#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const input = path.resolve(root, process.argv[2] ||
  "corpus/generated/paired-rules-only-report.json");
const outputDir = path.resolve(root, process.argv[3] || "corpus/generated");
const mistakeLimit = Number(process.argv[4] || 200);
const missLimit = Number(process.argv[5] || 100);
const report = JSON.parse(fs.readFileSync(input, "utf8"));

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

const rows = report.fixtures.flatMap((fixture) =>
  (fixture.results || []).filter((result) => result.expected.length).map((result) => ({
    video: fixture.name,
    tokenIndex: result.tokenIndex,
    timeSeconds: result.timeSeconds,
    expected: result.expected[0],
    predicted: result.word || "",
    context: result.context,
    frame: localFrame(result.context),
    correct: result.correct
  }))
);

function rank(selected, limit, includePrediction) {
  const groups = new Map();
  for (const row of selected) {
    const key = [row.expected, includePrediction ? row.predicted : "", row.frame].join("\t");
    let group = groups.get(key);
    if (!group) {
      group = {
        expected: row.expected,
        ...(includePrediction ? { predicted: row.predicted } : {}),
        frame: row.frame,
        count: 0,
        videos: new Set(),
        examples: []
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.videos.add(row.video);
    if (group.examples.length < 5) {
      group.examples.push({
        video: row.video,
        tokenIndex: row.tokenIndex,
        timeSeconds: row.timeSeconds,
        context: row.context
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, videoCount: group.videos.size, videos: undefined }))
    .sort((left, right) =>
      right.count - left.count ||
      right.videoCount - left.videoCount ||
      left.expected.localeCompare(right.expected) ||
      String(left.predicted || "").localeCompare(String(right.predicted || "")) ||
      left.frame.localeCompare(right.frame)
    )
    .slice(0, limit)
    .map((group, index) => ({ rank: index + 1, ...group }));
}

const mistakes = rows.filter((row) => !row.correct && row.predicted);
const misses = rows.filter((row) => !row.correct && !row.predicted);
const metadata = {
  generatedAt: new Date().toISOString(),
  source: path.relative(root, input),
  grouping: "expected word + three-token local frame; mistakes also include predicted word",
  metrics: report.summary
};
const outputs = [
  [`paired-rules-top-${mistakeLimit}-mistakes.json`, {
    ...metadata,
    definition: "Wrong committed rule predictions",
    totalOccurrences: mistakes.length,
    groups: rank(mistakes, mistakeLimit, true)
  }],
  [`paired-rules-top-${missLimit}-misses.json`, {
    ...metadata,
    definition: "Scored slots where rules abstained",
    totalOccurrences: misses.length,
    groups: rank(misses, missLimit, false)
  }]
];

fs.mkdirSync(outputDir, { recursive: true });
for (const [name, payload] of outputs) {
  const output = path.join(outputDir, name);
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`${output}: ${payload.groups.length} groups from ${payload.totalOccurrences} occurrences`);
}
