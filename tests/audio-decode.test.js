const assert = require("assert");

global.location = { href: "https://www.youtube.com/watch?v=test" };
global.document = {
  querySelector() { return null; },
  querySelectorAll() { return []; }
};
global.addEventListener = function addEventListener() {};
global.UncensoredRules = {
  CENSORED_TOKEN_REGEX: /\[__\]/,
  ALLOWED_WORDS: []
};

let decodeCalls = 0;
global.AudioContext = class AudioContext {
  decodeAudioData() {
    decodeCalls += 1;
    return decodeCalls === 1
      ? new Promise(function neverDecodes() {})
      : Promise.resolve({ duration: 10 });
  }
};

const nativeSetTimeout = global.setTimeout;
const nativeClearTimeout = global.clearTimeout;
let decodeTimeout;
global.setTimeout = function setTimeout(callback, delay) {
  if (delay === 15000) {
    decodeTimeout = callback;
    return -1;
  }
  return nativeSetTimeout.apply(this, arguments);
};
global.clearTimeout = function clearTimeout(id) {
  if (id === -1) return;
  nativeClearTimeout(id);
};

const audio = require("../src/audio-capture");
const first = audio.setSabrAudioData({ buffer: new ArrayBuffer(1), startMs: 0 });

new Promise(function waitForDecode(resolve) {
  nativeSetTimeout(resolve, 0);
}).then(function expireHungDecode() {
  assert.strictEqual(typeof decodeTimeout, "function");
  decodeTimeout();
  return first;
}).then(function decodeNextSegment() {
  return audio.setSabrAudioData({ buffer: new ArrayBuffer(1), startMs: 10000 });
}).then(function ignoreDuplicateSegment() {
  assert.strictEqual(audio.debugState().mediaAudio.segments.length, 1);
  audio.setOptions({ rulesEnabled: false, whisperEnabled: false, videoId: "test" });
  audio.rememberTimedTextData({
    tokens: [{ tokenIndex: 0, timeSeconds: 10, context: "say [__] now" }],
    timeline: []
  }, "lang=en&kind=asr", [], "test");
  audio.setOptions({ rulesEnabled: false, whisperEnabled: true, videoId: "test" });
  return audio.setSabrAudioData({ buffer: new ArrayBuffer(1), startMs: 10000 });
}).then(function verifyRecovery() {
  assert.strictEqual(decodeCalls, 3);
  return audio.setSabrAudioData({
    buffer: new ArrayBuffer(1),
    startMs: 100000,
    durationMs: 10000
  });
}).then(function ignoreAudioAwayFromCensoredSlots() {
  assert.strictEqual(decodeCalls, 3);
  console.log("audio-decode.test.js passed");
}).catch(function failed(error) {
  console.error(error);
  process.exitCode = 1;
});
