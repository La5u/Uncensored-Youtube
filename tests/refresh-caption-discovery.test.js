const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const refresh = require("../tools/refresh-caption-discovery");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "caption-refresh-"));
try {
  const fixtures = path.join(directory, "fixtures");
  fs.mkdirSync(fixtures);
  const report = path.join(directory, "one-report.json");
  fs.writeFileSync(report, "{}\n");
  const output = path.join(directory, "caption-discovery.json");
  const mining = path.join(directory, "caption-discovery-leads.json");
  const state = path.join(directory, "refresh-state.json");
  let builds = 0;
  let mines = 0;
  let sourceFingerprint = "first";
  const buildDiscovery = (options) => {
    builds += 1;
    assert.ok(options.reportPaths.includes(path.resolve(report)));
    return { dataset: "caption-discovery", rows: [{ id: "row" }], sources: [], sourceFingerprint };
  };
  const fakeMiner = {
    parseArgs(argv) {
      assert.deepStrictEqual(argv, ["--dataset", output, "--output", mining,
        "--window", "4,4", "--phrase-words", "8", "--limit", "0"]);
      return argv;
    },
    run() {
      mines += 1;
      return { leads: mines };
    }
  };
  const options = { reportPaths: [report, report], fixturesDir: fixtures, outputPath: output,
    miningPath: mining, statePath: state, buildDiscovery, miner: fakeMiner };

  assert.strictEqual(refresh.run(options).dataset, "rebuilt");
  assert.strictEqual(mines, 1);
  assert.strictEqual(refresh.run(options).mining, "unchanged");
  assert.strictEqual(mines, 1);
  assert.strictEqual(builds, 1);

  // A quiet tick parses/hashes its rollback snapshots instead of rereading
  // large artifacts. Content checks still run even when stat metadata agrees.
  const artifactReads = new Map([output, mining, state].map((file) => [file, 0]));
  const readSnapshot = fs.readFileSync;
  try {
    fs.readFileSync = (file, ...args) => {
      if (artifactReads.has(file)) artifactReads.set(file, artifactReads.get(file) + 1);
      return readSnapshot(file, ...args);
    };
    assert.strictEqual(refresh.run(options).status, "unchanged");
  } finally { fs.readFileSync = readSnapshot; }
  assert.deepStrictEqual([...artifactReads.values()], [1, 1, 1]);
  const originalMining = fs.readFileSync(mining);
  const miningStat = fs.statSync(mining);
  fs.writeFileSync(mining, Buffer.alloc(originalMining.length, 32));
  fs.utimesSync(mining, miningStat.atime, miningStat.mtime);
  assert.strictEqual(refresh.run(options).mining, "rebuilt", "same-size content corruption invalidates snapshots");
  assert.strictEqual(mines, 2);

  fs.unlinkSync(mining);
  assert.strictEqual(refresh.run(options).mining, "rebuilt");
  assert.strictEqual(mines, 3); // a missing derived artifact resumes safely

  // Every initial snapshot read is inside the lock-release guard. Even a
  // later snapshot failure must not rewrite the already-read originals.
  for (const file of [output, mining, state]) {
    for (const code of ["EACCES", "EISDIR"]) {
      const originals = [output, mining, state].map((artifact) => [artifact, fs.readFileSync(artifact)]);
      const readFileSync = fs.readFileSync, writeFileSync = fs.writeFileSync;
      const failure = Object.assign(new Error(`snapshot ${code}`), { code });
      const writes = [];
      let injected = false;
      try {
        fs.readFileSync = (target, ...args) => {
          if (target === file && !injected) { injected = true; throw failure; }
          return readFileSync(target, ...args);
        };
        fs.writeFileSync = (target, ...args) => {
          if (!String(target).endsWith(".lock")) writes.push(target);
          return writeFileSync(target, ...args);
        };
        assert.throws(() => refresh.run(options), (error) => error === failure);
      } finally {
        fs.readFileSync = readFileSync;
        fs.writeFileSync = writeFileSync;
      }
      assert.ok(injected);
      assert.deepStrictEqual(writes, []);
      for (const [artifact, content] of originals) {
        assert.ok(!fs.existsSync(`${artifact}.lock`));
        assert.deepStrictEqual(fs.readFileSync(artifact), content);
      }
      assert.strictEqual(refresh.run(options).status, "unchanged");
    }
  }

  const oldDataset = fs.readFileSync(output);
  const oldMining = fs.readFileSync(mining);
  const oldState = fs.readFileSync(state);
  sourceFingerprint = "broken-update";
  fs.writeFileSync(report, "{ }\n");
  fakeMiner.run = () => { throw new Error("miner failed"); };
  assert.throws(() => refresh.run(options), /miner failed/);
  assert.deepStrictEqual(fs.readFileSync(output), oldDataset);
  assert.deepStrictEqual(fs.readFileSync(mining), oldMining);
  assert.deepStrictEqual(fs.readFileSync(state), oldState);

  fakeMiner.run = () => ({ leads: 3 });
  fs.writeFileSync(`${state}.lock`, JSON.stringify({ pid: 99999999 }));
  refresh.run(options);
  assert.ok(!fs.existsSync(`${state}.lock`)); // recognized dead-PID locks are stale-safe
  fs.writeFileSync(`${state}.lock`, "99999999\n");
  assert.throws(() => refresh.run(options), /Caption discovery refresh is already running/);
  assert.ok(fs.existsSync(`${state}.lock`)); // malformed numeric locks wait for age expiry
  const oldLockTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(`${state}.lock`, oldLockTime, oldLockTime);
  refresh.run(options);
  assert.ok(!fs.existsSync(`${state}.lock`));
  fs.writeFileSync(`${state}.lock`, String(process.pid));
  assert.throws(() => refresh.run(options), /Caption discovery refresh is already running/);
  fs.unlinkSync(`${state}.lock`);

  const stagedOutput = path.join(directory, "staged.json");
  const stagedMining = path.join(directory, "staged-leads.json");
  const stagedState = path.join(directory, "staged-state.json");
  let staged = { rows: [{ videoId: "source-a" }, { videoId: "source-b" }], sources: [], sourceFingerprint: "stage-1" };
  const stagedMiner = { parseArgs: () => [], run: () => ({ staged: true }) };
  const stagedOptions = { ...options, outputPath: stagedOutput, miningPath: stagedMining, statePath: stagedState,
    buildDiscovery: () => staged, miner: stagedMiner };
  refresh.run(stagedOptions);
  const stagedOld = fs.readFileSync(stagedOutput);
  staged = { rows: [{ videoId: "source-a" }], sources: [], sourceFingerprint: "stage-2" };
  fs.writeFileSync(report, "stage-2\n");
  assert.strictEqual(refresh.run(stagedOptions).status, "deferred");
  assert.deepStrictEqual(fs.readFileSync(stagedOutput), stagedOld);
  staged = { rows: [{ videoId: "source-a" }, { videoId: "source-b" }, { videoId: "new-source" }], sources: [],
    diagnostics: { missingFixtures: ["historical-only"] }, sourceFingerprint: "stage-3" };
  fs.writeFileSync(report, "stage-3\n");
  assert.strictEqual(refresh.run(stagedOptions).dataset, "rebuilt");

  const parsed = refresh.parseArgs(["--report", report, "--report", report, "--fixtures", fixtures,
    "--output", output, "--mining", mining, "--watch", "300"]);
  assert.deepStrictEqual(parsed.reportPaths, [report, report]);
  assert.strictEqual(parsed.fixturesDir, path.resolve(fixtures));
  assert.strictEqual(parsed.outputPath, path.resolve(output));
  assert.strictEqual(parsed.miningPath, path.resolve(mining));
  assert.strictEqual(parsed.watchSeconds, 300);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("refresh-caption-discovery.test.js passed");
