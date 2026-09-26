#!/usr/bin/env node
"use strict";

// This is deliberately a discovery corpus, not another faithful/evaluation
// dataset.  It reads only explicitly saved pairs, and never edits a report or
// a fixture.  The timed-text and alignment code remains the authority for
// assigning labels; the code below only makes larger, sentence-aware views.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const timedText = require("../src/timedtext");
const { align, eventText, groundTruthWords, manualSwearEvents } = require("./evaluation-alignment");
const { classifyPairKind } = require("./download-paired-captions");
const { reportEvidenceStatus } = require("./audit-caption-corpus");

const root = path.join(__dirname, "..");
const MARKER = /\[\s*__\s*\]/gu;
const WORD = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/gu;
const PAIR_CLASSES = new Set(["manual-auto", "synthetic", "auto-auto", "unknown", "conflict"]);
const INDEX_CLASSES = new Set(["manual-auto", "synthetic"]);
const DISCOVERY_ALGORITHM_VERSION = 2;
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "u.s", "no"
]);

const text = (value) => typeof value === "string" ? value.trim() : "";
const compare = (a, b) => String(a).localeCompare(String(b));
const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const hash = (value) => `sha256:${sha(value)}`;
const markerCount = (value) => (String(value || "").match(MARKER) || []).length;
const VOLATILE_REPORT_KEYS = new Set([
  "generatedat", "finishedat", "startedat", "updatedat", "createdat", "clock", "walltime"
]);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) =>
    !VOLATILE_REPORT_KEYS.has(key.toLowerCase()))
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

