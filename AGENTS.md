# DemoBank

Text/voice assistant for https://www.demobank.si (AWS account 819097794827, us-west-2).
This repo is the source of truth for everything deployed; see README.md for the layout.
Rollback copies (`backup/`) are kept outside the repo, in `C:/github/demobank/backup` on the maintainer's machine.

## Files

Deployed to the website (S3), all in `website/`:

- `index.html` - markup and CSS (CRLF line endings, tab indentation).
- `app.js` - the page script (CRLF, tabs). No inline scripts or inline event handlers: the CSP forbids them.
- `lex-sdk.min.js` - built from `sdk/` (AWS SDK v3: Lex runtime + anonymous Cognito credentials). Do not edit by hand.
- `voicebot.vtt` - captions for `voicebot.mp4` (the video itself only lives in the bucket; both come from the
  `svg-to-mp4` skill in `C:\github\agent-skills`).
- `preview.png` - social preview image (1200x630). `favicon.png`.

Not deployed to the website:

- `website/sdk/` - `npm install`, then `npm run build` writes `../lex-sdk.min.js`. Versions are pinned exactly;
  install new ones with `--before=<date 7 days ago>` so nothing freshly published gets pulled in.
- `lambda/demo-bank/index.mjs` - the bot's Lambda (Bedrock answers; also serves the phone line); `config.json` has its settings.
- `lambda/demo-bank-tts/index.mjs` - the text-to-speech Lambda for the web page; `config.json` has its settings.
- `lex/` - export of bot version 51 (LexJson). `connect/DemoFlow.json` - the Amazon Connect flow.
- `aws/` - guardrail v11, CloudFront function and security headers policy, IAM policies, DynamoDB table.
  After changing any of these in AWS, re-export them here so the repo stays current.

## Hosting

- S3 bucket `demobank-virtual-assistant` (no versioning) behind CloudFront distribution `EKNGTSQVBSF70`
  (www.demobank.si, www.demobank.ai; the apex domains redirect to www, keeping path and query, via the CloudFront
  function `apex-to-www-redirect-demobank`, source in `aws/cloudfront/`).
- Response headers policy `demobank-security-headers` adds CSP, HSTS, nosniff, X-Frame-Options, Referrer-Policy
  and Permissions-Policy. `X-Content-Type-Options: nosniff` means every upload needs the right content type.
- The CSP lists every host the page talks to. A new CDN, API endpoint or inline script will be blocked until
  the policy is updated.
- Upload only the website files. Do not sync the whole folder.

Deploy the page from `website/` (Git Bash; `MSYS_NO_PATHCONV=1` is required or the invalidation path gets mangled):

    aws s3api get-object --bucket demobank-virtual-assistant --key index.html C:/github/demobank/backup/index-<date>.html
    aws s3api put-object --bucket demobank-virtual-assistant --key app.js --body app.js --content-type text/javascript
    aws s3api put-object --bucket demobank-virtual-assistant --key lex-sdk.min.js --body lex-sdk.min.js --content-type text/javascript
    aws s3api put-object --bucket demobank-virtual-assistant --key index.html --body index.html --content-type text/html
    MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation --distribution-id EKNGTSQVBSF70 --paths "/*"

When `app.js` or `lex-sdk.min.js` changes, bump the `?v=` value on its script tag in `index.html`, otherwise
returning visitors keep the copy cached by their browser.

## Backend

- Lex V2 bot `BWKAOWFRLW`, alias `GFO9LFVAOZ` (bot version 51), locale `en_US`. The browser calls it with the
  unauthenticated Cognito identity pool in `app.js`. That role (`lex-demo`) may only call `RecognizeText` and
  `RecognizeUtterance` on this alias.
