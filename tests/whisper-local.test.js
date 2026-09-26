const assert = require("assert");
const whisper = require("../src/whisper-local");

// Minimal stand-in for transformers.js: a word-level tokenizer and a cached
// decoder whose next-token probabilities depend only on the previous token.
const VOCAB = ["<pad>", " so", " what", " the", " fuck", " Fuck", " fucking", " Fucking", " shit", " Shit",
  " mother", "fucker", "fucking#", " up", " you", " is"];
const id = (piece) => {
  const index = VOCAB.indexOf(piece);
  if (index < 0) throw new Error(`unknown piece ${piece}`);
  return index;
};
class Tensor {
  constructor(type, data, dims) {
    Object.assign(this, typeof type === "string" ? { type, data, dims } : { data: [], dims: [1] });
    this.disposed = false;
  }
  dispose() { this.disposed = true; }
}
const transformers = {
  Tensor,
  cat: (list) => new Tensor("float32", [], [list.length])
};

function fakeAsr(first, next) {
  const tokenizer = {
    encode(text) {
      return text.trim().split(" ").flatMap((word) => {
        if (/^[Mm]otherfucker$/.test(word)) return [id(" mother"), id("fucker")];
        if (/^[Mm]otherfucking$/.test(word)) return [id(" mother"), id("fucking#")];
        return VOCAB.includes(" " + word) ? [id(" " + word)] : [id(" so")];
      });
    }
  };
  const logits = (rows) => {
    const data = new Float32Array(rows.length * VOCAB.length).fill(-1e4);
    rows.forEach((probs, row) => Object.entries(probs || {}).forEach(([piece, p]) => {
      data[row * VOCAB.length + id(piece)] = Math.log(p);
    }));
    return data;
  };
  const cache = () => ({
    "present.0.decoder.key": new Tensor("float32", [], [1]),
    "present.0.encoder.key": new Tensor("float32", [], [1])
  });
  const model = async ({ decoder_input_ids: ids, past_key_values: past }) => {
    if (!past) {
      const length = ids.dims[1];
      const rows = Array(length).fill(null);
      rows[length - 1] = first;
      return { logits: new Tensor("float32", logits(rows), [1, length, VOCAB.length]), ...cache() };
    }
    const rows = Array.from(ids.data, (token) => next[VOCAB[Number(token)]]);
    return { logits: new Tensor("float32", logits(rows), [rows.length, 1, VOCAB.length]), ...cache() };
  };
  const processor = async () => ({ input_features: new Tensor("float32", new Float32Array(80 * 3000), [1, 80, 3000]) });
  processor.feature_extractor = {
    config: { nb_max_frames: 3000, hop_length: 160, n_fft: 400, feature_size: 80 },
    // Stand-in log-mel of the real audio only: [bins, frames].
    _extract_fbank_features: async (waveform) => {
      const frames = Math.floor(waveform.length / 160);
      return { dims: [80, frames], data: new Float32Array(80 * frames).fill(1) };
    }
  };
  const asr = { tokenizer, model, processor, encodes: 0 };
  model.sessions = { model: { run: async () => { asr.encodes += 1; return { last_hidden_state: {} }; } } };
  return asr;
}

const score = async (first, next, candidates, slot) => (await whisper.scoreSlots(
  transformers, fakeAsr(first, next), new Float32Array([0.1]), candidates, [slot]))[0];
const CANDIDATES = ["fuck", "fucking", "shit", "motherfucker", "motherfucking"];

