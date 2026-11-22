var lexClient = new LexSdk.LexRuntimeV2Client({
	region: 'us-west-2',
	credentials: LexSdk.fromCognitoIdentityPool({
		identityPoolId: 'us-west-2:e2c73da1-ef5b-4021-bb83-1fd6b60ed368',
		clientConfig: { region: 'us-west-2' }
	})
});

var STORAGE_KEY = 'demobank.chat';
var MAX_SAVED_MESSAGES = 100;
var savedChat = loadSavedChat();
var sessionId = savedChat ? savedChat.sessionId : newSessionId();
var savedMessages = savedChat ? savedChat.messages : [];
var conversationDiv = document.getElementById('conversation');
var inputHint = document.getElementById('inputHint');
var chatStatus = document.getElementById('chatStatus');
var sendButton = document.getElementById('sendButton');

var MAX_LENGTH = 200;
var MAX_WORD_LENGTH = 20;
var MAX_WORD_COUNT = 20;
var WORD_COUNTER_FROM = 15;

var isBusy = false;
var typingIndicator = null;

var chatHistory = [];
var historyIndex = -1;
var temporaryInput = '';

var recognition = null;
var isRecording = false;
var recognitionSupported = false;

var CAPTURE_MAX_MS = 12000;
var CAPTURE_NO_SPEECH_MS = 6000;
var CAPTURE_SILENCE_MS = 1500;
var CAPTURE_SPEECH_LEVEL = 0.02;
var CAPTURE_SILENT_LEVEL = 0.005;
var lexCaptureSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder
	&& (window.AudioContext || window.webkitAudioContext) && (window.OfflineAudioContext || window.webkitOfflineAudioContext)
	&& window.DecompressionStream);
var lexCapture = null;

var speechSynthesisSupported = 'speechSynthesis' in window;
var isSpeaking = false;
var isMuted = true;

var TTS_URL = 'https://2ehgcjujhdvucdp5vhhr3n2wei0hgcza.lambda-url.us-west-2.on.aws/';
var SILENT_AUDIO = 'data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
var replyAudio = null;
var replyAudioUrl = null;
var speechRun = 0;

function newSessionId() {
	if (window.crypto && window.crypto.randomUUID) {
		return 'session-' + window.crypto.randomUUID();
	}
	var bytes = new Uint8Array(16);
	window.crypto.getRandomValues(bytes);
	var hex = '';
	for (var i = 0; i < bytes.length; i++) {
		hex += ('0' + bytes[i].toString(16)).slice(-2);
	}
	return 'session-' + hex;
}

function loadSavedChat() {
	try {
		var saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY));
		if (saved && /^session-[0-9a-f-]{32,36}$/.test(saved.sessionId) && Array.isArray(saved.messages)) {
			return saved;
		}
	} catch (e) {
		return null;
	}
	return null;
}

function saveChat() {
	try {
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
			sessionId: sessionId,
			messages: savedMessages.slice(-MAX_SAVED_MESSAGES)
		}));
	} catch (e) {
		console.error('Could not save the conversation:', e);
	}
}

function restoreChat() {
	var known = { userRequest: true, lexResponse: true, lexError: true };
	savedMessages = savedMessages.filter(function(message) {
		return message && known[message.className] === true && Array.isArray(message.content) && message.content.every(function(part) {
			return typeof part === 'string';
		});
	});
	
	if (conversationDiv) {
		conversationDiv.setAttribute('aria-live', 'off');
	}
	savedMessages.forEach(function(message) {
		appendMessage(message.className, message.content, {
			asMarkdown: !!message.asMarkdown,
			elementTag: message.elementTag === 'div' ? 'div' : 'p',
			restored: true
		});
		if (message.className === 'userRequest') {
			chatHistory.push(message.content.join(' '));
		}
	});
	historyIndex = chatHistory.length;
	setTimeout(function() {
		if (conversationDiv) {
			conversationDiv.setAttribute('aria-live', 'polite');
		}
	}, 0);
}

function callLex(command, callback) {
	lexClient.send(command).then(function(data) {
		callback(null, data);
	}, function(err) {
		callback(err);
	});
}