function positive(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function wordsIn(value, offset = 0) {
  WORD.lastIndex = 0;
  return [...String(value || "").matchAll(WORD)].map((match) => ({
    text: match[0], start: offset + match.index, end: offset + match.index + match[0].length
  }));
}

function markerMatches(value, offset = 0) {
  MARKER.lastIndex = 0;
  return [...String(value || "").matchAll(MARKER)].map((match) => ({
    text: match[0], start: offset + match.index, end: offset + match.index + match[0].length
  }));
}

function sentenceRanges(value) {
  const source = String(value || "");
  const ranges = [];
  let start = 0;
  let acceptedBoundaries = 0;
  const boundary = /[.!?]+/gu;
  let match;
  while ((match = boundary.exec(source))) {
    let end = match.index + match[0].length;
    while (end < source.length && `\"'’”)}]`.includes(source[end])) end += 1;
    if (end < source.length && !/\s/u.test(source[end])) continue;
    let before = source.slice(start, end).trim();
    while (before && `\"'’”)}]`.includes(before.at(-1))) before = before.slice(0, -1).trimEnd();
    const lastRaw = before.match(/[A-Za-z](?:[A-Za-z.]*)$/u)?.[0]?.toLowerCase() || "";
    const last = lastRaw.replace(/\.$/u, "");
    if (last && ABBREVIATIONS.has(last)) continue;
    ranges.push({ start, end });
    acceptedBoundaries += 1;
    start = end;
  }
  if (start < source.length || !ranges.length) ranges.push({ start, end: source.length });
  const result = ranges.filter((range) => range.end > range.start);
  result.reliable = acceptedBoundaries > 0;
  return result;
}

function contextShape(value) {
  return String(value || "").normalize("NFKC").replace(MARKER, "[__]")
    .replace(/\s+/gu, " ").trim().toLowerCase();
}

// Union the target sentence with the target's word window, not whole adjacent
// sentences. Punctuation is a heuristic; original source text is never rewritten.
function deriveContext(source, markerOffset, options = {}) {
  const minimumWords = positive(options.words ?? 4, "words");
  const maxWords = positive(options.maxWords ?? 120, "maxWords");
  if (maxWords < minimumWords * 2) {
    throw new Error("maxWords must be at least twice words.");
  }
  const value = String(source || "");
  const marker = Number(markerOffset);
  if (!Number.isSafeInteger(marker) || marker < 0 || marker > value.length) {
    throw new Error("markerOffset must be a valid character offset.");
  }
  const markerText = value.slice(marker).match(/^\[\s*__\s*\]/u)?.[0];
  if (!markerText) throw new Error("markerOffset must point to a censored marker.");
  const markerEnd = marker + markerText.length;
  const allWords = options.prepared?.words || wordsIn(value);
  const ranges = options.prepared?.sentences || sentenceRanges(value);
  const sentenceIndex = ranges.findIndex((range) => marker >= range.start && marker <= range.end);
  const range = ranges[sentenceIndex];
  let fallback = false;
  let start;
  let end;
  const before = allWords.filter((word) => word.end <= marker);
  const after = allWords.filter((word) => word.start >= markerEnd);
  start = before[Math.max(0, before.length - minimumWords)]?.start ?? marker;
  end = after[Math.min(minimumWords - 1, after.length - 1)]?.end ?? markerEnd;
  if (!range || !ranges.reliable) fallback = true;
  else {
    start = Math.min(start, range.start);
    end = Math.max(end, range.end);
  }

  let candidateWords = allWords.filter((word) => word.start >= start && word.end <= end);
  let truncated = false;
  if (candidateWords.length > maxWords) {
    truncated = true;
    const beforeCount = candidateWords.filter((word) => word.end <= marker).length;
    let first = Math.max(0, beforeCount - Math.floor(maxWords / 2));
    let last = Math.min(candidateWords.length, first + maxWords);
    if (last - first < maxWords) first = Math.max(0, last - maxWords);
    start = candidateWords[first]?.start ?? marker;
    end = candidateWords[last - 1]?.end ?? marker;
    // The marker is not a WORD match, so explicitly keep it when the cap is
    // reached at either edge.
    start = Math.min(start, marker);
    end = Math.max(end, markerEnd);
    candidateWords = allWords.filter((word) => word.start >= start && word.end <= end);
  }
  let contextStart = start;
  let contextEnd = end;
  while (contextStart < contextEnd && /\s/u.test(value[contextStart])) contextStart += 1;
  while (contextEnd > contextStart && /\s/u.test(value[contextEnd - 1])) contextEnd -= 1;
  if (marker < contextStart) contextStart = marker;
  if (markerEnd > contextEnd) contextEnd = markerEnd;
  const context = value.slice(contextStart, contextEnd);
  return {
    context,
    shape: contextShape(context),
    offset: contextStart,
    span: context.length,
    truncated,
    fallback,
    wordCount: wordsIn(context).length,
    sentenceExpanded: !fallback && (start < range.start || end > range.end)
  };
}

function readSnapshot(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const body = fs.readFileSync(file);
    return { path: file, body, sha256: hash(body), size: body.length };
  } catch { return null; }
}

function safePath(value, fixturesDir) {
  const file = path.isAbsolute(String(value || "")) ? String(value) : path.join(fixturesDir, String(value || ""));
  const resolved = path.resolve(file);
  const base = path.resolve(fixturesDir);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}

function declaredPaths(item) {
  const files = item?.files && typeof item.files === "object" ? item.files : {};
  const values = (...paths) => paths.filter(Boolean).map(String);
  return {
    auto: values(item?.autoPath, item?.censoredPath, files.auto, files.censored),
    manual: values(item?.manualPath, item?.uncensoredPath, files.manual, files.uncensored)
  };
}

function metadata(item, channel) {
  const value = (key) => text(item?.[key]) || text(channel?.[key]);
  return {
    creator: value("creator") || value("channel") || value("name"),
    creatorId: value("creatorId") || value("channelId"),
    creatorHandle: value("creatorHandle"),
    videoId: text(item?.videoId) || text(item?.id),
    acquisitionTimestamp: item?.timestamp ?? item?.savedAt ?? null
  };
}

