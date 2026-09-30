const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  acquireReportLock,
  checkedVideoKey,
  checkedVideoType,
  classifyPairKind,
  downloadCaption,
  hasCheckedVideo,
  hasSwears,
  hasTimedGroundTruth,
  inspectExistingPair,
  importCheckedVideoReports,
  isCanonicalChannelId,
  listEntries,
  loadCheckedVideoLedger,
  parseArgs,
  prospectiveTargetStatus,
  recordCheckedVideo,
  runYtDlp,
  saveCheckedVideoLedger,
  summarizePairItems,
  transientFailure,
  allConfiguredChannelsComplete,
  synthesizeCensoredCaption,
  validateChannelConfig,
  verifyProspectiveChannelId,
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
const targetedConfig = validateChannelConfig(require(
  "../tools/caption-growth-manual-targeted-20260828.json"
));
assert.strictEqual(targetedConfig.target, "manual-auto");
assert.deepStrictEqual(targetedConfig.targetContexts, [
  "oh [fuck|shit] that",
  "cool as [fuck|shit]"
]);
assert.strictEqual(targetedConfig.channels.length, 6);
const queryConfig = validateChannelConfig(require(
  "../tools/caption-growth-manual-context-queries.json"
));
assert.strictEqual(queryConfig.captionOnly, true);
assert.strictEqual(queryConfig.channels.length, 11);
const searchLanes = queryConfig.channels.filter((channel) => channel.name === "they-love" ||
  channel.name === "copula-gerund-him" || channel.name === "would-i" ||
  channel.name === "keep-contexts" || channel.name === "ambiguous-fuck-shit");
assert.strictEqual(searchLanes.length, 5);
assert.ok(searchLanes.every((channel) =>
  channel.sources.every((source) => source.startsWith("ytsearch5:"))));
assert.ok(queryConfig.channels.every((channel) => channel.targetContext));

const autoProspects = require("../tools/caption-prospects-uncensored-auto.json");
assert.strictEqual(autoProspects.prospective, true);
assert.strictEqual(autoProspects.entries.length, 40);
assert.strictEqual(new Set(autoProspects.entries.map((entry) => entry.channelId)).size, autoProspects.entries.length);
assert.ok(autoProspects.entries.every((entry) => entry.evidenceVideos.length && entry.observedSwears.length &&
  entry.evidenceVideos.some((video) => video.captionObservations.some((observation) => observation.observedForms.length))));
const manualProspects = require("../tools/caption-prospects-manual.json");
assert.ok(manualProspects.channels.length >= 2);
assert.strictEqual(new Set(manualProspects.channels.map((channel) => channel.channelId)).size, manualProspects.channels.length);
assert.ok(manualProspects.channels.every((channel) => channel.manualTrackObserved &&
  channel.manualTrackEvidence.videoId && channel.swearEvidence.observedForms.length));

const heldoutConfig = validateChannelConfig(require(
  "../tools/caption-growth-heldout-test-manual-pilot.json"
));
assert.strictEqual(heldoutConfig.prospective, true);
assert.strictEqual(heldoutConfig.minimumCreators, 3);
assert.strictEqual(heldoutConfig.minimumSlots, 30);
assert.ok(heldoutConfig.channels.every((channel) => isCanonicalChannelId(channel.channelId)));
const duplicateConfig = JSON.parse(JSON.stringify(heldoutConfig));
duplicateConfig.channels[1].name = duplicateConfig.channels[0].name;
assert.throws(() => validateChannelConfig(duplicateConfig), /Duplicate configured channel name/u);
const duplicateIdConfig = JSON.parse(JSON.stringify(heldoutConfig));
duplicateIdConfig.channels[1].channelId = duplicateIdConfig.channels[0].channelId;
assert.throws(() => validateChannelConfig(duplicateIdConfig), /Duplicate configured channelId/u);
const missingIdConfig = JSON.parse(JSON.stringify(heldoutConfig));
delete missingIdConfig.channels[0].channelId;
assert.throws(() => validateChannelConfig(missingIdConfig), /canonical channelId/u);
const searchConfig = JSON.parse(JSON.stringify(heldoutConfig));
searchConfig.searchChannels = ["ambiguous search"];
assert.throws(() => validateChannelConfig(searchConfig), /ambiguous/u);
const searchOnlyConfig = validateChannelConfig({ searchChannels: ["Loose Discovery Name"] });
assert.deepStrictEqual(searchOnlyConfig.channels, []);
assert.deepStrictEqual(searchOnlyConfig.searchChannels, ["Loose Discovery Name"]);
const expectedChannelId = heldoutConfig.channels[0].channelId;
assert.deepStrictEqual(verifyProspectiveChannelId(expectedChannelId, expectedChannelId), {
  valid: true, status: "", observedChannelId: expectedChannelId
});
assert.strictEqual(
  verifyProspectiveChannelId("UC0000000000000000000000", expectedChannelId).status,
  "channel-id-mismatch"
);
assert.strictEqual(verifyProspectiveChannelId("", expectedChannelId).status, "channel-id-unverified");
assert.deepStrictEqual(prospectiveTargetStatus([
  {
    channelId: expectedChannelId,
    items: [{ status: "paired-saved", pairClass: "manual-auto", creatorId: expectedChannelId, slots: 2 }]
  },
  {
    channelId: heldoutConfig.channels[1].channelId,
    items: [{ status: "paired-saved", pairClass: "manual-auto", creatorId: "UC0000000000000000000000", slots: 20 }]
  }
], 2, 4), {
  valid: false,
  contributingCreators: 1,
  slots: 2,
  minimumCreators: 2,
  minimumSlots: 4
});