function friendlyError(err) {
	var name = err && err.name;
	if (navigator.onLine === false || name === 'TypeError' || name === 'NetworkingError' || name === 'TimeoutError') {
		return 'I could not reach DemoBank. Please check your internet connection and try again.';
	}
	if (name === 'ThrottlingException' || (err && err.$metadata && err.$metadata.httpStatusCode === 429)) {
		return 'I am getting a lot of questions right now. Please try again in a moment.';
	}
	return 'Sorry, something went wrong. Please try again.';
}

function speakText(text) {
	if (!speechSynthesisSupported || !text || isMuted) {
		return;
	}
	
	if (window.speechSynthesis.speaking) {
		window.speechSynthesis.cancel();
	}
	
	// Remove markdown formatting for cleaner speech
	var cleanText = text
		.replace(/!\[.*?\]\(.*?\)/g, '') // Remove markdown images
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // Convert markdown links to just text
		.replace(/[*_~`#]/g, '') // Remove markdown formatting
		.replace(/\n+/g, '. ') // Convert newlines to pauses
		.trim();
	
	if (!cleanText) {
		return;
	}
	
	var utterance = new SpeechSynthesisUtterance(cleanText);
	utterance.rate = 1.0; // Speed (0.1 to 10)
	utterance.pitch = 1.0; // Pitch (0 to 2)
	utterance.volume = 1.0; // Volume (0 to 1)
	utterance.lang = 'en-US';
	
	utterance.onstart = function() {
		isSpeaking = true;
	};
	
	utterance.onend = function() {
		isSpeaking = false;
	};
	
	utterance.onerror = function(event) {
		console.error('Speech synthesis error:', event.error);
		isSpeaking = false;
	};
	
	window.speechSynthesis.speak(utterance);
}

function unlockReplyAudio() {
	if (replyAudio || !window.Audio) return;
	replyAudio = new Audio();
	replyAudio.src = SILENT_AUDIO;
	var playing = replyAudio.play();
	if (playing && playing.catch) {
		playing.catch(function() {});
	}
}

function stopSpeaking() {
	speechRun++;
	if (replyAudio) {
		replyAudio.onended = null;
		replyAudio.pause();
	}
	if (replyAudioUrl) {
		URL.revokeObjectURL(replyAudioUrl);
		replyAudioUrl = null;
	}
	if (window.speechSynthesis && window.speechSynthesis.speaking) {
		window.speechSynthesis.cancel();
	}
}

function fetchReplyAudio(part, isRetry) {
	return fetch(TTS_URL + '?sessionId=' + encodeURIComponent(sessionId) + '&part=' + part).then(function(response) {
		if (response.status === 204) {
			return null;
		}
		if (!response.ok) {
			throw new Error('Reply audio unavailable (' + response.status + ')');
		}
		return response.blob();
	}).catch(function(error) {
		if (isRetry) {
			throw error;
		}
		return new Promise(function(resolve) {
			setTimeout(resolve, 800);
		}).then(function() {
			return fetchReplyAudio(part, true);
		});
	});
}

function playReplyAudio(run, part, pending, text) {
	pending.then(function(audio) {
		if (run !== speechRun || !audio) {
			return;
		}

		var next = fetchReplyAudio(part + 1);
		next.catch(function() {});

		if (replyAudioUrl) {
			URL.revokeObjectURL(replyAudioUrl);
		}
		replyAudioUrl = URL.createObjectURL(audio);
		replyAudio.onended = function() {
			playReplyAudio(run, part + 1, next, text);
		};
		replyAudio.src = replyAudioUrl;
		return replyAudio.play();
	}).catch(function(error) {
		if (run !== speechRun) {
			return;
		}
		console.error('Reply audio error:', error);
		if (part === 0) {
			speakText(text);
		}
	});
}

function speakReply(text) {
	if (isMuted) {
		return;
	}
	stopSpeaking();
	if (!replyAudio || !window.fetch) {
		speakText(text);
		return;
	}
	playReplyAudio(speechRun, 0, fetchReplyAudio(0), text);
}
function toggleMute() {
	isMuted = !isMuted;
	var muteButton = document.getElementById('muteButton');
	if (!muteButton) return;
	
	if (isMuted) {
		stopSpeaking();
		muteButton.classList.add('muted');
		muteButton.title = 'Read replies aloud: off';
	} else {
		unlockReplyAudio();
		muteButton.classList.remove('muted');
		muteButton.title = 'Read replies aloud: on';
	}
	muteButton.setAttribute('aria-pressed', isMuted ? 'false' : 'true');
}

function updateConversationHeight() {
	var inputEl = document.getElementById('wisdom');
	if (!inputEl) return;
	var rect = inputEl.getBoundingClientRect();
	var inputHeight = rect.height || inputEl.offsetHeight;
	if (inputHeight) {
		document.documentElement.style.setProperty('--input-height', inputHeight + 'px');
	}
}

updateConversationHeight();

var SCROLL_SLOP_PX = 24;
var PAGE_SLOP_PX = 24;
function isAtBottom(el) {
	if (!el) return true;
	return (el.scrollHeight - el.scrollTop - el.clientHeight) <= SCROLL_SLOP_PX;
}
function isPageBottom() {
	var scroller = document.scrollingElement || document.documentElement || document.body;
	return (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= PAGE_SLOP_PX;
}
function scrollPageToBottom(smooth) {
	var scroller = document.scrollingElement || document.documentElement || document.body;
	var maxScroll = scroller.scrollHeight - scroller.clientHeight;
	if (maxScroll > 0) {
		window.scrollTo({ top: maxScroll, behavior: smooth ? 'smooth' : 'auto' });
	}
}

function appendMessage(className, content, options) {
	if (!conversationDiv || !content) return;
	var wasConversationPinned = isAtBottom(conversationDiv);
	var wasPagePinned = isPageBottom();
	var opts = options || {};
	var tagName = (opts.elementTag || 'p').toLowerCase();
	var container = document.createElement(tagName);
	container.className = className;

	var parts = Array.isArray(content) ? content : [content];
	parts = parts.filter(Boolean);
	if (!parts.length) return;

	if (opts.asMarkdown && window.marked && window.DOMPurify) {
		marked.setOptions({ breaks: true });
		var html = parts.map(function(part) {
			var rendered = marked.parse(part || '');
			return DOMPurify.sanitize(rendered);
		}).join('');
		container.innerHTML = html;
	} else {
		parts.forEach(function(part, index) {
			if (index > 0) {
				container.appendChild(document.createElement('br'));
			}
			container.appendChild(document.createTextNode(part));
		});
	}

	conversationDiv.appendChild(container);

	if (!opts.restored) {
		savedMessages.push({ className: className, content: parts, asMarkdown: !!opts.asMarkdown, elementTag: tagName });
		saveChat();
	}

	requestAnimationFrame(function() {
		if (wasConversationPinned) {
			conversationDiv.scrollTop = conversationDiv.scrollHeight;
		}
		if (wasConversationPinned && wasPagePinned) {
			scrollPageToBottom(true);
		}
	});
}

function showTyping() {
	if (!conversationDiv || typingIndicator) return;
	typingIndicator = document.createElement('div');
	typingIndicator.className = 'lexResponse typing';
	typingIndicator.setAttribute('aria-hidden', 'true');
	for (var i = 0; i < 3; i++) {
		typingIndicator.appendChild(document.createElement('span'));
	}
	conversationDiv.appendChild(typingIndicator);
}

function hideTyping() {
	if (typingIndicator && typingIndicator.parentNode) {
		typingIndicator.parentNode.removeChild(typingIndicator);
	}
	typingIndicator = null;
}

function setBusy(busy) {
	isBusy = busy;
	if (chatStatus) {
		chatStatus.textContent = busy ? 'DemoBank assistant is typing' : '';
	}
	var suggestions = document.querySelectorAll('.suggestion');
	for (var i = 0; i < suggestions.length; i++) {
		suggestions[i].setAttribute('aria-disabled', busy ? 'true' : 'false');
	}
	if (busy) {
		showTyping();
	} else {
		hideTyping();
	}
	updateSendButton();
}

function showHint(message, isError) {
	if (!inputHint) return;
	var text = message || '';
	if (inputHint.textContent !== text) {
		inputHint.textContent = text;
	}
	inputHint.classList.toggle('error', !!(text && isError));
}

function checkInput() {
	var wisdomText = document.getElementById('wisdom');
	var raw = wisdomText ? (wisdomText.value || '').trim() : '';
	var text = sanitizeInput(raw);
	return { raw: raw, text: text, problem: raw ? validateInput(text) : '' };
}

function updateSendButton() {
	if (!sendButton) return;
	var input = checkInput();
	sendButton.disabled = isBusy || !input.raw || !!input.problem;
}

function updateInputHint() {
	var wisdomText = document.getElementById('wisdom');
	if (!wisdomText) return;
	var input = checkInput();
	var wordCount = input.text ? input.text.split(' ').length : 0;

	if (input.problem) {
		showHint(input.problem, true);
	} else if (wordCount >= WORD_COUNTER_FROM) {
		showHint(wordCount + ' / ' + MAX_WORD_COUNT + ' words');
	} else {
		showHint('');
	}
	wisdomText.setAttribute('aria-invalid', input.problem ? 'true' : 'false');
	updateSendButton();
}

function pushChat() {
	var wisdomText = document.getElementById('wisdom');
	if (!wisdomText || isBusy) return false;

	var input = checkInput();
	if (!input.raw) {
		return false;
	}
	if (input.problem) {
		updateInputHint();
		return false;
	}
	var wisdom = input.text;

	chatHistory.push(input.raw);
	historyIndex = chatHistory.length;
	temporaryInput = '';

	wisdomText.value = '';
	updateInputHint();

	var params = {
		botId: 'BWKAOWFRLW',
		botAliasId: 'GFO9LFVAOZ',
		localeId: 'en_US',
		sessionId: sessionId,
		text: wisdom
	};

	appendMessage('userRequest', input.raw);
	stopSpeaking();
	setBusy(true);

	setTimeout(function() {
		if (conversationDiv) {
			conversationDiv.scrollTop = conversationDiv.scrollHeight;
		}
		scrollPageToBottom(true);
	}, 10);

	callLex(new LexSdk.RecognizeTextCommand(params), function(err, data) {
		setBusy(false);

		if (err) {
			console.log(err, err.stack);
			var errorMsg = friendlyError(err);
			appendMessage('lexError', errorMsg);
			speakText(errorMsg);
		}

		if (data) {
			showResponse(data);
		}
	});

	return false;
}

function showResponse(lexResponse) {
	if (!lexResponse || !lexResponse.messages) return;
	var messages = [];
	lexResponse.messages.forEach(function(message) {
		if (message && message.content) {
			messages.push(stripSsml(message.content));
		}
	});
	if (messages.length > 0) {
		var fullText = messages.join(' ');
		appendMessage('lexResponse', messages, { asMarkdown: true, elementTag: 'div' });
		speakReply(fullText);
	}
}

function stripSsml(content) {
	return /^\s*<speak>/i.test(content) ? content.replace(/<[^>]+>/g, '').trim() : content;
}

function sanitizeInput(input) {
	var text = input
		.replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, '-')
		.replace(/\u2026/g, '...');
	if (text.normalize) {
		text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
	}
	// Allow: letters, numbers, spaces, basic punctuation, common symbols
	// Block: HTML tags, script injection, control characters, etc.
	return text.replace(/[^\w\s.,!?'\-()@$%&+/:;"=\[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function validateInput(text) {
	if (!text) {
		return 'Please type your question using English letters or numbers.';
	}
	var words = text.split(' ');
	if (words.length > MAX_WORD_COUNT) {
		return words.length + ' / ' + MAX_WORD_COUNT + ' words. Please shorten your question.';
	}
	for (var i = 0; i < words.length; i++) {
		if (words[i].length > MAX_WORD_LENGTH) {
			return '"' + words[i].substring(0, 12) + '..." is too long. Words can have up to ' + MAX_WORD_LENGTH + ' characters.';
		}
	}
	if (text.length > MAX_LENGTH) {
		return 'Please shorten your question to ' + MAX_LENGTH + ' characters.';
	}
	return '';
}

function navigateHistory(direction) {
	var wisdomText = document.getElementById('wisdom');
	if (!wisdomText) return;

	if (historyIndex === chatHistory.length) {
		temporaryInput = wisdomText.value;
	}

	if (direction === 'up') {
		if (historyIndex > 0) {
			historyIndex--;
			wisdomText.value = chatHistory[historyIndex];
		}
	} else if (direction === 'down') {
		if (historyIndex < chatHistory.length) {
			historyIndex++;
			if (historyIndex === chatHistory.length) {
				wisdomText.value = temporaryInput;
			} else {
				wisdomText.value = chatHistory[historyIndex];
			}
		}
	}
	updateInputHint();
}

function askSuggestion(question) {
	var wisdomText = document.getElementById('wisdom');
	if (!wisdomText || !question || isBusy) return;
	wisdomText.value = question;
	pushChat();
}

var wisdomInput = document.getElementById('wisdom');
if (wisdomInput) {
	wisdomInput.addEventListener('input', updateInputHint);
	
	wisdomInput.addEventListener('keydown', function(event) {
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			navigateHistory('up');
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			navigateHistory('down');
		} else if (event.key !== 'Enter') {
			if (historyIndex !== chatHistory.length) {
				historyIndex = chatHistory.length;
				temporaryInput = '';
			}
		}
	});
}

function setMicState(recording) {
	isRecording = recording;
	var micButton = document.getElementById('micButton');
	if (!micButton) return;
	micButton.classList.toggle('recording', recording);
	micButton.title = recording ? 'Listening... Click to stop' : 'Speak your question';
	micButton.setAttribute('aria-pressed', recording ? 'true' : 'false');
}

function toggleLexCapture() {
	if (lexCapture) {
		stopLexCapture();
		return;
	}
	if (isBusy) {
		return;
	}

	lexCapture = {};
	stopSpeaking();
	navigator.mediaDevices.getUserMedia({ audio: true }).then(startLexCapture).catch(function(error) {
		console.error('Microphone error:', error);
		if (lexCapture && lexCapture.stream) {
			lexCapture.stream.getTracks().forEach(function(track) {
				track.stop();
			});
		}
		lexCapture = null;
		setMicState(false);

		if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
			showHint('Microphone access denied. Please allow microphone permissions to use voice input.', true);
		} else {
			showHint('Voice input error: ' + (error && error.message ? error.message : error), true);
		}
	});
}

function stopLexCapture() {
	if (lexCapture && lexCapture.recorder && lexCapture.recorder.state !== 'inactive') {
		lexCapture.recorder.stop();
	}
}

function startLexCapture(stream) {
	lexCapture = { stream: stream };

	var AudioContextClass = window.AudioContext || window.webkitAudioContext;
	var audioContext = new AudioContextClass();
	var analyser = audioContext.createAnalyser();
	var samples = new Float32Array(analyser.fftSize);
	var recorder = new MediaRecorder(stream);
	var chunks = [];
	var startedAt = Date.now();
	var lastSpeechAt = 0;
	var peakLevel = 0;

	audioContext.createMediaStreamSource(stream).connect(analyser);
	if (audioContext.state === 'suspended') {
		audioContext.resume();
	}

	var timer = setInterval(function() {
		analyser.getFloatTimeDomainData(samples);
		var sum = 0;
		for (var i = 0; i < samples.length; i++) {
			sum += samples[i] * samples[i];
		}
		var level = Math.sqrt(sum / samples.length);
		var now = Date.now();
		peakLevel = Math.max(peakLevel, level);
		if (level >= CAPTURE_SPEECH_LEVEL) {
			lastSpeechAt = now;
		}

		var tooLong = now - startedAt > CAPTURE_MAX_MS;
		var finished = lastSpeechAt && now - lastSpeechAt > CAPTURE_SILENCE_MS;
		var noSpeech = !lastSpeechAt && now - startedAt > CAPTURE_NO_SPEECH_MS;
		if (tooLong || finished || noSpeech) {
			stopLexCapture();
		}
	}, 100);

	recorder.ondataavailable = function(event) {
		if (event.data && event.data.size) {
			chunks.push(event.data);
		}
	};

	recorder.onstop = function() {
		clearInterval(timer);
		stream.getTracks().forEach(function(track) {
			track.stop();
		});
		lexCapture = null;
		setMicState(false);

		if (peakLevel < CAPTURE_SILENT_LEVEL) {
			audioContext.close();
			showHint('I did not hear anything. Please check your microphone and try again.', true);
			return;
		}

		showHint('');
		setBusy(true);
		new Blob(chunks, { type: recorder.mimeType }).arrayBuffer().then(function(encoded) {
			return new Promise(function(resolve, reject) {
				audioContext.decodeAudioData(encoded, resolve, reject);
			});
		}).then(toLexAudio).then(sendUtterance).catch(function(error) {
			console.error('Voice input error:', error);
			showHint('Voice input error: ' + (error && error.message ? error.message : error), true);
		}).then(function() {
			setBusy(false);
			audioContext.close();
		});
	};

	lexCapture.recorder = recorder;
	recorder.start();
	setMicState(true);
	showHint('Listening...');
}

function toLexAudio(audioBuffer) {
	var OfflineContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
	var offline = new OfflineContextClass(1, Math.max(1, Math.ceil(audioBuffer.duration * 16000)), 16000);
	var source = offline.createBufferSource();
	source.buffer = audioBuffer;
	source.connect(offline.destination);
	source.start();

	return offline.startRendering().then(function(rendered) {
		var input = rendered.getChannelData(0);
		var pcm = new Int16Array(input.length);
		for (var i = 0; i < input.length; i++) {
			var sample = Math.max(-1, Math.min(1, input[i]));
			pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
		}
		return new Uint8Array(pcm.buffer);
	});
}

function decodeLexField(value) {
	if (!value) {
		return Promise.resolve(null);
	}
	var binary = atob(value);
	var bytes = new Uint8Array(binary.length);
	for (var i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).text().then(function(text) {
		return JSON.parse(text);
	});
}

function sendUtterance(audio) {
	return new Promise(function(resolve, reject) {
		var params = {
			botId: 'BWKAOWFRLW',
			botAliasId: 'GFO9LFVAOZ',
			localeId: 'en_US',
			sessionId: sessionId,
			requestContentType: 'audio/l16; rate=16000; channels=1',
			responseContentType: 'text/plain; charset=utf-8',
			inputStream: audio
		};

		callLex(new LexSdk.RecognizeUtteranceCommand(params), function(err, data) {
			if (err) {
				console.log(err, err.stack);
				var errorMsg = friendlyError(err);
				appendMessage('lexError', errorMsg);
				speakText(errorMsg);
				resolve();
				return;
			}
			if (data.audioStream && data.audioStream.transformToByteArray) {
				data.audioStream.transformToByteArray().catch(function() {});
			}

			Promise.all([decodeLexField(data.inputTranscript), decodeLexField(data.messages)]).then(function(fields) {
				var transcript = fields[0];
				if (!transcript) {
					showHint('Sorry, I did not catch that. Please try again.', true);
					return;
				}

				transcript = transcript.charAt(0).toUpperCase() + transcript.slice(1);
				chatHistory.push(transcript);
				historyIndex = chatHistory.length;
				temporaryInput = '';
				appendMessage('userRequest', transcript);
				showResponse({ messages: fields[1] });
			}).then(resolve, reject);
		});
	});
}

function initSpeechRecognition() {
	var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	
	if (!SpeechRecognition) {
		recognitionSupported = false;
		var micButton = document.getElementById('micButton');
		if (micButton && !lexCaptureSupported) {
			micButton.disabled = true;
			micButton.title = 'Voice input not supported in this browser';
		}
		return;
	}
	
	recognitionSupported = true;
	recognition = new SpeechRecognition();
	recognition.continuous = false;
	recognition.interimResults = true;
	recognition.lang = 'en-US';
	
	recognition.onstart = function() {
		setMicState(true);
		showHint('Listening...');
	};
	
	recognition.onresult = function(event) {
		var transcript = '';
		for (var i = event.resultIndex; i < event.results.length; i++) {
			transcript += event.results[i][0].transcript;
		}
		
		var wisdomInput = document.getElementById('wisdom');
		if (wisdomInput && transcript) {
			wisdomInput.value = transcript;
			updateInputHint();
		}
	};
	
	recognition.onerror = function(event) {
		console.error('Speech recognition error:', event.error);
		setMicState(false);
		
		if (event.error === 'not-allowed' || event.error === 'permission-denied') {
			showHint('Microphone access denied. Please allow microphone permissions to use voice input.', true);
		} else if (event.error === 'no-speech') {
			// User didn't speak, no need to alert
			showHint('');
		} else if (event.error !== 'aborted') {
			showHint('Voice input error: ' + event.error, true);
		}
	};
	
	recognition.onend = function() {
		setMicState(false);
		if (inputHint && inputHint.textContent === 'Listening...') {
			showHint('');
		}
		var wisdomInput = document.getElementById('wisdom');
		if (wisdomInput) {
			if (wisdomInput.value && wisdomInput.value.trim() && !isBusy) {
				pushChat();
			}
		}
	};
}

function toggleSpeechRecognition() {
	if (!recognitionSupported || !recognition) {
		if (lexCaptureSupported) {
			toggleLexCapture();
		} else {
			showHint('Speech recognition is not supported in your browser. Please try Chrome, Edge, or Safari.', true);
		}
		return;
	}
	
	if (isBusy) {
		return;
	}
	
	if (isRecording) {
		recognition.stop();
	} else {
		stopSpeaking();
		try {
			recognition.start();
		} catch (e) {
			console.error('Error starting recognition:', e);
			if (e.name === 'InvalidStateError') {
				setTimeout(function() {
					try {
						recognition.start();
					} catch (err) {
						console.error('Failed to restart recognition:', err);
					}
				}, 100);
			}
		}
	}
}

window.addEventListener('resize', updateConversationHeight);

window.addEventListener('load', function() {
	updateConversationHeight();
	
	if (window.DOMPurify) {
		DOMPurify.addHook('afterSanitizeAttributes', function(node) {
			if (node.tagName === 'A' && node.hasAttribute('href')) {
				node.setAttribute('target', '_blank');
				node.setAttribute('rel', 'noopener noreferrer');
			}
		});
	}
	
	if (savedMessages.length > 0) {
		restoreChat();
	} else {
		var welcomeMessage = 'Hi, I can connect you with a DemoBank representative or answer your questions about our high yield savings account.';
		appendMessage('lexResponse', welcomeMessage, { asMarkdown: true, elementTag: 'div' });
		speakText(welcomeMessage);
	}
	
	if (conversationDiv) {
		conversationDiv.scrollTop = conversationDiv.scrollHeight;
		if (isPageBottom()) {
			scrollPageToBottom(false);
		}
	}
	
	initSpeechRecognition();
	
	var micButton = document.getElementById('micButton');
	if (micButton) {
		micButton.addEventListener('click', toggleSpeechRecognition);
	}
	
	var muteButton = document.getElementById('muteButton');
	if (muteButton) {
		muteButton.addEventListener('click', toggleMute);
	}
	
	var chatForm = document.getElementById('chatform');
	if (chatForm) {
		chatForm.addEventListener('submit', function(event) {
			event.preventDefault();
			pushChat();
		});
	}
	
	var videoLink = document.getElementById('videoLink');
	var videoDialog = document.getElementById('videoDialog');
	var videoClose = document.getElementById('videoClose');
	var architectureVideo = document.getElementById('architectureVideo');
	if (videoLink && videoDialog && videoDialog.showModal && videoClose && architectureVideo) {
		videoLink.addEventListener('click', function(event) {
			event.preventDefault();
			stopSpeaking();
			videoDialog.showModal();
			var playing = architectureVideo.play();
			if (playing && playing.catch) {
				playing.catch(function() {});
			}
		});
		videoClose.addEventListener('click', function() {
			videoDialog.close();
		});
		videoDialog.addEventListener('click', function(event) {
			if (event.target === videoDialog) {
				videoDialog.close();
			}
		});
		videoDialog.addEventListener('close', function() {
			architectureVideo.pause();
		});
	}
	
	var suggestions = document.getElementById('suggestions');
	if (suggestions) {
		suggestions.addEventListener('click', function(event) {
			var button = event.target.closest ? event.target.closest('.suggestion') : null;
			if (button) {
				askSuggestion(button.textContent);
			}
		});
	}
});
