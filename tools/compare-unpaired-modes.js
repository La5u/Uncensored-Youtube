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

function localFrame(context) {
  const tokens = String(context || "")
    .toLowerCase()
    .replace(/\[\s*__\s*\]/g, " __blank__ ")
    .replace(/[^a-z0-9'._-]+/g, " ")
    .trim()
    .split(/\s+/);
  const blank = tokens.indexOf("__blank__");
  if (blank < 0) return String(context || "").toLowerCase().trim();
  return [
    blank < 3 ? "^" : "",
    ...tokens.slice(Math.max(0, blank - 3), blank),
    "[__]",
    ...tokens.slice(blank + 1, blank + 4),
    blank + 4 > tokens.length ? "$" : ""
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

const rulesByFixture = resultMap(JSON.parse(fs.readFileSync(rulesReportPath, "utf8")));
const whisperByFixture = resultMap(JSON.parse(fs.readFileSync(whisperReportPath, "utf8")));

const slotCategories = {
  agree: 0,
  gap: 0,
  disagree: 0,
  bothEmpty: 0
};
const gapRows = [];
const disagreeRows = [];

for (const [fixtureName, whisperTokens] of whisperByFixture) {
  const rulesTokens = rulesByFixture.get(fixtureName);
  if (!rulesTokens) continue;
  whisperTokens.forEach((whisper, tokenIndex) => {
    const rules = rulesTokens.get(tokenIndex);
    if (!rules) return;
    const rulesWord = normalizedWord(rules.word);
    const whisperWord = normalizedWord(whisper.word);
    const frame = localFrame(rules.context || whisper.context);
    const row = {
      video: fixtureName,
      tokenIndex,
      context: rules.context || whisper.context,
      frame,
      rulesWord,
      whisperWord,
      rulesTemplate: rules.ruleTemplate || ""
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
    { frame: row.frame, count: 0, videos: new Set(), words: {} };
  group.count += 1;
  group.videos.add(row.video);
  increment(group.words, row.whisperWord);
  gapByFrame.set(row.frame, group);
});
const gapGroups = rankGroups([...gapByFrame.values()], 500).map((group) => ({
  ...group,
  words: Object.entries(group.words).sort((left, right) => right[1] - left[1])
}));

const disagreeByKey = new Map();
disagreeRows.forEach((row) => {
  const key = row.frame + "\t" + row.rulesWord + "\t" + row.whisperWord;
  const group = disagreeByKey.get(key) ||
    { frame: row.frame, rulesWord: row.rulesWord, whisperWord: row.whisperWord, count: 0, videos: new Set() };
  group.count += 1;
  group.videos.add(row.video);
  disagreeByKey.set(key, group);
});
const disagreeGroups = rankGroups([...disagreeByKey.values()], 500);

const total = Object.values(slotCategories).reduce((sum, count) => sum + count, 0);
const report = {
  generatedAt: new Date().toISOString(),
  source: {
    rules: path.relative(root, rulesReportPath),
    whisper: path.relative(root, whisperReportPath)
  },
  summary: {
    ...slotCategories,
    total,
    gapShare: total ? slotCategories.gap / total : 0,
    disagreeShare: total ? slotCategories.disagree / total : 0
  },
  gapGroups,
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
  `| Agree | Rules gap (whisper fills) | Disagree | Both empty | Total |`,
  `|---:|---:|---:|---:|---:|`,
  `| ${slotCategories.agree} | ${slotCategories.gap} | ${slotCategories.disagree} | ${slotCategories.bothEmpty} | ${report.summary.total} |`,
  "",
  `## Top rules-gap frames (candidate new rules)`,
  "",
  "| Rank | Count | Videos | Whisper words | Frame |",
  "|---:|---:|---:|---|---|",
  ...gapGroups.map((group) =>
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
