const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const refresh = require("../tools/post-acquisition-refresh");
const { defaultReports, EVIDENCE_POLICY } = require("../tools/audit-caption-corpus");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-refresh-test-"));
const reportPath = path.join(directory, "acquisition.json");
const fixturesDir = path.join(directory, "fixtures");
const datasetPath = path.join(directory, "dataset.json");
const auditPath = path.join(directory, "audit.json");
const miningPath = path.join(directory, "mining.json");
const statePath = path.join(directory, "state.json");
const staleArchive = path.join(directory, "stale-archive.json");
const projectRoot = path.join(__dirname, "..");
const expectedProvenanceReports = () => [...new Set([...defaultReports(projectRoot), reportPath]
  .map((file) => path.resolve(projectRoot, file)))];
const regressionDefaultReport = path.join(projectRoot, "corpus/generated",
  `caption-growth-refresh-regression-${process.pid}.json`);
fs.mkdirSync(path.dirname(regressionDefaultReport), { recursive: true }); // absent in a fresh checkout
fs.mkdirSync(fixturesDir);
fs.writeFileSync(staleArchive, JSON.stringify({ fixtures: [{ name: "stale", results: [] }] }));

const report = (slotCount, complete = false) => ({
  queueComplete: complete,
  channels: [{
    name: "Creator",
    queueComplete: complete,
    items: [
      { id: "manual", status: "paired-saved", pairClass: "manual-auto", slots: slotCount },
      { id: "automatic", status: "paired-saved", pairClass: "auto-auto", slots: 100 },
      { id: "failed", status: "no-usable-gt", pairClass: "manual-auto", slots: 99 }
    ]
  }]
});
const saveReport = (value) => fs.writeFileSync(reportPath, JSON.stringify(value));

