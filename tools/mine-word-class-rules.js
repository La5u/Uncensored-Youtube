#!/usr/bin/env node
// Diagnostic-only word-class mining; not runtime admission. --write is disabled.
// node --max-old-space-size=3000 tools/mine-word-class-rules.js [--report tmp/chosen.json]
// --audit / --dry-run are report-only aliases (candidate audit, not committed-template audit).
// Held-out videos are excluded by ID (read from acquisition metadata, never caption text).
"use strict";
const fs = require("fs");
const path = require("path");
const { creatorKey } = require("./shared");
const vm = require("vm");
const crypto = require("crypto");
const nlpModule = require("compromise");

const nlp = nlpModule.default || nlpModule;
const ROOT = path.resolve(__dirname, "..");
const HELDOUT_REPORTS = ["manual-auto", "synthetic-auto"].map((tier) =>
  `tmp/heldout-20261004/workspace/corpus/generated/heldout-${tier}-report.json`);
const HELDOUT_ID_FILES = ["tmp/heldout/post-freeze-manual-auto-ids.txt"];
const BEGIN = "  // BEGIN generated word classes (tools/mine-word-class-rules.js)";
const END = "  // END generated word classes";
const TIERS = ["synthetic", "manual-auto"];
// Gate (docs/RULES.md): 92% at 5+ matches with 2+ creators. Manual-auto passes only when synthetic
// has too few matches or agrees, and also needs a 95% Wilson lower bound of 0.80.
const MIN_MATCHES = 5, MIN_PRECISION = 0.92, MIN_CREATORS = 2, MANUAL_LOWER_BOUND = 0.8;
const WRONG_FILL_COST = 3, MIN_SCORE = 2;

const CLOSED = {
  SUBJ: ["i", "you", "he", "she", "we", "they"],
  OBJ: ["me", "him", "us", "them"],
  POSS: ["my", "your", "his", "her", "our", "their", "its"],
  DEM: ["this", "that", "these", "those"],
  ART: ["a", "an", "the"],
  PREP: ["about", "at", "by", "for", "from", "in", "into", "of", "on", "over", "through", "with", "to"],
  BE: ["is", "am", "are", "was", "were", "be", "been", "being", "'s", "'re", "'m"],
  MODAL: ["can", "could", "will", "would", "should", "might", "must", "gonna", "wanna", "gotta", "'ll", "'d"],
  NEG: ["not", "n't", "never", "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't", "wasn't"],
  CONJ: ["and", "but", "or", "so", "because", "cuz"]
};
const CLOSED_OF = new Map();
for (const [cls, words] of Object.entries(CLOSED)) for (const w of words) if (!CLOSED_OF.has(w)) CLOSED_OF.set(w, cls);
const TARGET = "blankx";

function openClass(tags) {
  const t = new Set(tags);
  if (t.has("Gerund")) return "GERUND";
  if (t.has("PastTense") || t.has("Participle")) return "PAST";
  if (t.has("Verb")) return "VERB";
  if (t.has("Adjective")) return "ADJ";
  if (t.has("Adverb")) return "ADV";
  if (t.has("ProperNoun")) return "PROPN";
  if (t.has("Plural")) return "NOUNS";
  if (t.has("Value")) return "NUM";
  if (t.has("Noun")) return "NOUN";
  return null;
}

// Tokens around the target blank: {lit, cls} words, punctuation as separate literal tokens.
function tokenize(context) {
  const text = context.replace(/…/g, " , ").replace(/\[__\]/, " BLANKX ").replace(/\[__\]/g, " , ");
  const out = [];
  for (const sentence of nlp(text).json()) for (const term of sentence.terms) {
    const pre = (term.pre || "").trim(), post = (term.post || "").trim();
    if (/[.,!?]/.test(pre)) out.push({ lit: pre.match(/[.,!?]/)[0] });
    const lit = (term.normal || term.text || "").toLowerCase().replace(/’/g, "'");
    if (!lit && out.length && term.tags) continue; // implicit contraction part
    if (lit) out.push({ lit, cls: lit === TARGET ? null : (CLOSED_OF.get(lit) || openClass(term.tags || [])) });
    const p = post.match(/[.,!?]/); if (p) out.push({ lit: p[0] });
  }
  return out;
}

function variants(tokens) { // every literal/class choice for a token list
  let acc = [[]];
  for (const t of tokens) {
    const opts = [t.lit]; if (t.cls) opts.push("{" + t.cls + "}");
    acc = acc.flatMap((a) => opts.map((o) => a.concat(o)));
  }
  return acc;
}

