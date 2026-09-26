const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const learner = require("../tools/mine-context-leaves");

assert.deepStrictEqual(learner.featureVector("before red [__] now after", 2, 2), [
  { offset: -2, token: "before", key: "-2:before" },
  { offset: -1, token: "red", key: "-1:red" },
  { offset: 1, token: "now", key: "1:now" },
  { offset: 2, token: "after", key: "2:after" }
]);
assert.deepStrictEqual(learner.featureVector("red [ __ ] now", 1, 1), [
  { offset: -1, token: "red", key: "-1:red" },
  { offset: 1, token: "now", key: "1:now" }
]);
assert.strictEqual(learner.featureVector("no marker", 1, 1), null);
assert.deepStrictEqual(learner.parseArgs([
  "--window", "3,1", "--max-depth", "1", "--min-support", "2", "report.json", "out.json"
]), {
  report: "report.json", provenance: "tools/caption-pair-provenance.json", output: "out.json",
  before: 3, after: 1, maxDepth: 1, minSupport: 2, minMarginalSupport: 3,
  minPrecision: 0.92, minMarginalPrecision: 0.92, minCreators: 2,
  minValidationSupport: 3, minValidationFolds: 2, minValidationPrecision: 0.92,
  minValidationMarginalPrecision: 0.92, limit: 100
});
assert.strictEqual(learner.parseArgs(["--dataset", "rows.json"]).dataset, "rows.json");
assert.strictEqual(learner.parseArgs(["--word", "FUCK"]).word, "fuck");
assert.throws(() => learner.parseArgs(["--window", "100,1"]), /limited/);
assert.throws(() => learner.featureVector("red [__] now", 100, 1), /limited/);
assert.deepStrictEqual(learner.featureVector("red … [__] now", 1, 1), [
  { offset: -1, token: "red", key: "-1:red" },
  { offset: 1, token: "now", key: "1:now" }
]);
assert.strictEqual(learner.runtimePatternMatches("red [fuck]", "red, [__]"), true);
assert.strictEqual(learner.runtimePatternMatches("red [fuck]", "red … [__]"), false);
assert.strictEqual(learner.runtimePatternMatches("what * [fuck]", "what the [__]"), true);
assert.strictEqual(learner.runtimePatternMatches("what * [fuck]", "what … [__]"), false);

const rows = learner.prepareRows([
  { id: "a1", fixture: "a", tokenIndex: 0, creator: "A", context: "red [__] now", expected: "fuck", current: "shit" },
  { id: "a2", fixture: "a", tokenIndex: 1, creator: "A", context: "red [__] now", expected: "fuck", current: "" },
  { id: "b1", fixture: "b", tokenIndex: 0, creator: "B", context: "red [__] now", expected: "fuck", current: "shit" },
  { id: "c1", fixture: "c", tokenIndex: 0, creator: "C", context: "red [__] now", expected: "shit", current: "fuck" }
], 1, 1);
const options = {
  maxDepth: 1, minSupport: 2, minMarginalSupport: 1, minPrecision: 0.75,
  minMarginalPrecision: 0.75, minCreators: 2
};
const leaves = learner.learnLeaves(rows, options);
const redLeaf = leaves.find((leaf) => leaf.key === "-1:red" && leaf.target === "fuck");
assert.ok(redLeaf);
assert.strictEqual(redLeaf.support, 4);
assert.strictEqual(redLeaf.creatorCount, 3);
assert.strictEqual(redLeaf.marginalSupport, 3);
assert.strictEqual(redLeaf.marginalCorrect, 3);
assert.strictEqual(redLeaf.marginalPrecision, 1);
assert.ok(!learner.learnLeaves(rows, { ...options, minMarginalPrecision: 1.01 })
  .some((leaf) => leaf.key === "-1:red" && leaf.target === "fuck"));

