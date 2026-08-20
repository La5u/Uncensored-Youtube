const rules = require("../src/rules");

const ALIGNMENT_DRIFTS = [1.5, 2, 3];
const RUNTIME_WORD_SET = new Set(rules.ALLOWED_WORDS);
// Ground truth may contain censored words that runtime deliberately does not
// propose. Keep those labels local to paired-caption evaluation.
const GROUND_TRUTH_WORDS = [...rules.ALLOWED_WORDS, ...rules.NOT_CENSORED_WORDS,
  "nigger", "nigga", "niggas", "retarded", "retard", "faggots", "fuckwit", "fucko", "fuckup",
  "sluts", "slutty", "bitchy", "shitballs", "shitshow", "dogshit", "clusterfuck", "fuckable", "ass", "asses",
  "bastard", "bastards", "piss", "pissed", "pissing", "crap",
  "dick", "shitty", "faggot", "cuck", "cucks", "tranny", "trannies",
  "fuckface", "genderfuck", "niggers", "fags", "midget", "midgets", "shemale",
  "chinaman", "sissy", "hooker", "dickshit", "dickgirl", "chickenshit",
  "clit", "dipshits", "blowjob", "cunty", "spick", "cuntskeleton",
  "shat"];
const GROUND_TRUTH_WORD_SET = new Set(GROUND_TRUTH_WORDS);

function eventText(event) {
  return (event.segs || []).map((segment) => segment.utf8 || "").join("");
}

function normalizedFuck(match, suffix) {
  const ending = String(suffix || "").toLowerCase().replace("’", "'");
  if (ending === "'s") return "fuck's";
  if (ending === "s") return "fucks";
  if (ending === "ed") return "fucked";
  if (ending === "er" || ending === "ers") return `fuck${ending}`;
  return ending ? "fucking" : "fuck";
}

