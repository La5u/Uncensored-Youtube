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
let frameWords = 5;
const MIN_OCCURRENCES = 3;
const MIN_PRECISION = 0.9;
for (let index = 0; index < extraArgs.length; index += 1) {
  if (extraArgs[index] === "--sample") sampleInputs.push(extraArgs[++index]);
  else if (extraArgs[index] === "--whisper") whisperInputs.push(extraArgs[++index]);
  else if (extraArgs[index] === "--exclude") exclusionInputs.push(extraArgs[++index]);
  else if (extraArgs[index] === "--limit") recommendationLimit = Number(extraArgs[++index]);
  else if (extraArgs[index] === "--frameWords") frameWords = Number(extraArgs[++index]);
  else exclusionInputs.push(extraArgs[index]);
}
if (!Number.isInteger(recommendationLimit) || recommendationLimit < 1 ||
    !Number.isInteger(frameWords) || frameWords < 1 || frameWords > 10) {
  throw new Error("--limit must be a positive integer and --frameWords must be 1..10");
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
  for (let left = 0; left <= frameWords; left += 1) {
    for (let right = 0; right <= frameWords; right += 1) {
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

const decisionCache = new Map();
function deterministicDecision(context) {
  if (decisionCache.has(context)) return decisionCache.get(context);
  const decision = rules.applyDeterministicRules(context).decisions[0] || null;
  if (decisionCache.size < 20000) decisionCache.set(context, decision);
  return decision;
}

function normalizedWord(value) {
  return String(value || "").toLowerCase().replace(/[.!?,;:]+$/u, "").trim();
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
      const decision = deterministicDecision(context);
      return { video: `${source}-${index}`, context, expected: word,
        predicted: normalizedWord(decision && decision.word) };
    });
  });
}

function readWhisper(file) {
  if (!fs.existsSync(file)) return [];
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  return (report.fixtures || []).flatMap((fixture) => (fixture.results || []).flatMap((row) => {
    if ((row.expected || []).length || row.source !== "transcript-anchor" ||
        !ALLOWED_WORDS.has(String(row.word || "").toLowerCase())) return [];
    const context = row.reviewContext || row.context;
    const decision = deterministicDecision(context);
    return [{ video: fixture.name, context, expected: normalizedWord(row.word),
      predicted: normalizedWord(decision && decision.word) }];
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
  return exactCandidatesByTemplate.get(template.toLowerCase()) || [];
}

const exactCandidatesByTemplate = new Map(rules.DETERMINISTIC_RULES.map((rule) =>
  [rule.template.toLowerCase(), rule.candidates]
));

function exactRuleExists(template, word) {
  return (exactCandidatesByTemplate.get(template.toLowerCase()) || []).includes(word);
}

const ALLOWED_WORDS = new Set(rules.ALLOWED_WORDS.map((word) => word.toLowerCase()));
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const pairedRows = report.fixtures.flatMap((fixture) => (fixture.results || [])
  .filter((row) => row.expected.length)
  .map((row) => ({ video: fixture.name, context: row.reviewContext || row.context,
    expected: normalizedWord(row.expected[0]), predicted: normalizedWord(row.word) })));
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
  const examples = stat.rowIds.map((id) => allRows[id])
    .filter((row, index, rows) => rows.findIndex((item) => item.context === row.context) === index)
    .slice(0, 8).map(({ video, context, expected, predicted, source }) =>
      ({ video, context, expected, predicted, source }));
  return { ...publicStat, videos: stat.videos.size, sources: [...stat.sources], examples,
    candidates: counts.slice(0, 2).map(([word]) => word), singlePrecision,
    ambiguousPrecision, alreadyInRules: counts.slice(0, 2).every(([word]) => existing.includes(word)) };
}).filter((stat) => stat.occurrences >= MIN_OCCURRENCES && stat.videos >= 2 &&
  stat.misses > 0 &&
  (stat.singlePrecision >= MIN_PRECISION || stat.ambiguousPrecision >= MIN_PRECISION))
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
  const correctDelta = stat.rowIds.reduce((total, id) => {
    const row = allRows[id];
    return total + Number(row.expected === word) - Number(row.predicted === row.expected);
  }, 0);
  const wrong = stat.rowIds.reduce((total, id) => total + Number(allRows[id].expected !== word), 0);
  return { stat, word, precision: sorted[0][1] / stat.rowIds.length,
    videos: videos.size, sourceStats, correctDelta, wrong,
    authoredPattern: stat.template.replace("[__]", `[${sorted[0][0]}]`) };
}).filter((candidate) => candidate.videos >= 2 && candidate.precision >= MIN_PRECISION &&
  Object.values(candidate.sourceStats).some((source) =>
    source.occurrences >= MIN_OCCURRENCES && source.videos >= 2 && source.precision >= MIN_PRECISION) &&
  !excludedPatterns.has(candidate.authoredPattern.toLowerCase()) &&
  !exactRuleExists(candidate.stat.template, candidate.word));
