const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const rules = require("../src/rules");
const ruleData = require("../src/rules-data");
const timedText = require("../src/timedtext");
const decision = require("../src/whisper-local");
const { align, manualSwearEvents } = require("./evaluation-alignment");

const root = path.join(__dirname, "..");
const resolvePath = (value) => path.resolve(root, value);
const REVIEW_ALIGNMENT_RATE = 0.5;
const ALLOWED_WORD_SET = new Set(rules.ALLOWED_WORDS);

function parseArgs(argv) {
  const args = {
    fixtures: "test-fixtures",
    audioDir: "test-fixtures/audio",
    manifest: "tools/whisper-audio-fixtures.json",
    output: "corpus/generated/whisper-only-report.json",
    mode: "whisper-only",
    transcripts: "",
    shift: "0",
    before: "1.5",
    after: "1.5",
    retryAfter: "2.5",
    limit: "0",
    names: "",
    contextEvents: "4",
    allowUnscored: "false",
    skipMissing: "false",
    discoverPaired: "false",
    discoverUnpaired: "false",
    rulesScoring: "strict",
    unpairedMinBlanks: "0",
    contextWindow: "1,0",
    checkpointEvery: "25",
    reuse: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) {
      const name = argv[index].slice(2);
      if (!(name in args)) throw new Error(`Unknown option --${name}.`);
      if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) {
        throw new Error(`Missing value for --${name}.`);
      }
      args[name] = argv[index + 1];
      index += 1;
    }
  }

  args.shift = Number(args.shift);
  args.before = Number(args.before);
  args.after = Number(args.after);
  args.retryAfter = Number(args.retryAfter);
  args.limit = Number(args.limit);
  args.contextEvents = Number(args.contextEvents);
  args.unpairedMinBlanks = Number(args.unpairedMinBlanks);
  args.checkpointEvery = Number(args.checkpointEvery);
  if (![args.before, args.after, args.retryAfter].every((value) => Number.isFinite(value) && value >= 0) ||
      !Number.isInteger(args.contextEvents) || args.contextEvents < 1 ||
      !Number.isFinite(args.shift)) {
    throw new Error("--before, --after, --retryAfter, and --shift must be numbers; --contextEvents must be a positive integer.");
  }
  if (![args.limit, args.unpairedMinBlanks, args.checkpointEvery]
    .every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error("--limit, --unpairedMinBlanks, and --checkpointEvery must be non-negative integers.");
  }
  args.names = new Set(args.names.split(",").filter(Boolean));
  ["allowUnscored", "skipMissing", "discoverPaired", "discoverUnpaired"].forEach((name) => {
    if (!["true", "false"].includes(args[name])) {
      throw new Error(`--${name} must be true or false.`);
    }
    args[name] = args[name] === "true";
  });
  if (!["whisper-only", "rules-only", "rules+whisper"].includes(args.mode)) {
    throw new Error("--mode must be whisper-only, rules-only, or rules+whisper.");
  }
  if (!["strict", "any-candidate"].includes(args.rulesScoring)) {
    throw new Error("--rulesScoring must be strict or any-candidate.");
  }
  if (args.rulesScoring !== "strict" && args.mode !== "rules-only") {
    throw new Error("--rulesScoring any-candidate requires --mode rules-only.");
  }
  const contextWindow = String(args.contextWindow).split(",").map((value) => Number(value));
  if (contextWindow.length !== 2 ||
      !contextWindow.every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error("--contextWindow must be two non-negative integers like 2,1 (before,after).");
  }
  args.contextBefore = contextWindow[0];
  args.contextAfter = contextWindow[1];
  return args;
}

