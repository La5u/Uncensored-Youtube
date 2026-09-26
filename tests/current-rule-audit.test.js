const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  allRuleDefinitions,
  auditCurrentRules,
  currentChoice,
  localRows,
  mergeRows,
  parseArgs,
  validateAuditInputs,
  ruleId
} = require("../tools/audit-current-rules");

const definitions = allRuleDefinitions();
assert.ok(definitions.length > 3700);
assert.strictEqual(new Set(definitions.map(ruleId)).size, definitions.length);
assert.strictEqual(currentChoice("watch this [__]").word, "shit");
assert.strictEqual(currentChoice("bull [__] [__]", 0).word, "fucking");
assert.strictEqual(currentChoice("bull [__] [__]", 1).word, "shit");
assert.deepStrictEqual(parseArgs(["--pair-class", "manual-auto,synthetic", "--minimum-matches", "2"]).pairClasses,
  new Set(["manual-auto", "synthetic"]));

const duplicate = mergeRows([
  { fixture: "one", tokenIndex: 0, context: "watch this [__]", expected: ["shit"], sourceKinds: ["archive"], sourceFiles: ["archive"] }
], [
  { fixture: "one", tokenIndex: 0, context: "watch this [__]", expected: ["shit"], sourceKinds: ["local"], sourceFiles: ["local"] }
]);
assert.strictEqual(duplicate.rows.length, 1);
assert.deepStrictEqual(duplicate.rows[0].sourceKinds, ["archive", "local"]);
assert.strictEqual(duplicate.overlap.exactObservationCount, 1);
const completeDuplicate = mergeRows([
  { fixture: "one", tokenIndex: 0, context: "watch this [__]", expected: ["shit"], evidenceEligible: false,
    sourceKinds: ["archive"], sourceFiles: ["archive"] }
], [
  { fixture: "one", tokenIndex: 0, context: "watch this [__]", expected: ["shit"], evidenceEligible: true,
    sourceKinds: ["local"], sourceFiles: ["local"] }
]);
assert.strictEqual(completeDuplicate.rows[0].evidenceEligible, true);
const conflicting = mergeRows([
  { fixture: "one", tokenIndex: 0, context: "watch this [__]", expected: ["shit"], sourceKinds: ["archive"], sourceFiles: ["archive"] }
], [
  { fixture: "one", tokenIndex: 0, context: "watch this [__]", expected: ["fuck"], sourceKinds: ["local"], sourceFiles: ["local"], contextFaithful: true }
]);
assert.strictEqual(conflicting.rows.length, 1);
assert.strictEqual(conflicting.rows[0].slotConflict, true);
assert.strictEqual(conflicting.slotConflicts.length, 1);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-rule-audit-"));
try {
  const fixtures = path.join(temporaryDirectory, "fixtures");
  fs.mkdirSync(fixtures);
  const payload = (text) => ({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: text }] }] });
  fs.writeFileSync(path.join(fixtures, "abcDEF12345_auto.en.json3"), JSON.stringify(payload("watch this [__]")));
  fs.writeFileSync(path.join(fixtures, "abcDEF12345_manual.en.json3"), JSON.stringify(payload("watch this shit")));
  const provenance = path.join(temporaryDirectory, "provenance.json");
  fs.writeFileSync(provenance, JSON.stringify({ provenance: [{
    pairClass: "manual-auto", creator: "Audit Creator", ids: ["abcDEF12345"]
  }] }));
  const report = path.join(temporaryDirectory, "report.json");
  fs.writeFileSync(report, JSON.stringify({ fixtures: [{ name: "abcDEF12345", results: [{
    tokenIndex: 0, context: "watch this [__]", expected: ["shit"]
  }] }] }));

  const multiFixtures = path.join(temporaryDirectory, "multi-fixtures");
  fs.mkdirSync(multiFixtures);
  fs.writeFileSync(path.join(multiFixtures, "multiABC123_auto.en.json3"),
    JSON.stringify(payload("bull [__] [__]")));
  fs.writeFileSync(path.join(multiFixtures, "multiABC123_manual.en.json3"),
    JSON.stringify(payload("bull fucking shit")));
  const multiRows = localRows(multiFixtures, new Map([["multiABC123", {
    pairClass: "manual-auto", creator: "Audit Creator"
  }]]), new Set(["manual-auto"]));
  assert.deepStrictEqual(multiRows.map((row) => row.context), ["bull [__] [__]", "bull [__] [__]"]);
  assert.deepStrictEqual(multiRows.map((row) => row.slotIndex), [0, 1]);
  assert.deepStrictEqual(multiRows.map((row) => row.expected), [["fucking"], ["shit"]]);

  const invalidReport = path.join(temporaryDirectory, "invalid-report.json");
  fs.writeFileSync(invalidReport, JSON.stringify({ fixtures: [{ name: "bad", results: [{
    tokenIndex: -1, context: "bad [__]"
  }] }] }));
  assert.throws(() => validateAuditInputs([invalidReport], [provenance]), /Invalid archived token index/);
  const invalidProvenance = path.join(temporaryDirectory, "invalid-provenance.json");
  fs.writeFileSync(invalidProvenance, JSON.stringify({ provenance: [{
    pairClass: "not-a-pair-class", ids: ["abcDEF12345"]
  }] }));
  assert.throws(() => validateAuditInputs([report], [invalidProvenance]), /Invalid provenance pair class/);

  const creatorFixtures = path.join(temporaryDirectory, "creator-fixtures");
  fs.mkdirSync(creatorFixtures);
  fs.writeFileSync(path.join(creatorFixtures, "creatorAAA0_auto.en.json3"),
    JSON.stringify(payload("watch this [__]")));
  fs.writeFileSync(path.join(creatorFixtures, "creatorAAA0_manual.en.json3"),
    JSON.stringify(payload("watch this shit")));
  fs.writeFileSync(path.join(creatorFixtures, "creatorBBB0_auto.en.json3"),
    JSON.stringify(payload("watch this [__]")));
  fs.writeFileSync(path.join(creatorFixtures, "creatorBBB0_manual.en.json3"),
    JSON.stringify(payload("watch this")));
  const creatorProvenance = path.join(temporaryDirectory, "creator-provenance.json");
  fs.writeFileSync(creatorProvenance, JSON.stringify({ provenance: [
    { pairClass: "manual-auto", creator: "Labeled Creator", ids: ["creatorAAA0"] },
    { pairClass: "manual-auto", creator: "Unlabeled Creator", ids: ["creatorBBB0"] }
  ] }));
  const creatorReport = path.join(temporaryDirectory, "creator-report.json");
  fs.writeFileSync(creatorReport, JSON.stringify({ fixtures: [] }));
  const creatorResult = auditCurrentRules({
    fixturesDir: creatorFixtures,
    reportPaths: [creatorReport],
    provenanceReports: [creatorProvenance],
    pairClasses: new Set(["manual-auto"]),
    minimumMatches: 1,
    minimumCreators: 2
  });
  const creatorRule = creatorResult.rules.find((entry) => entry.template === "watch this [__]");
  assert.strictEqual(creatorRule.creatorCount, 1);
  assert.strictEqual(creatorRule.evidenceSufficient, false);

  const conflictProvenance = path.join(temporaryDirectory, "conflict-provenance.json");
  fs.writeFileSync(conflictProvenance, JSON.stringify({ provenance: [
    { pairClass: "manual-auto", creator: "Audit Creator", ids: ["abcDEF12345"] },
    { pairClass: "synthetic", creator: "Audit Creator", ids: ["abcDEF12345"] }
  ] }));
  const conflictResult = auditCurrentRules({
    fixturesDir: fixtures,
    reportPaths: [report],
    provenanceReports: [conflictProvenance],
    pairClasses: new Set(["conflict"]),
    minimumMatches: 1,
    minimumCreators: 1
  });
  const conflictRule = conflictResult.rules.find((entry) => entry.template === "watch this [__]");
  assert.strictEqual(conflictResult.baseline.rows, 1);
  assert.strictEqual(conflictRule.creatorCount, 0);
  assert.strictEqual(conflictRule.evidenceSufficient, false);

  const syntheticFixtures = path.join(temporaryDirectory, "synthetic-fixtures");
  fs.mkdirSync(syntheticFixtures);
  fs.writeFileSync(path.join(syntheticFixtures, "synA0000001_auto.en.json3"),
    JSON.stringify(payload("some [__] going on")));
  fs.writeFileSync(path.join(syntheticFixtures, "synA0000001_manual.en.json3"),
    JSON.stringify(payload("some fuck going on")));
  const syntheticProvenance = path.join(temporaryDirectory, "synthetic-provenance.json");
  fs.writeFileSync(syntheticProvenance, JSON.stringify({ provenance: [{
    pairClass: "synthetic", creator: "Synthetic Creator", ids: ["synA0000001"]
  }] }));
  const syntheticResult = auditCurrentRules({
    fixturesDir: syntheticFixtures,
    reportPaths: [report],
    provenanceReports: [syntheticProvenance],
    pairClasses: new Set(["synthetic"]),
    minimumMatches: 1,
    minimumCreators: 1
  });
  const syntheticRule = syntheticResult.rules.find((entry) => entry.template === "some [__] going on");
  assert.strictEqual(syntheticResult.baseline.pairClasses.synthetic.rows, 1);
  assert.strictEqual(syntheticRule.matchedCount, 1);
  assert.strictEqual(syntheticRule.realEvidenceMatchedCount, 0);
  assert.strictEqual(syntheticRule.evidenceSufficient, false);
  assert.strictEqual(syntheticRule.recommendation, "candidate");

  const result = auditCurrentRules({
    fixturesDir: fixtures,
    reportPaths: [report],
    provenanceReports: [provenance],
    pairClasses: new Set(["manual-auto"]),
    minimumMatches: 1,
    minimumCreators: 1
  });
  assert.strictEqual(result.selection.archivedRetainedRows, 1);
  assert.strictEqual(result.selection.localRows, 1);
  assert.strictEqual(result.selection.retainedRows, 1);
  assert.strictEqual(result.overlap.exactObservationCount, 1);
  assert.strictEqual(result.baseline.rows, 1);
  assert.strictEqual(result.baseline.correct, 1);
  assert.strictEqual(result.selection.auditedRows, 1);
  assert.strictEqual(result.selection.nonFaithfulContextRows, 0);
  assert.strictEqual(result.limitations.archivedTransformedContextsExcluded, 0);

  const incompleteProvenance = path.join(temporaryDirectory, "incomplete-provenance.json");
  fs.writeFileSync(incompleteProvenance, JSON.stringify({ queueComplete: false, provenance: [{
    pairClass: "manual-auto", creator: "Audit Creator", ids: ["abcDEF12345"]
  }] }));
  const incompleteLocal = auditCurrentRules({
    fixturesDir: fixtures,
    reportPaths: [report],
    provenanceReports: [incompleteProvenance],
    pairClasses: new Set(["manual-auto"]),
    minimumMatches: 1,
    minimumCreators: 1
  });
  assert.strictEqual(incompleteLocal.baseline.rows, 0);
  assert.strictEqual(incompleteLocal.baseline.attempts, 0);
  assert.strictEqual(incompleteLocal.recommendationCounts.keep, 0);
  assert.strictEqual(incompleteLocal.selection.incompleteProvenanceRows, 1);
  assert.strictEqual(incompleteLocal.selection.exclusions.incompleteProvenance, 1);
  assert.strictEqual(incompleteLocal.selection.retainedRows, 1);

  const faithfulReport = path.join(temporaryDirectory, "faithful-report.json");
  fs.writeFileSync(faithfulReport, JSON.stringify({ fixtures: [{ name: "abcDEF12345", results: [{
    tokenIndex: 0, context: "watch this [__]", originalContext: "watch this [__]",
    contextFaithful: true, expected: ["shit"]
  }] }] }));
  const incompleteArchived = auditCurrentRules({
    fixturesDir: path.join(temporaryDirectory, "missing-faithful-fixtures"),
    reportPaths: [faithfulReport],
    provenanceReports: [incompleteProvenance],
    pairClasses: new Set(["manual-auto"]),
    minimumMatches: 1,
    minimumCreators: 1
  });
  assert.strictEqual(incompleteArchived.baseline.rows, 0);
  assert.strictEqual(incompleteArchived.baseline.attempts, 0);
  assert.strictEqual(incompleteArchived.recommendationCounts.keep, 0);
  assert.strictEqual(incompleteArchived.selection.incompleteProvenanceRows, 1);

  const archivedOnly = auditCurrentRules({
    fixturesDir: path.join(temporaryDirectory, "missing-fixtures"),
    reportPaths: [report],
    provenanceReports: [provenance],
    pairClasses: new Set(["manual-auto"]),
    minimumMatches: 1,
    minimumCreators: 1
  });
  assert.strictEqual(archivedOnly.baseline.rows, 0);
  assert.strictEqual(archivedOnly.limitations.archivedTransformedContextsExcluded, 1);
  const rule = result.rules.find((entry) => entry.template === "watch this [__]");
  assert.ok(rule);
  assert.strictEqual(rule.creatorCount, 1);
  assert.strictEqual(rule.correctCount, 1);
  assert.strictEqual(rule.recommendation, "keep");

  // A below-gate selector can have real, creator-diverse evidence for both
  // correct coverage and false outputs.  Its retirement recommendation must
  // report the trade-off rather than being vetoed by coverage loss.
  const retirementFixtures = path.join(temporaryDirectory, "retirement-fixtures");
  fs.mkdirSync(retirementFixtures);
  const retirementRows = [
    ["retireA0001", "shit", "Retire Creator A"],
    ["retireA0002", "shit", "Retire Creator A"],
    ["retireA0003", "fuck", "Retire Creator A"],
    ["retireB0001", "shit", "Retire Creator B"],
    ["retireB0002", "fuck", "Retire Creator B"],
    ["retireB0003", "fuck", "Retire Creator B"]
  ];
  retirementRows.forEach(([id, expected]) => {
    fs.writeFileSync(path.join(retirementFixtures, `${id}_auto.en.json3`),
      JSON.stringify(payload("some [__] going on")));
    fs.writeFileSync(path.join(retirementFixtures, `${id}_manual.en.json3`),
      JSON.stringify(payload(`some ${expected} going on`)));
  });
  ["retireM0001", "retireM0002", "retireM0003"].forEach((id) => {
    fs.writeFileSync(path.join(retirementFixtures, `${id}_auto.en.json3`),
      JSON.stringify(payload("bull [__] [__]")));
    fs.writeFileSync(path.join(retirementFixtures, `${id}_manual.en.json3`),
      JSON.stringify(payload("bull fucking shit")));
  });
  const coverageRows = [
    ["retireC0001", "Retire Creator A"], ["retireC0002", "Retire Creator A"],
    ["retireD0001", "Retire Creator B"], ["retireD0002", "Retire Creator B"]
  ];
  coverageRows.forEach(([id]) => {
    fs.writeFileSync(path.join(retirementFixtures, `${id}_auto.en.json3`),
      JSON.stringify(payload("what the [__]")));
    fs.writeFileSync(path.join(retirementFixtures, `${id}_manual.en.json3`),
      JSON.stringify(payload("what the shit")));
  });
  const retirementProvenance = path.join(temporaryDirectory, "retirement-provenance.json");
  fs.writeFileSync(retirementProvenance, JSON.stringify({ provenance: [
    { pairClass: "manual-auto", creator: "Retire Creator A", ids: retirementRows.slice(0, 3).map(([id]) => id) },
    { pairClass: "manual-auto", creator: "Retire Creator B", ids: retirementRows.slice(3).map(([id]) => id) },
    { pairClass: "manual-auto", creator: "Retire Creator A", ids: ["retireM0001", "retireM0002", "retireM0003"] },
    { pairClass: "manual-auto", creator: "Retire Creator A", ids: coverageRows.slice(0, 2).map(([id]) => id) },
    { pairClass: "manual-auto", creator: "Retire Creator B", ids: coverageRows.slice(2).map(([id]) => id) }
  ] }));
  const retirementReport = path.join(temporaryDirectory, "retirement-report.json");
  fs.writeFileSync(retirementReport, JSON.stringify({ fixtures: [] }));
  const retirementResult = auditCurrentRules({
    fixturesDir: retirementFixtures,
    reportPaths: [retirementReport],
    provenanceReports: [retirementProvenance],
    pairClasses: new Set(["manual-auto"]),
    minimumMatches: 1,
    minimumCreators: 1
  });
  const retirementRule = retirementResult.rules.find((entry) => entry.template === "some [__] going on");
  assert.strictEqual(retirementRule.recommendation, "retire");
  assert.strictEqual(retirementRule.correctLost, 3);
  assert.strictEqual(retirementRule.wrongAvoided, 3);
  assert.ok(retirementRule.aggregatePrecisionDelta > 0);
  assert.strictEqual(retirementRule.precisionFirstEvidenceSufficient, true);
  assert.strictEqual(retirementRule.qualityGate.deterministicPassed, false);
  assert.match(retirementRule.recommendationReason, /precision-first retirement/u);
  const coverageRule = retirementResult.rules.find((entry) => entry.template === "what the [__]");
  assert.strictEqual(coverageRule.recommendation, "remove");
  assert.strictEqual(coverageRule.correctLost, 0);
  assert.strictEqual(coverageRule.wrongAvoided, 4);
  assert.ok(coverageRule.aggregatePrecisionDelta > 0);
  assert.match(coverageRule.recommendationReason, /coverage-preserving/u);

  const originalProvenance = JSON.parse(fs.readFileSync(retirementProvenance, "utf8"));
  for (const [names, expectedCreators] of [
    [["Anonymous", "anonymous"], 0],
    [[" Same Creator ", "same creator"], 1]
  ]) {
    const provenance = originalProvenance.provenance.map((entry) => ({
      ...entry, creatorId: "invalid-id",
      creator: names[Number(entry.creator.endsWith("B"))]
    }));
    fs.writeFileSync(retirementProvenance, JSON.stringify({ provenance }));
    const identityResult = auditCurrentRules({
      fixturesDir: retirementFixtures, reportPaths: [retirementReport],
      provenanceReports: [retirementProvenance], pairClasses: new Set(["manual-auto"]),
      minimumMatches: 1, minimumCreators: 1
    }).rules.find((entry) => entry.template === "some [__] going on");
    assert.strictEqual(identityResult.realEvidenceCreatorCount, expectedCreators);
    assert.strictEqual(identityResult.precisionFirstEvidenceSufficient, false);
    assert.notStrictEqual(identityResult.recommendation, "retire");
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
console.log("current-rule-audit.test.js passed");
