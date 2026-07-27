const rules = require("../src/rules");

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

module.exports = { align, manualSwearEvents };
