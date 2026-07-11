const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

const content = read("src/content.js");
const pageHook = read("src/page-hook.js");
const audioCapture = read("src/audio-capture.js");

assert.ok(content.includes("src/sabr-worker.js"));
assert.ok(content.indexOf("loadSettings().then") < content.indexOf("injectScriptsSequentially(scripts)"));

assert.ok(pageHook.includes("audioReplacements.clear();"));
assert.ok(!pageHook.includes("fetchGoogleAudio"));
assert.ok(!pageHook.includes("bestGoogleAudioUrl"));

assert.ok(audioCapture.includes("bgMessage(\"transcribe\""));
assert.ok(audioCapture.includes("var decodeQueue = Promise.resolve();"));
assert.ok(audioCapture.includes("uncensored-whisper-resolution"));
assert.ok(audioCapture.includes("VISIBLE_REAPPLY_SECONDS"));
assert.ok(!audioCapture.includes("root.__uncensoredResolveToken"));
assert.ok(audioCapture.includes("beforeMatches || afterMatches"));
assert.ok(audioCapture.includes("readMediaWindow"));
assert.ok(audioCapture.includes("whisper model starting"));
assert.ok(audioCapture.includes("whisper model started"));

const captionSegment = { textContent: "fucking" };
global.location = { href: "https://www.youtube.com/watch?v=test" };
global.addEventListener = function addEventListener() {};
global.document = {
  querySelectorAll(selector) {
    return selector === ".ytp-caption-segment" ? [captionSegment] : [];
  },
  querySelector() {
    return null;
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

audio.rememberTimedTextTokens([contextToken]);
audio.rememberTimedTextTokens([deterministicToken]);
assert.strictEqual(captionSegment.textContent, "fucking");

console.log("extension-wiring.test.js passed");
