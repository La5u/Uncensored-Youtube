#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");
const { SWEAR_REGEX } = require("../corpus/swear-matcher");

const root = path.join(__dirname, "..");
const reportPath = path.resolve(root, process.argv[2] ||
  "corpus/generated/paired-rules-only-report.json");
const outputPath = path.resolve(root, process.argv[3] ||
  "corpus/generated/rule-opportunities.json");
const extraArgs = process.argv.slice(4);
const sampleInputs = [];
const whisperInputs = [];
const exclusionInputs = [];
let recommendationLimit = 250;
const MIN_OCCURRENCES = 2;
for (let index = 0; index < extraArgs.length; index += 1) {
  if (extraArgs[index] === "--sample") sampleInputs.push(extraArgs[++index]);
  else if (extraArgs[index] === "--whisper") whisperInputs.push(extraArgs[++index]);
  else if (extraArgs[index] === "--exclude") exclusionInputs.push(extraArgs[++index]);
  else if (extraArgs[index] === "--limit") recommendationLimit = Number(extraArgs[++index]);
  else exclusionInputs.push(extraArgs[index]);
}
if (!Number.isInteger(recommendationLimit) || recommendationLimit < 1) {
  throw new Error("--limit must be a positive integer");
}
if (!sampleInputs.length) {
  sampleInputs.push(
    "opensubtitles=corpus/generated/opensubtitles-rules-expanded-final/opensubtitles-samples.jsonl",
    "reddit=corpus/generated/reddit/reddit-samples.jsonl"
  );
}
const excludedPatterns = new Set(exclusionInputs.flatMap((file) => {
  const value = JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8"));
  return (Array.isArray(value) ? value : value.recommendations || [])
    .map((item) => String(item.authoredPattern || item).toLowerCase());
}));
const TOKEN = "__blank__";

function words(text) {
  return String(text || "").toLowerCase().replace(/\u2019/g, "'")
    .replace(/\[\s*__\s*\]/g, ` ${TOKEN} `)
    .match(/__blank__|[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
}

function expectedWords(text) {
  const found = [];
  String(text || "").replace(SWEAR_REGEX, (match, before, left, word) => {
    found.push(word.toLowerCase().replace(/\u2019/g, "'"));
    return match;
  });
  return found;
}

function localFrames(context) {
  const tokens = words(context);
  const blank = tokens.indexOf(TOKEN);
  if (blank < 0) return [];
  const frames = [];
  for (let left = 0; left <= 5; left += 1) {
    for (let right = 0; right <= 5; right += 1) {
      if (left + right < 1 || left > blank || right >= tokens.length - blank) continue;
      frames.push([
        ...tokens.slice(blank - left, blank), "[__]",
        ...tokens.slice(blank + 1, blank + right + 1)
      ].join(" "));
    }
  }
  return frames;
}

function addFrame(map, template, row, source) {
  let stat = map.get(template);
  if (!stat) {
    stat = { template, occurrences: 0, misses: 0, mistakes: 0, videos: new Set(),
      sources: new Set(), expectedCounts: {}, rowIds: [] };
    map.set(template, stat);
  }
  stat.occurrences += 1;
  stat.misses += row.predicted ? 0 : 1;
  stat.mistakes += row.predicted && row.predicted !== row.expected ? 1 : 0;
  stat.videos.add(row.video);
  stat.sources.add(source);
  if (row.id !== undefined) stat.rowIds.push(row.id);
  stat.expectedCounts[row.expected] = (stat.expectedCounts[row.expected] || 0) + 1;
}

function addRows(map, rows, source) {
  rows.forEach((row) => {
    const key = `${source}\n${row.context.toLowerCase()}\n${row.expected}`;
    if (seenRows.has(key)) return;
    seenRows.add(key);
    row.id = allRows.length;
    row.source = source;
    allRows.push(row);
    localFrames(row.context).forEach((frame) => addFrame(map, frame, row, source));
  });
}

function readSamples(file, source) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").flatMap((line, index) => {
    const sample = JSON.parse(line);
    const expected = expectedWords(sample.original);
    return expected.map((word, tokenIndex) => {
      let seen = -1;
      const context = String(sample.censored).replace(/\[\s*__\s*\]/g, (token) => {
        seen += 1;
        return seen === tokenIndex ? token : " ";
      });
      const decision = rules.applyDeterministicRules(context).decisions[0];
      return { video: `${source}-${index}`, context, expected: word,
        predicted: decision && decision.word ? decision.word.toLowerCase() : "" };
    });
  });
}

