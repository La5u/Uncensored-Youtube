const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  load,
  validate,
  validateReport,
  importReport,
  reportFingerprint,
  currentFingerprints,
  fingerprintMismatches,
  strictProvenanceRequested,
  render,
  metricsPath
} = require("../tools/evaluation-metrics");

const data = load();
assert.doesNotThrow(() => validate(data));
const manual = data.rows.find((row) => row.id === "manual-auto");
assert.ok(Math.abs(manual.correct / manual.attempted - 0.89598) < 0.00001);
assert.strictEqual(data.rows.find((row) => row.id === "held-out-test").available, false);
assert.strictEqual(data.rows.find((row) => row.id === "dense-audio-whisper").diagnostic, true);
assert.strictEqual(data.rows.find((row) => row.id === "dense-audio-hybrid").correct, 2127);
const staleRow = data.rows.find((row) => row.id === "manual-filmot-wave-20260905");
assert.ok(staleRow.stale && staleRow.superseded);
// Dense reports for all four modes are current-fingerprint diagnostics.
assert.ok(["dense-audio-rules", "dense-audio-whisper", "dense-audio-hybrid", "dense-audio-rules-first"].every((id) => {
  const row = data.rows.find((candidate) => candidate.id === id);
  return !row.stale && !row.superseded;
}));
assert.deepStrictEqual(currentFingerprints(), {
  rulesFingerprint: require("../tools/evaluate-whisper-only").rulesFingerprint(),
  rulesAuxFingerprint: require("../tools/evaluate-whisper-only").auxiliaryRulesFingerprint(),
  rulesEngineFingerprint: require("../tools/evaluate-whisper-only").rulesEngineFingerprint()
});
assert.deepStrictEqual(fingerprintMismatches({ ...currentFingerprints(), rulesFingerprint: "old" }, currentFingerprints()), ["rulesFingerprint"]);
assert.strictEqual(strictProvenanceRequested({ strictProvenance: true }), true);
assert.match(render(data), /Historical validation \(unverified\) \| diagnostic \| 9/);
assert.strictEqual(data.rows.find((row) => row.id === "held-out-validation").status, "diagnostic");
assert.match(render(data), /stale\/superseded.*not current-code benchmark results/);
assert.throws(() => validate({ ...data, rows: [{ ...manual, precision: 0 }] }), /Stale precision/);
for (const status of ["held-out-validation", "held-out-test"]) {
  for (const strictProvenance of [false, true]) {
    const claimed = { id: "unsupported-held-out", status, precision: 1, coverage: 1 };
    const check = (row) => validate({ ...data, rows: [row] }, { strictProvenance });
    assert.throws(() => check(claimed), /Held-out summary counts/);
    assert.throws(() => check({ ...claimed, scoredSlots: 1, attempted: 1, correct: 1 }),
      /Held-out metric .* requires source report provenance/);
    assert.doesNotThrow(() => check({ ...claimed, available: false }));
  }
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-metrics-"));
const reportPath = path.join(temporaryDirectory, "report.json");
const report = {
  complete: true,
  mode: "whisper-only",
  // Historical fingerprints: an import from older rules must be marked stale.
  rulesFingerprint: "3707:39:qoalur",
  rulesAuxFingerprint: "1vqdx59",
  rulesEngineFingerprint: "gzlhma",
  summary: {
    scoredCount: 3980,
    attemptedCount: 3123,
    correctCount: 3017,
    precision: 3017 / 3123,
    coverage: 3017 / 3980
  }
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const fingerprint = reportFingerprint(reportPath);
assert.doesNotThrow(() => validateReport(report, {
  mode: "whisper-only",
  reportFingerprint: fingerprint,
  actualReportFingerprint: fingerprint,
  rulesFingerprint: report.rulesFingerprint,
  rulesAuxFingerprint: report.rulesAuxFingerprint,
  rulesEngineFingerprint: report.rulesEngineFingerprint
}));
const imported = importReport(reportPath, {
  id: "dense-audio-whisper-import-test",
  mode: "whisper-only",
  reportFingerprint: fingerprint,
  rulesFingerprint: report.rulesFingerprint
});
assert.deepStrictEqual(
  { scoredSlots: imported.scoredSlots, attempted: imported.attempted, correct: imported.correct },
  { scoredSlots: 3980, attempted: 3123, correct: 3017 }
);
assert.strictEqual(imported.source.reportFingerprint, fingerprint);
assert.strictEqual(imported.stale, true);
const missingSourceRow = {
  ...imported,
  id: "missing-source",
  source: { ...imported.source, report: "corpus/generated/missing-source-report.json" }
};
assert.doesNotThrow(() => validate({ schemaVersion: 1, asOf: data.asOf, rows: [missingSourceRow] }));
assert.throws(() => validate({ schemaVersion: 1, asOf: data.asOf, rows: [missingSourceRow] },
  { strictProvenance: true }), /Missing source report for missing-source/);
assert.throws(() => importReport(reportPath, {
  mode: "whisper-only",
  rulesFingerprint: report.rulesFingerprint
}), /report SHA-256/);
assert.throws(() => importReport(reportPath, { mode: "whisper-only" }), /requires an expected fingerprint/);
assert.throws(() => validateReport({ ...report, complete: false }, { mode: "whisper-only" }), /incomplete/);
assert.throws(() => validateReport(report, { mode: "rules-only" }), /Unexpected report mode/);
assert.throws(() => validateReport({ ...report, summary: { ...report.summary, correctCount: 0, precision: 1 } }), /Stale report summary precision/);
assert.throws(() => validateReport(report, {
  mode: "whisper-only",
  reportFingerprint: "sha256:wrong",
  actualReportFingerprint: fingerprint
}), /Report fingerprint mismatch/);
const denseRow = staleRow;
assert.throws(() => validate({ ...data, rows: [{ ...denseRow, stale: false, superseded: false }] }), /mark it stale\/superseded diagnostic/);
const copiedReport = path.join(temporaryDirectory, "copied-report.json");
fs.copyFileSync(reportPath, copiedReport);
const copiedRow = { ...imported, id: "copied-report", source: { ...imported.source, report: copiedReport } };
assert.doesNotThrow(() => validate({ ...data, rows: [copiedRow] }));
fs.appendFileSync(copiedReport, " ");
assert.throws(() => validate({ ...data, rows: [copiedRow] }), /Source report fingerprint mismatch/);
const manifestPath = path.join(temporaryDirectory, "creator-manifest.json");
const manifestRaw = JSON.stringify({
  version: 1,
  prospective: true,
  minimumCreators: 1,
  minimumSlots: 1,
  frozenAt: new Date(Date.now() - 1000).toISOString(),
  method: "Canonical creator IDs assigned before caption labels were inspected.",
  creators: [{ name: "Held-out", channelId: "UCXGcEdl8PDZPpqB5zjLoQ2w", split: "test" }]
});
fs.writeFileSync(manifestPath, manifestRaw);
const heldOutReport = {
  ...report,
  ...currentFingerprints(),
  creatorManifest: manifestPath,
  creatorManifestFingerprint: require("../tools/evaluate-whisper-only").contentFingerprint(manifestRaw),
  creatorSplit: "test",
  prospective: true
};
const heldOutReportPath = path.join(temporaryDirectory, "held-out-report.json");
fs.writeFileSync(heldOutReportPath, `${JSON.stringify(heldOutReport, null, 2)}\n`);
const heldOutRow = {
  ...imported,
  id: "held-out-source",
  status: "held-out-test",
  stale: false,
  superseded: false,
  source: {
    ...imported.source,
    ...currentFingerprints(),
    report: heldOutReportPath,
    reportFingerprint: reportFingerprint(heldOutReportPath),
    creatorManifest: manifestPath,
    creatorManifestFingerprint: heldOutReport.creatorManifestFingerprint
  }
};
const heldOutData = { schemaVersion: 1, asOf: data.asOf, rows: [heldOutRow] };
assert.doesNotThrow(() => validate(heldOutData, { strictProvenance: true }));
for (const strictProvenance of [false, true]) {
  const check = (row) => validate({ ...heldOutData, rows: [row] }, { strictProvenance });
  for (const key of ["scoredSlots", "attempted", "correct"]) {
    for (const value of [undefined, null, "1", 0.5, -1, NaN, Infinity]) {
      assert.throws(() => check({ ...heldOutRow, [key]: value }), /Held-out summary counts/);
    }
  }
  assert.throws(() => check({ ...heldOutRow,
    source: { ...heldOutRow.source, report: path.join(temporaryDirectory, "missing-held-out.json") }
  }), /Missing source report/);
  assert.throws(() => check({ ...heldOutRow,
    source: { ...heldOutRow.source, rulesEngineFingerprint: undefined }
  }), /Incomplete evaluator fingerprints/);
  assert.throws(() => check({ ...heldOutRow,
    source: { ...heldOutRow.source, report: reportPath, reportFingerprint: fingerprint,
      rulesFingerprint: report.rulesFingerprint, rulesAuxFingerprint: report.rulesAuxFingerprint,
      rulesEngineFingerprint: report.rulesEngineFingerprint,
      creatorManifest: undefined, creatorManifestFingerprint: undefined }
  }), /lacks creator manifest provenance/);
}
const wrongHeldOutRow = {
  ...heldOutRow,
  source: { ...heldOutRow.source, creatorManifestFingerprint: "wrong" }
};
assert.throws(() => validate({ ...heldOutData, rows: [wrongHeldOutRow] }), /creator manifest fingerprint mismatch/);
const nonProspectiveReport = { ...heldOutReport, prospective: false };
fs.writeFileSync(heldOutReportPath, `${JSON.stringify(nonProspectiveReport, null, 2)}\n`);
const nonProspectiveRow = {
  ...heldOutRow,
  source: { ...heldOutRow.source, reportFingerprint: reportFingerprint(heldOutReportPath) }
};
assert.throws(() => validate({ ...heldOutData, rows: [nonProspectiveRow] }), /must be prospective/);
const beforeMetrics = fs.readFileSync(metricsPath);
const beforeReadme = fs.readFileSync(path.join(__dirname, "..", "README.md"));
const cli = spawnSync(process.execPath, ["tools/evaluation-metrics.js", "--import-report", reportPath,
  "--id", "newline-test", "--mode", "whisper-only", "--expected-report-fingerprint", fingerprint, "--write"], {
  cwd: path.join(__dirname, ".."), encoding: "utf8"
});
assert.strictEqual(cli.status, 0, cli.stderr);
const writtenMetrics = fs.readFileSync(metricsPath);
assert.strictEqual(writtenMetrics.at(-1), 10);
fs.writeFileSync(metricsPath, beforeMetrics);
fs.writeFileSync(path.join(__dirname, "..", "README.md"), beforeReadme);
fs.rmSync(temporaryDirectory, { recursive: true, force: true });
console.log("evaluation-metrics.test.js passed");
