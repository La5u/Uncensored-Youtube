const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  acquireReportLock,
  checkedVideoKey,
  checkedVideoType,
  classifyPairKind,
  hasCheckedVideo,
  hasSwears,
  hasTimedGroundTruth,
  importCheckedVideoReports,
  loadCheckedVideoLedger,
  parseArgs,
  recordCheckedVideo,
  saveCheckedVideoLedger,
  summarizePairItems,
  synthesizeCensoredCaption,
  writeAtomic
} = require("../tools/download-paired-captions");

assert.strictEqual(parseArgs(["--revisit"]).revisit, true);
assert.strictEqual(parseArgs(["--synthetic-auto-only"]).syntheticAutoOnly, true);
assert.strictEqual(parseArgs(["--manual-auto-only"]).manualAutoOnly, true);
assert.strictEqual(parseArgs(["--sample-per-channel", "8"]).samplePerChannel, 8);
assert.strictEqual(checkedVideoType(parseArgs(["--manual-auto-only"])), "manual-auto");
assert.strictEqual(checkedVideoType(parseArgs(["--auto-auto-only"])), "auto-auto");
assert.strictEqual(checkedVideoType(parseArgs(["--synthetic-auto-only"])), "synthetic-auto");
assert.strictEqual(checkedVideoType(parseArgs(["--pair-target", "0", "--audio-target", "1"])), "audio");
assert.strictEqual(checkedVideoType(parseArgs([])), "paired");
assert.throws(
  () => parseArgs(["--manual-auto-only", "--auto-auto-only"]),
  /mutually exclusive/
);

