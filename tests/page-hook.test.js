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
  fetch() { return Promise.reject(new Error("unused")); },
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
    patchTimedTextBodyWithOverrides(body, overrides) {
      patchOverrides.push(overrides.slice());
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

const firstTrack = timedTextDetails.at(-1).trackId;
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
context.dispatchEvent(new context.CustomEvent("uncensored-settings", {
  detail: JSON.stringify({ rulesEnabled: false, whisperEnabled: true, videoId: "test" })
}));
const alternateTrack = new FakeXHR();
alternateTrack.open("GET", captionUrl + "&name=English&tlang=es&vssId=.es");
alternateTrack.finish('{"events":[{"segs":[{"utf8":"[__]"}]}]}');
assert.notStrictEqual(timedTextDetails.at(-1).trackId, firstTrack);
assert.strictEqual(patchOverrides.at(-1).length, 0);

const plain = new FakeXHR();
plain.open("GET", "https://www.youtube.com/youtubei/v1/player");
plain.finish("plain response");
assert.strictEqual(plain.responseText, "plain response");

console.log("page-hook.test.js passed");
