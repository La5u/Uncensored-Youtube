const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const listeners = {};
const messages = [];
const settingsEvents = [];
let injected = 0;
const context = {
  URL,
  URLSearchParams,
  Promise,
  Set,
  Object,
  String,
  Boolean,
  JSON,
  CustomEvent: class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  },
  location: { href: "https://www.youtube.com/watch?v=test" },
  setTimeout(callback) {
    callback();
    return 0;
  },
  document: {
    createElement() {
      return { remove() {} };
    },
    documentElement: {
      appendChild(script) {
        injected += 1;
        if (script.onload) script.onload();
      }
    }
  },
  browser: {
    runtime: {
      getURL(path) { return "chrome-extension://test/" + path; },
      sendMessage(message) {
        messages.push(message);
        return Promise.resolve();
      }
    }
  }
};
context.window = context;
context.addEventListener = function addEventListener(type, listener) {
  listeners[type] = listener;
};
context.dispatchEvent = function dispatchEvent(event) {
  if (event.type === "uncensored-settings") settingsEvents.push({ injected, detail: JSON.parse(event.detail) });
};
context.UncensoredTimedText = {
  collectTimedTextData(body) {
    return body === "clean" ? { parsed: true, tokens: [] } : { parsed: true, tokens: [{}] };
  }
};
let decoderResets = 0;
context.UncensoredSabrParser = {
  createStreamDecoder() { return { reset() { decoderResets += 1; }, push() { return []; } }; }
};
context.UncensoredAudioInference = {
  rememberTimedTextData() {}
};

vm.runInNewContext(fs.readFileSync("src/content.js", "utf8"), context);

function sendTrack(body, trackId) {
  listeners["uncensored-timedtext"]({
    detail: JSON.stringify({ body, trackId, videoId: "test" })
  });
}

sendTrack("clean", "lang=es");
assert.strictEqual(messages.at(-1).uncensoredIdle, true);
sendTrack("censored", "lang=es");
assert.strictEqual(messages.at(-1).uncensoredActive, true);
const resetsWhileActive = decoderResets;
sendTrack("clean", "lang=fr");
assert.strictEqual(messages.at(-1).uncensoredIdle, true);
// Disabling capture frees decoder streams whose end messages it will no longer relay.
assert.strictEqual(decoderResets, resetsWhileActive + 1);

// Track events arrive before the page hook is injected; once injection finishes the hook
// must still receive the current settings even though the audio decision did not change.
(async function settingsReachInjectedHook() {
  await new Promise((resolve) => setImmediate(resolve));
  const last = settingsEvents.at(-1);
  assert.ok(injected > 0 && last.injected === injected, "settings dispatched after the last script loads");
  assert.strictEqual(last.detail.audioEnabled, false);
  console.log("content-lifecycle.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
