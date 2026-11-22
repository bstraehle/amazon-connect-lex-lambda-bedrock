import { createHash } from "node:crypto";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { LexRuntimeV2Client, GetSessionCommand } from "@aws-sdk/client-lex-runtime-v2";
import { LexModelsV2Client, DescribeBotAliasCommand, ListIntentsCommand, DescribeIntentCommand } from "@aws-sdk/client-lex-models-v2";

const ENDPOINTS = {
  us: "https://api.us.elevenlabs.io",
  eu: "https://api.eu.residency.elevenlabs.io",
  in: "https://api.in.residency.elevenlabs.io"
};
const DEFAULT_ENDPOINT = "https://api.elevenlabs.io";
const MAX_CHARS = 2000;
const PART_CHARS = Number(process.env.PART_CHARS) || 220;
const STATIC_REPLIES_TTL_MS = 10 * 60 * 1000;
// Synthesized audio is reused (e.g. replays and the fixed greeting) instead of paying ElevenLabs again.
const AUDIO_CACHE_MAX_BYTES = 32 * 1024 * 1024;
// Newly spoken replies per client IP and hour; cache hits are free, and every part of an admitted reply is
// spoken, so replies don't stop midway. Per instance (reserved concurrency is 2).
const SPOKEN_REPLIES_PER_HOUR = Number(process.env.SPOKEN_REPLIES_PER_HOUR) || 20;
const BUDGET_WINDOW_MS = 60 * 60 * 1000;

const secretsClient = new SecretsManagerClient({});
const lexClient = new LexRuntimeV2Client({});
const modelsClient = new LexModelsV2Client({});

var credentials;
var staticReplies;
const audioCache = new Map();
var audioCacheBytes = 0;
const budgets = new Map();
const admittedReplies = new Map();

/**
 * Lambda handler (function URL): speak one part of the bot's last reply in a Lex session
 * @param {{queryStringParameters?:{sessionId?:string,part?:string}}} event
 */
export const handler = async (event) => {
  try {
    const sessionId = parseSessionId(event);
    const part = parsePart(event);
    if (!sessionId || part === null) {
      return jsonResponse(400, "Invalid request");
    }

    const parts = splitSpeech(toSpeech(await lastReply(sessionId)));
    if (part >= parts.length) {
      return part === 0 ? jsonResponse(404, "Nothing to say") : { statusCode: 204 };
    }

    const text = pronounce(parts[part]);
    const key = createHash("sha256").update(JSON.stringify([process.env.MODEL_ID, process.env.VOICE_ID, text])).digest("hex");
    var audio = cachedAudio(key);
    if (audio) {
      console.log("ElevenLabs cache hit: part", part + 1, "of", parts.length);
    } else {
      const replyKey = createHash("sha256").update(JSON.stringify([sessionId, parts])).digest("hex");
      if (!withinBudget(event?.requestContext?.http?.sourceIp, replyKey)) {
        console.log("ElevenLabs budget exceeded: part", part + 1, "of", parts.length);
        return {
          statusCode: 429,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "3600" },
          body: JSON.stringify({ message: "Too many speech requests" })
        };
      }
      console.log("ElevenLabs request: part", part + 1, "of", parts.length, "-", parts[part].length, "characters");
      audio = await synthesize(text);
      cacheAudio(key, audio);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
      body: audio.toString("base64"),
      isBase64Encoded: true
    };
  } catch (error) {
    if (error?.name === "ResourceNotFoundException") {
      return jsonResponse(404, "Nothing to say");
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("ElevenLabs error: ", message);
    return jsonResponse(502, "Speech is unavailable");
  }
};

/**
 * Get cached audio, and mark it as recently used
 * @param {string} key - Hash of model, voice, and text
 */
function cachedAudio(key) {
  const audio = audioCache.get(key);
  if (audio) {
    audioCache.delete(key);
    audioCache.set(key, audio);
  }
  return audio;
}

/**
 * Cache audio, evicting the least recently used entries beyond the size limit
 * @param {string} key - Hash of model, voice, and text
 * @param {Buffer} audio - MP3 audio
 */
function cacheAudio(key, audio) {
  if (audio.length > AUDIO_CACHE_MAX_BYTES) {
    return;
  }
  audioCache.set(key, audio);
  audioCacheBytes += audio.length;
  for (const [oldKey, oldAudio] of audioCache) {
    if (audioCacheBytes <= AUDIO_CACHE_MAX_BYTES) {
      break;
    }
    audioCache.delete(oldKey);
    audioCacheBytes -= oldAudio.length;
  }
}

/**
 * Count a newly spoken reply against the caller's hourly budget; later parts of an admitted reply are free
 * @param {string|undefined} ip - The client IP
 * @param {string} replyKey - Hash of the session ID and the reply's parts
 */
function withinBudget(ip, replyKey) {
  const now = Date.now();
  const admitted = admittedReplies.get(replyKey);
  if (admitted && now - admitted < BUDGET_WINDOW_MS) {
    return true;
  }
  if (admittedReplies.size > 10000) {
    for (const [oldKey, time] of admittedReplies) {
      if (now - time >= BUDGET_WINDOW_MS) {
        admittedReplies.delete(oldKey);
      }
    }
  }
  if (budgets.size > 10000) {
    for (const [oldIp, budget] of budgets) {
      if (now - budget.start >= BUDGET_WINDOW_MS) {
        budgets.delete(oldIp);
      }
    }
  }
  const id = ip || "unknown";
  var budget = budgets.get(id);
  if (!budget || now - budget.start >= BUDGET_WINDOW_MS) {
    budget = { start: now, count: 0 };
    budgets.set(id, budget);
  }
  if (budget.count >= SPOKEN_REPLIES_PER_HOUR) {
    return false;
  }
  budget.count += 1;
  admittedReplies.set(replyKey, now);
  return true;
}