const validation = learner.validateFold(rows, ["A", "B", "C"], options);
assert.strictEqual(validation.folds.length, 3);
assert.strictEqual(validation.totals.rows, rows.length);
assert.ok(validation.folds.every((fold) => fold.creator && fold.rows > 0));
assert.ok(validation.folds.every((fold) => fold.learnedLeaves >= 0));
const foldRows = learner.prepareRows([
  { fixture: "fold-a", creator: "A", context: "red [__] now", expected: "fuck", current: "shit" },
  { fixture: "fold-b", creator: "B", context: "red [__] now", expected: "fuck", current: "shit" },
  { fixture: "fold-c", creator: "C", context: "red [__] now", expected: "fuck", current: "shit" }
], 1, 1);
const foldValidation = learner.validateFold(foldRows, ["A", "B", "C"], options);
const redValidation = foldValidation.candidates.get("-1:red=>fuck");
assert.strictEqual(redValidation.folds.size, 3);
assert.strictEqual(redValidation.evaluatedFolds.size, 3);
assert.strictEqual(redValidation.byCreator.size, 3);
const applied = learner.applyLeaves(rows, leaves, options);
assert.strictEqual(applied.rows, 4);
assert.strictEqual(applied.changed, 3);
assert.strictEqual(applied.modelCorrect, 3);
assert.strictEqual(learner.renderPattern([{ offset: -2, token: "what" }, { offset: 1, token: "is" }], "fuck"),
  "what * [fuck] is");
const syntheticRows = learner.prepareRows([
  { fixture: "synthetic-1", creator: "S", context: "red [__] now", expected: "shit", current: "" },
  { fixture: "synthetic-2", creator: "S", context: "red [__] now", expected: "shit", current: "" },
  { fixture: "synthetic-3", creator: "S", context: "red [__] now", expected: "fuck", current: "" }
], 1, 1);
const transferCandidate = {
  key: "-1:red", target: "fuck", conditions: [{ offset: -1, token: "red" }]
};
const transfer = learner.auditSyntheticTransfer(transferCandidate, syntheticRows, { maxDepth: 1 });
assert.strictEqual(transfer.runtimeCompatible, true);
assert.strictEqual(transfer.support, 3);
assert.strictEqual(transfer.targetCount, 1);
assert.strictEqual(transfer.strongReversal, true);
assert.match(learner.transferWarnings(transfer, transferCandidate)[0], /strong synthetic reversal/);
const zeroTransfer = learner.auditSyntheticTransfer(transferCandidate,
  learner.prepareRows([{ fixture: "other", creator: "S", context: "blue [__] now", expected: "fuck", current: "" }], 1, 1),
  { maxDepth: 1 });
assert.match(learner.transferWarnings(zeroTransfer, transferCandidate)[0], /zero support/);
assert.strictEqual(learner.runtimePattern([{ offset: -1, token: "red" }], "fuck"),
  "red [fuck]");
assert.strictEqual(learner.runtimePattern([{ offset: -2, token: "what" }, { offset: 1, token: "is" }], "fuck"),
  "what * [fuck] is");