function readWhisper(file) {
  if (!fs.existsSync(file)) return [];
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  return (report.fixtures || []).flatMap((fixture) => (fixture.results || []).flatMap((row) => {
    if ((row.expected || []).length || row.source !== "transcript-anchor" ||
        !ALLOWED_WORDS.has(String(row.word || "").toLowerCase())) return [];
    const decision = rules.applyDeterministicRules(row.context).decisions[0];
    return [{ video: fixture.name, context: row.context, expected: row.word.toLowerCase(),
      predicted: decision && decision.word ? decision.word.toLowerCase() : "" }];
  }));
}

function generatedPhrases() {
  const output = new Set();
  const add = (word, left, right = "") => output.add(`${left} [${word}]${right ? ` ${right}` : ""}`);
  const pronouns = ["me", "you", "him", "her", "us", "them"];
  const continuations = ["i", "you", "he", "she", "we", "they", "it", "this", "that"];
  ["fuck", "shit"].forEach((word) => {
    ["oh", "ah", "holy", "well", "no", "yes", "what the", "who the", "where the",
      "why the", "how the"].forEach((left) => continuations.forEach((right) => add(word, left, right)));
  });
  ["give", "gives", "gave", "giving", "don't give", "doesn't give", "didn't give",
    "couldn't give", "wouldn't give"].forEach((left) =>
    ["fuck", "shit"].forEach((word) => ["about", "anymore", "now", "if"].forEach((right) =>
      add(word, `${left} a`, right))));
  ["scare", "scared", "scares", "scaring", "beat", "kick", "knock", "shoot",
    "terrify", "frighten"].forEach((verb) => pronouns.forEach((object) =>
    add("shit", `${verb} the`, `out of ${object}`)));
  ["get", "got", "keep", "put", "pull", "sort"].forEach((verb) =>
    ["my", "your", "his", "her", "our", "their"].forEach((owner) =>
      add("shit", `${verb} ${owner}`, "together")));
  ["piece", "pile", "load", "sack", "bag", "bucket", "crock", "ton"].forEach((noun) =>
    add("shit", `${noun} of`));
  ["full", "tired", "sick", "afraid"].forEach((state) => add("shit", state === "full" ? "full of" : `${state} of this`));
  ["hurry", "shut", "listen", "wake", "lighten", "loosen", "straighten"].forEach((verb) =>
    add("fuck", verb, "up"));
  return [...output];
}

function existingCandidates(template) {
  const context = template.replace(/\[([^\]]+)\]/, "[__]");
  const decision = rules.applyDeterministicRules(context, { ambiguous: "abstain" }).decisions[0];
  return decision ? decision.rule.candidates : [];
}

function exactRuleExists(template, word) {
  return rules.DETERMINISTIC_RULES.some((rule) =>
    rule.template.toLowerCase() === template.toLowerCase() && rule.candidates.includes(word));
}

const ALLOWED_WORDS = new Set(rules.ALLOWED_WORDS.map((word) => word.toLowerCase()));
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const pairedRows = report.fixtures.flatMap((fixture) => (fixture.results || [])
  .filter((row) => row.expected.length)
  .map((row) => ({ video: fixture.name, context: row.context,
    expected: row.expected[0].toLowerCase(), predicted: String(row.word || "").toLowerCase() })));
const allRows = [];
const seenRows = new Set();
const frames = new Map();
addRows(frames, pairedRows, "paired");
sampleInputs.forEach((input) => {
  const separator = input.indexOf("=");
  if (separator < 1) throw new Error(`Expected --sample source=path, got ${input}`);
  const source = input.slice(0, separator);
  addRows(frames, readSamples(path.resolve(root, input.slice(separator + 1)), source), source);
});
whisperInputs.forEach((input) => addRows(frames, readWhisper(path.resolve(root, input)), "whisper"));

const opportunities = [...frames.values()].map((stat) => {
  const counts = Object.entries(stat.expectedCounts).sort((a, b) => b[1] - a[1]);
  const first = counts[0] || ["", 0];
  const second = counts[1] || ["", 0];
  const singlePrecision = first[1] / stat.occurrences;
  const ambiguousPrecision = (first[1] + second[1]) / stat.occurrences;
  const existing = existingCandidates(stat.template);
  const { rowIds, ...publicStat } = stat;
  return { ...publicStat, videos: stat.videos.size, sources: [...stat.sources],
    candidates: counts.slice(0, 2).map(([word]) => word), singlePrecision,
    ambiguousPrecision, alreadyInRules: counts.slice(0, 2).every(([word]) => existing.includes(word)) };
}).filter((stat) => stat.occurrences >= MIN_OCCURRENCES && stat.videos >= 2 &&
  stat.misses > 0 &&
  (stat.singlePrecision > 0.8 || stat.ambiguousPrecision > 0.9))
  .sort((a, b) => b.misses - a.misses || b.occurrences - a.occurrences ||
    b.singlePrecision - a.singlePrecision);

