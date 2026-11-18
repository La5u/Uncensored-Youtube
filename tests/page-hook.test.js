const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

class FakeXHR {
  constructor() {
    this.readyState = 0;
    this.responseType = "";
    this.body = "";
    this.listeners = new Set();
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  addEventListener(type, listener) {
    if (type === "readystatechange") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "readystatechange") this.listeners.delete(listener);
  }

  finish(body) {
    this.body = body;
    this.readyState = 4;
    Array.from(this.listeners).forEach((listener) => listener.call(this));
  }
}

Object.defineProperties(FakeXHR.prototype, {
  responseText: { configurable: true, get() { return this.body; } },
  response: { configurable: true, get() { return this.body; } }
});

const storage = new Map();
const listeners = new Map();
const timedTextDetails = [];
const patchOverrides = [];
const deterministicModes = [];
let fetchResult;
const audioMessages = [];
const context = {
  URL,
  URLSearchParams,
  Map,
  Set,
  Promise,
  Response,
  XMLHttpRequest: FakeXHR,
  location: { href: "https://www.youtube.com/watch?v=test" },
  document: { querySelector() { return null; } },
  sessionStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); }
  },
  fetch() { return fetchResult; },
  postMessage(message) { if (message.uncensoredSabrAudio) audioMessages.push(message); },
  addEventListener(type, listener) { listeners.set(type, listener); },
  dispatchEvent(event) {
    if (event.type === "uncensored-timedtext") timedTextDetails.push(JSON.parse(event.detail));
    listeners.get(event.type)?.call(context, event);
  },
  setTimeout(callback) { callback(); return 0; },
  clearTimeout() {},
  CustomEvent: class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options && options.detail;
    }
  },
  UncensoredRules: { ALLOWED_WORDS: ["fuck"] },
  UncensoredTimedText: {
    patchTimedTextBodyWithOverrides(body, overrides, useDeterministic) {
      patchOverrides.push(overrides.slice());
      deterministicModes.push(useDeterministic);
      return body.replace("[__]", overrides[0]?.word || "fuck");
    }
  },
  console
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "../src/page-hook.js"), "utf8"),
  context
);

const xhr = new FakeXHR();
const captionUrl = "https://www.youtube.com/api/timedtext?fmt=json3&v=test&lang=en";
xhr.open("GET", captionUrl);
xhr.finish('{"events":[{"segs":[{"utf8":"[__]"}]}]}');
assert.ok(xhr.responseText.includes("fuck"));
assert.strictEqual(xhr.listeners.size, 0);

const firstCaption = timedTextDetails.at(-1);
assert.strictEqual(firstCaption.body, xhr.body);
const firstTrack = firstCaption.trackId;
listeners.get("message").call(context, {
  source: context,
  data: {
    uncensoredWhisperResolution: JSON.stringify({
      tokenIndex: 0,
      word: "fuck",
      source: "media",
      videoId: "test",
      trackId: firstTrack
    })
  }
});
context.dispatchEvent(new context.CustomEvent("uncensored-settings", {
  detail: JSON.stringify({ rulesEnabled: false, whisperEnabled: false, videoId: "test" })
}));
const disabledTrack = new FakeXHR();
disabledTrack.open("GET", captionUrl);
disabledTrack.finish('{"events":[{"segs":[{"utf8":"[__]"}]}]}');
assert.strictEqual(patchOverrides.at(-1).length, 0);
// Acoustic-head and fused fills follow the sound-check switch.
for (const evidence of ["acoustic-head", "acoustic-fusion"]) {
  listeners.get("message").call(context, { source: vm.runInContext("globalThis", context), data: {
    uncensoredWhisperResolution: JSON.stringify({
    tokenIndex: 0, word: "fuck", source: "media", evidence, videoId: "test", trackId: firstTrack
  }) } });
  for (const acousticHead of [false, true]) {
    context.dispatchEvent(new context.CustomEvent("uncensored-settings", {
      detail: JSON.stringify({ rulesEnabled: false, whisperEnabled: true, acousticHead, videoId: "test" })
    }));
    const headTrack = new FakeXHR();
    headTrack.open("GET", captionUrl);
    headTrack.finish('{"events":[{"segs":[{"utf8":"[__]"}]}]}');
    assert.strictEqual(patchOverrides.at(-1).length, acousticHead ? 1 : 0, evidence);
  }
}
const clearMediaFill = {
  tokenIndex: 0, word: "", source: "media", evidence: "none", videoId: "test", trackId: firstTrack
};
for (const trackId of ["another-track", firstTrack]) {
  listeners.get("message").call(context, {
    source: vm.runInContext("globalThis", context),
    data: { uncensoredWhisperResolution: JSON.stringify({ ...clearMediaFill, trackId }) }
  });
  const refreshed = new FakeXHR();
  refreshed.open("GET", captionUrl);
  refreshed.finish(xhr.body);
  assert.strictEqual(patchOverrides.at(-1).length, trackId === firstTrack ? 0 : 1);
}
listeners.get("message").call(context, {
  source: vm.runInContext("globalThis", context),
  data: { uncensoredWhisperResolution: JSON.stringify({
    tokenIndex: 0, word: "fuck", source: "deterministic", evidence: "rule", videoId: "test", trackId: firstTrack
  }) }
});
for (const rulesEnabled of [true, false]) {
  context.dispatchEvent(new context.CustomEvent("uncensored-settings", {
    detail: JSON.stringify({ rulesEnabled, whisperEnabled: true, videoId: "test" })
  }));
  const fallbackTrack = new FakeXHR();
  fallbackTrack.open("GET", captionUrl);
  fallbackTrack.finish(xhr.body);
  assert.strictEqual(patchOverrides.at(-1)[0]?.source, rulesEnabled ? "deterministic" : undefined);
}
context.dispatchEvent(new context.CustomEvent("uncensored-settings", {
  detail: JSON.stringify({ rulesEnabled: false, whisperEnabled: true, videoId: "test" })
}));
const alternateTrack = new FakeXHR();
alternateTrack.open("GET", captionUrl + "&name=English&tlang=es&vssId=.es");
alternateTrack.finish('{"events":[{"segs":[{"utf8":"[__]"}]}]}');
assert.notStrictEqual(timedTextDetails.at(-1).trackId, firstTrack);
assert.strictEqual(patchOverrides.at(-1).length, 0);

