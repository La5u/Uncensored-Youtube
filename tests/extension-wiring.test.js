const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

const content = read("src/content.js");
const pageHook = read("src/page-hook.js");
const audioCapture = read("src/audio-capture.js");
const background = read("src/background.js");
const offscreen = read("src/offscreen.js");
const whisperWorker = read("src/whisper-module-worker.js");
const popup = read("src/popup.html");
const popupScript = read("src/popup.js");
const chromiumManifest = JSON.parse(read("manifest.chromium.json"));

assert.ok(audioCapture.includes("token.eventIndex === next.token.eventIndex"));
assert.ok(audioCapture.includes("token.timeSeconds - AUDIO_CONTEXT_SECONDS"));
assert.ok(audioCapture.includes("Math.round((token.timeSeconds || 0) * 10)"));
assert.ok(audioCapture.includes("tokens.slice(startIndex)"));
assert.ok(!audioCapture.includes("anchorCount"));
assert.ok(audioCapture.includes("var startTime = tokenWindow(group[0].token).startTime"));
assert.ok(!audioCapture.includes("availableTokenWindow"));
assert.ok(!audioCapture.includes("visibleAtPlayhead"));

assert.ok(content.includes("uncensoredSabr"));
assert.ok(content.includes("hasCensoredSlots || Boolean(data.tokens.length)"));
assert.ok(content.includes("audioNeeded !== true"));
assert.ok(!content.includes("sabrRelayQueue"));
assert.ok(!content.includes("sabrGeneration"));
assert.ok(content.includes("message.videoId !== currentVideoId()"));
assert.ok(content.includes("syncVideo(detail.videoId || currentVideoId())"));
assert.ok(pageHook.includes("function timedTextVideoId(input)"));
assert.ok(pageHook.includes("videoId !== currentVideoId() && !navigationPending"));
assert.strictEqual((content.match(/uncensoredIdle/g) || []).length, 1);
assert.ok(content.indexOf("loadSettings().then") < content.indexOf("injectScriptsSequentially(scripts)"));
assert.ok(background.includes("runtime.runtime.getContexts"));
assert.ok(background.includes("src/offscreen.html"));
assert.ok(background.includes("offscreen.closeDocument"));
assert.ok(background.includes("message.uncensoredIdle"));
assert.ok(offscreen.includes("src/sabr-worker.js"));
assert.ok(read("src/sabr-worker.js").includes('text.indexOf("A_OPUS")'));
assert.ok(offscreen.includes("src/whisper-module-worker.js"));
assert.ok(whisperWorker.includes("runtimeReady = import"));
assert.ok(chromiumManifest.permissions.includes("offscreen"));
assert.strictEqual(chromiumManifest.message_serialization, "structured_clone");
assert.strictEqual(chromiumManifest.minimum_chrome_version, "148");
assert.ok(popup.includes("91.1% precision"));
assert.ok(popup.includes("85.8% correct coverage"));
assert.ok(popup.includes("80.3% precision"));
assert.ok(popup.includes("90.3% precision"));
assert.ok(popup.includes("1,448 scored slots from 54 videos"));
assert.ok(popupScript.includes("rulesEnabled: true"));
assert.ok(popupScript.includes("whisperEnabled: true"));

assert.ok(pageHook.includes("audioReplacements.clear();"));
assert.ok(pageHook.includes("settings.audioNeeded === true"));
assert.ok(pageHook.includes("waitForAudioDecision"));
assert.ok(pageHook.includes("shouldObserveAudio() &&"));
assert.ok(pageHook.includes("decisionTimedOut"));
assert.ok(pageHook.includes("audioDecisionWaiters.push"));
assert.ok(pageHook.includes('url.searchParams.get("sabr") === "1"'));
assert.ok(!pageHook.includes("replaceOlderWaiter"));
assert.ok(!pageHook.includes("audio stream started"));
assert.ok(!pageHook.includes("audio capture enabled"));
assert.ok(pageHook.includes("uncensoredSavedResolutions"));
assert.ok(pageHook.includes("discardSavedResolutionsForOtherVideo"));
assert.ok(pageHook.includes("videoId !== currentVideoId()"));
assert.ok(!pageHook.includes("navigationGeneration"));
assert.ok(pageHook.includes("navigationPending"));
assert.ok(pageHook.includes("waitForNavigationFinish"));
assert.strictEqual((pageHook.match(/installNetworkHooks\(\);/g) || []).length, 3);
assert.ok(pageHook.includes("responseVideoId !== videoId && !duringNavigation"));
assert.ok(pageHook.includes("isGoogleVideoPlaybackUrl(response && response.url)"));
assert.ok(!pageHook.includes("captureMediaResponse"));
assert.ok(!pageHook.includes("preserveNetworkHooks"));
assert.ok(!pageHook.includes("fetchGoogleAudio"));
assert.ok(!pageHook.includes("bestGoogleAudioUrl"));

