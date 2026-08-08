const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

const content = read("src/content.js");
const pageHook = read("src/page-hook.js");
const audioCapture = read("src/audio-capture.js");
const sabrParser = read("src/sabr-parser.js");
const background = read("src/background.js");
const offscreen = read("src/offscreen.js");
const whisperWorker = read("src/whisper-module-worker.js");
const popup = read("src/popup.html");
const popupScript = read("src/popup.js");
const chromiumManifest = JSON.parse(read("manifest.chromium.json"));
const firefoxManifest = JSON.parse(read("manifest.firefox.json"));

assert.ok(audioCapture.includes("token.eventIndex === next.token.eventIndex"));
assert.ok(audioCapture.includes("token.timeSeconds - AUDIO_CONTEXT_SECONDS"));
assert.ok(audioCapture.includes("Math.round((token.timeSeconds || 0) * 10)"));
assert.ok(audioCapture.includes('return token.tokenIndex + "\\n"'));
assert.ok(audioCapture.includes("tokens.slice(startIndex)"));
assert.ok(!audioCapture.includes("anchorCount"));
assert.ok(audioCapture.includes("var startTime = tokenWindow(group[0].token).startTime"));
assert.ok(!audioCapture.includes("availableTokenWindow"));
assert.ok(!audioCapture.includes("visibleAtPlayhead"));

assert.ok(content.includes("createStreamDecoder"));
assert.ok(content.includes("localArrayBuffer"));
assert.ok(content.includes("settings.whisperEnabled && Boolean(activeVideoId)"));
assert.ok(content.includes("var shouldCapture = shouldDecode"));
assert.ok(!content.includes("hasCensoredSlots"));
assert.ok(content.includes("captureAudioEnabled !== true"));
assert.ok(!content.includes("sabrRelayQueue"));
assert.ok(!content.includes("sabrGeneration"));
assert.ok(content.includes("message.videoId !== currentVideoId()"));
assert.ok(content.includes("syncVideo(detail.videoId || currentVideoId())"));
assert.ok(pageHook.includes("function timedTextVideoId(input)"));
assert.ok(pageHook.includes("player.getPlayerResponse"));
assert.ok(pageHook.includes('"uncensored-no-captions"'));
assert.ok(content.includes('"uncensored-no-captions"'));
assert.ok(pageHook.includes("if (videoId !== currentVideoId()) return response"));
assert.ok(pageHook.includes("if (!settings.rulesEnabled)"));
assert.ok(pageHook.includes("setTimeout(function dispatchTimedText()"));
assert.ok(content.includes("detail.videoId !== currentVideoId()"));
assert.strictEqual((content.match(/uncensoredIdle/g) || []).length, 1);
assert.ok(content.includes("setExtensionHostActive(shouldCapture)"));
assert.ok(content.includes("setExtensionHostActive(false)"));
assert.ok(content.indexOf("loadSettings().then") < content.indexOf("injectScriptsSequentially(scripts)"));
assert.ok(background.includes("runtime.runtime.getContexts"));
assert.ok(background.includes("src/offscreen.html"));
assert.ok(background.includes("offscreen.closeDocument"));
assert.ok(background.includes("message.uncensoredIdle"));
assert.ok(sabrParser.includes('text.indexOf("A_OPUS")'));
assert.ok(!background.includes("uncensoredSabr"));
assert.ok(!offscreen.includes("sabr-worker"));
assert.ok(offscreen.includes("src/whisper-module-worker.js"));
assert.ok(whisperWorker.includes("runtimeReady = import"));
assert.ok(chromiumManifest.permissions.includes("offscreen"));
assert.strictEqual(chromiumManifest.message_serialization, "structured_clone");
assert.strictEqual(chromiumManifest.minimum_chrome_version, "148");
const injectedScripts = [
  "src/page-hook.js",
  "src/rules-compiler.js",
  "src/rules-data.js",
  "src/rules.js",
  "src/timedtext.js"
];
assert.deepStrictEqual(chromiumManifest.web_accessible_resources[0].resources, injectedScripts);
assert.deepStrictEqual(firefoxManifest.web_accessible_resources[0].resources, injectedScripts);
const ruleScripts = [
  "src/rules-compiler.js",
  "src/rules-data.js",
  "src/rules.js"
];
assert.deepStrictEqual(chromiumManifest.content_scripts[0].js.slice(0, ruleScripts.length), ruleScripts);
assert.deepStrictEqual(firefoxManifest.content_scripts[0].js.slice(0, ruleScripts.length), ruleScripts);
assert.ok(ruleScripts.every((script, index) =>
  content.indexOf(`"${script}"`) < content.indexOf(`"${ruleScripts[index + 1] || "src/timedtext.js"}"`)
));
assert.ok(chromiumManifest.content_scripts[0].js.includes("src/sabr-parser.js"));
assert.ok(firefoxManifest.content_scripts[0].js.includes("src/sabr-parser.js"));
assert.ok(pageHook.includes("allowedResolutionWord"));
assert.ok(pageHook.includes("allowedStretchedWord"));
assert.ok(pageHook.includes("!Number.isInteger(detail.tokenIndex) || detail.tokenIndex < 0"));
assert.ok(!popup.includes("Recommended:"));
assert.ok(popup.includes('id="metricsLabel"'));
assert.ok(!popup.includes("benchmarkTooltip"));
assert.ok(!popupScript.includes("benchmarkTooltip"));
assert.ok(popupScript.includes('"% coverage · "'));
assert.ok(!popupScript.includes("Hybrid is recommended."));
assert.ok(!popup.includes("Benchmark:"));
assert.ok(popup.includes('id="versionLabel"'));
assert.ok(popupScript.includes("runtime.runtime.getManifest().version"));
assert.ok(popupScript.includes("rulesEnabled: true"));
assert.ok(popupScript.includes("whisperEnabled: true"));

