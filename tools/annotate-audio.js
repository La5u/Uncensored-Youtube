#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { ALLOWED_WORDS } = require("../src/rules");
const { currentFingerprints } = require("./evaluation-metrics");
const timedText = require("../src/timedtext");

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
  bothEmptyLimit: 25,
  groupCaptions: "true",
  priorLabels: null
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
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === "--help" || key === "-h") args.help = true;
    else if (key.startsWith("--") && Object.prototype.hasOwnProperty.call(args, name)) {
      if (argv[i + 1] === undefined) throw new Error(`${key} needs a value.`);
      args[name] = argv[++i];
    } else throw new Error(`Unknown option: ${key}`);
  }
  args.port = Number(args.port);
  args.before = Number(args.before);
  args.after = Number(args.after);
  args.limit = Number(args.limit);
  args.bothEmptyLimit = Number(args.bothEmptyLimit);
  if (!["true", "false"].includes(String(args.groupCaptions))) throw new Error("--group-captions must be true or false.");
  args.groupCaptions = String(args.groupCaptions) === "true";
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
    let report = file;
    if (typeof file === "string") {
      const absolute = path.resolve(root, file);
      if (!fs.existsSync(absolute) || seen.has(absolute)) continue;
      seen.add(absolute);
      report = JSON.parse(fs.readFileSync(absolute, "utf8"));
    }
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
  bothEmptyLimit = 25, falseFillReport, annotationReports = [], groupCaptions = true,
  groupSourceDirectory = path.join(root, "test-fixtures") }) {
  const rulesMap = rules ? resultMap(rules.report) : new Map();
  const whisperMap = whisper ? resultMap(whisper.report) : new Map();
  const deepgramMap = deepgramTriage?.items || new Map();
  // readAnnotationHistory skips files already listed in annotationReports.
  const history = readAnnotationHistory([...annotationReports, falseFillReport].filter(Boolean), mode);
  const excluded = mode === "triage" ? readFalseFillReport(falseFillReport) : null;
  const grouping = groupCaptions && mode !== "false-fills";
  const eligibleKeys = mode === "deepgram-review" ? [...deepgramMap.keys()] :
    mode === "golden" && !rules ? [...whisperMap.keys()] :
    mode === "golden" && !whisper ? [...rulesMap.keys()] :
      mode === "false-fills" ? [...rulesMap.keys()] : [...new Set([...rulesMap.keys(), ...whisperMap.keys()])];
  const fixturesToReview = new Set(eligibleKeys.map((id) => (whisperMap.get(id) || rulesMap.get(id))?.fixture.name));
  const keys = grouping ? [...new Set([...eligibleKeys, ...rulesMap.keys(), ...whisperMap.keys()])]
    .filter((id) => fixturesToReview.has((whisperMap.get(id) || rulesMap.get(id))?.fixture.name)) : eligibleKeys;
  const originalKeys = new Set(eligibleKeys);
  const candidates = [], eligibleIds = new Set();
  const audioIdentities = new Map(), audioPaths = new Map();
  let missingAudio = 0;
  for (const id of keys.sort()) {
    const rulesRow = rulesMap.get(id);
    const whisperRow = whisperMap.get(id);
    if (!rulesRow && !whisperRow) continue;
    const available = mode === "false-fills" ? Boolean(rulesRow) :
      mode === "deepgram-review" ? Boolean(whisperRow) : mode === "golden" || Boolean(rulesRow && whisperRow);
    const excludedSlot = excluded && (excluded.ids.has(id) || excluded.nonEnglishFixtures.has((rulesRow || whisperRow).fixture.name));
    const category = mode === "false-fills" && normalizedWord(rulesRow?.result?.word)
      ? "false-fill" : categoryFor(rulesRow?.result, whisperRow?.result);
    const eligible = originalKeys.has(id) && available && !excludedSlot &&
      (mode === "false-fills" ? Boolean(normalizedWord(rulesRow?.result?.word)) :
        mode === "deepgram-review" || includeCategory(mode, category, whisperRow?.result));
    if (!grouping && !eligible) continue;
    if (rulesRow && whisperRow && Math.abs(Number(rulesRow.result.timeSeconds) -
      Number(whisperRow.result.timeSeconds)) > 0.1) {
      if (!eligible) continue; // An optional sibling must not abort selected-slot review.
      throw new Error(`Reports disagree on the timestamp for ${id}.`);
    }
    if (rulesRow && whisperRow && path.basename(String(rulesRow.fixture.audio || "")) !==
      path.basename(String(whisperRow.fixture.audio || ""))) {
      if (!eligible) continue;
      throw new Error(`Reports disagree on the audio for ${id}.`);
    }
    const row = mode === "false-fills" ? rulesRow : whisperRow || rulesRow;
    const timeSeconds = Number(row.result.timeSeconds);
    if (!Number.isFinite(timeSeconds) || !Number.isInteger(row.result.tokenIndex) || row.result.tokenIndex < 0) {
      if (!eligible) continue;
      throw new Error(`Invalid slot identity or timestamp for ${id}.`);
    }
    const audioKey = `${row.fixture.name}\0${row.fixture.audio || ""}`;
    if (!audioPaths.has(audioKey)) audioPaths.set(audioKey, findAudio(audioDir, row.fixture.name, row.fixture.audio));
    const audioFile = audioPaths.get(audioKey);
    if (!audioFile) {
      if (eligible) missingAudio += 1;
      continue;
    }
    const result = row.result;
    const deepgram = deepgramMap.get(id);
    if (deepgram && Math.abs(deepgram.timeSeconds - timeSeconds) > 0.1) {
      if (!eligible) continue;
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
    if (eligible) eligibleIds.add(id);
    candidates.push({
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
  const items = candidates.filter((item) => eligibleIds.has(item.id));
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
  ordered = groupCaptionItems(candidates, ordered, grouping, groupSourceDirectory);
  return { items: ordered, missingAudio,
    selection: mode === "false-fills" ? { priority: "P0", strategy: "bounded-round-robin-by-word-tier-fixture-rule",
      limit, candidateCount: items.length, selectedCount: ordered.length,
      coverage: { candidateRows: items.length, selectedRows: ordered.length,
        rowFraction: items.length ? ordered.length / items.length : 0,
        dimensions: coverageFor(items, ordered) } } : undefined };
}

function groupCaptionItems(items, selected, enabled, sourceDirectory = path.join(root, "test-fixtures")) {
  const ungrouped = ({ captionGroup, captionSourceSha256, ...item }) => item;
  selected = selected.map(ungrouped);
  if (!enabled || !selected.length) return selected;
  const selectedIds = new Set(selected.map((item) => item.id));
  const byId = new Map(items.map((item) => [item.id, ungrouped(item)]));
  const sources = new Map(), candidates = new Map();
  for (const item of selected) {
    if (!sources.has(item.fixture)) {
      const file = path.join(sourceDirectory, `${item.fixture}_auto.en.json3`);
      let source = null;
      try {
        const raw = fs.readFileSync(file, "utf8");
        const data = timedText.collectTimedTextData(raw, false);
        source = { data, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
      } catch (_) { /* Missing/unreadable source: retain single-slot review. */ }
      sources.set(item.fixture, source);
    }
    const source = sources.get(item.fixture);
    if (!source) continue;
    item.captionSourceSha256 = source.sha256;
    const { data } = source;
    const token = data.tokens.find((row) => row.tokenIndex === item.tokenIndex);
    const event = token && data.timeline.find((row) => row.eventIndex === token.eventIndex);
    // Negated <= also rejects NaN timestamps.
    if (!event || !(Math.abs(token.timeSeconds - item.timeSeconds) <= 0.1)) continue;
    const slots = data.tokens.filter((row) => row.eventIndex === event.eventIndex)
      .sort((left, right) => left.tokenIndex - right.tokenIndex);
    const siblings = slots.map((slot) => byId.get(`${item.fixture}:${slot.tokenIndex}`));
    if (slots.length < 2 || siblings.some((row, index) => !row ||
        !(Math.abs(slots[index].timeSeconds - row.timeSeconds) <= 0.1) ||
        row.audioFile !== item.audioFile || row.audioSha256 !== item.audioSha256)) continue;
    candidates.set(item.id, { event, slots, siblings, sourceSha256: source.sha256,
      key: `${item.fixture}:${event.eventIndex}` });
  }
  const emitted = new Set(), result = [];
  for (const item of selected) {
    const info = candidates.get(item.id);
    if (!info) { result.push(item); continue; }
    if (emitted.has(info.key)) continue;
    emitted.add(info.key);
    const id = `caption:${crypto.createHash("sha1").update(info.key).digest("hex").slice(0, 12)}`;
    for (const sibling of info.siblings) {
      sibling.captionSourceSha256 = info.sourceSha256;
      sibling.captionGroup = { id, eventIndex: info.event.eventIndex, text: info.event.text,
        slots: info.slots.map((slot) => slot.tokenIndex),
        expandedSelection: !selectedIds.has(sibling.id) };
      result.push(sibling);
    }
  }
  return result;
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
  if (!STATUS_SETS.default.includes(annotation.status)) {
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
    if (saved.fixture !== item.fixture || saved.tokenIndex !== item.tokenIndex || saved.timeSeconds !== item.timeSeconds ||
        saved.captionSourceSha256 !== item.captionSourceSha256 ||
        JSON.stringify(saved.captionGroup) !== JSON.stringify(item.captionGroup)) {
      throw new Error(`Existing annotation file has different caption identity for ${item.id}; choose another --output.`);
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
  if (item.captionGroup) throw new Error("Grouped caption slots require a complete caption batch.");
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

function applyCaptionBatch(state, groupId, labels, edits = []) {
  if (state.mode === "false-fills") throw new Error("False-fill sessions cannot use caption batches.");
  if (typeof groupId !== "string" || !Array.isArray(labels) || !labels.length) throw new Error("Caption batch must label every slot.");
  const members = state.items.filter((item) => item.captionGroup?.id === groupId)
    .sort((left, right) => left.tokenIndex - right.tokenIndex);
  if (!members.length || members.length !== labels.length) throw new Error("Caption batch has incomplete or invalid slot coverage.");
  if (!Array.isArray(edits)) throw new Error("Invalid saved-label edits.");
  const editable = new Set();
  for (const edit of edits) {
    const item = members.find((member) => member.id === edit?.id);
    if (!item || editable.has(edit.id) || JSON.stringify(item.annotation) !== JSON.stringify(edit.previous)) {
      throw new Error("Saved label changed; reload before correcting it.");
    }
    editable.add(edit.id);
  }
  const supplied = new Map();
  for (const row of labels) {
    if (!row || typeof row.id !== "string" || supplied.has(row.id)) throw new Error("Caption batch has duplicate or invalid slots.");
    const item = members.find((candidate) => candidate.id === row.id);
    if (!item) throw new Error("Caption batch cannot include a slot from another group.");
    const annotation = validateAnnotation(JSON.parse(JSON.stringify(row.annotation || null)));
    if (FALSE_FILL_STATUSES.includes(annotation.status)) throw new Error("Caption batches require audio annotation statuses.");
    if (annotation.status === "pending") throw new Error("Caption batch labels must be completed.");
    if (item.annotation.status !== "pending" && !editable.has(item.id) && JSON.stringify(item.annotation) !== JSON.stringify(row.annotation)) {
      throw new Error(`Refusing to overwrite reviewed slot ${row.id}.`);
    }
    supplied.set(row.id, annotation);
  }
  // Equal lengths, unique ids and group membership imply every member is covered.
  for (const item of members) {
    if (item.annotation.status === "pending" || editable.has(item.id)) item.annotation = supplied.get(item.id);
  }
  return members.map(({ id, annotation }) => ({ id, annotation }));
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

function verifiedAudio(item, cache) {
  const audioFile = path.resolve(root, item.audioFile);
  const stat = fs.statSync(audioFile);
  const signature = (value) => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(":");
  let checked = cache.get(audioFile);
  if (!checked || checked.signature !== signature(stat)) {
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(audioFile)).digest("hex");
    if (signature(fs.statSync(audioFile)) !== signature(stat)) throw new Error("Audio changed while being verified.");
    checked = { signature: signature(stat), sha256 };
    cache.set(audioFile, checked);
  }
  return { audioFile, stat, actualSha256: checked.sha256 };
}

function serveAudio(request, response, item, cache) {
  // Browser range requests must not rehash a whole recording on every seek.
  // ctime also invalidates same-size edits whose mtime was restored.
  const { audioFile, stat, actualSha256 } = verifiedAudio(item, cache);
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
:root{font:16px system-ui;color:#eee;background:#151515}body{max-width:900px;margin:24px auto;padding:0 16px}button,input{font:inherit}button{padding:10px 14px;margin:4px;border:0;border-radius:6px;cursor:pointer}button:disabled{cursor:not-allowed;opacity:.45}[hidden]{display:none!important}.primary{background:#58a6ff}.selected{background:#8b5cf6;color:#fff}.active-slot{border-left:3px solid #58a6ff;padding-left:8px}.negative{background:#e59b45}.muted{color:#aaa}.transcript{color:#aaa;font-size:.88rem;line-height:1.35}.prediction{color:#aaa;user-select:none}.context{font-size:1.45rem;line-height:1.5;background:#242424;padding:18px;border-radius:8px}audio{display:none}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.timeline{flex:1;min-width:260px}.rule-box{margin:12px 0;padding:10px;background:#202020;border-radius:8px}input{padding:9px;background:#242424;color:#fff;border:1px solid #666;border-radius:5px}#word{min-width:240px}#manualRule{min-width:300px}.grow{flex:1}details{margin:16px 0;background:#202020;padding:10px}pre{white-space:pre-wrap}.done{color:#72d572}@media(max-width:600px){body{margin:10px auto}.context{font-size:1.15rem}}
</style><h1>Uncensored audio labels</h1><div id="progress" class="muted"></div><h2>Target caption</h2><p id="context" class="context"></p><details><summary>Surrounding captions</summary><p id="surrounding"></p><p class="muted">Surrounding text is not expected in the 4s clip.</p></details>
<audio id="audio" preload="metadata"></audio><div class="row"><button id="play" class="primary">▶ Play near word (Space)</button><button id="wide" hidden>Replay full context</button><span id="kind" class="muted"></span></div>
<details id="asr"><summary>Show ASR transcripts after listening (unverified)</summary><p id="transcript" class="transcript"></p><p id="deepgram" class="transcript"></p></details><div id="predicted" class="row"></div><details><summary>More model details</summary><pre id="models"></pre></details>
<section id="groupControls" hidden><h3>Caption event · numbered slots</h3><p id="groupCaption" class="muted"></p><p class="muted">Choose a status and word for each pending slot. The sequence box fills editable swear slots, in order. Enter moves to the next empty word, then submits the caption when all slots are ready. Quick words and rule recommendations target the active slot. Skip leaves reviewed labels untouched. To correct an earlier label, click Edit saved labels, make your changes, then Save all.</p><div id="groupSlots"></div><div class="row"><input id="groupWords" class="grow" placeholder="word1, word2, word3"><button id="saveGroup" class="primary">Save all caption slots</button><button id="editGroup">Edit saved labels</button><button id="cancelEdit" hidden>Cancel edits</button></div></section>
<div id="standardControls" class="row"><input id="word" list="words" placeholder="Type or select swear" autocomplete="off"><datalist id="words"></datalist><button id="save" class="primary">Save swear (Enter)</button><button id="rulesWord" class="primary">Use Rules word (R)</button><button id="none" class="negative">No swear in audio</button><button id="wrong" class="negative">Wrong audio fragment</button><button id="nonenglish" class="negative">Not English audio</button></div>
<div id="falseFillControls" hidden><p class="muted">False-fill label: listen first; do not treat the caption/model word as ground truth.</p><div class="row"><label>Actually spoken word <input id="spokenWord" placeholder="word (if audible)" autocomplete="off"></label><label>Confidence <select id="confidence"><option selected>high</option><option>medium</option><option>low</option><option>unknown</option></select></label><label>Timing offset (s) <input id="timingOffset" type="number" step="0.01" placeholder="none"></label></div><div class="row"><button id="falseRulesCorrect" class="primary">Rules correct (R)</button><button id="genuine" class="primary">Genuine profanity</button><button id="ordinary" class="primary">Ordinary word</button><button id="falseWrong" class="negative">Wrong audio fragment (W)</button><button id="silence" class="negative">Silence / no word (S)</button><button id="falseNonEnglish" class="negative">Non-English (N)</button><button id="uncertain" class="negative">Unusable / uncertain (U)</button></div></div>
<div id="common" class="row"></div><div id="ruleBox" class="rule-box"><span>Optional rule recommendation:</span><div class="row"><button id="precise">Precise / word-for-word</button><button id="general">General pattern</button><button id="manual">Manual rule…</button><input id="manualRule" class="grow" placeholder="Type the rule" hidden><button id="clearRule" hidden>Clear</button></div></div><div class="row"><input id="note" class="grow" placeholder="Optional note"><button id="prev">← Previous</button><button id="skip" class="negative">Unsure / skip (U) →</button></div><p id="message"></p>
<script>
let state,index=0,end=0,wideUsed=false,ruleKind=null,saving=false,groupFields=[],activeGroupField=null,editingReviewed=false;const $=id=>document.getElementById(id),frequency=word=>state.frequencies[word]||0;
function setFalseFillView(){const active=state.mode==='false-fills',grouped=Boolean(state.items[index]?.captionGroup);$('falseFillControls').hidden=!active;$('standardControls').hidden=active;$('word').hidden=grouped;$('save').hidden=grouped;$('groupControls').hidden=active||!grouped;$('common').hidden=active;$('ruleBox').hidden=active;$('skip').hidden=active;$('skip').textContent=grouped?'Unsure / skip remaining slots (U) →':'Unsure / skip (U) →';$('none').textContent=grouped?(editingReviewed?'No swear in caption':'No swear in remaining slots'):'No swear in audio';$('wrong').textContent=grouped?(editingReviewed?'Wrong caption fragment':'Wrong fragment (remaining slots)'):'Wrong audio fragment';$('nonenglish').textContent=grouped?(editingReviewed?'Not English caption':'Not English (remaining slots)'):'Not English audio';$('note').hidden=grouped}
function falseLabel(status,spokenWord=$('spokenWord').value.trim()||null){const raw=$('timingOffset').value.trim();return {status,word:null,spokenWord,confidence:$('confidence').value,timingOffsetSeconds:raw===''?null:Number(raw),note:$('note').value}}
function sortedWords(){return [...state.words].sort((a,b)=>frequency(b)-frequency(a)||state.words.indexOf(a)-state.words.indexOf(b))}
function completeWord(value){value=value.trim().toLowerCase();return sortedWords().find(word=>word.startsWith(value)&&word!==value)}
function wordButton(word,text){const button=document.createElement('button');button.className='primary';button.textContent=text;button.onclick=()=>label({status:'swear',word,note:$('note').value});return button}
function refreshWords(){const words=sortedWords();$('words').replaceChildren(...words.map(word=>{const option=document.createElement('option');option.value=word;option.label=frequency(word)?word+' · '+frequency(word):word;return option}));const empty=Boolean(state.items[index]?.captionGroup)||!$('word').value.trim();$('common').replaceChildren(...(empty?words.filter(word=>frequency(word)).slice(0,10).map(word=>wordButton(word,word+' · '+frequency(word))):[]))}
async function init(){state=await fetch('/api/state').then(r=>r.json());const first=state.items.findIndex(x=>x.annotation.status==='pending');index=first<0?Math.max(0,state.items.length-1):first;show()} 
function show(auto=false){editingReviewed=false;const item=state.items[index];if(!item){$('context').textContent='No matching items with local audio.';return}setFalseFillView();$('asr').open=false;$('predicted').hidden=state.mode==='deepgram-review';$('wide').hidden=state.mode!=='deepgram-review';$('play').textContent=item.captionGroup?'▶ Play caption group (Space)':'▶ Play near word (Space)';$('progress').textContent=(index+1)+' / '+state.items.length+' · '+state.items.filter(x=>x.annotation.status!=='pending').length+' reviewed · '+state.items.filter(x=>x.annotation.ruleRecommendation).length+' rule recommendations'+(state.missingAudio?' · '+state.missingAudio+' skipped without audio':'');const chosen=String(item.rules?.word||'').trim(),candidates=(item.rules?.candidates||[]).filter(word=>word&&word!==chosen),caption=chosen?chosen:candidates.join('|');$('context').textContent=item.captionGroup?item.captionGroup.text:(caption?item.context.replace('[__]','['+caption+']'):item.context);if(item.captionGroup)showCaptionGroup(item);$('surrounding').textContent=item.reviewContext||'';$('kind').textContent=item.category;const audio=$('audio');audio.onloadedmetadata=auto?()=>{audio.onloadedmetadata=null;play()}:null;audio.src='/audio/'+encodeURIComponent(item.id)+'?v='+encodeURIComponent(item.audioVersion);$('word').value=item.annotation.word||'';$('spokenWord').value=item.annotation.spokenWord||'';$('confidence').value=item.annotation.status==='pending'?'high':(item.annotation.confidence||'unknown');$('timingOffset').value=item.annotation.timingOffsetSeconds??'';$('note').value=item.annotation.note||'';wideUsed=Boolean(item.annotation.widePlayed);ruleKind=item.annotation.ruleRecommendation?.kind||null;$('manualRule').value=item.annotation.ruleRecommendation?.rule||'';refreshRule();const rulesWord=state.words.includes(item.rules?.word)?item.rules.word:null;$('rulesWord').disabled=!rulesWord;$('rulesWord').textContent=rulesWord?'Use Rules: '+rulesWord+' (R)':'No Rules word (R)';$('falseRulesCorrect').disabled=!item.rules?.word;$('transcript').textContent=item.whisper?.transcript?'Whisper: '+item.whisper.transcript:'';const deepgram=item.deepgramTranscript||(item.captionGroup?groupMembers(item).find(member=>member.deepgramTranscript)?.deepgramTranscript:null);$('deepgram').textContent=deepgram?'Deepgram ASR (unverified; listen to the audio): '+deepgram:'';$('models').textContent=JSON.stringify({rules:item.rules,whisper:item.whisper,deepgramTranscript:item.deepgramTranscript},null,2);showPredictions(item);refreshWords();$('message').textContent=item.annotation.status==='pending'?'':('Saved: '+item.annotation.status+(item.annotation.word?' — '+item.annotation.word:''));if(item.captionGroup&&activeGroupField)selectGroupField(activeGroupField)}
function showPredictions(item){
  const guesses=new Map,add=(name,word)=>{if(state.words.includes(word))guesses.set(word,[...(guesses.get(word)||[]),name])};
  if(state.mode!=='false-fills'){add('Rules',item.rules?.word);for(const word of item.rules?.candidates||[])add('Rule candidate',word);add('Whisper',item.whisper?.word)}
  $('predicted').replaceChildren(...[...guesses].sort((a,b)=>frequency(b[0])-frequency(a[0])).map(([word,names])=>wordButton(word,names.join(' + ')+': '+word)));
}
function groupMembers(item){return state.items.filter(x=>x.captionGroup?.id===item.captionGroup.id).sort((a,b)=>a.tokenIndex-b.tokenIndex)}
function eventKey(item){return item.captionGroup?.id||item.id}
function previousEvent(){
  if(saving||!index)return;
  const current=eventKey(state.items[index]);
  let previous=index-1;
  while(previous>=0&&eventKey(state.items[previous])===current)previous--;
  if(previous<0)return;
  const key=eventKey(state.items[previous]);
  while(previous>0&&eventKey(state.items[previous-1])===key)previous--;
  index=previous;show(true);
}
function nextPendingEvent(){
  const current=eventKey(state.items[index]);
  const next=state.items.findIndex((x,i)=>i>index&&eventKey(x)!==current&&x.annotation.status==='pending');
  const earlier=next<0?state.items.findIndex(x=>eventKey(x)!==current&&x.annotation.status==='pending'):next;
  if(earlier>=0)index=earlier;
  show(earlier>=0);
}
function recountWords(){
  state.frequencies={};
  for(const item of state.items)if(item.annotation.status==='swear')state.frequencies[item.annotation.word]=(state.frequencies[item.annotation.word]||0)+1;
}
function showCaptionGroup(item){
  const members=groupMembers(item);
  $('groupCaption').textContent=members.length+' ordered slots · Save all to apply local changes';
  groupFields=members.map((slot,i)=>{
    const row=document.createElement('div');row.className='row';
    const title=document.createElement('span');title.textContent=(i+1)+'. '+slot.id;
    const word=document.createElement('input');word.setAttribute('list','words');word.placeholder='Heard word';word.value=slot.annotation.word||'';
    const status=document.createElement('select');
    for(const value of state.statusSet){const option=document.createElement('option');option.value=value;option.textContent=value;status.append(option)}
    const completed=slot.annotation.status!=='pending'&&!editingReviewed;
    const note=document.createElement('input');note.placeholder='Optional note / unsupported heard word';note.value=slot.annotation.note||'';note.maxLength=500;note.readOnly=completed;note.hidden=completed&&!note.value;
    status.value=slot.annotation.status==='pending'?'swear':slot.annotation.status;status.disabled=completed;word.readOnly=completed;
    status.onchange=()=>{word.disabled=status.value!=='swear'};
    word.disabled=status.value!=='swear';
    const field={slot,row,word,status,note,ruleRecommendation:slot.annotation.ruleRecommendation||null};
    for(const input of [word,status,note])input.onfocus=()=>selectGroupField(field);
    for(const input of [word,note])input.addEventListener('keydown',event=>{
      if(event.key==='Enter'){event.preventDefault();enterGroupField(field)}
      else if(input===word&&event.key==='Tab'&&word.value.trim()){
        const match=completeWord(word.value);
        if(match){event.preventDefault();word.value=match}
      }
    });
    row.append(title,word,status,note);return field;
  });
  $('groupSlots').replaceChildren(...groupFields.map(field=>field.row));
  activeGroupField=groupFields.find(editableField)||null;
  $('groupWords').value='';
  $('groupWords').disabled=$('saveGroup').disabled=!editingReviewed&&members.every(x=>x.annotation.status!=='pending');
  $('editGroup').hidden=editingReviewed||members.every(x=>x.annotation.status==='pending');$('cancelEdit').hidden=!editingReviewed;
}
function editableField(field){return editingReviewed||field.slot.annotation.status==='pending'}
function captionGroupLabels(){
  const swearFields=groupFields.filter(field=>editableField(field)&&field.status.value==='swear');
  const sequence=$('groupWords').value.trim().toLowerCase().split(/[\\s,]+/u).filter(Boolean);
  if(sequence.length){
    if(sequence.length!==swearFields.length)throw Error('Enter exactly one word per pending swear slot, in order.');
    swearFields.forEach((field,i)=>{field.word.value=sequence[i]});
  }
  return groupFields.map(({slot,word,status,note},i)=>{
    if(!editingReviewed&&slot.annotation.status!=='pending')return {id:slot.id,annotation:slot.annotation};
    if(slot.annotation.status!=='pending'&&status.value===slot.annotation.status&&word.value.trim().toLowerCase()===(slot.annotation.word||'')&&note.value===(slot.annotation.note||'')&&JSON.stringify(fieldRecommendation(slot.id))===JSON.stringify(slot.annotation.ruleRecommendation||null))return {id:slot.id,annotation:slot.annotation};
    if(status.value==='pending')throw Error('Choose a completed status for slot '+(i+1)+'.');
    const value=word.value.trim().toLowerCase();
    if(status.value==='swear'&&!state.words.includes(value))throw Error('Select a supported swear word for slot '+(i+1)+'.');
    return {id:slot.id,annotation:{...slot.annotation,status:status.value,word:status.value==='swear'?value:null,note:note.value,widePlayed:Boolean(slot.annotation.widePlayed||wideUsed),ruleRecommendation:status.value==='swear'?fieldRecommendation(slot.id):null}};
  });
}
function fieldRecommendation(id){return groupFields.find(field=>field.slot.id===id)?.ruleRecommendation||null}
function enterGroupField(field){
  if(saving)return;
  if(editableField(field)&&field.status.value==='swear'&&!state.words.includes(field.word.value.trim().toLowerCase())){
    $('message').textContent='Select a supported swear word for this slot.';return;
  }
  const missing=groupFields.find(candidate=>editableField(candidate)&&candidate.status.value==='swear'&&!candidate.word.value.trim());
  if(missing){selectGroupField(missing);missing.word.focus();$('message').textContent='Fill the next word, then Enter submits the caption.';return}
  return saveCaptionGroup();
}
function selectGroupField(field){
  if(!editableField(field))return;
  activeGroupField=field;ruleKind=field.ruleRecommendation?.kind||null;
  for(const candidate of groupFields)candidate.row.className=candidate===field?'row active-slot':'row';
  showPredictions(field.slot);
  $('models').textContent=JSON.stringify({rules:field.slot.rules,whisper:field.slot.whisper},null,2);
  $('manualRule').value=field.ruleRecommendation?.rule||'';refreshRule();
  $('groupCaption').textContent=groupFields.length+' ordered slots · quick words and rule recommendations target slot '+(groupFields.indexOf(field)+1);
  const word=field.slot.rules?.word;
  $('rulesWord').disabled=!state.words.includes(word);$('rulesWord').textContent=state.words.includes(word)?'Use Rules: '+word+' (R)':'No Rules word (R)';
}
function setGroupWord(word){
  if(saving||!state.words.includes(word))return;
  const field=activeGroupField||groupFields.find(editableField);
  if(!field||!editableField(field))return;
  field.status.value='swear';field.status.onchange();field.word.value=word;
  $('groupWords').value='';
  const next=groupFields.find(candidate=>editableField(candidate)&&!candidate.word.value.trim());
  selectGroupField(next||field);(next||field).word.focus();
}
function setGroupStatus(status){
  if(saving)return;
  const targets=groupFields.filter(field=>status==='skipped'?field.slot.annotation.status==='pending':editableField(field));
  if(!targets.length)return nextPendingEvent();
  $('groupWords').value='';
  for(const field of targets){field.status.value=status;field.status.onchange();}
  return saveCaptionGroup();
}
async function saveCaptionGroup(){
  if(saving||!state.items[index]?.captionGroup||$('saveGroup').disabled)return;
  saving=true;$('saveGroup').disabled=true;
  try{
    const labels=captionGroupLabels(),groupId=state.items[index].captionGroup.id;
    const response=await fetch('/api/caption-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId,labels,edits:editingReviewed?groupFields.filter(field=>field.slot.annotation.status!=='pending').map(field=>({id:field.slot.id,previous:field.slot.annotation})):[]})}),body=await response.json();
    if(!response.ok)throw Error(body.error);
    for(const change of body.annotations)state.items.find(x=>x.id===change.id).annotation=change.annotation;
    recountWords();nextPendingEvent();
  }catch(error){$('message').textContent=error.message}
  finally{saving=false;$('saveGroup').disabled=!state.items[index]?.captionGroup||(!editingReviewed&&groupMembers(state.items[index]).every(x=>x.annotation.status!=='pending'))}
}
function refreshRule(){for(const kind of ['precise','general','manual'])$(kind).className=ruleKind===kind?'selected':'';const manual=ruleKind==='manual';$('manualRule').hidden=!manual;$('clearRule').hidden=!ruleKind;if(manual&&!state.items[index]?.captionGroup)setTimeout(()=>$('manualRule').focus(),0)}
function selectRule(kind){ruleKind=ruleKind===kind?null:kind;if(state.items[index]?.captionGroup&&activeGroupField)activeGroupField.ruleRecommendation=recommendation();refreshRule();if(ruleKind==='manual')$('manualRule').focus()}
function recommendation(){return ruleKind?{kind:ruleKind,rule:ruleKind==='manual'?$('manualRule').value:null}:null}
function playbackRange(item,full=false){
  if(item.captionGroup){
    const members=groupMembers(item),start=Math.min(...members.map(x=>x.clipStart)),end=Math.max(...members.map(x=>x.clipEnd));
    return full?[start,end]:[Math.max(start,Math.min(...members.map(x=>x.timeSeconds))-1),Math.min(end,Math.max(...members.map(x=>x.timeSeconds))+2.5)];
  }
  const focused=state.mode==='deepgram-review'&&!full;
  return [focused?Math.max(item.clipStart,item.timeSeconds-1):item.category==='false-fill'&&!full?Math.max(0,item.timeSeconds-.5):item.clipStart,focused?Math.min(item.clipEnd,item.timeSeconds+2.5):item.clipEnd];
}
function play(full=false){const a=$('audio'),item=state.items[index];a.playbackRate=1;[a.currentTime,end]=playbackRange(item,full);if(full)wideUsed=true;a.play().catch(error=>$('message').textContent='Playback failed: '+error.message)}
$('audio').addEventListener('timeupdate',()=>{if($('audio').currentTime>=end)$('audio').pause()});$('play').onclick=()=>play();$('wide').onclick=()=>play(true);$('prev').onclick=previousEvent;$('skip').onclick=()=>label(state.mode==='false-fills'?falseLabel('uncertain'):{status:'skipped',word:null,note:$('note').value});
async function label(annotation){if(saving)return;if(state.items[index]?.captionGroup)return annotation.status==='swear'?setGroupWord(annotation.word):setGroupStatus(annotation.status);saving=true;annotation.widePlayed=wideUsed;annotation.ruleRecommendation=annotation.status==='swear'?recommendation():null;try{const response=await fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:state.items[index].id,annotation})}),body=await response.json();if(!response.ok){$('message').textContent=body.error;return}for(const change of body.annotations)state.items.find(x=>x.id===change.id).annotation=change.annotation;recountWords();const next=state.items.findIndex((x,i)=>i>index&&x.annotation.status==='pending');if(next>=0){index=next;show(true)}else if(index<state.items.length-1){index++;show(true)}else show()}finally{saving=false}}
$('falseRulesCorrect').onclick=()=>{const word=String(state.items[index].rules?.word||'').toLowerCase().trim();if(word)label(falseLabel('genuine-profanity',word))};$('genuine').onclick=()=>label(falseLabel('genuine-profanity'));$('ordinary').onclick=()=>label(falseLabel('ordinary-word'));$('falseWrong').onclick=()=>label(falseLabel('alignment-mismatch'));$('silence').onclick=()=>label(falseLabel('no-corresponding-word'));$('falseNonEnglish').onclick=()=>label(falseLabel('non-english'));$('uncertain').onclick=()=>label(falseLabel('uncertain'));$('precise').onclick=()=>selectRule('precise');$('general').onclick=()=>selectRule('general');$('manual').onclick=()=>selectRule('manual');$('clearRule').onclick=()=>{ruleKind=null;if(state.items[index]?.captionGroup&&activeGroupField)activeGroupField.ruleRecommendation=null;refreshRule()};$('manualRule').addEventListener('input',()=>{if(state.items[index]?.captionGroup&&activeGroupField&&ruleKind==='manual')activeGroupField.ruleRecommendation=recommendation()});$('editGroup').onclick=()=>{if(saving)return;editingReviewed=true;setFalseFillView();showCaptionGroup(state.items[index]);if(activeGroupField)selectGroupField(activeGroupField);$('message').textContent='Editing saved labels. Changes are not saved until Save all.'};$('cancelEdit').onclick=()=>{if(!saving)show()};$('saveGroup').onclick=saveCaptionGroup;$('groupWords').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();saveCaptionGroup()}});$('save').onclick=()=>label({status:'swear',word:$('word').value.trim().toLowerCase(),note:$('note').value});$('rulesWord').onclick=()=>{const word=(state.items[index].captionGroup?activeGroupField?.slot:state.items[index]).rules?.word;if(state.words.includes(word))label({status:'swear',word,note:$('note').value})};$('none').onclick=()=>label({status:'no-swear-in-audio',word:null,note:$('note').value});$('wrong').onclick=()=>label({status:'wrong-audio-fragment',word:null,note:$('note').value});$('nonenglish').onclick=()=>label({status:'not-english',word:null,note:$('note').value});$('word').addEventListener('input',refreshWords);$('word').addEventListener('keydown',e=>{if(e.key==='Enter')$('save').click();else if(e.key==='Tab'&&e.target.value.trim()){const match=completeWord($('word').value);if(match){e.preventDefault();$('word').value=match;refreshWords()}}});$('spokenWord').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.target.blur()}else if(e.key==='Enter'&&e.target.value.trim())$('genuine').click()});document.addEventListener('keydown',e=>{if(e.key==='/'&&!state.items[index]?.captionGroup&&!e.target.matches('input,textarea,[contenteditable]')){e.preventDefault();$('spokenWord').focus();$('spokenWord').select();return}if(e.target.matches('input,textarea,select,[contenteditable]'))return;if(state.items[index]?.captionGroup){if(e.key===' '){e.preventDefault();play()}else if(e.key==='Enter'&&!e.target.matches('button')){e.preventDefault();saveCaptionGroup()}else if(e.key.toLowerCase()==='u')$('skip').click();else if(e.key.toLowerCase()==='r')$('rulesWord').click();else if(e.key==='ArrowLeft')previousEvent();return;}if(e.key==='Enter'&&state.mode==='false-fills'&&!e.target.matches('select,button'))return $('falseRulesCorrect').click();if(e.key===' ') {e.preventDefault();play()}else if(e.key.toLowerCase()==='r'){(state.mode==='false-fills'?$('falseRulesCorrect'):$('rulesWord')).click()}else if(e.key.toLowerCase()==='w'&&state.mode==='false-fills')$('falseWrong').click();else if(e.key.toLowerCase()==='s'&&state.mode==='false-fills')$('silence').click();else if(e.key.toLowerCase()==='n'&&state.mode==='false-fills')$('falseNonEnglish').click();else if(e.key.toLowerCase()==='u')$('skip').click();else if(e.key==='ArrowLeft')$('prev').click()});init();
</script>`;

function startServer(state, output, args) {
  const host = "127.0.0.1";
  const origin = `http://${host}:${args.port}`;
  const byId = new Map(state.items.map((item) => [item.id, item]));
  const audioChecks = new Map();
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
        return item ? serveAudio(request, response, item, audioChecks) : sendJson(response, 404, { error: "Unknown item." });
      }
      const update = (limit, apply) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; if (body.length > limit) request.destroy(); });
        request.on("end", () => {
          const snapshot = state.items.map((item) => item.annotation);
          try {
            const annotations = apply(JSON.parse(body));
            state.updatedAt = new Date().toISOString();
            writeAtomic(output, state);
            sendJson(response, 200, { annotations });
          } catch (error) {
            state.items.forEach((item, index) => { item.annotation = snapshot[index]; });
            sendJson(response, 400, { error: error.message });
          }
        });
      };
      if (request.method === "POST" && url.pathname === "/api/caption-batch") {
        return update(10000, (value) => applyCaptionBatch(state, value.groupId, value.labels, value.edits));
      }
      if (request.method === "POST" && url.pathname === "/api/label") {
        return update(2000, (value) => {
          if (!byId.has(value.id)) throw new Error("Unknown item.");
          return applyAnnotation(state, byId.get(value.id), value.annotation);
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
    `  --group-captions true|false group exact source caption events (default true; false-fills remains per-slot)\n` +
    `  --prior-labels FILE     seed labels from a reviewed annotation queue\n` +
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
  if (args.priorLabels) annotationReports.push(args.priorLabels);
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

module.exports = { parseArgs, readReport, readDeepgramTriage, categoryFor, buildQueue, validateAnnotation,
  applyAnnotation, applyCaptionBatch, resume, publicState, statusSetFor, groupCaptionItems, verifiedAudio, html: HTML };