const selectable = [...frames.values()].filter((stat) =>
  stat.rowIds.length >= MIN_OCCURRENCES).map((stat) => {
  const counts = {};
  const videos = new Set();
  const sourceStats = {};
  stat.rowIds.forEach((id) => {
    const row = allRows[id];
    videos.add(row.video);
    counts[row.expected] = (counts[row.expected] || 0) + 1;
    const source = sourceStats[row.source] ||
      (sourceStats[row.source] = { occurrences: 0, correct: 0, videos: new Set() });
    source.occurrences += 1;
    source.videos.add(row.video);
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const word = sorted[0][0];
  stat.rowIds.forEach((id) => {
    const row = allRows[id];
    sourceStats[row.source].correct += Number(row.expected === word);
  });
  Object.values(sourceStats).forEach((source) => {
    source.precision = source.correct / source.occurrences;
    source.videos = source.videos.size;
  });
  return { stat, word, precision: sorted[0][1] / stat.rowIds.length,
    videos: videos.size, sourceStats,
    authoredPattern: stat.template.replace("[__]", `[${sorted[0][0]}]`) };
}).filter((candidate) => candidate.videos >= 2 && candidate.precision > 0.8 &&
  Object.values(candidate.sourceStats).some((source) =>
    source.occurrences >= MIN_OCCURRENCES && source.videos >= 2 && source.precision > 0.8) &&
  !excludedPatterns.has(candidate.authoredPattern.toLowerCase()) &&
  !exactRuleExists(candidate.stat.template, candidate.word));
const claimed = new Set();
const recommendations = [];
while (recommendations.length < recommendationLimit) {
  let best = null;
  selectable.forEach((candidate) => {
    if (candidate.selected) return;
    let correctDelta = 0;
    let wrong = 0;
    candidate.stat.rowIds.forEach((id) => {
      if (claimed.has(id)) return;
      const row = allRows[id];
      const correct = row.expected === candidate.word;
      correctDelta += Number(correct) - Number(row.predicted === row.expected);
      wrong += Number(!correct);
    });
    const score = correctDelta * 10 - wrong;
    if (!best || score > best.score) best = { candidate, correctDelta, score };
  });
  if (!best || best.correctDelta <= 0) break;
  best.candidate.selected = true;
  best.candidate.stat.rowIds.forEach((id) => claimed.add(id));
  recommendations.push({
    authoredPattern: best.candidate.authoredPattern,
    template: best.candidate.stat.template,
    candidate: best.candidate.word,
    precision: best.candidate.precision,
    occurrences: best.candidate.stat.rowIds.length,
    videos: best.candidate.videos,
    sourceStats: best.candidate.sourceStats
  });
}

const generated = generatedPhrases().map((phrase) => {
  const match = phrase.match(/\[([^\]]+)\]/);
  const template = phrase.replace(/\[[^\]]+\]/, "[__]");
  const stat = frames.get(template);
  return { phrase, template, candidate: match[1], alreadyInRules:
    existingCandidates(template).includes(match[1]), occurrences: stat ? stat.occurrences : 0,
    expectedCounts: stat ? stat.expectedCounts : {} };
});

const output = {
  generatedAt: new Date().toISOString(), source: path.relative(root, reportPath),
  thresholds: { singleCandidate: 0.8, ambiguousCandidates: 0.9,
    minimumOccurrences: MIN_OCCURRENCES, minimumVideos: 2 },
  counts: { rows: allRows.length, pairedRows: pairedRows.length, minedFrames: frames.size,
    generatedPhrases: generated.length, generatedNotInRules: generated.filter((x) => !x.alreadyInRules).length,
    opportunities: opportunities.length, recommendations: recommendations.length },
  generatedPhrases: generated,
  opportunities,
  recommendations,
  topPairedMisses: opportunities.filter((x) => x.sources.includes("paired")).slice(0, 300),
  topErrors: opportunities.filter((x) => x.mistakes).slice(0, 50)
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.counts));