function reportItem(item, channel, reportPath, reportStatus) {
  if (item?.status !== "paired-saved" || !item.id) return null;
  const mapped = classifyPairKind(item.pairKind);
  const declared = text(item.pairClass);
  const explicit = PAIR_CLASSES.has(declared) && declared !== "unknown";
  const classificationConflict = declared === "conflict" ||
    (explicit && mapped.pairClass && declared !== mapped.pairClass);
  const pairClass = classificationConflict ? "conflict" :
    (explicit ? declared : mapped.pairClass || "unknown");
  return { ...metadata(item, channel), autoPath: item.autoPath || item.censoredPath,
    manualPath: item.manualPath || item.uncensoredPath, files: item.files,
    declaredPaths: declaredPaths(item), pairClass, classificationConflict,
    pairKind: text(item.pairKind), report: reportPath, reportStatus };
}

function reportItems(report, reportPath, reportStatus) {
  const items = [];
  const channels = Array.isArray(report?.channels) ? report.channels : [];
  channels.forEach((channel) => (channel.items || []).forEach((item) => {
    const record = reportItem(item, channel, reportPath, reportStatus);
    if (record) items.push(record);
  }));
  // A few old acquisition reports used a top-level items array.
  (report?.items || []).forEach((item) => {
    const record = reportItem(item, report, reportPath, reportStatus);
    if (record) items.push(record);
  });
  // The canonical backfill is grouped by video ID and uses the normal fixture
  // names; merge these records by ID with acquisition records below.
  (report?.provenance || []).forEach((group) => {
    const pairClass = PAIR_CLASSES.has(group?.pairClass) ? group.pairClass : "unknown";
    (Array.isArray(group?.ids) ? group.ids : []).forEach((id) => {
      const videoId = text(id);
      if (!videoId) return;
      items.push({ ...metadata({ ...group, id: videoId }, {}), videoId,
        pairClass, classificationConflict: pairClass === "conflict", declaredPaths: {},
        pairKind: text(group.pairKind), report: reportPath, reportStatus });
    });
  });
  return items;
}

function loadReports(reportPaths, diagnostics) {
  const records = [];
  const descriptors = [];
  for (const input of reportPaths) {
    const file = path.resolve(input);
    const live = fs.existsSync(`${file}.lock`);
    if (live) diagnostics.lockedReports.push(file);
    const before = readSnapshot(file);
    if (!before) { diagnostics.invalidReports.push(file); continue; }
    let report;
    try { report = JSON.parse(before.body.toString("utf8")); }
    catch { diagnostics.invalidReports.push(file); continue; }
    let reportStatus;
    try { reportStatus = reportEvidenceStatus(report); }
    catch { diagnostics.invalidReports.push(file); continue; }
    const after = readSnapshot(file);
    if (!after || after.sha256 !== before.sha256) { diagnostics.unstableReports.push(file); continue; }
    if (live) {
      diagnostics.liveReports.push(file);
      reportStatus = "incomplete";
    }
    descriptors.push({ path: file, sha256: before.sha256, stableSha256: hash(canonical(report)), evidenceStatus: reportStatus,
      live });
    records.push(...reportItems(report, file, reportStatus));
  }
  return { records, descriptors };
}

function provenanceStatus(values, conflict) {
  if (conflict) return "conflict";
  if (values.includes("incomplete")) return "incomplete";
  if (values.length && values.every((value) => value === "complete")) return "complete";
  return "legacy";
}

function uniqueSorted(values) { return [...new Set(values.filter(Boolean))].sort(compare); }

