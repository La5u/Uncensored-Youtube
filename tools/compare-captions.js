const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");

function fixturePath(fileName) {
  if (fs.existsSync(fileName)) {
    return fileName;
  }

  return path.join(__dirname, "..", "tests", "fixtures", fileName);
}

const censoredPath = fixturePath(process.argv[2] || "mov_censored.json");
const uncensoredPath = fixturePath(process.argv[3] || "mov.json");
const WINDOW_BEFORE_MS = 1800;
const WINDOW_AFTER_MS = 2600;

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

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

function tokenTimes(event) {
  const times = [];

  (event.segs || []).forEach((seg) => {
    if (!seg || typeof seg.utf8 !== "string" || !rules.hasCensoredToken(seg.utf8)) {
      return;
    }

    for (let index = 0; index < countCensoredTokens(seg.utf8); index += 1) {
      times.push((event.tStartMs || 0) + (seg.tOffsetMs || 0));
    }
  });

  return times;
}

function eventEnd(event) {
  return (event.tStartMs || 0) + (event.dDurationMs || 0);
}

function windowText(events, timestampMs) {
  const start = timestampMs - WINDOW_BEFORE_MS;
  const end = timestampMs + WINDOW_AFTER_MS;

  return events
    .filter((event) => eventEnd(event) >= start && (event.tStartMs || 0) <= end)
    .map(eventText)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWord(text, word) {
  const pattern = word
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/'/g, "['’]");

  return new RegExp("(^|[^a-z0-9_])" + pattern + "($|[^a-z0-9_])", "i").test(text);
}

function replacementStatus(replacement, actualText) {
  if (!replacement) {
    const allowedHits = rules.ALLOWED_WORDS.filter((word) => containsWord(actualText, word));
    return {
      status: allowedHits.length ? "missed-censored-word" : "not-replaced",
      actualHit: allowedHits.join("/")
    };
  }

  const candidates = replacement.rule.candidates;
  const actualCandidate = candidates.find((candidate) => containsWord(actualText, candidate));

  if (!actualCandidate) {
    return {
      status: "wrong-or-not-in-window",
      actualHit: ""
    };
  }

  return {
    status: actualCandidate === candidates[0] ? "primary-match" : "alternative-match",
    actualHit: actualCandidate
  };
}

const censoredPayload = readJson(censoredPath);
const uncensoredPayload = readJson(uncensoredPath);
const censoredEventTexts = censoredPayload.events.map(eventText);
const fullCensoredText = censoredEventTexts.join("\n");
const result = rules.applyDeterministicRules(fullCensoredText);
const replacementsByToken = new Map(
  result.replacements.map((replacement) => [replacement.tokenIndex, replacement])
);
const contexts = tokenContexts(fullCensoredText);
const rows = [];
let tokenOffset = 0;

censoredPayload.events.forEach((event, eventIndex) => {
  const originalText = censoredEventTexts[eventIndex];
  const eventTokenCount = countCensoredTokens(originalText);

  if (!eventTokenCount) {
    return;
  }

  const times = tokenTimes(event);

  for (let localTokenIndex = 0; localTokenIndex < eventTokenCount; localTokenIndex += 1) {
    const tokenIndex = tokenOffset + localTokenIndex;
    const replacement = replacementsByToken.get(tokenIndex);
    const actualText = windowText(uncensoredPayload.events, times[localTokenIndex] || event.tStartMs || 0);
    const status = replacementStatus(replacement, actualText);

    rows.push({
      eventIndex,
      localTokenIndex,
      time: times[localTokenIndex] || event.tStartMs || 0,
      context: contexts[tokenIndex],
      replacement: replacement ? replacement.displayWord : "not replaced",
      rule: replacement ? replacement.rule.template : "",
      status: status.status,
      actualHit: status.actualHit,
      actualText
    });
  }

  tokenOffset += eventTokenCount;
});

const summary = rows.reduce((counts, row) => {
  counts[row.status] = (counts[row.status] || 0) + 1;
  return counts;
}, {});

console.log(`censored: ${censoredPath}`);
console.log(`uncensored: ${uncensoredPath}`);
console.log(`tokens: ${rows.length}`);
Object.keys(summary).sort().forEach((status) => {
  console.log(`${status}: ${summary[status]}`);
});

console.log("\nReplaced tokens:");
rows.filter((row) => row.replacement !== "not replaced").forEach((row, index) => {
  console.log(
    `${String(index + 1).padStart(3, "0")} ${row.status} event ${row.eventIndex} @${row.time} | ${row.context} | ${row.replacement} | rule: ${row.rule} | actual: ${row.actualHit || row.actualText}`
  );
});

console.log("\nMissed tokens with allowed uncensored word in timing window:");
rows.filter((row) => row.status === "missed-censored-word").forEach((row, index) => {
  console.log(
    `${String(index + 1).padStart(3, "0")} event ${row.eventIndex} @${row.time} | ${row.context} | actual: ${row.actualHit} | ${row.actualText}`
  );
});
