#!/usr/bin/env node
"use strict";

// Offline-only, shallow context miner. Its output is a review queue, never a
// runtime dependency.
const fs = require("fs");
const path = require("path");
const { DEFAULT_REPORTS, DEFAULT_PROVENANCE_REPORTS, loadArchivedRows } = require("./archived-rules-benchmark");

const root = path.join(__dirname, "..");
const { EVIDENCE_POLICY } = require("./audit-caption-corpus");
const runtimeRules = require("../src/rules");
const DEFAULT_REPORT = "corpus/generated/paired-rules-only-report.json";
const DEFAULT_PROVENANCE = "tools/caption-pair-provenance.json";
const DEFAULT_OUTPUT = "corpus/generated/context-leaf-proposals.json";
const BOUNDARY_LEFT = "<BOS>";
const BOUNDARY_RIGHT = "<EOS>";
const MAX_WINDOW_SIDE = 8;
const MAX_WINDOW_FEATURES = 16;
const RUNTIME_PATTERN_CACHE = new Map();
const MARKER = /\[\s*__\s*\]/gu;
const NON_SPEECH = /\[(?!\s*__\s*\])[^\]\n]*\]/gu;
const WORDS = /[*]|\[__\]|[\p{L}\p{N}_']+/gu;
const ratio = (value, total) => total ? value / total : 0;
const count = (collection, key) => collection instanceof Map
  ? collection.set(key, (collection.get(key) || 0) + 1)
  : (collection[key] = (collection[key] || 0) + 1);

function normalizeWord(value) {
  return String(value ?? "").toLowerCase().replaceAll("’", "'")
    .replace(/^[^\p{L}\p{N}_']+|[^\p{L}\p{N}_']+$/gu, "").trim();
}
function groupKey(row) { return row.creatorKey || row.creatorId || row.creator; }
function canonicalDiscoveryCreator(row) {
  const name = String(row.creator || "").trim().normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
  const id = String(row.creatorId || "").trim().normalize("NFKC").toLowerCase();
  const placeholder = /^(?:unknown|unknown creator|placeholder|anonymous|n\/?a|null|none|missing|unassigned|undefined)$/u;
  if ((!id && !name) || placeholder.test(name) || placeholder.test(id)) return "";
  return id || name;
}
function runtimeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(MARKER, "[__]")
    .replace(NON_SPEECH, " ").replaceAll("’", "'").toLowerCase();
}
function runtimeWords(value) { return runtimeText(value).match(WORDS) || []; }
function integer(value, name, minimum = 0) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
  return number;
}
function rate(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw new Error(`${name} must be between 0 and 1.`);
  return number;
}
function parseWindow(value) {
  const parts = String(value).split(",").map(Number);
  if (parts.length !== 2 || !parts.every((part) => Number.isInteger(part) && part >= 1)) {
    throw new Error("--window must be two positive integers like 2,2.");
  }
  if (parts.some((part) => part > MAX_WINDOW_SIDE) || parts[0] + parts[1] > MAX_WINDOW_FEATURES) {
    throw new Error(`--window is limited to ${MAX_WINDOW_SIDE} tokens per side and ${MAX_WINDOW_FEATURES} tokens total.`);
  }
  return parts;
}
function parseArgs(argv = process.argv.slice(2)) {
  const options = { report: DEFAULT_REPORT, provenance: DEFAULT_PROVENANCE, output: DEFAULT_OUTPUT,
    before: 2, after: 2, phraseWords: 8, maxDepth: 2, minSupport: 4, minMarginalSupport: 3,
    minPrecision: 0.92, minMarginalPrecision: 0.92, minCreators: 2,
    minValidationSupport: 3, minValidationFolds: 2, minValidationPrecision: 0.92,
    minValidationMarginalPrecision: 0.92, limit: 100 };
  const aliases = { report: "report", provenance: "provenance", dataset: "dataset", output: "output",
    window: "window", before: "before", after: "after", "phrase-words": "phraseWords", "max-depth": "maxDepth",
    "min-support": "minSupport", "min-marginal-support": "minMarginalSupport", "min-precision": "minPrecision",
    "min-marginal-precision": "minMarginalPrecision", "min-creators": "minCreators",
    "min-validation-support": "minValidationSupport", "min-validation-folds": "minValidationFolds",
    "min-validation-precision": "minValidationPrecision",
    "min-validation-marginal-precision": "minValidationMarginalPrecision", limit: "limit", word: "word", exclude: "exclude" };
  const positional = [], explicitWindow = { before: false, after: false }, explicitLimit = { value: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    const name = argument.slice(2), key = aliases[name];
    if (!key) throw new Error(`Unknown option --${name}.`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    options[key] = value;
    if (key === "before") explicitWindow.before = true;
    if (key === "after") explicitWindow.after = true;
    if (key === "window") explicitWindow.before = explicitWindow.after = true;
    if (key === "limit") explicitLimit.value = true;
  }
  if (positional.length > 2) throw new Error("Expected at most report and output positional arguments.");
  if (positional[0]) options.report = positional[0];
  if (positional[1]) options.output = positional[1];
  if (options.window !== undefined) { [options.before, options.after] = parseWindow(options.window); delete options.window; }
  options.before = integer(options.before, "--before", 1); options.after = integer(options.after, "--after", 1);
  options.phraseWords = integer(options.phraseWords, "--phrase-words", 1);
  if (options.phraseWords > MAX_WINDOW_FEATURES) throw new Error("--phrase-words must be <= 16.");
  if (options.before > MAX_WINDOW_SIDE || options.after > MAX_WINDOW_SIDE || options.before + options.after > MAX_WINDOW_FEATURES) {
    throw new Error(`--before/--after are limited to ${MAX_WINDOW_SIDE} tokens per side and ${MAX_WINDOW_FEATURES} tokens total.`);
  }
  options.maxDepth = integer(options.maxDepth, "--max-depth", 1);
  if (options.maxDepth > 2) throw new Error("--max-depth must be 1 or 2 for a shallow learner.");
  ["minSupport", "minMarginalSupport", "minCreators", "minValidationSupport", "minValidationFolds"].forEach((key) => {
    options[key] = integer(options[key], `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, 1);
  });
  options.limit = integer(options.limit, "--limit", 0);
  ["minPrecision", "minMarginalPrecision", "minValidationPrecision", "minValidationMarginalPrecision"].forEach((key) => {
    options[key] = rate(options[key], `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  });
  if (options.word !== undefined) {
    options.word = normalizeWord(options.word);
    if (!options.word) throw new Error("--word must be a nonempty word.");
  }
  const phraseWords = options.phraseWords;
  delete options.phraseWords;
  Object.defineProperty(options, "phraseWords", { value: phraseWords, enumerable: false });
  Object.defineProperty(options, "_explicitWindow", { value: explicitWindow, enumerable: false });
  Object.defineProperty(options, "_explicitLimit", { value: explicitLimit.value, enumerable: false });
  return options;
}

function loadProvenance(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || !Array.isArray(data.provenance)) throw new Error("Provenance archive must contain a provenance array.");
  const records = new Map();
  for (const group of data.provenance) {
    if (!group || !Array.isArray(group.ids)) throw new Error("Invalid provenance group.");
    for (const rawId of group.ids) {
      const id = String(rawId).trim();
      if (!id) throw new Error("Provenance ids must be nonempty.");
      const next = { pairClass: String(group.pairClass || "unknown"), creator: String(group.creator || "").trim(), creatorId: String(group.creatorId || "").trim() };
      const previous = records.get(id);
      if (previous && (previous.pairClass !== next.pairClass || previous.creator !== next.creator ||
          (previous.creatorId && next.creatorId && previous.creatorId !== next.creatorId))) {
        records.set(id, { pairClass: "conflict", creator: "", creatorId: "" });
      } else if (!previous) records.set(id, next);
      else if (!previous.creatorId && next.creatorId) records.set(id, { ...previous, creatorId: next.creatorId });
    }
  }
  return records;
}
function fixtureId(fixture) {
  const value = String(fixture?.videoId || fixture?.name || "");
  return value.length >= 11 ? value.slice(0, 11) : value;
}
function validateWindowSize(before, after) {
  if (![before, after].every(Number.isSafeInteger) || before < 1 || after < 1 || before > MAX_WINDOW_SIDE ||
      after > MAX_WINDOW_SIDE || before + after > MAX_WINDOW_FEATURES) {
    throw new Error(`Context windows are limited to ${MAX_WINDOW_SIDE} tokens per side and ${MAX_WINDOW_FEATURES} tokens total.`);
  }
}
function featureVector(context, before = 2, after = 2) {
  validateWindowSize(before, after);
  const parts = String(context || "").split(MARKER);
  if (parts.length !== 2) return null;
  const left = runtimeWords(parts[0]), right = runtimeWords(parts[1]);
  const features = [];
  for (let distance = before; distance; distance -= 1) features.push({ offset: -distance, token: left[left.length - distance] || BOUNDARY_LEFT });
  for (let distance = 1; distance <= after; distance += 1) features.push({ offset: distance, token: right[distance - 1] || BOUNDARY_RIGHT });
  features.forEach((feature) => { feature.key = `${feature.offset}:${feature.token}`; });
  return features;
}
function indexRows(rows, skipped) {
  const creators = new Map();
  rows.forEach((row) => {
    const key = groupKey(row), bucket = creators.get(key) || { creator: row.creator, creatorId: row.creatorId || "", rows: 0,
      fixtures: new Set(), labels: new Map(), currentAttempted: 0, currentCorrect: 0 };
    bucket.rows += 1; bucket.fixtures.add(row.fixture); count(bucket.labels, row.expected);
    bucket.currentAttempted += Number(Boolean(row.current)); bucket.currentCorrect += Number(Boolean(row.current) && row.current === row.expected);
    creators.set(key, bucket);
  });
  return { rows, fixtures: new Set(rows.map((row) => row.fixture)), creators, skipped };
}
function loadRows(reportPath, provenancePath, before = 2, after = 2, wantedPairClass = "manual-auto") {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!report || !Array.isArray(report.fixtures)) throw new Error("Report must contain a fixtures array.");
  const provenance = loadProvenance(provenancePath), rows = [];
  const nonTarget = wantedPairClass === "manual-auto" ? "nonManualAuto" : "nonTargetPairClass";
  const skipped = { missingProvenance: 0, [nonTarget]: 0, unlabeled: 0, ambiguous: 0, noContext: 0 };
  report.fixtures.forEach((fixture) => {
    const id = fixtureId(fixture), record = provenance.get(id) || {};
    const pairClass = record.pairClass || fixture.pairClass || "unknown";
    if ((wantedPairClass === "synthetic" && !record.pairClass) || pairClass !== wantedPairClass) {
      skipped[pairClass === "unknown" || (wantedPairClass === "synthetic" && !record.pairClass) ? "missingProvenance" : nonTarget] += 1; return;
    }
    const creator = record.creator || fixture.creator || "";
    if (wantedPairClass === "manual-auto" && (!creator || creator.toLowerCase() === "unknown")) { skipped.missingProvenance += 1; return; }
    (fixture.results || []).forEach((result) => {
      const expected = Array.isArray(result.expected) ? result.expected.map(normalizeWord).filter(Boolean) : [];
      if (!expected.length) { skipped.unlabeled += 1; return; }
      if (expected.length !== 1) { skipped.ambiguous += 1; return; }
      const context = String(result.context || result.reviewContext || ""), features = featureVector(context, before, after);
      if (!features) { skipped.noContext += 1; return; }
      rows.push({ id: `${id}:${result.tokenIndex ?? rows.length}`, fixture: id, tokenIndex: result.tokenIndex, creator,
        creatorId: record.creatorId || fixture.creatorId || "", context, expected: expected[0],
        current: normalizeWord(result.word ?? result.predicted), features });
    });
  });
  return { report, ...indexRows(rows, skipped) };
}
function isFaithfulValidationDataset(dataset) {
  return Boolean(dataset && dataset.mode === "faithful" && dataset.validation === "faithful-only" && dataset.discoveryOnly === false &&
    dataset.provenance?.evidencePolicy === EVIDENCE_POLICY);
}
function validationEligibility(datasetPath, dataset) {
  if (!datasetPath) return { eligible: false, reason: "Creator-fold validation requires an explicit --dataset marked mode faithful, validation faithful-only, discoveryOnly false, and the evidence policy exclude-explicitly-incomplete-v1." };
  if (!dataset || dataset.mode !== "faithful" || dataset.validation !== "faithful-only" || dataset.discoveryOnly !== false) {
    return { eligible: false, reason: "Input dataset is discovery-only; creator-fold validation and promotion proposals require mode faithful, validation faithful-only, and discoveryOnly false." };
  }
  if (dataset.provenance?.evidencePolicy !== EVIDENCE_POLICY) {
    return { eligible: false, reason: "Input faithful dataset is missing evidence policy exclude-explicitly-incomplete-v1; rebuild the faithful dataset before creator-fold validation and promotion proposals." };
  }
  return { eligible: true, reason: null };
}
function validateDatasetShape(dataset) {
  if (!dataset || dataset.dataset !== "real-manual-auto" || dataset.pairClass !== "manual-auto" || !Array.isArray(dataset.rows)) {
    throw new Error("Dataset must be a real-manual-auto manual-auto row dataset.");
  }
  if (!Number.isSafeInteger(dataset.foldCount) || dataset.foldCount < 2) throw new Error("Dataset foldCount must be an integer >= 2.");
  const folds = new Map(), ids = new Set();
  dataset.rows.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Dataset row ${index} is not an object.`);
    const creator = String(raw.creator || "").trim(), key = String(raw.creatorKey || raw.creatorId || creator).trim();
    if (!key || (creator.toLowerCase() === "unknown" && !raw.creatorKey && !raw.creatorId)) {
      throw new Error(`Dataset row ${index} is missing a creator key.`);
    }
    if (!Number.isSafeInteger(raw.creatorFold) || raw.creatorFold < 0 || raw.creatorFold >= dataset.foldCount) throw new Error(`Dataset row ${index} has an invalid creatorFold.`);
    if (folds.has(key) && folds.get(key) !== raw.creatorFold) throw new Error(`Creator ${key} appears in multiple folds.`);
    folds.set(key, raw.creatorFold);
    const id = String(raw.id || `${raw.videoId || raw.fixture || "row"}:${raw.tokenIndex ?? index}`);
    if (ids.has(id)) throw new Error(`Dataset contains duplicate row id ${id}.`); ids.add(id);
  });
  if (!folds.size) throw new Error("Dataset contains no creator rows.");
}
function loadDataset(datasetPath, before = 2, after = 2) {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8")); validateDatasetShape(dataset);
  const skipped = { missingCreator: 0, unlabeled: 0, ambiguous: 0, noContext: 0, evidenceIneligible: 0 }, rows = [];
  dataset.rows.forEach((raw, index) => {
    if (raw.evidenceEligible === false) { skipped.evidenceIneligible += 1; return; }
    const expected = (Array.isArray(raw.expected) ? raw.expected : [raw.expected]).map(normalizeWord).filter(Boolean);
    if (!expected.length) { skipped.unlabeled += 1; return; }
    if (expected.length !== 1) { skipped.ambiguous += 1; return; }
    const creator = String(raw.creator || "").trim();
    if (!creator || creator.toLowerCase() === "unknown") { skipped.missingCreator += 1; return; }
    const context = String(raw.context || ""), features = featureVector(context, before, after);
    if (!features) { skipped.noContext += 1; return; }
    rows.push({ id: String(raw.id || `${raw.videoId || raw.fixture || "row"}:${raw.tokenIndex ?? index}`),
      fixture: String(raw.videoId || raw.fixture || ""), tokenIndex: raw.tokenIndex, creator,
      creatorId: String(raw.creatorId || "").trim(), creatorKey: String(raw.creatorKey || "").trim(), creatorFold: raw.creatorFold,
      context, expected: expected[0], current: normalizeWord(raw.currentPrediction ?? raw.current ?? raw.predicted),
      evidenceEligible: raw.evidenceEligible !== false, reportEvidence: raw.reportEvidence || {}, features });
  });
  return { report: { mode: "rules-only", rulesFingerprint: dataset.rulesFingerprint || null }, dataset, ...indexRows(rows, skipped) };
}

function validateDiscoveryDataset(dataset) {
  if (!dataset || dataset.dataset !== "caption-discovery" || dataset.version !== 2 || dataset.discoveryOnly !== true ||
      !Array.isArray(dataset.contexts) || !Array.isArray(dataset.rows)) {
    throw new Error("Dataset must be a caption-discovery v2 discoveryOnly dataset.");
  }
  const contexts = new Map(), rowIds = new Set();
  dataset.contexts.forEach((context, index) => {
    if (!context || typeof context !== "object" || !String(context.id || "") || typeof context.text !== "string") {
      throw new Error(`Discovery context ${index} is invalid.`);
    }
    if (contexts.has(context.id)) throw new Error(`Discovery dataset contains duplicate context id ${context.id}.`);
    const markers = [...String(context.text).matchAll(MARKER)];
    if (!markers.length) throw new Error(`Discovery context ${context.id} has no marker.`);
    contexts.set(String(context.id), { ...context, markers });
  });
  dataset.rows.forEach((row, index) => {
    if (!row || typeof row !== "object") throw new Error(`Discovery row ${index} is invalid.`);
    const id = String(row.id || "");
    if (!id || rowIds.has(id)) throw new Error(`Discovery dataset contains duplicate row id ${id || index}.`);
    rowIds.add(id);
    const context = contexts.get(String(row.contextId || ""));
    if (!context) throw new Error(`Discovery row ${id} references an unknown context.`);
    if (!["manual-auto", "synthetic", "unknown", "conflict"].includes(row.pairClass)) {
      throw new Error(`Discovery row ${id} has an invalid pairClass.`);
    }
    if (row.labelStatus !== undefined && !["known", "ambiguous", "unknown"].includes(row.labelStatus)) {
      throw new Error(`Discovery row ${id} has an invalid labelStatus.`);
    }
    if (!String(row.videoId || row.sourceId || "").trim()) throw new Error(`Discovery row ${id} is missing a source identity.`);
    if (!Number.isSafeInteger(row.tokenIndex) || row.tokenIndex < 0) {
      throw new Error(`Discovery row ${id} has an invalid tokenIndex.`);
    }
    if (!Number.isSafeInteger(row.slotIndex) || row.slotIndex < 0 || row.slotIndex >= context.markers.length) {
      throw new Error(`Discovery row ${id} has an invalid slotIndex.`);
    }
    if (!Number.isSafeInteger(row.targetOffset) || row.targetOffset !== context.markers[row.slotIndex].index) {
      throw new Error(`Discovery row ${id} has an invalid targetOffset.`);
    }
    const candidates = row.expectedCandidates === undefined ? [] : row.expectedCandidates;
    if (!Array.isArray(candidates)) throw new Error(`Discovery row ${id} has invalid expectedCandidates.`);
    if (row.labelStatus === "known" && (typeof row.expected !== "string" || !normalizeWord(row.expected))) throw new Error(`Discovery row ${id} has an invalid known label.`);
    if (candidates.some((candidate) => typeof candidate !== "string" || !normalizeWord(candidate))) throw new Error(`Discovery row ${id} has invalid expectedCandidates.`);
    if (row.labelStatus === "ambiguous" && candidates.length < 2) throw new Error(`Discovery row ${id} has invalid ambiguous labels.`);
    if (row.labelStatus === "unknown" && row.expected !== null && row.expected !== undefined) throw new Error(`Discovery row ${id} has an invalid unknown label.`);
  });
  return contexts;
}
function discoveryTokens(value) {
  const source = String(value || ""), tokens = [];
  // Discovery keeps source offsets intact, but should not learn presentation
  // and non-speech annotations as lexical context. Masking (rather than
  // deleting) also leaves marker positions and punctuation untouched.
  const masked = source
    .replace(NON_SPEECH, (match) => " ".repeat(match.length))
    .replace(/>{2,}/gu, (match) => " ".repeat(match.length))
    .replace(/[♪♫]/gu, " ")
    .replace(/<\/?[A-Za-z][^>\n]*>/gu, (match) => " ".repeat(match.length));
  const pattern = /\[\s*__\s*\]|[^\s]+/gu;
  let match;
  while ((match = pattern.exec(masked))) tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  return tokens;
}
function discoveryFeatureVector(context, slotIndex, before = 2, after = 2) {
  validateWindowSize(before, after);
  const source = String(context || ""), markers = [...source.matchAll(MARKER)];
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex >= markers.length) return null;
  const marker = markers[slotIndex], tokens = discoveryTokens(source);
  const target = tokens.findIndex((token) => token.start === marker.index);
  if (target < 0) return null;
  const features = [];
  for (let distance = before; distance; distance -= 1) {
    const token = tokens[target - distance];
    const text = token?.text || BOUNDARY_LEFT;
    features.push({ offset: -distance, token: text.toLowerCase(), slotIndex,
      sentenceBoundary: /[.!?]["'’”)}\]]*$/u.test(text), key: `${-distance}:${text.toLowerCase()}` });
  }
  for (let distance = 1; distance <= after; distance += 1) {
    const token = tokens[target + distance];
    const text = token?.text || BOUNDARY_RIGHT;
    features.push({ offset: distance, token: text.toLowerCase(), slotIndex,
      sentenceBoundary: /^[.!?]+/u.test(text), key: `${distance}:${text.toLowerCase()}` });
  }
  return features;
}
function discoveryRawIdentity(row) {
  return [row.videoId || row.fixture, row.contextId, row.slotIndex, row.tokenIndex].join("\0");
}
function discoveryContextIdentity(row) {
  return [row.contextId, row.slotIndex].join("\0");
}
function discoverySupportIdentity(row) {
  // Compilation copies from one creator cannot increase clip support, while
  // other creators still provide independent evidence for the same target slot.
  return [groupKey(row) || "unknown", row.contextId, row.slotIndex].join("\0");
}
function mergeDiscoveryEvidence(entry, row) {
  if (row.expected) entry.labels.add(row.expected);
  row.expectedCandidates.forEach((label) => entry.candidates.add(label));
  if (row.labelStatus === "unknown" || row.labelStatus === "ambiguous" || !row.expected) entry.unknown = true;
  (entry.rows || (entry.rows = [])).push(row);
  if (!entry.row || (row.labelStatus === "known" && entry.row.labelStatus !== "known") || row.id.localeCompare(entry.row.id) < 0) {
    entry.row = row;
  }
}
function baselineForDiscoveryRow(context, slotIndex, expected, labelStatus, result = runtimeRules.applyDeterministicRules(context)) {
  const decision = (result.decisions || []).find((candidate) => {
    const start = Number.isSafeInteger(candidate.tokenIndex) ? candidate.tokenIndex : -1;
    const span = Number.isSafeInteger(candidate.tokenSpan) && candidate.tokenSpan > 0 ? candidate.tokenSpan : 1;
    return start <= slotIndex && start + span > slotIndex;
  });
  const prediction = decision ? normalizeWord(decision.word) : "";
  const outcome = labelStatus === "known" && expected
    ? prediction === expected ? "already-correct" : prediction ? "wrong" : "abstain"
    : prediction ? "unscored" : "abstain";
  return { prediction, outcome };
}
function loadDiscoveryDataset(datasetPath, before = 2, after = 2) {
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const contexts = validateDiscoveryDataset(dataset), runtimeResults = new Map(), rows = [], skipped = { unlabeled: 0, ambiguous: 0, noContext: 0 };
  dataset.rows.forEach((raw, index) => {
    const context = contexts.get(String(raw.contextId)), features = discoveryFeatureVector(context.text, raw.slotIndex, before, after);
    if (!features) { skipped.noContext += 1; return; }
    const expected = typeof raw.expected === "string" ? normalizeWord(raw.expected) : null;
    const expectedCandidates = [...new Set((Array.isArray(raw.expectedCandidates) ? raw.expectedCandidates : [])
      .map(normalizeWord).filter(Boolean))];
    if (expected && !expectedCandidates.length) expectedCandidates.push(expected);
    if (raw.labelStatus === "ambiguous") skipped.ambiguous += 1;
    if (raw.labelStatus === "unknown" || (!expected && !expectedCandidates.length)) skipped.unlabeled += 1;
    const labelStatus = raw.labelStatus || (expected ? "known" : "unknown");
    let runtimeResult = runtimeResults.get(context.id);
    if (!runtimeResult) {
      runtimeResult = runtimeRules.applyDeterministicRules(context.text);
      runtimeResults.set(context.id, runtimeResult);
    }
    const baseline = baselineForDiscoveryRow(context.text, raw.slotIndex, expected, labelStatus, runtimeResult);
    rows.push({ id: String(raw.id), fixture: String(raw.videoId || raw.sourceId || ""), videoId: String(raw.videoId || ""),
      tokenIndex: raw.tokenIndex, slotIndex: raw.slotIndex, creator: String(raw.creator || "").trim(), creatorId: String(raw.creatorId || "").trim(),
      creatorKey: String(raw.creatorId || raw.creator || "unknown").trim(), context: context.text, contextId: String(raw.contextId), targetOffset: raw.targetOffset,
      expected, expectedCandidates, labelStatus, current: baseline.prediction, currentOutcome: baseline.outcome, features, pairClass: raw.pairClass,
      sourceId: String(raw.sourceId || "") });
  });
  return { report: { mode: dataset.mode || "discovery", rulesFingerprint: null }, dataset, contexts, fixtures: new Set(rows.map((row) => row.videoId).filter(Boolean)), ...indexRows(rows, skipped) };
}
function prepareRows(rows, before, after) { rows.forEach((row) => { row.features = featureVector(row.context, before, after); }); return rows.filter((row) => row.features); }
function combinations(values, depth, start = 0, selected = [], output = []) {
  if (selected.length === depth) return output.push(selected), output;
  for (let index = start; index <= values.length - depth + selected.length; index += 1) combinations(values, depth, index + 1, selected.concat(values[index]), output);
  return output;
}
function leafKey(conditions) { return conditions.slice().sort((a, b) => a.offset - b.offset).map((condition) => condition.key).join("|"); }
function newStat(conditions) { return { key: leafKey(conditions), conditions: conditions.slice().sort((a, b) => a.offset - b.offset), count: 0,
  expected: new Map(), current: new Map(), currentCorrectByPrediction: new Map(), creators: new Set() }; }
function addStat(map, conditions, row) {
  const key = leafKey(conditions), stat = map.get(key) || newStat(conditions); map.set(key, stat);
  stat.count += 1; count(stat.expected, row.expected); count(stat.current, row.current); stat.creators.add(groupKey(row));
  if (row.current && row.current === row.expected) count(stat.currentCorrectByPrediction, row.current);
}
function summarizeStat(stat, options) {
  const labels = [...stat.expected.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [target, targetCorrect] = labels[0] || ["", 0], unchanged = stat.current.get(target) || 0;
  const marginalSupport = stat.count - unchanged, marginalCorrect = targetCorrect - (stat.currentCorrectByPrediction.get(target) || 0);
  const baselineCorrect = [...stat.currentCorrectByPrediction.entries()].filter(([prediction]) => prediction !== target).reduce((sum, [, value]) => sum + value, 0);
  const candidate = { key: stat.key, conditions: stat.conditions, depth: stat.conditions.length, target, support: stat.count,
    targetCorrect, precision: ratio(targetCorrect, stat.count), marginalSupport, marginalCorrect,
    marginalPrecision: ratio(marginalCorrect, marginalSupport), baselineCorrect, netGain: marginalCorrect - baselineCorrect,
    creatorCount: stat.creators.size, creators: [...stat.creators].sort(), labels: Object.fromEntries(labels) };
  candidate.qualified = candidate.support >= options.minSupport && candidate.creatorCount >= options.minCreators &&
    candidate.precision >= options.minPrecision && candidate.marginalSupport >= options.minMarginalSupport &&
    candidate.marginalPrecision >= options.minMarginalPrecision && candidate.netGain >= 1;
  return candidate;
}
function discoverLeaves(rows, options) {
  const stats = new Map();
  rows.forEach((row) => {
    combinations(row.features, 1).forEach((conditions) => addStat(stats, conditions, row));
    if (options.maxDepth >= 2) combinations(row.features, 2).forEach((conditions) => addStat(stats, conditions, row));
  });
  return [...stats.values()].map((stat) => summarizeStat(stat, options)).filter((candidate) => candidate.qualified)
    .sort((a, b) => b.depth - a.depth || b.netGain - a.netGain || b.marginalPrecision - a.marginalPrecision || b.support - a.support || a.key.localeCompare(b.key));
}
const learnLeaves = discoverLeaves;

function discoveryCandidateKey(tier, conditions, target) {
  return `${tier}:${leafKey(conditions)}=>${target}`;
}
function discoveryLeadExamples(rows, target) {
  const seen = new Set();
  return rows
    .sort((a, b) => Number(b.expected !== target) - Number(a.expected !== target) || a.id.localeCompare(b.id))
    .flatMap((row) => {
      const key = discoveryRawIdentity(row); if (seen.has(key)) return []; seen.add(key);
      const potential = row.labelStatus !== "known" ? "unknown" : row.expected === target
        ? row.current === target ? "already-correct" : "gain" : "loss";
      return [{ id: row.id, videoId: row.videoId || row.fixture || null, contextId: row.contextId, slotIndex: row.slotIndex,
        tokenIndex: row.tokenIndex, targetOffset: row.targetOffset, context: row.context, creator: row.creator || null, expected: row.expected,
        expectedCandidates: row.expectedCandidates, labelStatus: row.labelStatus, current: row.current || null,
        currentOutcome: row.currentOutcome, potential }];
    }).slice(0, 8);
}
function discoveryUnitRows(unit) { return unit.rows?.length ? unit.rows : unit.row ? [unit.row] : []; }
function cleanTargetUnit(unit, target) {
  return !unit.unknown && unit.labels.size === 1 && unit.labels.has(target);
}
function baselineDiffersFromTarget(unit, target) {
  const rows = discoveryUnitRows(unit);
  return rows.length > 0 && rows.every((row) => row.current !== target);
}
function hasActualCorrectOpposition(unit, target) {
  return discoveryUnitRows(unit).some((row) => row.labelStatus === "known" && row.expected && row.expected !== target &&
    row.current !== target && row.current === row.expected);
}
function hasNewlyWrongOpposition(unit, target) {
  return discoveryUnitRows(unit).some((row) => row.labelStatus === "known" && row.expected && row.expected !== target &&
    row.current !== target && row.current !== row.expected);
}
function discoveryBaselineOutcome(unit, target) {
  if (unit.unknown) return baselineDiffersFromTarget(unit, target) ? "unknown-attempt" : "unknown";
  if (cleanTargetUnit(unit, target)) return baselineDiffersFromTarget(unit, target) ? "gain" : "already-correct";
  if (hasActualCorrectOpposition(unit, target)) return "correct-lost";
  if (hasNewlyWrongOpposition(unit, target)) return "newly-wrong";
  return "opposing";
}
function discoveryConditions(features, maxDepth, phraseWords = 8) {
  const output = new Map();
  const add = (conditions) => output.set(leafKey(conditions), conditions);
  combinations(features, 1).forEach(add);
  if (maxDepth >= 2) combinations(features, 2).forEach(add);
  // Unlike sparse leaves, these are contiguous phrases on either side of the
  // marker.  The target is the implicit centre, so no powerset is generated.
  for (let left = 0; left <= phraseWords; left += 1) for (let right = 0; right <= phraseWords; right += 1) {
    const length = left + right; if (!length || length > phraseWords) continue;
    const conditions = features.filter(({ offset }) => offset < 0 ? offset >= -left : offset <= right);
    if (conditions.length === length) add(conditions);
  }
  return [...output.values()];
}
function discoveryMatchIndex(rows) {
  const index = new Map();
  rows.forEach((row) => row.features.forEach(({ key }) => {
    const bucket = index.get(key) || [];
    bucket.push(row); index.set(key, bucket);
  }));
  return index;
}
function crossTierAudit(candidate, index) {
  // Match the same target-relative features, including punctuation. This is
  // an evidence screen, not execution/validation of a runtime rule template.
  const keys = candidate.conditions.map(({ offset, token }) => `${offset}:${token}`);
  const buckets = keys.map((key) => index.get(key) || []).sort((a, b) => a.length - b.length);
  const matched = (buckets[0] || []).filter((row) => keys.every((key) => row.features.some((feature) => feature.key === key)));
  const units = new Map(); matched.forEach((row) => { const key = discoverySupportIdentity(row), unit = units.get(key) || { row: null, labels: new Set(), candidates: new Set(), unknown: false, rows: [] }; mergeDiscoveryEvidence(unit, row); units.set(key, unit); });
  const values = [...units.values()], clean = values.filter((unit) => cleanTargetUnit(unit, candidate.target)), unknown = values.filter((unit) => unit.unknown), conflicts = values.filter((unit) => !unit.unknown && !cleanTargetUnit(unit, candidate.target));
  const ids = (items) => items.flatMap(discoveryUnitRows).map((row) => row.id).filter(Boolean).slice(0, 10);
  return { status: values.length ? "observed" : "unsupported", support: values.length, clean: clean.length, conflicts: conflicts.length, unknown: unknown.length,
    precision: ratio(clean.length, values.length), exampleIds: ids(values), counterexampleIds: ids(conflicts), unknownIds: ids(unknown) };
}
function discoverDiscoveryLeads(rows, tier, options = {}) {
  options = { maxDepth: 2, phraseWords: 8, minSupport: 4, minCreators: 2, minPrecision: 0.92, minMarginalSupport: 3, minMarginalPrecision: 0.92, limit: 0, ...options };
  if (options.exclude && !(options.exclude instanceof Set)) options.exclude = discoveryExclusions(options.exclude);
  const tierRows = rows.filter((row) => row.pairClass === tier), supportCounts = new Map();
  // Count first.  Unsupported patterns never acquire row/unit maps, which is
  // important for high-cardinality caption corpora.
  tierRows.forEach((row) => discoveryConditions(row.features, options.maxDepth, options.phraseWords).forEach((conditions) => {
    const key = leafKey(conditions); supportCounts.set(key, (supportCounts.get(key) || 0) + 1);
  }));
  const stats = new Map();
  tierRows.forEach((row) => discoveryConditions(row.features, options.maxDepth, options.phraseWords).forEach((conditions) => {
    const key = leafKey(conditions); if ((supportCounts.get(key) || 0) < options.minSupport) return;
    const stat = stats.get(key) || { key, conditions: conditions.slice(), rows: new Map(), units: new Map(), contexts: new Set(), labels: new Map(), candidates: new Map(), unknown: 0, creators: new Set(), rawSupport: 0 };
    stat.rawSupport += 1; stat.contexts.add(discoveryContextIdentity(row)); stat.creators.add(groupKey(row) || "unknown");
    const rawKey = discoveryRawIdentity(row), raw = stat.rows.get(rawKey) || { row: null, labels: new Set(), candidates: new Set(), unknown: false };
    mergeDiscoveryEvidence(raw, row); stat.rows.set(rawKey, raw);
    const unitKey = discoverySupportIdentity(row), unit = stat.units.get(unitKey) || { row: null, labels: new Set(), candidates: new Set(), unknown: false };
    mergeDiscoveryEvidence(unit, row); stat.units.set(unitKey, unit); stats.set(key, stat);
  }));
  const leads = [], rejectedByReason = {}, rejectedSamples = new Map();
  let rejectedCount = 0;
  const rejectionLimit = 10;
  stats.forEach((stat) => {
    const units = [...stat.units.values()], evidence = [...stat.rows.values()];
    units.forEach((unit) => { unit.labels.forEach((label) => count(stat.labels, label)); unit.candidates.forEach((label) => count(stat.candidates, label)); stat.unknown += Number(unit.unknown); });
    const evidenceLabels = new Map(); evidence.forEach((entry) => entry.labels.forEach((label) => count(evidenceLabels, label)));
    [...stat.labels.keys()].forEach((target) => {
      const clean = units.filter((unit) => cleanTargetUnit(unit, target)), support = units.length;
      const targetCount = clean.length, marginalUnits = units.filter((unit) => baselineDiffersFromTarget(unit, target));
      const marginalCorrect = marginalUnits.filter((unit) => cleanTargetUnit(unit, target)).length;
      const potentialGain = marginalCorrect, correctLost = units.filter((unit) => hasActualCorrectOpposition(unit, target)).length;
      const newlyWrong = units.filter((unit) => hasNewlyWrongOpposition(unit, target)).length, potentialLoss = correctLost + newlyWrong;
      const baselineOutcomes = {}; units.forEach((unit) => { const outcome = discoveryBaselineOutcome(unit, target); baselineOutcomes[outcome] = (baselineOutcomes[outcome] || 0) + 1; });
      const targetCreators = [...new Set(clean.map((unit) => canonicalDiscoveryCreator(unit.row)).filter(Boolean))].sort();
      const lead = { id: discoveryCandidateKey(tier, stat.conditions, target), key: stat.key, tier, target, runtimeCompatible: false, promotionEligible: false,
        conditions: stat.conditions.map(({ offset, token, slotIndex, sentenceBoundary }) => ({ offset, token, slotIndex, sentenceBoundary })), depth: stat.conditions.length,
        support, uniqueContextSupport: stat.contexts.size, rawSupport: stat.rawSupport, evidenceSupport: evidence.length, targetCount,
        evidenceTargetCount: evidenceLabels.get(target) || 0, precision: ratio(targetCount, support), evidencePrecision: ratio(evidenceLabels.get(target) || 0, evidence.length),
        marginalSupport: marginalUnits.length, marginalCorrect, marginalPrecision: ratio(marginalCorrect, marginalUnits.length),
        competingLabelCounts: Object.fromEntries([...stat.candidates.entries()].filter(([label]) => label !== target).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]))),
        unknownMatches: stat.unknown, labelCounts: Object.fromEntries(stat.labels), evidenceLabelCounts: Object.fromEntries(evidenceLabels), creatorCount: stat.creators.size, creators: [...stat.creators].sort(),
        targetCreatorCount: targetCreators.length, targetCreators, targetSupportingCreatorCount: targetCreators.length, targetSupportingCreators: targetCreators,
        duplicateContextSupport: stat.rawSupport - support, duplicateRawSupport: stat.rawSupport - evidence.length, baselineOutcomes, potentialGain, potentialLoss, correctLost,
        newlyWrong, unknownAttempts: units.filter((unit) => unit.unknown && baselineDiffersFromTarget(unit, target)).length, potentialNet: potentialGain - potentialLoss,
        leadKind: potentialGain ? "new-rule" : "rediscovery", rediscovery: !potentialGain, baseline: { outcomes: baselineOutcomes, potentialGain, potentialLoss, correctLost, newlyWrong, potentialNet: potentialGain - potentialLoss },
        examples: discoveryLeadExamples(evidence.flatMap(discoveryUnitRows), target) };
      const allCounterexampleRows = evidence.flatMap(discoveryUnitRows).filter((row) => row.labelStatus !== "known" || row.expected !== target);
      lead.exampleIds = lead.examples.map((example) => example.id); lead.counterexampleIds = [...new Set(allCounterexampleRows.map((row) => row.id))];
      const reasons = []; if (support < options.minSupport) reasons.push("support"); if (lead.targetSupportingCreatorCount < options.minCreators) reasons.push("creators");
      if (lead.precision < options.minPrecision) reasons.push("precision"); if (lead.marginalSupport < options.minMarginalSupport) reasons.push("marginalSupport"); if (lead.marginalPrecision < options.minMarginalPrecision) reasons.push("marginalPrecision");
      if (!reasons.length && options.crossTierIndex) {
        lead.crossTier = { tier: options.crossTierTier || null, ...crossTierAudit(lead, options.crossTierIndex) };
        if (lead.crossTier.support >= options.minSupport && lead.crossTier.precision < options.minPrecision) reasons.push("crossTierPrecision");
      }
      lead.qualified = !reasons.length && !(options.exclude instanceof Set && options.exclude.has(lead.id));
      if (lead.qualified) leads.push(lead); else {
        rejectedCount += 1;
        if (options.exclude instanceof Set && options.exclude.has(lead.id) && !reasons.length) reasons.push("excluded");
        const rejectedEntry = { support: lead.support, targetCount: lead.targetCount, precision: lead.precision, marginalSupport: lead.marginalSupport, marginalPrecision: lead.marginalPrecision, targetSupportingCreatorCount: lead.targetSupportingCreatorCount, reasons, crossTier: lead.crossTier || null, counterexampleCount: lead.counterexampleIds.length, counterexampleIds: lead.counterexampleIds.slice(0, rejectionLimit) };
        reasons.forEach((reason) => {
          rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1;
          const samples = rejectedSamples.get(reason) || [];
          if (samples.length < rejectionLimit) samples.push([lead.id, rejectedEntry]);
          rejectedSamples.set(reason, samples);
        });
      }
    });
  });
  const sorted = leads.sort((a,b) => b.precision-a.precision || b.marginalPrecision-a.marginalPrecision || b.targetSupportingCreatorCount-a.targetSupportingCreatorCount || b.potentialGain-a.potentialGain || b.potentialNet-a.potentialNet || a.id.localeCompare(b.id));
  const result = sorted.filter((lead) => !options.word || lead.target === options.word);
  const emitted = options.limit ? result.slice(0, options.limit) : result;
  const rejected = Object.fromEntries([...new Map([...rejectedSamples.values()].flat()).entries()]);
  const rejectedSampleCount = Object.keys(rejected).length;
  const summary = { tested: rejectedCount + leads.length, qualifiedTotal: leads.length, emitted: emitted.length, rejectedCount, rejectedByReason,
    rejectedSampled: true, rejectedSampleCount, rejectedSampleLimitPerReason: rejectionLimit, rejected };
  emitted.summary = summary; return emitted;
}
function discoveryWordSummary(rows, tier) {
  const summary = {}, units = new Map();
  const get = (word) => summary[word] || (summary[word] = { matches: 0, contexts: 0, creators: new Set(), unknownMatches: 0, competingLabelCounts: {} });
  rows.filter((row) => row.pairClass === tier).forEach((row) => {
    const key = discoverySupportIdentity(row), unit = units.get(key) || { row: null, labels: new Set(), candidates: new Set(), unknown: false };
    mergeDiscoveryEvidence(unit, row); units.set(key, unit);
  });
  units.forEach((unit) => {
    const words = [...new Set([...unit.labels, ...unit.candidates])];
    words.forEach((word) => {
      const value = get(word);
      // A contradictory or unknown unit is retained as evidence, but cannot
      // inflate the word's clean support or creator diversity.
      if (cleanTargetUnit(unit, word)) { value.matches += 1; value.contexts += 1; value.creators.add(groupKey(unit.row) || "unknown"); }
      if (unit.unknown) value.unknownMatches += 1;
      unit.candidates.forEach((label) => { if (label !== word) value.competingLabelCounts[label] = (value.competingLabelCounts[label] || 0) + 1; });
    });
  });
  return Object.fromEntries(Object.entries(summary).map(([word, value]) => [word, { ...value, creatorCount: value.creators.size, creators: [...value.creators].sort() }]).sort(([a], [b]) => a.localeCompare(b)));
}
function discoveryOutput(loaded, options) {
  const tiers = {}, rowsByTier = Object.fromEntries(["manual-auto", "synthetic"].map((tier) => [tier, loaded.rows.filter((row) => row.pairClass === tier)]));
  const indexes = Object.fromEntries(["manual-auto", "synthetic"].map((tier) => [tier, discoveryMatchIndex(rowsByTier[tier], options.maxDepth, options.phraseWords)]));
  ["manual-auto", "synthetic"].forEach((tier) => {
    const tierRows = rowsByTier[tier], otherTier = tier === "manual-auto" ? "synthetic" : "manual-auto";
    const leads = discoverDiscoveryLeads(loaded.rows, tier, { ...options, crossTierRows: rowsByTier[otherTier], crossTierIndex: indexes[otherTier], crossTierTier: otherTier });
    tiers[tier] = { rows: tierRows.length, contexts: new Set(tierRows.map((row) => discoveryContextIdentity(row))).size,
      creatorCount: new Set(tierRows.map((row) => groupKey(row) || "unknown")).size,
      creators: [...new Set(tierRows.map((row) => groupKey(row) || "unknown"))].sort(), words: discoveryWordSummary(loaded.rows, tier), leads,
      rejected: leads.summary };
  });
  return { method: "in-sample discovery-only candidate mining", tiers, word: options.word || null,
    note: "All leads are research-only; discovery precision denominators include unknown and conflicting support units, and labels, punctuation, and unknowns are not runtime evidence or promotion validation." };
}
function matchingKeys(row, maxDepth) {
  const keys = combinations(row.features, 1).map(leafKey);
  if (maxDepth >= 2) combinations(row.features, 2).forEach((conditions) => keys.push(leafKey(conditions)));
  return keys;
}
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function renderPattern(conditions, target) {
  if (!conditions.length || [BOUNDARY_LEFT, BOUNDARY_RIGHT].includes(target) || conditions.some(({ token }) => [BOUNDARY_LEFT, BOUNDARY_RIGHT].includes(token))) return null;
  const left = conditions.filter(({ offset }) => offset < 0), right = conditions.filter(({ offset }) => offset > 0);
  const leftWidth = left.length ? Math.max(...left.map(({ offset }) => -offset)) : 0, rightWidth = right.length ? Math.max(...right.map(({ offset }) => offset)) : 0;
  const byOffset = new Map(conditions.map(({ offset, token }) => [offset, token])), tokens = [];
  for (let offset = -leftWidth; offset < 0; offset += 1) tokens.push(byOffset.get(offset) || "*");
  tokens.push(`[${target}]`);
  for (let offset = 1; offset <= rightWidth; offset += 1) tokens.push(byOffset.get(offset) || "*");
  return tokens.join(" ");
}
function runtimePattern(conditions, target) {
  if (!conditions.length || conditions.some(({ token }) => [BOUNDARY_LEFT, BOUNDARY_RIGHT].includes(token)) ||
      runtimeWords(target).join(" ") !== target || !runtimeWords(target).length || conditions.some(({ token }) => runtimeWords(token).join(" ") !== token)) return null;
  return renderPattern(conditions, target);
}
function compileRuntimePattern(pattern) {
  if (!pattern) return null;
  const template = String(pattern).replace(/\[[^\]]+\]/u, "[__]"), blankAt = template.indexOf("[__]");
  if (blankAt < 0) return null;
  const literal = (value) => escapeRegExp(value).replace(/'/g, "['’]").replace(/ /g, "[\\s,\"“”]+");
  const escaped = (literal(template.slice(0, blankAt)) + literal(template.slice(blankAt))).replace(/\\\*/g, "\\S+");
  return new RegExp(`(^|[^\\p{L}\\p{N}_'’])(${escaped})(?=$|[^\\p{L}\\p{N}_'’])`, "iu");
}
function runtimePatternTokenMatch(pattern, context) {
  const wanted = runtimeWords(String(pattern).replace(/\[[^\]]+\]/u, "[__]")), actual = runtimeWords(context);
  if (!wanted.length || wanted.length > actual.length) return false;
  for (let start = 0; start <= actual.length - wanted.length; start += 1) {
    if (wanted.every((token, index) => token === "*" || token === actual[start + index])) return true;
  }
  return false;
}
function runtimePatternMatches(pattern, context) {
  if (!pattern) return false;
  let matcher = RUNTIME_PATTERN_CACHE.get(pattern);
  if (!matcher) { matcher = compileRuntimePattern(pattern); if (matcher) RUNTIME_PATTERN_CACHE.set(pattern, matcher); }
  const text = runtimeText(context);
  return Boolean(matcher && runtimePatternTokenMatch(pattern, text) && matcher.test(text));
}
function candidateMatches(row, candidate, maxDepth) {
  const pattern = runtimePattern(candidate.conditions, candidate.target);
  return Boolean(pattern && matchingKeys(row, maxDepth).includes(candidate.key) && runtimePatternMatches(pattern, row.context));
}
function auditSyntheticTransfer(candidate, rows, options = { maxDepth: 2 }) {
  if (!runtimePattern(candidate.conditions, candidate.target)) return { runtimeCompatible: false, support: 0, targetCount: 0, precision: 0, dominantExpected: null, dominantCount: 0, strongReversal: false };
  const matches = rows.filter((row) => candidateMatches(row, candidate, options.maxDepth)), labels = new Map();
  matches.forEach((row) => count(labels, row.expected));
  const ordered = [...labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), [dominantExpected, dominantCount] = ordered[0] || [null, 0];
  const targetCount = labels.get(candidate.target) || 0;
  return { runtimeCompatible: true, support: matches.length, targetCount, precision: ratio(targetCount, matches.length), dominantExpected, dominantCount,
    strongReversal: matches.length >= 3 && ratio(targetCount, matches.length) < 0.5 && dominantExpected !== candidate.target && dominantCount > targetCount };
}
function transferWarnings(transfer, candidate) {
  if (!transfer.runtimeCompatible) return ["synthetic audit skipped: pattern is not runtime-compatible"];
  if (!transfer.support) return ["synthetic audit: zero support for runtime-compatible pattern"];
  if (transfer.strongReversal) return [`strong synthetic reversal: ${transfer.dominantExpected} ${transfer.dominantCount}/${transfer.support}; ${candidate.target} ${transfer.targetCount}/${transfer.support}`];
  return transfer.targetCount < transfer.support ? [`synthetic counterexample: ${candidate.target} ${transfer.targetCount}/${transfer.support}`] : [];
}
const candidateId = (candidate) => `${candidate.key}=>${candidate.target}`;
function emptyAggregate() { return { support: 0, targetCorrect: 0, marginalSupport: 0, marginalCorrect: 0, baselineCorrect: 0,
  folds: new Set(), evaluatedFolds: new Set(), creators: new Set(), byCreator: new Map() }; }
function ensureAggregateFold(aggregate, foldCreator) {
  if (!foldCreator) return null;
  aggregate.folds.add(foldCreator); aggregate.evaluatedFolds.add(foldCreator);
  let fold = aggregate.byCreator.get(foldCreator);
  if (!fold) { fold = { support: 0, targetCorrect: 0, marginalSupport: 0, marginalCorrect: 0, baselineCorrect: 0 }; aggregate.byCreator.set(foldCreator, fold); }
  return fold;
}
function updateAggregate(aggregate, row, target, foldCreator = "") {
  aggregate.support += 1; aggregate.targetCorrect += Number(row.expected === target);
  const fold = ensureAggregateFold(aggregate, foldCreator); aggregate.creators.add(groupKey(row));
  if (fold) { fold.support += 1; fold.targetCorrect += Number(row.expected === target); }
  if (row.current === target) return;
  aggregate.marginalSupport += 1; aggregate.marginalCorrect += Number(row.expected === target);
  aggregate.baselineCorrect += Number(Boolean(row.current) && row.current === row.expected);
  if (fold) { fold.marginalSupport += 1; fold.marginalCorrect += Number(row.expected === target); fold.baselineCorrect += Number(Boolean(row.current) && row.current === row.expected); }
}
function finishAggregate(aggregate) {
  const folds = [...aggregate.folds].sort(), evaluatedFolds = [...aggregate.evaluatedFolds].sort(), missingFolds = folds.filter((fold) => !aggregate.evaluatedFolds.has(fold));
  const byCreator = Object.fromEntries([...aggregate.byCreator.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([creator, value]) => [creator, {
    ...value, precision: ratio(value.targetCorrect, value.support), marginalPrecision: ratio(value.marginalCorrect, value.marginalSupport), netGain: value.marginalCorrect - value.baselineCorrect }]));
  return { support: aggregate.support, targetCorrect: aggregate.targetCorrect, precision: ratio(aggregate.targetCorrect, aggregate.support),
    marginalSupport: aggregate.marginalSupport, marginalCorrect: aggregate.marginalCorrect, marginalPrecision: ratio(aggregate.marginalCorrect, aggregate.marginalSupport),
    baselineCorrect: aggregate.baselineCorrect, netGain: aggregate.marginalCorrect - aggregate.baselineCorrect, folds, applicableFolds: folds,
    evaluatedFolds, missingFolds, complete: folds.length > 0 && !missingFolds.length, creators: [...aggregate.creators].sort(), byCreator };
}
function baselineStats(rows) {
  const attempted = rows.filter((row) => row.current).length, correct = rows.filter((row) => row.current && row.current === row.expected).length;
  return { rows: rows.length, attempted, correct, precision: ratio(correct, attempted), coverage: ratio(correct, rows.length) };
}
function applicableFoldSpecs(rows, creators, foldValues) {
  const values = foldValues || creators;
  return [...new Set(values)].filter((value) => rows.some((row) => foldValues ? row.creatorFold === value : groupKey(row) === value))
    .map((value) => foldValues ? { id: `fold-${value}`, fold: value } : { id: value, creator: value });
}
function leafIndex(leaves) { const index = new Map(); leaves.forEach((leaf) => (index.get(leaf.key) || (index.set(leaf.key, []), index.get(leaf.key))).push(leaf)); return index; }
function runtimeMatchesForRow(row, leaves, options, byKey = leafIndex(leaves)) {
  return matchingKeys(row, options.maxDepth).flatMap((key) => byKey.get(key) || []).filter((leaf) => runtimePatternMatches(runtimePattern(leaf.conditions, leaf.target), row.context));
}
function leafOrder(leaves) {
  const ordered = leaves.slice().sort((a, b) => b.depth - a.depth || b.precision - a.precision || b.support - a.support || a.key.localeCompare(b.key));
  return new Map(ordered.map((leaf, index) => [leaf, index]));
}
function applyLeaves(rows, leaves, options) {
  const runtimeLeaves = leaves.filter((leaf) => runtimePattern(leaf.conditions, leaf.target)), byKey = leafIndex(runtimeLeaves), rank = leafOrder(runtimeLeaves);
  const result = { ...baselineStats(rows), changed: 0, changedCorrect: 0, changedWrong: 0, modelAttempted: 0, modelCorrect: 0, matched: 0 };
  rows.forEach((row) => {
    const matches = runtimeMatchesForRow(row, runtimeLeaves, options, byKey), selected = matches.sort((a, b) => rank.get(a) - rank.get(b))[0];
    let prediction = row.current;
    if (selected) { result.matched += 1; if (row.current !== selected.target) { prediction = selected.target; result.changed += 1; result.changedCorrect += Number(prediction === row.expected); result.changedWrong += Number(prediction !== row.expected); } }
    result.modelAttempted += Number(Boolean(prediction)); result.modelCorrect += Number(Boolean(prediction) && prediction === row.expected);
  });
  result.modelPrecision = ratio(result.modelCorrect, result.modelAttempted); result.modelCoverage = ratio(result.modelCorrect, result.rows);
  result.changedPrecision = ratio(result.changedCorrect, result.changed); result.netGain = result.modelCorrect - result.correct; return result;
}
function validateFoldInputs(rows, creators, foldValues) {
  if (!Array.isArray(rows)) throw new Error("Validation rows must be an array.");
  if (rows.some((row) => !row || !groupKey(row))) throw new Error("Every validation row must have a creator key.");
  if (foldValues) {
    if (!Array.isArray(foldValues) || !foldValues.length || foldValues.some((fold) => !Number.isSafeInteger(fold) || fold < 0)) throw new Error("Validation fold values are invalid.");
    const folds = new Map();
    rows.forEach((row) => {
      if (!Number.isSafeInteger(row.creatorFold) || !foldValues.includes(row.creatorFold)) throw new Error("Every validation row must have a valid creatorFold.");
      const key = groupKey(row); if (folds.has(key) && folds.get(key) !== row.creatorFold) throw new Error(`Creator ${key} appears in multiple validation folds.`); folds.set(key, row.creatorFold);
    });
  } else if (!Array.isArray(creators)) throw new Error("Validation creators must be an array.");
}
function validateFold(rows, creators, options, foldValues = null, discoveredCandidates = null) {
  validateFoldInputs(rows, creators, foldValues);
  const aggregate = new Map(), folds = [], discovered = discoveredCandidates === null ? discoverLeaves(rows, options) : discoveredCandidates;
  applicableFoldSpecs(rows, creators, foldValues).forEach((spec) => {
    const heldOut = spec.id, train = rows.filter((row) => foldValues ? row.creatorFold !== spec.fold : groupKey(row) !== spec.creator), test = rows.filter((row) => foldValues ? row.creatorFold === spec.fold : groupKey(row) === spec.creator);
    const trainLeaves = learnLeaves(train, options).filter((leaf) => runtimePattern(leaf.conditions, leaf.target)), byKey = leafIndex(trainLeaves), trainIds = new Set(trainLeaves.map(candidateId));
    discovered.filter((candidate) => trainIds.has(candidateId(candidate))).forEach((candidate) => { const aggregateForCandidate = aggregate.get(candidateId(candidate)) || emptyAggregate(); ensureAggregateFold(aggregateForCandidate, heldOut); aggregate.set(candidateId(candidate), aggregateForCandidate); });
    const rank = leafOrder(trainLeaves), metrics = { creator: heldOut, creatorName: test[0]?.creator || heldOut, rows: test.length, learnedLeaves: trainLeaves.length,
      attempted: 0, correct: 0, matched: 0, changed: 0, changedCorrect: 0, changedWrong: 0, modelAttempted: 0, modelCorrect: 0 };
    test.forEach((row) => {
      metrics.attempted += Number(Boolean(row.current)); metrics.correct += Number(Boolean(row.current) && row.current === row.expected);
      const matches = runtimeMatchesForRow(row, trainLeaves, options, byKey);
      matches.forEach((leaf) => { const candidate = aggregate.get(candidateId(leaf)); if (candidate) updateAggregate(candidate, row, leaf.target, heldOut); });
      const selected = matches.sort((a, b) => rank.get(a) - rank.get(b))[0]; let prediction = row.current;
      if (selected) { metrics.matched += 1; if (row.current !== selected.target) { prediction = selected.target; metrics.changed += 1; metrics.changedCorrect += Number(prediction === row.expected); metrics.changedWrong += Number(prediction !== row.expected); } }
      metrics.modelAttempted += Number(Boolean(prediction)); metrics.modelCorrect += Number(Boolean(prediction) && prediction === row.expected);
    });
    metrics.precision = ratio(metrics.correct, metrics.attempted); metrics.coverage = ratio(metrics.correct, metrics.rows); metrics.modelPrecision = ratio(metrics.modelCorrect, metrics.modelAttempted);
    metrics.modelCoverage = ratio(metrics.modelCorrect, metrics.rows); metrics.changedPrecision = ratio(metrics.changedCorrect, metrics.changed); metrics.netGain = metrics.modelCorrect - metrics.correct; folds.push(metrics);
  });
  const totals = folds.reduce((sum, fold) => { ["rows", "attempted", "correct", "matched", "changed", "changedCorrect", "changedWrong", "modelAttempted", "modelCorrect", "learnedLeaves"].forEach((key) => { sum[key] += fold[key]; }); return sum; },
    { rows: 0, attempted: 0, correct: 0, matched: 0, changed: 0, changedCorrect: 0, changedWrong: 0, modelAttempted: 0, modelCorrect: 0, learnedLeaves: 0 });
  return { folds, totals: { ...totals, foldCount: folds.length, precision: ratio(totals.correct, totals.attempted), coverage: ratio(totals.correct, totals.rows),
    modelPrecision: ratio(totals.modelCorrect, totals.modelAttempted), modelCoverage: ratio(totals.modelCorrect, totals.rows), changedPrecision: ratio(totals.changedCorrect, totals.changed), netGain: totals.modelCorrect - totals.correct }, candidates: aggregate };
}
function examplesFor(candidate, rows, options) {
  const matches = rows.filter((row) => candidateMatches(row, candidate, options.maxDepth)).sort((a, b) => Number(b.expected === candidate.target && b.current !== candidate.target) - Number(a.expected === candidate.target && a.current !== candidate.target));
  const seen = new Set();
  return matches.flatMap((row) => { if (seen.has(row.context)) return []; seen.add(row.context); return [{ fixture: row.fixture, tokenIndex: row.tokenIndex, creator: row.creator, creatorId: row.creatorId || null,
    context: row.context, expected: row.expected, current: row.current || null, changed: row.current !== candidate.target, correct: row.expected === candidate.target }]; }).slice(0, 8);
}
function serializeProposal(candidate, validation, rows, options, syntheticRows = []) {
  const validationStats = finishAggregate(validation || emptyAggregate()), synthetic = auditSyntheticTransfer(candidate, syntheticRows, options);
  return { id: candidateId(candidate), runtimeCompatible: true, pattern: renderPattern(candidate.conditions, candidate.target),
    conditions: candidate.conditions.map(({ offset, token }) => ({ offset, token })), depth: candidate.depth, support: candidate.support, precision: candidate.precision,
    marginalSupport: candidate.marginalSupport, marginalPrecision: candidate.marginalPrecision, marginalCorrect: candidate.marginalCorrect, baselineCorrect: candidate.baselineCorrect,
    netGain: candidate.netGain, creators: candidate.creators, creatorCount: candidate.creatorCount, labelCounts: candidate.labels, validation: validationStats,
    syntheticTransfer: synthetic, transferWarnings: transferWarnings(synthetic, candidate), examples: examplesFor(candidate, rows, options) };
}
function creatorSummary(creators) {
  return Object.fromEntries([...creators.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, { creator: value.creator, creatorId: value.creatorId || null,
    rows: value.rows, fixtures: value.fixtures.size, labels: Object.fromEntries([...value.labels.entries()].filter(([label]) => label).sort((a, b) => b[1] - a[1])), currentAttempted: value.currentAttempted,
    currentCorrect: value.currentCorrect, currentPrecision: ratio(value.currentCorrect, value.currentAttempted), currentCoverage: ratio(value.currentCorrect, value.rows) }]));
}
function archivePaths(reportPath, provenancePath) {
  const useArchive = path.resolve(root, reportPath) === path.resolve(root, DEFAULT_REPORT) && path.resolve(root, provenancePath) === path.resolve(root, DEFAULT_PROVENANCE);
  const reports = useArchive ? DEFAULT_REPORTS.map((file) => path.resolve(root, file)) : [reportPath];
  const provenance = useArchive ? DEFAULT_PROVENANCE_REPORTS : [provenancePath];
  return { reports: [...new Set(reports)].filter((file) => fs.existsSync(file)), provenance: [...new Set(provenance)].filter((file) => fs.existsSync(file)) };
}
function loadSyntheticArchive(reportPath, provenancePath, before = 2, after = 2) {
  const paths = archivePaths(reportPath, provenancePath);
  if (!paths.reports.length || !paths.provenance.length) throw new Error("Synthetic audit needs a report and provenance archive.");
  const archived = loadArchivedRows(paths.reports, paths.provenance), skipped = { missingProvenance: 0, nonTargetPairClass: 0, unlabeled: 0, ambiguous: 0, noContext: 0 }, rows = [], fixtures = new Set();
  archived.rows.forEach((raw) => {
    if (raw.pairClass !== "synthetic") { skipped[raw.pairClass === "unknown" ? "missingProvenance" : "nonTargetPairClass"] += 1; return; }
    fixtures.add(raw.fixture);
    if (!raw.expected.length) { skipped.unlabeled += 1; return; }
    if (raw.expected.length !== 1) { skipped.ambiguous += 1; return; }
    const expected = normalizeWord(raw.expected[0]), features = featureVector(raw.context, before, after);
    if (!expected) { skipped.unlabeled += 1; return; }
    if (!features) { skipped.noContext += 1; return; }
    rows.push({ id: raw.id, fixture: raw.fixture, tokenIndex: raw.tokenIndex, creator: raw.creator, creatorId: raw.creatorId,
      context: raw.context, expected, current: normalizeWord(raw.current || raw.predicted), features });
  });
  return { rows, fixtures, skipped, reports: paths.reports, provenance: paths.provenance, archivedRows: archived.rows.length };
}
function writeOutput(output, outputPath) {
  const destination = path.resolve(root, outputPath); fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`); fs.renameSync(temporary, destination);
  return destination;
}
function discoveryExclusions(value) {
  if (!value) return new Set();
  const parsed = Array.isArray(value) ? value : (() => {
    try { return String(value).trim().startsWith("[") ? JSON.parse(value) : JSON.parse(fs.readFileSync(value, "utf8")); }
    catch (error) { throw new Error(`--exclude must be a JSON array or a file containing one: ${error.message}`); }
  })();
  const keys = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.keys) ? parsed.keys : null;
  if (!keys || keys.some((key) => typeof key !== "string")) throw new Error("--exclude must contain an array of exact candidate keys.");
  return new Set(keys);
}
function runDiscoveryDataset(datasetPath, options) {
  const discoveryOptions = { before: 4, after: 4, phraseWords: 8, maxDepth: 2, minSupport: 4, minCreators: 2, minPrecision: 0.92, minMarginalSupport: 3, minMarginalPrecision: 0.92, limit: 0, ...options, phraseWords: options.phraseWords ?? 8 };
  // maxDepth controls sparse feature combinations only; phraseWords controls the independent contiguous phrase pass.
  // Keep the faithful miner's historical two-token defaults; automatic
  // discovery widens its window unless the caller selected another window.
  if (!options._explicitWindow?.before) discoveryOptions.before = 4;
  if (!options._explicitWindow?.after) discoveryOptions.after = 4;
  if (!options._explicitLimit) discoveryOptions.limit = 0;
  discoveryOptions.exclude = discoveryExclusions(discoveryOptions.exclude);
  if (discoveryOptions.word !== undefined) discoveryOptions.word = normalizeWord(discoveryOptions.word);
  const loaded = loadDiscoveryDataset(datasetPath, discoveryOptions.before, discoveryOptions.after), discovery = discoveryOutput(loaded, discoveryOptions);
  const creatorNames = [...new Set(loaded.rows.map((row) => groupKey(row) || "unknown"))].sort();
  const output = { version: 2, learner: "offline-shallow-contextual-leaves", generatedAt: new Date().toISOString(), discoveryOnly: true, source: {
    report: null, dataset: path.relative(root, datasetPath), syntheticReports: [], provenance: null,
    syntheticProvenance: [], rulesFingerprint: null, mode: "discovery-only", validation: "discovery-only",
    discoveryOnly: true, pairClass: null },
    options: { before: discoveryOptions.before, after: discoveryOptions.after, phraseWords: discoveryOptions.phraseWords, maxDepth: discoveryOptions.maxDepth, limit: discoveryOptions.limit, word: discoveryOptions.word || null },
    thresholds: { support: discoveryOptions.minSupport, marginalSupport: discoveryOptions.minMarginalSupport, precision: discoveryOptions.minPrecision,
      marginalPrecision: discoveryOptions.minMarginalPrecision, creators: discoveryOptions.minCreators },
    data: { rows: loaded.rows.length, fixtures: loaded.fixtures.size, creators: creatorNames.length, validationEligible: false,
      skipped: loaded.skipped, candidateLeaves: Object.values(discovery.tiers).reduce((sum, tier) => sum + tier.leads.length, 0), proposals: 0 },
    creators: creatorSummary(loaded.creators), baseline: baselineStats(loaded.rows), inSample: null, validated: false,
    discovery, creatorFoldValidation: { eligible: false, validated: false, status: "discovery-only",
      reason: "caption-discovery v2 datasets are research-only and cannot supply faithful validation or promotion proposals.",
      method: "not run", model: "No validation evidence was used.", proposalSelection: "disabled for discovery-only input",
      creatorCount: creatorNames.length, foldCount: 0, totals: null, folds: [] }, proposals: [] };
  const outputPath = discoveryOptions.output || DEFAULT_OUTPUT, destination = writeOutput(output, outputPath);
  console.log(JSON.stringify({ output: path.relative(root, destination), rows: output.data.rows, creators: output.data.creators,
    tiers: Object.fromEntries(Object.entries(output.discovery.tiers).map(([tier, value]) => [tier, { rows: value.rows, leads: value.leads.length, words: Object.keys(value.words).length }])), proposals: 0 }));
  return output;
}
function run(options) {
  const datasetPath = options.dataset ? path.resolve(root, options.dataset) : "";
  if (datasetPath) {
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(datasetPath, "utf8")); } catch { metadata = null; }
    if (metadata?.dataset === "caption-discovery") return runDiscoveryDataset(datasetPath, options);
  }
  const reportPath = path.resolve(root, options.report || DEFAULT_REPORT), provenancePath = path.resolve(root, options.provenance || DEFAULT_PROVENANCE);
  const loaded = datasetPath ? loadDataset(datasetPath, options.before, options.after) : loadRows(reportPath, provenancePath, options.before, options.after), synthetic = loadSyntheticArchive(reportPath, provenancePath, options.before, options.after);
  const rows = loaded.rows; if (!rows.length) throw new Error("No labeled manual-auto rows with a usable context were found.");
  const validation = validationEligibility(datasetPath, loaded.dataset), creatorNames = [...new Set(rows.map(groupKey))].sort();
  const foldValues = validation.eligible ? Array.from({ length: loaded.dataset.foldCount }, (_, fold) => fold) : null;
  if (foldValues && new Set(rows.map((row) => row.creatorFold)).size < 2) throw new Error("Dataset must contain at least two populated creator folds.");
  const leaves = discoverLeaves(rows, options), runtimeLeaves = leaves.filter((candidate) => runtimePattern(candidate.conditions, candidate.target));
  const foldValidation = validation.eligible ? validateFold(rows, creatorNames, options, foldValues, leaves) : null;
  const inSample = applyLeaves(rows, leaves, options);
  const proposals = validation.eligible ? runtimeLeaves.map((candidate) => serializeProposal(candidate, foldValidation.candidates.get(candidateId(candidate)), rows, options, synthetic.rows))
    .filter((proposal) => proposal.validation.complete && proposal.validation.support >= options.minValidationSupport && proposal.validation.applicableFolds.length >= options.minValidationFolds &&
      !proposal.validation.missingFolds.length && proposal.validation.precision >= options.minValidationPrecision && proposal.validation.marginalSupport >= options.minValidationSupport &&
      proposal.validation.marginalPrecision >= options.minValidationMarginalPrecision && proposal.validation.netGain >= 1)
    .sort((a, b) => b.validation.netGain - a.validation.netGain || b.validation.marginalPrecision - a.validation.marginalPrecision || b.validation.marginalCorrect - a.validation.marginalCorrect || b.support - a.support || a.id.localeCompare(b.id)).slice(0, options.limit) : [];
  const inputMetadata = datasetPath ? loaded.dataset : loaded.report;
  const creatorFoldValidation = { eligible: validation.eligible, status: validation.eligible ? "validated" : "discovery-only", reason: validation.reason,
    method: validation.eligible ? loaded.dataset.foldMethod || "fixed creator folds" : "not run; an explicit faithful validation dataset is required",
    model: validation.eligible ? "training-qualified runtime leaves are applied to held-out rows; held-out rows never train a fold model" : "No held-out creator-fold evidence was used.",
    proposalSelection: validation.eligible ? "screening only; candidate metrics are conditional and are not an unbiased post-selection estimate" : "disabled until faithful-only validation is available",
    creatorCount: creatorNames.length, foldCount: foldValidation ? foldValidation.folds.length : 0, totals: foldValidation?.totals || null, folds: foldValidation?.folds || [] };
  const output = { version: 2, learner: "offline-shallow-contextual-leaves", generatedAt: new Date().toISOString(), source: {
    report: datasetPath ? null : path.relative(root, reportPath), dataset: datasetPath ? path.relative(root, datasetPath) : null,
    syntheticReports: synthetic.reports.map((file) => path.relative(root, file)), provenance: datasetPath ? loaded.dataset.provenance?.reports || null : path.relative(root, provenancePath),
    syntheticProvenance: synthetic.provenance.map((file) => path.relative(root, file)), rulesFingerprint: loaded.report.rulesFingerprint || null,
    mode: inputMetadata.mode || null, validation: datasetPath ? loaded.dataset.validation || null : null, discoveryOnly: !validation.eligible, pairClass: "manual-auto" },
    options: { before: options.before, after: options.after, maxDepth: options.maxDepth }, thresholds: { support: options.minSupport, marginalSupport: options.minMarginalSupport, precision: options.minPrecision,
      marginalPrecision: options.minMarginalPrecision, creators: options.minCreators, validationSupport: options.minValidationSupport, validationFolds: options.minValidationFolds,
      validationPrecision: options.minValidationPrecision, validationMarginalPrecision: options.minValidationMarginalPrecision }, data: { rows: rows.length, fixtures: loaded.fixtures.size, creators: creatorNames.length,
      validationEligible: validation.eligible, skipped: loaded.skipped, candidateLeaves: leaves.length, runtimeCandidateLeaves: runtimeLeaves.length, nonRuntimeCandidateLeaves: leaves.length - runtimeLeaves.length, proposals: proposals.length,
      syntheticRows: synthetic.rows.length, syntheticFixtures: synthetic.fixtures.size, syntheticArchiveRows: synthetic.archivedRows, syntheticSkipped: synthetic.skipped }, creators: creatorSummary(loaded.creators), baseline: baselineStats(rows), inSample,
    discovery: { method: "in-sample candidate mining; labels and rows are used only to find review candidates", candidateLeaves: leaves.length, runtimeCandidateLeaves: runtimeLeaves.length,
      nonRuntimeCandidateLeaves: leaves.length - runtimeLeaves.length, note: "Discovery metrics are descriptive; precision denominators include unknown and conflicting support units and are not held-out evidence.", diagnostics: "Window-edge candidates remain discovery-only; they are not converted to runtime anchors.", validationGate: validation.reason },
    syntheticAudit: { reports: synthetic.reports.map((file) => path.relative(root, file)), provenance: synthetic.provenance.map((file) => path.relative(root, file)), archivedRows: synthetic.archivedRows, usableRows: synthetic.rows.length, complete: true },
    creatorFoldValidation, proposals };
  const outputPath = writeOutput(output, options.output);
  console.log(JSON.stringify({ output: path.relative(root, outputPath), data: output.data, baseline: output.baseline, inSample: output.inSample, creatorFoldValidation: output.creatorFoldValidation, proposals: proposals.length }, null, 2));
  return output;
}
if (require.main === module) { try { run(parseArgs()); } catch (error) { console.error(error.message || error); process.exit(1); } }
module.exports = { parseArgs, loadDataset, loadDiscoveryDataset, isFaithfulValidationDataset, loadSyntheticArchive, featureVector, discoveryFeatureVector, prepareRows,
  learnLeaves, discoverDiscoveryLeads, discoveryOutput, validateFold, applyLeaves, auditSyntheticTransfer, transferWarnings, runtimePattern, runtimePatternMatches, run, renderPattern,
  MAX_WINDOW_SIDE };
