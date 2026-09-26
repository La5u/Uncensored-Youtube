const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const evaluator = require("./evaluate-whisper-only");
const metricsPath = path.join(root, "docs", "evaluation-metrics.json");
const readmePath = path.join(root, "README.md");
const start = "<!-- evaluation-metrics:start -->";
const end = "<!-- evaluation-metrics:end -->";
const fingerprintKeys = ["rulesFingerprint", "rulesAuxFingerprint", "rulesEngineFingerprint"];
const heldOutStatuses = new Set(["held-out-validation", "held-out-test"]);

function load(file = metricsPath) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function resolve(file) {
  return path.isAbsolute(file) ? file : path.join(root, file);
}

function sha256(text) {
  return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

function reportFingerprint(file) {
  return sha256(fs.readFileSync(resolve(file), "utf8"));
}

function currentFingerprints() {
  return {
    rulesFingerprint: evaluator.rulesFingerprint(),
    rulesAuxFingerprint: evaluator.auxiliaryRulesFingerprint(),
    rulesEngineFingerprint: evaluator.rulesEngineFingerprint()
  };
}

function fingerprintMismatches(source, current = currentFingerprints()) {
  return fingerprintKeys.filter((key) => source[key] !== current[key]);
}

function normalizeMode(mode) {
  return mode === "hybrid" ? "rules+whisper" : mode;
}

function strictProvenanceRequested(options = {}) {
  return options === true || options.strictProvenance === true;
}

function percent(value) {
  return value == null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function verifyCreatorManifest(row, source, report) {
  const reportManifest = typeof report.creatorManifest === "string" ? report.creatorManifest.trim() : "";
  const reportFingerprint = typeof report.creatorManifestFingerprint === "string"
    ? report.creatorManifestFingerprint.trim() : "";
  const expectedManifest = typeof source.creatorManifest === "string" ? source.creatorManifest.trim() : "";
  const expectedFingerprint = typeof source.creatorManifestFingerprint === "string"
    ? source.creatorManifestFingerprint.trim() : "";
  const claimsManifest = reportManifest || reportFingerprint || expectedManifest || expectedFingerprint ||
    report.creatorSplit === "test" || report.prospective === true;
  const heldOut = heldOutStatuses.has(row.status);

  if (!claimsManifest) {
    if (heldOut) throw new Error(`Held-out source report for ${row.id} lacks creator manifest provenance.`);
    return;
  }
  if (!reportManifest || !reportFingerprint) {
    throw new Error(`Source report creator manifest provenance is incomplete for ${row.id}`);
  }
  if (expectedManifest && resolve(expectedManifest) !== resolve(reportManifest)) {
    throw new Error(`Source report creator manifest mismatch for ${row.id}`);
  }
  if (expectedFingerprint && expectedFingerprint !== reportFingerprint) {
    throw new Error(`Source report creator manifest fingerprint mismatch for ${row.id}`);
  }

  let manifest;
  try {
    manifest = evaluator.loadCreatorManifest(resolve(reportManifest));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Missing creator manifest for ${row.id}: ${reportManifest}`);
    }
    throw new Error(`Invalid creator manifest for ${row.id}: ${error.message || error}`);
  }
  const actualFingerprint = manifest.fingerprint;
  if (actualFingerprint !== reportFingerprint) {
    throw new Error(`Creator manifest fingerprint mismatch for ${row.id}: ${actualFingerprint}`);
  }
  if (report.creatorSplit === "test" && report.prospective !== true) {
    throw new Error(`Test source report for ${row.id} must be prospective.`);
  }
  if (report.prospective === true && report.creatorSplit !== "test") {
    throw new Error(`Prospective source report for ${row.id} must use the test creator split.`);
  }
  if (heldOut) {
    const expectedSplit = row.status === "held-out-test" ? "test" : "validation";
    if (report.creatorSplit !== expectedSplit) {
      throw new Error(`Source report creator split mismatch for ${row.id}: ${report.creatorSplit || "missing"}`);
    }
    if (row.status === "held-out-test" && report.prospective !== true) {
      throw new Error(`Held-out test source report for ${row.id} must be prospective.`);
    }
  }
}

function verifySourceReport(row) {
  const source = row.source;
  let raw;
  try {
    raw = fs.readFileSync(resolve(source.report), "utf8");
  } catch (error) {
    throw new Error(`Missing source report for ${row.id}: ${source.report}`);
  }
  const actualFingerprint = sha256(raw);
  if (actualFingerprint !== source.reportFingerprint) {
    throw new Error(`Source report fingerprint mismatch for ${row.id}: ${actualFingerprint}`);
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid source report JSON for ${row.id}: ${source.report}`);
  }
  const expectedMode = source.mode || row.mode;
  if (expectedMode && normalizeMode(expectedMode) !== report.mode) {
    throw new Error(`Source report mode mismatch for ${row.id}: ${report.mode || "missing"}`);
  }
  if (source.complete !== report.complete || report.complete !== true) {
    throw new Error(`Source report completion mismatch for ${row.id}`);
  }
  for (const key of fingerprintKeys) {
    if (source[key] && report[key] !== source[key]) {
      throw new Error(`Source report ${key} mismatch for ${row.id}`);
    }
  }
  validateReport(report, {
    mode: expectedMode,
    id: row.id,
    status: row.status,
    creatorManifest: source.creatorManifest,
    creatorManifestFingerprint: source.creatorManifestFingerprint
  });
  const summary = report.summary;
  for (const [rowKey, reportKey] of [["scoredSlots", "scoredCount"], ["attempted", "attemptedCount"], ["correct", "correctCount"]]) {
    if (row[rowKey] != null && row[rowKey] !== summary[reportKey]) {
      throw new Error(`Source report ${reportKey} mismatch for ${row.id}`);
    }
  }
}

function validate(data, options = {}) {
  if (data.schemaVersion !== 1 || !Array.isArray(data.rows) || !data.asOf) {
    throw new Error("Invalid evaluation metrics schema.");
  }
  const ids = new Set();
  const current = currentFingerprints();
  const strictProvenance = strictProvenanceRequested(options);
  for (const row of data.rows) {
    if (!row.id || ids.has(row.id)) throw new Error(`Duplicate or missing metric id: ${row.id}`);
    ids.add(row.id);
    if (!["development", "held-out-validation", "held-out-test", "diagnostic"].includes(row.status)) {
      throw new Error(`Invalid metric status for ${row.id}: ${row.status}`);
    }
    if (row.available === false) continue;
    const heldOut = heldOutStatuses.has(row.status);
    if (heldOut) {
      if (["scoredSlots", "attempted", "correct"].some((key) =>
        !Number.isSafeInteger(row[key]) || row[key] < 0)) {
        throw new Error(`Held-out summary counts are missing or invalid for ${row.id}`);
      }
      if (!row.source) throw new Error(`Held-out metric ${row.id} requires source report provenance.`);
    }
    for (const key of ["precision", "coverage"]) {
      if (row[key] != null && (row[key] < 0 || row[key] > 1)) throw new Error(`Invalid ${key} for ${row.id}`);
    }
    if (row.scoredSlots != null && row.attempted != null && row.correct != null) {
      const precision = row.attempted ? row.correct / row.attempted : 0;
      const coverage = row.scoredSlots ? row.correct / row.scoredSlots : 0;
      if (row.correct < 0 || row.attempted < 0 || row.scoredSlots < 0 || row.correct > row.attempted || row.attempted > row.scoredSlots) {
        throw new Error(`Invalid summary counts for ${row.id}`);
      }
      if (row.precision != null && Math.abs(row.precision - precision) > 0.00001) {
        throw new Error(`Stale precision for ${row.id}`);
      }
      if (row.coverage != null && Math.abs(row.coverage - coverage) > 0.00001) {
        throw new Error(`Stale coverage for ${row.id}`);
      }
    }
    if (row.source) {
      if (typeof row.source.report !== "string" || !row.source.report.trim() ||
          !/^sha256:[a-f0-9]{64}$/u.test(row.source.reportFingerprint) || row.source.complete !== true) {
        throw new Error(`Invalid report provenance for ${row.id}`);
      }
      if ((strictProvenance || heldOut) && fingerprintKeys.some((key) =>
        typeof row.source[key] !== "string" || !row.source[key].trim())) {
        throw new Error(`Incomplete evaluator fingerprints for ${row.id}`);
      }
      if (!fs.existsSync(resolve(row.source.report))) {
        if (strictProvenance || heldOut) throw new Error(`Missing source report for ${row.id}: ${row.source.report}`);
      } else {
        verifySourceReport(row);
      }
      const stale = fingerprintMismatches(row.source, current);
      if (stale.length && (row.status !== "diagnostic" || row.diagnostic !== true ||
          !(row.stale === true || row.superseded === true))) {
        throw new Error(`${row.id} is stale for ${stale.join(", ")}; mark it stale/superseded diagnostic.`);
      }
    }
  }
}

function validateReport(report, expected = {}) {
  if (!report || report.complete !== true) throw new Error("Cannot import an incomplete report.");
  if (!["whisper-only", "rules-only", "rules-first", "rules+whisper"].includes(report.mode)) {
    throw new Error(`Invalid report mode: ${report.mode}`);
  }
  if (expected.mode && normalizeMode(expected.mode) !== report.mode) {
    throw new Error(`Unexpected report mode: ${report.mode}; expected ${expected.mode}.`);
  }
  const summary = report.summary;
  const countKeys = ["evaluatedCount", "scoredCount", "attemptedCount", "correctCount",
    "acceptedCount", "scoredAcceptedCount", "unscoredAcceptedCount", "unscoredCount"];
  if (!summary || countKeys.some((key) => summary[key] != null &&
      (!Number.isInteger(summary[key]) || summary[key] < 0)) ||
      !Number.isInteger(summary.scoredCount) || !Number.isInteger(summary.attemptedCount) ||
      !Number.isInteger(summary.correctCount) || summary.correctCount > summary.attemptedCount ||
      summary.attemptedCount > summary.scoredCount) {
    throw new Error("Invalid report summary counts.");
  }
  const checkRate = (name, numerator, denominator) => {
    if (summary[name] != null && Math.abs(summary[name] - (denominator ? numerator / denominator : 0)) > 0.000001) {
      throw new Error(`Stale report summary ${name}.`);
    }
  };
  checkRate("precision", summary.correctCount, summary.attemptedCount);
  checkRate("coverage", summary.correctCount, summary.scoredCount);
  checkRate("accuracy", summary.correctCount, summary.scoredCount);
  if (summary.evaluatedCount != null) {
    if (!Number.isInteger(summary.evaluatedCount) || summary.scoredCount > summary.evaluatedCount) {
      throw new Error("Invalid report evaluated count.");
    }
    checkRate("alignmentRate", summary.scoredCount, summary.evaluatedCount);
  }
  if (summary.unscoredCount != null && summary.evaluatedCount != null &&
      summary.unscoredCount !== summary.evaluatedCount - summary.scoredCount) {
    throw new Error("Stale report unscored count.");
  }
  if (summary.acceptedCount != null) {
    if (!Number.isInteger(summary.acceptedCount) || summary.acceptedCount < 0 ||
        (summary.evaluatedCount != null && summary.acceptedCount > summary.evaluatedCount)) {
      throw new Error("Invalid report accepted count.");
    }
    if (summary.evaluatedCount != null) checkRate("fillRate", summary.acceptedCount, summary.evaluatedCount);
  }
  if (summary.scoredAcceptedCount != null && summary.scoredAcceptedCount > summary.attemptedCount) {
    throw new Error("Invalid report scored accepted count.");
  }
  if (summary.unscoredAcceptedCount != null && summary.unscoredCount != null &&
      summary.unscoredAcceptedCount > summary.unscoredCount) {
    throw new Error("Invalid report unscored accepted count.");
  }
  if (summary.scoredAcceptedCount != null && summary.unscoredAcceptedCount != null &&
      summary.acceptedCount != null && summary.acceptedCount !== summary.scoredAcceptedCount + summary.unscoredAcceptedCount) {
    throw new Error("Stale report accepted count.");
  }
  verifyCreatorManifest({ id: expected.id || "report", status: expected.status }, expected, report);
  if (expected.reportFingerprint && expected.actualReportFingerprint &&
      expected.reportFingerprint !== expected.actualReportFingerprint) {
    throw new Error(`Report fingerprint mismatch: ${expected.actualReportFingerprint}`);
  }
  for (const key of fingerprintKeys) {
    if (expected[key] && report[key] !== expected[key]) {
      throw new Error(`Report ${key} mismatch: ${report[key] || "missing"}`);
    }
  }
  return report;
}

function importReport(file, options = {}) {
  if (!options.mode) throw new Error("Report import requires an expected mode.");
  const reportPath = resolve(file);
  const raw = fs.readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw);
  const fingerprint = sha256(raw);
  const expected = { ...options, actualReportFingerprint: fingerprint };
  if (!expected.reportFingerprint) {
    throw new Error("Report import requires an expected fingerprint: expected report SHA-256 is required.");
  }
  validateReport(report, expected);
  const summary = report.summary;
  const id = options.id || `dense-audio-${report.mode === "rules+whisper" ? "hybrid" : report.mode}`;
  const label = options.label || `Dense audio set, ${report.mode === "rules+whisper" ? "hybrid" : report.mode}`;
  const source = {
    report: path.relative(root, reportPath),
    reportFingerprint: fingerprint,
    mode: report.mode,
    complete: report.complete,
    rulesFingerprint: report.rulesFingerprint || null,
    rulesAuxFingerprint: report.rulesAuxFingerprint || null,
    rulesEngineFingerprint: report.rulesEngineFingerprint || null
  };
  const stale = fingerprintMismatches(source);
  return {
    id,
    label,
    tier: options.tier || "manual-auto",
    status: "diagnostic",
    diagnostic: true,
    ...(stale.length ? { stale: true, superseded: true } : {}),
    mode: report.mode,
    scoredSlots: summary.scoredCount,
    attempted: summary.attemptedCount,
    correct: summary.correctCount,
    precision: summary.correctCount / (summary.attemptedCount || 1),
    coverage: summary.correctCount / (summary.scoredCount || 1),
    source,
    note: options.note || "Completed source report; diagnostic only and not a held-out estimate."
  };
}

