const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");

function fixturePath(fileName) {
  if (fs.existsSync(fileName)) {
    return fileName;
  }

  return path.join(__dirname, "fixtures", fileName);
}

const inputPath = fixturePath(process.argv[2] || "example.json");
const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));

function eventText(event) {
  return (event.segs || []).map((seg) => seg.utf8 || "").join("");
}

function countCensoredTokens(text) {
  const tokenRegex = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
  const matches = text.match(tokenRegex);

  return matches ? matches.length : 0;
}

function words(value) {
  return rules.normalizeCensoredTokens(value)
    .replace(/[“”"]/g, "")
    .match(/[A-Za-z]+(?:['’][A-Za-z]+)?|\[__\]/g) || [];
}

function tokenContexts(value) {
  const allWords = words(value);
  const contexts = [];

  allWords.forEach((word, index) => {
    if (word !== rules.CENSORED_TOKEN) {
      return;
    }

    const before = allWords.slice(Math.max(0, index - 2), index).join(" ");
    const after = allWords.slice(index + 1, index + 3).join(" ");

    contexts.push(`${before} [__] ${after}`.trim());
  });

  return contexts;
}

let tokenCount = 0;
let replacementCount = 0;
const eventTexts = payload.events.map(eventText);
const fullText = eventTexts.join("\n");
const result = rules.applyDeterministicRules(fullText);
const replacementsByToken = new Map(
  result.replacements.map((replacement) => [replacement.tokenIndex, replacement.displayWord])
);
const contexts = tokenContexts(fullText);
let tokenOffset = 0;

payload.events.forEach((event, index) => {
  const originalText = eventTexts[index];
  const eventTokenCount = countCensoredTokens(originalText);

  if (!eventTokenCount) {
    return;
  }

  for (let localTokenIndex = 0; localTokenIndex < eventTokenCount; localTokenIndex += 1) {
    const tokenIndex = tokenOffset + localTokenIndex;
    const replacement = replacementsByToken.get(tokenIndex) || "not replaced";

    tokenCount += 1;
    if (replacement !== "not replaced") {
      replacementCount += 1;
    }

    console.log(
      `${String(tokenCount).padStart(3, "0")} event ${String(index).padStart(4, " ")} #${localTokenIndex + 1} | ${contexts[tokenIndex]} | ${replacement}`
    );
  }

  tokenOffset += eventTokenCount;
});

console.log("");
console.log(`file: ${inputPath}`);
console.log(`tokens: ${tokenCount}`);
console.log(`replaced: ${replacementCount}`);
console.log(`not replaced: ${tokenCount - replacementCount}`);