assert.ok(pageHook.includes("audioReplacements.clear();"));
assert.ok(pageHook.includes("settings.captureAudio === true"));
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
assert.ok(pageHook.includes("navigationPending ||\n      settings.captureAudio !== false"));
assert.ok(pageHook.includes("requestDuringNavigation"));
assert.ok(pageHook.includes("duringNavigation ? currentVideoId() : responseVideoId"));
assert.strictEqual((pageHook.match(/installNetworkHooks\(\);/g) || []).length, 3);
assert.ok(pageHook.includes("videoId !== currentVideoId()"));
assert.ok(pageHook.includes("isGoogleVideoPlaybackUrl(response && response.url)"));
assert.ok(!pageHook.includes("captureMediaResponse"));
assert.ok(!pageHook.includes("preserveNetworkHooks"));
assert.ok(!pageHook.includes("fetchGoogleAudio"));
assert.ok(!pageHook.includes("bestGoogleAudioUrl"));

assert.ok(audioCapture.includes("bgMessage(\"transcribe\""));
assert.ok(audioCapture.includes("Whisper via extension host"));
assert.ok(audioCapture.includes("var decodeQueue = Promise.resolve();"));
assert.ok(audioCapture.includes("Audio decode timed out"));
assert.ok(audioCapture.includes("uncensoredWhisperResolution"));
assert.ok(pageHook.includes("uncensoredWhisperResolution"));
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
assert.ok(audioCapture.includes("encodedSegmentNeeded"));
assert.ok(!audioCapture.includes("Math.abs((token.timeSeconds || 0) - playhead)"));
assert.ok(audioCapture.includes("!tokenMetadataKnown || segmentNeeded(segment)"));
assert.ok(!audioCapture.includes("segmentInBufferedRange"));
assert.ok(audioCapture.includes("videoHasCensoredSlots"));
assert.ok(audioCapture.includes("whisper model starting"));
assert.ok(audioCapture.includes("whisper model started"));
assert.ok(audioCapture.includes('debugLog("new video", videoId)'));
assert.ok(audioCapture.includes("root.console.clear()"));
assert.ok(audioCapture.includes("uncensoredWhisperResolution"));
assert.ok(pageHook.includes("uncensoredWhisperResolution"));
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

assert.strictEqual(audio.arbitrateResolution(deterministicToken, {
  word: "shit", source: "media", evidence: "transcript"
}).word, "fuck");
assert.strictEqual(audio.arbitrateResolution(deterministicToken, {
  word: "shit", source: "media", evidence: "transcript-anchor"
}).word, "shit");
assert.strictEqual(audio.arbitrateResolution(contextToken, {
  word: "shit", source: "media", evidence: "transcript"
}).word, "shit");

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

