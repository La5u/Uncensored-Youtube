const assert = require("assert");
const fs = require("fs");
const path = require("path");

function read(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

const content = read("src/content.js");
const pageHook = read("src/page-hook.js");
const audioCapture = read("src/audio-capture.js");

assert.ok(content.indexOf("\"src/sabr-parser.js\"") < content.indexOf("\"src/page-hook.js\""));
assert.ok(content.indexOf("injectScriptsSequentially(scripts)") < content.indexOf("loadSettings().then"));

assert.ok(pageHook.includes("audioReplacements.clear();"));
assert.ok(!pageHook.includes("fetchGoogleAudio"));
assert.ok(!pageHook.includes("bestGoogleAudioUrl"));

assert.ok(audioCapture.includes("bgMessage(\"transcribe\""));
assert.ok(audioCapture.includes("var globalSabrParser = null;"));
assert.ok(audioCapture.includes("pending tokens waiting for page audio"));
assert.ok(audioCapture.includes("decodeSabrSegment"));

console.log("extension-wiring.test.js passed");