function patterns(tokens) { // up to two tokens on each side of the target
  const i = tokens.findIndex((t) => t.lit === TARGET); if (i < 0) return [];
  const lefts = [[]], rights = [[]];
  for (let k = 1; k <= 2 && i - k >= 0; k++) lefts.push(...variants(tokens.slice(i - k, i)));
  for (let k = 1; k <= 2 && i + k < tokens.length; k++) rights.push(...variants(tokens.slice(i + 1, i + 1 + k)));
  const out = [];
  for (const l of lefts) for (const r of rights) if (l.length || r.length) out.push(l.concat("[__]", r).join(" "));
  return out;
}

function heldoutIds() {
  const ids = new Set();
  for (const file of HELDOUT_REPORTS) {
    for (const channel of JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")).channels || []) {
      for (const item of channel.items || []) if (item.status === "paired-saved") ids.add(item.id);
    }
  }
  for (const file of HELDOUT_ID_FILES) {
    for (const id of fs.readFileSync(path.join(ROOT, file), "utf8").split(/\s+/)) if (id) ids.add(id);
  }
  return ids;
}

function blockSource(s, body) {
  const a = s.indexOf(BEGIN), b = s.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error("Missing generated-block markers");
  return s.slice(0, a) + `${BEGIN}\n${body}\n` + s.slice(b);
}

// Dataset-independent, whole-creator assignment across both tiers.
function creatorFold(key) {
  return crypto.createHash("sha256").update("word-class-creator-v1\0" + key).digest()[0] & 1;
}

function canonicalTier(row) {
  // pairClass is archive provenance, not a fallback for a conflicting tier.
  if (Object.hasOwn(row, "pairClass")) {
    if (Object.hasOwn(row, "tier") && row.tier !== row.pairClass) return null;
    return TIERS.includes(row.pairClass) ? row.pairClass : null;
  }
  return TIERS.includes(row.tier) ? row.tier : null;
}

