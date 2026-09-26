#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { currentChoice, localRows } = require("./audit-current-rules");
const { currentFingerprints } = require("./evaluation-metrics");
const { buildProvenanceIndex, fixturePart, EVIDENCE_POLICY } = require("./audit-caption-corpus");
const {
  DEFAULT_REPORTS, DEFAULT_PROVENANCE_REPORTS, censoredSlotCount: markerCount,
  compareText, loadArchivedRows
} = require("./archived-rules-benchmark");

const root = path.join(__dirname, "..");
const DEFAULT_FIXTURES = "test-fixtures";
const DEFAULT_OUTPUT = ".tmp-real-manual-auto-dataset.json";
const DEFAULT_FAITHFUL_OUTPUT = ".tmp-real-manual-auto-faithful.json";
const DEFAULT_FOLDS = 5;
const DATASET_MODES = new Set(["faithful", "faithful-only", "archived", "archived-discovery"]);
const CREATOR_ID = /^UC[A-Za-z0-9_-]{22}$/u;
const MARKER = /\[\s*__\s*\]/gu;
const UNKNOWN = /^(?:anonymous|na|n\/a|none|null|unknown)(?: creator)?$/u;
const FOLD_METHOD = "sha256(creator-key) modulo fold-count; canonical creatorId, otherwise normalized creator name; unknown creators excluded";
const SELECTION_POLICY = "whole-fixture; duplicate fixture versions use stable source-path precedence, never label counts";
const FAITHFUL_POLICY = "raw local auto/manual fixtures; one row per aligned censored slot; archived evaluator contexts excluded";

const text = (value) => typeof value === "string" ? value.trim() : "";
const creatorName = (row) => text(row.creator).normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
const normalizedWord = (value) => text(value).toLowerCase().replace(/[.!?,;:]+$/u, "");
const normalizedContext = (value) => text(value).normalize("NFKC").replace(/\s+/gu, " ")
  .replace(MARKER, "[__]").toLowerCase();
const isUnknownCreator = (row) => !CREATOR_ID.test(text(row.creatorId)) &&
  (!creatorName(row) || UNKNOWN.test(creatorName(row)));

function creatorKey(row) {
  const id = text(row.creatorId);
  const name = creatorName(row);
  return CREATOR_ID.test(id) ? `id:${id}` : name && !UNKNOWN.test(name) ? `name:${name}` : "";
}

function creatorFold(key, foldCount) {
  if (!key) return null;
  return crypto.createHash("sha256").update(key).digest().readUInt32BE(0) % foldCount;
}

function currentPrediction(context, slotIndex = 0) {
  const choice = currentChoice(context, slotIndex);
  return normalizedWord(choice?.word);
}

function normalizedMode(mode) {
  return mode === "faithful-only" ? "faithful" : mode === "archived-discovery" ? "archived" : mode;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
}

