const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const listeners = {};
const messages = [];
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
context.dispatchEvent = function dispatchEvent() {};
context.UncensoredTimedText = {
  collectTimedTextData(body) {
    return body === "clean" ? { parsed: true, tokens: [] } : { parsed: true, tokens: [{}] };
  }
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
sendTrack("clean", "lang=fr");
assert.strictEqual(messages.at(-1).uncensoredIdle, true);

console.log("content-lifecycle.test.js passed");
