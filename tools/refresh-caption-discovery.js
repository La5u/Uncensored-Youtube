#!/usr/bin/env node
"use strict";

// Orchestrate the disposable, discovery-only caption corpus.  Acquisition
// reports and fixture files are inputs; this command never promotes or edits
// either one.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const builder = require("./build-caption-discovery");
const miner = require("./mine-context-leaves");
const { defaultReports } = require("./audit-caption-corpus");

const root = path.join(__dirname, "..");
const defaults = {
  fixturesDir: path.join(root, "test-fixtures"),
  outputPath: path.join(root, "corpus/generated/caption-discovery.json"),
  miningPath: path.join(root, "corpus/generated/caption-discovery-leads.json"),
  statePath: path.join(root, "corpus/generated/caption-discovery-refresh-state.json"),
  watchSeconds: 0
};
const reportDirectories = [
  path.join(root, "tmp/channel-research/agent-downloads"),
  path.join(root, "tmp/channel-research/agent-downloads/state"),
  path.join(root, "state")
];
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const absolute = (file) => path.resolve(root, file);
const LOCK_STALE_MS = 60 * 60 * 1000;
const DISCOVERY_MODULES = [
  __filename,
  require.resolve("./build-caption-discovery"),
  require.resolve("./evaluation-alignment"),
  require.resolve("../src/timedtext"),
  require.resolve("./download-paired-captions"),
  require.resolve("./audit-caption-corpus"),
  require.resolve("./mine-context-leaves"),
  require.resolve("./archived-rules-benchmark"),
  ...["rules", "rules-data", "rules-compiler", "rule-data/exact", "rule-data/grammar", "rule-data/language"]
    .map((file) => require.resolve(`../src/${file}`))
];

function reportFiles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith("report.json"))
      .map((entry) => path.join(directory, entry.name));
  } catch { return []; }
}

function collectReportPaths(options = {}) {
  const explicit = options.reportPaths || options.reports || options.report || [];
  const values = Array.isArray(explicit) ? explicit : [explicit];
  return [...new Set([
    ...defaultReports(root),
    ...reportDirectories.flatMap(reportFiles),
    ...values.filter(Boolean).map(absolute)
  ].map((file) => path.resolve(file)))].sort();
}

function snapshotFingerprint(files) {
  // The builder performs content snapshots when a refresh is needed. This
  // inexpensive inventory lets a quiet watcher avoid rereading large reports;
  // atomic acquisition writes change size/mtime and therefore wake the next
  // pass.
  const parts = files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${file}\0${stat.size}\0${stat.mtimeMs}\0${fs.existsSync(`${file}.lock`)}\0`;
    } catch { return `${file}\0missing\0`; }
  });
  return sha(Buffer.from(parts.join("")));
}

function readJson(file, fallback = null) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}

function fileFingerprint(file) {
  try { return sha(fs.readFileSync(file)); } catch { return ""; }
}

function currentModulesFingerprint() {
  return sha(Buffer.from(JSON.stringify(DISCOVERY_MODULES.map((file) => ({
    file: path.resolve(file), sha256: fileFingerprint(file)
  })))));
}

// Resolve existing symlinks, while still producing a stable identity for a
// destination whose leaf does not exist yet. This keeps output aliases from
// bypassing the input guard through a symlink or a missing output file.
function realPath(file) {
  let current = path.resolve(file);
  const suffix = [];
  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      return path.join(resolved, ...suffix.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(file);
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function datasetFixturePaths(dataset) {
  return (dataset?.sources || []).flatMap((source) =>
    (source.files || []).filter((file) => file && file.path).map((file) => absolute(file.path)));
}

function indexedSourceCounts(dataset) {
  const counts = new Map();
  (dataset?.rows || []).forEach((row) => {
    const identity = String(row?.videoId || row?.sourceId || row?.id || "").trim();
    if (identity) counts.set(identity, (counts.get(identity) || 0) + 1);
  });
  return counts;
}

function indexedSourceRegression(previousDataset, currentDataset) {
  const previous = indexedSourceCounts(previousDataset);
  const current = indexedSourceCounts(currentDataset);
  return [...previous.entries()].some(([identity, count]) => (current.get(identity) || 0) < count);
}

function writeAtomic(file, value) {
  const destination = path.resolve(file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temporary, value);
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or already absent */ }
  }
}

function restore(file, previous) {
  if (previous === null) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  } else writeAtomic(file, previous);
}

function recognizedLockPid(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !Number.isSafeInteger(parsed.pid) || parsed.pid < 1) return null;
    return parsed.pid;
  } catch { return null; }
}

function acquireLock(file) {
  const lock = `${path.resolve(file)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  while (true) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
      return lock;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = "";
      try { owner = fs.readFileSync(lock, "utf8"); } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw readError;
      }
      // Only the lock format written above can establish a dead owner. A
      // malformed (including numeric-only) lock is retained until it has
      // exceeded the abandonment age, avoiding accidental concurrent writers.
      const pid = recognizedLockPid(owner);
      if (pid !== null) {
        try { process.kill(pid, 0); throw new Error(`Caption discovery refresh is already running: ${lock}`); }
        catch (processError) {
          if (processError.code !== "ESRCH") throw processError;
        }
      }
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { continue; }
      if (!stale && pid === null) throw new Error(`Caption discovery refresh is already running: ${lock}`);
      try { fs.unlinkSync(lock); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
    }
  }
}