function normalizeGroundTruthText(text) {
  return String(text || "")
    .replace(/\\N/gu, " ")
    .replace(/\bf['’.-]ing\b/giu, "fucking")
    .replace(/\bn[*#_$-]+a(s?)\b/giu, (_, plural) => plural ? "niggas" : "nigga")
    .replace(/\b(?:betch|bish)\b/giu, "bitch")
    .replace(/\bdick\s+head(s?)\b/giu, (_, plural) => plural ? "dickheads" : "dickhead")
    .replace(/\bass\s*fuckery\b/giu, "ass fuckery")
    .replace(/\bmotherf+u+c+k+a+\b/giu, "motherfucker")
    .replace(/\bmotherf(?:u)?c?[*#_$-]+c?k?ing\b/giu, "motherfucking")
    .replace(/\bfatherf(?:u)?c?[*#_$-]+c?k?ing\b/giu, "father fucking")
    .replace(/\bclusterf(?:u)?c?[*#_$-]+c?k?\b/giu, "clusterfuck")
    .replace(/\bgenderf(?:u)?c?[*#_$-]+c?k?\b/giu, "genderfuck")
    .replace(/\bf(?:u)?c?[*#_$-]+c?k?face\b/giu, "fuckface")
    .replace(/\bf(?:u)?c?[*#_$-]+c?k?hole\b/giu, "fuck hole")
    .replace(/\bd(?:i)?[*#_$-]+c?k\b/giu, "dick")
    .replace(/\bp(?:u)?[*#_$-]+(?:ss)?y\b/giu, "pussy")
    .replace(/\btr[*#_$-]+nn(?:y|ies)\b/giu, (match) => match.toLowerCase().endsWith("ies") ? "trannies" : "tranny")
    .replace(/\ba[*#_$-]{3,}e\b/giu, "asshole")
    .replace(/\bwtf\b/giu, "fuck")
    .replace(/\bfook\b/giu, "fuck")
    .replace(/\b(?:fockin|fokicng)\b/giu, "fucking")
    .replace(/\bmotherfuckin['’]?\b/giu, "motherfucking")
    .replace(/\bshittin['’]?\b/giu, "shitting")
    .replace(/\bfux\b/giu, "fucks")
    .replace(/\bcuntskelleton\b/giu, "cuntskeleton")
    .replace(/\bmotha\s*f+u+c+k+a+\b/giu, "motherfucker")
    .replace(/\bmotherf(?:u)?c?[*#_-]+c?k?(?:er)?(?=$|[^A-Za-z0-9_])/giu, "motherfucker")
    .replace(/\bf(?:u)?c?[*#_-]+c?k?(ing|in['’]?|en|ng|g|ed|ers?|s|['’]s)?(?=$|[^A-Za-z0-9_])/giu, normalizedFuck)
    .replace(/\bf+u+c+k+(ing|in['’]?|ed|ers?|s)?\b/giu, normalizedFuck)
    .replace(/\bf+a+[ckq]+\b/giu, "fuck")
    .replace(/\bf+u+k+\b/giu, "fuck")
    .replace(/\bfk['’]?n\b/giu, "fucking")
    .replace(/\bfucken\b/giu, "fucking")
    .replace(/\bsh[*#_-]+t(?:ting|tin['’]?)\b/giu, "shitting")
    .replace(/\bsh[*#_-]+t\b/giu, "shit")
    .replace(/\bs[*#_-]+(?:ing|tin['’]?)\b/giu, "shitting")
    .replace(/\bs[*#_-]+t\b/giu, "shit")
    .replace(/\ba[*#_-]+hole(s)?\b/giu, (_, plural) => plural ? "assholes" : "asshole")
    .replace(/\bp(?:u)?[*#_-]+(?:ss)?(y|ies)\b/giu, (_, suffix) => suffix.toLowerCase() === "ies" ? "pussies" : "pussy")
    .replace(/\bb[*#_-]+(?:tc)?h(es)?\b/giu, (_, plural) => plural ? "bitches" : "bitch")
    .replace(/\bc[*#_-]+nt(s)?\b/giu, (_, plural) => plural ? "cunts" : "cunt")
    .replace(/\bc[*#_-]+ck(s)?\b/giu, (_, plural) => plural ? "cocks" : "cock")
    .replace(/\bbu+l+s(?:h)?[*#_-]+t\b/giu, "bullshit")
    .replace(/\bfuck(boy|ton)\b/giu, "fuck $1")
    .replace(/\bshit(stain|face|bird)\b/giu, "shit $1")
    .replace(/\bs+h+i+e?t+\b/giu, "shit")
    .replace(/\bsht\b/giu, "shit")
    .replace(/\bf\W*cking\b/giu, "fucking")
    .replace(/\bf\W*ck\b/giu, "fuck")
    .replace(/\bfuc[#*](?!\w)/giu, "fuck")
    .replace(/\bsh@(?:a|t)(?!\w)/giu, "shit")
    .replace(/\bfuckin['’]?(?!\w)/giu, "fucking")
    .replace(/\bmotha\s+fucka+\b/giu, "motherfucker")
    .replaceAll("’", "'");
}

function groundTruthWords(text) {
  const expanded = normalizeGroundTruthText(text);
  const alternatives = [...GROUND_TRUTH_WORDS]
    .sort((left, right) => right.length - left.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${alternatives})(?=$|[^A-Za-z0-9_])`, "giu");

  return [...expanded.matchAll(pattern)].map((match) => match[2].toLowerCase());
}

function tokenLabel(value) {
  if (GROUND_TRUTH_WORD_SET.has(value)) return value;
  const apostrophe = value.indexOf("'");
  const root = apostrophe < 0 ? "" : value.slice(0, apostrophe);
  return GROUND_TRUTH_WORD_SET.has(root) ? root : "";
}

function manualSwearEvents(payload, includeEvaluationOnly = false) {
  const contextTokens = [];
  const swearEvents = (payload.events || []).flatMap((event, eventIndex) => {
    if (!event || !Array.isArray(event.segs)) return [];
    const text = eventText(event);
    const tokens = normalizeGroundTruthText(text).toLowerCase()
      .match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
    const start = (event.tStartMs || 0) / 1000;
    const end = start + (event.dDurationMs || 0) / 1000;
    const contextIndexes = [];
    tokens.forEach((value, index) => {
      const label = tokenLabel(value);
      if (label && (includeEvaluationOnly || RUNTIME_WORD_SET.has(label))) {
        contextIndexes.push(contextTokens.length);
      }
      contextTokens.push({
        value,
        label,
        eventIndex,
        start,
        end,
        proxyTime: start + (end - start) * (index + 0.5) / tokens.length
      });
    });
    const words = contextIndexes.map((index) => contextTokens[index].label);
    return words.length ? [{ eventIndex, start, end, text, words, contextIndexes }] : [];
  });
  swearEvents.contextTokens = contextTokens;
  return swearEvents;
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
    if (action === "match") expected.set(tokens[previousRow].tokenIndex, {
      word: occurrences[previousColumn].word,
      occurrenceIndex: previousColumn
    });
    row = previousRow;
    column = previousColumn;
  }
  return expected;
}

function lexicalWords(text) {
  return String(text || "").toLowerCase().replaceAll("’", "'")
    .match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
}

function suffixMatches(left, right) {
  let count = 0;
  while (count < left.length && count < right.length
    && left[left.length - count - 1] === right[right.length - count - 1]) count += 1;
  return count;
}

function prefixMatches(left, right) {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

function lcs(left, right) {
  const row = Array(right.length + 1).fill(0);
  left.forEach((value) => {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const previous = row[index];
      row[index] = value === right[index - 1]
        ? diagonal + 1
        : Math.max(row[index], row[index - 1]);
      diagonal = previous;
    }
  });
  return row[right.length];
}

function contextProposal(token, manualTokens) {
  const parts = String(token.context || "").split(/\[\s*__\s*\]/u);
  const left = lexicalWords(parts[0]).slice(-10);
  const right = lexicalWords(parts[1]).slice(0, 10);
  if (!left.length || !right.length) return null;

  const candidates = manualTokens.flatMap((candidate, index) => {
    const distance = distanceToEvent(token.timeSeconds, candidate);
    if (distance > 10) return [];
    const before = manualTokens.slice(Math.max(0, index - 15), index).map((item) => item.value);
    const after = manualTokens.slice(index + 1, index + 16).map((item) => item.value);
    const leftExact = suffixMatches(left, before);
    const rightExact = prefixMatches(right, after);
    return [{
      ...candidate,
      contextIndex: index,
      leftExact,
      rightExact,
      score: 5 * (leftExact + rightExact) + lcs(left, before) + lcs(right, after)
        + (leftExact && rightExact ? 3 : 0) - distance * 0.05
    }];
  }).sort((leftCandidate, rightCandidate) => rightCandidate.score - leftCandidate.score);
  const best = candidates[0];
  if (!best || !best.label || !best.leftExact || !best.rightExact
    || best.score - (candidates[1] ? candidates[1].score : 0) < 3) return null;
  return best;
}

function trackOffset(tokens, manualTokens) {
  const byNeighbors = new Map();
  for (let index = 1; index + 1 < manualTokens.length; index += 1) {
    const key = `${manualTokens[index - 1].value}\0${manualTokens[index + 1].value}`;
    if (!byNeighbors.has(key)) byNeighbors.set(key, []);
    byNeighbors.get(key).push(index);
  }
  const deltas = tokens.flatMap((token) => {
    const parts = String(token.context || "").split(/\[\s*__\s*\]/u);
    const left = lexicalWords(parts[0]).slice(-10);
    const right = lexicalWords(parts[1]).slice(0, 10);
    if (!left.length || !right.length) return [];
    const candidates = (byNeighbors.get(`${left.at(-1)}\0${right[0]}`) || []).map((index) => ({
      index,
      exact: suffixMatches(left, manualTokens.slice(Math.max(0, index - 10), index).map((item) => item.value))
        + prefixMatches(right, manualTokens.slice(index + 1, index + 11).map((item) => item.value))
    })).sort((a, b) => b.exact - a.exact);
    if (!candidates[0] || candidates[0].exact < 6
      || candidates[1]?.exact === candidates[0].exact) return [];
    return [manualTokens[candidates[0].index].proxyTime - token.timeSeconds];
  });
  if (deltas.length < 3) return null;
  const cluster = deltas.reduce((best, delta) => {
    const current = deltas.filter((value) => Math.abs(value - delta) <= 2);
    return current.length > best.length ? current : best;
  }, []);
  if (cluster.length < 3 || cluster.length * 2 < deltas.length) return null;
  cluster.sort((a, b) => a - b);
  const middle = Math.floor(cluster.length / 2);
  return cluster.length % 2 ? cluster[middle] : (cluster[middle - 1] + cluster[middle]) / 2;
}

function normalizeCompoundLabel(word, context) {
  const text = String(context || "").toLowerCase();
  if (word === "shitballs" && /\[\s*__\s*\]\s+balls\b/u.test(text)) return "shit";
  if (word === "shitshow" && /\[\s*__\s*\]\s+show\b/u.test(text)) return "shit";
  if (word === "dogshit" && /\bdog\s+\[\s*__\s*\]/u.test(text)) return "shit";
  if (word === "chickenshit" && /\bchicken\s+\[\s*__\s*\]/u.test(text)) return "shit";
  if (word === "clusterfuck" && /\bcluster\s+\[\s*__\s*\]/u.test(text)) return "fuck";
  if (word === "fuckface" && /\[\s*__\s*\]\s+face\b/u.test(text)) return "fuck";
  if (word === "motherfucker" && /\bmother\s+\[\s*__\s*\]/u.test(text)) return "fucker";
  return word;
}

function align(tokens, manualEvents, expectedByToken) {
  const manualTokens = manualEvents.contextTokens || [];
  const occurrences = manualEvents.flatMap((event) => event.words.map((word, index) => ({
    ...event,
    word,
    contextIndex: event.contextIndexes ? event.contextIndexes[index] : undefined,
    proxyTime: event.start + (event.end - event.start) * (index + 0.5) / event.words.length
  })));
  const alignments = ALIGNMENT_DRIFTS.map((drift) => bestAlignment(tokens, occurrences, drift));
  const stable = [...alignments[0]].filter(([tokenIndex, match]) => (
    alignments.every((alignment) => alignment.get(tokenIndex)?.word === match.word)
  ));
  const expected = new Map(stable.map(([tokenIndex, match]) => [tokenIndex, match.word]));
  const contextIndexByToken = new Map(stable.map(([tokenIndex, match]) => [
    tokenIndex,
    occurrences[match.occurrenceIndex].contextIndex
  ]));
  const usedOccurrences = new Set(stable.flatMap(([tokenIndex]) => alignments
    .map((alignment) => alignment.get(tokenIndex)?.occurrenceIndex)
    .filter((index) => index !== undefined)
    .map((index) => occurrences[index].contextIndex)
    .filter((index) => index !== undefined)));
  const protectedTokens = new Set(Object.keys(expectedByToken || {}).map(Number));
  Object.entries(expectedByToken || {}).forEach(([tokenIndex, words]) => {
    expected.set(Number(tokenIndex), words[0]);
  });
  // Prefer a unique two-sided lexical match over timing alone. This prevents a
  // visible swear near the blank from being reused as the hidden label.
  const proposals = tokens
    .map((token) => ({ token, proposal: contextProposal(token, manualTokens) }))
    .filter(({ proposal }) => proposal)
    .sort((left, right) => right.proposal.score - left.proposal.score);
  const proposalByToken = new Map(proposals.map(({ token, proposal }) => [token.tokenIndex, proposal]));
  proposals
    .forEach(({ token, proposal }) => {
      const previousIndex = contextIndexByToken.get(token.tokenIndex);
      const displaced = [...contextIndexByToken].find(([tokenIndex, contextIndex]) => (
        tokenIndex !== token.tokenIndex && contextIndex === proposal.contextIndex
      ));
      if (displaced) {
        const [displacedToken] = displaced;
        const displacedProposal = proposalByToken.get(displacedToken);
        if (protectedTokens.has(displacedToken) ||
            displacedProposal?.score >= proposal.score) return;
        expected.delete(displacedToken);
        contextIndexByToken.delete(displacedToken);
      }
      if (usedOccurrences.has(proposal.contextIndex) && previousIndex !== proposal.contextIndex && !displaced) return;
      if (previousIndex !== undefined) usedOccurrences.delete(previousIndex);
      expected.set(token.tokenIndex, proposal.label);
      contextIndexByToken.set(token.tokenIndex, proposal.contextIndex);
      usedOccurrences.add(proposal.contextIndex);
    });
  const offset = trackOffset(tokens, manualTokens);
  if (offset !== null && Math.abs(offset) > 1) {
    const shiftedTokens = tokens.map((token) => ({
      ...token,
      timeSeconds: token.timeSeconds + offset
    }));
    const shifted = ALIGNMENT_DRIFTS.map((drift) => bestAlignment(shiftedTokens, occurrences, drift));
    const stableShifted = [...shifted[0]].filter(([tokenIndex, match]) => shifted.every((alignment) => (
      alignment.get(tokenIndex)?.occurrenceIndex === match.occurrenceIndex
    )));
    const conflicts = stableShifted.some(([tokenIndex, match]) => (
      expected.has(tokenIndex) && expected.get(tokenIndex) !== match.word
    ));
    if (!conflicts) stableShifted.forEach(([tokenIndex, match]) => {
      const occurrence = occurrences[match.occurrenceIndex];
      if (expected.has(tokenIndex) || usedOccurrences.has(occurrence.contextIndex)) return;
      expected.set(tokenIndex, match.word);
      contextIndexByToken.set(tokenIndex, occurrence.contextIndex);
      usedOccurrences.add(occurrence.contextIndex);
    });
  }
  tokens.forEach((token) => {
    const word = expected.get(token.tokenIndex);
    const context = String(token.context || "").toLowerCase();
    const normalized = normalizeCompoundLabel(word, context);
    if (normalized !== word) expected.set(token.tokenIndex, normalized);
    const contextIndex = contextIndexByToken.get(token.tokenIndex);
    const splitAssFuckery = manualTokens[contextIndex]?.value === "ass"
      && manualTokens[contextIndex + 1]?.value === "fuckery";
    if ((word === "fuckery" || splitAssFuckery) && /\bass\s+\[\s*__\s*\]/u.test(context)) expected.set(token.tokenIndex, "fuckery");
  });
  return { expected, mismatches: tokens.filter((token) => !expected.has(token.tokenIndex)).map((token) => ({
    tokenIndex: token.tokenIndex,
    timeSeconds: token.timeSeconds,
    context: token.context
  })) };
}

module.exports = { align, groundTruthWords, manualSwearEvents, normalizeCompoundLabel };