function expectedWords(row) {
  if ((Object.hasOwn(row, "labeled") && row.labeled !== true) ||
    (Object.hasOwn(row, "label") && row.label !== "eligible") ||
    !Array.isArray(row.expected) || !row.expected.length) return null;
  // Same lowercase/trim and terminal-punctuation comparison as the benchmark,
  // but do not apply its slang, masked-word, compound or context-dependent aliases.
  if (row.expected.some((w) => typeof w !== "string")) return null;
  const words = [...new Set(row.expected.map((w) => w.trim().toLowerCase().replace(/[.,!?;:…]+$/g, "")))];
  return words.length === 1 && /^[a-z]+(?:'[a-z]+)?$/.test(words[0]) ? words : null;
}

function eligibleRow(row) {
  return !!row && row.evidenceEligible !== false && !!canonicalTier(row) &&
    !!creatorKey(row) && !!expectedWords(row);
}

function normalizedRows(rows) {
  return rows.filter(eligibleRow).map((r) => ({ ...r, tier: canonicalTier(r), expected: expectedWords(r) }));
}

function targetSlot(row) {
  const count = typeof row.context === "string" ? (row.context.match(/\[__\]/g) || []).length : 0;
  if (count === 1) return 0; // simplified archive contexts discard original slot numbering
  const slot = Object.hasOwn(row, "targetSlotIndex") ? row.targetSlotIndex :
    row.contextFaithful === true ? row.slotIndex : null;
  return Number.isSafeInteger(slot) && slot >= 0 && slot < count ? slot : null;
}

function baselineWord(engine, row) {
  const d = engine.applyDeterministicRules(row.context).decisions
    .find((d) => d.tokenIndex <= row.targetSlotIndex && row.targetSlotIndex < d.tokenIndex + d.tokenSpan);
  return d && d.word ? d.word.toLowerCase() : "";
}

function prepareRows(archive, engine) {
  return normalizedRows(archive).flatMap((r) => {
    const targetSlotIndex = targetSlot(r);
    if (targetSlotIndex === null) return [];
    // The tokenizer treats its first blank as the target; keep sibling blanks as separators.
    let slot = 0;
    const context = r.context.replace(/\[__\]/g, () => slot++ === targetSlotIndex ? "[__]" : " , ");
    const tokens = tokenize(context);
    const prepared = { ...r, targetSlotIndex, tokens, pats: patterns(tokens) };
    return [{ ...prepared, current: baselineWord(engine, prepared) }];
  });
}

// Use the browser-style loaders in an isolated realm; no disk or require-cache mutation.
function loadRuntime(generated = {}) {
  const context = vm.createContext({});
  for (const file of ["rules-compiler.js", "rule-data/language.js", "rule-data/exact.js",
    "rule-data/grammar.js", "rules-data.js", "rules.js"]) {
    let source = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
    if (file === "rule-data/language.js") source = blockSource(source, generated.language ?? "  var WORD_CLASSES = Object.freeze({});");
    if (file === "rule-data/grammar.js") source = blockSource(source, generated.grammar ?? "");
    vm.runInContext(source, context, { filename: file });
  }
  return { engine: context.UncensoredRules, language: context.UncensoredRuleDataParts.language };
}

const wilson = (k, n) => {
  const z = 1.96, p = k / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
};

function tierStats(rows, word) {
  const stats = {};
  for (const tier of TIERS) {
    const rs = rows.filter((r) => r.tier === tier);
    const correct = rs.filter((r) => r.expected.includes(word));
    stats[tier] = { n: rs.length, correct: correct.length,
      creators: new Set(correct.map(creatorKey)).size };
  }
  return stats;
}

function passes(t, tier) {
  return t.n >= MIN_MATCHES && t.correct / t.n >= MIN_PRECISION && t.creators >= MIN_CREATORS &&
    (tier !== "manual-auto" || wilson(t.correct, t.n) >= MANUAL_LOWER_BOUND);
}

function tierPass(stats, tier) {
  return passes(stats[tier], tier) && (tier !== "manual-auto" ||
    stats.synthetic.n < MIN_MATCHES || stats.synthetic.correct / stats.synthetic.n >= MIN_PRECISION);
}

// Choice and support use training labels only; ties have a stable lexical order.
function wordChoice(rows) {
  for (const tier of TIERS) {
    const counts = new Map();
    for (const r of rows) if (r.tier === tier) counts.set(r.expected[0], (counts.get(r.expected[0]) || 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top && tierPass(tierStats(rows, top[0]), tier)) return { word: top[0], tier };
  }
  return null;
}

// Two deterministic folds, whole creators (across both tiers), raw labeled matches.
// Both directions must independently support the same word/tier. Sparse folds abstain.
function creatorGate(rows, marginal = rows.filter((r) => !r.current)) {
  rows = rows.filter((r) => r && expectedWords(r));
  marginal = marginal.filter((r) => r && expectedWords(r));
  if (rows.some((r) => !eligibleRow(r)) || marginal.some((r) => !eligibleRow(r))) return null;
  rows = normalizedRows(rows);
  marginal = normalizedRows(marginal);
  const choice = wordChoice(rows);
  if (!choice) return null;
  const creators = [...new Set(rows.map(creatorKey))].sort();
  const foldOf = new Map(creators.map((creator) => [creator, creatorFold(creator)]));
  const firstChoice = tierStats(rows, choice.word), marginalStats = tierStats(marginal, choice.word);
  if (!tierPass(marginalStats, choice.tier)) return null;
  const folds = [];
  for (let fold = 0; fold < 2; fold++) {
    const train = rows.filter((r) => foldOf.get(creatorKey(r)) !== fold);
    const validation = rows.filter((r) => foldOf.get(creatorKey(r)) === fold);
    const trained = wordChoice(train);
    if (!trained || trained.word !== choice.word || trained.tier !== choice.tier) return null;
    const trainMarginal = tierStats(marginal.filter((r) => foldOf.get(creatorKey(r)) !== fold), trained.word);
    const first = tierStats(validation, trained.word);
    const remaining = tierStats(marginal.filter((r) => foldOf.get(creatorKey(r)) === fold), trained.word);
    if (!tierPass(trainMarginal, trained.tier) || !tierPass(first, trained.tier) ||
      !tierPass(remaining, trained.tier)) return null;
    folds.push({ trainCreators: creators.filter((c) => foldOf.get(c) !== fold),
      validationCreators: creators.filter((c) => foldOf.get(c) === fold), word: trained.word,
      passedOn: trained.tier, firstChoice: first, marginal: remaining });
  }
  return { ...choice, firstChoice, marginal: marginalStats, folds };
}

// Greedy rule choice over rows the current runtime leaves blank.
function mine(rows, canEmit = () => true) {
  rows = normalizedRows(rows);
  const stats = new Map(); // cheap full-data prefilter; never used as validation
  for (const r of rows) for (const p of r.pats) {
    let s = stats.get(p); if (!s) stats.set(p, s = {});
    const t = s[r.tier] || (s[r.tier] = { n: 0, words: {} });
    t.n++; t.words[r.expected[0]] = (t.words[r.expected[0]] || 0) + 1;
  }
  for (const [p, s] of stats) { // retain row indices only for plausible patterns (keeps memory low)
    if (!Object.values(s).some((t) => t.n >= MIN_MATCHES && Math.max(...Object.values(t.words)) / t.n >= MIN_PRECISION)) stats.delete(p);
  }
  const candidates = new Map([...stats.keys()].map((p) => [p, { p }]));
  stats.clear();
  const rowsOf = new Map();
  rows.forEach((r, i) => {
    for (const p of r.pats) if (candidates.has(p)) (rowsOf.get(p) || rowsOf.set(p, []).get(p)).push(i);
  });
  for (const [p, c] of candidates) {
    const gate = creatorGate(rowsOf.get(p).map((i) => rows[i]));
    if (!gate || !canEmit({ pattern: p, word: gate.word, tier: gate.tier })) { candidates.delete(p); rowsOf.delete(p); }
    else Object.assign(c, { w: gate.word, tier: gate.tier, gate });
  }
  const covered = new Set(), chosen = [];
  let pool = [...candidates.values()];
  for (;;) {
    let best = null, bestRows = null, bestOk = 0, bestScore = 0, bestGate = null;
    for (const c of pool) {
      const rs = (rowsOf.get(c.p) || []).filter((i) => !rows[i].current && !covered.has(i));
      const ok = rs.filter((i) => rows[i].expected.includes(c.w)).length;
      const primary = rs.filter((i) => rows[i].tier === c.tier);
      const primaryOk = primary.filter((i) => rows[i].expected.includes(c.w)).length;
      const score = primaryOk - WRONG_FILL_COST * (primary.length - primaryOk);
      if (score < MIN_SCORE || (best && (best.tier === "synthetic" && c.tier !== "synthetic" ||
        best.tier === c.tier && score <= bestScore))) continue;
      const gate = covered.size ? creatorGate(rowsOf.get(c.p).map((i) => rows[i]), rs.map((i) => rows[i])) : c.gate;
      if (!gate) continue;
      best = c; bestRows = rs; bestOk = ok; bestScore = score; bestGate = gate;
    }
    if (!best || bestScore < MIN_SCORE) break;
    chosen.push({ pattern: best.p, word: best.w, passedOn: best.tier, newFills: bestRows.length, newCorrect: bestOk,
      gate: bestGate });
    bestRows.forEach((i) => covered.add(i));
    pool = pool.filter((c) => c !== best);
  }
  return { candidates: candidates.size, chosen };
}

// Closed classes as tagged; open classes keep words seen 3+ times with 90%+ in one class.
function lexicons(rows, allowed) {
  const counts = new Map(), lexicon = {};
  for (const r of rows.filter(eligibleRow)) for (const t of r.tokens) {
    if (!t.cls) continue;
    if (CLOSED[t.cls]) { (lexicon[t.cls] || (lexicon[t.cls] = new Set())).add(t.lit); continue; }
    const c = counts.get(t.lit) || counts.set(t.lit, {}).get(t.lit);
    c[t.cls] = (c[t.cls] || 0) + 1;
  }
  for (const [w, c] of counts) {
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const [cls, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    if (total < 3 || n / total < 0.9 || allowed.has(w) || !/^[a-z][a-z']*$/.test(w)) continue;
    (lexicon[cls] || (lexicon[cls] = new Set())).add(w);
  }
  return lexicon;
}

// Templates: drop non-word literals, unknown outputs and existing rules; greedy order is priority.
function templates(chosen, lexicon, ruleWords, existing) {
  const name = (cls) => "wc-" + cls.toLowerCase();
  const rules = [], seen = new Set();
  for (const c of chosen) {
    if (!ruleWords.has(c.word)) continue;
    const tokens = c.pattern.split(" ");
    if (tokens.some((t) => !(t === "[__]" || /^\{[A-Z]+\}$/.test(t) || /^[.,!?]$/.test(t) ||
      (/^[a-z][a-z']*$/.test(t) && (t.length > 1 || t === "i" || t === "a"))))) continue;
    if (tokens.some((t) => /^\{/.test(t) && !lexicon[t.slice(1, -1)])) continue;
    let text = "";
    for (const t of tokens) {
      const piece = t === "[__]" ? `[${c.word}]` : /^\{/.test(t) ? `<${name(t.slice(1, -1))}>` : t;
      text += /^[.,!?]$/.test(t) || !text ? piece : " " + piece;
    }
    if (/^[.,!?]/.test(text) || seen.has(text) || existing.has(text.replace(/\[[a-z']+\]/, "[__]"))) continue;
    seen.add(text); rules.push(text);
  }
  const used = [...new Set(rules.flatMap((r) => r.match(/<wc-[a-z]+>/g) || []))].map((t) => t.slice(4, -1).toUpperCase()).sort();
  const classes = used.map((cls) => `    "${name(cls)}": set("${name(cls)}", ${JSON.stringify([...lexicon[cls]].sort())})`);
  return {
    rules, classes: Object.fromEntries(used.map((cls) => [name(cls), lexicon[cls].size])),
    language: "  var WORD_CLASSES = Object.freeze({\n" + classes.join(",\n") + "\n  });",
    grammar: `    group("fallback/word-class", 5020, [\n` + rules.map((r) => "      pattern`" + r + "`").join(",\n") + "\n    ]),"
  };
}

// Retrospective candidate diagnostic only: selection on these data is not admission.
// Each VM uses final static classes learned solely from its training tokens, never labels.
function validateCompiledCandidate(candidate, rows, options = {}) {
  const baseline = options.baseline || loadRuntime();
  const allowed = new Set(baseline.language.ALLOWED_WORDS.map((w) => w.toLowerCase()));
  const ruleWords = new Set(baseline.language.RULE_WORDS.map((w) => w.toLowerCase()));
  const existing = new Set(baseline.engine.DETERMINISTIC_RULES.map((r) => r.template));
  const excluded = { ineligibleEvidence: 0, unsupportedLabel: 0, ambiguousTarget: 0 };
  rows = rows.flatMap((r) => {
    if (!r || !expectedWords(r)) { excluded.unsupportedLabel++; return []; }
    if (!eligibleRow(r)) { excluded.ineligibleEvidence++; return []; }
    const targetSlotIndex = targetSlot(r);
    if (targetSlotIndex === null) { excluded.ambiguousTarget++; return []; }
    const row = { ...r, tier: canonicalTier(r), expected: expectedWords(r), targetSlotIndex };
    return [{ ...row, current: baselineWord(baseline.engine, row) }];
  });
  const folds = [];
  for (let fold = 0; fold < 2; fold++) {
    const train = rows.filter((r) => creatorFold(creatorKey(r)) !== fold);
    const validation = rows.filter((r) => creatorFold(creatorKey(r)) === fold);
    const emitted = templates([candidate], lexicons(train, allowed), ruleWords, existing);
    const support = { fold, rules: emitted.rules, classes: emitted.classes, passed: false };
    folds.push(support);
    if (emitted.rules.length !== 1) { support.reason = "insufficient emitted vocabulary or ineligible template"; continue; }
    const { engine } = loadRuntime(emitted);
    const matches = (rs) => rs.filter((r) => engine.applyDeterministicRules(r.context, { trace: true }).trace
      .some((s) => s.tokenIndex === r.targetSlotIndex && s.tokenSpan === 1 &&
        s.alternatives.some((a) => a.rule.template === emitted.rules[0].replace(/\[[a-z']+\]/, "[__]"))));
    const training = matches(train), testing = matches(validation);
    const trained = wordChoice(training);
    Object.assign(support, { trained,
      train: tierStats(training, candidate.word),
      trainMarginal: tierStats(training.filter((r) => !r.current), candidate.word),
      validation: tierStats(testing, candidate.word),
      validationMarginal: tierStats(testing.filter((r) => !r.current), candidate.word) });
    const tier = candidate.passedOn || candidate.tier;
    support.passed = !!trained && trained.word === candidate.word && trained.tier === tier &&
      [support.train, support.trainMarginal, support.validation, support.validationMarginal]
        .every((stats) => tierPass(stats, tier));
    if (!support.passed) support.reason = "compiled match choice or fold support failed";
  }
  return { status: "not runtime admission", passed: folds.every((f) => f.passed), folds, excluded,
    caveat: "Retrospective diagnostic: candidate selection uses the same data; pooled/effective coverage, multi-slot behavior and independent/frozen vocabulary remain unresolved. No deployment or prospective accuracy claim." };
}

// Pool admission: the emitted template and the compiled train-only fold check must both pass.
function poolGate(rows, lexicon, ruleWords, existing, baseline, validated = []) {
  return (c) => {
    if (!templates([c], lexicon, ruleWords, existing).rules.length) return false;
    const check = validateCompiledCandidate(c, rows, { baseline });
    validated.push({ pattern: c.pattern, word: c.word, tier: c.tier, passed: check.passed,
      reasons: check.folds.map((f) => f.reason).filter(Boolean) });
    return check.passed;
  };
}

// Reports are new files only, under the real project tmp directory. Refuse symlinks
// in every path component; exclusive creation also prevents overwriting raced-in files.
function reportPath(file) {
  const target = path.resolve(ROOT, file), tmp = path.join(ROOT, "tmp");
  if (!target.startsWith(tmp + path.sep)) throw new Error("Report must be a new file under tmp/");
  const parts = path.relative(ROOT, target).split(path.sep);
  let current = ROOT;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === "ENOENT" && i === parts.length - 1) break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Report path must not contain symlinks");
    if (i === parts.length - 1) throw new Error("Report must be a new file (already exists)");
    if (!stat.isDirectory()) throw new Error("Report parent must be a directory");
  }
  if (fs.realpathSync(path.dirname(target)) !== path.dirname(target)) {
    throw new Error("Report parent must be a real resolved path, without symlinks");
  }
  return target;
}

function writeReport(file, report) {
  const target = reportPath(file);
  fs.writeFileSync(target, JSON.stringify(report, null, 1) + "\n", { flag: "wx" });
}

function parseArgs(args) {
  const options = { write: false, report: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--write") options.write = true;
    else if (args[i] === "--audit" || args[i] === "--dry-run") continue;
    else if (args[i] === "--report" && args[i + 1] && !args[i + 1].startsWith("--")) options.report = args[++i];
    else throw new Error("Unknown or incomplete option: " + args[i]);
  }
  if (options.write) throw new Error("--write is disabled: final compiled-template matching and an independent/frozen class vocabulary gate are required; diagnostics are not runtime admission");
  if (options.report) reportPath(options.report);
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const heldout = heldoutIds();
  const { engine, language } = loadRuntime();
  const { DEFAULT_REPORTS, DEFAULT_PROVENANCE_REPORTS, loadArchivedRows } = require("./archived-rules-benchmark");
  const loaded = loadArchivedRows(DEFAULT_REPORTS, DEFAULT_PROVENANCE_REPORTS);
  const conflicts = new Set(loaded.slotConflictIds);
  const archive = loaded.rows.filter((r) => !heldout.has(r.fixture) && !conflicts.has(r.id) &&
    r.labeled && r.expected && r.expected.length);
  console.error("archive rows", archive.length, "held-out videos excluded", heldout.size);
  const rows = prepareRows(archive, engine);
  const lexicon = lexicons(rows, new Set(language.ALLOWED_WORDS.map((w) => w.toLowerCase())));
  const existing = new Set(engine.DETERMINISTIC_RULES.map((r) => r.template));
  const ruleWords = new Set(language.RULE_WORDS.map((w) => w.toLowerCase()));
  const validated = [];
  const { candidates, chosen } = mine(rows, poolGate(rows, lexicon, ruleWords, existing, { engine, language }, validated));
  const out = templates(chosen, lexicon, ruleWords, existing);
  const diagnostic = { status: "not runtime admission", creatorGateVersion: "sha256-word-class-creator-v1",
    limitations: "Pool candidates pass compiled train-only folds, but greedy selection and the emitted class vocabulary use all data; not independent/frozen." };
  if (options.report) writeReport(options.report, { ...diagnostic, candidates, validated, chosen });
  console.log(JSON.stringify({ ...diagnostic, candidates, validated: validated.length,
    validatedPassed: validated.filter((v) => v.passed).length, chosen: chosen.length, newFills: chosen.reduce((a, c) => a + c.newFills, 0),
    newCorrect: chosen.reduce((a, c) => a + c.newCorrect, 0), rules: out.rules.length, classes: out.classes }));
}

if (require.main === module) main();
module.exports = { tokenize, patterns, creatorKey, creatorFold, creatorGate, mine, prepareRows,
  lexicons, templates, loadRuntime, validateCompiledCandidate, poolGate, parseArgs, reportPath, writeReport };
