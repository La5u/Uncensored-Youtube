const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildRealManualAutoDataset,
  creatorFold,
  creatorKey,
  currentPrediction,
  parseArgs
} = require("../tools/build-real-manual-auto-dataset");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-real-dataset-"));
try {
  const reportPath = path.join(directory, "archive.json");
  const alternatePath = path.join(directory, "z-alternate.json");
  const provenancePath = path.join(directory, "provenance.json");
  fs.writeFileSync(reportPath, JSON.stringify({ fixtures: [
    { name: "video-b", results: [
      { tokenIndex: 0, context: "what the [__]", expected: ["fuck"] },
      { tokenIndex: 1, context: "no label [__]", expected: [] }
    ] },
    { name: "video-a", results: [
      { tokenIndex: 0, context: "shut the [__] up", expected: ["fuck"] }
    ] },
    { name: "synthetic", results: [
      { tokenIndex: 0, context: "what the [__]", expected: ["fuck"] }
    ] },
    { name: "multi-label", results: [
      { tokenIndex: 0, context: "what the [__]", expected: ["fuck", "shit"] }
    ] },
    { name: "unknown-creator", results: [
      { tokenIndex: 0, context: "what the [__]", expected: ["fuck"] }
    ] },
    { name: "no-marker", results: [
      { tokenIndex: 0, context: "what the heck", expected: ["fuck"] }
    ] },
    { name: "two-markers", results: [
      { tokenIndex: 0, context: "what [__] the [__]", expected: ["fuck"] }
    ] },
    { name: "leak", results: [
      { tokenIndex: 0, context: "what the [__]", expected: ["fuck"] }
    ] }
  ] }));
  fs.writeFileSync(alternatePath, JSON.stringify({ fixtures: [
    { name: "video-a", results: [
      { tokenIndex: 0, context: "shut the [__] up", expected: ["shit"] }
    ] }
  ] }));
  fs.writeFileSync(provenancePath, JSON.stringify({ provenance: [
    { pairClass: "manual-auto", creator: "Alice", creatorId: "UCAAAAAAAAAAAAAAAAAAAAAA", ids: ["video-a"] },
    { pairClass: "manual-auto", creator: " Alice ", ids: ["video-b"] },
    { pairClass: "synthetic", creator: "Not real", ids: ["synthetic"] },
    { pairClass: "manual-auto", creator: "Alice", ids: ["multi-label", "no-marker", "two-markers"] },
    { pairClass: "manual-auto", creator: "Bob", ids: ["leak"] },
    { pairClass: "manual-auto", creator: "unknown", ids: ["unknown-creator"] }
  ] }));

  const options = { mode: "archived", reportPaths: [alternatePath, reportPath], provenanceReports: [provenancePath], foldCount: 3 };
  const dataset = buildRealManualAutoDataset(options);
  assert.strictEqual(dataset.mode, "archived");
  assert.strictEqual(dataset.validation, "discovery-only");
  assert.strictEqual(dataset.discoveryOnly, true);
  assert.strictEqual(dataset.dataset, "real-manual-auto");
  assert.strictEqual(dataset.summary.rows, 3);
  assert.strictEqual(dataset.summary.creators, 2);
  assert.strictEqual(dataset.summary.fixtures, 3);
  assert.strictEqual(dataset.summary.manualAutoInputRows, 8);
  assert.strictEqual(dataset.summary.excludedRows, 5);
  assert.deepStrictEqual(dataset.summary.exclusions, {
    incompleteProvenance: 0,
    unlabeledExpected: 1,
    multiLabelExpected: 1,
    unknownCreator: 1,
    ambiguousCreator: 0,
    invalidExpected: 0,
    invalidContext: 2
  });
  assert.deepStrictEqual(dataset.rows.map((row) => row.videoId), ["video-a", "video-b", "leak"]);
  assert.deepStrictEqual(dataset.rows.map((row) => row.expected), ["fuck", "fuck", "fuck"]);
  assert.deepStrictEqual(dataset.rows.map((row) => row.currentPrediction), [
    currentPrediction("shut the [__] up"), currentPrediction("what the [__]"),
    currentPrediction("what the [__]")
  ]);
  assert.strictEqual(dataset.rows[0].creatorFold, dataset.rows[1].creatorFold);
  assert.deepStrictEqual(dataset.creators[0].rowIds, dataset.rows.slice(0, 2).map((row) => row.id));
  assert.strictEqual(dataset.creators[0].fixtureCount, 2);
  assert.match(dataset.rulesFingerprint, /^\d+:\d+:[a-z0-9]+$/u);
  assert.match(dataset.rulesAuxFingerprint, /^[a-z0-9]+$/u);
  assert.match(dataset.rulesEngineFingerprint, /^[a-z0-9]+$/u);
  assert.strictEqual(dataset.diagnostics.exclusions.multiLabelExpected.count, 1);
  assert.strictEqual(dataset.diagnostics.exclusions.unknownCreator.count, 1);
  assert.strictEqual(dataset.diagnostics.exclusions.invalidContext.count, 2);
  assert.strictEqual(dataset.diagnostics.duplicates.duplicateFixtureVersions, 1);
  assert.strictEqual(dataset.diagnostics.duplicates.duplicateSlots, 1);
  assert.strictEqual(dataset.diagnostics.duplicates.conflictingSlots, 1);
  assert.strictEqual(dataset.diagnostics.duplicates.selectedPairConflicts, 1);
  assert.strictEqual(dataset.diagnostics.contextLeakage.leakingContexts, 1);
  assert.strictEqual(dataset.diagnostics.contextLeakage.leakingRows, 2);

  const repeated = buildRealManualAutoDataset(options);
  assert.deepStrictEqual(repeated, dataset);
  const reordered = buildRealManualAutoDataset({ ...options, reportPaths: [reportPath, alternatePath] });
  assert.deepStrictEqual(reordered, dataset);

  const faithfulFixtures = path.join(directory, "faithful-fixtures");
  fs.mkdirSync(faithfulFixtures);
  const captionPayload = (caption) => ({ events: [{
    tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: caption }]
  }] });
  fs.writeFileSync(path.join(faithfulFixtures, "multiABC123_auto.en.json3"),
    JSON.stringify(captionPayload("bull [__] [__]")));
  fs.writeFileSync(path.join(faithfulFixtures, "multiABC123_manual.en.json3"),
    JSON.stringify(captionPayload("bull fucking shit")));
  const faithfulProvenancePath = path.join(directory, "faithful-provenance.json");
  fs.writeFileSync(faithfulProvenancePath, JSON.stringify({ provenance: [{
    pairClass: "manual-auto", creator: "Faithful Creator",
    creatorId: "UCAAAAAAAAAAAAAAAAAAAAAA", ids: ["multiABC123"]
  }] }));
  const transformedArchivePath = path.join(directory, "transformed-archive.json");
  fs.writeFileSync(transformedArchivePath, JSON.stringify({ fixtures: [{
    name: "multiABC123", results: [{ tokenIndex: 0, context: "wrong [__]", expected: ["shit"] }]
  }] }));
  const faithful = buildRealManualAutoDataset({
    mode: "faithful",
    fixturesDir: faithfulFixtures,
    reportPaths: [transformedArchivePath],
    provenanceReports: [faithfulProvenancePath],
    foldCount: 3
  });
  assert.strictEqual(faithful.mode, "faithful");
  assert.strictEqual(faithful.validation, "faithful-only");
  assert.strictEqual(faithful.discoveryOnly, false);
  assert.strictEqual(faithful.provenance.evidencePolicy, "exclude-explicitly-incomplete-v1");
  assert.strictEqual(faithful.summary.rows, 2);
  assert.deepStrictEqual(faithful.rows.map((row) => row.context), ["bull [__] [__]", "bull [__] [__]"]);
  assert.deepStrictEqual(faithful.rows.map((row) => row.originalContext), faithful.rows.map((row) => row.context));
  assert.ok(faithful.rows.every((row) => row.contextFaithful && row.contextSource === "fixture-original"));
  assert.deepStrictEqual(faithful.rows.map((row) => row.slotIndex), [0, 1]);
  assert.deepStrictEqual(faithful.rows.map((row) => row.expected), ["fucking", "shit"]);
  assert.deepStrictEqual(faithful.rows.map((row) => row.currentPrediction), [
    currentPrediction("bull [__] [__]", 0), currentPrediction("bull [__] [__]", 1)
  ]);
  assert.ok(faithful.rows.every((row) => row.source !== transformedArchivePath));
  assert.strictEqual(faithful.creators[0].creatorFold, faithful.rows[0].creatorFold);
  assert.strictEqual(faithful.diagnostics.archivedContextsExcluded, true);
  assert.ok(faithful.rows.every((row) => row.reportEvidence[faithfulProvenancePath] === "legacy"));
  const legacyProvenance = JSON.parse(fs.readFileSync(faithfulProvenancePath, "utf8"));
  fs.writeFileSync(faithfulProvenancePath, JSON.stringify({ ...legacyProvenance, queueComplete: false }));
  const incomplete = buildRealManualAutoDataset({ mode: "faithful", fixturesDir: faithfulFixtures,
    provenanceReports: [faithfulProvenancePath] });
  assert.strictEqual(incomplete.rows.length, 0);
  assert.strictEqual(incomplete.summary.exclusions.incompleteProvenance, 2);
  const completeProvenancePath = path.join(directory, "completed-provenance.json");
  fs.writeFileSync(completeProvenancePath, JSON.stringify({ ...legacyProvenance, queueComplete: true }));
  const completed = buildRealManualAutoDataset({ mode: "faithful", fixturesDir: faithfulFixtures,
    provenanceReports: [faithfulProvenancePath, completeProvenancePath] });
  assert.strictEqual(completed.rows.length, 2);
  assert.ok(completed.rows.every((row) => row.reportEvidence[completeProvenancePath] === "complete" &&
    row.reportEvidence[faithfulProvenancePath] === "incomplete"));
  assert.strictEqual(creatorKey({ creatorId: "UCAAAAAAAAAAAAAAAAAAAAAA", creator: "Different" }),
    "id:UCAAAAAAAAAAAAAAAAAAAAAA");
  assert.strictEqual(creatorKey({ creator: " Alice  " }), "name:alice");
  assert.strictEqual(creatorKey({ creator: "unknown" }), "");
  assert.deepStrictEqual(parseArgs(["--report", reportPath, "--provenance", provenancePath, "--folds", "3"]), {
    mode: "archived", fixturesDir: "test-fixtures", reportPaths: [reportPath], provenanceReports: [provenancePath],
    outputPath: ".tmp-real-manual-auto-dataset.json", foldCount: 3
  });
  assert.strictEqual(parseArgs(["--mode", "faithful"]).outputPath, ".tmp-real-manual-auto-faithful.json");
  assert.strictEqual(parseArgs(["--mode", "archived"]).outputPath, ".tmp-real-manual-auto-dataset.json");
  assert.strictEqual(parseArgs(["--mode", "faithful-only"]).mode, "faithful");
  assert.throws(() => parseArgs(["--folds", "0"]), /positive integer/);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("build-real-manual-auto-dataset.test.js passed");
