const assert = require("assert");
const fs = require("fs");
const { ALLOWED_WORDS } = require("../src/rules");

// Exercise the actual single- and grouped-candidate transport path.
let transcriptionCalls = 0;
global.transformers = {
  env: { backends: { onnx: { wasm: {} } } },
  pipeline: () => Promise.resolve(() => (++transcriptionCalls === 1 ? "fucks" : "fuck shit"))
};
const whisper = require("../src/whisper-local");

const cachedMorphology = whisper.decisionFromTranscript(
  " dragging the Danish girl, both fucks the Danish, I could never have",
  ALLOWED_WORDS,
  "dreams ha dragging the Danish girl well [__] the Danish I could never abide that",
  {}
);
assert.strictEqual(cachedMorphology.word, "fucks");
assert.strictEqual(whisper.arbitrateHybridResolution(
  "", cachedMorphology, ["fuck", "shit"]
).word, "fuck");

Promise.all([
  whisper.transcribeDetailed(new Float32Array([0.1]), ALLOWED_WORDS, "say [__] then", {
    hybridRuleWord: "",
    hybridRuleCandidates: ["shit", "fuck"]
  }),
  whisper.transcribeDetailed(new Float32Array([0.1]), ALLOWED_WORDS, "say [__] then [__]", {
    contexts: ["say [__]", "then [__]"],
    previousWords: ["say", "then"],
    slotCount: 2,
    hybridRuleWords: ["shit", "fucking"],
    hybridRuleCandidatesBySlot: [["shit", "fuck"], ["fucking", "shit"]]
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
