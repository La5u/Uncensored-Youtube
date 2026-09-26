#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { ALLOWED_WORDS } = require("../src/rules");
const { currentFingerprints } = require("./evaluation-metrics");

const root = path.join(__dirname, "..");
const DEFAULTS = {
  mode: "disagreements",
  rulesReport: "tmp/annotation-rules.json",
  whisperReport: "tmp/annotation-whisper.json",
  falseFillReport: "tmp/false-fill-p0.json",
  deepgramTriage: null,
  audioDir: "test-fixtures/audio",
  output: "tmp/audio-annotations.json",
  port: 8765,
  before: 1.5,
  after: 2.5,
  limit: 0,
  bothEmptyLimit: 25
};
const MODES = new Set(["disagreements", "whisper-misses", "review", "triage", "golden", "deepgram-review", "false-fills"]);
const FALSE_FILL_STATUSES = ["genuine-profanity", "ordinary-word", "no-corresponding-word",
  "non-english", "alignment-mismatch", "uncertain"];
const CONFIDENCES = ["high", "medium", "low", "unknown"];
const AUDIO_EXTENSIONS = new Set([".m4a", ".webm", ".mp3", ".wav", ".ogg", ".opus", ".mp4"]);
const STATUS_SETS = {
  "false-fills": ["pending", ...FALSE_FILL_STATUSES],
  default: ["pending", "swear", "no-swear-in-audio", "wrong-audio-fragment", "not-english", "skipped"]
};
const ANNOTATION_HISTORY = ["tmp/audio-golden.json", "tmp/audio-disagreements.json",
  "tmp/false-fill-p0.json", "tmp/triage.json"];
const UNUSABLE_ANNOTATION_STATUSES = new Set([
  "skipped", "wrong-audio-fragment", "not-english", "invalid", "alignment-mismatch", "uncertain", "non-english"
]);

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") args.help = true;
    else if (key.startsWith("--") && Object.prototype.hasOwnProperty.call(args,
      key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()))) {
      const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (argv[i + 1] === undefined) throw new Error(`${key} needs a value.`);
      args[name] = argv[++i];
    } else throw new Error(`Unknown option: ${key}`);
  }
  args.port = Number(args.port);
  args.before = Number(args.before);
  args.after = Number(args.after);
  args.limit = Number(args.limit);
  args.bothEmptyLimit = Number(args.bothEmptyLimit);
  if (!MODES.has(args.mode)) throw new Error(`--mode must be one of ${[...MODES].join(", ")}.`);
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error("Invalid --port.");
  if (![args.before, args.after].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("--before and --after must be non-negative numbers.");
  }
  if (!Number.isInteger(args.limit) || args.limit < 0) throw new Error("--limit must be a non-negative integer.");
  if (!Number.isInteger(args.bothEmptyLimit) || args.bothEmptyLimit < 0) {
    throw new Error("--both-empty-limit must be a non-negative integer.");
  }
  return args;
}

function readReport(file, expectedMode, diagnosticFingerprint = null) {
  const absolute = path.resolve(root, file);
  const raw = fs.readFileSync(absolute, "utf8");
  const fingerprint = crypto.createHash("sha256").update(raw).digest("hex");
  const report = JSON.parse(raw);
  if (!Array.isArray(report.fixtures) || report.mode !== expectedMode) {
    throw new Error(`${file} must be a ${expectedMode} evaluator report.`);
  }
  if (report.complete !== true) throw new Error(`${file} is incomplete.`);
  const current = currentFingerprints();
  for (const key of ["rulesFingerprint", "rulesAuxFingerprint", "rulesEngineFingerprint"]) {
    if (report[key] !== current[key] && fingerprint !== diagnosticFingerprint) {
      throw new Error(`${file} is stale for ${key}; expected ${current[key]}, got ${report[key] || "missing"}.`);
    }
  }
  return { report, path: absolute, sha256: `sha256:${fingerprint}` };
}

function resultMap(report) {
  const map = new Map();
  for (const fixture of report.fixtures || []) {
    if (!fixture || fixture.skipped || !fixture.name) continue;
    for (const result of fixture.results || []) {
      map.set(`${fixture.name}:${result.tokenIndex}`, { fixture, result });
    }
  }
  return map;
}