context.dispatchEvent(new context.CustomEvent("uncensored-settings", {
  detail: JSON.stringify({ rulesEnabled: true, whisperEnabled: true, videoId: "test" })
}));
const hybridTrack = new FakeXHR();
hybridTrack.open("GET", captionUrl + "&name=hybrid");
hybridTrack.finish('{"events":[{"segs":[{"utf8":"[__]"}]}]}');
assert.strictEqual(deterministicModes.at(-1), true);
context.dispatchEvent(new context.CustomEvent("uncensored-settings", {
  detail: JSON.stringify({ rulesEnabled: true, whisperEnabled: false, videoId: "test" })
}));
const rulesTrack = new FakeXHR();
rulesTrack.open("GET", captionUrl + "&name=rules");
rulesTrack.finish('{"events":[{"segs":[{"utf8":"[__]"}]}]}');
assert.strictEqual(deterministicModes.at(-1), true);

// Reopening a patched XHR restores native responses for the next request.
xhr.open("GET", "https://www.youtube.com/youtubei/v1/player");
xhr.finish("next response");
assert.strictEqual(xhr.responseText, "next response");
assert.strictEqual(xhr.response, "next response");

const plain = new FakeXHR();
plain.open("GET", "https://www.youtube.com/youtubei/v1/player");
plain.finish("plain response");
assert.strictEqual(plain.responseText, "plain response");

(async function testTransparentFetchObservation() {
  for (const response of [
    new Response("synthetic response"),
    { get url() { throw new Error("url unavailable"); } },
    {
      url: "https://rr1.googlevideo.com/videoplayback?sabr=1",
      clone() { throw new Error("response cannot be cloned"); }
    }
  ]) {
    fetchResult = Promise.resolve(response);
    assert.strictEqual(await context.fetch("/youtubei/v1/browse"), response,
      "observation errors must not replace or reject a successful response");
  }

  const networkError = new Error("network failed");
  fetchResult = Promise.reject(networkError);
  await assert.rejects(context.fetch("/youtubei/v1/browse"), (error) => error === networkError,
    "real Fetch failures must pass through unchanged");

  // Audio requested during one navigation must not be relabeled after a newer one starts.
  context.dispatchEvent(new context.CustomEvent("uncensored-settings", {
    detail: JSON.stringify({ rulesEnabled: true, whisperEnabled: true, audioEnabled: true, videoId: "test" })
  }));
  let cancelled = false;
  listeners.get("yt-navigate-start")();
  fetchResult = Promise.resolve({
    url: "https://rr1.googlevideo.com/videoplayback?sabr=1",
    clone() {
      return { body: {
        cancel() { cancelled = true; return Promise.resolve(); },
        getReader() { return { read: () => Promise.resolve({ done: true }), cancel: () => Promise.resolve() }; }
      } };
    }
  });
  await context.fetch("https://rr1.googlevideo.com/videoplayback?sabr=1");
  // The newer navigation's URL is live before its finish event resets audio settings.
  listeners.get("yt-navigate-start")();
  context.location.href = "https://www.youtube.com/watch?v=newer";
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  assert.ok(cancelled, "superseded navigation audio is cancelled");
  assert.strictEqual(audioMessages.length, 0);

  console.log("page-hook.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