assert.deepStrictEqual(
  require("../tools/download-paired-captions").distributedSample(
    Array.from({ length: 10 }, (_, index) => index), 4
  ),
  [0, 3, 6, 9]
);
assert.strictEqual(parseArgs(["--auto-auto-only"]).autoAutoOnly, true);
assert.throws(() => parseArgs(["--synthetic-auto-only", "true", "--auto-auto-only", "true"]), /mutually exclusive/u);
assert.deepStrictEqual(
  (({ requestSleep, maxGlobal429 }) => ({ requestSleep, maxGlobal429 }))(
    parseArgs(["--request-sleep", "7", "--max-global-429", "3"])
  ),
  { requestSleep: 7, maxGlobal429: 3 }
);
assert.throws(() => parseArgs(["--request-sleep", "-1"]), /positive/u);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-pair-"));
const caption = path.join(directory, "caption.json3");
fs.writeFileSync(caption, JSON.stringify({
  events: [{ segs: [{ utf8: "well, fucking hell" }] }]
}));
assert.strictEqual(hasSwears(caption), true);
const synthetic = path.join(directory, "synthetic.json3");
assert.strictEqual(synthesizeCensoredCaption(caption, synthetic), 1);
assert.match(fs.readFileSync(synthetic, "utf8"), /well, \[__\] hell/u);
const atomicReport = path.join(directory, "report.json");
writeAtomic(atomicReport, '{"ok":true}');
assert.deepStrictEqual(JSON.parse(fs.readFileSync(atomicReport, "utf8")), { ok: true });
assert.strictEqual(fs.existsSync(`${atomicReport}.tmp-${process.pid}`), false);
const releaseLock = acquireReportLock(atomicReport);
assert.throws(() => acquireReportLock(atomicReport), /already being written/u);
releaseLock();
const releaseReacquiredLock = acquireReportLock(atomicReport);
releaseReacquiredLock();
const ledgerPath = path.join(directory, "checked-video-ledger.json");
const releaseLedgerLock = acquireReportLock(ledgerPath);
assert.throws(() => acquireReportLock(ledgerPath), /already being written/u);
releaseLedgerLock();
const ledger = loadCheckedVideoLedger(ledgerPath);
assert.strictEqual(recordCheckedVideo(ledger, "abc123", "manual-auto", "no-manual"), true);
assert.strictEqual(recordCheckedVideo(ledger, "abc123", "manual-auto", "transient-failure"), false);
assert.strictEqual(recordCheckedVideo(ledger, "abc123", "manual-auto", "paired-saved"), false);
assert.strictEqual(recordCheckedVideo(ledger, "abc123", "manual-auto", "audio-fallback-saved"), false);
assert.strictEqual(recordCheckedVideo(ledger, "abc123", "auto-auto", "no-manual"), true);
assert.strictEqual(recordCheckedVideo(ledger, "abc123", "manual-auto", "no-manual"), false);
assert.strictEqual(hasCheckedVideo(ledger, "abc123", "manual-auto"), true);
assert.strictEqual(hasCheckedVideo(ledger, "abc123", "synthetic-auto"), false);
assert.strictEqual(checkedVideoKey("abc123", "manual-auto"), "abc123|manual-auto");
saveCheckedVideoLedger(ledger, ledgerPath);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(ledgerPath, "utf8")), {
  version: 1,
  checks: {
    "abc123|manual-auto": "no-manual",
    "abc123|auto-auto": "no-manual"
  }
});
const poisonedLedgerPath = path.join(directory, "poisoned-ledger.json");
fs.writeFileSync(poisonedLedgerPath, JSON.stringify({
  version: 1,
  checks: {
    "bad|manual-auto": "paired-saved",
    "bad|not-a-check": "no-manual",
    "good|manual-auto": "no-manual"
  }
}));
const filteredLedger = loadCheckedVideoLedger(poisonedLedgerPath);
assert.strictEqual(hasCheckedVideo(filteredLedger, "bad", "manual-auto"), false);
assert.strictEqual(hasCheckedVideo(filteredLedger, "good", "manual-auto"), true);
const reportsDirectory = path.join(directory, "reports");
fs.mkdirSync(reportsDirectory);
fs.writeFileSync(path.join(reportsDirectory, "old-report.json"), JSON.stringify({
  manualAutoOnly: true,
  channels: [{ items: [{ id: "old123", status: "no-manual" }] }]
}));
fs.writeFileSync(path.join(reportsDirectory, "bad-report.json"), "null");
assert.strictEqual(importCheckedVideoReports(ledger, reportsDirectory, ""), true);
assert.strictEqual(hasCheckedVideo(ledger, "old123", "manual-auto"), true);
const censored = path.join(directory, "censored.json3");
const uncensored = path.join(directory, "uncensored.json3");
fs.writeFileSync(censored, JSON.stringify({ events: [{
  tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "a [__] caption" }]
}] }));
fs.writeFileSync(uncensored, JSON.stringify({ events: [{
  tStartMs: 1100, dDurationMs: 500, segs: [{ utf8: "a bitchy caption" }]
}] }));
assert.strictEqual(hasTimedGroundTruth(censored, uncensored), true);
assert.strictEqual(hasTimedGroundTruth(censored, uncensored, true), false);
fs.writeFileSync(uncensored, JSON.stringify({ events: [{
  tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "a bitchy caption" }]
}] }));
assert.strictEqual(hasTimedGroundTruth(censored, uncensored, true), true);
fs.writeFileSync(uncensored, JSON.stringify({ events: [{
  tStartMs: 5000, dDurationMs: 500, segs: [{ utf8: "a bitchy caption" }]
}] }));
assert.strictEqual(hasTimedGroundTruth(censored, uncensored), false);
fs.writeFileSync(uncensored, JSON.stringify({ events: [{
  tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "a futureword caption" }]
}] }));
assert.strictEqual(hasTimedGroundTruth(censored, uncensored), true);
assert.strictEqual(hasTimedGroundTruth(censored, uncensored, true), false);

assert.deepStrictEqual(classifyPairKind("creator-manual"), {
  pairClass: "manual-auto",
  censoredKind: "auto-censored",
  uncensoredKind: "manual"
});
assert.deepStrictEqual(classifyPairKind("auto-en-en"), {
  pairClass: "auto-auto",
  censoredKind: "auto-censored",
  uncensoredKind: "auto-uncensored"
});
assert.deepStrictEqual(classifyPairKind("synthetic-auto"), {
  pairClass: "synthetic",
  censoredKind: "synthetic-censored",
  uncensoredKind: "auto-uncensored"
});
assert.deepStrictEqual(summarizePairItems([
  { status: "paired-saved", pairKind: "creator-manual" },
  { status: "paired-saved", pairKind: "auto-en" },
  { status: "paired-saved", pairKind: "synthetic-auto" },
  { status: "no-usable-gt", pairKind: "creator-manual" }
]), { manualAuto: 1, autoAuto: 1, synthetic: 1 });
fs.rmSync(directory, { recursive: true, force: true });
console.log("download-paired-captions.test.js passed");