captionSegment.textContent = "Stop. [__] hell";
video.currentTime = 110;
audio.rememberTimedTextData({
  tokens: [Object.assign({}, contextToken, {
    tokenIndex: 2,
    eventIndex: 2,
    timeSeconds: 110,
    context: "Stop. [__] hell",
    deterministicWord: "Fucking",
    deterministicCandidates: ["fucking", "Fucking"],
    deterministicAmbiguous: false
  })],
  timeline: [
    { eventIndex: 2, startTime: 110, endTime: 111, text: "Stop. [__] hell", firstTokenIndex: 2, tokenCount: 1 }
  ]
}, "lang=en&kind=formatted");
assert.strictEqual(captionSegment.textContent, "Stop. Fucking hell");
assert.strictEqual(audio.pendingTokenValues().length, 1);

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
assert.strictEqual(audio.resolvedTokenValues().length, 0);

const previousPlayer = player;
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr");
assert.strictEqual(audio.pendingTokenValues().length, 1);
global.location.href = "https://www.youtube.com/watch?v=next";
audio.rememberTimedTextData({ tokens: [], timeline: [] }, "lang=en&kind=asr", [], "next");
assert.strictEqual(audio.pendingTokenValues().length, 0);
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr", [], "next");
assert.strictEqual(audio.pendingTokenValues().length, 1);
player = {};
navigationListeners["yt-navigate-finish"]();
assert.strictEqual(audio.pendingTokenValues().length, 1);
assert.notStrictEqual(player, previousPlayer);
assert.strictEqual(observedCaptionTargets.at(-1), player);

global.location.href = "https://www.youtube.com/results?search_query=third";
navigationListeners["yt-navigate-finish"]();
assert.strictEqual(audio.pendingTokenValues().length, 0);
global.location.href = "https://www.youtube.com/watch?v=third";
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr", [], "third");
navigationListeners["yt-navigate-finish"]();
assert.strictEqual(audio.pendingTokenValues().length, 1);

global.location.href = "https://www.youtube.com/watch?v=collision";
const sameSlotContext = Object.assign({}, cachedToken, {
  timeSeconds: 300,
  context: "say [__] [__] now",
  eventIndex: 3
});
audio.rememberTimedTextData({
  tokens: [
    Object.assign({}, sameSlotContext, { tokenIndex: 3, eventTokenIndex: 0 }),
    Object.assign({}, sameSlotContext, { tokenIndex: 4, eventTokenIndex: 1 })
  ],
  timeline: []
}, "lang=en&kind=asr", [], "collision");
assert.strictEqual(audio.pendingTokenValues().length, 2);

const realConsole = console;
const debugCalls = [];
global.localStorage = { getItem: () => "1" };
global.console = {
  debug: (...args) => debugCalls.push(args.join(" ")),
  clear: () => debugCalls.push("clear"),
  log: (...args) => realConsole.log(...args)
};

for (const href of [
  "https://www.youtube.com/",
  "https://www.youtube.com/results?search_query=privacy",
  "https://www.youtube.com/playlist?list=PL123&v=privacy",
  "https://www.youtube.com/@channel",
  "https://www.youtube.com/@channel/videos",
  "https://www.youtube.com/watch"
]) {
  debugCalls.length = 0;
  global.location.href = href;
  navigationListeners["yt-navigate-finish"]();
  assert.strictEqual(debugCalls.length, 0, `non-video URL must not log: ${href}`);
}

for (const [href, videoId] of [
  ["https://www.youtube.com/watch?v=privacy", "privacy"],
  ["https://www.youtube.com/live/privacy-live", "privacy-live"],
  ["https://www.youtube.com/shorts/privacy-short", "privacy-short"]
]) {
  debugCalls.length = 0;
  global.location.href = href;
  navigationListeners["yt-navigate-finish"]();
  assert.deepStrictEqual(debugCalls, ["clear", `[uncensored] new video ${videoId}`]);
}

console.log("extension-wiring.test.js passed");
