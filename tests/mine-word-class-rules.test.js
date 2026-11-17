"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { creatorKey, creatorFold, creatorGate, mine, prepareRows, lexicons, templates,
  loadRuntime, validateCompiledCandidate: validateCandidate, poolGate, parseArgs, writeReport } = require("../tools/mine-word-class-rules");

// Isolated runtime realms are sizable; collect between diagnostics in the 128 MiB test lane.
function validateCompiledCandidate(...args) {
  if (global.gc) global.gc();
  const result = validateCandidate(...args);
  if (global.gc) global.gc();
  return result;
}

const pattern = "{SUBJ} [__]";
const groups = [[], []];
for (let i = 0; groups.some((g) => g.length < 2); i++) {
  const name = "Creator " + i, fold = creatorFold(creatorKey({ creator: name }));
  if (groups[fold].length < 2) groups[fold].push(name);
}
const creators = groups.flat();
function rows(tier = "synthetic", count = 3, word = "fuck", names = creators) {
  return names.flatMap((creator) => Array.from({ length: count }, () =>
    ({ tier, creator, expected: [word], current: "", pats: [pattern] })));
}
const good = rows();
const gate = creatorGate(good);
assert.ok(gate);
assert.strictEqual(gate.word, "fuck");
assert.strictEqual(gate.tier, "synthetic");
for (const fold of gate.folds) {
  assert.strictEqual(fold.firstChoice.synthetic.n, 6);
  assert.strictEqual(fold.marginal.synthetic.n, 6);
  assert.strictEqual(fold.firstChoice.synthetic.creators, 2);
  assert.ok(fold.trainCreators.every((c) => !fold.validationCreators.includes(c)));
}
assert.deepStrictEqual(creatorGate([...good].reverse()), gate);
assert.strictEqual(mine(good).chosen.length, 1);

// Canonical IDs unite aliases, even across tiers; fallback names normalize and reject placeholders.
const id = "UC" + "a".repeat(22);
assert.strictEqual(creatorKey({ creatorId: id, creator: "Alias" }), "id:" + id);
assert.strictEqual(creatorKey({ creatorId: id, creator: "unknown" }), "id:" + id);
assert.strictEqual(creatorKey({ creatorId: "invalid", creator: "  Named   CREATOR " }), "name:named creator");
for (const creator of ["unknown", "Unknown Creator", "N/A", "NA", "Anonymous", "anon", "none", "null", "undefined", "Not Available", "", "---"]) {
  assert.strictEqual(creatorKey({ creator }), null, creator);
  assert.strictEqual(creatorGate(rows("synthetic", 20, "fuck", [...creators.slice(0, 3), creator])), null);
}
assert.strictEqual(creatorGate(good.map((r, i) => ({ ...r, creator: "Alias " + i, creatorId: id }))), null);
const ids = [[], []];
for (let i = 0; ids.some((g) => g.length < 2); i++) {
  const creatorId = "UC" + String(i).padStart(22, "0"), fold = creatorFold("id:" + creatorId);
  if (ids[fold].length < 2) ids[fold].push(creatorId);
}
const identified = ids.flat().flatMap((creatorId) => rows("synthetic", 3, "fuck", ["unknown"])
  .map((r, i) => ({ ...r, creatorId, creator: "Alias " + i })));
assert.ok(creatorGate(identified));

// Pooled precision must not hide errors confined to an unseen-creator fold.
const bad = rows("synthetic", 100);
bad.filter((r) => groups[1].includes(r.creator)).forEach((r, i) => { if (i % 100 < 10) r.expected = ["shit"]; });
assert.strictEqual(bad.filter((r) => r.expected[0] === "fuck").length / bad.length, 0.95);
assert.strictEqual(creatorGate(bad), null);
assert.strictEqual(mine(bad).candidates, 0);
assert.strictEqual(creatorGate([...rows("synthetic", 100, "fuck", groups[0]),
  ...rows("synthetic", 3, "shit", groups[1])]), null);
