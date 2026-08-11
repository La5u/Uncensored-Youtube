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
  Worker: function Worker() {},
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
  },
  setTimeout,
  clearTimeout
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
  console.log("background-offscreen.test.js passed");
})().catch(function reportFailure(error) {
  console.error(error);
  process.exitCode = 1;
});