assert.strictEqual(learner.runtimePattern([{ offset: -1, token: "red" }, { offset: 1, token: "<EOS>" }], "fuck"), null);
assert.strictEqual(learner.renderPattern([{ offset: 1, token: "<EOS>" }], "fuck"), null);
const archiveDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-leaves-archive-"));
try {
  const archiveReport = path.join(archiveDirectory, "report.json");
  const archiveProvenance = path.join(archiveDirectory, "provenance.json");
  fs.writeFileSync(archiveReport, JSON.stringify({ fixtures: [
    { name: "synthetic-video", results: [{ tokenIndex: 0, context: "red [__] now", expected: ["fuck"] }] },
    { name: "manual-video", results: [{ tokenIndex: 0, context: "red [__] now", expected: ["fuck"] }] }
  ] }));
  fs.writeFileSync(archiveProvenance, JSON.stringify({ provenance: [
    { pairClass: "synthetic", creator: "Synthetic", ids: ["synthetic-video"] },
    { pairClass: "manual-auto", creator: "Manual", ids: ["manual-video"] }
  ] }));
  const syntheticArchive = learner.loadSyntheticArchive(archiveReport, archiveProvenance, 1, 1);
  assert.strictEqual(syntheticArchive.rows.length, 1);
  assert.strictEqual(syntheticArchive.fixtures.size, 1);
  assert.strictEqual(syntheticArchive.rows[0].expected, "fuck");
} finally {
  fs.rmSync(archiveDirectory, { recursive: true, force: true });
}
const invalidDatasetPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-leaves-")), "rows.json");
try {
  fs.writeFileSync(invalidDatasetPath, JSON.stringify({ dataset: "real-manual-auto", pairClass: "manual-auto",
    foldCount: 2, rows: [{ id: "row", creator: "A", context: "red [__] now", expected: "fuck" }] }));
  assert.throws(() => learner.loadDataset(invalidDatasetPath), /invalid creatorFold/);
  fs.writeFileSync(invalidDatasetPath, JSON.stringify({ dataset: "real-manual-auto", pairClass: "manual-auto",
    foldCount: 2, rows: [
      { id: "row-a", creator: "A", creatorKey: "a", creatorFold: 0,
        context: "red [__] now", expected: "fuck" },
      { id: "row-b", creator: "A", creatorKey: "a", creatorFold: 1,
        context: "red [__] now", expected: "fuck" }
    ] }));
  assert.throws(() => learner.loadDataset(invalidDatasetPath), /multiple folds/);
} finally {
  fs.rmSync(path.dirname(invalidDatasetPath), { recursive: true, force: true });
}
const gateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-leaves-gate-"));
try {
  const reportPath = path.join(gateDirectory, "report.json"), provenancePath = path.join(gateDirectory, "provenance.json");
  fs.writeFileSync(reportPath, JSON.stringify({ mode: "rules-only", fixtures: [
    { name: "creator-a", results: [{ tokenIndex: 0, context: "red [__] now", expected: ["fuck"], word: "shit" }] },
    { name: "creator-b", results: [{ tokenIndex: 0, context: "red [__] now", expected: ["fuck"], word: "shit" }] }
  ] }));
  fs.writeFileSync(provenancePath, JSON.stringify({ provenance: [
    { pairClass: "manual-auto", creator: "A", ids: ["creator-a"] },
    { pairClass: "manual-auto", creator: "B", ids: ["creator-b"] }
  ] }));
  const datasetRows = [
    { id: "a", videoId: "creator-a", tokenIndex: 0, creator: "A", creatorKey: "a", creatorFold: 0,
      context: "red [__] now", expected: "fuck", currentPrediction: "shit" },
    { id: "b", videoId: "creator-b", tokenIndex: 0, creator: "B", creatorKey: "b", creatorFold: 1,
      context: "red [__] now", expected: "fuck", currentPrediction: "shit" }
  ];
  const datasetPath = path.join(gateDirectory, "dataset.json");
  const writeDataset = (metadata) => fs.writeFileSync(datasetPath, JSON.stringify({ dataset: "real-manual-auto",
    pairClass: "manual-auto", foldCount: 2, ...metadata, rows: datasetRows }));
  const args = ["--report", reportPath, "--provenance", provenancePath, "--before", "1", "--after", "1", "--max-depth", "1",
    "--min-support", "1", "--min-marginal-support", "1", "--min-precision", "1", "--min-marginal-precision", "1",
    "--min-creators", "1", "--min-validation-support", "1", "--min-validation-folds", "2", "--min-validation-precision", "1",
    "--min-validation-marginal-precision", "1"];
  writeDataset({ mode: "archived", validation: "discovery-only", discoveryOnly: true });
  assert.strictEqual(learner.isFaithfulValidationDataset(JSON.parse(fs.readFileSync(datasetPath))), false);
  const archived = learner.run(learner.parseArgs(["--dataset", datasetPath, "--output", path.join(gateDirectory, "archived-output.json"), ...args]));
  assert.strictEqual(archived.data.candidateLeaves > 0, true);
  assert.strictEqual(archived.data.proposals, 0);
  assert.strictEqual(archived.creatorFoldValidation.eligible, false);
  assert.strictEqual(archived.creatorFoldValidation.status, "discovery-only");
  assert.strictEqual(archived.source.mode, "archived");

  const direct = learner.run(learner.parseArgs(["--output", path.join(gateDirectory, "direct-output.json"), ...args]));
  assert.strictEqual(direct.data.candidateLeaves > 0, true);
  assert.strictEqual(direct.data.proposals, 0);
  assert.strictEqual(direct.creatorFoldValidation.eligible, false);
  assert.match(direct.creatorFoldValidation.reason, /--dataset/);
  assert.strictEqual(direct.source.dataset, null);

  writeDataset({ mode: "faithful", validation: "faithful-only", discoveryOnly: false });
  const legacyFaithful = learner.run(learner.parseArgs(["--dataset", datasetPath,
    "--output", path.join(gateDirectory, "legacy-faithful-output.json"), ...args]));
  assert.strictEqual(legacyFaithful.creatorFoldValidation.eligible, false);
  assert.match(legacyFaithful.creatorFoldValidation.reason, /rebuild the faithful dataset/);
  assert.strictEqual(legacyFaithful.proposals.length, 0);

  writeDataset({ mode: "faithful", validation: "faithful-only", discoveryOnly: false,
    provenance: { evidencePolicy: "exclude-explicitly-incomplete-v1" } });
  const faithful = learner.run(learner.parseArgs(["--dataset", datasetPath, "--output", path.join(gateDirectory, "faithful-output.json"), ...args]));
  assert.strictEqual(faithful.creatorFoldValidation.eligible, true);
  assert.strictEqual(faithful.source.mode, "faithful");
  assert.ok(faithful.proposals.length > 0);
  const ineligibleDataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  ineligibleDataset.rows[0].evidenceEligible = false;
  fs.writeFileSync(datasetPath, JSON.stringify(ineligibleDataset));
  const filtered = learner.loadDataset(datasetPath);
  assert.strictEqual(filtered.rows.length, 1);
  assert.strictEqual(filtered.skipped.evidenceIneligible, 1);
} finally {
  fs.rmSync(gateDirectory, { recursive: true, force: true });
}

const discoveryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-leaves-discovery-"));
try {
  const contextText = "alpha, [__] beta. [__] gamma", first = contextText.indexOf("[__]"), second = contextText.indexOf("[__]", first + 1);
  assert.deepStrictEqual(learner.discoveryFeatureVector(contextText, 0, 1, 1).map(({ offset, token, key, slotIndex, sentenceBoundary }) =>
    ({ offset, token, key, slotIndex, sentenceBoundary })), [
    { offset: -1, token: "alpha,", key: "-1:alpha,", slotIndex: 0, sentenceBoundary: false },
    { offset: 1, token: "beta.", key: "1:beta.", slotIndex: 0, sentenceBoundary: false }
  ]);
  assert.strictEqual(learner.discoveryFeatureVector(contextText, 1, 1, 1)[0].slotIndex, 1);
  assert.deepStrictEqual(learner.discoveryFeatureVector(">>Attached, [ __ ] ♪♫ after [CrOwD cheering]", 0, 1, 1)
    .map(({ offset, token }) => ({ offset, token })), [
    { offset: -1, token: "attached," },
    { offset: 1, token: "after" }
  ]);
  assert.deepStrictEqual(learner.discoveryFeatureVector("<b>MixedCase</b> keeps, [Music] [__] next", 0, 1, 1)
    .map(({ offset, token }) => ({ offset, token })), [
    { offset: -1, token: "keeps," },
    { offset: 1, token: "next" }
  ]);
  const multiMarkerContext = "first [Music] [__] second [Crowd Cheering] [ __ ] third";
  assert.deepStrictEqual(learner.discoveryFeatureVector(multiMarkerContext, 1, 1, 1)
    .map(({ offset, token, slotIndex }) => ({ offset, token, slotIndex })), [
    { offset: -1, token: "second", slotIndex: 1 },
    { offset: 1, token: "third", slotIndex: 1 }
  ]);
  const discoveryPath = path.join(discoveryDirectory, "caption-discovery.json"), outputPath = path.join(discoveryDirectory, "output.json");
  const row = (id, videoId, creator, pairClass, expected, offset, slotIndex, expectedCandidates = expected ? [expected] : [], labelStatus = expected ? "known" : "unknown") =>
    ({ id, videoId, creator, creatorId: `id-${creator}`, sourceId: `source-${videoId}`, pairClass, contextId: "shared", targetOffset: offset,
      slotIndex, tokenIndex: slotIndex, expected, expectedCandidates, labelStatus });
  const discoveryDataset = { dataset: "caption-discovery", version: 2, discoveryOnly: true,
    // These hostile-looking fields must not open the faithful validation path.
    mode: "faithful", validation: "faithful-only", contexts: [{ id: "shared", text: contextText }], rows: [
      row("a", "clip-a", "A", "manual-auto", "fuck", first, 0), row("a-duplicate", "clip-a", "A", "manual-auto", "fuck", first, 0),
      row("b", "clip-b", "B", "manual-auto", "shit", first, 0), row("c", "clip-c", "C", "manual-auto", null, first, 0),
      row("ambiguous", "clip-d", "D", "manual-auto", null, first, 0, ["fuck", "shit"], "ambiguous"),
      row("second-slot", "clip-e", "E", "manual-auto", "fuck", second, 1), row("synthetic", "clip-s", "S", "synthetic", "fuck", first, 0)
    ] };
  fs.writeFileSync(discoveryPath, JSON.stringify(discoveryDataset));
  const discovered = learner.run(learner.parseArgs(["--dataset", discoveryPath, "--output", outputPath, "--before", "1", "--after", "1",
    "--max-depth", "1", "--min-support", "1", "--min-creators", "1", "--min-precision", "0.92", "--min-marginal-support", "1", "--min-marginal-precision", "0.92", "--word", "fuck"]));
  assert.strictEqual(discovered.source.discoveryOnly, true);
  assert.strictEqual(discovered.source.mode, "discovery-only");
  assert.strictEqual(discovered.validated, false);
  assert.strictEqual(discovered.proposals.length, 0);
  assert.strictEqual(discovered.creatorFoldValidation.eligible, false);
  assert.strictEqual(discovered.options.limit, 0); // discovery defaults to unlimited, unlike the CLI parser's faithful default.
  const manualLeads = discovered.discovery.tiers["manual-auto"].leads;
  const manualLeadId = "manual-auto:-1:alpha,=>fuck";
  assert.ok(!manualLeads.some((lead) => lead.id === manualLeadId));
  const manualLead = manualLeads.summary.rejected[manualLeadId];
  assert.ok(manualLead); // contradictory and unknown evidence is retained, but cannot qualify.
  assert.strictEqual(manualLead.support, 4); // duplicate clip-a is counted once, not twice.
  assert.strictEqual(manualLead.targetCount, 1);
  assert.strictEqual(manualLead.precision, 0.25); // --word did not remove competing/unknown matches.
  assert.ok(manualLead.reasons.includes("precision"));
  assert.deepStrictEqual(manualLead.counterexampleIds.sort(), ["ambiguous", "b", "c"]);
  assert.strictEqual(discovered.discovery.tiers["manual-auto"].leads.some((lead) => lead.id === manualLeadId), false);
  assert.ok(!("leadsByTier" in discovered.discovery));
  assert.ok(!("wordSummary" in discovered.discovery));
  assert.ok(discovered.discovery.tiers["manual-auto"].leads.some((lead) => lead.conditions.some((condition) => condition.slotIndex === 1)));
  assert.strictEqual(discovered.discovery.tiers.synthetic.leads.length, 0);
  const syntheticRejected = discovered.discovery.tiers.synthetic.leads.summary.rejected["synthetic:-1:alpha,=>fuck"];
  assert.ok(syntheticRejected);
  assert.ok(syntheticRejected.reasons.includes("crossTierPrecision"));
  assert.strictEqual(syntheticRejected.crossTier.status, "observed");
  assert.deepStrictEqual(syntheticRejected.crossTier.counterexampleIds, ["b"]);
  assert.deepStrictEqual(syntheticRejected.crossTier.unknownIds.sort(), ["ambiguous", "c"]);
  const defaultDiscovery = learner.run(learner.parseArgs(["--dataset", discoveryPath, "--output", path.join(discoveryDirectory, "default-output.json"),
    "--max-depth", "1", "--min-support", "1", "--min-creators", "1", "--min-precision", "0.92", "--min-marginal-support", "1", "--min-marginal-precision", "0.92"]));
  assert.strictEqual(defaultDiscovery.options.before, 4);
  assert.strictEqual(defaultDiscovery.options.after, 4);
  assert.strictEqual(defaultDiscovery.options.phraseWords, 8);
  assert.strictEqual(defaultDiscovery.options.limit, 0);
  const loadedDiscovery = learner.loadDiscoveryDataset(discoveryPath, 1, 1);
  const repeatedBase = loadedDiscovery.rows.find((candidate) => candidate.id === "a");
  const repeatedRows = [
    ...loadedDiscovery.rows,
    { ...repeatedBase, id: "a-second-label", tokenIndex: 1, expected: "shit", expectedCandidates: ["shit"], labelStatus: "known" },
    { ...repeatedBase, id: "a-second-unknown", tokenIndex: 2, expected: null, expectedCandidates: [], labelStatus: "unknown" }
  ];
  const repeatedLeads = learner.discoverDiscoveryLeads(repeatedRows, "manual-auto", { maxDepth: 1, minSupport: 1, minCreators: 1, minPrecision: 0, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 100 });
  const repeatedLead = repeatedLeads.find((lead) => lead.key === "-1:alpha," && lead.target === "fuck");
  assert.strictEqual(repeatedLead, undefined);
  const repeatedRejected = repeatedLeads.summary.rejected[manualLeadId];
  assert.ok(repeatedRejected);
  assert.strictEqual(repeatedRejected.support, manualLead.support);
  assert.ok(repeatedRejected.counterexampleIds.includes("a-second-label"));
  assert.ok(repeatedRejected.counterexampleIds.includes("a-second-unknown"));

  const conflictRows = [
    { ...repeatedBase, id: "a-conflict-target", tokenIndex: 10, expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "shit" },
    { ...repeatedBase, id: "a-conflict-opposite", tokenIndex: 11, expected: "shit", expectedCandidates: ["shit"], labelStatus: "known", current: "" }
  ];
  const conflictLeads = learner.discoverDiscoveryLeads(conflictRows, "manual-auto", { maxDepth: 1, minSupport: 1, minCreators: 1, minPrecision: 0, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 100 });
  const conflictLead = conflictLeads.find((lead) => lead.key === "-1:alpha," && lead.target === "fuck");
  assert.strictEqual(conflictLead, undefined);
  const conflictRejected = conflictLeads.summary.rejected[manualLeadId];
  assert.ok(conflictRejected);
  assert.strictEqual(conflictRejected.support, 1);
  assert.strictEqual(conflictRejected.targetCount, 0);
  assert.notStrictEqual(conflictRejected.precision, 1);
  assert.ok(conflictRejected.reasons.includes("creators"));
  assert.deepStrictEqual(conflictRejected.counterexampleIds.sort(), ["a-conflict-opposite"]);

  const sameSentence = "red [__] now red [__] now";
  const separateSlotRows = [0, 1].map((slotIndex) => ({ ...repeatedBase, id: `same-slot-${slotIndex}`,
    context: sameSentence, contextId: "same-sentence", slotIndex, tokenIndex: slotIndex,
    targetOffset: sameSentence.indexOf("[__]", slotIndex ? sameSentence.indexOf("[__]") + 1 : 0),
    features: learner.discoveryFeatureVector(sameSentence, slotIndex, 1, 1), expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "" }));
  const separateSlotLead = learner.discoverDiscoveryLeads(separateSlotRows, "manual-auto", { maxDepth: 1, minSupport: 1, minCreators: 1, minPrecision: 0, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 100 })
    .find((lead) => lead.key === "-1:red" && lead.target === "fuck");
  assert.ok(separateSlotLead);
  assert.strictEqual(separateSlotLead.support, 2);
  assert.strictEqual(separateSlotLead.uniqueContextSupport, 2);
  assert.strictEqual(separateSlotLead.targetCount, 2);

  const unknownCreatorRows = [
    { ...repeatedBase, id: "known-creator", creator: "Known", creatorId: "known-id", creatorKey: "known-id", expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "" },
    { ...repeatedBase, id: "unknown-creator", creator: "unknown", creatorId: "unknown", creatorKey: "unknown", expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "" }
  ];
  const unknownCreatorLeads = learner.discoverDiscoveryLeads(unknownCreatorRows, "manual-auto", { maxDepth: 1, minSupport: 1, minCreators: 2, minPrecision: 0, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 0 });
  assert.ok(unknownCreatorLeads.summary.rejected["manual-auto:-1:alpha,=>fuck"].reasons.includes("creators"));

  const phraseText = "a b c d [__] e f g h";
  const phraseRows = [{ ...repeatedBase, id: "phrase-width-8", context: phraseText, features: learner.discoveryFeatureVector(phraseText, 0, 4, 4),
    targetOffset: phraseText.indexOf("[__]"), expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "" }];
  const phraseLeads = learner.discoverDiscoveryLeads(phraseRows, "manual-auto", { maxDepth: 1, phraseWords: 8, minSupport: 1, minCreators: 1,
    minPrecision: 0, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 0 });
  assert.ok(phraseLeads.some((lead) => lead.depth === 8));
  assert.ok(!phraseLeads.some((lead) => lead.depth > 8));

  const exclusionRows = ["exclude-a", "exclude-b"].map((id, index) => ({ ...repeatedBase, id, creator: `Exclude ${index}`,
    creatorId: `exclude-${index}`, creatorKey: `exclude-${index}`, expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "" }));
  const exclusionLeads = learner.discoverDiscoveryLeads(exclusionRows, "manual-auto", { maxDepth: 2, minSupport: 1, minCreators: 2,
    minPrecision: 1, minMarginalSupport: 1, minMarginalPrecision: 1, limit: 0, exclude: ["manual-auto:-1:alpha,=>fuck"] });
  assert.ok(!exclusionLeads.some((lead) => lead.id === "manual-auto:-1:alpha,=>fuck"));
  assert.ok(exclusionLeads.some((lead) => lead.key === "-1:alpha,|1:beta." && lead.target === "fuck"));

  const manyRows = Array.from({ length: 9 }, (_, index) => ({ ...repeatedBase, id: `positive-${index}`, creator: `Positive ${index}`,
    creatorId: `positive-${index}`, creatorKey: `positive-${index}`, expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "" }));
  manyRows.push(...["contrary-a", "contrary-b"].map((id, index) => ({ ...repeatedBase, id, creator: `Contrary ${index}`,
    creatorId: `contrary-${index}`, creatorKey: `contrary-${index}`, expected: "shit", expectedCandidates: ["shit"], labelStatus: "known", current: "" })));
  const manyLeads = learner.discoverDiscoveryLeads(manyRows, "manual-auto", { maxDepth: 1, minSupport: 1, minCreators: 1, minPrecision: 0.92,
    minMarginalSupport: 1, minMarginalPrecision: 0, limit: 0 });
  const manyRejected = manyLeads.summary.rejected["manual-auto:-1:alpha,=>fuck"];
  assert.ok(manyRejected);
  assert.deepStrictEqual(manyRejected.counterexampleIds.sort(), ["contrary-a", "contrary-b"]);
  assert.strictEqual(manyRejected.counterexampleCount, 2);
  assert.strictEqual(manyLeads.summary.rejectedSampled, true);
  assert.strictEqual(manyLeads.summary.rejectedCount, manyLeads.summary.tested - manyLeads.summary.qualifiedTotal);

  const crossRows = [
    ...["manual-a", "manual-b"].map((id, index) => ({ ...repeatedBase, id, pairClass: "manual-auto", creator: `Manual ${index}`, creatorKey: `manual-${index}`, contextId: id, expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "" })),
    ...["synthetic-a", "synthetic-b"].map((id, index) => ({ ...repeatedBase, id, pairClass: "synthetic", creator: `Synthetic ${index}`, creatorKey: `synthetic-${index}`, contextId: id, expected: "shit", expectedCandidates: ["shit"], labelStatus: "known", current: "" }))
  ];
  crossRows.forEach((row) => { row.features = learner.discoveryFeatureVector("alpha [__] now", 0, 1, 1); row.context = "alpha [__] now"; row.slotIndex = 0; row.videoId = row.id; });
  const cross = learner.discoveryOutput({ rows: crossRows, creators: new Map(), fixtures: new Set(), skipped: {} },
    { maxDepth: 1, phraseWords: 8, minSupport: 1, minCreators: 1, minPrecision: 0.92, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 0 });
  const crossRejected = cross.tiers["manual-auto"].leads.summary.rejected;
  assert.ok(Object.values(crossRejected).some((entry) => entry.reasons.includes("crossTierPrecision")));
  const crossRejectedEntry = Object.values(cross.tiers.synthetic.leads.summary.rejected).find((entry) => entry.reasons.includes("crossTierPrecision"));
  assert.strictEqual(crossRejectedEntry.crossTier.status, "observed");
  assert.strictEqual(crossRejectedEntry.crossTier.support, 2);
  assert.deepStrictEqual(crossRejectedEntry.crossTier.counterexampleIds, ["manual-a", "manual-b"]);
  assert.strictEqual("validated" in crossRejectedEntry.crossTier, false);
  const solo = learner.discoveryOutput({ rows: crossRows.filter((row) => row.pairClass === "manual-auto"), creators: new Map(), fixtures: new Set(), skipped: {} },
    { maxDepth: 1, phraseWords: 8, minSupport: 1, minCreators: 1, minPrecision: 0.92, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 0 });
  const soloLead = solo.tiers["manual-auto"].leads.find((lead) => lead.target === "fuck");
  assert.strictEqual(soloLead.crossTier.status, "unsupported");
  assert.strictEqual(soloLead.promotionEligible, false);

  const overHundred = Array.from({ length: 101 }, (_, index) => {
    const context = `unlimited-${index} [__] now`;
    return { ...repeatedBase, id: `unlimited-${index}`, creator: `Unlimited ${index}`, creatorId: `unlimited-${index}`, creatorKey: `unlimited-${index}`,
      contextId: `unlimited-context-${index}`, context, features: learner.discoveryFeatureVector(context, 0, 1, 1), targetOffset: context.indexOf("[__]"),
      expected: "fuck", expectedCandidates: ["fuck"], labelStatus: "known", current: "" };
  });
  const unlimitedLeads = learner.discoverDiscoveryLeads(overHundred, "manual-auto", { maxDepth: 1, minSupport: 1, minCreators: 1,
    minPrecision: 0, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 0 });
  assert.ok(unlimitedLeads.length > 100);
  assert.ok(learner.discoverDiscoveryLeads(overHundred, "manual-auto", { maxDepth: 1, minSupport: 1, minCreators: 1,
    minPrecision: 0, minMarginalSupport: 1, minMarginalPrecision: 0, limit: 100 }).length <= 100);

  const bad = JSON.parse(JSON.stringify(discoveryDataset)); bad.rows[0].targetOffset += 1;
  fs.writeFileSync(discoveryPath, JSON.stringify(bad));
  assert.throws(() => learner.loadDiscoveryDataset(discoveryPath, 1, 1), /targetOffset/);
} finally {
  fs.rmSync(discoveryDirectory, { recursive: true, force: true });
}
console.log("mine-context-leaves.test.js passed");