function parseArgs(argv) {
  const args = { mode: "archived", fixturesDir: DEFAULT_FIXTURES, reportPaths: DEFAULT_REPORTS,
    provenanceReports: DEFAULT_PROVENANCE_REPORTS, outputPath: DEFAULT_OUTPUT, foldCount: DEFAULT_FOLDS };
  let outputSpecified = false;
  const take = (value, index) => {
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${value}.`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--mode") {
      const mode = take(value, index++);
      if (!DATASET_MODES.has(mode)) throw new Error("--mode must be faithful or archived.");
      args.mode = normalizedMode(mode);
    } else if (value === "--fixtures" || value === "--fixtures-dir") args.fixturesDir = take(value, index++);
    else if (value === "--report" || value === "--reports") {
      if (args.reportPaths === DEFAULT_REPORTS) args.reportPaths = [];
      args.reportPaths.push(...take(value, index++).split(",").filter(Boolean));
    } else if (value === "--provenance-report" || value === "--provenance") {
      if (args.provenanceReports === DEFAULT_PROVENANCE_REPORTS) args.provenanceReports = [];
      args.provenanceReports.push(...take(value, index++).split(",").filter(Boolean));
    } else if (value === "--output") {
      args.outputPath = take(value, index++);
      outputSpecified = true;
    } else if (value === "--folds") args.foldCount = positive(take(value, index++), "--folds");
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (args.mode === "faithful" && !outputSpecified) args.outputPath = DEFAULT_FAITHFUL_OUTPUT;
  return args;
}

function stablePaths(files) {
  return [...files].sort((left, right) => compareText(
    path.relative(root, path.resolve(root, left)), path.relative(root, path.resolve(root, right))) ||
    compareText(path.resolve(root, left), path.resolve(root, right)));
}

function resolvedCreatorKey(row, idsByName) {
  const id = text(row.creatorId);
  if (CREATOR_ID.test(id)) return `id:${id}`;
  const ids = idsByName.get(creatorName(row));
  if (ids?.size > 1) return "";
  if (ids?.size === 1) return `id:${[...ids][0]}`;
  return creatorKey(row);
}

const rowIds = (rows) => rows.map((row) => String(row.id)).sort(compareText);
function exclusion(rows, details) {
  const result = { count: rows.length, rowIds: rowIds(rows) };
  if (details) result.markerCounts = Object.fromEntries([...new Set(rows.map((row) => markerCount(row.context)))].sort((a, b) => a - b)
    .map((count) => [count, rows.filter((row) => markerCount(row.context) === count).length]));
  return result;
}

function duplicateDiagnostics(loaded, fixtureIds) {
  const source = loaded.duplicateDiagnostics || {};
  const conflicts = (source.conflicts || []).filter(({ fixture }) => fixtureIds.has(fixture));
  return {
    inputRows: loaded.inputRows, retainedRows: loaded.rows.length, duplicateRows: loaded.duplicateRows,
    duplicateFixtures: loaded.duplicateFixtures, duplicateFixtureVersions: loaded.duplicateFixtureVersions,
    duplicateSlots: (source.duplicateSlots || []).length, exactDuplicateSlots: (source.exactDuplicateSlots || []).length,
    conflictingSlots: (source.conflicts || []).length, conflictFixtures: (source.conflictFixtures || []).length,
    selectedPairConflicts: conflicts.length, conflicts
  };
}

function contextLeakage(rows) {
  const byContext = new Map();
  rows.forEach((row) => {
    const key = normalizedContext(row.context);
    if (!byContext.has(key)) byContext.set(key, []);
    byContext.get(key).push(row);
  });
  const repeated = [], leaking = [];
  [...byContext.entries()].sort(([a], [b]) => compareText(a, b)).forEach(([context, values]) => {
    if (values.length < 2) return;
    const detail = { context, rowIds: rowIds(values),
      creators: [...new Set(values.map((row) => row.creatorKey))].sort(compareText),
      folds: [...new Set(values.map((row) => row.creatorFold))].sort((a, b) => a - b) };
    repeated.push(detail);
    if (detail.creators.length > 1 || detail.folds.length > 1) leaking.push(detail);
  });
  return {
    uniqueContexts: byContext.size, repeatedContexts: repeated.length,
    repeatedRows: repeated.reduce((n, item) => n + item.rowIds.length, 0),
    leakingContexts: leaking.length, leakingRows: leaking.reduce((n, item) => n + item.rowIds.length, 0),
    leakingCreators: new Set(leaking.flatMap((item) => item.creators)).size, contexts: leaking
  };
}

function sourceDescriptor(file) {
  const absolute = path.resolve(root, file);
  return { path: path.relative(root, absolute) || absolute,
    sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}` };
}

function localSources(fixturesDir) {
  const directory = path.resolve(root, fixturesDir);
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => fixturePart(name)).sort(compareText)
    .map((name) => sourceDescriptor(path.join(directory, name))) : [];
}

function faithfulDuplicateDiagnostics(rows) {
  const duplicateRows = rows.length - new Set(rows.map((row) => row.id)).size;
  return { inputRows: rows.length, retainedRows: rows.length - duplicateRows, duplicateRows,
    duplicateFixtures: 0, duplicateFixtureVersions: 0, duplicateSlots: duplicateRows,
    exactDuplicateSlots: duplicateRows, conflictingSlots: 0, conflictFixtures: 0,
    selectedPairConflicts: 0, conflicts: [] };
}

