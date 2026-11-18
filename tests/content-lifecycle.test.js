const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const listeners = {};
const messages = [];
const settingsEvents = [];
let injected = 0;
let storageListener = null;
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
    storage: {
      // No explicit mode choice; this device was measured fast enough for Whisper first.
      local: { get(defaults) { return Promise.resolve(Object.assign({}, defaults, { acousticHead: false, autoMode: "whisper-first" })); } },
      onChanged: { addListener(listener) { storageListener = listener; } }
    },
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
const analyses = [];
const rememberedTracks = [];
context.UncensoredTimedText = {
  collectTimedTextData(body, rules) {
    analyses.push([body, rules]);
    return body === "clean" ? { parsed: true, tokens: [] } : { parsed: true, tokens: [{}] };
  }
};
let decoderResets = 0;
context.UncensoredSabrParser = {
  createStreamDecoder() { return { reset() { decoderResets += 1; }, push() { return []; } }; }
};
context.UncensoredAudioInference = {
  rememberTimedTextData(data, trackId) { rememberedTracks.push([data, trackId]); }
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
  // The stored acoustic-head switch reaches the hook and audio capture, and follows changes.
  assert.strictEqual(last.detail.acousticHead, false);
  storageListener({ acousticHead: { newValue: true } }, "local");
  assert.strictEqual(settingsEvents.at(-1).detail.acousticHead, true);

  storageListener({ enabled: { newValue: false } }, "local");
  analyses.length = 0;
  const beforeReplacement = rememberedTracks.length;
  sendTrack("old", "lang=fr");
  sendTrack("censored", "lang=en");
  assert.deepStrictEqual(analyses, [], "Off retains raw captions without analyzing them");
  assert.strictEqual(rememberedTracks.length, beforeReplacement, "Off defers forwarding track data");
  storageListener({ enabled: { newValue: true }, mode: { newValue: "whisper" } }, "local");
  assert.deepStrictEqual(analyses, [["censored", false]], "reenabling uses the latest track");
  storageListener({ mode: { newValue: null } }, "local");

  // Automatic mode: no explicit choice uses the measured mode, changed only at video start.
  const mode = () => settingsEvents.at(-1).detail.whisperFirst;
  const navigate = (videoId) => {
    context.location.href = "https://www.youtube.com/watch?v=" + videoId;
    listeners["yt-navigate-finish"]();
  };
  assert.strictEqual(mode(), true);
  storageListener({ autoMode: { newValue: "rules-first" } }, "local");
  sendTrack("censored", "lang=en");
  assert.strictEqual(mode(), true, "no switch mid-video");
  navigate("next");
  assert.strictEqual(settingsEvents.at(-1).detail.videoId, "next");
  assert.strictEqual(mode(), false, "applied at the next video start");
  // An explicit popup choice applies at once and sticks across automatic updates and videos.
  storageListener({ mode: { newValue: "whisper-first" } }, "local");
  assert.strictEqual(mode(), true);
  storageListener({ autoMode: { newValue: "rules-first" } }, "local");
  navigate("third");
  assert.strictEqual(settingsEvents.at(-1).detail.videoId, "third");
  assert.strictEqual(mode(), true);
  // Choosing Automatic again applies the measured mode at once.
  storageListener({ mode: { newValue: "auto" } }, "local");
  assert.strictEqual(mode(), false);
  // The popup switch turns everything off at once, across videos, keeping the chosen mode.
  const active = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const detail = settingsEvents.at(-1).detail;
    return [detail.rulesEnabled, detail.whisperEnabled];
  };
  storageListener({ enabled: { newValue: false } }, "local");
  assert.deepStrictEqual(await active(), [false, false]);
  navigate("fourth");
  assert.deepStrictEqual(await active(), [false, false]);
  storageListener({ enabled: { newValue: true }, mode: { newValue: "rules" } }, "local");
  assert.deepStrictEqual(await active(), [true, false]);
  console.log("content-lifecycle.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