- Lambda `demo-bank` answers `QuestionAnswering` and `FallbackIntent` (dialog code hook).
  - It refuses questions with more than 20 words, a word over 20 characters, more than 200 characters, or
    characters outside `[\w\s.,!?'\-()@$%&+/:;"=\[\]]`. `app.js` mirrors these limits (`MAX_*` constants and
    `sanitizeInput`); change both together.
  - Conversation memory: the last 3 question/answer pairs are kept per Lex session ID in the DynamoDB table
    `demobank-conversations` (15 minutes, TTL attribute `expiresAt`). Do not move this into Lex session
    attributes: Amazon Connect replaces them on every turn, which silently breaks follow-ups on the phone.
    `FallbackIntent` only reaches Bedrock when there is history (a likely follow-up); otherwise it returns
    the fixed refusal.
  - Bedrock guardrail `6w2hf5g6l179` (`DemoBank`), version 11, set in the Lambda's `GUARDRAIL_VERSION`.
    The PASSWORD filter masks user input only: on answers it replaced the bolded link name
    "**Forgot password**" with `{PASSWORD}` (it started doing so on 2026-11-18 with no configuration change).
    If a `{SOMETHING}` placeholder shows up in an answer, set the Lambda variable `LOG_GUARDRAIL_TRACE=true`
    for a moment: interventions then log the full guardrail trace (the matched entity and the model's text). Remove it
    afterwards, because the trace can contain what the user typed (e.g. a password). Test wording with `ApplyGuardrail`.
  - Logs hold only metadata (intent, input mode, question length, stop reason, guardrail action, token usage) and the
    answer as sent; never the question. Lex conversation logs (`/aws/lex/BWKAOWFRLW`) still hold transcripts.
  - Refusals (the model's "I cannot help with this" and the guardrail's blocked message, equal to `REFUSAL_MSG`) are
    not stored as history.
  - Its execution role is shared with the `ai-horizon-analysis` Lambda; the inline policy
    `demobank-conversation-history` grants access to that one table.
- Lambda `demo-bank-tts` (public function URL, CORS limited to the site origins) speaks the bot's last reply
  in a Lex session with the ElevenLabs voice and model of the Amazon Connect flow `DemoFlow` (key in Secrets
  Manager secret `Eleven_Labs`). The page requests `?sessionId=...&part=N` until it gets HTTP 204.
  - Lex only keeps replies produced by the Lambda in the session. For fixed replies (greeting, agent, goodbye)
    the function reads the intent's configured response from the bot definition.
  - Reserved concurrency is 2 on purpose: the ElevenLabs plan allows 3 concurrent requests and the phone line
    shares them.
  - Synthesized audio is cached in memory (LRU, 32 MB) by model, voice, and text, so replays and the fixed replies
    don't hit ElevenLabs again. Newly spoken replies are limited per client IP to `SPOKEN_REPLIES_PER_HOUR` (default 20,
    per instance); every part of an admitted reply is spoken. Beyond the limit the function returns 429 for the reply's
    first part and the page falls back to the browser's voice.
  - Do not switch the function URL to response streaming: a client that disconnects mid-stream keeps a
    concurrency slot busy for about 3 minutes.

Deploy a Lambda (zip must contain `index.mjs` at its root):

    aws lambda update-function-code --function-name <demo-bank|demo-bank-tts> --region us-west-2 --zip-file fileb://<zip>

## Rollback

The `backup/` files below are in `C:/github/demobank/backup`, not in this repo.

- 2026-11-21 review fixes (microphone draft, refusal history, log redaction, TTS cache/budget, apex paths):
  `demo-bank` version 4 and `demo-bank-tts` version 1 hold the code from before; the previous page, Lambda zips,
  and CloudFront function are in `backup/*-2026-11-21.*`.
- Page: re-upload a file from `backup/index-*.html` and invalidate. `index-2026-10-04.html` is the original
  single-file page (it needs the security headers policy detached, because it uses inline scripts).
- `demo-bank` Lambda: version 1 and `backup/demo-bank-2026-10-17.zip` hold the code from before conversation memory.
  Version 2 is the variant that kept the memory in Lex session attributes (works on the web only).
- Guardrail: set `GUARDRAIL_VERSION` back to 10 (Lambda version 3 has that setting; the full version 10
  definition is in `backup/guardrail-6w2hf5g6l179-v10.json`).
- Lex: point alias `GFO9LFVAOZ` back to bot version 50 (settings in `backup/lex-alias-before-2026-11-17.json`).
- CloudFront: `backup/cloudfront-distribution-config-before.json` and
  `backup/cloudfront-function-apex-to-www-redirect-demobank-before.js`.
- Anonymous role: the AWS managed policy `AmazonLexRunBotsOnly` was replaced by the inline policy `demobank-bot-only`.

## Testing

- Python Playwright (Chromium, Firefox, and Edge via `channel="msedge"`) is installed on this machine.
  Playwright's own Chromium cannot play the H.264 video; use Edge for that.
- To test the phone path without calling: send speech with `RecognizeUtterance` using a fixed session ID and
  pass `sessionState` with only an `x-amz-lex:connect-originating-request-id` session attribute on every
  turn. That is what Amazon Connect does, and a plain Lex test does not reproduce it.
- To test local files under the real origin (CSP, CORS and the ElevenLabs voice all depend on it), route
  `https://www.demobank.si/**` to the local files in Playwright instead of serving from localhost.
- Shell commands sent through an agent tool lose one of every two consecutive backslashes; avoid `\` in heredocs.

## Repo

- `.gitattributes` pins each deployed file's line endings (CRLF for `index.html`, `app.js`, and the `demo-bank`
  Lambda; LF for the rest), so a checkout is byte-identical to the deployed files. Compare before deploying: `aws s3api get-object ... ` / `aws lambda get-function` and `cmp`.
- Never commit secrets: the ElevenLabs key stays in Secrets Manager (`Eleven_Labs`).