/**
 * Build a JSON response
 * @param {number} statusCode - The HTTP status code
 * @param {string} message - The message
 */
function jsonResponse(statusCode, message) {
  return {
    statusCode: statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ message: message })
  };
}

/**
 * Read the Lex session ID from the query string
 * @param {{queryStringParameters?:{sessionId?:string}}} event
 */
function parseSessionId(event) {
  const sessionId = event?.queryStringParameters?.sessionId;
  return typeof sessionId === "string" && /^[0-9a-zA-Z._:-]{2,100}$/.test(sessionId) ? sessionId : null;
}

/**
 * Read the part number from the query string
 * @param {{queryStringParameters?:{part?:string}}} event
 */
function parsePart(event) {
  const part = event?.queryStringParameters?.part || "0";
  return /^[0-9]{1,2}$/.test(part) ? Number(part) : null;
}

/**
 * Get the bot's last reply in a Lex session
 * @param {string} sessionId - The Lex session ID
 */
async function lastReply(sessionId) {
  const session = await lexClient.send(new GetSessionCommand({
    botId: process.env.BOT_ID,
    botAliasId: process.env.BOT_ALIAS_ID,
    localeId: process.env.LOCALE_ID,
    sessionId: sessionId
  }));
  const reply = (session.messages || []).map(message => message.content || "").join("\n");
  if (reply) {
    return reply;
  }

  // The session only holds replies that came from the bot's Lambda; fixed replies live in the intent
  const replies = await loadStaticReplies();
  return replies[session.sessionState?.intent?.name] || "";
}

/**
 * Load the fixed replies of the bot's intents (greeting, goodbye, ...), by intent name
 */
async function loadStaticReplies() {
  if (staticReplies && Date.now() - staticReplies.loadedAt < STATIC_REPLIES_TTL_MS) {
    return staticReplies.replies;
  }

  const alias = await modelsClient.send(new DescribeBotAliasCommand({
    botId: process.env.BOT_ID,
    botAliasId: process.env.BOT_ALIAS_ID
  }));
  const bot = { botId: process.env.BOT_ID, botVersion: alias.botVersion, localeId: process.env.LOCALE_ID };
  const intents = await modelsClient.send(new ListIntentsCommand({ ...bot, maxResults: 100 }));

  const replies = {};
  await Promise.all((intents.intentSummaries || []).map(async (summary) => {
    const intent = await modelsClient.send(new DescribeIntentCommand({ ...bot, intentId: summary.intentId }));
    const groups = intent.initialResponseSetting?.initialResponse?.messageGroups
      || intent.intentClosingSetting?.closingResponse?.messageGroups
      || [];
    const reply = groups.map(group => group.message?.plainTextMessage?.value || "").join("\n").trim();
    if (reply) {
      replies[summary.intentName] = reply;
    }
  }));

  staticReplies = { loadedAt: Date.now(), replies: replies };
  return replies;
}

/**
 * Convert a reply (markdown or SSML) to plain text for speech
 * @param {string} text - The reply
 */
function toSpeech(text) {
  var speech = text
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~`#\[\]]/g, "")
    .replace(/([^.!?:;,\s])[^\S\n]*\n+/g, "$1. ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,!?;:])/g, "$1")
    .trim();

  if (speech.length > MAX_CHARS) {
    speech = speech.substring(0, MAX_CHARS);
    speech = speech.substring(0, speech.lastIndexOf(".") + 1) || speech;
  }
  return speech;
}

/**
 * Split speech into parts of whole sentences (shorter ones first), so that audio starts quickly
 * @param {string} speech - The speech
 */
function splitSpeech(speech) {
  const parts = [];
  for (const sentence of speech.split(/(?<=[^\d\s][.!?])(?<!(?:^|[\s.])[A-Z]\.)\s+(?=[A-Z0-9"'(])/)) {
    const last = parts.length - 1;
    const limit = PART_CHARS * Math.min(1, 0.5 + 0.25 * last);
    if (last >= 0 && parts[last].length + sentence.length < limit) {
      parts[last] += " " + sentence;
    } else if (sentence) {
      parts.push(sentence);
    }
  }
  return parts;
}

/**
 * Spell out terms the way the phone bot does
 * @param {string} speech - The speech
 */
function pronounce(speech) {
  return speech
    .replace(/demobank\.si/gi, "Demo Bank dot S I")
    .replace(/\bAPY\b/g, "A P Y")
    .replace(/\bFDIC\b/g, "F D I C");
}

/**
 * Load the ElevenLabs API key (same secret as the Amazon Connect flow)
 */
async function loadCredentials() {
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
  try {
    const parsed = JSON.parse(secret.SecretString);
    return { apiToken: parsed.apiToken, apiTokenRegion: parsed.apiTokenRegion };
  } catch (error) {
    return { apiToken: secret.SecretString };
  }
}

/**
 * Synthesize speech with ElevenLabs, returns MP3 audio
 * @param {string} text - The text
 */
async function synthesize(text) {
  credentials = credentials || await loadCredentials();
  const endpoint = ENDPOINTS[credentials.apiTokenRegion] || DEFAULT_ENDPOINT;
  const response = await fetch(endpoint + "/v1/text-to-speech/" + process.env.VOICE_ID + "?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": credentials.apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({ text: text, model_id: process.env.MODEL_ID }),
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) {
    if (response.status === 401) {
      credentials = undefined;
    }
    throw new Error("ElevenLabs " + response.status + ": " + (await response.text()).substring(0, 300));
  }
  return Buffer.from(await response.arrayBuffer());
}
