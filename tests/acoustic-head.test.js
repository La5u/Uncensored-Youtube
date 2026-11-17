const assert = require("assert");
const fs = require("fs");
const path = require("path");
const head = require("../src/acoustic-head");

const model = head.parse(fs.readFileSync(path.join(__dirname, "../src/models/acoustic-head-cnn.bin")));
assert.strictEqual(model.models.length, 5);
assert.deepStrictEqual([model.frames, model.dim, model.before, model.words.length], [150, 384, 50, 65]);

// Parity with the torch head (int8-dequantized weights, tmp/acoustic-train-20261112/export_head.py) on
// fixed synthetic crops: full, first 20 frames outside the window, last 20 outside. [class, probability].
const TORCH = [
  [[0, 0.1644], [18, 0.10989], [53, 0.05427], [9, 0.04503]],
  [[18, 0.15616], [36, 0.12267], [39, 0.08187], [12, 0.07982]],
  [[41, 0.29679], [27, 0.07877], [47, 0.07537], [0, 0.04658]]
];
TORCH.forEach((expected, i) => {
  const f32 = Math.fround;
  const x = new Float32Array(150 * 384);
  const mask = [];
  for (let f = 0; f < 150; f += 1) {
    mask.push(!(i === 1 && f < 20) && !(i === 2 && f >= 130));
    for (let d = 0; d < 384 && mask[f]; d += 1) {
      x[f * 384 + d] = Math.sin(f32(f * f32(0.37 * (i + 1))) + f32(d * 0.11)) * 2 + Math.cos(f32(d * f32(0.05 * (i + 2))));
    }
  }
  const probs = head.forward(model, x, mask);
  assert.ok(Math.abs(probs.reduce((a, b) => a + b, 0) - 1) < 1e-5);
  expected.forEach(([c, p]) => assert.ok(Math.abs(probs[c] - p) < 2e-5, `input ${i} class ${c}: ${probs[c]} != ${p}`));
});

// Crop: 50 frames (1 s) before the blank, 150 after; frames outside the 1500-frame window are zero and masked.
const hidden = new Float32Array(1500 * 384).map((_, i) => Math.floor(i / 384));
let crop = head.crop(model, hidden, 1500, 0.5);
assert.deepStrictEqual([crop.mask.indexOf(true), crop.x[25 * 384], crop.x[24 * 384]], [25, 0, 0]);
assert.strictEqual(crop.x[26 * 384 + 7], 1);
crop = head.crop(model, hidden, 1500, 29);
assert.deepStrictEqual([crop.mask.lastIndexOf(true), crop.x[99 * 384]], [99, 1499]);

// Selection: abstentions and near ties (two gated words within the margin on log P(word + next)).
const decision = (word, scores) => ({ word, scores: scores.map(([w, logp, withNext]) => ({ word: w, logp, withNext })) });
assert.strictEqual(head.uncertain(decision("", []), -4, 1), true);
assert.strictEqual(head.uncertain(decision("fuck", [["fuck", -1, -3]]), -4, 1), false);
assert.strictEqual(head.uncertain(decision("fuck", [["fuck", -1, -3], ["fucking", -2, -4]]), -4, 1), true);
assert.strictEqual(head.uncertain(decision("fuck", [["fuck", -1, -3], ["fucking", -2, -4.5]]), -4, 1), false);
assert.strictEqual(head.uncertain(decision("fuck", [["fuck", -1, -3], ["fucking", -5, -3.2]]), -4, 1), false);

// Choice: the most probable word if it clears the threshold and is a candidate.
const probs = new Float32Array(65);
probs[model.words.indexOf("shit")] = 0.97;
assert.ok(model.threshold > 0.96 && model.threshold < 0.97);
assert.strictEqual(head.choose(model, probs, ["fuck", "shit"]), "shit");
assert.strictEqual(head.choose(model, probs, ["fuck"]), "");
probs[model.words.indexOf("shit")] = 0.9;
assert.strictEqual(head.choose(model, probs, ["shit"]), "");
assert.deepStrictEqual(head.top(model, probs), { word: "shit", p: probs[model.words.indexOf("shit")] });

// Fusion: the shipped file carries its parameters (one family per word).
assert.ok(model.fusion.weights.length === 3 && model.fusion.family.length === model.words.length);
const fused = { words: ["fuck", "fucking", "shit"], margin: 1,
  fusion: { weights: [1, 1, 1], threshold: 0.5, unscored: [3, -40], family: ["fuck", "fuck", "shit"] } };
const fuse = (p, word, scores, candidates, prunedMax = -6) =>
  head.fuse(fused, p, Object.assign(decision(word, scores), { prunedMax }), candidates, -4).word;
// Decoder abstained, nothing scored: the head decides, if it clears the threshold.
assert.strictEqual(fuse([0.1, 0.1, 0.8], "", [], null, -Infinity), "shit");
assert.strictEqual(fuse([0.4, 0.3, 0.3], "", [], null, -Infinity), "");
// A confident decoder keeps its inflection against a fused word of the same family...
assert.strictEqual(fuse([0.98, 0.01, 0.01], "fucking", [["fucking", -1, -2], ["fuck", -1.5, -3.5]]), "fucking");
// ...but not when it nearly tied, nor against another family, unless that word is no candidate.
assert.strictEqual(fuse([0.98, 0.01, 0.01], "fucking", [["fucking", -1, -2], ["fuck", -1.5, -2.5]]), "fuck");
assert.strictEqual(fuse([0.01, 0.01, 0.98], "fucking", [["fucking", -1, -2], ["shit", -1.5, -3.5]]), "shit");
assert.strictEqual(fuse([0.01, 0.01, 0.98], "fucking", [["fucking", -1, -2], ["shit", -1.5, -3.5]], ["fucking"]), "fucking");
// Loading: weights parse from a fetched buffer; any failure warns once and resolves null.
(async () => {
  const bytes = fs.readFileSync(path.join(__dirname, "../src/models/acoustic-head-cnn.bin"));
  const warnings = [];
  const { fetch: realFetch } = globalThis, { warn } = console;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(bytes).buffer });
    const loaded = await head.load("x");
    assert.deepStrictEqual([loaded.model.models.length, loaded.error], [5, ""]);
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.deepStrictEqual(await head.load("x"), { model: null, error: "HTTP 404" });
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    assert.strictEqual((await head.load("x")).model, null);
    globalThis.fetch = async () => { throw new TypeError("network"); };
    assert.deepStrictEqual(await head.load("x"), { model: null, error: "network" });
  } finally {
    globalThis.fetch = realFetch;
    console.warn = warn;
  }
  assert.strictEqual(warnings.length, 3);
  assert.match(warnings[0], /acoustic head unavailable: HTTP 404/);
  console.log("acoustic-head.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
