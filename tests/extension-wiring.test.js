const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

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
assert.ok(popup.includes('id="mode" type="range" min="0" max="4"'));
assert.ok(popup.includes('id="versionLabel"'));
assert.ok(popup.includes('id="enabled" type="checkbox" role="switch" checked'));
// The popup's five slider stops and content.js's mode table must stay in step.
const popupModes = [...popupScript.matchAll(/\{ id: "([a-z-]+)"/gu)].map((match) => match[1]);
assert.deepStrictEqual(popupModes, ["rules", "rules-first", "auto", "whisper-first", "whisper"]);
assert.ok(popupModes.every((mode) => mode === "auto" || content.includes(`${mode.includes("-") ? `"${mode}"` : mode}: [`)));
assert.ok(popupScript.includes('var DEFAULT_MODE = "auto";'));

// Popup: stored values pick the slider stop; Automatic shows the next video’s recommendation.
async function popupShows(stored, toggleHead = false) {
  const elements = {}, listeners = {};
  const element = (id) => elements[id] || (elements[id] = {
    setAttribute() {}, addEventListener(type, listener) { listeners[id + type] = listener; }
  });
  require("vm").runInNewContext(popupScript, {
    document: { getElementById: element },
    chrome: { runtime: { getManifest: () => ({ version: "1" }) },
      storage: { local: { get: (defaults) => Promise.resolve(Object.assign({}, defaults, stored)), set() {} } } }
  });
  await new Promise((resolve) => setImmediate(resolve));
  if (toggleHead) {
    elements.acousticHead.checked = !elements.acousticHead.checked;
    listeners.acousticHeadchange();
  }
  return { precision: elements.modePrecision.textContent, coverage: elements.modeCoverage.textContent, mode: popupModes[elements.mode.value], current: elements.modeCurrent.hidden ? null : elements.modeCurrent.textContent,
    cpu: elements.modeCpu.textContent, soundCheck: !elements.acousticHead.disabled, enabled: !elements.modeControls.disabled };
}
(async () => {
  assert.deepStrictEqual(await popupShows({}), { precision: "Up to 89%", coverage: "Up to 87%", mode: "auto", current: "Next video: Rules first (measuring)", cpu: "Moderate", soundCheck: true, enabled: true });
  assert.deepStrictEqual(await popupShows({ autoMode: "whisper-first", whisperSpeed: [1, 1, 1, 1, 1] }),
    { precision: "Up to 97%", coverage: "Up to 95%", mode: "auto", current: "Next video: Whisper first", cpu: "High", soundCheck: true, enabled: true });
  assert.strictEqual((await popupShows({ rulesEnabled: true, whisperEnabled: true })).mode, "auto");
  assert.strictEqual((await popupShows({ whisperEnabled: false })).mode, "rules");
  assert.deepStrictEqual(await popupShows({ mode: "rules" }), { precision: "Up to 81%", coverage: "Up to 37%", mode: "rules", current: null, cpu: "Minimal", soundCheck: false, enabled: true });
  assert.strictEqual((await popupShows({ mode: "whisper", acousticHead: false })).coverage, "Up to 90%");
  assert.strictEqual((await popupShows({ mode: "whisper" }, true)).coverage, "Up to 90%");
  // Stored "off" and legacy both-off become the switch off with the slider at Automatic.
  for (const stored of [{ mode: "off" }, { rulesEnabled: false, whisperEnabled: false }]) {
    const shown = await popupShows(stored);
    assert.deepStrictEqual([shown.mode, shown.enabled], ["auto", false]);
  }
  assert.deepStrictEqual(await popupShows({ enabled: false, mode: "whisper" }).then((shown) => [shown.mode, shown.enabled]), ["whisper", false]);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

test("7. Sound check off shows figures only for measured combinations", async () => {
  for (const stored of [
    { mode: "whisper-first" }, { mode: "rules-first" },
    { mode: "auto", autoMode: "whisper-first" }, { mode: "auto", autoMode: "rules-first" }
  ]) {
    const { precision, coverage } = await popupShows(stored, true);
    assert.deepStrictEqual([precision, coverage], ["Not measured", "Not measured"], JSON.stringify(stored));
  }
  const decoder = await popupShows({ mode: "whisper", acousticHead: false });
  assert.deepStrictEqual([decoder.precision, decoder.coverage], ["Up to 97%", "Up to 90%"]);
});

test("9. AMO source notes name both current release archives", () => {
  assert.deepStrictEqual(read("AMO_SOURCE.md").match(/dist\/uncensored-youtube-(?:firefox|chromium)-[\d.]+\.zip/g), [
    `dist/uncensored-youtube-firefox-${firefoxManifest.version}.zip`,
    `dist/uncensored-youtube-chromium-${chromiumManifest.version}.zip`
  ]);
});

for (const file of ["docs/RULES.md", "docs/SESSION_HANDOFF.md"]) {
  test(`11. ${file} documents the generated rule group's release status`, () => {
    assert.match(read(file), /1\.6\.3 disables the generated word-class group and retains the diagnostic miner/);
  });
}
// The acoustic head: one popup switch, on by default, loaded where Whisper runs (both browsers' worker).
assert.ok(popup.includes('id="acousticHead" type="checkbox" checked'));
assert.ok(popupScript.includes("acousticHead: true") && content.includes("acousticHead: true"));
const worker = read("src/whisper-module-worker.js");
assert.ok(worker.includes('import "./acoustic-head.js";'));
assert.ok(worker.includes('UncensoredAcousticHead.load(new URL("./models/acoustic-head-cnn.bin"'));
assert.ok(worker.includes("acousticHead: options.acousticHead === false ? null : head"));
assert.ok(worker.includes('acousticHead: head.model ? "loaded" : "unavailable: " + head.error'));

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
// Frames run at once unless a test queues them to mimic a throttled (hidden) window.
let queuedFrames = null;
let captionObserverCallback = null;
global.requestAnimationFrame = function requestAnimationFrame(callback) {
  if (queuedFrames) queuedFrames.push(callback); else callback();
};
global.MutationObserver = class MutationObserver {
  constructor(callback) {
    captionObserverCallback = callback;
  }
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
audio.setOptions({ rulesEnabled: true, whisperEnabled: false });

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
    deterministicAmbiguous: false,
    deterministicTier: "exact"
  })],
  timeline: [
    { eventIndex: 2, startTime: 110, endTime: 111, text: "Stop. [__] hell", firstTokenIndex: 2, tokenCount: 1 }
  ]
}, "lang=en&kind=formatted");
assert.strictEqual(captionSegment.textContent, "Stop. Fucking hell");

