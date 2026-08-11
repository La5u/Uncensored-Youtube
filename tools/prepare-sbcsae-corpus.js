#!/usr/bin/env node
// Convert TalkBank's CHAT transcripts into the JSONL contract used by the
// rule miner. The source data stays local/ignored; this small adapter is the
// reproducible transformation from .cha turns to original/censored pairs.
"use strict";

const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");

const allowedWords = rules.ALLOWED_WORDS.slice().sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['\\u2019]"))
  .join("|");
const SWEAR_REGEX = new RegExp(
  "(^|[^A-Za-z0-9_])([\\p{P}\\p{S}]*)(" + allowedWords +
  ")([\\p{P}\\p{S}]*)(?=$|[^A-Za-z0-9_])", "giu");

const root = path.join(__dirname, "..");
const inputDir = path.resolve(root, process.argv[2] || "corpus/santa-barbara/SBCSAE");
const outputDir = path.resolve(root, process.argv[3] || "corpus/generated/sbcsae-conversation");
const outputPath = path.join(outputDir, "sbcsae-samples.jsonl");
const reportPath = path.join(outputDir, "sbcsae-report.json");
const MIN_WORDS = 2;
const MAX_CHARS = 280;

function cleanChat(text) {
  return String(text)
    .replace(/\x15[^\x15]*\x15/g, " ")
    .replace(/&[{}][^\s]+/g, " ")
    .replace(/&=[^\s]+/g, " ")
    .replace(/\[%[^\]]*\]/g, " ")
    .replace(/[⌈⌉⌊⌋]\d*/gu, " ")
    .replace(/<([^>]+)>/gu, " $1 ")
    .replace(/\((?:\.{1,3}|[ʔh]+|[a-z]+)\)/giu, " ")
    .replace(/\+(?:\/\.|\.\.\.|\/)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function censor(text) {
  return text.replace(SWEAR_REGEX, (match, before, leftPunct, word, rightPunct) =>
    `${before}${leftPunct}[__]${rightPunct}`);
}

function expectedCount(text) {
  let count = 0;
  text.replace(SWEAR_REGEX, () => { count += 1; return ""; });
  return count;
}

function words(text) {
  return (text.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g) || []).length;
}

if (!fs.existsSync(inputDir)) throw new Error(`Missing transcript directory: ${inputDir}`);
const files = fs.readdirSync(inputDir).filter((name) => name.endsWith(".cha")).sort();
if (!files.length) throw new Error(`No .cha files found under ${inputDir}`);

fs.mkdirSync(outputDir, { recursive: true });
const rows = [];
const counts = Object.fromEntries(rules.ALLOWED_WORDS.map((word) => [word, 0]));
let linesRead = 0;
for (const file of files) {
  const body = fs.readFileSync(path.join(inputDir, file), "utf8");
  for (const line of body.split(/\r?\n/)) {
    linesRead += 1;
    if (!line.trim() || line.startsWith("@") || line.startsWith("%")) continue;
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const original = cleanChat(line.slice(separator + 1));
    if (original.length > MAX_CHARS || words(original) < MIN_WORDS) continue;
    const censored = censor(original);
    const tokenCount = expectedCount(original);
    if (!tokenCount) continue;
    original.replace(SWEAR_REGEX, (match, before, leftPunct, word) => {
      const key = word.toLowerCase().replace(/\u2019/g, "'");
      if (key in counts) counts[key] += 1;
      return match;
    });
    rows.push({ original, censored, source: file });
  }
}

fs.writeFileSync(outputPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const report = {
  source: "Santa Barbara Corpus of Spoken American English (SBCSAE), TalkBank",
  sourceUrl: "https://talkbank.org/ca/access/SBCSAE.html",
  license: "Creative Commons Attribution-NoDerivatives 3.0 United States (CC BY-ND 3.0 US); follow TalkBank citation/use rules",
  licenseCaveat: "Outputs remain ignored/local: CC BY-ND permits analysis, but redistribution of adapted/censored text may be restricted; consult TalkBank terms before sharing.",
  inputDir: path.relative(root, inputDir),
  files,
  linesRead,
  rows: rows.length,
  profanityTokens: Object.values(counts).reduce((total, count) => total + count, 0),
  profanityByWord: counts,
  minWords: MIN_WORDS,
  maxChars: MAX_CHARS,
  output: path.relative(root, outputPath)
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