assert.strictEqual(creatorGate(rows("synthetic", 2)), null);
assert.strictEqual(creatorGate(rows("synthetic", 20, "fuck", [groups[0][0], groups[1][0]])), null);
const sparse = rows("synthetic", 10);
sparse.forEach((r, i) => { if (i % 10 >= 2) r.current = "fuck"; });
assert.strictEqual(creatorGate(sparse), null);
const badMarginal = rows("synthetic", 100);
badMarginal.forEach((r, i) => {
  if (i % 100 >= 6) r.current = "fuck";
  if (i % 100 < 2) r.expected = ["shit"];
});
assert.strictEqual(creatorGate(badMarginal), null);

const disagreement = [...rows("synthetic", 10), ...rows("manual-auto", 10, "shit")];
assert.strictEqual(creatorGate(disagreement).tier, "synthetic");
assert.strictEqual(creatorGate(disagreement).firstChoice["manual-auto"].correct, 0);
const manual = rows("manual-auto", 10);
assert.strictEqual(creatorGate(manual).tier, "manual-auto");
assert.strictEqual(creatorGate(rows("manual-auto", 3)), null);
assert.strictEqual(creatorGate([...manual, ...rows("synthetic", 1, "shit")]).tier, "manual-auto");
assert.strictEqual(creatorGate([...manual, ...rows("synthetic", 1, "fuck"), ...rows("synthetic", 1, "shit")]), null);
// Secondary-only additions used to move sorted alternating creator partitions.
const secondary = rows("manual-auto", 10, "shit", ["! Earlier secondary", "zz Later secondary"]);
const extended = creatorGate([...good, ...secondary]);
assert.ok(extended);
for (let fold = 0; fold < 2; fold++) {
  assert.deepStrictEqual(extended.folds[fold].validationCreators.filter((c) => gate.folds[fold].validationCreators.includes(c)),
    gate.folds[fold].validationCreators);
  assert.deepStrictEqual(extended.folds[fold].firstChoice.synthetic, gate.folds[fold].firstChoice.synthetic);
}
// Same canonical creator stays in its fold across tiers and display aliases.
const crossTier = creatorGate([...identified, ...identified.map((r) => ({ ...r, tier: "manual-auto", creator: "Other alias" }))]);
assert.deepStrictEqual(crossTier.folds.map((f) => f.validationCreators), creatorGate(identified).folds.map((f) => f.validationCreators));

// Manual-only candidate has much higher score but must not crowd primary overlap.
const manualPattern = "[__] {VERB}";
const overlap = [...good.map((r) => ({ ...r, pats: [pattern, manualPattern] })),
  ...rows("manual-auto", 30).map((r) => ({ ...r, pats: [manualPattern] }))];
// Only four synthetic matches overall: manual pattern must pass on the secondary tier.
overlap.slice(0, 8).forEach((r) => { r.pats = [pattern]; });
assert.strictEqual(mine(overlap).candidates, 2);
const selected = mine(overlap).chosen;
assert.strictEqual(selected[0].passedOn, "synthetic");
assert.strictEqual(selected[0].pattern, pattern);
assert.strictEqual(mine(good.map((r) => ({ ...r, pats: [pattern, manualPattern] }))).chosen.length, 1);
// Discarded templates must not consume greedy coverage.
const emitRows = good.map((r) => ({ ...r, pats: ["123 [__]", pattern] }));
const vocabulary = { SUBJ: new Set(["i"]) }, words = new Set(["fuck"]);
const emitted = mine(emitRows, (c) => templates([c], vocabulary, words, new Set()).rules.length > 0);
assert.strictEqual(emitted.candidates, 1);
assert.strictEqual(emitted.chosen[0].pattern, pattern);