assert.deepStrictEqual(
  require("../tools/download-paired-captions").distributedSample(
    Array.from({ length: 10 }, (_, index) => index), 4
  ),
  [0, 3, 6, 9]
);
assert.throws(() => parseArgs(["--synthetic-auto-only", "true", "--auto-auto-only", "true"]), /mutually exclusive/u);
assert.deepStrictEqual(
  (({ requestSleep, maxGlobal429, socketTimeout, childTimeout }) =>
    ({ requestSleep, maxGlobal429, socketTimeout, childTimeout }))(
    parseArgs(["--request-sleep", "7", "--max-global-429", "3", "--socket-timeout", "45",
      "--child-timeout", "90"])
  ),
  { requestSleep: 7, maxGlobal429: 3, socketTimeout: 45, childTimeout: 90 }
);
assert.throws(() => parseArgs(["--request-sleep", "-1"]), /positive/u);
assert.throws(() => parseArgs(["--socket-timeout", "0"]), /positive/u);
assert.throws(() => parseArgs(["--child-timeout", "0"]), /positive/u);
assert.strictEqual(transientFailure({ status: 1, stdout: "", stderr: "socket timeout" }), true);
assert.strictEqual(transientFailure({ status: 1, stdout: "", stderr: "HTTP Error 500" }), true);
for (const message of [
  "No route to host", "Temporary failure in name resolution", "Could not resolve host",
  "TLS handshake failed", "SSL certificate verify failed"
]) {
  assert.strictEqual(transientFailure({ status: 1, stdout: "", stderr: message }), true, message);
}
assert.strictEqual(transientFailure({ status: 1, stdout: "", stderr: "invalid subtitle language" }), false);
assert.strictEqual(allConfiguredChannelsComplete(
  [{ name: "one" }, { name: "two" }],
  [{ name: "one", queueComplete: true }]
), false);
assert.strictEqual(allConfiguredChannelsComplete(
  [{ name: "one" }, { name: "two" }],
  [{ name: "one", queueComplete: true }, { name: "two", queueComplete: true }]
), true);
assert.strictEqual(allConfiguredChannelsComplete(
  [{ name: "one" }], [{ name: "one", complete: true }]
), false);
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
fs.writeFileSync(`${atomicReport}.lock`, "999999999");
const releaseRecoveredLock = acquireReportLock(atomicReport);
assert.strictEqual(fs.existsSync(`${atomicReport}.lock`), true);
releaseRecoveredLock();
const videoLockPath = path.join(directory, "abc123def45.video");
const releaseVideo = acquireReportLock(videoLockPath);
assert.throws(() => acquireReportLock(videoLockPath), /already being written/u);
releaseVideo();
assert.strictEqual(fs.existsSync(`${videoLockPath}.lock`), false);
const ledgerPath = path.join(directory, "checked-video-ledger.json");
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
assert.strictEqual(hasTimedGroundTruth(censored, uncensored), false);
assert.strictEqual(hasTimedGroundTruth(censored, uncensored, true), false);