function render(data) {
  const rows = data.rows.map((row) => {
    const slots = row.scoredSlots == null ? "—" : row.scoredSlots.toLocaleString("en-US");
    const status = row.stale || row.superseded ? `${row.status} (stale/superseded)` : row.status;
    return `| ${row.label} | ${status} | ${slots} | ${percent(row.precision ?? (row.attempted ? row.correct / row.attempted : null))} | ${percent(row.coverage ?? (row.scoredSlots ? row.correct / row.scoredSlots : null))} |`;
  });
  const validationRows = data.rows.filter((row) => row.status === "held-out-validation" && row.available !== false);
  const testRows = data.rows.filter((row) => row.status === "held-out-test");
  const caveats = ["Development rows are in-sample."];
  if (validationRows.length === 1 && Number.isInteger(validationRows[0].scoredSlots)) {
    caveats.push(`The ${validationRows[0].scoredSlots.toLocaleString("en-US")}-slot validation row is diagnostic only.`);
  } else if (validationRows.length) {
    caveats.push("Held-out validation rows are diagnostic only.");
  }
  if (!testRows.length || testRows.every((row) => row.available === false)) {
    caveats.push("No held-out test score is available.");
  }
  const staleRows = data.rows.filter((row) => row.stale || row.superseded);
  if (staleRows.length) {
    const current = currentFingerprints();
    caveats.push("Rows marked stale/superseded are historical diagnostics, not current-code benchmark results. " +
      `Current evaluator fingerprints: rules ${current.rulesFingerprint}, aux ${current.rulesAuxFingerprint}, engine ${current.rulesEngineFingerprint}.`);
  }
  return [
    start,
    "### Current evaluation metrics",
    "",
    "The canonical snapshot is [`docs/evaluation-metrics.json`](docs/evaluation-metrics.json), as of " + data.asOf + ".",
    "",
    "| Tier | Status | Scored slots | Precision | Coverage |",
    "| --- | --- | ---: | ---: | ---: |",
    ...rows,
    "",
    ...caveats,
    end
  ].join("\n");
}