// Filter provenance before either tokenization or runtime calls; invalid contexts would throw.
const raw = { pairClass: "synthetic", creator: creators[0], context: "I [__]", expected: ["fuck"] };
let calls = 0;
const prepared = prepareRows([raw, ...[
  { evidenceEligible: false }, { pairClass: "auto-auto" }, { pairClass: "unknown" }, { creator: "anonymous" }
].map((change) => ({ ...raw, ...change, context: null }))], {
  applyDeterministicRules() { calls++; return { decisions: [] }; }
});
assert.strictEqual(calls, 1);
assert.strictEqual(prepared.length, 1);
assert.ok(lexicons(prepared, new Set()).SUBJ.has("i"));
assert.strictEqual(mine(good.map((r) => ({ ...r, evidenceEligible: false }))).candidates, 0);

assert.deepStrictEqual(parseArgs([]), { write: false, report: null });
assert.strictEqual(parseArgs(["--dry-run"]).write, false);
for (const args of [["--write"], ["--audit", "--write"], ["--write", "--report", "tmp/new.json"]]) {
  assert.throws(() => parseArgs(args), /--write is disabled.*compiled-template/);
}
assert.throws(() => parseArgs(["--report"]), /incomplete/);
for (const file of ["report.json", "src/rules.js", "src/rule-data/language.js", "tmp/../package.json"]) {
  assert.throws(() => parseArgs(["--report", file]), /under tmp/);
}
const dir = fs.mkdtempSync(path.join(__dirname, "../tmp/miner-test-"));
try {
  const report = path.join(dir, "report.json");
  assert.deepStrictEqual(parseArgs(["--audit", "--report", report]), { write: false, report });
  writeReport(report, { status: "not runtime admission" });
  assert.throws(() => writeReport(report, {}), /already exists/);
  const source = path.join(__dirname, "../tools/mine-word-class-rules.js");
  const before = fs.readFileSync(source, "utf8");
  const link = path.join(dir, "source.json");
  fs.symlinkSync(source, link);
  assert.throws(() => parseArgs(["--report", link]), /symlinks/);
  assert.throws(() => writeReport(link, {}), /symlinks/);
  const parent = path.join(dir, "parent");
  fs.symlinkSync(path.join(__dirname, "../src"), parent);
  assert.throws(() => writeReport(path.join(parent, "new.json"), {}), /symlinks/);
  const internalParent = path.join(dir, "internal-parent");
  fs.symlinkSync(dir, internalParent);
  assert.throws(() => writeReport(path.join(internalParent, "new.json"), {}), /symlinks/);
  const dangling = path.join(dir, "dangling.json");
  fs.symlinkSync(path.join(dir, "missing.json"), dangling);
  assert.throws(() => writeReport(dangling, {}), /symlinks/);
  assert.strictEqual(fs.readFileSync(source, "utf8"), before);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

// Isolated baseline loading never writes source or pollutes host globals/cache.
const files = ["language.js", "grammar.js"].map((f) => path.join(__dirname, "../src/rule-data", f));
const original = files.map((f) => fs.readFileSync(f, "utf8"));
const cache = Object.keys(require.cache), hostRules = globalThis.UncensoredRules;
const write = fs.writeFileSync;
let runtime;
try {
  fs.writeFileSync = () => { throw new Error("Unexpected source write"); };
  runtime = loadRuntime();
} finally { fs.writeFileSync = write; }
assert.strictEqual(globalThis.UncensoredRules, hostRules);
assert.deepStrictEqual(Object.keys(require.cache), cache);
assert.deepStrictEqual(files.map((f) => fs.readFileSync(f, "utf8")), original);
assert.strictEqual(Object.keys(runtime.language.WORD_CLASSES).length, 0);
assert.ok(!runtime.engine.DETERMINISTIC_RULES.some((r) => r.template.includes("<wc-")));
assert.strictEqual(runtime.engine.applyDeterministicRules("what the [__]").decisions[0].word, "fuck");
// Compiled diagnostics use static train-only vocabulary, not contextual POS membership.
const candidate = { pattern: "velvet [__] {NOUN}", word: "fuck", passedOn: "synthetic" };
function compiledRows(count = 3) {
  return rows("synthetic", count).map((r) => ({ ...r, context: "velvet [__] lantern",
    pats: [candidate.pattern], tokens: [{ lit: "velvet" }, { lit: "blankx" }, { lit: "lantern", cls: "NOUN" }] }));
}
const positive = validateCompiledCandidate(candidate, compiledRows(), { baseline: runtime });
assert.ok(positive.passed, JSON.stringify(positive));
assert.strictEqual(positive.status, "not runtime admission");
assert.match(positive.caveat, /Retrospective.*selection.*multi-slot/);
for (const f of positive.folds) {
  for (const key of ["train", "trainMarginal", "validation", "validationMarginal"]) {
    assert.deepStrictEqual(f[key].synthetic, { n: 6, correct: 6, creators: 2 });
  }
}
const mismatch = [...compiledRows(10), ...compiledRows(1).map((r) => ({ ...r,
  expected: ["shit"], pats: [], tokens: r.tokens.map((t) => t.lit === "lantern" ? { ...t, cls: "VERB" } : t) }))];
assert.ok(creatorGate(mismatch.filter((r) => r.pats.length))); // tokenizer would overlook wrong matches
const rejected = validateCompiledCandidate(candidate, mismatch, { baseline: runtime });
assert.strictEqual(rejected.passed, false);
assert.ok(rejected.folds.every((f) => f.validation.synthetic.n === 22 && f.validation.synthetic.correct === 20));

// CLI pool wiring: only compiled-validated candidates reach greedy selection.
const poolVocabulary = { NOUN: new Set(["lantern"]) };
for (const [data, count] of [[compiledRows(), 1], [mismatch, 0]]) {
  const log = [];
  const pool = mine(data, poolGate(data, poolVocabulary, words, new Set(), runtime, log));
  assert.strictEqual(pool.chosen.length, count);
  assert.deepStrictEqual(log.map((v) => [v.pattern, v.word, v.tier, v.passed]),
    [[candidate.pattern, "fuck", "synthetic", count === 1]]);
}

// Each side has enough contextual matches, but its terms are absent from the other train lexicon.
const missing = compiledRows().map((r) => {
  const term = groups[0].includes(r.creator) ? "lantern" : "goblet";
  return { ...r, context: "velvet [__] " + term,
    tokens: r.tokens.map((t) => t.cls ? { ...t, lit: term } : t) };
});
assert.ok(creatorGate(missing));
const absent = validateCompiledCandidate(candidate, missing, { baseline: runtime });
assert.strictEqual(absent.passed, false);
assert.ok(absent.folds.every((f) => f.train.synthetic.n === 6 && f.validation.synthetic.n === 0));
const noVocabulary = validateCompiledCandidate(candidate, compiledRows().map((r) => ({ ...r, tokens: [] })));
assert.ok(noVocabulary.folds.every((f) => !f.passed && /vocabulary/.test(f.reason)));

// Validation labels cannot affect this direction's emitted vocabulary or training word choice.
const changed = compiledRows().map((r) => groups[0].includes(r.creator) ? { ...r, expected: ["shit"] } : r);
const changedGate = validateCompiledCandidate(candidate, changed, { baseline: runtime });
for (const key of ["rules", "classes", "trained", "train", "trainMarginal"]) {
  assert.deepStrictEqual(changedGate.folds[0][key], positive.folds[0][key]);
}
assert.strictEqual(changedGate.passed, false);
const manualCandidate = { ...candidate, passedOn: "manual-auto" };
const manualCompiled = compiledRows(10).map((r) => ({ ...r, tier: "manual-auto" }));
assert.ok(validateCompiledCandidate(manualCandidate, manualCompiled).passed);
assert.strictEqual(validateCompiledCandidate(manualCandidate,
  compiledRows().map((r) => ({ ...r, tier: "manual-auto" }))).passed, false); // Wilson
assert.strictEqual(validateCompiledCandidate(manualCandidate,
  [...manualCompiled, ...compiledRows().map((r) => ({ ...r, expected: ["shit"] }))]).passed, false); // reversal
// Baseline-empty marginal must pass independently on training as well as validation.
const occupied = compiledRows(10).map((r, i) => i % 10 < 8 ? { ...r,
  context: "what the [__] lantern", tokens: [{ lit: "lantern", cls: "NOUN" }] } : r);
const broad = { ...candidate, pattern: "[__] {NOUN}" };
const marginalFailure = validateCompiledCandidate(broad, occupied, { baseline: runtime });
assert.strictEqual(marginalFailure.passed, false);
assert.ok(marginalFailure.folds.every((f) => f.train.synthetic.n === 20 && f.trainMarginal.synthetic.n === 4));
// Match only the labeled target slot, not another occurrence of the candidate in the context.
const otherSlot = compiledRows().map((r) => ({ ...r, context: "velvet [__] lantern. elsewhere [__]",
  tokenIndex: 42, targetSlotIndex: 1 }));
assert.ok(validateCompiledCandidate(candidate, otherSlot).folds.every((f) => f.validation.synthetic.n === 0));

// Archive tokenIndex is absolute metadata, never a local slot (even for simplified contexts).
const absolute = compiledRows().map((r) => ({ ...r, tokenIndex: 42, slotIndex: 9 }));
assert.ok(validateCompiledCandidate(candidate, absolute, { baseline: runtime }).passed);
const absolutePrepared = prepareRows(absolute, runtime.engine);
assert.ok(absolutePrepared.every((r) => r.tokenIndex === 42 && r.slotIndex === 9 && r.targetSlotIndex === 0));
assert.ok(validateCompiledCandidate(candidate, absolutePrepared, { baseline: runtime }).passed);
const occupiedAbsolute = occupied.map((r) => ({ ...r, tokenIndex: 42, slotIndex: 9 }));
assert.deepStrictEqual(validateCompiledCandidate(broad, occupiedAbsolute, { baseline: runtime }).folds,
  marginalFailure.folds);
const multi = compiledRows().map((r) => ({ ...r, tokenIndex: 42, slotIndex: 0, targetSlotIndex: 1,
  context: "elsewhere [__]. velvet [__] lantern" }));
assert.ok(validateCompiledCandidate(candidate, multi, { baseline: runtime }).passed);
assert.ok(prepareRows(multi, runtime.engine).every((r) => r.targetSlotIndex === 1 && r.pats.includes(candidate.pattern)));
const faithful = multi.map(({ targetSlotIndex, ...r }) => ({ ...r, slotIndex: 1, contextFaithful: true }));
assert.ok(validateCompiledCandidate(candidate, faithful, { baseline: runtime }).passed);
const ambiguous = multi.map(({ targetSlotIndex, ...r }) => r);
assert.strictEqual(prepareRows(ambiguous, runtime.engine).length, 0);
assert.strictEqual(validateCompiledCandidate(candidate, ambiguous, { baseline: runtime }).excluded.ambiguousTarget, 12);
for (const targetSlotIndex of [-1, 2, 1.5, null]) {
  assert.strictEqual(validateCompiledCandidate(candidate, multi.map((r) => ({ ...r, targetSlotIndex })),
    { baseline: runtime }).excluded.ambiguousTarget, 12);
}
// Baseline occupancy is checked at the same local target, not a filled sibling.
const siblingOccupied = multi.map((r) => ({ ...r, context: "what the [__]. velvet [__] lantern" }));
assert.ok(validateCompiledCandidate(candidate, siblingOccupied, { baseline: runtime }).passed);
const targetOccupied = multi.map((r) => ({ ...r, context: "elsewhere [__]. what the [__] lantern" }));
const targetOccupancy = validateCompiledCandidate(broad, targetOccupied, { baseline: runtime });
assert.ok(targetOccupancy.folds.every((f) => f.trainMarginal.synthetic.n === 0));

// Canonical-only archive provenance works in every entry point; conflicts cannot promote tiers.
const canonical = compiledRows().map(({ tier, ...r }) => ({ ...r, pairClass: tier }));
assert.deepStrictEqual(validateCompiledCandidate(candidate, canonical, { baseline: runtime }).folds, positive.folds);
assert.ok(creatorGate(canonical));
assert.strictEqual(mine(canonical).chosen.length, 1);
assert.ok(lexicons(canonical, new Set()).NOUN.has("lantern"));
for (const change of [{ tier: "manual-auto" }, { pairClass: "auto-auto", tier: "synthetic" },
  { pairClass: null, tier: "synthetic" }]) {
  const conflicting = canonical.map((r) => ({ ...r, ...change }));
  assert.strictEqual(prepareRows(conflicting, runtime.engine).length, 0);
  assert.strictEqual(mine(conflicting).candidates, 0);
  assert.deepStrictEqual(lexicons(conflicting, new Set()), {});
  assert.strictEqual(validateCompiledCandidate(candidate, conflicting, { baseline: runtime }).excluded.ineligibleEvidence, 12);
}
// Benchmark-compatible terminal punctuation, not arbitrary spelling/alias transformations.
const normalized = compiledRows().map((r) => ({ ...r, expected: ["  FUCK!?  "] }));
assert.deepStrictEqual(validateCompiledCandidate(candidate, normalized, { baseline: runtime }).folds, positive.folds);
assert.ok(creatorGate(normalized));
assert.strictEqual(mine(normalized).chosen[0].word, "fuck");
assert.ok(prepareRows(normalized, runtime.engine).every((r) => r.expected[0] === "fuck"));

// Explicit eligibility flags and unsupported labels are removed before vocabulary or denominators.
const excludedChanges = [{ labeled: false }, { labeled: null }, { label: "ineligible" },
  { label: "unlabeled" }, { label: null }, { expected: null }, { expected: [] },
  { expected: [null] }, { expected: [42] }, { expected: ["fuck", "shit"] },
  { expected: ["f*ck"] }, { expected: ["fuck shit"] }, { expected: [""] },
  { expected: ["fuck💥"] }, { expected: ["fuck_"] }];
for (const change of excludedChanges) {
  const invalid = compiledRows().map((r) => ({ ...r, ...change,
    context: null, tokens: [{ lit: "poison", cls: "NOUN" }] }));
  assert.strictEqual(prepareRows(invalid, runtime.engine).length, 0);
  assert.deepStrictEqual(lexicons(invalid, new Set()), {});
  assert.strictEqual(mine(invalid).candidates, 0);
  assert.deepStrictEqual(creatorGate([...good, ...invalid]), gate);
  const result = validateCompiledCandidate(candidate, [...compiledRows(), ...invalid], { baseline: runtime });
  assert.deepStrictEqual(result.folds, positive.folds);
  assert.strictEqual(result.excluded.unsupportedLabel, 12);
}
const explicitEligible = compiledRows().map((r) => ({ ...r, label: "eligible", labeled: true }));
assert.deepStrictEqual(validateCompiledCandidate(candidate, explicitEligible, { baseline: runtime }).folds, positive.folds);
assert.deepStrictEqual(validateCompiledCandidate(candidate, [...compiledRows(), ...compiledRows().map((r) =>
  ({ ...r, evidenceEligible: false, context: null }))], { baseline: runtime }).folds, positive.folds);

// Compiled VM loading too must be write-free and leave the host require cache untouched.
const beforeCompiledCache = Object.keys(require.cache);
try {
  fs.writeFileSync = () => { throw new Error("Unexpected source write"); };
  assert.ok(validateCompiledCandidate(candidate, compiledRows()).passed);
} finally { fs.writeFileSync = write; }
assert.deepStrictEqual(Object.keys(require.cache), beforeCompiledCache);
assert.strictEqual(globalThis.UncensoredRules, hostRules);
assert.deepStrictEqual(files.map((f) => fs.readFileSync(f, "utf8")), original);
assert.strictEqual(Object.keys(runtime.language.WORD_CLASSES).length, 0);
console.log("mine-word-class-rules tests passed");