const fixtureDirectoryForAudit = path.join(__dirname, "..", "test-fixtures");
fs.mkdirSync(fixtureDirectoryForAudit, { recursive: true }); // absent in a fresh (public) checkout
const auditVideoId = "zzzzzzzzzzy";
const auditAutoPath = path.join(fixtureDirectoryForAudit, `${auditVideoId}_auto.en.json3`);
const auditManualPath = path.join(fixtureDirectoryForAudit, `${auditVideoId}_manual.en.json3`);
try {
  fs.writeFileSync(auditAutoPath, JSON.stringify({ events: [{
    tStartMs: 100, dDurationMs: 500, segs: [{ utf8: "a [__] caption" }]
  }] }));
  assert.deepStrictEqual(inspectExistingPair(auditVideoId), {
    pairValidation: "incomplete", pairKind: "", pairClass: ""
  });
  fs.writeFileSync(auditManualPath, JSON.stringify({ events: [{
    tStartMs: 100, dDurationMs: 500, segs: [{ utf8: "a bitchy caption" }]
  }] }));
  const auditedPair = inspectExistingPair(auditVideoId);
  assert.strictEqual(auditedPair.pairValidation, "valid-unclassified");
  assert.strictEqual(auditedPair.pairKind, "");
  assert.strictEqual(auditedPair.pairClass, "");
  assert.strictEqual(auditedPair.provenance, "unknown-without-paired-saved-report");
  fs.writeFileSync(auditManualPath, "{}");
  assert.strictEqual(inspectExistingPair(auditVideoId).pairValidation, "unverified");
} finally {
  fs.rmSync(auditAutoPath, { force: true });
  fs.rmSync(auditManualPath, { force: true });
}

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
(async () => {
  const fixtureDirectory = path.join(__dirname, "..", "test-fixtures");
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  const languageVideoId = "zzzzzzzzzzz";
  const wrongLanguage = path.join(fixtureDirectory, `${languageVideoId}_manual.es.json3`);
  const requestedLanguage = path.join(fixtureDirectory, `${languageVideoId}_manual.en.json3`);
  try {
    const rejected = await downloadCaption(
      "https://example.test/watch?v=zzzzzzzzzzz", languageVideoId, "manual", "en",
      async () => {
        fs.writeFileSync(wrongLanguage, "{}");
        return { status: 0, stdout: "", stderr: "" };
      }
    );
    assert.strictEqual(rejected, "");
    assert.strictEqual(fs.existsSync(requestedLanguage), false);

    fs.writeFileSync(requestedLanguage, "{}");
    const accepted = await downloadCaption(
      "https://example.test/watch?v=zzzzzzzzzzz", languageVideoId, "manual", "en",
      async () => ({ status: 0, stdout: "", stderr: "" })
    );
    assert.strictEqual(accepted, requestedLanguage);
  } finally {
    fs.rmSync(wrongLanguage, { force: true });
    fs.rmSync(requestedLanguage, { force: true });
  }

  const partial = await listEntries("https://example.test/videos", 3, async () => ({
    status: 1,
    stdout: "abc123\tPartial video\tCreator\tNA\thttps://example.test/watch?v=abc123\n",
    stderr: "No route to host"
  }));
  assert.strictEqual(partial.entries.length, 1);
  assert.match(partial.error, /No route to host/u);
  const tabRow = "abc123\tVideo\tNA\tNA\thttps://example.test/watch?v=abc123\tUCzS3-65Y91JhOxFiM7j6grg\n";
  const tab = await listEntries("https://www.youtube.com/channel/UCzS3-65Y91JhOxFiM7j6grg/videos", 1,
    async () => ({ status: 0, stdout: tabRow, stderr: "" }));
  assert.strictEqual(tab.entries[0].channelId, "UCzS3-65Y91JhOxFiM7j6grg");
  const playlist = await listEntries("https://www.youtube.com/playlist?list=PLx", 1,
    async () => ({ status: 0, stdout: tabRow, stderr: "" }));
  assert.strictEqual(playlist.entries[0].channelId, "");

  let hangingChild;
  let spawnedArgs;
  const hangingSpawn = (_command, args) => {
    spawnedArgs = args;
    hangingChild = new EventEmitter();
    hangingChild.stdout = new EventEmitter();
    hangingChild.stderr = new EventEmitter();
    hangingChild.kill = (signal) => { hangingChild.killed = signal; return true; };
    return hangingChild;
  };
  const watchdogResult = await runYtDlp([], { spawn: hangingSpawn, watchdogMs: 5 });
  assert.strictEqual(watchdogResult.status, 124);
  assert.strictEqual(watchdogResult.timedOut, true);
  assert.strictEqual(spawnedArgs[0], "--ignore-config");
  assert.strictEqual(hangingChild.killed, "SIGKILL");
  assert.match(watchdogResult.stderr, /child watchdog timed out/u);
  console.log("download-paired-captions.test.js passed");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