assert.ok(audioCapture.includes("bgMessage(\"transcribe\""));
assert.ok(audioCapture.includes("Whisper via extension host"));
assert.ok(audioCapture.includes("var decodeQueue = Promise.resolve();"));
assert.ok(audioCapture.includes("Audio decode timed out"));
assert.ok(audioCapture.includes("uncensored-whisper-resolution"));
assert.ok(!audioCapture.includes("VISIBLE_REAPPLY_SECONDS"));
assert.ok(audioCapture.includes("nearbyTimelineWords"));
assert.ok(audioCapture.includes("visibleTokenMapping"));
assert.ok(audioCapture.includes("captionTrackId"));
assert.ok(audioCapture.includes("rules.formatWordCase"));
assert.ok(!audioCapture.includes("previousCaptionRow"));
assert.ok(!audioCapture.includes("topCaptionRow"));
assert.ok(!audioCapture.includes("root.__uncensoredResolveToken"));
assert.ok(audioCapture.includes("token.eventIndex === next.token.eventIndex"));
assert.ok(audioCapture.includes("forceSingle"));
assert.ok(audioCapture.includes("whisper retry"));
assert.ok(audioCapture.includes("readMediaWindow"));
assert.ok(!audioCapture.includes("Math.abs((token.timeSeconds || 0) - playhead)"));
assert.ok(audioCapture.includes("!tokenMetadataKnown || segmentNeeded(segment)"));
assert.ok(!audioCapture.includes("segmentInBufferedRange"));
assert.ok(audioCapture.includes("videoHasCensoredSlots"));
assert.ok(audioCapture.includes("token.visibleOnly"));
assert.ok(audioCapture.includes("whisper model starting"));
assert.ok(audioCapture.includes("whisper model started"));
assert.ok(audioCapture.includes("syncVideo(nextOptions.videoId)"));
assert.ok(!audioCapture.includes('whisperModelState = "idle";\n      }'));
assert.ok(!audioCapture.includes('root.addEventListener("yt-navigate-start", resetForNavigation)'));
assert.ok(!content.match(/yt-navigate-start[\s\S]{0,250}uncensoredIdle/));

const captionSegment = { textContent: "fucking" };
let captionSegments = [captionSegment];
const videoListeners = {};
const navigationListeners = {};
const observedCaptionTargets = [];
let player = {};
const video = {
  currentTime: 0,
  paused: false,
  addEventListener(type, listener) {
    videoListeners[type] = listener;
  },
  removeEventListener() {}
};
global.location = { href: "https://www.youtube.com/watch?v=test" };
global.addEventListener = function addEventListener(type, listener) {
  navigationListeners[type] = listener;
};
global.requestAnimationFrame = function requestAnimationFrame(callback) { callback(); };
global.MutationObserver = class MutationObserver {
  disconnect() {}
  observe(target) {
    observedCaptionTargets.push(target);
  }
};
global.document = {
  querySelectorAll(selector) {
    return selector === ".ytp-caption-segment" ? captionSegments : [];
  },
  querySelector(selector) {
    if (selector === "video") return video;
    return selector === "#movie_player, .html5-video-player" ? player : null;
  }
};
global.UncensoredRules = {
  CENSORED_TOKEN: "[__]",
  CENSORED_TOKEN_REGEX: /\[__\]/,
  ALLOWED_WORDS: ["fuck", "shit"],
  hasCensoredToken(text) {
    return /\[__\]/.test(text);
  },
  applyDeterministicRules() {
    return { replacements: [{ word: "shit" }] };
  }
};

const audio = require("../src/audio-capture");
const contextToken = {
  tokenIndex: 1,
  timeSeconds: 1,
  context: "what [__] now",
  eventIndex: 1,
  eventTokenIndex: 0
};
const deterministicToken = Object.assign({}, contextToken, {
  deterministicWord: "fuck"
});

audio.rememberTimedTextData({ tokens: [contextToken], timeline: [] }, "lang=en&kind=asr");
audio.rememberTimedTextData({ tokens: [deterministicToken], timeline: [] }, "lang=en&kind=asr");
assert.strictEqual(captionSegment.textContent, "fucking");

captionSegment.textContent = "repeat [__] now";
video.currentTime = 100;
audio.rememberTimedTextData({
  tokens: [
    Object.assign({}, contextToken, { tokenIndex: 0, eventIndex: 0, timeSeconds: 10, deterministicWord: "fuck" }),
    Object.assign({}, contextToken, { tokenIndex: 1, eventIndex: 1, timeSeconds: 100, deterministicWord: "shit" })
  ],
  timeline: [
    { eventIndex: 0, startTime: 10, endTime: 11, text: "repeat [__] now", firstTokenIndex: 0, tokenCount: 1 },
    { eventIndex: 1, startTime: 100, endTime: 101, text: "repeat [__] now", firstTokenIndex: 1, tokenCount: 1 }
  ]
}, "lang=en&kind=asr");
assert.strictEqual(captionSegment.textContent, "repeat shit now");