function groupCreators(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const group = groups.get(row.creatorKey) || { creator: row.creator, creatorId: row.creatorKey.startsWith("id:") ? row.creatorKey.slice(3) : "",
      creatorHandle: row.creatorHandle, creatorKey: row.creatorKey, creatorFold: row.creatorFold, fixtures: new Set(), rowIds: [] };
    group.fixtures.add(row.videoId); group.rowIds.push(row.id); groups.set(row.creatorKey, group);
  });
  return [...groups.values()].sort((a, b) => compareText(a.creatorKey, b.creatorKey)).map((group) => ({
    creator: group.creator, creatorId: group.creatorId, creatorHandle: group.creatorHandle,
    creatorKey: group.creatorKey, creatorFold: group.creatorFold, fixtureCount: group.fixtures.size,
    rowCount: group.rowIds.length, rowIds: group.rowIds
  }));
}

function buildDataset({ mode, inputRows, foldCount, loaded, fixturesDir, provenanceReports, provenance }) {
  const idsByName = new Map();
  inputRows.filter((row) => row.evidenceEligible !== false).forEach((row) => {
    const name = creatorName(row), id = text(row.creatorId);
    if (!name || isUnknownCreator(row) || !CREATOR_ID.test(id)) return;
    const ids = idsByName.get(name) || new Set(); ids.add(id); idsByName.set(name, ids);
  });
  const excluded = Object.fromEntries(["incompleteProvenance", "unlabeledExpected", "multiLabelExpected", "unknownCreator",
    "ambiguousCreator", "invalidExpected", "invalidContext"].map((key) => [key, []]));
  const rows = [];
  inputRows.forEach((raw) => {
    const fail = (key) => excluded[key].push(raw);
    if (raw.evidenceEligible === false) return fail("incompleteProvenance");
    if (!raw.expected.length) return fail("unlabeledExpected");
    if (raw.expected.length !== 1) return fail("multiLabelExpected");
    const expected = normalizedWord(raw.expected[0]);
    if (!expected) return fail("invalidExpected");
    if (isUnknownCreator(raw)) return fail("unknownCreator");
    const key = resolvedCreatorKey(raw, idsByName);
    if (!key) return fail("ambiguousCreator");
    const context = mode === "faithful" ? raw.originalContext || raw.context : raw.context;
    if (mode === "faithful" ? !raw.contextFaithful || markerCount(context) < 1 : markerCount(context) !== 1) {
      return fail("invalidContext");
    }
    rows.push({ id: raw.id, videoId: raw.fixture, tokenIndex: raw.tokenIndex,
      ...(mode === "faithful" ? { slotIndex: raw.slotIndex, originalContext: context,
        contextFaithful: true, contextSource: raw.contextSource || "fixture-original" } : {}),
      creator: text(raw.creator), creatorId: CREATOR_ID.test(text(raw.creatorId)) ? text(raw.creatorId) : key.startsWith("id:") ? key.slice(3) : "",
      creatorHandle: text(raw.creatorHandle), creatorKey: key, creatorFold: creatorFold(key, foldCount),
      context, expected, currentPrediction: currentPrediction(context, raw.slotIndex),
      evidenceEligible: raw.evidenceEligible !== false, reportEvidence: raw.reportEvidence || {},
      source: mode === "faithful" ? raw.sourceFiles?.[0] || path.relative(root, path.resolve(root, fixturesDir)) || fixturesDir : raw.source });
  });
  rows.sort((a, b) => compareText(a.creatorKey, b.creatorKey) || compareText(a.videoId, b.videoId) ||
    a.tokenIndex - b.tokenIndex || compareText(a.id, b.id));
  const creators = groupCreators(rows);
  const creatorsByFold = Object.fromEntries(Array.from({ length: foldCount }, (_, fold) => [fold, 0]));
  creators.forEach((group) => { creatorsByFold[group.creatorFold] += 1; });
  const exclusions = Object.fromEntries(Object.entries(excluded).map(([key, values]) => [key,
    exclusion(values, key === "invalidContext")]));
  const fingerprints = currentFingerprints();
  const provenanceSources = mode === "faithful" ? stablePaths(provenanceReports).map(sourceDescriptor) : loaded.provenanceSources;
  const result = {
    version: 3, dataset: "real-manual-auto", pairClass: "manual-auto", mode,
    validation: mode === "faithful" ? "faithful-only" : "discovery-only", discoveryOnly: mode !== "faithful",
    foldCount, foldMethod: FOLD_METHOD, selectionPolicy: mode === "faithful" ? FAITHFUL_POLICY : SELECTION_POLICY,
    contextPolicy: mode === "faithful" ? "raw local auto fixture context, including all original caption slots" :
      "archived evaluator contexts are discovery-only; validation requires raw local fixtures",
    ...fingerprints,
    sources: mode === "faithful" ? localSources(fixturesDir) : loaded.sources.map(({ path: sourcePath, sha256 }) => ({ path: sourcePath, sha256 })),
    provenance: { reports: provenanceSources, indexedPairCount: mode === "faithful" ? provenance.size : loaded.indexedPairCount,
      ...(mode === "faithful" ? { evidencePolicy: EVIDENCE_POLICY } : {}) },
    summary: {
      rows: rows.length, creators: creators.length, fixtures: new Set(rows.map((row) => row.videoId)).size,
      creatorsByFold, manualAutoInputRows: inputRows.length,
      ...(mode === "faithful" ? { faithfulInputRows: inputRows.filter((row) => row.contextFaithful).length } : {}),
      excludedRows: Object.values(excluded).reduce((n, values) => n + values.length, 0),
      exclusions: Object.fromEntries(Object.entries(exclusions).map(([key, value]) => [key, value.count]))
    },
    diagnostics: { exclusions,
      duplicates: mode === "faithful" ? faithfulDuplicateDiagnostics(inputRows) : duplicateDiagnostics(loaded, new Set(inputRows.map((row) => row.fixture))),
      contextLeakage: contextLeakage(rows), ...(mode === "faithful" ? { archivedContextsExcluded: true } : {}) },
    creators, rows
  };
  if (mode === "faithful") result.fixturesDir = path.relative(root, path.resolve(root, fixturesDir)) || fixturesDir;
  return result;
}