function sourceGroups(records, fixturesDir, diagnostics) {
  const groups = new Map();
  records.forEach((record) => {
    if (!record.videoId) return;
    const key = record.videoId;
    const group = groups.get(key) || { key, videoId: record.videoId,
      records: [], reports: [], creators: [], creatorIds: [], handles: [] };
    group.records.push(record); group.reports.push(record.report); group.creators.push(record.creator);
    group.creatorIds.push(record.creatorId); group.handles.push(record.creatorHandle); groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => compare(a.key, b.key)).map((group) => {
    const declared = Object.fromEntries(["auto", "manual"].map((kind) => [kind, uniqueSorted(group.records
      .flatMap((record) => record.declaredPaths?.[kind] || [])
      .map((value) => path.resolve(fixturesDir, String(value))))]));
    const pathConflict = Object.values(declared).some((values) => values.length > 1);
    const paths = pathConflict ? { auto: null, manual: null } : {
      auto: safePath(declared.auto[0] || `${group.videoId}_auto.en.json3`, fixturesDir),
      manual: safePath(declared.manual[0] || `${group.videoId}_manual.en.json3`, fixturesDir)
    };
    // Do not retain fixture bodies for the whole corpus. They are read and
    // re-snapshotted one source at a time during the build loop.
    const files = { auto: paths.auto ? { path: paths.auto } : null, manual: paths.manual ? { path: paths.manual } : null };
    const invalid = pathConflict || !paths.auto || !paths.manual ||
      !fs.existsSync(paths.auto) || !fs.existsSync(paths.manual);
    if (pathConflict) diagnostics.conflictingSourcePaths.push(group.videoId);
    else if (!paths.auto || !paths.manual) diagnostics.invalidSourcePaths.push(group.videoId);
    else if (!fs.existsSync(paths.auto) || !fs.existsSync(paths.manual)) diagnostics.missingFixtures.push(group.videoId);
    const knownClasses = group.records.map((record) => record.pairClass)
      .filter((value) => value !== "unknown" && value !== "conflict");
    const classConflict = new Set(knownClasses).size > 1 || group.records.some((record) => record.classificationConflict ||
      record.pairClass === "conflict");
    const creatorConflict = uniqueSorted(group.creatorIds).length > 1 ||
      (!uniqueSorted(group.creatorIds).length && uniqueSorted(group.creators).length > 1);
    const conflict = classConflict || creatorConflict || pathConflict;
    const resolvedClass = conflict ? "conflict" : knownClasses[0] || "unknown";
    if (conflict) diagnostics.quarantinedSources.push(group.videoId);
    const status = provenanceStatus(group.records.map((record) => record.reportStatus), conflict);
    return {
      ...group, files, invalid, conflict, originalPairClass: resolvedClass, pairClass: resolvedClass,
      creator: uniqueSorted(group.creators)[0] || "", creatorId: uniqueSorted(group.creatorIds)[0] || "",
      creatorIds: uniqueSorted(group.creatorIds), creators: uniqueSorted(group.creators), creatorHandles: uniqueSorted(group.handles),
      acquisitionTimestamps: uniqueSorted(group.records.map((record) => record.acquisitionTimestamp == null ? "" : String(record.acquisitionTimestamp))),
      reports: uniqueSorted(group.reports), provenanceStatus: status
    };
  });
}

function pairPayload(source) {
  if (source.invalid || !source.files.auto?.body || !source.files.manual?.body) return null;
  const auto = source.files.auto.body.toString("utf8");
  const manual = source.files.manual.body.toString("utf8");
  let autoPayload;
  let manualPayload;
  try { autoPayload = JSON.parse(auto); manualPayload = JSON.parse(manual); }
  catch { return null; }
  // Synthetic acquisition copies the original uncensored automatic caption to
  // `_manual`, then masks `_auto`; the filename convention is therefore the
  // reverse of a real manual/automatic pair.
  const censoredBody = auto;
  const censoredPayload = autoPayload;
  const uncensoredPayload = manualPayload;
  const tokens = timedText.collectTimedTextData(censoredBody, false).tokens;
  const expected = align(tokens, manualSwearEvents(uncensoredPayload, true)).expected;
  const corpusParts = [];
  const slots = [];
  let offset = 0;
  let tokenIndex = 0;
  (censoredPayload.events || []).forEach((event, eventIndex) => {
    const value = eventText(event);
    if (!value) return;
    if (corpusParts.length) { corpusParts.push(" "); offset += 1; }
    const eventOffset = offset;
    corpusParts.push(value); offset += value.length;
    markerMatches(value, eventOffset).forEach((marker, slotInEvent) => {
      slots.push({ ...marker, eventIndex, slotInEvent, tokenIndex: tokenIndex + slotInEvent,
        timeSeconds: tokens[tokenIndex + slotInEvent]?.timeSeconds ??
          (Number(event.tStartMs) || 0) / 1000 });
    });
    tokenIndex += markerCount(value);
  });
  const fullText = corpusParts.join("");
  return { text: fullText, slots, expected, tokens, censoredPayload, uncensoredPayload,
    prepared: { words: wordsIn(fullText), sentences: sentenceRanges(fullText) } };
}

function directSlotInfo(pair, slot) {
  const cEvent = pair.censoredPayload.events?.[slot.eventIndex];
  const uEvent = pair.uncensoredPayload.events?.[slot.eventIndex];
  if (!cEvent || !uEvent || eventText(cEvent).replace(/\s+/gu, " ").trim() === "") return null;
  if (cEvent.tStartMs !== uEvent.tStartMs || cEvent.dDurationMs !== uEvent.dDurationMs) return null;
  const cText = eventText(cEvent);
  const uText = eventText(uEvent);
  const pieces = cText.split(MARKER);
  const pattern = pieces.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*?)");
  const match = new RegExp(`^${pattern}$`, "su").exec(uText);
  if (!match) return null;
  const labels = groundTruthWords(match[slot.slotInEvent + 1] || "");
  return labels.length === 1 ? { label: labels[0], candidates: labels, status: "known" } :
    labels.length > 1 ? { label: null, candidates: labels, status: "ambiguous" } :
      { label: null, candidates: [], status: "unknown" };
}