function discoverUnpaired(fixturesPath, minBlanks) {
  const files = fs.readdirSync(fixturesPath);
  const manualIds = new Set(files
    .filter((name) => name.endsWith("_manual.en.json3"))
    .map((name) => name.slice(0, 11)));
  const seen = new Set();

  return files.filter((name) => name.endsWith("_auto.en.json3"))
    .sort((left, right) => left.length - right.length)
    .flatMap((censored) => {
      const videoId = censored.slice(0, 11);
      if (seen.has(videoId) || manualIds.has(videoId)) return [];
      seen.add(videoId);
      const payload = JSON.parse(fs.readFileSync(path.join(fixturesPath, censored), "utf8"));
      const blanks = (payload.events || []).reduce((count, event) => {
        const text = (event.segs || []).map((segment) => segment.utf8 || "").join("");
        return count + (rules.normalizeCensoredTokens(text).match(rules.CENSORED_TOKEN_REGEX) || []).length;
      }, 0);
      return blanks > minBlanks
        ? [{ name: videoId, videoId, censored, uncensored: "", blanks }]
        : [];
    });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordsInText(text) {
  const normalized = decision.normalizeText(text);
  const words = rules.ALLOWED_WORDS.filter((word) => (
    new RegExp("(^|\\s)" + escapeRegExp(decision.normalizeText(word)) + "(?=\\s|$)").test(normalized)
  ));

  // A few human caption tracks obscure otherwise explicit ground truth.
  if (/\bfuc[#*](?!\w)/iu.test(text)) words.push("fuck");
  if (/\bsh@(?:a|t)(?!\w)/iu.test(text)) words.push("shit");
  return [...new Set(words)];
}

function transcriptContainsWord(transcript, word) {
  const words = decision.normalizeText(transcript).split(" ");
  const normalized = decision.normalizeText(word).split(" ").pop();
  return Boolean(normalized && words.includes(normalized));
}

function expectedWords(events, timeSeconds, windowSeconds) {
  return [...new Set(events
    .filter((event) => event.start <= timeSeconds + windowSeconds && event.end >= timeSeconds - windowSeconds)
    .flatMap((event) => wordsInText(event.text)))];
}

function allowedExpectedWords(expectedByToken) {
  return new Map([...expectedByToken].filter(([, word]) => ALLOWED_WORD_SET.has(word)));
}

function findAudio(audioDir, fixture) {
  const dir = resolvePath(audioDir);
  const id = fixture.videoId || fixture.name;

  if (!fs.existsSync(dir)) {
    return "";
  }

  const file = fs.readdirSync(dir).find((name) => (
    (name.startsWith(`${id}.`) || name.startsWith(`${id}_(`))
    && /\.(webm|m4a|opus|mp3|wav)$/i.test(name)
  ));

  return file ? path.join(dir, file) : "";
}

function pcmSlice(audioPath, startSeconds, durationSeconds) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(Math.max(0, startSeconds)),
    "-t",
    String(durationSeconds),
    "-i",
    audioPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "f32le",
    "pipe:1"
  ], {
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || `ffmpeg exited with ${result.status}`);
  }

  return new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    Math.floor(result.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT)
  ).slice();
}

async function importTransformers() {
  return import(path.join(root,
    "node_modules/@huggingface/transformers/dist/transformers.node.mjs"));
}

async function createTranscriber() {
  const transformers = await importTransformers();
  const { pipeline, env } = transformers;

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = "./src/models/";

  return pipeline("automatic-speech-recognition", "whisper-tiny.en", {
    dtype: "q8",
    device: "cpu"
  });
}

