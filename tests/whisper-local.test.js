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
const tensors = [];
class Tensor {
  constructor(type, data, dims) {
    // Like Transformers, wrapping an ORT tensor borrows its identity, not a copy.
    this.ort_tensor = typeof type === "string" ? { type, data, dims, disposals: 0 } : type;
    if (typeof type === "string") tensors.push(this.ort_tensor);
  }
  get data() { this.assertAlive(); return this.ort_tensor.data; }
  get dims() { this.assertAlive(); return this.ort_tensor.dims; }
  assertAlive() { assert.strictEqual(this.ort_tensor.disposals, 0, "use after disposal"); }
  dispose() {
    this.assertAlive();
    this.ort_tensor.disposals += 1;
  }
}
const assertDisposed = (owned) => owned.forEach((tensor, index) => {
  assert.strictEqual(tensor.disposals, 1, `tensor ${index} must be disposed exactly once`);
});
const transformers = {
  Tensor,
  cat: (list) => {
    list.forEach((tensor) => tensor.assertAlive());
    return new Tensor("float32", [], [list.length]);
  }
};

function fakeAsr(first, next, options = {}) {
  const tokenizer = {
    encode(text) {
      if (options.fail === "tokenizer-before" || options.fail === "tokenizer-after" && asr.prefills) {
        throw new Error(options.fail);
      }
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
  const cache = (cross) => ({
    "present.0.decoder.key": new Tensor("float32", [], [1]),
    "present.0.encoder.key": cross || new Tensor("float32", [], [1])
  });
  const model = async ({ encoder_outputs: hidden, decoder_input_ids: ids, past_key_values: past }) => {
    hidden.assertAlive();
    ids.assertAlive();
    Object.values(past || {}).forEach((tensor) => tensor.assertAlive());
    if (!past) {
      asr.prefills += 1;
      if (options.fail === "prefill" || options.fail === "second-slot" && asr.prefills === 2) throw new Error(options.fail);
      const length = ids.dims[1];
      const rows = Array(length).fill(null);
      rows[length - 1] = typeof first === "function" ? first(ids) : first;
      const out = { logits: new Tensor("float32", logits(rows), [1, length, VOCAB.length]), ...cache() };
      if (options.fail === "prefill-output") {
        Object.defineProperty(out.logits, "data", { get() { throw new Error(options.fail); } });
      }
      return out;
    }
    asr.steps += 1;
    if (options.fail === `decoder-${asr.steps}`) throw new Error(options.fail);
    const rows = Array.from(ids.data, (token) => next[VOCAB[Number(token)]]);
    const cross = options.borrowCross ? new Tensor(past["past_key_values.0.encoder.key"].ort_tensor) : null;
    const out = { logits: new Tensor("float32", logits(rows), [rows.length, 1, VOCAB.length]), ...cache(cross) };
    if (options.fail === "step-output") {
      // A scoring failure after the decoder resolves still owns its outputs.
      Object.defineProperty(out.logits, "data", { get() { throw new Error(options.fail); } });
    }
    return out;
  };
  const processor = async () => ({ input_features: new Tensor("float32", new Float32Array(80 * 3000), [1, 80, 3000]) });
  processor.feature_extractor = {
    config: { nb_max_frames: 3000, hop_length: 160, n_fft: 400, feature_size: 80 },
    // Stand-in log-mel of the real audio only: [bins, frames].
    _extract_fbank_features: async (waveform) => {
      const frames = Math.floor(waveform.length / 160);
      const mel = new Tensor("float32", new Float32Array(80 * frames).fill(1), [80, frames]);
      if (options.fail === "mel-output") {
        Object.defineProperty(mel, "data", { get() { throw new Error(options.fail); } });
      }
      return mel;
    }
  };
  const asr = { tokenizer, model, processor, encodes: 0, prefills: 0, steps: 0 };
  model.sessions = { model: { run: async ({ input_features: features }, outputs) => {
    assert.strictEqual(features.disposals, 0);
    assert.deepStrictEqual(outputs, ["last_hidden_state"]);
    asr.encodes += 1;
    asr.features = Array.from(features.data);
    asr.featureDims = features.dims;
    if (options.fail === "encoder") throw new Error(options.fail);
    asr.hidden = new Tensor("float32", [], [1]);
    return { last_hidden_state: asr.hidden.ort_tensor };
  } } };
  return asr;
}

const score = async (first, next, candidates, slot) => (await whisper.scoreSlots(
  transformers, fakeAsr(first, next), new Float32Array([0.1]), candidates, [slot]))[0];
const CANDIDATES = ["fuck", "fucking", "shit", "motherfucker", "motherfucking"];

(async () => {
  // Confident candidate after the caption prefix.
  let decision = await score({ " fucking": 0.9, " so": 0.1 }, { " fucking": { " up": 0.5, " you": 0.5 } }, CANDIDATES,
    { prefix: "so what the", nextWord: "up" });
  assert.deepStrictEqual([decision.word, decision.evidence], ["fucking", "candidate-score"]);
  // Evidence: decoded words with and without the next caption word.
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
  assert.deepStrictEqual(decision.scores.map((entry) => entry.word), ["fucking"]);
  near(decision.scores[0].logp, Math.log(0.9));
  near(decision.scores[0].withNext, Math.log(0.9 * 0.5));

  // Every candidate below the gate (log P < -4) abstains.
  decision = await score({ " so": 0.97, " fuck": 0.01, " shit": 0.01 }, {}, CANDIDATES, { prefix: "so" });
  assert.deepStrictEqual([decision.word, decision.evidence], ["", "none"]);
  // Abstentions keep the sub-gate evidence.
  assert.deepStrictEqual(decision.scores.map((entry) => entry.word).sort(), ["fuck", "shit"]);
  near(decision.scores[0].logp, Math.log(0.01 / 0.99));

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

  // Only the real audio plus 2 s of silence is encoded: 1 s of audio -> 300 frames, the 102 stand-in mel frames then silence.
  await whisper.scoreSlots(transformers, shared, new Float32Array(16000), CANDIDATES, [{ prefix: "so" }]);
  assert.deepStrictEqual(shared.featureDims, [1, 80, 300]);
  assert.deepStrictEqual([shared.features[0], shared.features[101], shared.features[299]], [1, 1, (Math.max(4 - 4 - 8, -10) + 4) / 4]);
  // Audio filling the 30 s window keeps the processor's full 3000 frames.
  await whisper.scoreSlots(transformers, shared, new Float32Array(480000), CANDIDATES, [{ prefix: "so" }]);
  assert.deepStrictEqual(shared.featureDims, [1, 80, 3000]);

  // Adjacent blanks hear distinct words when the second is conditioned on the first;
  // blanks scored elsewhere are dropped, including decisions from a previous window.
  const sequential = fakeAsr((ids) => Number(ids.data[ids.data.length - 1]) === id(" fucking")
    ? { " shit": 0.9, " so": 0.1 } : { " fucking": 0.9, " so": 0.1 }, {});
  const prefills = [];
  const decoder = sequential.model;
  sequential.model = Object.assign(async (inputs) => {
    if (!inputs.past_key_values) {
      prefills.push(Array.from(inputs.decoder_input_ids.data.slice(2), (token) => VOCAB[Number(token)].trim()).join(" "));
    }
    return decoder(inputs);
  }, { sessions: decoder.sessions });
  const adjacentSlots = [
    { tokenIndex: 0, prefix: [{ word: "what" }, { word: "the" }] },
    { tokenIndex: 1, prefix: [{ tokenIndex: 3 }, { word: "what" }, { word: "the" }, { tokenIndex: 0 }] }
  ];
  const adjacent = await whisper.scoreSlots(transformers, sequential, new Float32Array([0.1]), CANDIDATES, adjacentSlots);
  assert.deepStrictEqual(adjacent.map((d) => d.word), ["fucking", "shit"]);
  assert.deepStrictEqual(prefills, ["what the", "what the fucking"]);
  const freshWindow = await whisper.scoreSlots(transformers, sequential, new Float32Array([0.1]), CANDIDATES, [adjacentSlots[1]]);
  assert.strictEqual(freshWindow[0].word, "fucking");
  assert.strictEqual(prefills[2], "what the");

  // A hybrid rule fallback is not something Whisper heard: after abstention it must
  // not enter the next slot's prefix, even though it is returned as the first fill.
  const abstaining = fakeAsr({ " so": 0.99, " fuck": 0.01 }, {});
  const abstainingDecoder = abstaining.model;
  abstaining.model = Object.assign(async (inputs) => {
    if (!inputs.past_key_values) {
      assert.deepStrictEqual(Array.from(inputs.decoder_input_ids.data.slice(2), Number), [id(" what"), id(" the")]);
    }
    return abstainingDecoder(inputs);
  }, { sessions: abstainingDecoder.sessions });
  const fallback = await whisper.scoreSlots(transformers, abstaining, new Float32Array([0.1]), CANDIDATES,
    [{ ...adjacentSlots[0], hybridRuleWord: "shit", hybridRuleSource: "deterministic" }, adjacentSlots[1]]);
  assert.deepStrictEqual(fallback.map((d) => d.word), ["shit", ""]);

  // Optional acoustic head: fills only uncertain slots that carry a time, and the next slot's
  // prefix keeps the decoder's word. A model-less stub head always proposes its first word.
  const stubHead = (threshold) => ({ words: ["shit"], threshold, margin: 1, frames: 2, dim: 1, before: 1,
    framesPerSecond: 50, models: [] });
  const headed = await whisper.scoreSlots(transformers, abstaining, new Float32Array([0.1]), CANDIDATES,
    [{ ...adjacentSlots[0], time: 1 }, adjacentSlots[1]], { acousticHead: stubHead(0) });
  assert.deepStrictEqual(headed.map((d) => [d.word, d.evidence]), [["shit", "acoustic-head"], ["", "none"]]);
  const belowThreshold = await whisper.scoreSlots(transformers, abstaining, new Float32Array([0.1]), CANDIDATES,
    [{ ...adjacentSlots[0], time: 1 }], { acousticHead: stubHead(0.5) });
  assert.strictEqual(belowThreshold[0].word, "");
  // A consulted slot reports the head's top word and probability, filled or not.
  assert.deepStrictEqual([headed[0].head, headed[1].head, belowThreshold[0].head],
    [{ word: "shit", p: 0 }, undefined, { word: "shit", p: 0 }]);
  const ruleKept = await whisper.scoreSlots(transformers, abstaining, new Float32Array([0.1]), CANDIDATES,
    [{ ...adjacentSlots[0], time: 1, hybridRuleWord: "fuck" }], { acousticHead: stubHead(0.5) });
  assert.deepStrictEqual([ruleKept[0].word, ruleKept[0].evidence, ruleKept[0].head], ["fuck", "rule", { word: "shit", p: 0 }]);
  const confident = await whisper.scoreSlots(transformers, fakeAsr({ " fucking": 0.9, " so": 0.1 }, {}),
    new Float32Array([0.1]), CANDIDATES, [{ prefix: "so", time: 1 }], { acousticHead: stubHead(0) });
  assert.strictEqual(confident[0].word, "fucking");
  assert.strictEqual(confident[0].head, undefined, "confident slots never consult the head");
  // A head file with fusion parameters is consulted on confident slots too and labels a changed
  // word "acoustic-fusion" (the stub heads above have none, so they stay on uncertain slots).
  const fusionHead = (weights) => Object.assign(stubHead(0), { words: ["shit", "fucking"],
    fusion: { weights, threshold: 0, unscored: [3, -40], family: ["shit", "fuck"] } });
  const fusedSlots = (weights) => whisper.scoreSlots(transformers, fakeAsr({ " fucking": 0.9, " so": 0.1 }, {}),
    new Float32Array([0.1]), CANDIDATES, [{ prefix: "so", time: 1 }], { acousticHead: fusionHead(weights) });
  const kept = await fusedSlots([0, 0, 1]);
  assert.deepStrictEqual([kept[0].word, kept[0].evidence, Boolean(kept[0].head)], ["fucking", "candidate-score", true]);
  assert.ok(Number.isFinite(kept[0].prunedMax) || kept[0].prunedMax === -Infinity);
  const replaced = await fusedSlots([0, 0, -1]);
  assert.deepStrictEqual([replaced[0].word, replaced[0].evidence, replaced[0].decoderWord], ["shit", "acoustic-fusion", "fucking"]);

  assertDisposed(tensors);

  // Track underlying tensors (not wrappers), including replacements over several
  // decoder steps/batches. One hidden state stays borrowed across both slots.
  const first = Object.fromEntries([" fuck", " Fuck", " fucking", " Fucking", " shit", " Shit", " mother"].map((piece) => [piece, 1 / 7]));
  const next = Object.fromEntries(VOCAB.map((piece) => [piece, { " up": 0.5, fucker: 0.4, "fucking#": 0.1 }]));
  for (const borrowCross of [false, true]) {
    for (const fail of [null, "encoder", "prefill", "prefill-output", "tokenizer-before", "tokenizer-after", "decoder-1", "decoder-2", "decoder-3", "step-output", "second-slot"]) {
      for (const longAudio of [false, true]) {
        const start = tensors.length;
        const asr = fakeAsr(first, next, { fail, borrowCross });
        const result = whisper.scoreSlots(transformers, asr, new Float32Array(longAudio ? 480000 : 1), CANDIDATES,
          [{ prefix: "so", nextWord: "up" }, { prefix: "what the", nextWord: "up" }]);
        if (fail) await assert.rejects(result, new RegExp(fail));
        else {
          assert.strictEqual((await result).length, 2);
          assert.strictEqual(asr.prefills, 2);
          assert.ok(asr.steps > 2, "exercise replacements and multiple batches");
        }
        assert.strictEqual(asr.encodes, 1);
        assertDisposed(tensors.slice(start));
      }
    }
  }

  const melStart = tensors.length;
  await assert.rejects(whisper.scoreSlots(transformers, fakeAsr(first, next, { fail: "mel-output" }),
    new Float32Array(1), CANDIDATES, [{}]), /mel-output/);
  assertDisposed(tensors.slice(melStart));

  // Partial tiling failures must release copies created before cat rejects.
  for (const failAt of [1, 2, 3, 4, 5, 6]) {
    const start = tensors.length;
    let cats = 0;
    const broken = { ...transformers, cat(list) {
      if (++cats === failAt) throw new Error("tiling");
      return transformers.cat(list);
    } };
    await assert.rejects(whisper.scoreSlots(broken, fakeAsr(first, next), new Float32Array(1), CANDIDATES,
      [{ nextWord: "up" }]), /tiling/);
    assertDisposed(tensors.slice(start));
  }

  // Empty input is a terminal abstention; inference failures reach the caller.
  assert.deepStrictEqual((await whisper.transcribeDetailed(new Float32Array(), ["fuck"], "", { slots: [{}] })).decisions.map((d) => d.word), [""]);
  await assert.rejects(whisper.transcribeDetailed(new Float32Array([0.1]), ["fuck"], "", { slots: [{}] }));

  // Worker path: the runtime loads transformers globally and arbitrates with the rule word.
  global.transformers = Object.assign({
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => fakeAsr({ " fucking": 0.9, " so": 0.1 }, {})
  }, transformers);
  const firstWindow = await whisper.transcribeDetailed(new Float32Array([0.1]), CANDIDATES, "", {
    slots: [{ prefix: "what the", hybridRuleWord: "shit", hybridRuleSource: "deterministic" }]
  });
  decision = firstWindow.decisions[0];
  assert.deepStrictEqual([decision.word, decision.hybridCrossFamily], ["fucking", true]);
  // Window timing feeds the automatic mode; the first window after the model loads is warm-up.
  assert.strictEqual(firstWindow.inferenceMs, undefined);
  const secondWindow = await whisper.transcribeDetailed(new Float32Array([0.1]), CANDIDATES, "", { slots: [{ prefix: "so" }] });
  assert.ok(secondWindow.inferenceMs >= 0);
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
  assertDisposed(tensors);
  console.log("whisper-local.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
