const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");
const timedText = require("../src/timedtext");
const { normalizeText } = require("../src/whisper-local");

const root = path.join(__dirname, "..");
const fixturesDir = path.join(root, "test-fixtures");
const manifestPath = path.join(root, "tools/whisper-audio-fixtures.json");
const outputPath = path.join(root, "corpus/generated/youtube-rules-report.json");
const ALIGNMENT_DRIFTS = [1.5, 2, 3];

function eventText(event) {
  return (event.segs || []).map((segment) => segment.utf8 || "").join("");
}

function groundTruthWords(text) {
  const expanded = text
    .replace(/\bf\W*cking\b/giu, "fucking")
    .replace(/\bf\W*ck\b/giu, "fuck")
    .replace(/\bfuc[#*](?!\w)/giu, "fuck")
    .replace(/\bsh@(?:a|t)(?!\w)/giu, "shit")
    .replace(/\bfuckin['’]?(?!\w)/giu, "fucking")
    .replace(/\bmotha\s+fucka+\b/giu, "motherfucker")
    .replaceAll("’", "'");
  const alternatives = [...rules.ALLOWED_WORDS]
    .sort((left, right) => right.length - left.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${alternatives})(?=$|[^A-Za-z0-9_])`, "giu");

  return [...expanded.matchAll(pattern)].map((match) => match[2].toLowerCase());
}

function manualSwearEvents(payload) {
  return (payload.events || []).flatMap((event, eventIndex) => {
    if (!event || !Array.isArray(event.segs)) return [];
    const words = groundTruthWords(eventText(event));
    const start = (event.tStartMs || 0) / 1000;
    const end = start + (event.dDurationMs || 0) / 1000;
    return words.length ? [{ eventIndex, start, end, text: eventText(event), words }] : [];
  });
}

function distanceToEvent(time, event) {
  if (time < event.start) return event.start - time;
  if (time > event.end) return time - event.end;
  return 0;
}

function bestAlignment(tokens, occurrences, maxDrift) {
  const rows = Array.from({ length: tokens.length + 1 }, () => Array(occurrences.length + 1));
  rows[0][0] = { matches: 0, cost: 0, previous: null };
  function keep(row, column, candidate) {
    const current = rows[row][column];
    if (!current || candidate.matches > current.matches
      || (candidate.matches === current.matches && candidate.cost < current.cost)) rows[row][column] = candidate;
  }
  for (let row = 0; row <= tokens.length; row += 1) {
    for (let column = 0; column <= occurrences.length; column += 1) {
      const cell = rows[row][column];
      if (!cell) continue;
      if (row < tokens.length) keep(row + 1, column, { ...cell, previous: [row, column, "token"] });
      if (column < occurrences.length) keep(row, column + 1, { ...cell, previous: [row, column, "word"] });
      if (row < tokens.length && column < occurrences.length
        && distanceToEvent(tokens[row].timeSeconds, occurrences[column]) <= maxDrift) {
        keep(row + 1, column + 1, {
          matches: cell.matches + 1,
          cost: cell.cost + Math.abs(tokens[row].timeSeconds - occurrences[column].proxyTime),
          previous: [row, column, "match"]
        });
      }
    }
  }
  const expected = new Map();
  let row = tokens.length;
  let column = occurrences.length;
  while (rows[row][column].previous) {
    const [previousRow, previousColumn, action] = rows[row][column].previous;
    if (action === "match") expected.set(tokens[previousRow].tokenIndex, occurrences[previousColumn].word);
    row = previousRow;
    column = previousColumn;
  }
  return expected;
}

function align(tokens, manualEvents, expectedByToken) {
  const occurrences = manualEvents.flatMap((event) => event.words.map((word, index) => ({
    ...event,
    word,
    proxyTime: event.start + (event.end - event.start) * (index + 0.5) / event.words.length
  })));
  const alignments = ALIGNMENT_DRIFTS.map((drift) => bestAlignment(tokens, occurrences, drift));
  const expected = new Map([...alignments[0]].filter(([tokenIndex, word]) => (
    alignments.every((alignment) => alignment.get(tokenIndex) === word)
  )));
  Object.entries(expectedByToken || {}).forEach(([tokenIndex, words]) => {
    expected.set(Number(tokenIndex), words[0]);
  });
  return { expected, mismatches: tokens.filter((token) => !expected.has(token.tokenIndex)).map((token) => ({
    tokenIndex: token.tokenIndex,
    timeSeconds: token.timeSeconds,
    context: token.context
  })) };
}

function fixturePairs() {
  return fs.readdirSync(fixturesDir)
    .filter((name) => name.endsWith("_auto.en.json3") || name.endsWith("_auto.en.vtt"))
    .map((auto) => {
      const name = auto.replace(/_auto\.en\.(?:json3|vtt)$/u, "");
      return { name, auto, manual: `${name}_manual.en.json3` };
    })
    .filter((pair) => fs.existsSync(path.join(fixturesDir, pair.manual)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function evaluate(pair, manifestByName) {
  const body = fs.readFileSync(path.join(fixturesDir, pair.auto), "utf8");
  if (pair.auto.endsWith(".vtt")) {
    return { name: pair.name, format: "vtt", tokenCount: (body.match(rules.CENSORED_TOKEN_REGEX) || []).length,
      alignedCount: 0, resolvedCount: 0, correctCount: 0, wrong: [], missed: [], alignmentMismatches: [] };
  }

  const tokens = timedText.collectTimedTextTokens(body, true);
  const autoPayload = JSON.parse(body);
  const analysis = rules.applyDeterministicRules((autoPayload.events || []).map(eventText).join("\n"));
  const ruleByToken = new Map();
  analysis.replacements.forEach((replacement) => {
    for (let offset = 0; offset < (replacement.tokenSpan || 1); offset += 1) {
      ruleByToken.set(replacement.tokenIndex + offset, replacement.rule.template);
    }
  });
  const manual = JSON.parse(fs.readFileSync(path.join(fixturesDir, pair.manual), "utf8"));
  const fixture = manifestByName.get(pair.name) || {};
  const { expected, mismatches } = align(tokens, manualSwearEvents(manual), fixture.expectedByToken);
  const scored = tokens.filter((token) => expected.has(token.tokenIndex));
  const results = scored.map((token) => ({
    tokenIndex: token.tokenIndex,
    timeSeconds: token.timeSeconds,
    context: token.context,
    expected: expected.get(token.tokenIndex),
    word: token.deterministicWord,
    rule: ruleByToken.get(token.tokenIndex) || "",
    correct: normalizeText(token.deterministicWord) === normalizeText(expected.get(token.tokenIndex))
  }));

  return {
    name: pair.name,
    format: "json3",
    tokenCount: tokens.length,
    totalResolvedCount: tokens.filter((token) => token.deterministicWord).length,
    alignedCount: results.length,
    resolvedCount: results.filter((result) => result.word).length,
    correctCount: results.filter((result) => result.correct).length,
    correct: results.filter((result) => result.correct),
    wrong: results.filter((result) => result.word && !result.correct),
    missed: results.filter((result) => !result.word),
    alignmentMismatches: mismatches
  };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestByName = new Map(manifest.map((fixture) => [fixture.name, fixture]));
  const fixtures = fixturePairs().map((pair) => evaluate(pair, manifestByName));
  const summary = {
    fixtureCount: fixtures.length,
    tokenCount: fixtures.reduce((sum, fixture) => sum + fixture.tokenCount, 0),
    totalResolvedCount: fixtures.reduce((sum, fixture) => sum + (fixture.totalResolvedCount || 0), 0),
    alignedCount: fixtures.reduce((sum, fixture) => sum + fixture.alignedCount, 0),
    resolvedCount: fixtures.reduce((sum, fixture) => sum + fixture.resolvedCount, 0),
    correctCount: fixtures.reduce((sum, fixture) => sum + fixture.correctCount, 0),
    wrongCount: fixtures.reduce((sum, fixture) => sum + fixture.wrong.length, 0),
    missedCount: fixtures.reduce((sum, fixture) => sum + fixture.missed.length, 0),
    alignmentMismatchCount: fixtures.reduce((sum, fixture) => sum + fixture.alignmentMismatches.length, 0)
  };
  summary.precision = summary.resolvedCount ? summary.correctCount / summary.resolvedCount : 0;
  summary.coverage = summary.alignedCount ? summary.correctCount / summary.alignedCount : 0;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({ summary, fixtures }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(outputPath);
}

if (require.main === module) main();

module.exports = { align, manualSwearEvents };