function buildArchivedDataset({ reportPaths = DEFAULT_REPORTS, provenanceReports = DEFAULT_PROVENANCE_REPORTS,
  foldCount = DEFAULT_FOLDS } = {}) {
  foldCount = positive(foldCount, "foldCount");
  const reports = stablePaths(reportPaths), provenanceFiles = stablePaths(provenanceReports);
  const loaded = loadArchivedRows(reports, provenanceFiles, { selectionPolicy: "source-precedence" });
  return buildDataset({ mode: "archived", inputRows: loaded.rows.filter((row) => row.pairClass === "manual-auto"),
    foldCount, loaded, provenanceReports: provenanceFiles });
}

function buildFaithfulDataset({ fixturesDir = DEFAULT_FIXTURES, provenanceReports = DEFAULT_PROVENANCE_REPORTS,
  foldCount = DEFAULT_FOLDS } = {}) {
  foldCount = positive(foldCount, "foldCount");
  const files = stablePaths(provenanceReports).map((file) => path.resolve(root, file));
  const provenance = buildProvenanceIndex(files);
  return buildDataset({ mode: "faithful", inputRows: localRows(path.resolve(root, fixturesDir), provenance, new Set(["manual-auto"])),
    foldCount, fixturesDir, provenanceReports: files, provenance });
}

function buildRealManualAutoDataset(options = {}) {
  const mode = normalizedMode(options.mode || "archived");
  if (!DATASET_MODES.has(options.mode || mode) || !["faithful", "archived"].includes(mode)) {
    throw new Error("mode must be faithful or archived.");
  }
  return mode === "faithful" ? buildFaithfulDataset(options) : buildArchivedDataset(options);
}

function writeDataset(dataset, outputPath) {
  const output = `${JSON.stringify(dataset, null, 2)}\n`;
  if (outputPath === "-") process.stdout.write(output);
  else { const destination = path.resolve(root, outputPath); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, output); }
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const dataset = buildRealManualAutoDataset(args);
    writeDataset(dataset, args.outputPath);
    if (args.outputPath !== "-") console.log(JSON.stringify({ output: args.outputPath, summary: dataset.summary }, null, 2));
  } catch (error) { console.error(error.message || error); process.exit(1); }
}

module.exports = { buildFaithfulDataset, buildRealManualAutoDataset, creatorFold, creatorKey,
  currentFingerprints, currentPrediction, parseArgs };