function releaseLock(lock) {
  if (!lock) return;
  try { fs.unlinkSync(lock); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function outputIsInput(file, reportPaths, fixturesDir) {
  const destination = realPath(file), fixtures = realPath(fixturesDir);
  return reportPaths.map(realPath).some((report) => report === destination) ||
    destination === fixtures || destination.startsWith(`${fixtures}${path.sep}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...defaults, reportPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!["--report", "--fixtures", "--output", "--mining", "--state", "--watch"].includes(value)) {
      throw new Error(`Unknown argument: ${value}`);
    }
    const next = argv[++index];
    if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${value}.`);
    if (value === "--report") args.reportPaths.push(next);
    else if (value === "--fixtures") args.fixturesDir = absolute(next);
    else if (value === "--output") args.outputPath = absolute(next);
    else if (value === "--mining") args.miningPath = absolute(next);
    else if (value === "--state") args.statePath = absolute(next);
    else {
      const seconds = Number(next);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--watch must be a non-negative number of seconds.");
      args.watchSeconds = seconds;
    }
  }
  return args;
}

function run(options = {}) {
  const args = { ...defaults, ...options };
  args.fixturesDir = absolute(args.fixturesDir || args.fixtures);
  args.outputPath = absolute(args.outputPath || args.output);
  args.miningPath = absolute(args.miningPath || args.mining || args.miningOutput);
  args.statePath = absolute(args.statePath || args.state);
  const reports = collectReportPaths(args);
  const outputPaths = [args.outputPath, args.miningPath, args.statePath];
  if (outputPaths.some((file) => outputIsInput(file, reports, args.fixturesDir)) ||
      new Set(outputPaths.map(realPath)).size !== outputPaths.length) {
    throw new Error("Refusing to write discovery output over an input or raw fixture.");
  }
  const locks = [];
  try {
    for (const file of [args.outputPath, args.miningPath, args.statePath]) locks.push(acquireLock(file));
  } catch (error) {
    locks.reverse().forEach(releaseLock);
    throw error;
  }
  const old = new Map([args.outputPath, args.miningPath, args.statePath].map((file) => [file,
    fs.existsSync(file) ? fs.readFileSync(file) : null]));
  try {
    const previousState = readJson(args.statePath, {}) || {};
    const previousDataset = readJson(args.outputPath, null);
    const previousFixtures = datasetFixturePaths(previousDataset);
    const modulesFingerprint = currentModulesFingerprint();
    const quickFingerprint = snapshotFingerprint([...reports, ...previousFixtures]);
    if (previousState.quickFingerprint === quickFingerprint &&
        previousState.modulesFingerprint === modulesFingerprint &&
        previousState.datasetFingerprint === fileFingerprint(args.outputPath) &&
        previousState.miningFingerprint === fileFingerprint(args.miningPath)) {
      return { status: "unchanged", reports, inputFingerprint: previousState.inputFingerprint,
        dataset: "unchanged", mining: "unchanged" };
    }
    const buildDiscovery = args.buildDiscovery || args.builder || args.build || builder.buildDiscovery;
    const dataset = buildDiscovery({ fixturesDir: args.fixturesDir, reportPaths: reports, previousDataset });
    if (indexedSourceRegression(previousDataset, dataset)) {
      // A source that was already indexed must not silently vanish because a
      // report or fixture was momentarily unavailable. Sources which never
      // produced rows (including historical missing fixtures) do not block a
      // new acquisition.
      return { status: "deferred", reports, reason: "previously indexed source is incomplete", dataset: previousDataset || dataset };
    }

    const inputFingerprint = sha(Buffer.from(JSON.stringify({ reports, sourceFingerprint: dataset.sourceFingerprint })));
    const currentDatasetFingerprint = fileFingerprint(args.outputPath);
    const modulesChanged = previousState.modulesFingerprint !== modulesFingerprint;
    const datasetChanged = modulesChanged || !currentDatasetFingerprint || previousState.datasetFingerprint !== currentDatasetFingerprint ||
      previousState.inputFingerprint !== inputFingerprint;
    const miningExists = Boolean(fileFingerprint(args.miningPath));
    const miningChanged = datasetChanged || !miningExists || previousState.miningFingerprint !== fileFingerprint(args.miningPath);
    const result = { status: "unchanged", reports, inputFingerprint, dataset: "unchanged", mining: "unchanged" };
    if (!datasetChanged && !miningChanged) return result;

    if (datasetChanged) {
      writeAtomic(args.outputPath, `${JSON.stringify(dataset)}\n`);
      result.dataset = "rebuilt";
      result.status = "refreshed";
    }
    const datasetFingerprint = fileFingerprint(args.outputPath);
    if (!datasetFingerprint) throw new Error(`Dataset output is missing: ${args.outputPath}`);

    if (miningChanged) {
      const miningModule = (args.miner && typeof args.miner === "object") ? args.miner :
        (args.minerModule || miner);
      const parseMinerArgs = args.parseMinerArgs || miningModule.parseArgs;
      const runMiner = args.mine || (typeof args.miner === "function" ? args.miner : miningModule.run);
      const parsed = parseMinerArgs(["--dataset", args.outputPath, "--output", args.miningPath,
        "--window", "4,4", "--phrase-words", "8", "--limit", "0"]);
      const mined = runMiner(parsed);
      // Some embedders return the artifact without writing it. Reuse that
      // result, when available, without imposing a miner output format.
      if (!fileFingerprint(args.miningPath) && mined !== undefined) {
        writeAtomic(args.miningPath, `${typeof mined === "string" ? mined : JSON.stringify(mined)}\n`);
      }
      if (!fileFingerprint(args.miningPath)) throw new Error(`Mining output is missing: ${args.miningPath}`);
      result.mining = "rebuilt";
      result.status = "refreshed";
    }
    const state = {
      version: 1, inputFingerprint,
      quickFingerprint: snapshotFingerprint([...reports, ...datasetFixturePaths(dataset)]),
      modulesFingerprint, datasetFingerprint: fileFingerprint(args.outputPath),
      miningFingerprint: fileFingerprint(args.miningPath), reportCount: reports.length
    };
    writeAtomic(args.statePath, `${JSON.stringify(state)}\n`);
    return { ...result, datasetFingerprint: state.datasetFingerprint, miningFingerprint: state.miningFingerprint };
  } catch (error) {
    // The miner is external to this transaction. Restore every artifact if it
    // failed after writing, so a broken partial source cannot erase a good run.
    for (const [file, content] of old) restore(file, content);
    throw error;
  } finally {
    locks.reverse().forEach(releaseLock);
  }
}

function watch(options = {}) {
  const args = { ...defaults, ...options };
  const seconds = Number(args.watchSeconds ?? args.watch ?? 0);
  if (!(seconds > 0)) return run(args);
  let stopped = false;
  let timer;
  const signal = () => { stop(); process.exitCode = 0; };
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGTERM", signal);
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  const tick = () => {
    if (stopped) return;
    try { run(args); } catch (error) { process.stderr.write(`${error.message || error}\n`); }
    if (!stopped) timer = setTimeout(tick, seconds * 1000);
  };
  tick();
  return { status: "watching", seconds, stop };
}

if (require.main === module) {
  try {
    const result = watch(parseArgs());
    if (result?.status !== "watching") {
      const { reports, dataset, ...summary } = result;
      process.stdout.write(`${JSON.stringify({ ...summary, reportCount: reports?.length,
        dataset: typeof dataset === "string" ? dataset : "deferred" })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}

module.exports = { defaults, collectReportPaths, snapshotFingerprint, fileFingerprint, currentModulesFingerprint,
  realPath, indexedSourceRegression, writeAtomic, acquireLock, releaseLock, parseArgs, run, watch };