captionSegment.textContent = "repeat [__] now";
video.currentTime = 10;
videoListeners.seeking();
assert.strictEqual(captionSegment.textContent, "repeat fuck now");

const upperCaption = { textContent: "come [__] you", contains() { return false; } };
const lowerCaption = { textContent: "[__] piece", contains() { return false; } };
captionSegments = [upperCaption, lowerCaption];
video.currentTime = 150;
audio.rememberTimedTextData({
  tokens: [
    Object.assign({}, contextToken, { tokenIndex: 0, eventIndex: 0, timeSeconds: 148, deterministicWord: "fuck" }),
    Object.assign({}, contextToken, { tokenIndex: 1, eventIndex: 1, timeSeconds: 150, deterministicWord: "shit" })
  ],
  timeline: [
    { eventIndex: 0, startTime: 147, endTime: 151, text: "come [__] you", firstTokenIndex: 0, tokenCount: 1 },
    { eventIndex: 1, startTime: 149, endTime: 153, text: "[__] piece", firstTokenIndex: 1, tokenCount: 1 }
  ]
}, "lang=en&kind=two-rows");
assert.strictEqual(upperCaption.textContent, "come fuck you");
assert.strictEqual(lowerCaption.textContent, "shit piece");

captionSegments = [captionSegment];

captionSegment.textContent = "repeat [__] now";
video.currentTime = 103;
audio.rememberTimedTextData({
  tokens: [
    Object.assign({}, contextToken, { tokenIndex: 0, eventIndex: 0, timeSeconds: 100, deterministicWord: "fuck" }),
    Object.assign({}, contextToken, { tokenIndex: 1, eventIndex: 1, timeSeconds: 105, deterministicWord: "shit" })
  ],
  timeline: [
    { eventIndex: 0, startTime: 100, endTime: 104, text: "repeat [__] now", firstTokenIndex: 0, tokenCount: 1 },
    { eventIndex: 1, startTime: 105, endTime: 109, text: "repeat [__] now", firstTokenIndex: 1, tokenCount: 1 }
  ]
}, "lang=en&kind=");
assert.strictEqual(captionSegment.textContent, "repeat [__] now");

audio.setOptions({ rulesEnabled: false, whisperEnabled: true, audioNeeded: true });
captionSegment.textContent = "cached [__] now";
video.currentTime = 200;
const cachedToken = Object.assign({}, contextToken, {
  tokenIndex: 2,
  eventIndex: 2,
  timeSeconds: 200,
  context: "cached [__] now"
});
audio.rememberTimedTextData({
  tokens: [cachedToken],
  timeline: [
    { eventIndex: 2, startTime: 200, endTime: 201, text: "cached [__] now", firstTokenIndex: 2, tokenCount: 1 }
  ]
}, "lang=en&kind=asr", [{
  tokenIndex: 2,
  word: "fuck",
  source: "media",
  timeSeconds: 200,
  normalizedContext: "cached [__] now"
}]);
assert.strictEqual(captionSegment.textContent, "cached fuck now");

captionSegment.textContent = "fresh [__] now";
const freshToken = Object.assign({}, cachedToken, { context: "fresh [__] now" });
audio.rememberTimedTextData({ tokens: [freshToken], timeline: [] }, "lang=en&kind=other", [{
  tokenIndex: 2,
  word: "fuck",
  source: "media",
  timeSeconds: 200,
  normalizedContext: "stale [__] now"
}]);
assert.strictEqual(captionSegment.textContent, "fresh [__] now");
assert.strictEqual(audio.debugState().resolvedTokens.length, 0);

const previousPlayer = player;
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr");
assert.strictEqual(audio.debugState().pendingTokens.length, 1);
global.location.href = "https://www.youtube.com/watch?v=next";
audio.rememberTimedTextData({ tokens: [], timeline: [] }, "lang=en&kind=asr", [], "next");
assert.strictEqual(audio.debugState().pendingTokens.length, 0);
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr", [], "next");
assert.strictEqual(audio.debugState().pendingTokens.length, 1);
player = {};
navigationListeners["yt-navigate-finish"]();
assert.strictEqual(audio.debugState().pendingTokens.length, 1);
assert.notStrictEqual(player, previousPlayer);
assert.strictEqual(observedCaptionTargets.at(-1), player);

global.location.href = "https://www.youtube.com/results?search_query=third";
navigationListeners["yt-navigate-finish"]();
assert.strictEqual(audio.debugState().pendingTokens.length, 0);
global.location.href = "https://www.youtube.com/watch?v=third";
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr", [], "third");
navigationListeners["yt-navigate-finish"]();
assert.strictEqual(audio.debugState().pendingTokens.length, 1);

console.log("extension-wiring.test.js passed");