const claimed = new Set();
const recommendations = [];
selectable.sort((left, right) => right.correctDelta * 10 - right.wrong -
  (left.correctDelta * 10 - left.wrong));
for (const candidate of selectable) {
  if (recommendations.length >= recommendationLimit) break;
  let correctDelta = 0;
  candidate.stat.rowIds.forEach((id) => {
    if (claimed.has(id)) return;
    const row = allRows[id];
    correctDelta += Number(row.expected === candidate.word) - Number(row.predicted === row.expected);
  });
  if (correctDelta <= 0) continue;
  candidate.stat.rowIds.forEach((id) => claimed.add(id));
  recommendations.push({
    authoredPattern: candidate.authoredPattern,
    template: candidate.stat.template,
    candidate: candidate.word,
    precision: candidate.precision,
    occurrences: candidate.stat.rowIds.length,
    videos: candidate.videos,
    sourceStats: candidate.sourceStats
  });
}

function errorGroups(rows, key, limit) {
  const groups = new Map();
  rows.forEach((row) => {
    const group = groups.get(key(row)) || { key: key(row), count: 0, videos: new Set(), examples: [] };
    group.count += 1;
    group.videos.add(row.video);
    if (group.examples.length < 5 && !group.examples.some((example) => example.context === row.context)) {
      group.examples.push({ video: row.video, context: row.context, expected: row.expected, predicted: row.predicted,
        source: row.source });
    }
    groups.set(group.key, group);
  });
  return [...groups.values()].sort((left, right) => right.count - left.count ||
    right.videos.size - left.videos.size || left.key.localeCompare(right.key))
    .slice(0, limit)
    .map((group, index) => ({ rank: index + 1, key: group.key, count: group.count,
      videos: group.videos.size, examples: group.examples }));
}

const missedRows = allRows.filter((row) => !row.predicted);
const wrongRows = allRows.filter((row) => row.predicted && row.predicted !== row.expected);
const topMissedWords = errorGroups(missedRows, (row) => row.expected, 300);
const topWrongPlacements = errorGroups(wrongRows,
  (row) => `${row.expected} <- ${row.predicted}`, 50);

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
  thresholds: { singleCandidate: MIN_PRECISION, ambiguousCandidates: MIN_PRECISION,
    minimumOccurrences: MIN_OCCURRENCES, minimumVideos: 2, frameWords },
  counts: { rows: allRows.length, pairedRows: pairedRows.length, minedFrames: frames.size,
    generatedPhrases: generated.length, generatedNotInRules: generated.filter((x) => !x.alreadyInRules).length,
    opportunities: opportunities.length, recommendations: recommendations.length },
  generatedPhrases: generated,
  opportunities,
  recommendations,
  topMissedWords,
  topWrongPlacements,
  topPairedMisses: opportunities.filter((x) => x.sources.includes("paired")).slice(0, 300),
  topErrors: opportunities.filter((x) => x.mistakes).slice(0, 50)
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.counts));
