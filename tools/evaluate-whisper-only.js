const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const rules = require("../src/rules");
const ruleData = require("../src/rules-data");
const timedText = require("../src/timedtext");
const decision = require("../src/whisper-local");
const { align, manualSwearEvents } = require("./evaluation-alignment");
const { buildProvenanceIndex, defaultReports } = require("./audit-caption-corpus");

const root = path.join(__dirname, "..");
const resolvePath = (value) => path.resolve(root, value);
const REVIEW_ALIGNMENT_RATE = 0.5;
const ALLOWED_WORD_SET = new Set(rules.ALLOWED_WORDS);
const CREATOR_SPLITS = new Set(["discovery", "validation", "test"]);
const CANONICAL_CREATOR_ID = /^UC[A-Za-z0-9_-]{22}$/u;

function normalizeFixtureManifest(manifest) {
  return Array.isArray(manifest) ? manifest : manifest?.fixtures;
}

function audioWindowKey({ shift, before, after }) {
  return `shift=${Number(shift)};before=${Number(before)};after=${Number(after)}`;
}

function parseArgs(argv) {
  const args = {
    fixtures: "test-fixtures",
    audioDir: "test-fixtures/audio",
    manifest: "tools/whisper-audio-fixtures.json",
    output: "corpus/generated/whisper-only-report.json",
    mode: "whisper-only",
    transcripts: "",
    shift: "0",
    before: "3",
    after: "1.5",
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
    reuse: "",
    pairClass: "all",
    creatorManifest: "",
    creatorSplit: "all",
    provenanceReports: ""
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
  args.limit = Number(args.limit);
  args.contextEvents = Number(args.contextEvents);
  args.unpairedMinBlanks = Number(args.unpairedMinBlanks);
  args.checkpointEvery = Number(args.checkpointEvery);
  if (![args.before, args.after].every((value) => Number.isFinite(value) && value >= 0) ||
      !Number.isInteger(args.contextEvents) || args.contextEvents < 1 ||
      !Number.isFinite(args.shift)) {
    throw new Error("--before, --after, and --shift must be numbers; --contextEvents must be a positive integer.");
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
  if (!["whisper-only", "rules-only", "rules-first", "rules+whisper"].includes(args.mode)) {
    throw new Error("--mode must be whisper-only, rules-only, rules-first, or rules+whisper.");
  }
  if (!["strict", "any-candidate"].includes(args.rulesScoring)) {
    throw new Error("--rulesScoring must be strict or any-candidate.");
  }
  if (!["all", "manual-auto", "auto-auto", "synthetic", "unknown", "conflict"].includes(args.pairClass)) {
    throw new Error("--pairClass must be all, manual-auto, auto-auto, synthetic, unknown, or conflict.");
  }
  if (!["all", "discovery", "validation", "test"].includes(args.creatorSplit)) {
    throw new Error("--creatorSplit must be all, discovery, validation, or test.");
  }
  if (args.creatorSplit !== "all" && !args.creatorManifest) {
    throw new Error("--creatorSplit requires --creatorManifest.");
  }
  if (args.creatorSplit === "test" && args.pairClass !== "manual-auto") {
    throw new Error("--creatorSplit test requires --pairClass manual-auto.");
  }
  if (args.creatorSplit === "test" && args.skipMissing) {
    throw new Error("Prospective test evaluation cannot use --skipMissing true.");
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
  args.audioWindowKey = audioWindowKey(args);
  return args;
}

function validateTranscriptCacheWindow(report, args) {
  const expected = audioWindowKey(args);
  if (report?.audioWindowKey === expected) return;
  const actual = report?.audioWindowKey || "missing";
  throw new Error(`Transcript cache is incompatible: expected audio window ${expected}, found ${actual}. ` +
    `Regenerate it with --shift ${args.shift} --before ${args.before} --after ${args.after}, ` +
    "or omit --transcripts.");
}

function validateTranscriptCache(report, args, expectedGenerationFingerprint = transcriptGenerationFingerprint()) {
  validateTranscriptCacheWindow(report, args);
  if (report?.complete !== true) {
    throw new Error("Transcript cache is incomplete; use a complete Whisper report or omit --transcripts.");
  }
  if (report.mode !== "whisper-only" && report.mode !== "rules+whisper") {
    throw new Error("Transcript cache must be generated in whisper-only or rules+whisper mode; rules-only caches are not valid.");
  }
  if (!expectedGenerationFingerprint ||
      report.transcriptGenerationFingerprint !== expectedGenerationFingerprint) {
    const actual = report?.transcriptGenerationFingerprint || "missing";
    throw new Error(`Transcript cache is incompatible: expected transcript generation ${expectedGenerationFingerprint}, ` +
      `found ${actual}. Regenerate it or omit --transcripts.`);
  }
}

// A held-out result is only reproducible when the creator assignment itself is
// frozen.  Keep this validation next to the evaluator so an ad-hoc manifest
// cannot silently turn a prospective test run into an in-sample estimate.
function isCanonicalCreatorId(value) {
  return typeof value === "string" && CANONICAL_CREATOR_ID.test(value.trim());
}

function isProspectiveMethod(method) {
  const normalized = method.toLocaleLowerCase();
  return /\b(?:canonical|creator\s+id|channel\s+id|assignment|split)\b/u.test(normalized) &&
    /\b(?:before|prior|pre[- ]?registered|preregistered|blind)\b/u.test(normalized) &&
    /\b(?:caption|label|outcome|content|evaluation|inspection)\b/u.test(normalized);
}

function loadCreatorManifest(file) {
  const raw = fs.readFileSync(file, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.creators) ||
      !manifest.creators.length) {
    throw new Error("Creator manifest must be version 1 with a non-empty creators array.");
  }
  const frozenAt = typeof manifest.frozenAt === "string" ? Date.parse(manifest.frozenAt) : NaN;
  if (!Number.isFinite(frozenAt) || frozenAt > Date.now() ||
      typeof manifest.method !== "string" || !manifest.method.trim()) {
    throw new Error("Creator manifest must declare a valid, non-future frozenAt timestamp and method.");
  }
  if (manifest.prospective === true && !isProspectiveMethod(manifest.method)) {
    throw new Error("Prospective creator manifests need a pre-registered method.");
  }
  if (manifest.prospective === true &&
      (![manifest.minimumCreators, manifest.minimumSlots].every((value) =>
        Number.isInteger(value) && value > 0))) {
    throw new Error("Prospective creator manifests need positive minimumCreators and minimumSlots.");
  }
  const byName = new Map();
  const byId = new Map();
  const names = new Set();
  const ids = new Set();
  manifest.creators.forEach((creator) => {
    if (!creator || typeof creator.name !== "string" || !creator.name.trim() ||
        !CREATOR_SPLITS.has(creator.split)) {
      throw new Error("Each creator manifest entry needs a name and discovery, validation, or test split.");
    }
    const name = creator.name.trim();
    const nameKey = name.toLocaleLowerCase();
    if (names.has(nameKey)) throw new Error(`Duplicate creator manifest name: ${name}.`);
    names.add(nameKey);
    const channelId = typeof creator.channelId === "string" ? creator.channelId.trim() : "";
    if (creator.split === "test" && !isCanonicalCreatorId(channelId)) {
      throw new Error(`Prospective test creator ${name} needs a canonical channelId.`);
    }
    if (channelId && !isCanonicalCreatorId(channelId)) {
      throw new Error(`Creator ${name} has an invalid canonical channelId.`);
    }
    if (channelId && ids.has(channelId)) {
      throw new Error(`Duplicate creator manifest channelId: ${channelId}.`);
    }
    byName.set(name, creator.split);
    if (channelId) {
      ids.add(channelId);
      byId.set(channelId, creator.split);
    }
  });
  if (manifest.prospective === true && !manifest.creators.some((creator) => creator.split === "test")) {
    throw new Error("Prospective creator manifests need a test split.");
  }
  return {
    manifest,
    byName,
    byId,
    fingerprint: contentFingerprint(raw)
  };
}

function creatorSplitForRecord(record, creatorManifest) {
  if (!creatorManifest) return "unknown";
  const creatorId = typeof record.creatorId === "string" ? record.creatorId.trim() : "";
  const creatorName = typeof record.creator === "string" ? record.creator.trim() : "";
  const idSplit = creatorId && creatorManifest.byId.get(creatorId);
  const nameSplit = creatorName && creatorManifest.byName.get(creatorName);
  if (idSplit && nameSplit && idSplit !== nameSplit) return "conflict";
  return idSplit || nameSplit || "unknown";
}

function isProspectiveTestFixture(fixture, creatorManifest) {
  return fixture.pairClass === "manual-auto" &&
    isCanonicalCreatorId(fixture.creatorId) &&
    creatorManifest.byId.get(fixture.creatorId.trim()) === "test" &&
    creatorSplitForRecord(fixture, creatorManifest) === "test";
}

function validateProspectiveSummary(summary, manifest) {
  const minimumCreators = manifest?.minimumCreators;
  const minimumSlots = manifest?.minimumSlots;
  if (![minimumCreators, minimumSlots].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Prospective evaluation needs positive minimumCreators and minimumSlots.");
  }
  const creatorCount = summary?.creatorMacro?.contributingCreatorCount ??
    summary?.creatorMacro?.creatorCount ?? 0;
  const scoredSlots = summary?.scoredCount ?? 0;
  return {
    valid: creatorCount >= minimumCreators && scoredSlots >= minimumSlots,
    creatorCount,
    scoredSlots,
    minimumCreators,
    minimumSlots
  };
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

function contextWordForToken(token) {
  if (token.deterministicWord) return "";
  const result = rules.applyDeterministicRules(token.context);
  return result.replacements?.length === 1 ? result.replacements[0].word : "";
}

// rules+whisper is the popup's "Whisper first"; rules-first leaves unambiguous rule
// fills alone and asks Whisper only about the rest.
function shouldTranscribeToken(token, mode) {
  if (mode === "rules-first") return !token.deterministicWord || Boolean(token.deterministicAmbiguous);
  return mode === "whisper-only" || mode === "rules+whisper";
}

function ruleQualityGate(metric) {
  const support = metric.matchedCount || 0;
  const candidateCount = metric.candidateCount || 1;
  const generalized = /[*…]|<[^>]+>/u.test(metric.template || "");
  let minimumSupport = generalized ? 10 : 4;
  let minimumPrecision = generalized ? 0.92 : support >= 6 ? 0.85 : 0.90;
  const score = candidateCount > 1 ? metric.candidatePrecision : metric.precision;

  if (!generalized && candidateCount === 1 && support >= 6) minimumSupport = 6;

  if (candidateCount >= 4) {
    minimumSupport = Math.max(minimumSupport, 20);
    minimumPrecision = Math.max(minimumPrecision, 0.97);
  } else if (candidateCount === 3) {
    minimumSupport = Math.max(minimumSupport, 10);
    minimumPrecision = Math.max(minimumPrecision, 0.95);
  } else if (candidateCount === 2) {
    minimumSupport = Math.max(minimumSupport, 6);
    minimumPrecision = Math.max(minimumPrecision, 0.92);
  }
  const evidencePassed = support >= minimumSupport && metric.creatorCount >= 2;
  const deterministicMinimumPrecision = candidateCount === 1
    ? minimumPrecision : candidateCount === 2 ? 0.90 : candidateCount === 3 ? 0.95 : 0.97;
  return {
    passed: evidencePassed && score >= minimumPrecision,
    deterministicPassed: evidencePassed && metric.precision >= deterministicMinimumPrecision,
    score,
    minimumSupport,
    minimumPrecision,
    deterministicMinimumPrecision,
    minimumCreators: 2,
    generalized
  };
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

  const asr = await pipeline("automatic-speech-recognition", "whisper-tiny.en", {
    dtype: "q8",
    device: "cpu"
  });
  return { transformers, asr };
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

function classifyResult(result) {
  if (!result.expected.length) return "unscored";
  if (result.correct) return "correct-exact";
  return result.word ? "different-swear" : "missed";
}

// Mirrors audio-capture.js: one 30 s Whisper window per run of upcoming slots; each
// slot's prefix is the caption heard since the window start.
const WINDOW_SECONDS = 30;

async function windowedAudioDecisions(args, audio, tokens, getTranscriber) {
  const decisions = new Map();
  const ordered = [...tokens].sort((left, right) => left.timeSeconds - right.timeSeconds);
  for (let index = 0; index < ordered.length;) {
    const start = Math.max(0, ordered[index].timeSeconds - args.before);
    const group = [];
    while (index < ordered.length && (!group.length || ordered[index].timeSeconds + args.after <= start + WINDOW_SECONDS)) {
      group.push(ordered[index]);
      index += 1;
    }
    const { transformers, asr } = await getTranscriber();
    const end = group[group.length - 1].timeSeconds + args.after;
    const pcm = pcmSlice(audio, start + args.shift, end - start);
    const scored = await decision.scoreSlots(transformers, asr, pcm, rules.ALLOWED_WORDS, group.map((token) => ({
      prefix: (token.precedingWords || []).filter((word) => word.time >= start).map((word) => word.word).join(" "),
      nextWord: token.nextWord
    })));
    group.forEach((token, slot) => decisions.set(token.tokenIndex, scored[slot]));
  }
  return decisions;
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
  const timelineIndex = new Map(timedData.timeline.map((event, index) => [event.eventIndex, index]));
  const audioDecisions = await windowedAudioDecisions(args, audio, selectedTokens.filter((token) =>
    shouldTranscribeToken(token, args.mode) && !(cachedResults && cachedResults.get(token.tokenIndex))), getTranscriber);
  const results = [];
  let reusedSlotCount = 0;

  for (const token of selectedTokens) {
    const reviewContext = reviewContextForToken(timedData.timeline, token, args.contextEvents, timelineIndex);
    const candidateWords = args.mode === "rules-only" ? token.deterministicCandidates : [];
    const anyCandidate = args.rulesScoring === "any-candidate";
    const hybridRuleWord = args.mode === "rules+whisper" || args.mode === "rules-first"
      ? token.deterministicWord || contextWordForToken(token) : "";
    const hybridRuleSource = token.deterministicWord ? "deterministic" : "context";
    const reusable = reusableResults && reusableResults.get(token.tokenIndex);
    if (args.mode === "rules-only" && reusable && reusable.context === token.context &&
        reusable.reviewContext === reviewContext && reusable.word === token.deterministicWord &&
        reusable.ruleTemplate === (token.deterministicRuleTemplate || "") &&
        (reusable.ruleId || "") === (token.deterministicRuleId || "") &&
        reusable.ruleTier === (token.deterministicTier || "") &&
        reusable.candidateScoring === anyCandidate &&
        JSON.stringify(reusable.candidates || []) === JSON.stringify(candidateWords)) {
      results.push(reusable);
      reusedSlotCount += 1;
      continue;
    }
    const transcribe = shouldTranscribeToken(token, args.mode);
    let audioDecision = null;
    let chosen = { word: token.deterministicWord, evidence: "deterministic" };
    if (transcribe) {
      const cached = cachedResults && cachedResults.get(token.tokenIndex);
      if (cached) {
        audioDecision = { word: cached.audioWord || "", evidence: cached.audioWord ? "candidate-score" : "none",
          score: cached.audioScore };
      } else {
        audioDecision = audioDecisions.get(token.tokenIndex);
      }
      chosen = hybridRuleWord
        ? decision.arbitrateHybridResolution(hybridRuleWord, audioDecision, hybridRuleSource) || {}
        : audioDecision;
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
      prefix: token.prefix,
      nextWord: token.nextWord,
      word: chosen.word,
      candidates: candidateWords,
      attempted,
      candidateScoring: anyCandidate,
      ruleTemplate: token.deterministicRuleTemplate || "",
      ruleId: token.deterministicRuleId || "",
      ruleTier: token.deterministicTier || "",
      source: chosen.evidence,
      expected,
      correct
    };
    if (audioDecision) Object.assign(result, { audioWord: audioDecision.word, audioScore: audioDecision.score ?? null });
    if (chosen.hybridCrossFamily) result.hybridCrossFamily = true;
    result.classification = classifyResult(result);
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

function fixtureFingerprint(fixturesPath, fixture, censoredBody) {
  let censored;
  let uncensored = "";
  try {
    censored = censoredBody === undefined
      ? fs.readFileSync(path.join(fixturesPath, fixture.censored), "utf8")
      : censoredBody;
  } catch {
    return "";
  }
  if (fixture.uncensored) {
    try {
      uncensored = fs.readFileSync(path.join(fixturesPath, fixture.uncensored), "utf8");
    } catch {
      // An unpaired fixture has an empty manual side.
    }
  }
  return contentFingerprint(`${censored}\n${uncensored}`);
}

function transcriptCacheResults(fixture, currentFingerprint) {
  return fixture && currentFingerprint && fixture.contentFingerprint === currentFingerprint
    ? new Map((fixture.results || []).map((result) => [result.tokenIndex, result]))
    : null;
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
  const value = rules.DETERMINISTIC_RULES.map((rule) =>
    `${rule.template}|${rule.candidates.join(",")}|`).join("");
  return `${rules.DETERMINISTIC_RULES.length}:${rules.RULE_WORDS.length}:${contentFingerprint(value)}`;
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

function decisionFingerprint() {
  return contentFingerprint([
    fs.readFileSync(path.join(root, "src", "whisper-local.js"), "utf8"),
    contextWordForToken, shouldTranscribeToken, windowedAudioDecisions,
    evaluateFixture, isCorrect, classifyResult
  ].map((value) => String(value)).join("\n"));
}

function transcriptGenerationFingerprint() {
  return contentFingerprint([
    "candidate-scoring-v1",
    fs.readFileSync(path.join(root, "src", "whisper-local.js"), "utf8"),
    audioWindowKey,
    findAudio,
    pcmSlice,
    importTransformers,
    createTranscriber,
    evaluateFixture,
    shouldTranscribeToken,
    String(rules.CENSORED_TOKEN_REGEX),
    fs.readFileSync(path.join(root, "src", "timedtext.js"), "utf8")
  ].map((value) => String(value)).join("\n"));
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

function creatorMacro(fixtures) {
  const buckets = new Map();
  fixtures.forEach((fixture) => {
    const key = fixture.creatorId || fixture.creator;
    if (!key || key === "unknown") return; // Unknown provenance must not masquerade as a creator.
    const bucket = buckets.get(key) || {
      fixtureCount: 0, scoredCount: 0, attemptedCount: 0, correctCount: 0
    };
    const rows = fixture.results || [];
    const scored = rows.filter((result) => result.expected.length);
    bucket.fixtureCount += fixture.skipped ? 0 : 1;
    bucket.scoredCount += scored.length;
    bucket.attemptedCount += scored.filter((result) =>
      result.attempted ?? Boolean(result.word)).length;
    bucket.correctCount += scored.filter((result) => result.correct).length;
    buckets.set(key, bucket);
  });
  const creators = [...buckets.values()];
  const mean = (values) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const precisionValues = creators.filter((creator) => creator.attemptedCount)
    .map((creator) => creator.correctCount / creator.attemptedCount);
  const coverageValues = creators.filter((creator) => creator.scoredCount)
    .map((creator) => creator.correctCount / creator.scoredCount);
  return {
    creatorCount: creators.length,
    contributingCreatorCount: coverageValues.length,
    attemptedCreatorCount: precisionValues.length,
    precision: mean(precisionValues),
    coverage: mean(coverageValues),
    accuracy: mean(coverageValues)
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
  const pairClasses = {};
  fixtures.forEach((fixture) => {
    const name = fixture.pairClass || "unknown";
    const bucket = pairClasses[name] || {
      fixtureCount: 0, evaluatedCount: 0, scoredCount: 0,
      attemptedCount: 0, correctCount: 0
    };
    const fixtureResults = fixture.results || [];
    const fixtureScored = fixtureResults.filter((result) => result.expected.length);
    bucket.fixtureCount += fixture.skipped ? 0 : 1;
    bucket.evaluatedCount += fixtureResults.length;
    bucket.scoredCount += fixtureScored.length;
    bucket.attemptedCount += fixtureScored.filter((result) => result.attempted ?? Boolean(result.word)).length;
    bucket.correctCount += fixtureScored.filter((result) => result.correct).length;
    pairClasses[name] = bucket;
  });
  Object.values(pairClasses).forEach((bucket) => {
    bucket.precision = bucket.attemptedCount ? bucket.correctCount / bucket.attemptedCount : 0;
    bucket.coverage = bucket.scoredCount ? bucket.correctCount / bucket.scoredCount : 0;
  });
  const creatorMacroByPairClass = Object.fromEntries(Object.keys(pairClasses).map((name) => [
    name, creatorMacro(fixtures.filter((fixture) => (fixture.pairClass || "unknown") === name))
  ]));
  const creators = {};
  fixtures.forEach((fixture) => {
    const name = fixture.creator || "unknown";
    const rows = (fixture.results || []).filter((result) => result.expected.length);
    const bucket = creators[name] || { fixtureCount: 0, scoredCount: 0,
      attemptedCount: 0, correctCount: 0 };
    bucket.fixtureCount += fixture.skipped ? 0 : 1;
    bucket.scoredCount += rows.length;
    bucket.attemptedCount += rows.filter((result) => result.attempted ?? Boolean(result.word)).length;
    bucket.correctCount += rows.filter((result) => result.correct).length;
    creators[name] = bucket;
  });
  Object.values(creators).forEach((bucket) => {
    bucket.precision = bucket.attemptedCount ? bucket.correctCount / bucket.attemptedCount : 0;
    bucket.coverage = bucket.scoredCount ? bucket.correctCount / bucket.scoredCount : 0;
  });
  const ruleMetrics = {};
  fixtures.forEach((fixture) => {
    (fixture.results || []).forEach((result) => {
      if (!result.ruleId || !result.expected.length) return;
      const attempted = result.attempted ?? Boolean(result.word);
      const bucket = ruleMetrics[result.ruleId] || {
        ruleId: result.ruleId, template: result.ruleTemplate,
        tier: result.ruleTier, matchedCount: 0, attemptedCount: 0, correctCount: 0,
        candidateCorrectCount: 0, candidateCount: 0, creators: new Set(), pairClasses: {}
      };
      const pairClass = fixture.pairClass || "unknown";
      const pairBucket = bucket.pairClasses[pairClass] || {
        matchedCount: 0, attemptedCount: 0, correctCount: 0
      };
      bucket.matchedCount += 1;
      bucket.candidateCount = Math.max(bucket.candidateCount, (result.candidates || []).length);
      if (fixture.creator && fixture.creator !== "unknown") bucket.creators.add(fixture.creator);
      if ((result.candidates || []).some((candidate) => (
        isCorrect(candidate, result.expected, result.context)
      ))) bucket.candidateCorrectCount += 1;
      pairBucket.matchedCount += 1;
      if (attempted) {
        bucket.attemptedCount += 1;
        pairBucket.attemptedCount += 1;
      }
      if (result.correct) {
        bucket.correctCount += 1;
        pairBucket.correctCount += 1;
      }
      bucket.pairClasses[pairClass] = pairBucket;
      ruleMetrics[result.ruleId] = bucket;
    });
  });
  Object.values(ruleMetrics).forEach((bucket) => {
    bucket.precision = bucket.attemptedCount ? bucket.correctCount / bucket.attemptedCount : 0;
    bucket.candidateCount = bucket.candidateCount || 1;
    bucket.candidatePrecision = bucket.matchedCount
      ? bucket.candidateCorrectCount / bucket.matchedCount : 0;
    bucket.creatorCount = bucket.creators.size;
    bucket.qualityGate = ruleQualityGate(bucket);
    delete bucket.creators;
    Object.values(bucket.pairClasses).forEach((pairBucket) => {
      pairBucket.precision = pairBucket.attemptedCount
        ? pairBucket.correctCount / pairBucket.attemptedCount : 0;
    });
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
    pairClasses,
    creatorMacro: creatorMacro(fixtures),
    creatorMacroByPairClass,
    creators,
    ruleMetrics: Object.values(ruleMetrics)
      .sort((left, right) => right.attemptedCount - left.attemptedCount ||
        left.ruleId.localeCompare(right.ruleId)),
    classifications,
    topConfusions: Object.entries(confusions)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 50)
      .map(([pair, count]) => ({ pair, count }))
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fixturesPath = resolvePath(args.fixtures);
  const configured = normalizeFixtureManifest(
    JSON.parse(fs.readFileSync(resolvePath(args.manifest), "utf8"))
  );
  const reportPaths = args.provenanceReports
    ? args.provenanceReports.split(",").filter(Boolean).map(resolvePath)
    : defaultReports(root);
  const provenance = buildProvenanceIndex(reportPaths);
  const creatorManifest = args.creatorManifest
    ? loadCreatorManifest(resolvePath(args.creatorManifest)) : null;
  if (args.creatorSplit === "test" && creatorManifest.manifest.prospective !== true) {
    throw new Error("Prospective test evaluation requires a prospective creator manifest.");
  }
  const withPairClass = (fixture) => {
    const record = provenance.get(fixture.videoId || fixture.name.slice(0, 11)) || {};
    const creator = record.creator || fixture.creator || "";
    const creatorId = record.creatorId || fixture.creatorId || "";
    return { ...fixture, pairClass: record.pairClass || "unknown",
      creator, creatorId,
      creatorSplit: creatorSplitForRecord({ ...record, creator, creatorId }, creatorManifest) };
  };
  const byName = new Map(configured.map(withPairClass).map((fixture) => [fixture.name, fixture]));
  if (args.discoverPaired) {
    fs.readdirSync(fixturesPath)
      .filter((name) => name.endsWith("_auto.en.json3"))
      .forEach((censored) => {
        const basename = censored.slice(0, -"_auto.en.json3".length);
        const name = basename.slice(0, 11);
        const uncensored = `${basename}_manual.en.json3`;
        if (!byName.has(name) && fs.existsSync(path.join(fixturesPath, uncensored))) {
          const fixture = withPairClass({ name, videoId: name, censored, uncensored });
          byName.set(name, fixture);
        }
      });
  }
  const allFixtures = args.discoverUnpaired
    ? discoverUnpaired(fixturesPath, args.unpairedMinBlanks)
      .map((fixture) => ({ ...fixture, pairClass: "unpaired" }))
    : [...byName.values()];
  const manifest = allFixtures.filter((fixture) => (
    (!args.names.size || args.names.has(fixture.name)) &&
    (args.pairClass === "all" || fixture.pairClass === args.pairClass) &&
    (args.creatorSplit === "all" || (args.creatorSplit === "test"
      ? isProspectiveTestFixture(fixture, creatorManifest)
      : fixture.creatorSplit === args.creatorSplit))
  ));

  if (!manifest.length) {
    throw new Error("No fixtures matched the selection.");
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
  const transcriptGenerationFingerprintValue = transcriptGenerationFingerprint();
  if (cachedReport) validateTranscriptCache(cachedReport, args, transcriptGenerationFingerprintValue);
  const cachedByFixture = new Map((cachedReport?.fixtures || [])
    .map((fixture) => [fixture.name, fixture]));
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
  const decisionFingerprintValue = decisionFingerprint();
  const signature = ruleSignature();
  const reuseCompatible = reuseReport && reuseReport.mode === args.mode &&
    reuseReport.rulesScoring === args.rulesScoring && reuseReport.shift === args.shift &&
    reuseReport.audioWindowKey === args.audioWindowKey &&
    reuseReport.before === args.before && reuseReport.after === args.after &&
    reuseReport.contextEvents === args.contextEvents &&
    reuseReport.contextBefore === args.contextBefore &&
    reuseReport.contextAfter === args.contextAfter &&
    reuseReport.limit === args.limit && reuseReport.allowUnscored === args.allowUnscored &&
    reuseReport.discoverPaired === args.discoverPaired &&
    reuseReport.discoverUnpaired === args.discoverUnpaired &&
    reuseReport.pairClass === args.pairClass &&
    reuseReport.creatorManifest === args.creatorManifest &&
    reuseReport.creatorManifestFingerprint === (creatorManifest?.fingerprint || "") &&
    reuseReport.creatorSplit === args.creatorSplit &&
    reuseReport.unpairedMinBlanks === args.unpairedMinBlanks &&
    reuseReport.decisionFingerprint === decisionFingerprintValue;
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
  const reportPrefix = {
    mode: args.mode, rulesScoring: args.rulesScoring, shift: args.shift,
    before: args.before, after: args.after,
    audioWindowKey: args.audioWindowKey
  };
  const reportOptions = {
    contextEvents: args.contextEvents, contextBefore: args.contextBefore,
    contextAfter: args.contextAfter, limit: args.limit, allowUnscored: args.allowUnscored,
    discoverPaired: args.discoverPaired, discoverUnpaired: args.discoverUnpaired,
    pairClass: args.pairClass, creatorManifest: args.creatorManifest,
    creatorManifestFingerprint: creatorManifest?.fingerprint || "",
    creatorManifestFrozenAt: creatorManifest?.manifest.frozenAt || "",
    creatorManifestMethod: creatorManifest?.manifest.method || "",
    creatorSplit: args.creatorSplit, prospective: args.creatorSplit === "test",
    minimumCreators: creatorManifest?.manifest.minimumCreators || 0,
    minimumSlots: creatorManifest?.manifest.minimumSlots || 0,
    provenanceReports: reportPaths.map((file) => path.relative(root, file)),
    unpairedMinBlanks: args.unpairedMinBlanks
  };
  const reportFingerprints = {
    rulesFingerprint: fingerprint, rulesAuxFingerprint: auxiliaryFingerprint,
    rulesEngineFingerprint: engineFingerprint, decisionFingerprint: decisionFingerprintValue,
    transcriptGenerationFingerprint: transcriptGenerationFingerprintValue, ruleSignature: signature
  };

  function fixtureBody(fixture) {
    try {
      return fs.readFileSync(path.join(fixturesPath, fixture.censored), "utf8");
    } catch {
      return "";
    }
  }

  for (const [fixtureIndex, fixture] of manifest.entries()) {
    const cached = reusedByName.get(fixture.name);
    let reusable = false;
    let reusableResults = null;
    const body = fixtureBody(fixture);
    const currentFixtureFingerprint = fixtureFingerprint(fixturesPath, fixture, body);
    const transcriptResults = transcriptCacheResults(cachedByFixture.get(fixture.name),
      currentFixtureFingerprint);
    if (cached && cached.results) {
      const sameContent = cached.contentFingerprint && cached.contentFingerprint === currentFixtureFingerprint;
      if (sameContent) reusableResults = new Map(cached.results.map((result) => [result.tokenIndex, result]));
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
      fixtures.push({ ...cached, pairClass: fixture.pairClass, creator: fixture.creator,
        creatorId: fixture.creatorId, creatorSplit: fixture.creatorSplit, rulesFingerprint: fingerprint,
        reusedSlotCount: cached.results.length });
    } else {
      if (fixtureIndex % 50 === 0) {
        console.error(`Evaluating ${fixtureIndex + 1}/${manifest.length}...`);
      }
      const evaluated = await evaluateFixture(
        args, fixture, getTranscriber, transcriptResults, reusableResults
      );
      evaluated.pairClass = fixture.pairClass;
      evaluated.creator = fixture.creator;
      evaluated.creatorId = fixture.creatorId;
      evaluated.creatorSplit = fixture.creatorSplit;
      reusedSlotCount += evaluated.reusedSlotCount || 0;
      fixtures.push(evaluated);
    }
    if (args.checkpointEvery > 0 && (fixtureIndex + 1) % args.checkpointEvery === 0) {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify({
        ...reportPrefix,
        complete: false,
        ...reportOptions,
        ...reportFingerprints,
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

  const summary = summarize(fixtures);
  if (args.creatorSplit === "test") {
    const validity = validateProspectiveSummary(summary, creatorManifest.manifest);
    if (!validity.valid) {
      throw new Error(`Prospective test requires at least ${validity.minimumCreators} scored creators and ` +
        `${validity.minimumSlots} scored slots; got ${validity.creatorCount} creators and ` +
        `${validity.scoredSlots} slots.`);
    }
  }

  const report = {
    ...reportPrefix,
    ...reportOptions,
    complete: true,
    ...reportFingerprints,
    reusedCount,
    reusedSlotCount,
    summary,
    fixtures
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const { ruleMetrics, ...consoleSummary } = report.summary;
  console.log(JSON.stringify({
    output: args.output,
    reusedFixtures: reusedCount,
    reusedSlots: reusedSlotCount,
    summary: consoleSummary,
    ruleMetricCount: ruleMetrics.length
  }, null, 2));
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseArgs,
  normalizeFixtureManifest,
  audioWindowKey,
  validateTranscriptCacheWindow,
  validateTranscriptCache,
  discoverUnpaired,
  shouldTranscribeToken,
  contextWordForToken,
  allowedExpectedWords,
  findAudio,
  isCorrect,
  classifyResult,
  summarize,
  changedRuleTemplates,
  contentFingerprint,
  fixtureFingerprint,
  transcriptCacheResults,
  auxiliaryRulesFingerprint,
  reviewContextForToken,
  ruleQualityGate,
  rulesEngineFingerprint,
  decisionFingerprint,
  transcriptGenerationFingerprint,
  rulesFingerprint,
  creatorMacro,
  isCanonicalCreatorId,
  isProspectiveTestFixture,
  loadCreatorManifest,
  creatorSplitForRecord,
  validateProspectiveSummary
};