try {
  assert.strictEqual(refresh.slots(report(2)), 2);
  assert.strictEqual(refresh.slots({ channels: [{ items: [{
    status: "paired-saved", pairKind: "auto-en", slots: 20
  }] }], minimumSlotsObserved: 20 }), 0);
  assert.strictEqual(refresh.queueComplete(report(0, true)), true);
  assert.strictEqual(refresh.queueComplete({ queueComplete: true, channels: [{ queueComplete: false }] }), false);
  assert.strictEqual(refresh.queueComplete({ complete: true, channels: [{ complete: true }] }), false);
  assert.throws(() => refresh.validateReport({ fixtures: [] }), /channels array/u);
  assert.throws(() => refresh.validateReport({ channels: [{ items: [null] }] }), /acquisition item/u);
  assert.strictEqual(refresh.parseArgs(["--minimum-new-slots", "3"]).minimumSlots, 3);
  assert.throws(() => refresh.parseArgs(["--minimum-slots", "0"]), /positive integer/u);

  const calls = { build: 0, audit: 0, mine: 0, auditInputs: [], mineInputs: [] };
  const faithfulDataset = {
    dataset: "real-manual-auto", pairClass: "manual-auto",
    mode: "faithful", validation: "faithful-only", discoveryOnly: false,
    provenance: { evidencePolicy: EVIDENCE_POLICY },
    rows: [{ id: "row-1", contextFaithful: true }]
  };
  const dependencies = {
    currentFingerprints: () => ({ rulesFingerprint: "rules-1" }),
    buildDataset: (options) => {
      calls.build += 1;
      assert.deepStrictEqual(options, { fixturesDir, provenanceReports: expectedProvenanceReports() });
      return faithfulDataset;
    },
    auditRules: (options) => {
      calls.audit += 1;
      calls.auditInputs.push(options);
      // A downloader report is provenance, not an archived evaluator report;
      // never fall back to an older archived report for the audit input.
      assert.deepStrictEqual(options.provenanceReports, expectedProvenanceReports());
      assert.notStrictEqual(options.reportPaths[0], staleArchive);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(options.reportPaths[0], "utf8")), { fixtures: [] });
      refresh.writeAtomic(auditPath, JSON.stringify({ audit: calls.audit }));
      return { audit: calls.audit };
    },
    mine: (options) => {
      calls.mine += 1;
      calls.mineInputs.push(options);
      assert.strictEqual(options.provenance, reportPath);
      assert.notStrictEqual(options.report, reportPath);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(options.report, "utf8")), { fixtures: [] });
      refresh.writeAtomic(options.output, JSON.stringify({ mining: calls.mine }));
    }
  };

  saveReport(report(2));
  let result = refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath, minimumSlots: 3 });
  assert.deepStrictEqual({ dataset: result.dataset, audit: result.audit, mining: result.mining },
    { dataset: "rebuilt", audit: "rebuilt", mining: "skipped" });
  assert.strictEqual(calls.mine, 0);

  result = refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath, minimumSlots: 3 });
  assert.deepStrictEqual({ dataset: result.dataset, audit: result.audit, mining: result.mining },
    { dataset: "unchanged", audit: "unchanged", mining: "skipped" });
  assert.deepStrictEqual({ build: calls.build, audit: calls.audit, mine: calls.mine },
    { build: 1, audit: 1, mine: 0 });

  fs.writeFileSync(auditPath, JSON.stringify({ stale: true }));
  result = refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath, minimumSlots: 3 });
  assert.strictEqual(result.audit, "rebuilt");
  assert.strictEqual(calls.audit, 2);

  saveReport(report(4));
  result = refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath, minimumSlots: 3 });
  assert.strictEqual(result.gainedSlots, 2);
  assert.strictEqual(result.mining, "skipped");
  assert.strictEqual(calls.mine, 0);

  saveReport(report(7));
  result = refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath, minimumSlots: 3 });
  assert.strictEqual(result.gainedSlots, 3);
  assert.strictEqual(result.evidenceStatus, "incomplete");
  assert.strictEqual(result.mining, "skipped");
  assert.strictEqual(calls.mine, 0);
  assert.strictEqual(fs.existsSync(miningPath), false);

  saveReport(report(7, true));
  result = refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath, minimumSlots: 99 });
  assert.strictEqual(result.gainedSlots, 0);
  assert.strictEqual(result.queueComplete, true);
  assert.strictEqual(result.mining, "rebuilt");
  assert.strictEqual(result.evidenceStatus, "complete");
  assert.strictEqual(calls.mine, 1);
  assert.strictEqual(calls.mineInputs[0].report !== reportPath, true);

  // Old caches cannot bypass a newly introduced evidence policy.
  const oldState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  delete oldState.evidencePolicy;
  fs.writeFileSync(statePath, JSON.stringify(oldState));
  result = refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath });
  assert.strictEqual(result.dataset, "rebuilt");

  saveReport(report(7));
  const previousProposals = fs.readFileSync(miningPath, "utf8");
  result = refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath });
  assert.strictEqual(result.miningEligible, false);
  assert.strictEqual(result.mining, "skipped");
  assert.strictEqual(fs.readFileSync(miningPath, "utf8"), previousProposals);
  const blockedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.strictEqual(blockedState.miningEligible, false);
  assert.strictEqual(blockedState.miningFingerprint, "");
  assert.strictEqual(blockedState.miningOutputFingerprint, "");
  fs.writeFileSync(`${reportPath}.lock`, "running");
  assert.throws(() => refresh.run({ ...dependencies, acquisition: reportPath, fixtures: fixturesDir,
    dataset: datasetPath, audit: auditPath, mining: miningPath, state: statePath, minimumSlots: 1 }),
    /still being written/u);
  fs.unlinkSync(`${reportPath}.lock`);

  const unfaithfulState = path.join(directory, "unfaithful-state.json");
  assert.throws(() => refresh.run({ ...dependencies, buildDataset: () => ({ mode: "archived", rows: [] }),
    acquisition: reportPath, fixtures: fixturesDir, dataset: path.join(directory, "unfaithful.json"),
    audit: path.join(directory, "unfaithful-audit.json"), mining: path.join(directory, "unfaithful-mining.json"),
    state: unfaithfulState, minimumSlots: 1 }), /non-faithful/u);

  const realFixtures = path.join(directory, "real-fixtures");
  fs.mkdirSync(realFixtures);
  const caption = (text) => ({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: text }] }] });
  fs.writeFileSync(path.join(realFixtures, "abcDEF12345_auto.en.json3"),
    JSON.stringify(caption("watch this [__]")));
  fs.writeFileSync(path.join(realFixtures, "abcDEF12345_manual.en.json3"),
    JSON.stringify(caption("watch this shit")));
  const actualReportPath = path.join(directory, "actual-acquisition.json");
  fs.writeFileSync(actualReportPath, JSON.stringify({ queueComplete: false, channels: [{
    name: "Actual Creator", queueComplete: false, items: [{ id: "abcDEF12345",
      status: "paired-saved", pairClass: "manual-auto", slots: 1,
      creator: "Actual Creator", creatorId: "UCAAAAAAAAAAAAAAAAAAAAAA" }]
  }] }));
  const actualResult = refresh.run({ acquisition: actualReportPath, fixtures: realFixtures,
    dataset: path.join(directory, "actual-dataset.json"), audit: path.join(directory, "actual-audit.json"),
    mining: path.join(directory, "actual-mining.json"), state: path.join(directory, "actual-state.json"),
    minimumSlots: 2 });
  assert.strictEqual(actualResult.slots, 1);
  assert.strictEqual(actualResult.mining, "skipped");
  const actualDataset = JSON.parse(fs.readFileSync(path.join(directory, "actual-dataset.json"), "utf8"));
  assert.strictEqual(actualDataset.mode, "faithful");
  assert.strictEqual(actualDataset.summary.rows, 0);
  assert.strictEqual(actualDataset.summary.exclusions.incompleteProvenance, 1);
  assert.strictEqual(actualDataset.provenance.evidencePolicy, EVIDENCE_POLICY);
  const actualAudit = JSON.parse(fs.readFileSync(path.join(directory, "actual-audit.json"), "utf8"));
  assert.strictEqual(actualAudit.selection.archivedRetainedRows, 0);
  assert.strictEqual(actualAudit.selection.localFaithfulRows, 1);
  assert.strictEqual(actualAudit.selection.incompleteProvenanceRows, 1);
  assert.strictEqual(actualAudit.baseline.attempts, 0);

  // Regression: a dynamically discovered old provenance report must survive
  // alongside the new acquisition report instead of reducing the dataset to
  // only the new acquisition's fixtures.
  const oldId = "QxRefresh01", newId = "QxRefresh02";
  const oldDefaultReport = regressionDefaultReport;
  const regressionFixtures = path.join(directory, "regression-fixtures");
  const regressionAcquisition = path.join(directory, "regression-acquisition.json");
  const regressionDataset = path.join(directory, "regression-dataset.json");
  const regressionAudit = path.join(directory, "regression-audit.json");
  const regressionState = path.join(directory, "regression-state.json");
  fs.mkdirSync(regressionFixtures);
  fs.writeFileSync(oldDefaultReport, JSON.stringify({ channels: [{ name: "Old Creator",
    creatorId: "UCAAAAAAAAAAAAAAAAAAAAAA", items: [{ id: oldId, status: "paired-saved",
      pairClass: "manual-auto" }] }] }));
  fs.writeFileSync(regressionAcquisition, JSON.stringify({ channels: [{ name: "New Creator",
    creatorId: "UCBBBBBBBBBBBBBBBBBBBBBB", items: [{ id: newId, status: "paired-saved",
      pairClass: "manual-auto", slots: 1 }] }] }));
  fs.writeFileSync(path.join(regressionFixtures, `${oldId}_auto.en.json3`),
    JSON.stringify(caption("watch this [__]")));
  fs.writeFileSync(path.join(regressionFixtures, `${oldId}_manual.en.json3`),
    JSON.stringify(caption("watch this shit")));
  fs.writeFileSync(path.join(regressionFixtures, `${newId}_auto.en.json3`),
    JSON.stringify(caption("watch this [__]")));
  fs.writeFileSync(path.join(regressionFixtures, `${newId}_manual.en.json3`),
    JSON.stringify(caption("watch this fuck")));
  const regressionAuditRules = (options) => {
    assert.ok(options.provenanceReports.includes(oldDefaultReport));
    assert.ok(options.provenanceReports.includes(regressionAcquisition));
    refresh.writeAtomic(regressionAudit, "{}\n");
    return {};
  };
  let regressionResult = refresh.run({ acquisition: regressionAcquisition, fixtures: regressionFixtures,
    dataset: regressionDataset, audit: regressionAudit, mining: path.join(directory, "regression-mining.json"),
    state: regressionState, minimumSlots: 999, auditRules: regressionAuditRules });
  assert.strictEqual(regressionResult.dataset, "rebuilt");
  let regressionOutput = JSON.parse(fs.readFileSync(regressionDataset, "utf8"));
  assert.strictEqual(regressionOutput.summary.rows, 2);
  assert.strictEqual(regressionOutput.summary.fixtures, 2);
  assert.ok(regressionOutput.provenance.reports.some((report) =>
    report.path === path.relative(projectRoot, oldDefaultReport)));
  assert.ok(regressionOutput.provenance.reports.some((report) =>
    report.path === path.relative(projectRoot, regressionAcquisition)));
  const firstSourceFingerprint = JSON.parse(fs.readFileSync(regressionState, "utf8")).source;
  fs.writeFileSync(oldDefaultReport, JSON.stringify({ changed: true, channels: [{ name: "Old Creator",
    creatorId: "UCAAAAAAAAAAAAAAAAAAAAAA", items: [{ id: oldId, status: "paired-saved",
      pairClass: "manual-auto" }] }] }));
  regressionResult = refresh.run({ acquisition: regressionAcquisition, fixtures: regressionFixtures,
    dataset: regressionDataset, audit: regressionAudit, mining: path.join(directory, "regression-mining.json"),
    state: regressionState, minimumSlots: 999, auditRules: regressionAuditRules });
  assert.strictEqual(regressionResult.dataset, "rebuilt");
  assert.notStrictEqual(JSON.parse(fs.readFileSync(regressionState, "utf8")).source, firstSourceFingerprint);
  regressionOutput = JSON.parse(fs.readFileSync(regressionDataset, "utf8"));
  assert.strictEqual(regressionOutput.summary.rows, 2);
  assert.strictEqual(regressionOutput.summary.fixtures, 2);

  const atomicPath = path.join(directory, "atomic.json");
  refresh.writeAtomic(atomicPath, "{}\n");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(atomicPath, "utf8")), {});
  assert.throws(() => refresh.writeAtomic(directory, "will fail"));
  assert.ok(!fs.readdirSync(directory).some((name) => name.includes(`${process.pid}.`) && name.endsWith(".tmp")));
} finally {
  fs.rmSync(regressionDefaultReport, { force: true });
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("post-acquisition-refresh.test.js passed");
