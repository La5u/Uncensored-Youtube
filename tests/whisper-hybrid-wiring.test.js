const assert = require("assert");
const fs = require("fs");

// The worker loads whisper-local directly. Keep a real candidate-only request
// here so the worker payload shape cannot regress to requiring a rule word.
let transcriptionCalls = 0;
global.transformers = {
  env: { backends: { onnx: { wasm: {} } } },
  pipeline: () => Promise.resolve(() => (++transcriptionCalls === 1 ? "fuck" : "fuck shit"))
};
const whisper = require("../src/whisper-local");

// Real cached row OjMPJVmXxV8:14: the stored morphology is not one of the
// runtime candidates, so arbitration must not invent the first candidate.
const ojDecision = whisper.decisionFromTranscript(
  " dragging the Danish girl, both fucks the Danish, I could never have",
  ["fuck", "shit"],
  "dreams ha dragging the Danish girl well [__] the Danish I could never abide that",
  {}
);
assert.strictEqual(ojDecision.word, "");
assert.strictEqual(whisper.arbitrateHybridResolution("", ojDecision, ["fuck", "shit"]), ojDecision);

Promise.all([
  whisper.transcribeDetailed(new Float32Array([0.1]), ["fuck", "shit"], "say [__] then", {
    hybridRuleWord: "",
    hybridRuleCandidates: ["fuck", "shit"]
  }),
  whisper.transcribeDetailed(new Float32Array([0.1]), ["fuck", "shit"], "say [__] then [__]", {
    contexts: ["say [__]", "then [__]"],
    previousWords: ["say", "then"],
    slotCount: 2,
    hybridRuleWords: ["", ""],
    hybridRuleCandidatesBySlot: [["fuck"], ["shit"]]
  })
]).then(([single, group]) => {
  assert.strictEqual(single.word, "fuck");
  assert.strictEqual(single.evidence, "transcript");
  assert.strictEqual(single.hybridCrossFamily, true);
  assert.deepStrictEqual(group.slotWords, ["fuck", "shit"]);
  assert.deepStrictEqual(group.slotHybridCrossFamily, [true, true]);
  assert.ok(fs.readFileSync("src/whisper-module-worker.js", "utf8").includes('import "./whisper-local.js";'));
  console.log("whisper-hybrid-wiring.test.js passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
