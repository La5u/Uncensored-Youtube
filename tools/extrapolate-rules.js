#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");
const ruleData = require("../src/rules-data");
const compiler = require("../src/rules-compiler");
const evaluator = require("./evaluate-whisper-only");

const root = path.join(__dirname, "..");
const reportPath = path.resolve(root, process.argv[2] ||
  "/tmp/opencode/paired-rules-final-v6.json");
const outputPath = path.resolve(root, process.argv[3] ||
  "corpus/generated/extrapolated-candidates.json");

const TARGET_CANDIDATES = 60000;
const CENSORED_TOKEN = rules.CENSORED_TOKEN;
const ALLOWED_WORD_SET = new Set(rules.ALLOWED_WORDS);
const MAX_TRIM_TOKENS = 9;
const MAX_PART_TOKENS = 4;
const MAX_MIX_PER_WORD = 25000;

const existingTemplates = new Set(rules.DETERMINISTIC_RULES.map((rule) => rule.template));

// Fixed-token swap classes: replace a literal token with a similar word.
const TOKEN_SWAPS = {
  "you": ["he", "she", "they", "we", "it", "me", "them"],
  "my": ["your", "his", "her", "our", "their"],
  "the": ["a", "this", "that"],
  "that": ["this"],
  "this": ["that"],
  "oh": ["ah", "uh", "hey"],
  "yeah": ["no", "well"],
  "said": ["says", "say"],
  "get": ["got", "gets", "gets to"],
  "got": ["get", "gets"],
  "do": ["did", "does", "doing"],
  "did": ["do", "does"],
  "i": ["you", "we", "they", "he", "she"],
  "you're": ["he's", "she's", "we're", "they're", "it's"],
  "going": ["gonna"],
  "gonna": ["going"],
  "for": ["from", "about"],
  "to": ["for"],
  "in": ["on", "at"],
  "and": ["but", "or"],
  "a": ["the", "some", "any"],
  "some": ["a", "any"],
  "you": ["me"],
  "we": ["they", "you"]
};

// Candidate-class swaps: single-candidate rules may also fire with a similar
// word in the same slot. Only words already in ALLOWED_WORDS are usable.
const CANDIDATE_SWAPS = {
  "fuck": ["shit", "fucking", "fucked", "bullshit", "asshole", "bitch", "motherfucker", "cunt", "pussy", "whore", "slut"],
  "fucking": ["fucking", "shit", "fucked", "fuck", "bullshit", "asshole", "bitch", "motherfucker", "motherfucking", "cunt"],
  "fucked": ["fucking", "shit", "fuck", "bullshit", "bitch"],
  "shit": ["fuck", "fucking", "bullshit", "asshole", "bitch", "motherfucker", "dipshit", "shithole"],
  "bitch": ["asshole", "whore", "cunt", "slut"],
  "asshole": ["bitch", "assholes", "dickhead"],
  "dickhead": ["asshole", "dickheads"],
  "bullshit": ["shit", "bullshit", "fuck", "fucking"],
  "motherfucker": ["motherfuckers", "motherfucking", "fucker", "fuckers"],
  "pussy": ["cock", "cunt"],
  "cock": ["pussy", "cock"]
};

function words(template) {
  return template
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .trim()
    .split(/\s+/u);
}

function buildTemplate(tokens) {
  return tokens.join(" ");
}

// Mirror rules.js compileRule so matching uses the same regex semantics.
function compileTemplate(template) {
  const startsSentence = /^\^/.test(template);
  const endsWithSpace = /\s$/.test(template);
  const endsSentence = /\$$/.test(template);
  let t = template;
  if (startsSentence) t = t.slice(1);
  if (endsSentence) t = t.slice(0, -1);
  const startsWithPunctuation = /^[.!?]/.test(t);
  if (endsWithSpace) t = t.replace(/\s+$/, "");
  const escaped = compiler.escapeRegExp(t)
    .replace(/\\\[__\\\]/g, "\\[__\\]")
    .replace(/'/g, "['\u2019]")
    .replace(/ /g, "\\s+");
  const suffix = endsSentence
    ? "(?=[^\\p{L}\\p{N}_'’]*$)"
    : endsWithSpace ? "(?=\\s|$)" : "(?=$|[^\\p{L}\\p{N}_'’])";
  return new RegExp((startsSentence ? "(^)" : startsWithPunctuation ? "()" : "(^|[^\\p{L}\\p{N}_'’])") +
    "(" + escaped + ")" + suffix, "giu");
}