function buildDiscovery(options = {}) {
  const fixturesDir = path.resolve(options.fixturesDir || options.fixtures || path.join(root, "test-fixtures"));
  const reportInput = options.reportPaths || options.reports || options.report || [];
  const reportPaths = (Array.isArray(reportInput) ? reportInput : [reportInput]).filter(Boolean)
    .map((file) => path.resolve(file));
  const minimumWords = positive(options.words ?? 4, "words");
  const maxWords = positive(options.maxWords ?? 120, "maxWords");
  if (maxWords < minimumWords * 2) throw new Error("maxWords must be at least twice words.");
  const implementationFiles = [__filename, require.resolve("./evaluation-alignment"), require.resolve("../src/timedtext"),
    ...["rules", "rules-data", "rules-compiler", "rule-data/exact", "rule-data/grammar", "rule-data/language"]
      .map((file) => require.resolve(`../src/${file}`))];
  const implementation = implementationFiles.map((file) => ({ file, sha256: hash(fs.readFileSync(file)) }));
  const buildFingerprint = hash(canonical({ algorithmVersion: DISCOVERY_ALGORITHM_VERSION,
    implementation, options: { words: minimumWords, maxWords } }));
  const previousDataset = options.previousDataset;
  const previousUsable = previousDataset?.dataset === "caption-discovery" &&
    previousDataset.buildFingerprint === buildFingerprint && previousDataset.options?.words === minimumWords &&
    previousDataset.options?.maxWords === maxWords;
  const previousSources = new Map((previousUsable && Array.isArray(previousDataset.sources) ? previousDataset.sources : [])
    .map((source) => [source.sourceHash, source]));
  const previousRows = new Map();
  if (previousUsable && Array.isArray(previousDataset.rows)) previousDataset.rows.forEach((row) => {
    if (!previousRows.has(row.sourceId)) previousRows.set(row.sourceId, []);
    previousRows.get(row.sourceId).push(row);
  });
  const previousContexts = new Map((previousUsable && Array.isArray(previousDataset.contexts) ? previousDataset.contexts : [])
    .map((context) => [context.id, context]));
  const diagnostics = {
    reports: reportPaths.length, invalidReports: [], lockedReports: [], liveReports: [], unstableReports: [],
    unstablePairs: [], missingFixtures: [], invalidSourcePaths: [], conflictingSourcePaths: [], quarantinedSources: [],
    unknownSlots: 0, ambiguousSlots: 0, truncatedContexts: 0, fallbackContexts: 0, duplicateSources: 0, invalidFixtures: [],
    reusedSources: 0, rebuiltSources: 0
  };
  const loaded = loadReports(reportPaths, diagnostics);
  const sources = sourceGroups(loaded.records, fixturesDir, diagnostics);
  diagnostics.duplicateSources = loaded.records.length - sources.reduce((sum, source) => sum + 1, 0);
  const contexts = new Map();
  const rows = [];
  const sourceOutput = [];
  for (const source of sources) {
    const beforeFiles = {
      auto: source.files.auto ? readSnapshot(source.files.auto.path) : null,
      manual: source.files.manual ? readSnapshot(source.files.manual.path) : null
    };
    source.files = beforeFiles;
    const beforeAuto = beforeFiles.auto?.sha256;
    const beforeManual = beforeFiles.manual?.sha256;
    const afterAuto = source.files.auto ? readSnapshot(source.files.auto.path) : null;
    const afterManual = source.files.manual ? readSnapshot(source.files.manual.path) : null;
    const releaseFiles = () => {
      source.files = Object.fromEntries(Object.entries(source.files).map(([kind, file]) =>
        [kind, file ? { path: file.path, sha256: file.sha256, size: file.size } : file]));
    };
    if (beforeAuto && (!afterAuto || afterAuto.sha256 !== beforeAuto) || beforeManual && (!afterManual || afterManual.sha256 !== beforeManual)) {
      diagnostics.unstablePairs.push(source.videoId);
      releaseFiles();
      continue;
    }
    const sourceFiles = [source.files.auto, source.files.manual].filter(Boolean)
      .map((file) => ({ path: path.relative(root, file.path) || file.path, sha256: file.sha256 }));
    const sourceHash = hash(canonical({ videoId: source.videoId, pairClass: source.pairClass,
      originalPairClass: source.originalPairClass, files: sourceFiles, reports: source.reports,
      metadata: source.records.map((record) => canonical(record)).sort(compare),
      creator: source.creator, creatorId: source.creatorId, creatorIds: source.creatorIds,
      creators: source.creators, creatorHandles: source.creatorHandles,
      acquisitionTimestamps: source.acquisitionTimestamps, provenanceStatus: source.provenanceStatus }));
    const sourceRecord = { id: `source:${sha(sourceHash).slice(0, 20)}`, videoId: source.videoId,
      pairClass: source.pairClass, originalPairClass: source.originalPairClass, files: sourceFiles,
      reports: source.reports.map((file) => path.relative(root, file) || file), sourceHash, rowCount: null,
      creator: source.creator, creatorId: source.creatorId, creatorIds: source.creatorIds,
      creators: source.creators, creatorHandles: source.creatorHandles, acquisitionTimestamps: source.acquisitionTimestamps,
      provenanceStatus: source.provenanceStatus };
    sourceOutput.push(sourceRecord);
    const previousSource = previousSources.get(sourceHash);
    const cachedRows = previousSource && previousSource.id === sourceRecord.id ?
      (previousRows.get(previousSource.id) || []) : null;
    const cachedContexts = cachedRows?.map((row) => previousContexts.get(row.contextId));
    const reusable = !source.invalid && beforeAuto && beforeManual && previousSource?.id === sourceRecord.id &&
      previousSource.rowCount === cachedRows?.length && cachedRows && cachedContexts.every((context, index) => context &&
        context.id === cachedRows[index].contextId &&
        typeof context.text === "string") && cachedRows.every((row) => row.videoId === source.videoId &&
        row.sourceId === sourceRecord.id && Array.isArray(row.expectedCandidates) && typeof row.labelStatus === "string" &&
        (source.conflict || source.originalPairClass === "unknown"
          ? row.expected === null && row.labelStatus === "unknown" && row.expectedCandidates.length === 0
          : true));
    if (reusable) {
      cachedContexts.forEach((context) => { if (!contexts.has(context.id)) contexts.set(context.id, context); });
      rows.push(...cachedRows);
      sourceRecord.rowCount = cachedRows.length;
      diagnostics.reusedSources += 1;
      releaseFiles();
      continue;
    }
    if (!source.invalid && beforeAuto && beforeManual) diagnostics.rebuiltSources += 1;
    const pair = pairPayload(source);
    if (!pair) { diagnostics.invalidFixtures.push(source.videoId); releaseFiles(); continue; }
    const sourceId = sourceRecord.id;
    const sourceRowStart = rows.length;
    pair.slots.forEach((slot) => {
      const direct = source.conflict || source.originalPairClass === "unknown" ? null : directSlotInfo(pair, slot);
      const aligned = pair.expected.get(slot.tokenIndex);
      const info = direct || (source.conflict || source.originalPairClass === "unknown" ? { label: null, candidates: [], status: "unknown" } :
        aligned ? { label: aligned, candidates: [aligned], status: "known" } :
          { label: null, candidates: [], status: "unknown" });
      let context;
      try { context = deriveContext(pair.text, slot.start, { words: minimumWords, maxWords, prepared: pair.prepared }); }
      catch { return; }
      const contextId = `context:${sha(context.context).slice(0, 20)}`;
      if (!contexts.has(contextId)) contexts.set(contextId, { id: contextId, text: context.context,
        shape: context.shape, wordCount: context.wordCount, truncated: context.truncated, fallback: context.fallback });
      const targetOffset = slot.start - context.offset;
      const slotIndex = markerMatches(context.context.slice(0, targetOffset)).length;
      const timestamp = slot.timeSeconds;
      const rowKey = [source.videoId, source.originalPairClass, slot.tokenIndex, contextId, targetOffset].join("\0");
      rows.push({ id: `row:${sha(rowKey).slice(0, 20)}`, contextId, tokenIndex: slot.tokenIndex, slotIndex,
        targetOffset, targetSpan: slot.end - slot.start,
        expected: info.label, expectedCandidates: info.candidates, labelStatus: info.status,
        pairClass: source.pairClass, sourceId,
        videoId: source.videoId, creator: source.creator, creatorId: source.creatorId,
        timestamp });
    });
    sourceRecord.rowCount = rows.length - sourceRowStart;
    releaseFiles();
  }
  rows.sort((a, b) => compare(a.id, b.id));
  const contextOutput = [...contexts.values()].sort((a, b) => compare(a.id, b.id));
  diagnostics.unknownSlots = rows.filter((row) => row.labelStatus === "unknown").length;
  diagnostics.ambiguousSlots = rows.filter((row) => row.labelStatus === "ambiguous").length;
  diagnostics.truncatedContexts = rows.filter((row) => contexts.get(row.contextId)?.truncated).length;
  diagnostics.fallbackContexts = rows.filter((row) => contexts.get(row.contextId)?.fallback).length;
  const byWord = { "manual-auto": {}, synthetic: {} };
  const byShape = {};
  rows.forEach((row) => {
    if (row.pairClass !== "conflict") {
      const context = contexts.get(row.contextId);
      const shapeKey = `${context?.shape || ""}|offset:${row.targetOffset}`;
      if (!byShape[shapeKey]) byShape[shapeKey] = [];
      byShape[shapeKey].push(row.id);
    }
    if (INDEX_CLASSES.has(row.pairClass) && row.labelStatus === "known") {
      const word = String(row.expected).toLowerCase();
      (byWord[row.pairClass][word] ||= []).push(row.id);
    }
  });
  Object.values(byWord).forEach((words) => Object.keys(words).forEach((word) => words[word].sort(compare)));
  Object.keys(byShape).forEach((shape) => byShape[shape].sort(compare));
  diagnostics.sources = sourceOutput.length;
  diagnostics.rows = rows.length;
  diagnostics.contexts = contextOutput.length;
  const sourceFingerprint = hash(canonical({ algorithmVersion: DISCOVERY_ALGORITHM_VERSION,
    buildFingerprint, implementation,
    reports: loaded.descriptors.map((report) => ({
    path: report.path, stableSha256: report.stableSha256, evidenceStatus: report.evidenceStatus, live: report.live
  })), sources: sourceOutput.map((source) => ({
    videoId: source.videoId, pairClass: source.pairClass, sourceHash: source.sourceHash,
    files: source.files, reports: source.reports, provenanceStatus: source.provenanceStatus
  })), options: { words: minimumWords, maxWords } }));
  return {
    dataset: "caption-discovery", version: 2, discoveryOnly: true,
    contextPolicy: "union of target sentence and +/-N words around the target; punctuation-unreliable fallback +/-N words; literal markers retained",
    options: { words: minimumWords, maxWords }, buildFingerprint, sourceFingerprint,
    sources: sourceOutput, contexts: contextOutput, rows, byWord, byShape,
    diagnostics: { ...diagnostics, invalidReports: diagnostics.invalidReports.sort(compare), lockedReports: diagnostics.lockedReports.sort(compare),
      liveReports: diagnostics.liveReports.sort(compare), unstableReports: diagnostics.unstableReports.sort(compare), unstablePairs: uniqueSorted(diagnostics.unstablePairs),
      missingFixtures: uniqueSorted(diagnostics.missingFixtures), invalidSourcePaths: uniqueSorted(diagnostics.invalidSourcePaths),
      conflictingSourcePaths: uniqueSorted(diagnostics.conflictingSourcePaths), invalidFixtures: uniqueSorted(diagnostics.invalidFixtures),
      quarantinedSources: uniqueSorted(diagnostics.quarantinedSources) }
  };
}

