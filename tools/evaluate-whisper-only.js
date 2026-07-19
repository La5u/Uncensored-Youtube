const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const rules = require("../src/rules");
const timedText = require("../src/timedtext");
const decision = require("../src/whisper-local");
const { align, manualSwearEvents } = require("./evaluate-youtube-rules");

const root = path.join(__dirname, "..");

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
    allowUnscored: "false"
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) {
      args[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }

  args.before = Number(args.before);
  args.after = Number(args.after);
  args.limit = Number(args.limit);
  args.names = new Set(args.names.split(",").filter(Boolean));
  args.allowUnscored = args.allowUnscored === "true";
  if (!["whisper-only", "rules-only", "rules+whisper"].includes(args.mode)) {
    throw new Error("--mode must be whisper-only, rules-only, or rules+whisper.");
  }
  return args;
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

function findAudio(audioDir, fixture) {
  const dir = path.join(root, audioDir);

  if (!fs.existsSync(dir)) {
    return "";
  }

  const file = fs.readdirSync(dir).find((name) => (
    name.startsWith(`${fixture.name}.`) && /\.(webm|m4a|opus|mp3|wav)$/i.test(name)
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

function isCorrect(word, expected) {
  const normalized = decision.normalizeText(word);

  return expected.some((candidate) => decision.normalizeText(candidate) === normalized);
}

async function evaluateFixture(args, fixture, transcriber, cachedResults) {
  const censoredPath = path.join(root, args.fixtures, fixture.censored);
  const uncensoredPath = fixture.uncensored && path.join(root, args.fixtures, fixture.uncensored);
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
  const manual = uncensoredPath && fs.existsSync(uncensoredPath)
    ? JSON.parse(fs.readFileSync(uncensoredPath, "utf8"))
    : null;
  const expectedByToken = manual
    ? align(tokens, manualSwearEvents(manual), fixture.expectedByToken).expected
    : new Map();
  const selectedTokens = args.limit > 0 ? tokens.slice(0, args.limit) : tokens;
  const results = [];

  for (const token of selectedTokens) {
    const deterministic = args.mode === "rules-only"
      ? Boolean(token.deterministicWord)
      : args.mode === "rules+whisper" && token.deterministicWord && token.deterministicCandidates.length <= 1;
    let transcript = "";
    let chosen = { word: token.deterministicWord, evidence: "deterministic" };
    if (!deterministic && args.mode !== "rules-only") {
      const cached = cachedResults && cachedResults.get(token.tokenIndex);
      if (cached) {
        transcript = cached.transcript;
      } else {
        if (!transcriber) throw new Error(`Missing cached transcript for ${fixture.name}:${token.tokenIndex}.`);
        const pcm = pcmSlice(audio, token.timeSeconds - args.before, args.before + args.after);
        const transcription = await transcriber(pcm);
        transcript = typeof transcription === "string" ? transcription : transcription.text;
      }
      chosen = decision.decisionFromTranscript(transcript, token.candidates, token.context, {
        fCandidates: token.fCandidates,
        previousWord: token.previousWord,
        previousWordOffset: token.previousWordOffset
      });
    }
    const expected = expectedByToken.has(token.tokenIndex) ? [expectedByToken.get(token.tokenIndex)] : [];

    results.push({
      tokenIndex: token.tokenIndex,
      timeSeconds: token.timeSeconds,
      context: token.context,
      transcript,
      word: chosen.word,
      source: chosen.evidence,
      expected,
      correct: isCorrect(chosen.word, expected)
    });
  }

  const scored = results.filter((result) => result.expected.length);

  return {
    name: fixture.name,
    skipped: false,
    audio,
    tokenCount: tokens.length,
    evaluatedCount: results.length,
    scoredCount: scored.length,
    acceptedCount: results.filter((result) => result.word).length,
    correctCount: scored.filter((result) => result.correct).length,
    results
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configured = JSON.parse(fs.readFileSync(path.join(root, args.manifest), "utf8"));
  const byName = new Map(configured.map((fixture) => [fixture.name, fixture]));
  fs.readdirSync(path.join(root, args.fixtures))
    .filter((name) => name.endsWith("_auto.en.json3"))
    .forEach((censored) => {
      const name = censored.slice(0, -"_auto.en.json3".length);
      const uncensored = `${name}_manual.en.json3`;
      if (!byName.has(name) && fs.existsSync(path.join(root, args.fixtures, uncensored))) {
        byName.set(name, { name, censored, uncensored });
      }
    });
  const allFixtures = [...byName.values()];
  const manifest = args.names.size
    ? allFixtures.filter((fixture) => args.names.has(fixture.name))
    : allFixtures;

  if (!manifest.length) {
    throw new Error("No fixtures matched --names.");
  }

  const missing = manifest.filter((fixture) => (
    (args.mode !== "rules-only" && !findAudio(args.audioDir, fixture))
    || !fs.existsSync(path.join(root, args.fixtures, fixture.censored))
    || (!args.allowUnscored && (!fixture.uncensored || !fs.existsSync(path.join(root, args.fixtures, fixture.uncensored))))
  ));

  if (missing.length) {
    throw new Error(`Missing fixture files for: ${missing.map((fixture) => fixture.name).join(", ")}. Run tools/download-whisper-fixtures.js first.`);
  }

  const cachedReport = args.transcripts
    ? JSON.parse(fs.readFileSync(path.join(root, args.transcripts), "utf8"))
    : null;
  const cachedByFixture = new Map((cachedReport && cachedReport.fixtures || []).map((fixture) => [
    fixture.name,
    new Map(fixture.results.map((result) => [result.tokenIndex, result]))
  ]));
  const transcriber = cachedReport || args.mode === "rules-only" ? null : await createTranscriber();
  const fixtures = [];

  for (const fixture of manifest) {
    console.error(`Evaluating ${fixture.name}...`);
    fixtures.push(await evaluateFixture(args, fixture, transcriber, cachedByFixture.get(fixture.name)));
  }

  if (!fixtures.some((fixture) => fixture.evaluatedCount)) {
    throw new Error("No censored caption slots were evaluated.");
  }

  const report = {
    mode: args.mode,
    before: args.before,
    after: args.after,
    fixtures
  };

  fs.mkdirSync(path.dirname(path.join(root, args.output)), { recursive: true });
  fs.writeFileSync(path.join(root, args.output), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: args.output,
    fixtures: fixtures.map((fixture) => ({
      name: fixture.name,
      skipped: fixture.skipped,
      tokenCount: fixture.tokenCount || 0,
      evaluatedCount: fixture.evaluatedCount || 0,
      scoredCount: fixture.scoredCount || 0,
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

module.exports = { parseArgs, wordsInText, expectedWords, findAudio };