// A re-rendered cue with a resolved slot is patched in the observer callback, before paint,
// even when animation frames are throttled; our own write does not trigger another patch.
queuedFrames = [];
const captionMutation = [{ target: { nodeType: 1, closest: () => true } }];
captionSegment.textContent = "Stop. [__] hell";
captionObserverCallback(captionMutation);
assert.strictEqual(captionSegment.textContent, "Stop. Fucking hell");
assert.strictEqual(queuedFrames.length, 0);
captionObserverCallback(captionMutation);
captionObserverCallback(captionMutation);
assert.strictEqual(captionSegment.textContent, "Stop. Fucking hell");
queuedFrames.splice(0).forEach((callback) => callback());
queuedFrames = null;
assert.strictEqual(audio.pendingTokenValues().length, 0);

audio.setOptions({ rulesEnabled: false, whisperEnabled: true, audioEnabled: true });
assert.strictEqual(audio.pendingTokenValues().length, 1);
// Rules first: an unambiguous rule fill is not queued for Whisper; Whisper first is.
audio.setOptions({ rulesEnabled: true, whisperEnabled: true, audioEnabled: true });
assert.strictEqual(audio.pendingTokenValues().length, 0);
audio.setOptions({ rulesEnabled: true, whisperEnabled: true, whisperFirst: true, audioEnabled: true });
assert.strictEqual(audio.pendingTokenValues().length, 1);
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
