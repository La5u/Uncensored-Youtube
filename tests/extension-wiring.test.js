const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

const content = read("src/content.js");
const popup = read("src/popup.html");
const popupScript = read("src/popup.js");
const chromiumManifest = JSON.parse(read("manifest.chromium.json"));
const firefoxManifest = JSON.parse(read("manifest.firefox.json"));
const injectedScripts = [
  "src/page-hook.js",
  "src/rules-compiler.js",
  "src/rule-data/language.js",
  "src/rule-data/exact.js",
  "src/rule-data/grammar.js",
  "src/rule-data/priors.js",
  "src/rules-data.js",
  "src/rules.js",
  "src/timedtext.js"
];
const contentScripts = injectedScripts.slice(1).concat([
  "src/sabr-parser.js",
  "src/audio-capture.js",
  "src/content.js"
]);

assert.ok(chromiumManifest.permissions.includes("offscreen"));
assert.strictEqual(chromiumManifest.message_serialization, "structured_clone");
assert.deepStrictEqual(chromiumManifest.web_accessible_resources[0].resources, injectedScripts);
assert.deepStrictEqual(firefoxManifest.web_accessible_resources[0].resources, injectedScripts);
assert.deepStrictEqual(chromiumManifest.content_scripts[0].js, contentScripts);
assert.deepStrictEqual(firefoxManifest.content_scripts[0].js, contentScripts);
assert.ok(injectedScripts.every((script, index) => index === injectedScripts.length - 1 ||
  content.indexOf(`"${script}"`) < content.indexOf(`"${injectedScripts[index + 1]}"`)));
assert.ok(popup.includes('id="metricsLabel"'));
assert.ok(popup.includes('id="versionLabel"'));
assert.ok(popupScript.includes("rulesEnabled: true"));
assert.ok(popupScript.includes("whisperEnabled: true"));

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
  },
  formatWordCase(word) { return word; }
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
assert.strictEqual(audio.pendingTokenValues().length, 0);

audio.setOptions({ rulesEnabled: false, whisperEnabled: true, audioEnabled: true });
assert.strictEqual(audio.pendingTokenValues().length, 1);
audio.setOptions({ rulesEnabled: true, whisperEnabled: true, audioEnabled: true });
assert.strictEqual(audio.pendingTokenValues().length, 0);
audio.setOptions({ rulesEnabled: false, whisperEnabled: true, audioEnabled: true });
assert.strictEqual(audio.pendingTokenValues().length, 1);
const cachedToken = Object.assign({}, contextToken, {
  tokenIndex: 2,
  eventIndex: 2,
  timeSeconds: 200,
  context: "cached [__] now"
});
const previousPlayer = player;
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr");
assert.strictEqual(audio.pendingTokenValues().length, 1);
global.location.href = "https://www.youtube.com/watch?v=next";
audio.rememberTimedTextData({ tokens: [], timeline: [] }, "lang=en&kind=asr", "next");
assert.strictEqual(audio.pendingTokenValues().length, 0);
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr", "next");
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
audio.rememberTimedTextData({ tokens: [cachedToken], timeline: [] }, "lang=en&kind=asr", "third");
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
}, "lang=en&kind=asr", "collision");
assert.strictEqual(audio.pendingTokenValues().length, 2);

const realConsole = console;
const debugCalls = [];
global.localStorage = { getItem: () => "1" };
global.console = {
  debug: (...args) => debugCalls.push(args.join(" ")),
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
  assert.deepStrictEqual(debugCalls, [`[uncensored] new video ${videoId}`]);
}

console.log("extension-wiring.test.js passed");