function isCorrect(word, expected, context) {
  if (/\[\s*__\s*\]['’]s\b/i.test(context || "") &&
      expected.some((candidate) => decision.normalizeText(candidate) === "fuck 's")) {
    return decision.normalizeText(word) === "fuck";
  }
  function comparable(value) {
    const normalized = decision.normalizeText(value)
      .replace(/([a-z0-9'])\1{2,}/g, "$1");

    return /\[\s*__\s*\]\s+sake\b/i.test(context || "")
      && ["fuck", "fucks", "fuck 's"].includes(normalized)
      ? "fuck's"
      : normalized;
  }

  const normalizedWord = comparable(word);
  return expected.some((candidate) => {
    const normalizedCandidate = comparable(candidate);
    return normalizedCandidate === normalizedWord ||
      (normalizedWord === "shit" && normalizedCandidate === "dogshit" && /dog\s+\[__\]/iu.test(context)) ||
      (normalizedWord === "shit" && normalizedCandidate === "shitshow" && /\[__\]\s+show/iu.test(context)) ||
      (normalizedWord === "shit" && normalizedCandidate === "shitballs" && /\[__\]\s+balls/iu.test(context)) ||
      (normalizedWord === "fuck" && normalizedCandidate === "clusterfuck" && /cluster\s+\[__\]/iu.test(context));
  });
}

function transcriptHasLiteralExpected(transcript, expected) {
  const literal = ` ${String(transcript || "").toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")} `;

  return expected.some((word) => literal.includes(
    ` ${String(word).toLowerCase().replace(/\u2019/g, "'")} `
  ));
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = previous;
    }
  }
  return row[right.length];
}

function nearExpectedWord(transcript, expected) {
  const transcriptWords = decision.normalizeText(transcript).split(" ").filter(Boolean);
  let best = null;

  expected.forEach((candidate) => {
    const normalized = decision.normalizeText(candidate);
    transcriptWords.forEach((word) => {
      const distance = editDistance(normalized, word);
      if (!best || distance < best.distance) best = { word, expected: candidate, distance };
    });
  });
  return best && best.distance <= (decision.normalizeText(best.expected).length > 5 ? 2 : 1)
    ? best
    : null;
}

function classifyResult(result) {
  if (!result.expected.length) return "unscored";
  if (result.correct) {
    return transcriptHasLiteralExpected(result.transcript, result.expected)
      ? "correct-exact"
      : "correct-normalized-variant";
  }
  if (result.recognizedExpected) return "recognized-wrong-slot";
  if (result.recognizedWords.length) return "different-swear";
  if (nearExpectedWord(result.transcript, result.expected)) return "near-transcription";
  return "missed";
}

async function evaluateFixture(args, fixture, getTranscriber, cachedResults, reusableResults) {
  const fixturesPath = resolvePath(args.fixtures);
  const censoredPath = path.join(fixturesPath, fixture.censored);
  const uncensoredPath = fixture.uncensored && path.join(fixturesPath, fixture.uncensored);
  const audio = findAudio(args.audioDir, fixture);

  if ((args.mode !== "rules-only" && !audio) || !fs.existsSync(censoredPath) || (!args.allowUnscored && (!uncensoredPath || !fs.existsSync(uncensoredPath)))) {
    return {
      name: fixture.name,
      skipped: true,
      reason: args.mode !== "rules-only" && !audio ? "missing audio" : "missing captions",
      audio
    };
  }

  const body = fs.readFileSync(censoredPath, "utf8");
  const timedData = timedText.collectTimedTextData(body, args.mode !== "whisper-only", {
    contextBefore: args.contextBefore,
    contextAfter: args.contextAfter
  });
  const tokens = timedData.tokens;
  const manualBody = uncensoredPath && fs.existsSync(uncensoredPath)
    ? fs.readFileSync(uncensoredPath, "utf8")
    : "";
  const manual = manualBody ? JSON.parse(manualBody) : null;
  const manualCensoredCount = manualBody
    ? timedText.collectTimedTextTokens(manualBody, false).length
    : 0;
  if (manualCensoredCount) {
    return {
      name: fixture.name,
      skipped: true,
      reason: "manual captions contain censored slots",
      audio,
      tokenCount: tokens.length,
      manualCensoredCount
    };
  }
  const manualEvents = manual ? manualSwearEvents(manual) : null;
  const hasConfiguredLabels = Object.keys(fixture.expectedByToken || {}).length > 0;
  if (tokens.length && manualEvents && !hasConfiguredLabels
    && !manualEvents.contextTokens.some((token) => token.label)) {
    return {
      name: fixture.name,
      skipped: true,
      reason: "manual captions contain no ground-truth words",
      audio,
      tokenCount: tokens.length,
      manualCensoredCount
    };
  }
  const expectedByToken = manualEvents
    ? allowedExpectedWords(align(tokens, manualEvents, fixture.expectedByToken).expected)
    : new Map();
  const selectedTokens = args.limit > 0 ? tokens.slice(0, args.limit) : tokens;
  const transcriptByTime = new Map();
  const timelineIndex = new Map(timedData.timeline.map((event, index) => [event.eventIndex, index]));
  const results = [];
  let reusedSlotCount = 0;

  for (const token of selectedTokens) {
    const reviewContext = reviewContextForToken(timedData.timeline, token, args.contextEvents, timelineIndex);
    const candidateWords = args.mode === "rules-only" ? token.deterministicCandidates : [];
    const anyCandidate = args.rulesScoring === "any-candidate";
    const reusable = reusableResults && reusableResults.get(token.tokenIndex);
    if (args.mode === "rules-only" && reusable && reusable.context === token.context &&
        reusable.reviewContext === reviewContext && reusable.word === token.deterministicWord &&
        reusable.ruleTemplate === (token.deterministicRuleTemplate || "") &&
        reusable.ruleTier === (token.deterministicTier || "") &&
        reusable.candidateScoring === anyCandidate &&
        JSON.stringify(reusable.candidates || []) === JSON.stringify(candidateWords)) {
      results.push(reusable);
      reusedSlotCount += 1;
      continue;
    }
    const deterministic = args.mode === "rules-only" ? Boolean(token.deterministicWord) : false;
    let transcript = "";
    let chosen = { word: token.deterministicWord, evidence: "deterministic" };
    if (!deterministic && args.mode !== "rules-only") {
      const cached = cachedResults && cachedResults.get(token.tokenIndex);
      if (cached) {
        transcript = cached.transcript;
      } else if (transcriptByTime.has(token.timeSeconds)) {
        transcript = transcriptByTime.get(token.timeSeconds);
      } else {
        const transcriber = await getTranscriber();
        const pcm = pcmSlice(audio, token.timeSeconds + args.shift - args.before, args.before + args.after);
        const transcription = await transcriber(pcm, { max_new_tokens: 32 });
        transcript = typeof transcription === "string" ? transcription : transcription.text;
        transcriptByTime.set(token.timeSeconds, transcript);
      }
      chosen = decision.decisionFromTranscript(
        transcript,
        token.candidates,
        token.context,
        {
          fCandidates: token.fCandidates,
          previousWord: token.previousWord,
          previousWordOffset: token.previousWordOffset
        }
      );
      if (!chosen.word && args.retryAfter > args.after &&
          transcriptContainsWord(transcript, token.previousWord)) {
        const transcriber = await getTranscriber();
        const retryPcm = pcmSlice(audio, token.timeSeconds + args.shift - args.before,
          args.before + args.retryAfter);
        const retryResult = await transcriber(retryPcm, { max_new_tokens: 32 });
        const retryTranscript = typeof retryResult === "string" ? retryResult : retryResult.text;
        const retryDecision = decision.decisionFromTranscript(
          retryTranscript, token.candidates, token.context, {
            fCandidates: token.fCandidates,
            previousWord: token.previousWord,
            previousWordOffset: token.previousWordOffset
          }
        );
        if (retryDecision.evidence === "transcript-anchor") {
          transcript = retryTranscript;
          chosen = retryDecision;
        }
      }
      if (args.mode === "rules+whisper" && token.deterministicWord &&
          chosen.evidence !== "transcript-anchor") {
        chosen = { word: token.deterministicWord, evidence: "deterministic" };
      }
    }
    const expected = expectedByToken.has(token.tokenIndex) ? [expectedByToken.get(token.tokenIndex)] : [];
    const attempted = anyCandidate ? candidateWords.length > 0 : Boolean(chosen.word);
    const correct = anyCandidate
      ? candidateWords.some((word) => isCorrect(word, expected, token.context))
      : isCorrect(chosen.word, expected, token.context);
    const result = {
      tokenIndex: token.tokenIndex,
      timeSeconds: token.timeSeconds,
      context: token.context,
      reviewContext,
      transcript,
      word: chosen.word,
      candidates: candidateWords,
      attempted,
      candidateScoring: anyCandidate,
      ruleTemplate: token.deterministicRuleTemplate || "",
      ruleTier: token.deterministicTier || "",
      source: chosen.evidence,
      recognizedWords: chosen.words || (chosen.word ? [chosen.word] : []),
      expected,
      correct,
      recognizedExpected: (chosen.words || []).some((word) => isCorrect(word, expected, token.context))
    };
    result.classification = classifyResult(result);
    result.nearTranscription = result.classification === "near-transcription"
      ? nearExpectedWord(transcript, expected)
      : null;
    results.push(result);
  }

  const scored = results.filter((result) => result.expected.length);

  const alignmentRate = results.length ? scored.length / results.length : 0;
  return {
    name: fixture.name,
    skipped: false,
    audio,
    tokenCount: tokens.length,
    evaluatedCount: results.length,
    scoredCount: scored.length,
    unscoredCount: results.length - scored.length,
    alignmentRate,
    reviewRecommended: results.length > 0 && alignmentRate < REVIEW_ALIGNMENT_RATE,
    manualCensoredCount,
    acceptedCount: results.filter((result) => result.word).length,
    attemptedCount: results.filter((result) => result.attempted).length,
    correctCount: scored.filter((result) => result.correct).length,
    reusedSlotCount,
    contentFingerprint: contentFingerprint(`${body}\n${manualBody}`),
    rulesFingerprint: rulesFingerprint(),
    results
  };
}

function reviewContextForToken(timeline, token, radius = 2, timelineIndex) {
  const position = timelineIndex ? timelineIndex.get(token.eventIndex)
    : timeline.findIndex((event) => event.eventIndex === token.eventIndex);
  if (position === undefined || position < 0) return token.context;
  const first = Math.max(0, position - radius);
  const last = Math.min(timeline.length, position + radius + 1);
  return timeline.slice(first, last).map((event) => {
    let relativeIndex = 0;
    return event.text.replace(rules.CENSORED_TOKEN_REGEX, () => {
      const index = event.firstTokenIndex + relativeIndex;
      relativeIndex += 1;
      return index === token.tokenIndex ? rules.CENSORED_TOKEN : "…";
    });
  }).join(" ").replace(/\s+/g, " ").trim();
}

function contentFingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function joinedCaptionText(body) {
  try {
    const payload = JSON.parse(body);
    return (payload.events || []).map((event) =>
      (event.segs || []).map((seg) => seg.utf8 || "").join("")
    ).join(" ");
  } catch {
    return "";
  }
}

function rulesFingerprint() {
  const seed = `${rules.DETERMINISTIC_RULES.length}:${rules.RULE_WORDS.length}`;
  let hash = 0x811c9dc5;
  for (const rule of rules.DETERMINISTIC_RULES) {
    const value = `${rule.template}|${rule.candidates.join(",")}|`;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${seed}:${(hash >>> 0).toString(36)}`;
}

function auxiliaryRulesFingerprint() {
  return contentFingerprint(JSON.stringify({
    frames: ruleData.RULE_GROUPS.frames,
    priors: ruleData.CANDIDATE_PRIORS,
    continuing: ruleData.CONTINUING_PREFIX_SETS,
    allowed: ruleData.ALLOWED_WORDS,
    ruleWords: ruleData.RULE_WORDS
  }));
}

function rulesEngineFingerprint() {
  return contentFingerprint(["rules.js", "rules-compiler.js"].map((name) =>
    fs.readFileSync(path.join(root, "src", name), "utf8")).join("\n"));
}

function ruleSignature() {
  return rules.DETERMINISTIC_RULES.map((rule) => ({
    template: rule.template,
    candidates: rule.candidates
  }));
}

function changedRuleTemplates(previous, current) {
  const previousMap = new Map(previous.map((rule) => [rule.template, rule.candidates]));
  const currentMap = new Map(current.map((rule) => [rule.template, rule.candidates]));
  const changed = new Set();
  const sameCandidates = (left, right) => left && right && left.length === right.length &&
    left.every((candidate, index) => candidate === right[index]);

  current.forEach((rule) => {
    const before = previousMap.get(rule.template);
    if (!before || !sameCandidates(before, rule.candidates)) changed.add(rule.template);
  });

  const previousCommon = previous.filter((rule) => currentMap.has(rule.template)).map((rule) => rule.template);
  const currentCommon = current.filter((rule) => previousMap.has(rule.template)).map((rule) => rule.template);
  currentCommon.forEach((template, index) => {
    if (template !== previousCommon[index]) {
      changed.add(template);
      if (previousCommon[index]) changed.add(previousCommon[index]);
    }
  });

  current.forEach((rule) => {
    previousMap.delete(rule.template);
  });
  return {
    changed: [...changed],
    removed: [...previousMap.keys()]
  };
}

function summarize(fixtures) {
  const results = fixtures.flatMap((fixture) => fixture.results || []);
  const scored = results.filter((result) => result.expected.length);
  const attempted = scored.filter((result) => (
    typeof result.attempted === "boolean" ? result.attempted : Boolean(result.word)
  ));
  const correct = scored.filter((result) => result.correct);
  const classifications = {};
  const confusions = {};

  scored.forEach((result) => {
    classifications[result.classification] = (classifications[result.classification] || 0) + 1;
    if (!result.correct) {
      const predicted = result.candidateScoring && result.candidates && result.candidates.length
        ? result.candidates.join("|")
        : result.word || "(none)";
      const key = `${result.expected[0]} <- ${predicted}`;
      confusions[key] = (confusions[key] || 0) + 1;
    }
  });
  return {
    fixtureCount: fixtures.filter((fixture) => !fixture.skipped).length,
    contributingFixtureCount: fixtures.filter((fixture) => (fixture.results || []).length).length,
    skippedFixtureCount: fixtures.filter((fixture) => fixture.skipped).length,
    evaluatedCount: results.length,
    scoredCount: scored.length,
    unscoredCount: results.length - scored.length,
    alignmentRate: results.length ? scored.length / results.length : 0,
    manualCensoredCount: fixtures.reduce((count, fixture) => count + (fixture.manualCensoredCount || 0), 0),
    manualCensoredFixtureCount: fixtures.filter((fixture) => fixture.manualCensoredCount).length,
    reviewFixtureCount: fixtures.filter((fixture) => fixture.reviewRecommended).length,
    reviewUnscoredCount: fixtures.filter((fixture) => fixture.reviewRecommended)
      .reduce((count, fixture) => count + fixture.unscoredCount, 0),
    acceptedCount: results.filter((result) => result.word).length,
    scoredAcceptedCount: scored.filter((result) => result.word).length,
    unscoredAcceptedCount: results.filter((result) => !result.expected.length && result.word).length,
    fillRate: results.length
      ? results.filter((result) => result.word).length / results.length
      : 0,
    attemptedCount: attempted.length,
    correctCount: correct.length,
    precision: attempted.length ? correct.length / attempted.length : 0,
    coverage: scored.length ? correct.length / scored.length : 0,
    accuracy: scored.length ? correct.length / scored.length : 0,
    classifications,
    topConfusions: Object.entries(confusions)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 50)
      .map(([pair, count]) => ({ pair, count }))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturesPath = resolvePath(args.fixtures);
  const configured = JSON.parse(fs.readFileSync(resolvePath(args.manifest), "utf8"));
  const byName = new Map(configured.map((fixture) => [fixture.name, fixture]));
  if (args.discoverPaired) {
    fs.readdirSync(fixturesPath)
      .filter((name) => name.endsWith("_auto.en.json3"))
      .forEach((censored) => {
        const basename = censored.slice(0, -"_auto.en.json3".length);
        const name = basename.slice(0, 11);
        const uncensored = `${basename}_manual.en.json3`;
        if (!byName.has(name) && fs.existsSync(path.join(fixturesPath, uncensored))) {
          byName.set(name, { name, videoId: name, censored, uncensored });
        }
      });
  }
  const allFixtures = args.discoverUnpaired
    ? discoverUnpaired(fixturesPath, args.unpairedMinBlanks)
    : [...byName.values()];
  const manifest = args.names.size
    ? allFixtures.filter((fixture) => args.names.has(fixture.name))
    : allFixtures;

  if (!manifest.length) {
    throw new Error("No fixtures matched --names.");
  }

  const missing = manifest.filter((fixture) => (
    (args.mode !== "rules-only" && !findAudio(args.audioDir, fixture))
    || !fs.existsSync(path.join(fixturesPath, fixture.censored))
    || (!args.allowUnscored && (!fixture.uncensored || !fs.existsSync(path.join(fixturesPath, fixture.uncensored))))
  ));

  if (missing.length && !args.skipMissing) {
    throw new Error(`Missing fixture files for: ${missing.map((fixture) => fixture.name).join(", ")}. Run tools/download-whisper-fixtures.js first.`);
  }

  const cachedReport = args.transcripts
    ? JSON.parse(fs.readFileSync(resolvePath(args.transcripts), "utf8"))
    : null;
  const cachedByFixture = new Map((cachedReport && cachedReport.fixtures || []).map((fixture) => [
    fixture.name,
    new Map((fixture.results || []).map((result) => [result.tokenIndex, result]))
  ]));
  const reuseReport = args.reuse
    ? JSON.parse(fs.readFileSync(resolvePath(args.reuse), "utf8"))
    : null;
  let transcriberPromise = null;
  const getTranscriber = () => {
    if (args.mode === "rules-only") return Promise.resolve(null);
    if (!transcriberPromise) transcriberPromise = createTranscriber();
    return transcriberPromise;
  };
  const fixtures = [];
  const outputPath = resolvePath(args.output);
  const fingerprint = rulesFingerprint();
  const auxiliaryFingerprint = auxiliaryRulesFingerprint();
  const engineFingerprint = rulesEngineFingerprint();
  const signature = ruleSignature();
  const reuseCompatible = reuseReport && reuseReport.mode === args.mode &&
    reuseReport.rulesScoring === args.rulesScoring && reuseReport.before === args.before &&
    reuseReport.after === args.after && reuseReport.retryAfter === args.retryAfter &&
    reuseReport.contextEvents === args.contextEvents &&
    reuseReport.contextBefore === args.contextBefore &&
    reuseReport.contextAfter === args.contextAfter &&
    reuseReport.limit === args.limit && reuseReport.allowUnscored === args.allowUnscored &&
    reuseReport.discoverPaired === args.discoverPaired &&
    reuseReport.discoverUnpaired === args.discoverUnpaired &&
    reuseReport.unpairedMinBlanks === args.unpairedMinBlanks;
  const reusedByName = new Map((reuseCompatible && reuseReport.fixtures || [])
    .map((fixture) => [fixture.name, fixture]));
  const previousSignature = reuseCompatible && reuseReport.ruleSignature || null;
  const auxiliaryUnchanged = reuseCompatible &&
    reuseReport.rulesAuxFingerprint === auxiliaryFingerprint &&
    reuseReport.rulesEngineFingerprint === engineFingerprint;
  const rulesUnchanged = auxiliaryUnchanged && reuseReport.rulesFingerprint === fingerprint;
  const ruleDiff = !rulesUnchanged && previousSignature ? changedRuleTemplates(previousSignature, signature) : { changed: [], removed: [] };
  const canReuseByText = args.mode === "rules-only" && Boolean(previousSignature) &&
    auxiliaryUnchanged && !rulesUnchanged;
  let reusedCount = 0;
  let reusedSlotCount = 0;

  function fixtureBody(fixture) {
    try {
      return fs.readFileSync(path.join(fixturesPath, fixture.censored), "utf8");
    } catch {
      return "";
    }
  }

  function fixtureFingerprint(fixture, censoredBody) {
    try {
      const censored = censoredBody === undefined ? fixtureBody(fixture) : censoredBody;
      const uncensored = fixture.uncensored
        ? fs.readFileSync(path.join(fixturesPath, fixture.uncensored), "utf8")
        : "";
      return contentFingerprint(`${censored}\n${uncensored}`);
    } catch {
      return "";
    }
  }

  for (const [fixtureIndex, fixture] of manifest.entries()) {
    const cached = reusedByName.get(fixture.name);
    let reusable = false;
    let cachedResults = null;
    if (cached && cached.results) {
      const body = fixtureBody(fixture);
      const sameContent = cached.contentFingerprint && cached.contentFingerprint === fixtureFingerprint(fixture, body);
      if (sameContent) cachedResults = new Map(cached.results.map((result) => [result.tokenIndex, result]));
      if (sameContent && rulesUnchanged &&
          cached.results.every((result) => result.reviewContext)) {
        reusable = true;
      } else if (sameContent && canReuseByText) {
        const text = joinedCaptionText(body);
        const firedRemoved = cached.results.some((result) => ruleDiff.removed.includes(result.ruleTemplate));
        const matchesChanged = rules.templatesMatch(ruleDiff.changed, text);
        reusable = !firedRemoved && !matchesChanged &&
          cached.results.every((result) => result.reviewContext);
      }
    }
    if (reusable) {
      reusedCount += 1;
      reusedSlotCount += cached.results.length;
      fixtures.push({ ...cached, rulesFingerprint: fingerprint,
        reusedSlotCount: cached.results.length });
    } else {
      if (fixtureIndex % 50 === 0) {
        console.error(`Evaluating ${fixtureIndex + 1}/${manifest.length}...`);
      }
      const evaluated = await evaluateFixture(
        args, fixture, getTranscriber, cachedByFixture.get(fixture.name), cachedResults
      );
      reusedSlotCount += evaluated.reusedSlotCount || 0;
      fixtures.push(evaluated);
    }
    if (args.checkpointEvery > 0 && (fixtureIndex + 1) % args.checkpointEvery === 0) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify({
        mode: args.mode,
        rulesScoring: args.rulesScoring,
        before: args.before,
        after: args.after,
        retryAfter: args.retryAfter,
        contextEvents: args.contextEvents,
        contextBefore: args.contextBefore,
        contextAfter: args.contextAfter,
        limit: args.limit,
        allowUnscored: args.allowUnscored,
        discoverPaired: args.discoverPaired,
        discoverUnpaired: args.discoverUnpaired,
        unpairedMinBlanks: args.unpairedMinBlanks,
        rulesFingerprint: fingerprint,
        rulesAuxFingerprint: auxiliaryFingerprint,
        rulesEngineFingerprint: engineFingerprint,
        ruleSignature: signature,
        reusedCount,
        reusedSlotCount,
        summary: summarize(fixtures),
        fixtures
      }, null, 2)}\n`);
    }
  }

  if (!fixtures.some((fixture) => fixture.evaluatedCount)) {
    throw new Error("No censored caption slots were evaluated.");
  }

  const report = {
    mode: args.mode,
    rulesScoring: args.rulesScoring,
    before: args.before,
    after: args.after,
    retryAfter: args.retryAfter,
    contextEvents: args.contextEvents,
    contextBefore: args.contextBefore,
    contextAfter: args.contextAfter,
    limit: args.limit,
    allowUnscored: args.allowUnscored,
    discoverPaired: args.discoverPaired,
    discoverUnpaired: args.discoverUnpaired,
    unpairedMinBlanks: args.unpairedMinBlanks,
    complete: true,
    rulesFingerprint: fingerprint,
    rulesAuxFingerprint: auxiliaryFingerprint,
    rulesEngineFingerprint: engineFingerprint,
    ruleSignature: signature,
    reusedCount,
    reusedSlotCount,
    summary: summarize(fixtures),
    fixtures
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: args.output,
    reusedFixtures: reusedCount,
    reusedSlots: reusedSlotCount,
    summary: report.summary
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  discoverUnpaired,
  wordsInText,
  transcriptContainsWord,
  expectedWords,
  allowedExpectedWords,
  findAudio,
  isCorrect,
  classifyResult,
  summarize,
  changedRuleTemplates,
  contentFingerprint,
  auxiliaryRulesFingerprint,
  reviewContextForToken,
  rulesEngineFingerprint,
  rulesFingerprint
};