function parseArgs(argv) {
  const args = { reportPaths: [], fixturesDir: path.join(root, "test-fixtures"), outputPath: "", words: 4, maxWords: 120 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!["--report", "--fixtures", "--output", "--words", "--max-words"].includes(value)) throw new Error(`Unknown argument: ${value}`);
    const next = argv[++index];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}.`);
    if (value === "--report") args.reportPaths.push(next);
    else if (value === "--fixtures") args.fixturesDir = next;
    else if (value === "--output") args.outputPath = next;
    else if (value === "--words") args.words = positive(next, "--words");
    else args.maxWords = positive(next, "--max-words");
  }
  if (args.maxWords < args.words * 2) throw new Error("--max-words must be at least twice --words.");
  return args;
}

function outputIsInput(outputPath, options) {
  const destination = path.resolve(outputPath);
  const fixtures = path.resolve(options.fixturesDir || options.fixtures || path.join(root, "test-fixtures"));
  const reportInput = options.reportPaths || options.reports || options.report || [];
  const inputs = (Array.isArray(reportInput) ? reportInput : [reportInput]).filter(Boolean)
    .map((file) => path.resolve(file));
  return inputs.includes(destination) || destination === fixtures || destination.startsWith(`${fixtures}${path.sep}`);
}

function run(options = {}) {
  const outputPath = options.outputPath || options.output || "";
  const dataset = buildDiscovery(options);
  if (!outputPath || outputPath === "-") { process.stdout.write(`${JSON.stringify(dataset)}\n`); return { status: "written", output: "-", dataset }; }
  if (outputIsInput(outputPath, options)) throw new Error("Refusing to write discovery output over an input or raw fixture.");
  const destination = path.resolve(outputPath);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(destination, "utf8")); } catch { /* new output */ }
  if (previous?.dataset === "caption-discovery" && previous.sourceFingerprint === dataset.sourceFingerprint &&
      previous.options?.words === dataset.options.words && previous.options?.maxWords === dataset.options.maxWords) {
    return { status: "unchanged", output: destination, dataset: previous };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try { fs.writeFileSync(temporary, JSON.stringify(dataset)); fs.renameSync(temporary, destination); }
  finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
  return { status: "written", output: destination, dataset };
}

if (require.main === module) {
  try {
    const result = run(parseArgs(process.argv.slice(2)));
    if (result.output !== "-") process.stderr.write(`${result.status}: ${result.output}\n`);
  } catch (error) { process.stderr.write(`${error.message || error}\n`); process.exit(1); }
}

module.exports = { buildDiscovery, run, parseArgs, deriveContext, contextShape };
