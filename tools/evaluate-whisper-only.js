const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const rules = require("../src/rules");
const timedText = require("../src/timedtext");
const decision = require("../src/whisper-local");

const root = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = {
    fixtures: "tests/fixtures",
    audioDir: "tests/fixtures/audio",
    manifest: "tools/whisper-audio-fixtures.json",
    output: "corpus/generated/whisper-only-report.json",
    before: "1.25",
    after: "1.25",
    limit: "0"
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
  return args;
}

function eventText(event) {
  return (event.segs || []).map((seg) => seg.utf8 || "").join("");
}

function eventStart(event) {
  return (typeof event.tStartMs === "number" ? event.tStartMs : 0) / 1000;
}

function eventEnd(event) {
  return eventStart(event) + (typeof event.dDurationMs === "number" ? event.dDurationMs : 0) / 1000;
}

function uncensoredEvents(payload) {
  return (payload.events || [])
    .filter((event) => event && Array.isArray(event.segs))
    .map((event) => ({
      start: eventStart(event),
      end: eventEnd(event),
      text: eventText(event)
    }));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordsInText(text) {
  const normalized = decision.normalizeText(text);

  return rules.ALLOWED_WORDS.filter((word) => (
    new RegExp("(^|\\s)" + escapeRegExp(decision.normalizeText(word)) + "(?=\\s|$)").test(normalized)
  ));
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

function collectTokens(censoredPath) {
  return timedText.collectTimedTextTokens(fs.readFileSync(censoredPath, "utf8"), false);
}

function isCorrect(word, expected) {
  const normalized = decision.normalizeText(word);

  return expected.some((candidate) => decision.normalizeText(candidate) === normalized);
}

async function evaluateFixture(args, fixture, transcriber) {
  const censoredPath = path.join(root, args.fixtures, fixture.censored);
  const uncensoredPath = path.join(root, args.fixtures, fixture.uncensored);
  const audio = findAudio(args.audioDir, fixture);

  if (!audio || !fs.existsSync(censoredPath) || !fs.existsSync(uncensoredPath)) {
    return {
      name: fixture.name,
      skipped: true,
      reason: !audio ? "missing audio" : "missing captions",
      audio
    };
  }

  const tokens = collectTokens(censoredPath);
  const expectedEvents = uncensoredEvents(JSON.parse(fs.readFileSync(uncensoredPath, "utf8")));
  const selectedTokens = args.limit > 0 ? tokens.slice(0, args.limit) : tokens;
  const results = [];

  for (const token of selectedTokens) {
    const pcm = pcmSlice(audio, token.timeSeconds - args.before, args.before + args.after);
    const transcription = await transcriber(pcm);
    const transcript = typeof transcription === "string" ? transcription : transcription.text;
    const chosen = decision.decisionFromTranscript(transcript, token.candidates, token.context, { force: true });
    const expected = expectedWords(expectedEvents, token.timeSeconds, args.before + args.after);

    results.push({
      tokenIndex: token.tokenIndex,
      timeSeconds: token.timeSeconds,
      context: token.context,
      transcript,
      word: chosen.word,
      score: chosen.score,
      runnerUpScore: chosen.runnerUpScore,
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
  const manifest = JSON.parse(fs.readFileSync(path.join(root, args.manifest), "utf8"));
  const transcriber = await createTranscriber();
  const fixtures = [];

  for (const fixture of manifest) {
    console.error(`Evaluating ${fixture.name}...`);
    fixtures.push(await evaluateFixture(args, fixture, transcriber));
  }

  const report = {
    mode: "whisper-only",
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