function reportRows() {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  return report.fixtures.flatMap((fixture) => (fixture.results || [])
    .filter((row) => (row.expected || []).length)
    .map((row) => ({
      fixture: fixture.name,
      context: row.context,
      expected: row.expected,
      word: row.word,
      correct: row.correct,
      tier: row.ruleTier || ""
    })));
}

// Generate candidate authored patterns (template + single candidate word).
function generateCandidates() {
  const exactRules = compiler.compileGroups(ruleData.RULE_GROUPS.exact);
  const candidates = new Map(); // template -> { word, sources:Set }
  const seenTemplates = new Set(existingTemplates);

  const addCandidate = (template, word, source) => {
    template = buildTemplate(words(template));
    if (template.length < 2) return;
    if (!template.includes(CENSORED_TOKEN)) return;
    if ((template.match(/\[__\]/g) || []).length !== 1) return;
    if (seenTemplates.has(template)) return;
    if (!ALLOWED_WORD_SET.has(word)) return;
    seenTemplates.add(template);
    const entry = candidates.get(template) || { template, word, sources: new Set() };
    entry.sources.add(source);
    candidates.set(template, entry);
  };

  // Part pools keyed by candidate word for mix-and-match recombination.
  const leftParts = new Map(); // word -> Set["tok tok"]
  const rightParts = new Map(); // word -> Set["tok tok"]

  const collectPart = (map, word, tokens) => {
    if (!tokens.length) return;
    if (!map.has(word)) map.set(word, new Set());
    map.get(word).add(tokens.join(" "));
  };

  exactRules.forEach((rule) => {
    const template = rule.template;
    const blankIndex = words(template).indexOf(CENSORED_TOKEN);
    if (blankIndex < 0) return;
    const tokens = words(template);
    const left = tokens.slice(0, blankIndex);
    const right = tokens.slice(blankIndex + 1);
    const head = rule.candidates[0];
    if (!ALLOWED_WORD_SET.has(head)) return;

    const swapWords = (CANDIDATE_SWAPS[head] || []).filter((w) => w !== head);

    // Trim windows around [__]: keep [__] plus a left/right window, at most
    // 2 tokens per side and 4 total, always narrower than the source.
    for (let l = 0; l <= left.length; l += 1) {
      for (let r = 0; r <= right.length; r += 1) {
        if (l + r === 0) continue;
        if (l + 1 + r > MAX_TRIM_TOKENS) continue;
        if (l === left.length && r === right.length) continue;
        const newTokens = [...left.slice(left.length - l), CENSORED_TOKEN, ...right.slice(0, r)];
        addCandidate(buildTemplate(newTokens), head, `trim:${template}`);
        swapWords.forEach((word) => {
          addCandidate(buildTemplate(newTokens), word, `trim-swap:${template}:${word}`);
        });
      }
    }

    // Similar-token substitution on the full template (one swap at a time).
    tokens.forEach((token, index) => {
      if (token === CENSORED_TOKEN) return;
      const replacements = TOKEN_SWAPS[token.toLowerCase()] || [];
      replacements.forEach((replacement) => {
        const variant = tokens.slice();
        variant[index] = replacement;
        addCandidate(buildTemplate(variant), head, `token-swap:${template}:${token}`);
        swapWords.forEach((word) => {
          addCandidate(buildTemplate(variant), word, `token+swap:${template}:${token}:${word}`);
        });
      });
    });

    // Pool left/right context windows for cross-rule recombination.
    for (let l = 1; l <= Math.min(left.length, MAX_PART_TOKENS); l += 1) {
      collectPart(leftParts, head, left.slice(left.length - l));
    }
    for (let r = 1; r <= Math.min(right.length, MAX_PART_TOKENS); r += 1) {
      collectPart(rightParts, head, right.slice(0, r));
    }
  });

  // Cross-rule mix-and-match: left context from one rule + right context from
  // another, sharing the same candidate word and a similar slot position.
  for (const [word, lefts] of leftParts) {
    const rights = rightParts.get(word) || new Set();
    const leftArr = [...lefts];
    const rightArr = [...rights];
    if (!leftArr.length || !rightArr.length) continue;
    // Randomize-but-deterministic pairing so the pool is diverse yet bounded.
    const perm = (values, seed) => values
      .map((value, index) => [value, (index * 2654435761 + seed * 40503) >>> 0])
      .sort((a, b) => a[1] - b[1])
      .map((pair) => pair[0]);
    const shuffledLefts = perm(leftArr, 7);
    const shuffledRights = perm(rightArr, 11);
    let mixed = 0;
    for (const leftPart of shuffledLefts) {
      for (const rightPart of shuffledRights) {
        if (mixed >= MAX_MIX_PER_WORD) break;
        const template = `${leftPart} ${CENSORED_TOKEN} ${rightPart}`;
        if (template.split(" ").length > MAX_TRIM_TOKENS + 1) continue;
        addCandidate(template, word, `mix:${leftPart}|${rightPart}`);
        mixed += 1;
      }
    }
  }

  const all = [...candidates.values()];
  if (all.length > TARGET_CANDIDATES) {
    // Keep the most-sourced candidates first so scoring favors grounded rules.
    return all.sort((a, b) => b.sources.size - a.sources.size).slice(0, TARGET_CANDIDATES);
  }
  return all;
}

