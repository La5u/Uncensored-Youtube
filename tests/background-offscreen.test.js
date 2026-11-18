const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

let contextsCalls = 0;
let deliveryCalls = 0;
let createCalls = 0;
let onMessage;
const context = {
  Promise,
  Set,
  Error,
  chrome: {
    runtime: {
      getManifest() { return { background: { service_worker: "src/background.js" } }; },
      getURL(path) { return "chrome-extension://test/" + path; },
      getContexts() {
        contextsCalls += 1;
        return Promise.resolve(contextsCalls === 1 ? [{}] : []);
      },
      sendMessage() {
        deliveryCalls += 1;
        return deliveryCalls === 1
          ? Promise.reject(new Error("offscreen disappeared"))
          : Promise.resolve({ ok: true });
      },
      onMessage: {
        addListener(listener) { onMessage = listener; }
      }
    },
    offscreen: {
      createDocument() {
        createCalls += 1;
        return Promise.resolve();
      }
    }
  }
};
context.globalThis = context;
vm.runInNewContext(fs.readFileSync("src/background.js", "utf8"), context);

function preload() {
  return new Promise((resolve) => {
    onMessage({ uncensoredWhisper: true, type: "preload", data: {} }, { tab: { id: 1 } }, resolve);
  });
}

(async function testDeliveryRetry() {
  assert.strictEqual((await preload()).error, "offscreen disappeared");
  assert.strictEqual((await preload()).ok, true);
  assert.strictEqual(contextsCalls, 2);
  assert.strictEqual(createCalls, 1);
  // Two tabs may finish inference before either gets a storage response.
  let stored = { whisperSpeed: [0.5, 0.5, 2] };
  const recommendations = [];
  context.chrome.storage = { local: {
    get: (defaults) => Promise.resolve(Object.assign({}, defaults, stored)),
    set: async (values) => {
      await Promise.resolve();
      stored = Object.assign({}, stored, values);
      recommendations.push(values.autoMode);
    }
  } };
  const timing = (id, seconds) => new Promise((resolve, reject) => {
    if (onMessage({ uncensoredWhisper: true, type: "recordSpeed", data: { seconds, slots: 1 } },
      { tab: { id } }, resolve) !== true) reject(new Error("Expected asynchronous timing response"));
  });
  await Promise.all([timing(1, 0.69), timing(2, 2.76)]);
  assert.deepStrictEqual(stored.whisperSpeed, [0.5, 0.5, 2, 0.5, 2]);
  assert.deepStrictEqual(recommendations, ["rules-first", "whisper-first"]);
  assert.strictEqual(deliveryCalls, 2, "timings only use the shared background host");
  console.log("background-offscreen.test.js passed");
})().catch(function reportFailure(error) {
  console.error(error);
  process.exitCode = 1;
});