(async () => {
  // Confident candidate after the caption prefix.
  let decision = await score({ " fucking": 0.9, " so": 0.1 }, { " fucking": { " up": 0.5 } }, CANDIDATES,
    { prefix: "so what the", nextWord: "up" });
  assert.deepStrictEqual([decision.word, decision.evidence], ["fucking", "candidate-score"]);

  // Every candidate below the gate (log P < -4) abstains.
  decision = await score({ " so": 0.97, " fuck": 0.01, " shit": 0.01 }, {}, CANDIDATES, { prefix: "so" });
  assert.deepStrictEqual([decision.word, decision.evidence], ["", "none"]);

  // Among gated words the next caption word picks the form.
  decision = await score({ " fuck": 0.5, " fucking": 0.45 }, {
    " fuck": { " up": 0.01, " you": 0.99 }, " fucking": { " up": 0.9, " you": 0.1 }
  }, CANDIDATES, { prefix: "what the", nextWord: "Up!" });
  assert.strictEqual(decision.word, "fucking");
  decision = await score({ " fuck": 0.5, " fucking": 0.45 }, {}, CANDIDATES, { prefix: "what the" });
  assert.strictEqual(decision.word, "fuck");

  // Multi-token words are scored step by step with the cache.
  decision = await score({ " mother": 0.8, " so": 0.2 }, {
    " mother": { fucker: 0.9, "fucking#": 0.05 }
  }, CANDIDATES, { prefix: "you" });
  assert.strictEqual(decision.word, "motherfucker");

  // Lower-case and capitalised variants are summed per word.
  decision = await score({ " shit": 0.01, " Shit": 0.01, " so": 0.98 }, {}, CANDIDATES, {});
  assert.strictEqual(decision.word, "shit");
  assert.ok(decision.score >= whisper.MIN_LOG_PROB);

  // One 30 s encoding serves every slot in the window; rule words arbitrate per slot.
  const shared = fakeAsr({ " fucking": 0.9, " so": 0.1 }, {});
  const decisions = await whisper.scoreSlots(transformers, shared, new Float32Array([0.1]), CANDIDATES,
    [{ prefix: "so" }, { prefix: "so what the", hybridRuleWord: "shit", hybridRuleSource: "deterministic" }]);
  assert.strictEqual(shared.encodes, 1);
  assert.deepStrictEqual(decisions.map((d) => [d.word, Boolean(d.hybridCrossFamily)]), [["fucking", false], ["fucking", true]]);

  // Empty input is a terminal abstention; inference failures reach the caller.
  assert.deepStrictEqual((await whisper.transcribeDetailed(new Float32Array(), ["fuck"], "", { slots: [{}] })).decisions.map((d) => d.word), [""]);
  await assert.rejects(whisper.transcribeDetailed(new Float32Array([0.1]), ["fuck"], "", { slots: [{}] }));

  // Worker path: the runtime loads transformers globally and arbitrates with the rule word.
  global.transformers = Object.assign({
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => fakeAsr({ " fucking": 0.9, " so": 0.1 }, {})
  }, transformers);
  decision = (await whisper.transcribeDetailed(new Float32Array([0.1]), CANDIDATES, "", {
    slots: [{ prefix: "what the", hybridRuleWord: "shit", hybridRuleSource: "deterministic" }]
  })).decisions[0];
  assert.deepStrictEqual([decision.word, decision.hybridCrossFamily], ["fucking", true]);
  assert.ok(require("fs").readFileSync("src/whisper-module-worker.js", "utf8").includes('import "./whisper-local.js";'));

  // Hybrid contract: audio replaces any rule fill; when Whisper abstains the rule fill remains.
  assert.strictEqual(whisper.arbitrateHybridResolution(
    "shit", { word: "", evidence: "none" }, "deterministic"
  ).word, "shit");
  const hybrid = whisper.arbitrateHybridResolution("fuck", { word: "fucking", evidence: "candidate-score" }, "deterministic");
  assert.deepStrictEqual([hybrid.word, hybrid.hybridCrossFamily], ["fucking", true]);
  const noRule = { word: "shit", evidence: "candidate-score" };
  assert.strictEqual(whisper.arbitrateHybridResolution("", noRule), noRule);

  assert.strictEqual(whisper.normalizeText("F**king Motha-fucka"), "fucking motherfucker");
  console.log("whisper-local.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