// Score every candidate against the report rows.
function scoreCandidates(candidates, scoredRows) {
  const results = [];
  for (const candidate of candidates) {
    const regex = compileTemplate(candidate.template);
    const fired = [];
    let good = 0;
    let bad = 0;
    let newAttempts = 0;
    let newCorrectCount = 0;

    scoredRows.forEach((row, index) => {
      regex.lastIndex = 0;
      if (!regex.test(row.context)) return;
      const newCorrect = evaluator.isCorrect(candidate.word, row.expected, row.context);
      fired.push(index);
      if (newCorrect && !row.correct) good += 1;
      else if (!newCorrect && row.correct) bad += 1;
      if (!row.word) newAttempts += 1;
      if (newCorrect) newCorrectCount += 1;
    });
    if (!fired.length) continue;

    results.push({
      template: candidate.template,
      word: candidate.word,
      sources: [...candidate.sources],
      fired: fired.length,
      videos: new Set(fired.map((index) => scoredRows[index].fixture)).size,
      good,
      bad,
      newAttempts,
      deltaCorrect: good - bad,
      precision: newCorrectCount / fired.length,
      firedRows: fired
    });
  }
  return results;
}

// Greedy selection that claims rows so overlapping rules don't double-count,
// and enforces a global precision floor against the baseline totals.
function selectBest(results, keep, baseline, scoredRows) {
  const claimed = new Set();
  let correct = baseline.correct;
  let attempted = baseline.attempted;
  const selected = [];

  const ranked = results
    .filter((r) => r.deltaCorrect > 0 && r.precision >= 0.7)
    .sort((a, b) => b.deltaCorrect - a.deltaCorrect ||
      b.precision - a.precision || b.fired - a.fired);

  for (const result of ranked) {
    if (selected.length >= keep) break;
    let correctDelta = 0;
    let attemptedDelta = 0;
    result.firedRows.forEach((index) => {
      if (claimed.has(index)) return;
      const row = scoredRows[index];
      const newCorrect = evaluator.isCorrect(result.word, row.expected, row.context);
      if (newCorrect && !row.correct) correctDelta += 1;
      else if (!newCorrect && row.correct) correctDelta -= 1;
      if (!row.word) attemptedDelta += 1;
    });
    if (correctDelta <= 0) continue;
    if ((correct + correctDelta) / (attempted + attemptedDelta) < baseline.precision) continue;
    correct += correctDelta;
    attempted += attemptedDelta;
    result.firedRows.forEach((index) => claimed.add(index));
    selected.push(result);
  }
  return selected;
}

const candidates = generateCandidates();
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const rows = reportRows();
const scoredRows = rows.filter((row) => row.tier !== "exact");
const baseline = {
  correct: rows.filter((row) => row.correct).length,
  attempted: rows.filter((row) => row.word).length
};
baseline.precision = baseline.correct / baseline.attempted;
const scored = scoreCandidates(candidates, scoredRows);
const selected = selectBest(scored, 300, baseline, scoredRows);

const output = {
  generatedAt: new Date().toISOString(),
  source: path.relative(root, reportPath),
  counts: {
    candidates: candidates.length,
    scored: scored.length,
    selected: selected.length,
    netPositive: scored.filter((r) => r.deltaCorrect > 0).length,
    zeroRegression: scored.filter((r) => r.bad === 0 && r.newAttempts === 0).length
  },
  selected
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.counts));