function readDeepgramTriage(file) {
  const absolute = path.resolve(root, file);
  const raw = fs.readFileSync(absolute, "utf8");
  const report = JSON.parse(raw);
  if (report.evidenceStatus !== "diagnostic-only; no automatic truth claims" ||
      report.provider !== "Deepgram" || !/^[a-f0-9]{64}$/u.test(report.reportFingerprint) ||
      !report.items || Array.isArray(report.items) || typeof report.items !== "object") {
    throw new Error(`${file} must be a diagnostic-only Deepgram triage report.`);
  }
  const items = new Map();
  const ranks = new Map((report.selectionOrder || []).map((id, index) => [id, index]));
  for (const [id, row] of Object.entries(report.items)) {
    if (row?.status !== "complete" || !row.fixture || !Number.isInteger(row.tokenIndex) ||
        !Number.isFinite(row.timeSeconds) || typeof row.deepgramTranscript !== "string") continue;
    const key = `${row.fixture}:${row.tokenIndex}`;
    if (items.has(key)) throw new Error(`${file} has duplicate slot ${key}.`);
    items.set(key, { timeSeconds: row.timeSeconds, transcript: row.deepgramTranscript,
      rank: ranks.get(id) ?? items.size, category: row.category });
  }
  return { items, path: absolute, reportFingerprint: report.reportFingerprint,
    sha256: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}` };
}

function normalizedWord(value) {
  return String(value || "").toLowerCase().trim().replace(/[.!?]+$/u, "");
}

function whisperMiss(result) {
  const hasGroundTruth = Array.isArray(result?.expected) && result.expected.length > 0;
  return hasGroundTruth && result.correct === false && result.classification !== "unscored";
}

function categoryFor(rulesResult, whisperResult) {
  const rulesWord = normalizedWord(rulesResult?.word);
  const whisperWord = normalizedWord(whisperResult?.word);
  if (rulesWord && whisperWord && rulesWord !== whisperWord) return "disagreement";
  if (rulesWord && !whisperWord) return "rules-only";
  if (!rulesWord && whisperWord) return "whisper-only";
  if (rulesWord && whisperWord) return "agreement";
  return "both-empty";
}

function includeCategory(mode, category, whisperResult) {
  if (mode === "triage") return category !== "agreement";
  if (mode === "golden") return true;
  if (mode === "false-fills") return Boolean(category);
  if (mode === "disagreements") return category === "disagreement";
  if (mode === "whisper-misses") return whisperMiss(whisperResult);
  return category === "disagreement" || whisperMiss(whisperResult);
}

function falseFillStratum(result) {
  const word = normalizedWord(result?.word) || "unknown-word";
  const tier = String(result?.ruleTier || "unknown").trim().toLowerCase() || "unknown";
  return `${word}|${tier}`;
}

function stratifiedSample(items, limit, getStratum = (item) => item.stratum) {
  if (!items.length) return items;
  const target = limit || items.length;
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(getStratum(item)) || [];
    group.push(item);
    groups.set(getStratum(item), group);
  }
  const fixtureCounts = new Map();
  const ruleCounts = new Map();
  const selected = [];
  const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  while (selected.length < target) {
    let added = false;
    for (const [, group] of ordered) {
      if (!group.length || selected.length >= target) continue;
      group.sort((left, right) =>
        (fixtureCounts.get(left.fixture) || 0) - (fixtureCounts.get(right.fixture) || 0) ||
        (ruleCounts.get(left.ruleId) || 0) - (ruleCounts.get(right.ruleId) || 0) ||
        left.id.localeCompare(right.id));
      const item = group.shift();
      selected.push(item);
      fixtureCounts.set(item.fixture, (fixtureCounts.get(item.fixture) || 0) + 1);
      ruleCounts.set(item.ruleId, (ruleCounts.get(item.ruleId) || 0) + 1);
      added = true;
    }
    if (!added) break;
  }
  return selected;
}

function coverageFor(items, selected) {
  const dimensions = {
    fixture: (item) => item.fixture,
    ruleId: (item) => item.ruleId,
    wordTier: (item) => item.stratum
  };
  return Object.fromEntries(Object.entries(dimensions).map(([name, value]) => {
    const candidates = new Set(items.map(value));
    const chosen = new Set(selected.map(value));
    return [name, { candidateValues: candidates.size, selectedValues: chosen.size,
      coveredValues: chosen.size, coverage: candidates.size ? chosen.size / candidates.size : 0 }];
  }));
}

function safePrediction(result) {
  if (!result) return null;
  return {
    word: normalizedWord(result.word),
    candidates: Array.isArray(result.candidates) ? result.candidates : [],
    transcript: String(result.transcript || ""),
    source: String(result.source || ""),
    ruleTemplate: String(result.ruleTemplate || ""),
    ruleId: String(result.ruleId || ""),
    ruleTier: String(result.ruleTier || "")
  };
}

function findAudio(audioDir, fixtureName, reportedPath) {
  const directory = path.resolve(root, audioDir);
  if (!fs.existsSync(directory)) return null;
  const realDirectory = fs.realpathSync(directory);
  const reportedName = path.basename(String(reportedPath || ""));
  const matchesFixture = (entry) => entry === fixtureName + path.extname(entry) ||
    entry.startsWith(`${fixtureName}_`) || entry.startsWith(`${fixtureName} (`);
  const names = fs.readdirSync(directory).filter((name) =>
    AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()) && matchesFixture(name));
  const exact = names.filter((entry) => entry === reportedName);
  const name = exact.length === 1 ? exact[0] : (exact.length ? null : names.length === 1 ? names[0] : null);
  if (!name) return null;
  const absolute = fs.realpathSync(path.join(directory, name));
  return absolute.startsWith(`${realDirectory}${path.sep}`) && fs.statSync(absolute).isFile() ? absolute : null;
}

function readFalseFillReport(file) {
  if (!file || !fs.existsSync(file)) return { ids: new Set(), nonEnglishFixtures: new Set() };
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (report.mode !== "false-fills" || !Array.isArray(report.items)) {
    throw new Error(`${file} must be a false-fills annotation report.`);
  }
  const ids = new Set(), nonEnglishFixtures = new Set();
  for (const item of report.items) {
    if (!item?.id) continue;
    if (["invalid", "alignment-mismatch", "no-corresponding-word", "uncertain"].includes(item.annotation?.status)) ids.add(item.id);
    if (item.annotation?.status === "non-english") nonEnglishFixtures.add(item.fixture);
  }
  return { ids, nonEnglishFixtures };
}

function annotationIdentity(item) {
  const time = Number(item?.timeSeconds);
  return [String(item?.fixture || ""), String(item?.tokenIndex ?? ""),
    Number.isFinite(time) ? time.toFixed(6) : "", path.basename(String(item?.audioFile || ""))].join("|");
}

function sameAnnotationAudio(left, right) {
  if (path.basename(String(left?.audioFile || "")) !== path.basename(String(right?.audioFile || ""))) return false;
  return !left?.audioSha256 || !right?.audioSha256 || left.audioSha256 === right.audioSha256;
}

function annotationHistoryEntry(item, mode) {
  const annotation = item?.annotation;
  if (!annotation || annotation.status === "pending") return null;
  if (mode === "false-fills") {
    return FALSE_FILL_STATUSES.includes(annotation.status) ? JSON.parse(JSON.stringify(annotation)) : null;
  }
  if (STATUS_SETS.default.includes(annotation.status) && !UNUSABLE_ANNOTATION_STATUSES.has(annotation.status)) {
    return JSON.parse(JSON.stringify(annotation));
  }
  if (annotation.status === "genuine-profanity" && ALLOWED_WORDS.includes(normalizedWord(annotation.spokenWord))) {
    return { status: "swear", word: normalizedWord(annotation.spokenWord), note: String(annotation.note || ""),
      widePlayed: Boolean(annotation.widePlayed), ruleRecommendation: null };
  }
  if (["ordinary-word", "no-corresponding-word"].includes(annotation.status)) {
    return { status: "no-swear-in-audio", word: null, note: String(annotation.note || ""),
      widePlayed: Boolean(annotation.widePlayed), ruleRecommendation: null };
  }
  return null;
}

function readAnnotationHistory(files = [], mode) {
  const labels = new Map(), blocked = new Map(), blockedFixtures = [];
  const seen = new Set();
  for (const file of files) {
    const absolute = typeof file === "string" ? path.resolve(root, file) : null;
    const source = absolute || file;
    if (absolute && (!fs.existsSync(absolute) || seen.has(absolute))) continue;
    if (absolute) seen.add(absolute);
    const report = typeof source === "string"
      ? JSON.parse(fs.readFileSync(source, "utf8")) : source;
    if (!report || !Array.isArray(report.items)) {
      throw new Error(`${file} must be an annotation report.`);
    }
    for (const item of report.items) {
      const status = item?.annotation?.status;
      if (!item?.fixture || !Number.isInteger(item.tokenIndex) || !Number.isFinite(Number(item.timeSeconds)) || !status) continue;
      const key = annotationIdentity(item);
      if (status === "not-english" || status === "non-english") {
        blockedFixtures.push(item);
      } else if (UNUSABLE_ANNOTATION_STATUSES.has(status)) {
        const rows = blocked.get(key) || [];
        rows.push(item);
        blocked.set(key, rows);
      }
      const label = annotationHistoryEntry(item, mode || report.mode);
      if (label) labels.set(key, { item, annotation: label });
    }
  }
  return { labels, blocked, blockedFixtures };
}

function historyMatch(history, item) {
  const key = annotationIdentity(item);
  if (history.blockedFixtures.some((row) => row.fixture === item.fixture && sameAnnotationAudio(row, item))) return null;
  if ((history.blocked.get(key) || []).some((row) => sameAnnotationAudio(row, item))) return null;
  const saved = history.labels.get(key);
  return saved && sameAnnotationAudio(saved.item, item) ? saved.annotation : undefined;
}

function buildQueue({ mode, rules, whisper, deepgramTriage, audioDir, before, after, limit = 0,
  bothEmptyLimit = 25, falseFillReport, annotationReports = [] }) {
  const rulesMap = rules ? resultMap(rules.report) : new Map();
  const whisperMap = whisper ? resultMap(whisper.report) : new Map();
  const deepgramMap = deepgramTriage?.items || new Map();
  const historyFiles = [...annotationReports];
  if (falseFillReport && !historyFiles.some((file) => typeof file === "string" &&
      path.resolve(root, file) === path.resolve(root, falseFillReport))) historyFiles.push(falseFillReport);
  const history = readAnnotationHistory(historyFiles, mode);
  const excluded = mode === "triage" ? readFalseFillReport(falseFillReport) : null;
  const keys = mode === "deepgram-review" ? [...deepgramMap.keys()] :
    mode === "golden" && !rules ? [...whisperMap.keys()] :
    mode === "golden" && !whisper ? [...rulesMap.keys()] :
      mode === "false-fills" ? [...rulesMap.keys()] : [...new Set([...rulesMap.keys(), ...whisperMap.keys()])];
  const items = [];
  const audioIdentities = new Map();
  let missingAudio = 0;
  for (const id of keys.sort()) {
    const rulesRow = rulesMap.get(id);
    const whisperRow = whisperMap.get(id);
    if (mode === "false-fills" ? !rulesRow :
        mode === "deepgram-review" ? !whisperRow : mode !== "golden" && (!rulesRow || !whisperRow)) continue;
    if (excluded && (excluded.ids.has(id) || excluded.nonEnglishFixtures.has((rulesRow || whisperRow).fixture.name))) continue;
    const category = mode === "false-fills" && normalizedWord(rulesRow?.result?.word)
      ? "false-fill" : categoryFor(rulesRow?.result, whisperRow?.result);
    if (mode === "false-fills" && !normalizedWord(rulesRow?.result?.word)) continue;
    if (mode !== "deepgram-review" && !includeCategory(mode, category, whisperRow?.result)) continue;
    if (rulesRow && whisperRow && Math.abs(Number(rulesRow.result.timeSeconds) -
      Number(whisperRow.result.timeSeconds)) > 0.1) {
      throw new Error(`Reports disagree on the timestamp for ${id}.`);
    }
    if (rulesRow && whisperRow && path.basename(String(rulesRow.fixture.audio || "")) !==
      path.basename(String(whisperRow.fixture.audio || ""))) {
      throw new Error(`Reports disagree on the audio for ${id}.`);
    }
    const row = mode === "false-fills" ? rulesRow : whisperRow || rulesRow;
    const timeSeconds = Number(row.result.timeSeconds);
    if (!Number.isFinite(timeSeconds) || !Number.isInteger(row.result.tokenIndex) || row.result.tokenIndex < 0) {
      throw new Error(`Invalid slot identity or timestamp for ${id}.`);
    }
    const audioFile = findAudio(audioDir, row.fixture.name, row.fixture.audio);
    if (!audioFile) {
      missingAudio += 1;
      continue;
    }
    const result = row.result;
    const deepgram = deepgramMap.get(id);
    if (deepgram && Math.abs(deepgram.timeSeconds - timeSeconds) > 0.1) {
      throw new Error(`Deepgram triage timestamp disagrees for ${id}.`);
    }
    let audioIdentity = audioIdentities.get(audioFile);
    if (!audioIdentity) {
      const stat = fs.statSync(audioFile);
      const audioSha256 = crypto.createHash("sha256").update(fs.readFileSync(audioFile)).digest("hex");
      audioIdentity = { audioVersion: `${stat.size}-${audioSha256}`, audioSha256 };
      audioIdentities.set(audioFile, audioIdentity);
    }
    const wordTier = mode === "false-fills" ? falseFillStratum(result) : null;
    const identity = { fixture: row.fixture.name, tokenIndex: result.tokenIndex, timeSeconds,
      audioFile: path.relative(root, audioFile), ...audioIdentity };
    const priorAnnotation = historyMatch(history, identity);
    if (priorAnnotation === null) continue;
    items.push({
      id,
      fixture: row.fixture.name,
      tokenIndex: result.tokenIndex,
      timeSeconds,
      context: String(result.context || ""),
      reviewContext: String(result.reviewContext || ""),
      category,
      stratum: wordTier,
      ruleId: mode === "false-fills" ? String(result.ruleId || "unknown") : null,
      ruleTier: mode === "false-fills" ? String(result.ruleTier || "unknown") : null,
      ...identity,
      clipStart: Math.max(0, timeSeconds - before),
      clipEnd: timeSeconds + after,
      rules: safePrediction(rulesRow?.result),
      whisper: mode === "false-fills" ? null : safePrediction(whisperRow?.result),
      deepgramTranscript: deepgram?.transcript || null,
      deepgramPriority: mode === "deepgram-review" ? deepgram?.rank : null,
      annotation: priorAnnotation || (mode === "false-fills"
        ? { status: "pending", word: null, spokenWord: null, confidence: "high",
          timingOffsetSeconds: null, note: "", widePlayed: false }
        : { status: "pending", word: null, note: "", widePlayed: false, ruleRecommendation: null })
    });
  }
  items.sort(mode === "deepgram-review" ? (left, right) =>
    left.deepgramPriority - right.deepgramPriority : mode === "golden" ? (left, right) => {
    const leftHash = crypto.createHash("sha256").update(left.id).digest("hex");
    const rightHash = crypto.createHash("sha256").update(right.id).digest("hex");
    return leftHash.localeCompare(rightHash);
  } : (left, right) => left.category.localeCompare(right.category) || left.id.localeCompare(right.id));
  let ordered;
  if (mode === "false-fills") ordered = stratifiedSample(items, limit);
  else if (mode === "triage") {
    const disagreements = items.filter((item) => item.category === "disagreement");
    const rulesOnly = items.filter((item) => item.category === "rules-only");
    const whisperOnly = items.filter((item) => item.category === "whisper-only");
    const bothEmpty = items.filter((item) => item.category === "both-empty");
    const target = limit || Infinity;
    const sample = (values, count) => count === 0 ? [] : stratifiedSample(values, count, (item) => item.fixture);
    const selectedDisagreements = disagreements.length > target
      ? sample(disagreements, target) : stratifiedSample(disagreements, Infinity, (item) => item.fixture);
    let remaining = target - selectedDisagreements.length;
    const selectedEmpty = sample(bothEmpty, Math.min(bothEmptyLimit, remaining));
    remaining -= selectedEmpty.length;
    const rulesTarget = Math.ceil(remaining / 2);
    const selectedRules = sample(rulesOnly, rulesTarget);
    const selectedWhisper = sample(whisperOnly, remaining - selectedRules.length);
    // Give unused unilateral capacity to the other side when one category is short.
    const used = selectedRules.length + selectedWhisper.length;
    const selectedRuleIds = new Set(selectedRules.map((item) => item.id));
    const extraRules = sample(rulesOnly.filter((item) => !selectedRuleIds.has(item.id)), remaining - used);
    ordered = [...selectedDisagreements, ...selectedRules, ...selectedWhisper, ...extraRules, ...selectedEmpty];
  } else ordered = limit ? items.slice(0, limit) : items;
  return { items: ordered, missingAudio,
    selection: mode === "false-fills" ? { priority: "P0", strategy: "bounded-round-robin-by-word-tier-fixture-rule",
      limit, candidateCount: items.length, selectedCount: ordered.length,
      coverage: { candidateRows: items.length, selectedRows: ordered.length,
        rowFraction: items.length ? ordered.length / items.length : 0,
        dimensions: coverageFor(items, ordered) } } : undefined };
}

function statusSetFor(mode) {
  return STATUS_SETS[mode] || STATUS_SETS.default;
}

function validateAnnotation(annotation) {
  if (!annotation) throw new Error("Invalid annotation status.");
  if (FALSE_FILL_STATUSES.includes(annotation.status)) {
    if (["expected", "correct", "classification"].some((field) =>
      Object.prototype.hasOwnProperty.call(annotation, field))) {
      throw new Error("False-fill labels cannot contain ground truth.");
    }
    if (annotation.word !== null) throw new Error("False-fill labels cannot contain a runtime word.");
    if (annotation.spokenWord !== null && (typeof annotation.spokenWord !== "string" || annotation.spokenWord.length > 200)) {
      throw new Error("Invalid spoken word.");
    }
    if (["genuine-profanity", "ordinary-word"].includes(annotation.status) &&
      (!annotation.spokenWord || !annotation.spokenWord.trim())) {
      throw new Error("This label needs the exact spoken word.");
    }
    if (!CONFIDENCES.includes(annotation.confidence)) throw new Error("Invalid confidence.");
    if (annotation.timingOffsetSeconds !== null &&
      (typeof annotation.timingOffsetSeconds !== "number" || !Number.isFinite(annotation.timingOffsetSeconds) ||
        Math.abs(annotation.timingOffsetSeconds) > 30)) throw new Error("Invalid timing offset.");
    // Older false-fill files may contain slotCorrespondence; it is no longer collected.
    delete annotation.slotCorrespondence;
    if (annotation.ruleRecommendation !== undefined && annotation.ruleRecommendation !== null) {
      throw new Error("False-fill labels cannot recommend a runtime rule.");
    }
    if (typeof annotation.note !== "string" || annotation.note.length > 500) throw new Error("Invalid note.");
    if (annotation.widePlayed !== undefined && typeof annotation.widePlayed !== "boolean") {
      throw new Error("Invalid wide-playback marker.");
    }
    return annotation;
  }
  if (!["pending", "swear", "no-swear-in-audio", "wrong-audio-fragment", "not-english", "skipped"].includes(annotation.status)) {
    throw new Error("Invalid annotation status.");
  }
  if (annotation.status === "swear" && !ALLOWED_WORDS.includes(annotation.word)) {
    throw new Error("Select a supported swear word.");
  }
  if (annotation.status !== "swear" && annotation.word !== null) {
    throw new Error("Only swear annotations may contain a word.");
  }
  if (typeof annotation.note !== "string" || annotation.note.length > 500) throw new Error("Invalid note.");
  if (annotation.widePlayed !== undefined && typeof annotation.widePlayed !== "boolean") {
    throw new Error("Invalid wide-playback marker.");
  }
  if (annotation.ruleIdea !== undefined) {
    if (typeof annotation.ruleIdea !== "boolean") throw new Error("Invalid legacy rule-idea marker.");
    if (annotation.ruleIdea && annotation.ruleRecommendation === undefined) {
      annotation.ruleRecommendation = { kind: "general", rule: null };
    }
    delete annotation.ruleIdea;
  }
  const recommendation = annotation.ruleRecommendation;
  if (recommendation !== undefined && recommendation !== null) {
    if (annotation.status !== "swear") throw new Error("Only swear labels can recommend a rule.");
    if (!recommendation || !["precise", "general", "manual"].includes(recommendation.kind)) {
      throw new Error("Invalid rule recommendation.");
    }
    if (recommendation.kind === "manual") {
      if (typeof recommendation.rule !== "string" || !recommendation.rule.trim() || recommendation.rule.length > 500) {
        throw new Error("Manual rule recommendations need 1–500 characters.");
      }
      recommendation.rule = recommendation.rule.trim();
    } else if (recommendation.rule !== null && recommendation.rule !== undefined) {
      throw new Error("Only manual recommendations may contain a rule.");
    } else recommendation.rule = null;
  }
  return annotation;
}

function resume(queue, output) {
  if (!fs.existsSync(output)) return queue;
  const old = JSON.parse(fs.readFileSync(output, "utf8"));
  for (const field of ["schemaVersion", "mode", "clip", "selection", "sources", "statusSet"]) {
    if (JSON.stringify(old[field]) !== JSON.stringify(queue[field])) {
      throw new Error(`Existing annotation file has different ${field}; choose another --output.`);
    }
  }
  if (!Array.isArray(old.items) || old.items.length !== queue.items.length) {
    throw new Error("Existing annotation file has a different item set; choose another --output.");
  }
  const oldItems = new Map();
  for (const item of old.items) {
    if (!item || typeof item.id !== "string" || oldItems.has(item.id)) {
      throw new Error("Existing annotation file has a different item set; choose another --output.");
    }
    oldItems.set(item.id, item);
  }
  for (const item of queue.items) {
    const saved = oldItems.get(item.id);
    if (!saved || saved.audioFile !== item.audioFile || saved.audioSha256 !== item.audioSha256 ||
        saved.audioVersion !== item.audioVersion) {
      throw new Error(`Existing annotation file has different audio identity for ${item.id}; choose another --output.`);
    }
    if (!queue.statusSet.includes(saved.annotation?.status)) {
      throw new Error(`Existing annotation file has invalid status for ${item.id}.`);
    }
    // Migrate old pending false-fill records to the high-confidence default, while
    // preserving confidence labels already assigned to completed records.
    if (queue.mode === "false-fills" && saved.annotation.status === "pending" &&
        (!saved.annotation.confidence || saved.annotation.confidence === "unknown")) {
      saved.annotation.confidence = "high";
    }
    item.annotation = validateAnnotation(saved.annotation);
  }
  return queue;
}

function applyAnnotation(state, item, annotation) {
  if (state.mode === "false-fills" && !FALSE_FILL_STATUSES.includes(annotation?.status)) {
    throw new Error("False-fill sessions require a false-fill disposition.");
  }
  item.annotation = validateAnnotation(annotation);
  const changed = [item];
  if (item.annotation.status === "not-english") {
    for (const sibling of state.items) {
      if (sibling.fixture !== item.fixture || sibling === item || sibling.annotation.status !== "pending") continue;
      sibling.annotation = { status: "not-english", word: null, note: "Same non-English audio.",
        widePlayed: false, ruleRecommendation: null };
      changed.push(sibling);
    }
  }
  return changed.map(({ id, annotation: value }) => ({ id, annotation: value }));
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function publicState(state) {
  const frequencies = {};
  for (const item of state.items) {
    if (item.annotation.status === "swear") {
      frequencies[item.annotation.word] = (frequencies[item.annotation.word] || 0) + 1;
    }
  }
  return {
    schemaVersion: state.schemaVersion,
    mode: state.mode,
    statusSet: state.statusSet,
    selection: state.selection,
    words: ALLOWED_WORDS,
    frequencies,
    missingAudio: state.missingAudio,
    items: state.items.map(({ audioFile, ...item }) => item)
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function serveAudio(request, response, item) {
  const audioFile = path.resolve(root, item.audioFile);
  const stat = fs.statSync(audioFile);
  const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(audioFile)).digest("hex");
  if (actualSha256 !== item.audioSha256) {
    return sendJson(response, 409, { error: "Audio content changed; rebuild or resume a new queue." });
  }
  const range = request.headers.range;
  const type = { ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".webm": "audio/webm",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg" }[
    path.extname(audioFile).toLowerCase()] || "application/octet-stream";
  if (!range) {
    response.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(audioFile).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
  if (!match) return sendJson(response, 416, { error: "Invalid range." });
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : 0;
  const start = suffixLength ? Math.max(0, stat.size - suffixLength) : Number(match[1] || 0);
  const end = Math.min(suffixLength ? stat.size - 1 : Number(match[2] || stat.size - 1), stat.size - 1);
  if (start > end || start >= stat.size) return sendJson(response, 416, { error: "Invalid range." });
  response.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes" });
  fs.createReadStream(audioFile, { start, end }).pipe(response);
}

const HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Uncensored audio labels</title><style>
:root{font:16px system-ui;color:#eee;background:#151515}body{max-width:900px;margin:24px auto;padding:0 16px}button,input{font:inherit}button{padding:10px 14px;margin:4px;border:0;border-radius:6px;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}[hidden]{display:none!important}.primary{background:#58a6ff}.selected{background:#8b5cf6;color:#fff}.negative{background:#e59b45}.muted{color:#aaa}.transcript{color:#aaa;font-size:.88rem;line-height:1.35}.prediction{color:#aaa;user-select:none}.context{font-size:1.45rem;line-height:1.5;background:#242424;padding:18px;border-radius:8px}audio{display:none}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.timeline{flex:1;min-width:260px}.rule-box{margin:12px 0;padding:10px;background:#202020;border-radius:8px}input{padding:9px;background:#242424;color:#fff;border:1px solid #666;border-radius:5px}#word{min-width:240px}#manualRule{min-width:300px}.grow{flex:1}details{margin:16px 0;background:#202020;padding:10px}pre{white-space:pre-wrap}.done{color:#72d572}@media(max-width:600px){body{margin:10px auto}.context{font-size:1.15rem}}
</style><h1>Uncensored audio labels</h1><div id="progress" class="muted"></div><h2>Target caption</h2><p id="context" class="context"></p><details><summary>Surrounding captions</summary><p id="surrounding"></p><p class="muted">Surrounding text is not expected in the 4s clip.</p></details>
<audio id="audio" preload="metadata"></audio><div class="row"><button id="play" class="primary">▶ Play near word (Space)</button><button id="wide" hidden>Replay full context</button><span id="kind" class="muted"></span></div>
<details id="asr"><summary>Show ASR transcripts after listening (unverified)</summary><p id="transcript" class="transcript"></p><p id="deepgram" class="transcript"></p></details><div id="predicted" class="row"></div><details><summary>More model details</summary><pre id="models"></pre></details>
<div id="standardControls" class="row"><input id="word" list="words" placeholder="Type or select swear" autocomplete="off"><datalist id="words"></datalist><button id="save" class="primary">Save swear (Enter)</button><button id="rulesWord" class="primary">Use Rules word (R)</button><button id="none" class="negative">No swear in audio</button><button id="wrong" class="negative">Wrong audio fragment</button><button id="nonenglish" class="negative">Not English audio</button></div>
<div id="falseFillControls" hidden><p class="muted">False-fill label: listen first; do not treat the caption/model word as ground truth.</p><div class="row"><label>Actually spoken word <input id="spokenWord" placeholder="word (if audible)" autocomplete="off"></label><label>Confidence <select id="confidence"><option selected>high</option><option>medium</option><option>low</option><option>unknown</option></select></label><label>Timing offset (s) <input id="timingOffset" type="number" step="0.01" placeholder="none"></label></div><div class="row"><button id="falseRulesCorrect" class="primary">Rules correct (R)</button><button id="genuine" class="primary">Genuine profanity</button><button id="ordinary" class="primary">Ordinary word</button><button id="falseWrong" class="negative">Wrong audio fragment (W)</button><button id="silence" class="negative">Silence / no word (S)</button><button id="falseNonEnglish" class="negative">Non-English (N)</button><button id="uncertain" class="negative">Unusable / uncertain (U)</button></div></div>
<div id="common" class="row"></div><div id="ruleBox" class="rule-box"><span>Optional rule recommendation:</span><div class="row"><button id="precise">Precise / word-for-word</button><button id="general">General pattern</button><button id="manual">Manual rule…</button><input id="manualRule" class="grow" placeholder="Type the rule" hidden><button id="clearRule" hidden>Clear</button></div></div><div class="row"><input id="note" class="grow" placeholder="Optional note"><button id="prev">← Previous</button><button id="skip" class="negative">Unsure / skip (U) →</button></div><p id="message"></p>
<script>
let state,index=0,end=0,wideUsed=false,ruleKind=null,saving=false;const $=id=>document.getElementById(id),frequency=word=>state.frequencies[word]||0;
function setFalseFillView(){const active=state.mode==='false-fills';$('falseFillControls').hidden=!active;$('standardControls').hidden=active;$('common').hidden=active;$('ruleBox').hidden=active;$('skip').hidden=active;$('prev').hidden=false}
function falseLabel(status,spokenWord=$('spokenWord').value.trim()||null){const raw=$('timingOffset').value.trim();return {status,word:null,spokenWord,confidence:$('confidence').value,timingOffsetSeconds:raw===''?null:Number(raw),note:$('note').value}}
function sortedWords(){return [...state.words].sort((a,b)=>frequency(b)-frequency(a)||state.words.indexOf(a)-state.words.indexOf(b))}
function wordButton(word,text){const button=document.createElement('button');button.className='primary';button.textContent=text;button.onclick=()=>label({status:'swear',word,note:$('note').value});return button}
function refreshWords(){const words=sortedWords();$('words').replaceChildren(...words.map(word=>{const option=document.createElement('option');option.value=word;option.label=frequency(word)?word+' · '+frequency(word):word;return option}));const empty=!$('word').value.trim();$('common').replaceChildren(...(empty?words.filter(word=>frequency(word)).slice(0,10).map(word=>wordButton(word,word+' · '+frequency(word))):[]))}
async function init(){state=await fetch('/api/state').then(r=>r.json());const first=state.items.findIndex(x=>x.annotation.status==='pending');index=first<0?Math.max(0,state.items.length-1):first;show()} 
function show(auto=false){const item=state.items[index];if(!item){$('context').textContent='No matching items with local audio.';return}setFalseFillView();$('asr').open=false;$('predicted').hidden=state.mode==='deepgram-review';$('wide').hidden=state.mode!=='deepgram-review';$('progress').textContent=(index+1)+' / '+state.items.length+' · '+state.items.filter(x=>x.annotation.status!=='pending').length+' reviewed · '+state.items.filter(x=>x.annotation.ruleRecommendation).length+' rule recommendations'+(state.missingAudio?' · '+state.missingAudio+' skipped without audio':'');const chosen=String(item.rules?.word||'').trim(),candidates=(item.rules?.candidates||[]).filter(word=>word&&word!==chosen),caption=chosen?chosen:candidates.join('|');$('context').textContent=caption?item.context.replace('[__]','['+caption+']'):item.context;$('surrounding').textContent=item.reviewContext||'';$('kind').textContent=item.category;const audio=$('audio');audio.onloadedmetadata=auto?()=>{audio.onloadedmetadata=null;play()}:null;audio.src='/audio/'+encodeURIComponent(item.id)+'?v='+encodeURIComponent(item.audioVersion);$('word').value=item.annotation.word||'';$('spokenWord').value=item.annotation.spokenWord||'';$('confidence').value=item.annotation.status==='pending'?'high':(item.annotation.confidence||'unknown');$('timingOffset').value=item.annotation.timingOffsetSeconds??'';$('note').value=item.annotation.note||'';wideUsed=Boolean(item.annotation.widePlayed);ruleKind=item.annotation.ruleRecommendation?.kind||null;$('manualRule').value=item.annotation.ruleRecommendation?.rule||'';refreshRule();const rulesWord=state.words.includes(item.rules?.word)?item.rules.word:null;$('rulesWord').disabled=!rulesWord;$('rulesWord').textContent=rulesWord?'Use Rules: '+rulesWord+' (R)':'No Rules word (R)';$('falseRulesCorrect').disabled=!item.rules?.word;$('transcript').textContent=item.whisper?.transcript?'Whisper: '+item.whisper.transcript:'';$('deepgram').textContent=item.deepgramTranscript?'Deepgram ASR (unverified; listen to the audio): '+item.deepgramTranscript:'';$('models').textContent=JSON.stringify({rules:item.rules,whisper:item.whisper,deepgramTranscript:item.deepgramTranscript},null,2);const guesses=new Map,addGuess=(name,word)=>{if(state.words.includes(word))guesses.set(word,[...(guesses.get(word)||[]),name])};if(state.mode!=='false-fills'){addGuess('Rules',item.rules?.word);for(const word of item.rules?.candidates||[])addGuess('Rule candidate',word);addGuess('Whisper',item.whisper?.word)}$('predicted').replaceChildren(...[...guesses].sort((a,b)=>frequency(b[0])-frequency(a[0])).map(([word,names])=>wordButton(word,names.join(' + ')+': '+word)));refreshWords();$('message').textContent=item.annotation.status==='pending'?'':('Saved: '+item.annotation.status+(item.annotation.word?' — '+item.annotation.word:''));end=item.clipEnd}
function refreshRule(){for(const kind of ['precise','general','manual'])$(kind).className=ruleKind===kind?'selected':'';const manual=ruleKind==='manual';$('manualRule').hidden=!manual;$('clearRule').hidden=!ruleKind;if(manual)setTimeout(()=>$('manualRule').focus(),0)}
function selectRule(kind){ruleKind=ruleKind===kind?null:kind;refreshRule()}
function recommendation(){return ruleKind?{kind:ruleKind,rule:ruleKind==='manual'?$('manualRule').value:null}:null}
function play(full=false){const a=$('audio'),item=state.items[index];a.playbackRate=1;const focused=state.mode==='deepgram-review'&&!full;a.currentTime=focused?Math.max(item.clipStart,item.timeSeconds-1):item.category==='false-fill'&&!full?Math.max(0,item.timeSeconds-.5):item.clipStart;end=focused?Math.min(item.clipEnd,item.timeSeconds+2.5):item.clipEnd;if(full)wideUsed=true;a.play().catch(error=>$('message').textContent='Playback failed: '+error.message)}
$('audio').addEventListener('timeupdate',()=>{if($('audio').currentTime>=end)$('audio').pause()});$('play').onclick=()=>play();$('wide').onclick=()=>play(true);$('prev').onclick=()=>{if(index){index--;show(true)}};$('skip').onclick=()=>label(state.mode==='false-fills'?falseLabel('uncertain'):{status:'skipped',word:null,note:$('note').value});
async function label(annotation){if(saving)return;saving=true;annotation.widePlayed=wideUsed;annotation.ruleRecommendation=annotation.status==='swear'?recommendation():null;const item=state.items[index],previous=item.annotation;try{const response=await fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,annotation})}),body=await response.json();if(!response.ok){$('message').textContent=body.error;return}if(previous.status==='swear')state.frequencies[previous.word]=Math.max(0,frequency(previous.word)-1);for(const changed of body.annotations||[{id:item.id,annotation:body.annotation}]){const target=state.items.find(x=>x.id===changed.id);if(target)target.annotation=changed.annotation}if(body.annotation.status==='swear')state.frequencies[body.annotation.word]=frequency(body.annotation.word)+1;const next=state.items.findIndex((x,i)=>i>index&&x.annotation.status==='pending');if(next>=0){index=next;show(true)}else if(index<state.items.length-1){index++;show(true)}else show()}finally{saving=false}}
$('falseRulesCorrect').onclick=()=>{const word=String(state.items[index].rules?.word||'').toLowerCase().trim();if(word)label(falseLabel('genuine-profanity',word))};$('genuine').onclick=()=>label(falseLabel('genuine-profanity'));$('ordinary').onclick=()=>label(falseLabel('ordinary-word'));$('falseWrong').onclick=()=>label(falseLabel('alignment-mismatch'));$('silence').onclick=()=>label(falseLabel('no-corresponding-word'));$('falseNonEnglish').onclick=()=>label(falseLabel('non-english'));$('uncertain').onclick=()=>label(falseLabel('uncertain'));$('precise').onclick=()=>selectRule('precise');$('general').onclick=()=>selectRule('general');$('manual').onclick=()=>selectRule('manual');$('clearRule').onclick=()=>{ruleKind=null;refreshRule()};$('save').onclick=()=>label({status:'swear',word:$('word').value.trim().toLowerCase(),note:$('note').value});$('rulesWord').onclick=()=>{const word=state.items[index].rules?.word;if(state.words.includes(word))label({status:'swear',word,note:$('note').value})};$('none').onclick=()=>label({status:'no-swear-in-audio',word:null,note:$('note').value});$('wrong').onclick=()=>label({status:'wrong-audio-fragment',word:null,note:$('note').value});$('nonenglish').onclick=()=>label({status:'not-english',word:null,note:$('note').value});$('word').addEventListener('input',refreshWords);$('word').addEventListener('keydown',e=>{if(e.key==='Enter')$('save').click();else if(e.key==='Tab'&&e.target.value.trim()){const value=$('word').value.trim().toLowerCase(),match=sortedWords().find(word=>word.startsWith(value)&&word!==value);if(match){e.preventDefault();$('word').value=match;refreshWords()}}});$('spokenWord').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.target.blur()}else if(e.key==='Enter'&&e.target.value.trim())$('genuine').click()});document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.target.matches('input,textarea,[contenteditable]')){e.preventDefault();$('spokenWord').focus();$('spokenWord').select();return}if(e.target.matches('input,textarea,[contenteditable]'))return;if(e.key==='Enter'&&state.mode==='false-fills'&&!e.target.matches('select,button'))return $('falseRulesCorrect').click();if(e.key===' ') {e.preventDefault();play()}else if(e.key.toLowerCase()==='r'){(state.mode==='false-fills'?$('falseRulesCorrect'):$('rulesWord')).click()}else if(e.key.toLowerCase()==='w'&&state.mode==='false-fills')$('falseWrong').click();else if(e.key.toLowerCase()==='s'&&state.mode==='false-fills')$('silence').click();else if(e.key.toLowerCase()==='n'&&state.mode==='false-fills')$('falseNonEnglish').click();else if(e.key.toLowerCase()==='u')$('skip').click();else if(e.key==='ArrowLeft')$('prev').click()});init();
</script>`;

function startServer(state, output, args) {
  const host = "127.0.0.1";
  const origin = `http://${host}:${args.port}`;
  const byId = new Map(state.items.map((item) => [item.id, item]));
  const server = http.createServer((request, response) => {
    try {
      if (request.headers.origin && request.headers.origin !== origin) {
        return sendJson(response, 403, { error: "Invalid origin." });
      }
      const url = new URL(request.url, origin);
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return response.end(HTML);
      }
      if (request.method === "GET" && url.pathname === "/api/state") return sendJson(response, 200, publicState(state));
      if (request.method === "GET" && url.pathname.startsWith("/audio/")) {
        const item = byId.get(decodeURIComponent(url.pathname.slice(7)));
        return item ? serveAudio(request, response, item) : sendJson(response, 404, { error: "Unknown item." });
      }
      if (request.method === "POST" && url.pathname === "/api/label") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; if (body.length > 2000) request.destroy(); });
        return request.on("end", () => {
          try {
            const value = JSON.parse(body);
            const item = byId.get(value.id);
            if (!item) return sendJson(response, 404, { error: "Unknown item." });
            const changed = applyAnnotation(state, item, value.annotation);
            state.updatedAt = new Date().toISOString();
            writeAtomic(output, state);
            return sendJson(response, 200, { annotation: item.annotation, annotations: changed });
          } catch (error) { return sendJson(response, 400, { error: error.message }); }
        });
      }
      return sendJson(response, 404, { error: "Not found." });
    } catch (error) { return sendJson(response, 500, { error: error.message }); }
  });
  server.listen(args.port, host, () => console.log(`Annotate at ${origin}\nLabels: ${path.relative(root, output)}`));
  return server;
}

