const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDiscovery, deriveContext, parseArgs, run, contextShape
} = require("../tools/build-caption-discovery");

const payload = (value, start = 0) => ({ events: [{ tStartMs: start, dDurationMs: 1000,
  segs: [{ utf8: value }] }] });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caption-discovery-"));
const fixtures = path.join(directory, "fixtures");
fs.mkdirSync(fixtures);
// Real convention: auto is the censored track and manual is the uncensored
// track, including synthetic pairs (the downloader masks `_auto` after
// copying the original automatic caption to `_manual`).
const writePair = (id, censored, uncensored) => {
  fs.writeFileSync(path.join(fixtures, `${id}_auto.en.json3`), JSON.stringify(payload(censored)));
  fs.writeFileSync(path.join(fixtures, `${id}_manual.en.json3`), JSON.stringify(payload(uncensored)));
};
try {
  const long = "before one two three four. target [__] after. following five six seven eight.";
  const marker = long.indexOf("[__]");
  const expanded = deriveContext(long, marker, { words: 4, maxWords: 120 });
  assert.strictEqual(expanded.fallback, false);
  assert.ok(expanded.context.startsWith("two three four."));
  assert.ok(expanded.context.endsWith("following five six"));
  assert.ok(expanded.context.includes("target [__] after."));
  assert.ok(expanded.offset > 0);
  assert.strictEqual(expanded.span, expanded.context.length);
  assert.ok(expanded.context.includes("target [__] after."));

  const noPunctuation = "zero one two three four five six [__] seven eight nine ten eleven";
  const fallback = deriveContext(noPunctuation, noPunctuation.indexOf("[__]"), { words: 4, maxWords: 120 });
  assert.strictEqual(fallback.fallback, true);
  assert.deepStrictEqual(fallback.context.split(/\s+/u).slice(0, 5), ["three", "four", "five", "six", "[__]"]);
  const multiText = "one two three four [__] five [__] six seven eight nine.";
  const multi = deriveContext(multiText, multiText.lastIndexOf("[__]"), { words: 4 });
  assert.strictEqual((multi.context.match(/\[__\]/gu) || []).length, 2);
  assert.strictEqual(contextShape("A [ __ ] B"), "a [__] b");
  const capText = "one two three four five six seven eight nine ten [__] twelve thirteen fourteen fifteen sixteen.";
  const capped = deriveContext(capText, capText.indexOf("[__]"), { words: 3, maxWords: 8 });
  assert.strictEqual(capped.truncated, true);
  assert.ok(capped.wordCount <= 8);
  assert.ok(capped.context.includes("[__]"));
  const abbreviation = deriveContext("Mr. Smith said one two three four [__] five six seven", "Mr. Smith said one two three four [__] five six seven".indexOf("[__]"), { words: 4 });
  assert.strictEqual(abbreviation.fallback, true);
  assert.throws(() => deriveContext("one [__] two", 4, { words: 4, maxWords: 1 }), /twice words/);
  for (const value of ["[__]", "one two [__]", "[__] one two", "[ __ ]"]) {
    assert.ok(deriveContext(value, value.indexOf("[")).context.includes(value.match(/\[\s*__\s*\]/u)[0]));
  }
  const interior = "Previous sentence. One two three four [__] five six seven eight. Next sentence.";
  assert.strictEqual(deriveContext(interior, interior.indexOf("[__]")).context,
    "One two three four [__] five six seven eight.");

  const manualId = "aaaaaBBBBBB";
  const syntheticId = "cccccDDDDDD";
  const unknownId = "eeeeeFFFFFF";
  const conflictId = "gggggHHHHHH";
  writePair(manualId, "one two three four [__] five six seven eight.", "one two three four fuck five six seven eight.");
  writePair(syntheticId, "one two three four [__] five six seven eight.", "one two three four shit five six seven eight.");
  writePair(unknownId, "one two three four [__] five six seven eight.", "one two three four fuck five six seven eight.");
  writePair(conflictId, "one two three four [__] five six seven eight.", "one two three four fuck five six seven eight.");
  const report = path.join(directory, "acquisition.json");
  fs.writeFileSync(report, JSON.stringify({ generatedAt: "first", channels: [{ name: "Creator", creatorId: "UC1111111111111111111111", items: [
    { id: manualId, status: "paired-saved", pairKind: "creator-manual" },
    { id: syntheticId, status: "paired-saved", pairKind: "synthetic-auto" },
    { id: unknownId, status: "paired-saved", pairKind: "unclassified" },
    { id: conflictId, status: "paired-saved", pairKind: "creator-manual" }
  ] }] }));
  const secondReport = path.join(directory, "conflict.json");
  fs.writeFileSync(secondReport, JSON.stringify({ channels: [{ creator: "Other", items: [
    { id: conflictId, status: "paired-saved", pairClass: "manual-auto", pairKind: "synthetic-auto" }
  ] }] }));

  const dataset = buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, secondReport], words: 4, maxWords: 120 });
  assert.strictEqual(dataset.dataset, "caption-discovery");
  assert.strictEqual(dataset.discoveryOnly, true);
  assert.strictEqual(dataset.rows.length, 4);
  assert.deepStrictEqual(dataset.rows.map((row) => row.pairClass).sort(), ["conflict", "manual-auto", "synthetic", "unknown"]);
  assert.strictEqual(dataset.rows.find((row) => row.pairClass === "manual-auto").expected, "fuck");
  assert.strictEqual(dataset.rows.find((row) => row.pairClass === "synthetic").expected, "shit");
  assert.strictEqual(dataset.rows.find((row) => row.pairClass === "unknown").expected, null);
  assert.strictEqual(dataset.sources.find((source) => source.pairClass === "conflict").provenanceStatus, "conflict");
  assert.strictEqual(dataset.byWord["manual-auto"].fuck.length, 1);
  assert.strictEqual(dataset.byWord.synthetic.shit.length, 1);
  assert.ok(Object.values(dataset.byShape).some((ids) => ids.length >= 2));
  assert.strictEqual(dataset.contexts.length, 1); // identical literal contexts are shared across four slots
  assert.ok(dataset.rows.every((row) => Number.isInteger(row.tokenIndex) && Number.isInteger(row.slotIndex) &&
    Number.isInteger(row.targetOffset) && !("videoHash" in row) && !("creatorHash" in row) && !("timestampHash" in row)));
  assert.ok(dataset.rows.every((row) => row.targetOffset >= 0 &&
    row.targetOffset < dataset.contexts.find((context) => context.id === row.contextId).text.length));
  assert.match(dataset.buildFingerprint, /^sha256:[0-9a-f]{64}$/u);
  const reused = buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, secondReport], previousDataset: dataset });
  assert.strictEqual(reused.diagnostics.reusedSources, 4);
  assert.strictEqual(reused.diagnostics.rebuiltSources, 0);
  assert.deepStrictEqual(reused.rows, dataset.rows);
  const changedAuto = path.join(fixtures, `${manualId}_auto.en.json3`);
  const originalAuto = fs.readFileSync(changedAuto);
  fs.writeFileSync(changedAuto, JSON.stringify(payload("one two three four [__] five six seven changed.")));
  try {
    const changed = buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, secondReport], previousDataset: dataset });
    assert.strictEqual(changed.diagnostics.reusedSources, 3);
    assert.strictEqual(changed.diagnostics.rebuiltSources, 1);
  } finally { fs.writeFileSync(changedAuto, originalAuto); }
  const changedOptions = buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, secondReport], words: 5,
    previousDataset: dataset });
  assert.strictEqual(changedOptions.buildFingerprint === dataset.buildFingerprint, false);
  assert.strictEqual(changedOptions.diagnostics.reusedSources, 0);
  assert.strictEqual(changedOptions.diagnostics.rebuiltSources, 4);
  const changedImplementation = buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, secondReport],
    previousDataset: { ...dataset, buildFingerprint: "sha256:stale" } });
  assert.strictEqual(changedImplementation.diagnostics.reusedSources, 0);
  assert.strictEqual(changedImplementation.diagnostics.rebuiltSources, 4);
  const originalReport = fs.readFileSync(report);
  const creatorVariant = JSON.parse(originalReport);
  creatorVariant.channels[0].creator = "Changed creator";
  fs.writeFileSync(report, JSON.stringify(creatorVariant));
  try {
    const changedCreator = buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, secondReport], previousDataset: dataset });
    assert.strictEqual(changedCreator.diagnostics.reusedSources, 0);
    assert.strictEqual(changedCreator.diagnostics.rebuiltSources, 4);
  } finally { fs.writeFileSync(report, originalReport); }
  const provenanceVariant = JSON.parse(originalReport);
  provenanceVariant.queueComplete = false;
  fs.writeFileSync(report, JSON.stringify(provenanceVariant));
  try {
    const changedProvenance = buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, secondReport], previousDataset: dataset });
    assert.strictEqual(changedProvenance.diagnostics.reusedSources, 0);
    assert.strictEqual(changedProvenance.diagnostics.rebuiltSources, 4);
  } finally { fs.writeFileSync(report, originalReport); }

  // Provenance backfill uses the conventional fixture names and must merge
  // with an acquisition record rather than inventing a second source. Its
  // legacy evidence status also stays legacy.
  const provenanceId = "provKnown01";
  const missingProvenanceId = "provMissing1";
  const explicitConflictId = "provClass01";
  const pathConflictId = "provPath01";
  writePair(provenanceId, "watch this [__]", "watch this fuck");
  writePair(explicitConflictId, "watch this [__]", "watch this shit");
  writePair(pathConflictId, "watch this [__]", "watch this fuck");
  const provenanceAcquisition = path.join(directory, "provenance-acquisition.json");
  const provenanceReport = path.join(directory, "provenance.json");
  const pathReport = path.join(directory, "path-conflict.json");
  fs.writeFileSync(provenanceAcquisition, JSON.stringify({ channels: [{ items: [
    { id: provenanceId, status: "paired-saved", pairKind: "unclassified" },
    { id: explicitConflictId, status: "paired-saved", pairClass: "conflict" },
    { id: pathConflictId, status: "paired-saved", pairClass: "manual-auto",
      autoPath: `${pathConflictId}_auto.en.json3`, manualPath: `${pathConflictId}_manual.en.json3` }
  ] }] }));
  fs.writeFileSync(provenanceReport, JSON.stringify({ provenance: [
    { pairClass: "manual-auto", creator: "Backfill", ids: [provenanceId, missingProvenanceId] }
  ] }));
  fs.writeFileSync(pathReport, JSON.stringify({ channels: [{ items: [
    { id: pathConflictId, status: "paired-saved", pairClass: "manual-auto",
      autoPath: "alternate_auto.json3", manualPath: `${pathConflictId}_manual.en.json3` }
  ] }] }));
  const backfilled = buildDiscovery({ fixturesDir: fixtures,
    reportPaths: [provenanceAcquisition, provenanceReport, pathReport] });
  const backfilledSource = backfilled.sources.find((source) => source.videoId === provenanceId);
  assert.strictEqual(backfilledSource.pairClass, "manual-auto");
  assert.strictEqual(backfilledSource.provenanceStatus, "legacy");
  assert.strictEqual(backfilled.sources.filter((source) => source.videoId === provenanceId).length, 1);
  assert.strictEqual(backfilled.rows.filter((row) => row.videoId === provenanceId).length, 1);
  assert.strictEqual(backfilled.rows.find((row) => row.videoId === provenanceId).expected, "fuck");
  assert.ok(backfilled.diagnostics.missingFixtures.includes(missingProvenanceId));
  const quarantinedConflict = backfilled.rows.find((row) => row.videoId === explicitConflictId);
  assert.strictEqual(quarantinedConflict.expected, null);
  assert.strictEqual(quarantinedConflict.labelStatus, "unknown");
  assert.strictEqual(backfilled.sources.find((source) => source.videoId === explicitConflictId).pairClass, "conflict");
  assert.ok(!Object.values(backfilled.byWord).some((words) => Object.values(words).flat()
    .some((id) => id === quarantinedConflict.id)));
  assert.ok(backfilled.diagnostics.conflictingSourcePaths.includes(pathConflictId));
  assert.strictEqual(backfilled.rows.some((row) => row.videoId === pathConflictId), false);
  const reorderedBackfill = buildDiscovery({ fixturesDir: fixtures,
    reportPaths: [provenanceReport, pathReport, provenanceAcquisition] });
  assert.deepStrictEqual(
    reorderedBackfill.sources.map((source) => [source.videoId, source.pairClass, source.provenanceStatus]),
    backfilled.sources.map((source) => [source.videoId, source.pairClass, source.provenanceStatus])
  );

  const clockVariant = JSON.parse(fs.readFileSync(report, "utf8"));
  clockVariant.generatedAt = "later";
  fs.writeFileSync(report, JSON.stringify(clockVariant));
  assert.strictEqual(buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, secondReport] }).sourceFingerprint,
    dataset.sourceFingerprint);

  const liveReport = path.join(directory, "live.json");
  fs.copyFileSync(report, liveReport);
  fs.writeFileSync(`${liveReport}.lock`, "active");
  try {
    const live = buildDiscovery({ fixturesDir: fixtures, reportPaths: [liveReport] });
    assert.strictEqual(live.rows.length, 4);
    assert.deepStrictEqual(live.diagnostics.liveReports, [liveReport]);
    assert.strictEqual(live.sources[0].provenanceStatus, "incomplete");
  } finally {
    fs.rmSync(`${liveReport}.lock`, { force: true });
  }

  const duplicate = buildDiscovery({ fixturesDir: fixtures, reportPaths: [report, report] });
  assert.strictEqual(duplicate.rows.length, 4);
  assert.ok(duplicate.diagnostics.duplicateSources > 0);
  const invalid = buildDiscovery({ fixturesDir: fixtures, reportPaths: [path.join(directory, "missing.json")] });
  assert.strictEqual(invalid.rows.length, 0);
  assert.strictEqual(invalid.diagnostics.invalidReports.length, 1);

  assert.deepStrictEqual(parseArgs(["--report", report, "--report", secondReport, "--fixtures", fixtures, "--words", "4", "--max-words", "8"]), {
    reportPaths: [report, secondReport], fixturesDir: fixtures, outputPath: "", words: 4, maxWords: 8
  });
  const output = path.join(directory, "discovery.json");
  assert.strictEqual(run({ fixturesDir: fixtures, reportPaths: [report], outputPath: output }).status, "written");
  assert.strictEqual(run({ fixturesDir: fixtures, reportPaths: [report], outputPath: output }).status, "unchanged");
  assert.throws(() => run({ fixturesDir: fixtures, reportPaths: [report], outputPath: path.join(fixtures, "bad.json") }), /input or raw fixture/);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("caption-discovery.test.js passed");
