const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

let pipelineCalls = 0;
const context = {
  Promise,
  transformers: {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline() {
      pipelineCalls += 1;
      return pipelineCalls === 1
        ? Promise.reject(new Error("temporary model failure"))
        : Promise.resolve(function transcriber() {});
    }
  },
  module: { exports: {} }
};
vm.runInNewContext(fs.readFileSync("src/whisper-local.js", "utf8"), context);
const whisper = context.module.exports;

(async function testRetry() {
  await assert.rejects(whisper.preload(), /temporary model failure/);
  assert.strictEqual(await whisper.preload(), true);
  assert.strictEqual(pipelineCalls, 2);
  console.log("whisper-init.test.js passed");
})().catch(function reportFailure(error) {
  console.error(error);
  process.exitCode = 1;
});