function usage() {
  return `Usage: node tools/annotate-audio.js [options]\n\n` +
    `  --mode disagreements|whisper-misses|review|triage|golden|deepgram-review|false-fills\n` +
    `                         false-fills uses only runtime predictions from --rules-report\n` +
    `  --rules-report FILE     rules-only evaluator report\n` +
    `  --whisper-report FILE   whisper-only evaluator report\n` +
    `  --false-fill-report FILE prior false-fill labels (triage exclusions)\n` +
    `  --deepgram-triage FILE    optional diagnostic transcript overlay; never labels truth\n` +
    `  --audio-dir DIR         local fixture audio directory\n` +
    `  --output FILE           resumable annotation JSON\n` +
    `  --before N --after N    seconds around each timestamp\n` +
    `  --limit N               cap queue size (0 means all)\n` +
    `  --both-empty-limit N    triage both-empty sample (default 25)\n` +
    `  --port N                localhost port (default 8765)\n`;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) return console.log(usage());
  const deepgramTriage = args.deepgramTriage ? readDeepgramTriage(args.deepgramTriage) : null;
  const rules = args.mode !== "deepgram-review" && fs.existsSync(path.resolve(root, args.rulesReport))
    ? readReport(args.rulesReport, "rules-only") : null;
  const whisper = args.mode === "false-fills" ? null :
    (fs.existsSync(path.resolve(root, args.whisperReport)) ? readReport(args.whisperReport, "whisper-only",
      ["golden", "deepgram-review"].includes(args.mode) ? deepgramTriage?.reportFingerprint : null) : null);
  const falseFillReport = args.mode === "triage" ? path.resolve(root, args.falseFillReport) : null;
  if (args.mode === "false-fills" && !rules) throw new Error("False-fill mode needs --rules-report.");
  if (args.mode === "deepgram-review" && (!deepgramTriage || !whisper)) {
    throw new Error("Deepgram review needs --deepgram-triage and --whisper-report.");
  }
  if (!["golden", "deepgram-review", "false-fills"].includes(args.mode) && (!rules || !whisper)) {
    throw new Error("This mode needs both --rules-report and --whisper-report.");
  }
  if (args.mode === "golden" && !rules && !whisper) throw new Error("Golden mode needs at least one report.");
  const output = path.resolve(root, args.output);
  const annotationReports = ANNOTATION_HISTORY.filter((file) => path.resolve(root, file) !== output);
  const built = buildQueue({ ...args, rules, whisper, deepgramTriage, falseFillReport, annotationReports });
  const state = resume({ schemaVersion: 1, mode: args.mode, createdAt: new Date().toISOString(),
    clip: { before: args.before, after: args.after }, missingAudio: built.missingAudio,
    statusSet: statusSetFor(args.mode),
    selection: built.selection,
    sources: { rules: rules && { path: path.relative(root, rules.path), sha256: rules.sha256 },
      whisper: whisper && { path: path.relative(root, whisper.path), sha256: whisper.sha256 },
      deepgramTriage: deepgramTriage && { path: path.relative(root, deepgramTriage.path), sha256: deepgramTriage.sha256 },
      falseFills: falseFillReport && fs.existsSync(falseFillReport) && { path: path.relative(root, falseFillReport),
        sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(falseFillReport)).digest("hex")}` } }, items: built.items }, output);
  writeAtomic(output, state);
  console.log(`Queue: ${state.items.length}; missing local audio: ${state.missingAudio}`);
  return startServer(state, output, args);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { parseArgs, readReport, readDeepgramTriage, resultMap, categoryFor, buildQueue, readFalseFillReport,
  readAnnotationHistory, validateAnnotation, applyAnnotation, resume, publicState, statusSetFor, html: HTML };