function updateReadme(data, write) {
  const readme = fs.readFileSync(readmePath, "utf8");
  const block = render(data);
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(readme)) throw new Error("README is missing the evaluation metrics markers.");
  if (write) fs.writeFileSync(readmePath, readme.replace(pattern, block));
  else if (readme.replace(pattern, block) !== readme) throw new Error("README metrics block is stale; run --write-readme.");
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return argv[index + 1];
}

function importFromCommand(argv, validationOptions = {}) {
  const report = argument(argv, "--import-report");
  if (!report) return false;
  const expectedReport = argument(argv, "--expected-report-fingerprint");
  const row = importReport(report, {
    id: argument(argv, "--id"),
    label: argument(argv, "--label"),
    mode: argument(argv, "--mode"),
    tier: argument(argv, "--tier"),
    note: argument(argv, "--note"),
    reportFingerprint: expectedReport,
    rulesFingerprint: argument(argv, "--expected-rules-fingerprint"),
    rulesAuxFingerprint: argument(argv, "--expected-rules-aux-fingerprint"),
    rulesEngineFingerprint: argument(argv, "--expected-rules-engine-fingerprint")
  });
  const data = load();
  const rows = data.rows.filter((existing) => existing.id !== row.id);
  const next = { ...data, rows: [...rows, row] };
  validate(next, validationOptions);
  if (argv.includes("--write")) {
    fs.writeFileSync(metricsPath, `${JSON.stringify(next, null, 2)}\n`);
    updateReadme(next, true);
  }
  console.log(`${argv.includes("--write") ? "Imported" : "Validated"} ${row.id}: ${row.source.reportFingerprint}`);
  return true;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const strictProvenance = argv.includes("--strict-provenance");
  if (!importFromCommand(argv, { strictProvenance })) {
    const data = load();
    validate(data, { strictProvenance });
    updateReadme(data, argv.includes("--write-readme"));
    console.log(`Evaluation metrics ${argv.includes("--write-readme") ? "written" : "checked"}.`);
  }
}

module.exports = {
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
};
