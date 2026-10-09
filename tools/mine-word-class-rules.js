#!/usr/bin/env node
// Mine word-class rules from the caption archive and rewrite the generated blocks: WORD_CLASSES in
// src/rule-data/language.js and the fallback/word-class group in src/rule-data/grammar.js.
// node --max-old-space-size=3000 tools/mine-word-class-rules.js [--report chosen.json]
// Held-out videos are excluded by ID (read from acquisition metadata, never caption text).
"use strict";
const fs = require("fs");
const path = require("path");
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

function replaceBlock(file, body) {
  const p = path.join(ROOT, file), s = fs.readFileSync(p, "utf8");
  const a = s.indexOf(BEGIN), b = s.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error("Missing generated-block markers in " + file);
  fs.writeFileSync(p, s.slice(0, a) + `${BEGIN}\n${body}\n` + s.slice(b));
}

const wilson = (k, n) => {
  const z = 1.96, p = k / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
};
const summarize = (t, w) => t ? `${t.words[w] || 0}/${t.n} cr${t.cr[w] ? t.cr[w].size : 0}` : "-";

// Greedy rule choice over rows the current runtime leaves blank.
function mine(rows) {
  const stats = new Map(); // pattern -> {tier: {n, words: {w: n}, cr: {w: Set}}}
  for (const r of rows) for (const p of r.pats) {
    let s = stats.get(p); if (!s) stats.set(p, s = {});
    const t = s[r.tier] || (s[r.tier] = { n: 0, words: {}, cr: {} });
    t.n++; t.words[r.expected[0]] = (t.words[r.expected[0]] || 0) + 1;
  }
  for (const [p, s] of stats) { // creators only for patterns that can still pass (keeps memory low)
    if (!Object.values(s).some((t) => t.n >= MIN_MATCHES && Math.max(...Object.values(t.words)) / t.n >= MIN_PRECISION)) stats.delete(p);
  }
  for (const r of rows) for (const p of r.pats) {
    const t = stats.get(p) && stats.get(p)[r.tier]; if (!t) continue;
    (t.cr[r.expected[0]] || (t.cr[r.expected[0]] = new Set())).add(r.creator);
  }
  const pass = (t, w, tier) => t.n >= MIN_MATCHES && (t.words[w] || 0) / t.n >= MIN_PRECISION &&
    t.cr[w] && t.cr[w].size >= MIN_CREATORS && (tier !== "manual-auto" || wilson(t.words[w] || 0, t.n) >= MANUAL_LOWER_BOUND);
  const candidates = new Map();
  for (const [p, s] of stats) {
    for (const tier of TIERS) {
      const t = s[tier]; if (!t || t.n < MIN_MATCHES) continue;
      const w = Object.entries(t.words).sort((a, b) => b[1] - a[1])[0][0];
      const other = s[tier === "synthetic" ? "manual-auto" : "synthetic"];
      if (!pass(t, w, tier)) continue;
      if (tier === "manual-auto" && other && other.n >= MIN_MATCHES && (other.words[w] || 0) / other.n < MIN_PRECISION) continue;
      candidates.set(p, { p, w, tier, s });
      break;
    }
  }
  const rowsOf = new Map();
  rows.forEach((r, i) => {
    if (r.current) return;
    for (const p of r.pats) if (candidates.has(p)) (rowsOf.get(p) || rowsOf.set(p, []).get(p)).push(i);
  });
  const covered = new Set(), chosen = [];
  let pool = [...candidates.values()];
  for (;;) {
    let best = null, bestRows = null, bestOk = 0, bestScore = 0;
    for (const c of pool) {
      const rs = (rowsOf.get(c.p) || []).filter((i) => !covered.has(i));
      const ok = rs.filter((i) => rows[i].expected.includes(c.w)).length;
      const score = ok - WRONG_FILL_COST * (rs.length - ok);
      if (score > bestScore) { best = c; bestRows = rs; bestOk = ok; bestScore = score; }
    }
    if (!best || bestScore < MIN_SCORE) break;
    chosen.push({ pattern: best.p, word: best.w, passedOn: best.tier, newFills: bestRows.length, newCorrect: bestOk,
      synthetic: summarize(best.s.synthetic, best.w), manual: summarize(best.s["manual-auto"], best.w) });
    bestRows.forEach((i) => covered.add(i));
    pool = pool.filter((c) => c !== best);
  }
  return { candidates: candidates.size, chosen };
}

// Closed classes as tagged; open classes keep words seen 3+ times with 90%+ in one class.
function lexicons(rows, allowed) {
  const counts = new Map(), lexicon = {};
  for (const r of rows) for (const t of r.tokens) {
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

function main() {
  const reportIndex = process.argv.indexOf("--report");
  const heldout = heldoutIds();
  // Mine against the runtime without its generated rules.
  replaceBlock("src/rule-data/language.js", "  var WORD_CLASSES = Object.freeze({});");
  replaceBlock("src/rule-data/grammar.js", "");
  const engine = require("../src/rules.js"); // before anything else loads it
  const { DEFAULT_REPORTS, DEFAULT_PROVENANCE_REPORTS, loadArchivedRows } = require("./archived-rules-benchmark");
  const language = require("../src/rule-data/language.js");
  const loaded = loadArchivedRows(DEFAULT_REPORTS, DEFAULT_PROVENANCE_REPORTS);
  const conflicts = new Set(loaded.slotConflictIds);
  const archive = loaded.rows.filter((r) => !heldout.has(r.fixture) && !conflicts.has(r.id) &&
    r.labeled && r.expected && r.expected.length);
  console.error("archive rows", archive.length, "held-out videos excluded", heldout.size);
  const tokenized = archive.map((r) => ({ tokens: tokenize(r.context) }));
  const rows = [];
  archive.forEach((r, i) => {
    if (!TIERS.includes(r.pairClass)) return;
    const d = engine.applyDeterministicRules(r.context).decisions[0];
    rows.push({ tier: r.pairClass, creator: r.creator, expected: r.expected.map((w) => w.toLowerCase()),
      current: d && d.word ? d.word.toLowerCase() : "", pats: patterns(tokenized[i].tokens) });
  });
  const { candidates, chosen } = mine(rows);
  const lexicon = lexicons(tokenized, new Set(language.ALLOWED_WORDS.map((w) => w.toLowerCase())));
  const existing = new Set(engine.DETERMINISTIC_RULES.map((r) => r.template));
  const out = templates(chosen, lexicon, new Set(language.RULE_WORDS.map((w) => w.toLowerCase())), existing);
  replaceBlock("src/rule-data/language.js", out.language);
  replaceBlock("src/rule-data/grammar.js", out.grammar);
  if (reportIndex > 0) fs.writeFileSync(process.argv[reportIndex + 1], JSON.stringify({ chosen }, null, 1) + "\n");
  console.log(JSON.stringify({ candidates, chosen: chosen.length, newFills: chosen.reduce((a, c) => a + c.newFills, 0),
    newCorrect: chosen.reduce((a, c) => a + c.newCorrect, 0), rules: out.rules.length, classes: out.classes }));
}

if (require.main === module) {
  const files = ["language.js", "grammar.js"].map((f) => path.join(ROOT, "src/rule-data", f));
  const original = files.map((f) => fs.readFileSync(f, "utf8"));
  try { main(); } catch (error) { files.forEach((f, i) => fs.writeFileSync(f, original[i])); throw error; }
}
module.exports = { tokenize, patterns };
