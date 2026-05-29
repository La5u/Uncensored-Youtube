const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

const content = read("src/content.js");
const pageHook = read("src/page-hook.js");
const host = read("src/whisper-host.js");
const audioCapture = read("src/audio-capture.js");

assert.ok(content.indexOf("\"src/sabr-parser.js\"") < content.indexOf("\"src/page-hook.js\""));
assert.ok(content.indexOf("injectScriptsSequentially(scripts)") < content.indexOf("loadSettings().then"));

assert.ok(pageHook.includes("audioReplacements.clear();"));
assert.ok(!pageHook.includes("fetchGoogleAudio"));
assert.ok(!pageHook.includes("bestGoogleAudioUrl"));

assert.ok(host.includes("var streamParsers = new Map();"));
assert.ok(host.includes("streamParsers.set(streamId, parser);"));
assert.ok(!host.includes("activeChunkStreamId"));
assert.ok(host.includes("} else {\n          tokenQueue.delete(key);\n        }"));
assert.ok(host.includes("catch(function failed(error) {\n        tokenQueue.delete(key);"));
assert.ok(host.includes("TRANSCRIBE_TIMEOUT_MS"));
assert.ok(host.includes("Whisper worker timed out"));
assert.ok(audioCapture.includes("var backgroundAudioStreamIds = new Set();"));
assert.ok(audioCapture.includes("pending tokens waiting for page audio"));
assert.ok(audioCapture.includes("backgroundAudioStreamIds.size"));

console.log("extension-wiring.test.js passed");
