#!/usr/bin/env node
"use strict";

// Resumable offline refresh after caption acquisition. Acquisition itself is
// deliberately not started here; an incomplete queue may still be useful for
// rebuilding/auditing, but explicitly incomplete reports cannot trigger mining.
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { buildFaithfulDataset, currentFingerprints } = require("./build-real-manual-auto-dataset");
const { auditCurrentRules } = require("./audit-current-rules");
const { defaultReports, reportEvidenceStatus, EVIDENCE_POLICY } = require("./audit-caption-corpus");
const { classifyPairKind } = require("./download-paired-captions");
const miner = require("./mine-context-leaves");

const root = path.join(__dirname, "..");
const defaults = {
  acquisition: "corpus/generated/paired-caption-download-report.json",
  fixtures: "test-fixtures", dataset: ".tmp-real-manual-auto-faithful.json",
  audit: "corpus/generated/current-rule-audit.json", mining: "corpus/generated/context-leaf-proposals.json",
  state: "corpus/generated/post-acquisition-refresh.json", minimumSlots: 1
};
const absolute = (file) => path.resolve(root, file);
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(absolute(file))).digest("hex");
function filesIn(directory) {
  const dir = absolute(directory);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path.relative(root, file)) : [path.relative(root, file)];
  }).sort();
}
function fingerprint(files) {
  const hash = crypto.createHash("sha256");
  files.map((file) => [file, sha256(file)]).forEach(([file, digest]) => hash.update(`${file}\0${digest}\0`));
  return hash.digest("hex");
}
function validateReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report) || !Array.isArray(report.channels)) {
    throw new Error("Invalid acquisition report: expected a channels array.");
  }
  if (report.queueComplete !== undefined && typeof report.queueComplete !== "boolean") {
    throw new Error("Invalid acquisition report: queueComplete must be boolean.");
  }
  report.channels.forEach((channel, channelIndex) => {
    if (!channel || typeof channel !== "object" || Array.isArray(channel)) {
      throw new Error(`Invalid acquisition channel ${channelIndex}.`);
    }
    if (channel.queueComplete !== undefined && typeof channel.queueComplete !== "boolean") {
      throw new Error(`Invalid acquisition channel queueComplete ${channelIndex}.`);
    }
    if (channel.items !== undefined && !Array.isArray(channel.items)) {
      throw new Error(`Invalid acquisition channel items ${channelIndex}.`);
    }
    (channel.items || []).forEach((item, itemIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Invalid acquisition item ${channelIndex}:${itemIndex}.`);
      }
    });
  });
  return report;
}
function itemSlots(item) {
  const value = Number(item.slots);
  return item.status === "paired-saved" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
function slots(report) {
  return report.channels.flatMap((channel) => channel.items || []).reduce((total, item) => {
    const pairClass = item.pairClass || classifyPairKind(item.pairKind).pairClass;
    return total + (pairClass === "manual-auto" ? itemSlots(item) : 0);
  }, 0);
}
function queueComplete(report) {
  const channelsComplete = report.channels.length > 0 && report.channels.every((channel) => channel.queueComplete === true);
  return channelsComplete && report.queueComplete !== false;
}
function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(absolute(file), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}
function writeAtomic(file, value) {
  const destination = absolute(file); fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, value);
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* ignore cleanup failures */ }
    throw error;
  }
}
function fileFingerprint(file) {
  try { return sha256(file); } catch { return ""; }
}
function provenanceReports(acquisition) {
  return [...new Set([...defaultReports(root), acquisition].map((file) => path.resolve(root, file)))];
}
function faithfulDataset(dataset) {
  return dataset && dataset.dataset === "real-manual-auto" && dataset.pairClass === "manual-auto" &&
    dataset.mode === "faithful" && dataset.validation === "faithful-only" && dataset.discoveryOnly === false &&
    dataset.provenance?.evidencePolicy === EVIDENCE_POLICY &&
    Array.isArray(dataset.rows) && dataset.rows.every((row) => row && row.contextFaithful === true && row.evidenceEligible !== false);
}
function freshArchiveReport() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-refresh-"));
  const file = path.join(directory, "empty-report.json");
  writeAtomic(file, "{\"fixtures\":[]}\n");
  return { file, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...defaults };
  const names = { report: "acquisition", acquisition: "acquisition", fixtures: "fixtures", dataset: "dataset",
    audit: "audit", mining: "mining", state: "state", "minimum-slots": "minimumSlots",
    "minimum-new-slots": "minimumSlots" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = names[String(argv[i]).replace(/^--/u, "")];
    if (!key) throw new Error(`Unknown option ${argv[i]}.`);
    const value = argv[++i]; if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argv[i - 1]}.`);
    args[key] = key === "minimumSlots" ? Number(value) : value;
  }
  if (!Number.isSafeInteger(args.minimumSlots) || args.minimumSlots < 1) throw new Error("--minimum-slots must be a positive integer.");
  return args;
}
function run(options = {}) {
  const args = { ...defaults, ...options };
  const acquisition = absolute(args.acquisition);
  if (fs.existsSync(`${acquisition}.lock`)) {
    throw new Error(`Acquisition report is still being written: ${args.acquisition}`);
  }
  const report = validateReport(readJson(args.acquisition, null));
  const reports = provenanceReports(args.acquisition);
  const sourceFiles = [...reports, ...filesIn(args.fixtures)];
  const sourceFingerprint = fingerprint(sourceFiles), previous = readJson(args.state, {}), currentSlots = slots(report);
  const gainedSlots = Math.max(0, currentSlots - (Number(previous.slots) || 0));
  const rules = (options.currentFingerprints || currentFingerprints)();
  const fingerprints = { source: sourceFingerprint, rules, evidencePolicy: EVIDENCE_POLICY };
  const rulesFingerprint = JSON.stringify(rules);
  const changed = previous.source !== sourceFingerprint || JSON.stringify(previous.rules) !== rulesFingerprint ||
    previous.evidencePolicy !== EVIDENCE_POLICY;
  const auditFingerprint = `${sourceFingerprint}:${rulesFingerprint}:${EVIDENCE_POLICY}`;
  const result = { sourceFingerprint, slots: currentSlots, gainedSlots, queueComplete: queueComplete(report),
    evidenceStatus: reportEvidenceStatus(report), mining: "skipped" };
  result.miningEligible = result.evidenceStatus !== "incomplete";
  const buildDataset = options.buildDataset || buildFaithfulDataset;
  const auditRules = options.auditRules || auditCurrentRules;
  const mine = options.mine || miner.run;
  const datasetExists = fs.existsSync(absolute(args.dataset));
  const datasetCurrent = datasetExists && previous.datasetFingerprint === fileFingerprint(args.dataset);
  let dataset;
  if (changed || !datasetCurrent) {
    dataset = buildDataset({ fixturesDir: args.fixtures, provenanceReports: reports });
    if (!faithfulDataset(dataset)) throw new Error("Refusing to use a non-faithful dataset.");
    writeAtomic(args.dataset, `${JSON.stringify(dataset, null, 2)}\n`);
    result.dataset = "rebuilt";
  } else result.dataset = "unchanged";
  if (!dataset) dataset = readJson(args.dataset, null);
  if (!faithfulDataset(dataset)) throw new Error("Refusing to use a non-faithful dataset.");
  const datasetFingerprint = fileFingerprint(args.dataset);
  if (!datasetFingerprint) throw new Error(`Dataset output is missing: ${args.dataset}`);

  // The downloader report is provenance, not an archived evaluator report.
  // Give the audit/miner a fresh empty archive rather than reusing stale output.
  const archive = freshArchiveReport();
  try {
    const auditExists = fs.existsSync(absolute(args.audit));
    const auditCurrent = auditExists && previous.auditFingerprint === auditFingerprint &&
      Boolean(previous.auditOutputFingerprint) && fileFingerprint(args.audit) === previous.auditOutputFingerprint;
    if (!auditCurrent) {
      const audit = auditRules({ fixturesDir: args.fixtures, reportPaths: [archive.file], provenanceReports: reports });
      writeAtomic(args.audit, `${JSON.stringify(audit, null, 2)}\n`); result.audit = "rebuilt";
    } else result.audit = "unchanged";
    const auditOutputFingerprint = fileFingerprint(args.audit);
    if (!auditOutputFingerprint) throw new Error(`Audit output is missing: ${args.audit}`);

    const miningFingerprint = `${datasetFingerprint}:${rulesFingerprint}`;
    const shouldMine = result.miningEligible &&
      (result.queueComplete || gainedSlots >= args.minimumSlots);
    const miningCurrent = fs.existsSync(absolute(args.mining)) && previous.miningFingerprint === miningFingerprint &&
      Boolean(previous.miningOutputFingerprint) && fileFingerprint(args.mining) === previous.miningOutputFingerprint;
    if (shouldMine && dataset.rows.length) {
      if (!miningCurrent) {
        mine(miner.parseArgs(["--dataset", args.dataset, "--report", archive.file,
          "--provenance", args.acquisition, "--output", args.mining]));
        // miner writes atomically; hash the completed artifact for the ledger.
        result.mining = "rebuilt";
      } else result.mining = "unchanged";
      result.miningFingerprint = miningFingerprint;
      result.miningOutputFingerprint = fileFingerprint(args.mining);
      if (!result.miningOutputFingerprint) throw new Error(`Mining output is missing: ${args.mining}`);
    }
  } finally {
    archive.cleanup();
  }
  writeAtomic(args.state, `${JSON.stringify({ ...fingerprints, source: sourceFingerprint, slots: currentSlots,
    datasetFingerprint, auditFingerprint,
    auditOutputFingerprint: fileFingerprint(args.audit),
    miningEligible: result.miningEligible,
    miningFingerprint: result.miningEligible ? result.miningFingerprint || previous.miningFingerprint || "" : "",
    miningOutputFingerprint: result.miningEligible ? result.miningOutputFingerprint || previous.miningOutputFingerprint || "" : "" }, null, 2)}\n`);
  return result;
}
if (require.main === module) { try { console.log(JSON.stringify(run(parseArgs()), null, 2)); } catch (error) { console.error(error.message || error); process.exit(1); } }
module.exports = { defaults, fingerprint, parseArgs, queueComplete, run, slots, validateReport, writeAtomic };
