#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const rulesReportPath = path.resolve(root, process.argv[2] ||
  "corpus/generated/unpaired-rules-only-report.json");
const whisperReportPath = path.resolve(root, process.argv[3] ||
  "corpus/generated/unpaired-whisper-only-report.json");
const outputDir = path.resolve(root, process.argv[4] || "corpus/generated");

function localFrame(context, radius = 4) {
  const tokens = String(context || "")
    .toLowerCase()
    .replace(/\[\s*__\s*\]/g, " __blank__ ")
    .replace(/[^a-z0-9'._-]+/g, " ")
    .trim()
    .split(/\s+/);
  const blank = tokens.indexOf("__blank__");
  if (blank < 0) return String(context || "").toLowerCase().trim();
  return [
    blank < radius ? "^" : "",
    ...tokens.slice(Math.max(0, blank - radius), blank),
    "[__]",
    ...tokens.slice(blank + 1, blank + radius + 1),
    blank + radius + 1 > tokens.length ? "$" : ""
  ].filter(Boolean).join(" ");
}

function resultMap(report) {
  const byFixture = new Map();
  (report.fixtures || []).forEach((fixture) => {
    if (!fixture || !Array.isArray(fixture.results)) return;
    const byToken = new Map();
    fixture.results.forEach((result) => {
      byToken.set(result.tokenIndex, result);
    });
    byFixture.set(fixture.name, byToken);
  });
  return byFixture;
}

function increment(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function normalizedWord(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .trim();
}

const rulesReport = JSON.parse(fs.readFileSync(rulesReportPath, "utf8"));
const whisperReport = JSON.parse(fs.readFileSync(whisperReportPath, "utf8"));
const rulesByFixture = resultMap(rulesReport);
const whisperByFixture = resultMap(whisperReport);

const slotCategories = {
  agree: 0,
  gap: 0,
  rulesOnly: 0,
  disagree: 0,
  bothEmpty: 0,
  missingRules: 0,
  missingWhisper: 0
};
const gapRows = [];
const rulesOnlyRows = [];
const disagreeRows = [];
const incompleteRows = [];

const fixtureNames = new Set([...rulesByFixture.keys(), ...whisperByFixture.keys()]);
for (const fixtureName of fixtureNames) {
  const rulesTokens = rulesByFixture.get(fixtureName);
  const whisperTokens = whisperByFixture.get(fixtureName);
  const tokenIndexes = new Set([
    ...(rulesTokens ? rulesTokens.keys() : []),
    ...(whisperTokens ? whisperTokens.keys() : [])
  ]);
  tokenIndexes.forEach((tokenIndex) => {
    const rules = rulesTokens && rulesTokens.get(tokenIndex);
    const whisper = whisperTokens && whisperTokens.get(tokenIndex);
    if (!rules || !whisper) {
      slotCategories[!rules ? "missingRules" : "missingWhisper"] += 1;
      incompleteRows.push({ video: fixtureName, tokenIndex, rules: Boolean(rules), whisper: Boolean(whisper) });
      return;
    }
    const rulesWord = normalizedWord(rules.word);
    const whisperWord = normalizedWord(whisper.word);
    const context = rules.reviewContext || whisper.reviewContext || rules.context || whisper.context;
    const frame = localFrame(context);
    const row = {
      video: fixtureName,
      tokenIndex,
      context,
      frame,
      rulesWord,
      whisperWord,
      rulesTemplate: rules.ruleTemplate || "",
      whisperSource: whisper.source || "",
      rulesSource: rules.source || ""
    };
    if (rulesWord && whisperWord) {
      if (rulesWord === whisperWord) slotCategories.agree += 1;
      else {
        slotCategories.disagree += 1;
        disagreeRows.push(row);
      }
    } else if (!rulesWord && whisperWord) {
      slotCategories.gap += 1;
      gapRows.push(row);
    } else if (rulesWord && !whisperWord) {
      slotCategories.rulesOnly += 1;
      rulesOnlyRows.push(row);
    } else {
      slotCategories.bothEmpty += 1;
    }
  });
}

function rankGroups(groups, limit) {
  return groups
    .map((group) => ({ ...group, videoCount: group.videos.size, videos: undefined }))
    .sort((left, right) =>
      right.count - left.count ||
      right.videoCount - left.videoCount ||
      left.frame.localeCompare(right.frame))
    .slice(0, limit)
    .map((group, index) => ({ rank: index + 1, ...group }));
}

const gapByFrame = new Map();
gapRows.forEach((row) => {
  const group = gapByFrame.get(row.frame) ||
    { frame: row.frame, count: 0, videos: new Set(), words: {}, examples: [] };
  group.count += 1;
  group.videos.add(row.video);
  increment(group.words, row.whisperWord);
  if (group.examples.length < 5) group.examples.push({ video: row.video, context: row.context,
    whisperWord: row.whisperWord });
  gapByFrame.set(row.frame, group);
});
const gapGroups = rankGroups([...gapByFrame.values()], 500).map((group) => ({
  ...group,
  words: Object.entries(group.words).sort((left, right) => right[1] - left[1])
}));

const rulesOnlyByFrame = new Map();
rulesOnlyRows.forEach((row) => {
  const group = rulesOnlyByFrame.get(row.frame) ||
    { frame: row.frame, count: 0, videos: new Set(), words: {}, examples: [] };
  group.count += 1;
  group.videos.add(row.video);
  increment(group.words, row.rulesWord);
  if (group.examples.length < 5) group.examples.push({ video: row.video, context: row.context,
    rulesWord: row.rulesWord, ruleTemplate: row.rulesTemplate });
  rulesOnlyByFrame.set(row.frame, group);
});
const rulesOnlyGroups = rankGroups([...rulesOnlyByFrame.values()], 500).map((group) => ({
  ...group,
  words: Object.entries(group.words).sort((left, right) => right[1] - left[1])
}));

const disagreeByKey = new Map();
disagreeRows.forEach((row) => {
  const key = row.frame + "\t" + row.rulesWord + "\t" + row.whisperWord;
  const group = disagreeByKey.get(key) ||
    { frame: row.frame, rulesWord: row.rulesWord, whisperWord: row.whisperWord,
      count: 0, videos: new Set(), examples: [] };
  group.count += 1;
  group.videos.add(row.video);
  if (group.examples.length < 5) group.examples.push({ video: row.video, context: row.context });
  disagreeByKey.set(key, group);
});
const disagreeGroups = rankGroups([...disagreeByKey.values()], 500);

const total = Object.values(slotCategories).reduce((sum, count) => sum + count, 0);
const compared = total - slotCategories.missingRules - slotCategories.missingWhisper;

function reportCompleteness(report) {
  const partialFixtures = (report.fixtures || []).filter((fixture) =>
    fixture && !fixture.skipped && Number(fixture.tokenCount || 0) > (fixture.results || []).length
  );
  return {
    fixtureCount: (report.fixtures || []).length,
    evaluatedSlots: (report.fixtures || []).reduce((sum, fixture) => sum + (fixture.results || []).length, 0),
    declaredSlots: (report.fixtures || []).reduce((sum, fixture) => sum + Number(fixture.tokenCount || 0), 0),
    partialFixtureCount: partialFixtures.length,
    partialFixtures: partialFixtures.slice(0, 50).map((fixture) => ({
      name: fixture.name,
      tokenCount: fixture.tokenCount,
      evaluatedCount: (fixture.results || []).length
    })),
    limit: report.limit === undefined ? null : report.limit,
    complete: report.complete !== false && partialFixtures.length === 0
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  source: {
    rules: path.relative(root, rulesReportPath),
    whisper: path.relative(root, whisperReportPath)
  },
  reports: {
    rules: reportCompleteness(rulesReport),
    whisper: reportCompleteness(whisperReport)
  },
  summary: {
    ...slotCategories,
    total,
    compared,
    gapShare: compared ? slotCategories.gap / compared : 0,
    rulesOnlyShare: compared ? slotCategories.rulesOnly / compared : 0,
    disagreeShare: compared ? slotCategories.disagree / compared : 0,
    incompleteShare: total ? (slotCategories.missingRules + slotCategories.missingWhisper) / total : 0
  },
  gapGroups,
  rulesOnlyGroups,
  incompleteRows: incompleteRows.slice(0, 500),
  disagreeGroups
};

fs.mkdirSync(outputDir, { recursive: true });
const jsonPath = path.join(outputDir, "unpaired-mode-compare.json");
fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

const mdPath = path.join(outputDir, "unpaired-mode-compare.md");
const lines = [
  "# Unpaired rules vs whisper comparison",
  "",
  `- rules report: \`${report.source.rules}\``,
  `- whisper report: \`${report.source.whisper}\``,
  "",
  `- compared slots: ${report.summary.compared}; incomplete report slots: ${slotCategories.missingRules + slotCategories.missingWhisper}`,
  `- rules report complete: ${report.reports.rules.complete}; Whisper report complete: ${report.reports.whisper.complete}`,
  "",
  `| Agree | Rules gap | Rules only | Disagree | Both empty | Incomplete | Total |`,
  `|---:|---:|---:|---:|---:|---:|---:|`,
  `| ${slotCategories.agree} | ${slotCategories.gap} | ${slotCategories.rulesOnly} | ${slotCategories.disagree} | ${slotCategories.bothEmpty} | ${slotCategories.missingRules + slotCategories.missingWhisper} | ${report.summary.total} |`,
  "",
  `## Top rules-gap frames (candidate new rules)`,
  "",
  "| Rank | Count | Videos | Whisper words | Frame |",
  "|---:|---:|---:|---|---|",
  ...gapGroups.map((group) =>
    `| ${group.rank} | ${group.count} | ${group.videoCount} | ${group.words.map(([word, count]) => `${word} ${count}`).join(", ")} | \`${group.frame}\` |`),
  "",
  `## Top rules-only fills (Whisper skipped)`,
  "",
  "| Rank | Count | Videos | Rules words | Frame |",
  "|---:|---:|---:|---|---|",
  ...rulesOnlyGroups.map((group) =>
    `| ${group.rank} | ${group.count} | ${group.videoCount} | ${group.words.map(([word, count]) => `${word} ${count}`).join(", ")} | \`${group.frame}\` |`),
  "",
  `## Top rules/whisper disagreements (candidate rule mistakes)`,
  "",
  "| Rank | Count | Videos | Rules | Whisper | Frame |",
  "|---:|---:|---:|---|---|---|",
  ...disagreeGroups.map((group) =>
    `| ${group.rank} | ${group.count} | ${group.videoCount} | ${group.rulesWord} | ${group.whisperWord} | \`${group.frame}\` |`)
];
fs.writeFileSync(mdPath, `${lines.join("\n")}\n`);

console.log(JSON.stringify({
  output: jsonPath,
  summary: report.summary,
  gapGroups: gapGroups.length,
  disagreeGroups: disagreeGroups.length
}, null, 2));
