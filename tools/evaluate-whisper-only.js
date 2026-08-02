const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const rules = require("../src/rules");
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
    before: "1.5",
    after: "1.5",
    limit: "0",
    names: "",
    allowUnscored: "false",
    skipMissing: "false",
    discoverPaired: "false",
    discoverUnpaired: "false",
    rulesScoring: "strict",
    unpairedMinBlanks: "0",
    checkpointEvery: "25"
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

  args.before = Number(args.before);
  args.after = Number(args.after);
  args.limit = Number(args.limit);
  args.unpairedMinBlanks = Number(args.unpairedMinBlanks);
  args.checkpointEvery = Number(args.checkpointEvery);
  if (![args.before, args.after].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("--before and --after must be non-negative numbers.");
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
  const candidates = [
    path.join(root, "node_modules/@huggingface/transformers/dist/transformers.node.mjs"),
    "/tmp/uncensored-transformers/node_modules/@huggingface/transformers/dist/transformers.node.mjs"
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return import(candidate);
    }
  }

  throw new Error("Missing @huggingface/transformers. Install it in node_modules or /tmp/uncensored-transformers.");
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

async function evaluateFixture(args, fixture, getTranscriber, cachedResults) {
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
  const tokens = timedText.collectTimedTextTokens(body, args.mode !== "whisper-only");
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
  const results = [];

  for (const token of selectedTokens) {
    const deterministic = args.mode === "rules-only"
      ? Boolean(token.deterministicWord)
      : args.mode === "rules+whisper" && token.deterministicWord && !token.deterministicAmbiguous;
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
        const pcm = pcmSlice(audio, token.timeSeconds - args.before, args.before + args.after);
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
    }
    const expected = expectedByToken.has(token.tokenIndex) ? [expectedByToken.get(token.tokenIndex)] : [];
    const candidateWords = args.mode === "rules-only" ? token.deterministicCandidates : [];
    const anyCandidate = args.rulesScoring === "any-candidate";
    const attempted = anyCandidate ? candidateWords.length > 0 : Boolean(chosen.word);
    const correct = anyCandidate
      ? candidateWords.some((word) => isCorrect(word, expected, token.context))
      : isCorrect(chosen.word, expected, token.context);
    const result = {
      tokenIndex: token.tokenIndex,
      timeSeconds: token.timeSeconds,
      context: token.context,
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
    results
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
  let transcriberPromise = null;
  const getTranscriber = () => {
    if (args.mode === "rules-only") return Promise.resolve(null);
    if (!transcriberPromise) transcriberPromise = createTranscriber();
    return transcriberPromise;
  };
  const fixtures = [];
  const outputPath = resolvePath(args.output);

  for (const [fixtureIndex, fixture] of manifest.entries()) {
    console.error(`Evaluating ${fixture.name}...`);
    fixtures.push(await evaluateFixture(args, fixture, getTranscriber, cachedByFixture.get(fixture.name)));
    if (args.checkpointEvery > 0 && (fixtureIndex + 1) % args.checkpointEvery === 0) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify({
        mode: args.mode,
        rulesScoring: args.rulesScoring,
        before: args.before,
        after: args.after,
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
    summary: summarize(fixtures),
    fixtures
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: args.output,
    fixtures: fixtures.map((fixture) => ({
      name: fixture.name,
      skipped: fixture.skipped,
      tokenCount: fixture.tokenCount || 0,
      evaluatedCount: fixture.evaluatedCount || 0,
      scoredCount: fixture.scoredCount || 0,
      reviewRecommended: Boolean(fixture.reviewRecommended),
      manualCensoredCount: fixture.manualCensoredCount || 0,
      acceptedCount: fixture.acceptedCount || 0,
      correctCount: fixture.correctCount || 0,
      reason: fixture.reason || ""
    }))
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
  expectedWords,
  allowedExpectedWords,
  findAudio,
  isCorrect,
  classifyResult,
  summarize
};
