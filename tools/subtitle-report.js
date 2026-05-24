const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");

function fixturePath(fileName) {
  if (fs.existsSync(fileName)) {
    return fileName;
  }

  return path.join(__dirname, "..", "tests", "fixtures", fileName);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function eventText(event) {
  return (event.segs || []).map((seg) => seg.utf8 || "").join("");
}

function tokenRanges(text) {
  const tokenRegex = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
  const ranges = [];
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length
    });
  }

  return ranges;
}

function sentenceRange(text, tokenStart, tokenEnd) {
  let start = tokenStart;
  let end = tokenEnd;

  while (start > 0 && !/[.!?\n]/.test(text.charAt(start - 1))) {
    start -= 1;
  }

  while (end < text.length && !/[.!?\n]/.test(text.charAt(end))) {
    end += 1;
  }

  if (end < text.length && /[.!?]/.test(text.charAt(end))) {
    end += 1;
  }

  return {
    start,
    end
  };
}

function cleanSentence(text) {
  const sentence = rules.normalizeCensoredTokens(text)
    .replace(/\[(?!\s*__\s*\])[^\]\n]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!sentence) {
    return "";
  }

  const capitalized = sentence.charAt(0).toUpperCase() + sentence.slice(1);

  return /[.!?]$/.test(capitalized) ? capitalized : capitalized + ".";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const replacementWordRegex = new RegExp(
  "\\b(" + rules.ALLOWED_WORDS.map(escapeRegExp).join("|") + ")\\b",
  "gi"
);

function coveringReplacement(replacementsByToken, tokenIndex) {
  for (const replacement of replacementsByToken.values()) {
    const tokenSpan = replacement.tokenSpan || 1;

    if (tokenIndex > replacement.tokenIndex && tokenIndex < replacement.tokenIndex + tokenSpan) {
      return replacement;
    }
  }

  return null;
}

function patchedSentence(sentence, firstTokenIndex, replacementsByToken) {
  const tokenRegex = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
  let localTokenIndex = 0;

  return cleanSentence(sentence.replace(tokenRegex, (token) => {
    const tokenIndex = firstTokenIndex + localTokenIndex;
    const replacement = replacementsByToken.get(tokenIndex);
    const coveredReplacement = coveringReplacement(replacementsByToken, tokenIndex);
    localTokenIndex += 1;

    if (coveredReplacement) {
      return "";
    }

    return replacement ? replacement.displayWord : token;
  })).replace(replacementWordRegex, "[$&]");
}

const inputPath = fixturePath(process.argv[2] || "example.json");
const payload = readJson(inputPath);
const fullText = payload.events.map(eventText).join("\n");
const normalizedText = rules.normalizeCensoredTokens(fullText);
const result = rules.applyDeterministicRules(fullText);
const replacementsByToken = new Map(
  result.replacements.map((replacement) => [replacement.tokenIndex, replacement])
);
const ranges = tokenRanges(normalizedText);
const sentenceCounts = new Map();

let replacedCount = 0;

ranges.forEach((range, index) => {
  const replacement = replacementsByToken.get(index);
  const coveredReplacement = coveringReplacement(replacementsByToken, index);
  const rangeForSentence = sentenceRange(normalizedText, range.start, range.end);
  const sentenceText = normalizedText.slice(rangeForSentence.start, rangeForSentence.end);
  const firstTokenIndex = ranges.findIndex((candidate) => candidate.start >= rangeForSentence.start);

  if (replacement || coveredReplacement) {
    replacedCount += 1;
  }

  const sentence = patchedSentence(sentenceText, firstTokenIndex, replacementsByToken);
  sentenceCounts.set(sentence, (sentenceCounts.get(sentence) || 0) + 1);
});

Array.from(sentenceCounts.entries())
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .forEach(([sentence, count], index) => {
    console.log(`${String(index + 1).padStart(3, "0")} | ${sentence} | x${count}`);
  });

console.log("");
console.log(`file: ${inputPath}`);
console.log(`tokens: ${ranges.length}`);
console.log(`replaced: ${replacedCount}`);
console.log(`not replaced: ${ranges.length - replacedCount}`);
