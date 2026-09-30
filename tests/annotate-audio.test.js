"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const annotation = require("../tools/annotate-audio");
const { ALLOWED_WORDS } = require("../src/rules");

assert.ok(!annotation.html.includes("Caption/audio do not match (M)"));
assert.ok(annotation.html.includes("Target caption") && annotation.html.includes("Surrounding captions") &&
  annotation.html.includes("Surrounding text is not expected in the 4s clip."));
assert.ok(annotation.html.includes("item.context.replace('[__]','['+caption+']')") &&
  annotation.html.includes("$('surrounding').textContent=item.reviewContext||''"));
assert.ok(annotation.html.includes("e.key==='Enter'&&e.target.value.trim()") &&
  annotation.html.includes("$('genuine').click()"));
assert.ok(!annotation.html.includes("e.key.toLowerCase()==='m'&&state.mode==='false-fills'"));
assert.ok(annotation.html.includes("Wrong audio fragment (W)") &&
  annotation.html.includes("falseLabel('alignment-mismatch')") &&
  annotation.html.includes("e.key.toLowerCase()==='w'&&state.mode==='false-fills'") &&
  annotation.html.includes("e.key==='/'&&!state.items[index]?.captionGroup") &&
  annotation.html.includes("e.key==='Escape'") &&
  annotation.html.includes("e.key.toLowerCase()==='s'&&state.mode==='false-fills'") &&
  annotation.html.includes("e.key.toLowerCase()==='n'&&state.mode==='false-fills'") &&
  annotation.html.includes("if(e.key===' ') {e.preventDefault();play()}"));

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-annotations-"));
fs.writeFileSync(path.join(directory, "video.m4a"), "audio");
const reportPath = path.join(directory, "rules.json");
const report = { mode: "rules-only", complete: true, fixtures: [],
  ...require("../tools/evaluation-metrics").currentFingerprints() };
fs.writeFileSync(reportPath, JSON.stringify(report));
assert.deepStrictEqual(annotation.readReport(reportPath, "rules-only").report, report);
fs.writeFileSync(reportPath, JSON.stringify({ ...report, rulesFingerprint: "old" }));
assert.throws(() => annotation.readReport(reportPath, "rules-only"), /stale for rulesFingerprint/);
const archivedHash = require("crypto").createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex");
assert.deepStrictEqual(annotation.readReport(reportPath, "rules-only", archivedHash).report.rulesFingerprint, "old");
assert.throws(() => annotation.readReport(reportPath, "rules-only", "0".repeat(64)), /stale for rulesFingerprint/);

function result(tokenIndex, word, extra = {}) {
  return {
    tokenIndex,
    timeSeconds: 10 + tokenIndex,
    context: `context ${tokenIndex} [__]`,
    reviewContext: `review ${tokenIndex} [__]`,
    word,
    candidates: word ? [word] : [],
    expected: ["shit"],
    correct: word === "shit",
    classification: word === "shit" ? "correct-exact" : "missed",
    ...extra
  };
}

function source(mode, results) {
  return { report: { mode, complete: true, fixtures: [{ name: "video", audio: "/stale/video.webm", results }] } };
}

const rules = source("rules-only", [result(0, "fuck"), result(1, "shit"), result(2, "shit"), result(3, "", { classification: "unscored" })]);
const whisper = source("whisper-only", [
  result(0, "shit"),
  result(1, ""),
  result(2, "shit"),
  result(3, "", { classification: "unscored" })
]);

assert.strictEqual(annotation.categoryFor(rules.report.fixtures[0].results[0],
  whisper.report.fixtures[0].results[0]), "disagreement");
assert.strictEqual(annotation.categoryFor(rules.report.fixtures[0].results[1],
  whisper.report.fixtures[0].results[1]), "rules-only");
assert.strictEqual(annotation.categoryFor(rules.report.fixtures[0].results[2],
  whisper.report.fixtures[0].results[2]), "agreement");
const priorLabels = path.join(directory, "false-fills.json");
fs.writeFileSync(priorLabels, JSON.stringify({ mode: "false-fills", items: [{ id: "video:1",
  fixture: "video", annotation: { status: "uncertain" } }] }));
const triage = annotation.buildQueue({ mode: "triage", rules, whisper, falseFillReport: priorLabels,
  audioDir: directory, before: 1, after: 2 });
assert.deepStrictEqual(triage.items.map((item) => item.id), ["video:0", "video:3"]);
assert.ok(!triage.items.some((item) => item.category === "agreement"));
const limitedTriage = annotation.buildQueue({ mode: "triage", rules, whisper,
  audioDir: directory, before: 1, after: 2, limit: 1 });
assert.deepStrictEqual(limitedTriage.items.map((item) => item.id), ["video:0"]);
const reservedTriage = annotation.buildQueue({ mode: "triage", rules, whisper,
  audioDir: directory, before: 1, after: 2, limit: 2, bothEmptyLimit: 1 });
assert.deepStrictEqual(reservedTriage.items.map((item) => item.id), ["video:0", "video:3"]);

const deepgramPath = path.join(directory, "deepgram-triage.json");
fs.writeFileSync(deepgramPath, JSON.stringify({ evidenceStatus: "diagnostic-only; no automatic truth claims",
  provider: "Deepgram", reportFingerprint: archivedHash, items: { one: { status: "complete", fixture: "video", tokenIndex: 0,
    timeSeconds: 10, deepgramTranscript: "unverified transcript" } } }));
const deepgramTriage = annotation.readDeepgramTriage(deepgramPath);
const disagreements = annotation.buildQueue({ mode: "disagreements", rules, whisper, deepgramTriage,
  audioDir: directory, before: 1, after: 2 });
assert.strictEqual(disagreements.items.length, 1);
assert.strictEqual(disagreements.items[0].id, "video:0");
assert.strictEqual(disagreements.items[0].clipStart, 9);
assert.strictEqual(disagreements.items[0].clipEnd, 12);
assert.ok(!Object.prototype.hasOwnProperty.call(disagreements.items[0].whisper, "expected"));
assert.strictEqual(disagreements.items[0].deepgramTranscript, "unverified transcript");
const deepgramReview = annotation.buildQueue({ mode: "deepgram-review", rules: null, whisper,
  deepgramTriage, audioDir: directory, before: 1, after: 2 });
assert.deepStrictEqual(deepgramReview.items.map(item => item.id), ["video:0"]);
assert.ok(!Object.prototype.hasOwnProperty.call(deepgramReview.items[0].whisper, "expected"));
assert.ok(annotation.html.includes("Show ASR transcripts after listening") &&
  annotation.html.includes("$('predicted').hidden=state.mode==='deepgram-review'"));
assert.ok(annotation.html.includes("item.timeSeconds-1") &&
  annotation.html.includes("$('wide').onclick=()=>play(true)"));
assert.strictEqual(disagreements.items[0].rules.word, "fuck");
const untrustedPath = path.join(directory, "untrusted.json");
fs.writeFileSync(untrustedPath, JSON.stringify({ provider: "Deepgram", items: {} }));
assert.throws(() => annotation.readDeepgramTriage(untrustedPath), /diagnostic-only/u);

const misses = annotation.buildQueue({ mode: "whisper-misses", rules, whisper,
  audioDir: directory, before: 1.5, after: 2.5 });
assert.deepStrictEqual(misses.items.map((item) => item.id), ["video:1"]);
const golden = annotation.buildQueue({ mode: "golden", rules: null, whisper,
  audioDir: directory, before: 1.5, after: 2.5, limit: 2 });
assert.strictEqual(golden.items.length, 2);
const allGolden = annotation.buildQueue({ mode: "golden", rules, whisper,
  audioDir: directory, before: 1.5, after: 2.5 });
const priorQueue = path.join(directory, "prior-queue.json");
fs.writeFileSync(priorQueue, JSON.stringify({ mode: "golden", items: [
  { ...allGolden.items.find((item) => item.id === "video:0"), annotation: { status: "wrong-audio-fragment", word: null, note: "bad fragment" } },
  { ...allGolden.items.find((item) => item.id === "video:1"), annotation: { status: "swear", word: "shit", note: "keep this" } }
] }));
const historyGolden = annotation.buildQueue({ mode: "golden", rules, whisper,
  annotationReports: [priorQueue], audioDir: directory, before: 1.5, after: 2.5 });
assert.deepStrictEqual(new Set(historyGolden.items.map((item) => item.id)), new Set(["video:1", "video:2", "video:3"]));
assert.deepStrictEqual(historyGolden.items.find((item) => item.id === "video:1").annotation,
  { status: "swear", word: "shit", note: "keep this" });
const falseFills = annotation.buildQueue({ mode: "false-fills", rules, whisper: null,
  audioDir: directory, before: 1, after: 1, limit: 2 });
assert.strictEqual(falseFills.items.length, 2);
const roundRobinRules = source("rules-only", [result(0, "shit"), result(1, "shit"), result(2, "fuck")]);
const allFalseFills = annotation.buildQueue({ mode: "false-fills", rules: roundRobinRules, whisper: null,
  audioDir: directory, before: 1, after: 1, limit: 0 });
assert.deepStrictEqual(allFalseFills.items.map((item) => item.id), ["video:2", "video:0", "video:1"]);
assert.strictEqual(falseFills.selection.priority, "P0");
assert.strictEqual(falseFills.selection.strategy, "bounded-round-robin-by-word-tier-fixture-rule");
assert.strictEqual(falseFills.selection.coverage.selectedRows, 2);
assert.ok(falseFills.selection.coverage.dimensions.wordTier.coverage > 0);
assert.ok(falseFills.items.every((item) => item.category === "false-fill" && item.stratum));
assert.ok(falseFills.items.every((item) => !Object.prototype.hasOwnProperty.call(item.rules, "expected")));
assert.ok(falseFills.items.every((item) => item.whisper === null));
assert.ok(falseFills.items.every((item) => item.audioSha256 && item.audioVersion));

const ambiguousDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-ambiguous-audio-"));
fs.writeFileSync(path.join(ambiguousDirectory, "video_a.m4a"), "a");
fs.writeFileSync(path.join(ambiguousDirectory, "video_b.m4a"), "b");
const ambiguous = annotation.buildQueue({ mode: "false-fills", rules, whisper: null,
  audioDir: ambiguousDirectory, before: 1, after: 1 });
assert.strictEqual(ambiguous.items.length, 0);
assert.strictEqual(ambiguous.missingAudio, 3);
fs.rmSync(ambiguousDirectory, { recursive: true, force: true });

assert.deepStrictEqual(annotation.validateAnnotation({ status: "swear", word: ALLOWED_WORDS[0], note: "" }),
  { status: "swear", word: ALLOWED_WORDS[0], note: "" });
assert.deepStrictEqual(annotation.validateAnnotation({ status: "no-swear-in-audio", word: null, note: "late" }),
  { status: "no-swear-in-audio", word: null, note: "late" });
assert.deepStrictEqual(annotation.validateAnnotation({ status: "wrong-audio-fragment", word: null, note: "mismatch" }),
  { status: "wrong-audio-fragment", word: null, note: "mismatch" });
assert.deepStrictEqual(annotation.validateAnnotation({ status: "not-english", word: null, note: "", widePlayed: true }),
  { status: "not-english", word: null, note: "", widePlayed: true });
assert.deepStrictEqual(annotation.validateAnnotation({ status: "swear", word: ALLOWED_WORDS[0], note: "",
  ruleRecommendation: { kind: "precise", rule: null } }),
{ status: "swear", word: ALLOWED_WORDS[0], note: "", ruleRecommendation: { kind: "precise", rule: null } });
assert.deepStrictEqual(annotation.validateAnnotation({ status: "swear", word: ALLOWED_WORDS[0], note: "",
  ruleRecommendation: { kind: "manual", rule: "  before [__] after  " } }).ruleRecommendation,
{ kind: "manual", rule: "before [__] after" });
assert.deepStrictEqual(annotation.validateAnnotation({ status: "swear", word: ALLOWED_WORDS[0], note: "", ruleIdea: true }).ruleRecommendation,
  { kind: "general", rule: null });
assert.throws(() => annotation.validateAnnotation({ status: "not-english", word: null, note: "",
  ruleRecommendation: { kind: "general", rule: null } }), /Only swear labels/u);
assert.throws(() => annotation.validateAnnotation({ status: "swear", word: ALLOWED_WORDS[0], note: "",
  ruleRecommendation: { kind: "manual", rule: "" } }), /1–500/u);
assert.throws(() => annotation.validateAnnotation({ status: "not-english", word: null, note: "", widePlayed: "yes" }),
  /wide-playback/u);
assert.deepStrictEqual(annotation.validateAnnotation({ status: "skipped", word: null, note: "" }),
  { status: "skipped", word: null, note: "" });
assert.throws(() => annotation.validateAnnotation({ status: "swear", word: "not-in-vocabulary", note: "" }),
  /supported swear/u);
assert.throws(() => annotation.validateAnnotation({ status: "no-swear-in-audio", word: "shit", note: "" }),
  /Only swear/u);
const falseLabel = { status: "ordinary-word", word: null, spokenWord: "shifts", confidence: "high",
  timingOffsetSeconds: -0.18, note: "clear" };
assert.deepStrictEqual(annotation.validateAnnotation(falseLabel), falseLabel);
assert.strictEqual(falseFills.items[0].annotation.confidence, "high");
const legacyFalseLabel = { status: "ordinary-word", word: null, spokenWord: "shifts", confidence: "high",
  timingOffsetSeconds: 0, slotCorrespondence: "same-slot", note: "" };
assert.deepStrictEqual(annotation.validateAnnotation(legacyFalseLabel), { status: "ordinary-word", word: null,
  spokenWord: "shifts", confidence: "high", timingOffsetSeconds: 0, note: "" });
assert.throws(() => annotation.validateAnnotation({ ...falseLabel, spokenWord: null }), /exact spoken/u);
assert.throws(() => annotation.validateAnnotation({ ...falseLabel, confidence: "certain" }), /confidence/u);
assert.throws(() => annotation.validateAnnotation({ ...falseLabel, status: "genuine-profanity", spokenWord: null }), /exact spoken/u);
assert.throws(() => annotation.validateAnnotation({ ...falseLabel, expected: ["shit"] }), /ground truth/u);
assert.throws(() => annotation.applyAnnotation({ mode: "false-fills", items: [] },
  { annotation: { status: "pending" } }, { status: "swear", word: ALLOWED_WORDS[0], note: "" }), /false-fill disposition/u);

const languageItems = [
  { id: "a:0", fixture: "a", annotation: { status: "pending" } },
  { id: "a:1", fixture: "a", annotation: { status: "pending" } },
  { id: "a:2", fixture: "a", annotation: { status: "swear", word: ALLOWED_WORDS[0], note: "" } },
  { id: "b:0", fixture: "b", annotation: { status: "pending" } }
];
const languageChanges = annotation.applyAnnotation({ items: languageItems }, languageItems[0],
  { status: "not-english", word: null, note: "" });
assert.deepStrictEqual(languageChanges.map((change) => change.id), ["a:0", "a:1"]);
assert.strictEqual(languageItems[1].annotation.status, "not-english");
assert.strictEqual(languageItems[2].annotation.status, "swear");
assert.strictEqual(languageItems[3].annotation.status, "pending");

const saved = path.join(directory, "saved.json");
const resumable = { schemaVersion: 1, mode: "disagreements", clip: { before: 1, after: 2 },
  statusSet: annotation.statusSetFor("disagreements"), sources: { rules: "a", whisper: "b" }, items: disagreements.items };
fs.writeFileSync(saved, JSON.stringify({ ...resumable, items: [{ ...disagreements.items[0],
  annotation: { status: "swear", word: ALLOWED_WORDS[0], note: "certain" } }] }));
annotation.resume(resumable, saved);
assert.strictEqual(resumable.items[0].annotation.status, "swear");
assert.throws(() => annotation.resume({ ...resumable, mode: "golden" }, saved), /different mode/u);
fs.writeFileSync(saved, JSON.stringify({ ...resumable, items: [{ ...disagreements.items[0],
  audioSha256: "changed", annotation: { status: "pending", word: null, note: "" } }] }));
assert.throws(() => annotation.resume(resumable, saved), /audio identity/u);
const statusMismatch = { ...resumable, statusSet: ["pending"] };
assert.throws(() => annotation.resume(statusMismatch, saved), /different statusSet/u);
const exposed = annotation.publicState({ schemaVersion: 1, mode: "test", missingAudio: 0,
  items: disagreements.items });
assert.strictEqual(exposed.items[0].audioFile, undefined);
assert.strictEqual(exposed.frequencies[ALLOWED_WORDS[0]], 1);

const missing = annotation.buildQueue({ mode: "golden", rules: source("rules-only", [result(0, "shit")]),
  whisper: null, audioDir: path.join(directory, "missing"), before: 1, after: 1 });
assert.strictEqual(missing.items.length, 0);
assert.strictEqual(missing.missingAudio, 1);
assert.throws(() => annotation.buildQueue({ mode: "golden",
  rules: source("rules-only", [result(0, "shit", { timeSeconds: NaN })]), whisper: null,
  audioDir: directory, before: 1, after: 1 }), /Invalid slot/u);

// Range/seek requests share a verified content hash, never a stat-only
// assumption. Same-size, backdated edits and file replacement invalidate it.
const cachedAudio = path.join(directory, "cached.webm");
fs.writeFileSync(cachedAudio, "audio-one");
const audioItem = { audioFile: cachedAudio };
const audioCache = new Map();
const initialAudio = annotation.verifiedAudio(audioItem, audioCache);
const audioStat = fs.statSync(cachedAudio);
let audioReads = 0;
const nativeAudioRead = fs.readFileSync;
try {
  fs.readFileSync = (file, ...args) => {
    if (file === cachedAudio) audioReads++;
    return nativeAudioRead(file, ...args);
  };
  assert.strictEqual(annotation.verifiedAudio(audioItem, audioCache).actualSha256, initialAudio.actualSha256);
  assert.strictEqual(audioReads, 0);
  fs.writeFileSync(cachedAudio, "audio-two");
  fs.utimesSync(cachedAudio, audioStat.atime, audioStat.mtime);
  assert.notStrictEqual(annotation.verifiedAudio(audioItem, audioCache).actualSha256, initialAudio.actualSha256);
  assert.strictEqual(audioReads, 1);
  fs.writeFileSync(`${cachedAudio}.new`, "audio-one");
  fs.utimesSync(`${cachedAudio}.new`, audioStat.atime, audioStat.mtime);
  fs.renameSync(`${cachedAudio}.new`, cachedAudio);
  assert.strictEqual(annotation.verifiedAudio(audioItem, audioCache).actualSha256, initialAudio.actualSha256);
  assert.strictEqual(audioReads, 2);
} finally { fs.readFileSync = nativeAudioRead; }
const nativeAudioStat = fs.statSync;
let statCalls = 0;
try {
  fs.statSync = (file, ...args) => {
    const stat = nativeAudioStat(file, ...args);
    if (file === cachedAudio && ++statCalls === 2) stat.ctimeMs++;
    return stat;
  };
  const changingCache = new Map();
  assert.throws(() => annotation.verifiedAudio(audioItem, changingCache), /changed while/u);
  assert.strictEqual(changingCache.size, 0);
} finally { fs.statSync = nativeAudioStat; }

const groupDir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-groups-"));
const payload = { events: [
  { tStartMs: 10000, dDurationMs: 2000, segs: [{ utf8: "… [__] then [__] and [__]", tOffsetMs: 0 }] },
  { tStartMs: 20000, dDurationMs: 1000, segs: [{ utf8: "[__]", tOffsetMs: 0 }] }
] };
fs.writeFileSync(path.join(groupDir, "video_auto.en.json3"), JSON.stringify(payload));
const parsed = require("../src/timedtext").collectTimedTextData(JSON.stringify(payload), false);
assert.strictEqual(annotation.parseArgs(["--group-captions", "false"]).groupCaptions, false);
assert.strictEqual(annotation.parseArgs([]).groupCaptions, true);
assert.strictEqual(annotation.parseArgs(["--prior-labels", "tmp/reviewed.json"]).priorLabels, "tmp/reviewed.json");
const sourceSlots = parsed.tokens.map((token) => result(token.tokenIndex, "shit", { timeSeconds: token.timeSeconds }));
const groupOptions = { mode: "deepgram-review", rules: null, whisper: source("whisper-only", sourceSlots),
  deepgramTriage: { items: new Map([["video:1", { timeSeconds: parsed.tokens[1].timeSeconds,
    transcript: "diagnostic only", rank: 0 }]]) },
  audioDir: directory, groupSourceDirectory: groupDir, before: 4, after: 7, limit: 1 };
const groupQueue = annotation.buildQueue(groupOptions);
const unrelatedAudio = path.join(directory, "unrelated.m4a");
fs.writeFileSync(unrelatedAudio, "unrelated audio");
const extendedWhisper = { report: { ...groupOptions.whisper.report,
  fixtures: [...groupOptions.whisper.report.fixtures, { name: "unrelated", audio: unrelatedAudio, results: [result(0, "shit")] }] } };
let audioListings = 0;
const listAudio = fs.readdirSync, readAudioFile = fs.readFileSync;
try {
  fs.readdirSync = (dir, ...args) => { if (dir === directory) audioListings++; return listAudio(dir, ...args); };
  fs.readFileSync = (file, ...args) => {
    assert.notStrictEqual(file, unrelatedAudio, "a triage queue must not hash unrelated recordings");
    return readAudioFile(file, ...args);
  };
  assert.deepStrictEqual(annotation.buildQueue({ ...groupOptions, whisper: extendedWhisper }).items.map(item => item.id),
    groupQueue.items.map(item => item.id));
} finally { fs.readdirSync = listAudio; fs.readFileSync = readAudioFile; }
assert.strictEqual(audioListings, 1, "resolve each fixture audio path once, not once per slot");
assert.deepStrictEqual(groupQueue.items.map((item) => item.id), ["video:0", "video:1", "video:2"],
  "one Deepgram triage slot expands to all three source slots, not the unrelated fourth slot");
assert.deepStrictEqual(groupQueue.items.map((item) => item.captionGroup.expandedSelection), [true, false, true]);
assert.ok(groupQueue.items.every((item) => item.annotation.status === "pending"));
assert.deepStrictEqual(annotation.buildQueue({ ...groupOptions, groupCaptions: false }).items.map((item) => item.id), ["video:1"]);
const reviewed = { mode: "golden", items: [{ ...groupQueue.items[0],
  annotation: { status: "swear", word: "fuck", note: "human label", widePlayed: true } }] };
const historyGroup = annotation.buildQueue({ ...groupOptions, annotationReports: [reviewed] });
assert.deepStrictEqual(historyGroup.items[0].annotation, reviewed.items[0].annotation);
assert.strictEqual(historyGroup.items[1].annotation.status, "pending");
assert.strictEqual(historyGroup.items[2].annotation.status, "pending");
for (const changed of [{ timeSeconds: reviewed.items[0].timeSeconds + 0.2 }, { audioSha256: "changed" }, { audioFile: "different.m4a" }]) {
  const mismatch = annotation.buildQueue({ ...groupOptions,
    annotationReports: [{ ...reviewed, items: [{ ...reviewed.items[0], ...changed }] }] });
  assert.strictEqual(mismatch.items[0].annotation.status, "pending", "history requires the same timestamp and audio");
}
const filteredRules = source("rules-only", sourceSlots.map((row, i) => ({ ...row, word: i === 1 ? "fuck" : "shit" })));
const disagreementGroup = annotation.buildQueue({ ...groupOptions, mode: "disagreements", rules: filteredRules });
assert.deepStrictEqual(disagreementGroup.items.map((item) => item.id), ["video:0", "video:1", "video:2"],
  "category-ineligible agreement siblings remain reviewable");
const inconsistentRules = source("rules-only", filteredRules.report.fixtures[0].results.map((row, i) =>
  i === 2 ? { ...row, timeSeconds: row.timeSeconds + 1 } : row));
assert.deepStrictEqual(annotation.buildQueue({ ...groupOptions, mode: "disagreements", rules: inconsistentRules }).items.map(item => item.id),
  ["video:1"], "an inconsistent optional sibling falls back to selected single-slot review");
const malformedSibling = source("whisper-only", sourceSlots.map((row, i) => i === 2 ? { ...row, timeSeconds: NaN } : row));
assert.deepStrictEqual(annotation.buildQueue({ ...groupOptions, whisper: malformedSibling }).items.map(item => item.id), ["video:1"]);
const invalidSelected = source("whisper-only", sourceSlots.map((row, i) => i === 1 ? { ...row, timeSeconds: row.timeSeconds + 1 } : row));
assert.throws(() => annotation.buildQueue({ ...groupOptions, whisper: invalidSelected }), /triage timestamp/u);
const unionRules = source("rules-only", filteredRules.report.fixtures[0].results.filter((row) => row.tokenIndex !== 2));
const unionWhisper = source("whisper-only", sourceSlots.filter((row) => row.tokenIndex !== 0));
assert.deepStrictEqual(annotation.buildQueue({ ...groupOptions, mode: "disagreements", rules: unionRules,
  whisper: unionWhisper }).items.map((item) => item.id), ["video:0", "video:1", "video:2"],
  "siblings may be supplied by only one evaluator source");
const staleSibling = source("whisper-only", sourceSlots.map((row, i) => i === 2 ? { ...row, timeSeconds: row.timeSeconds + 1 } : row));
assert.deepStrictEqual(annotation.buildQueue({ ...groupOptions, whisper: staleSibling }).items.map((item) => item.id), ["video:1"],
  "every sibling timestamp is checked");
const groupResume = { schemaVersion: 1, mode: "deepgram-review", clip: { before: 4, after: 7 },
  statusSet: annotation.statusSetFor("deepgram-review"), sources: {}, items: historyGroup.items };
const groupSaved = path.join(directory, "group-saved.json");
fs.writeFileSync(groupSaved, JSON.stringify(groupResume));
assert.deepStrictEqual(annotation.resume({ ...groupResume, items: annotation.buildQueue(groupOptions).items }, groupSaved).items[0].annotation,
  reviewed.items[0].annotation);
const metadataChanged = annotation.buildQueue(groupOptions).items;
metadataChanged[0].captionGroup.slots = [0, 1];
assert.throws(() => annotation.resume({ ...groupResume, items: metadataChanged }, groupSaved), /caption identity/u);
const timestampChanged = annotation.buildQueue(groupOptions).items;
timestampChanged[0].timeSeconds += 0.2;
assert.throws(() => annotation.resume({ ...groupResume, items: timestampChanged }, groupSaved), /caption identity/u);
fs.writeFileSync(path.join(groupDir, "video_auto.en.json3"), JSON.stringify({ ...payload,
  events: payload.events.map((event, i) => i ? event : { ...event, segs: [{ utf8: "Changed [__] then [__] and [__]", tOffsetMs: 0 }] }) }));
assert.throws(() => annotation.resume({ ...groupResume, items: annotation.buildQueue(groupOptions).items }, groupSaved), /caption identity/u);
fs.writeFileSync(path.join(groupDir, "video_auto.en.json3"), "{malformed");
const malformedGroup = annotation.buildQueue(groupOptions);
assert.deepStrictEqual(malformedGroup.items.map((item) => item.id), ["video:1"]);
assert.strictEqual(malformedGroup.items[0].captionGroup, undefined);
fs.writeFileSync(path.join(groupDir, "video_auto.en.json3"), JSON.stringify(payload));
const makeSlot = (tokenIndex, timeSeconds) => ({ id: `video:${tokenIndex}`, fixture: "video", tokenIndex,
  timeSeconds, audioFile: "video.m4a", audioSha256: "same-audio",
  clipStart: Math.max(0, timeSeconds - 4), clipEnd: timeSeconds + 7,
  annotation: { status: "pending", word: null, note: "" } });
const rawSlots = parsed.tokens.slice(0, 3).map((token) => makeSlot(token.tokenIndex, token.timeSeconds));
const grouped = annotation.groupCaptionItems(rawSlots, [rawSlots[1]], true, groupDir);
assert.strictEqual(grouped.length, 3);
assert.deepStrictEqual(grouped.map((item) => item.tokenIndex), [0, 1, 2]);
assert.deepStrictEqual(grouped.map((item) => item.captionGroup.expandedSelection), [true, false, true]);
assert.strictEqual(grouped[0].captionGroup.text, "… [__] then [__] and [__]");
let sourceReads = 0;
const readFileSync = fs.readFileSync;
try {
  fs.readFileSync = function(file, ...args) {
    if (file === path.join(groupDir, "video_auto.en.json3")) sourceReads++;
    return readFileSync.call(this, file, ...args);
  };
  annotation.groupCaptionItems(rawSlots, rawSlots, true, groupDir);
} finally { fs.readFileSync = readFileSync; }
assert.strictEqual(sourceReads, 1, "caption source is read/parsed once per fixture");
for (const changed of [{ audioFile: "other.m4a" }, { audioSha256: "different" }, { timeSeconds: rawSlots[2].timeSeconds + 1 }]) {
  const badSlots = rawSlots.map((slot, i) => i === 2 ? { ...slot, ...changed } : slot);
  const fallback = annotation.groupCaptionItems(badSlots, [badSlots[1]], true, groupDir);
  assert.strictEqual(fallback.length, 1);
  assert.strictEqual(fallback[0].captionGroup, undefined);
}
assert.strictEqual(annotation.groupCaptionItems(rawSlots.slice(0, 2), [rawSlots[1]], true, groupDir).length, 1,
  "missing sibling safely falls back to one slot");
const twoPayload = { events: [{ tStartMs: 10000, dDurationMs: 2000,
  segs: [{ utf8: "[__] and [__]", tOffsetMs: 0 }] }] };
fs.writeFileSync(path.join(groupDir, "two_auto.en.json3"), JSON.stringify(twoPayload));
const twoParsed = require("../src/timedtext").collectTimedTextData(JSON.stringify(twoPayload), false);
const twoSlots = twoParsed.tokens.map((token) => ({ ...makeSlot(token.tokenIndex, token.timeSeconds),
  id: `two:${token.tokenIndex}`, fixture: "two" }));
assert.strictEqual(annotation.groupCaptionItems(twoSlots, [twoSlots[0]], true, groupDir).length, 2);
assert.strictEqual(new Set(grouped.map((item) => item.captionGroup.id)).size, 1);
assert.strictEqual(annotation.groupCaptionItems(rawSlots, [rawSlots[1]], false, groupDir).length, 1);
assert.strictEqual(annotation.groupCaptionItems(rawSlots, [makeSlot(1, 99)], true, groupDir).length, 1);
assert.strictEqual(annotation.groupCaptionItems([...rawSlots, makeSlot(3, parsed.tokens[3].timeSeconds)], rawSlots, true, groupDir).length, 3,
  "separate events remain separate");
const batchState = { mode: "golden", items: grouped.map((item) => ({ ...item,
  annotation: { status: "pending", word: null, note: "" } })) };
const batchLabels = grouped.map((item, index) => ({ id: item.id,
  annotation: { status: "swear", word: ["fuck", "shit", "fuck"][index], note: "" } }));
assert.throws(() => annotation.applyCaptionBatch(batchState, grouped[0].captionGroup.id, batchLabels.slice(0, 2)), /coverage/u);
assert.ok(batchState.items.every((item) => item.annotation.status === "pending"));
assert.throws(() => annotation.applyCaptionBatch(batchState, grouped[0].captionGroup.id,
  [...batchLabels.slice(0, 2), { ...batchLabels[2], id: "video:3" }]), /another group/u);
assert.ok(batchState.items.every((item) => item.annotation.status === "pending"));
const batchBefore = JSON.stringify(batchState);
assert.throws(() => annotation.applyAnnotation(batchState, batchState.items[0], batchLabels[0].annotation), /complete caption batch/u);
assert.strictEqual(JSON.stringify(batchState), batchBefore, "single-label API cannot bypass batch coverage");
const invalidLast = batchLabels.map((row, index) => ({ ...row,
  annotation: { ...row.annotation, ...(index === 2 ? { word: "invalid" } : { ruleIdea: true }) } }));
const invalidBefore = JSON.stringify(invalidLast);
assert.throws(() => annotation.applyCaptionBatch(batchState, grouped[0].captionGroup.id, invalidLast), /supported swear/u);
assert.strictEqual(JSON.stringify(invalidLast), invalidBefore, "validation does not mutate supplied labels");
assert.strictEqual(JSON.stringify(batchState), batchBefore, "invalid final label is atomic");
assert.throws(() => annotation.applyCaptionBatch(batchState, grouped[0].captionGroup.id,
  [batchLabels[0], batchLabels[1], batchLabels[1]]), /duplicate/u);
assert.strictEqual(JSON.stringify(batchState), batchBefore, "duplicate batch is atomic");
assert.throws(() => annotation.applyCaptionBatch({ ...batchState, mode: "false-fills" }, grouped[0].captionGroup.id,
  batchLabels), /False-fill/u);
assert.strictEqual(JSON.stringify(batchState), batchBefore);
batchState.items.reverse();
const savedBatch = annotation.applyCaptionBatch(batchState, grouped[0].captionGroup.id, [...batchLabels].reverse());
assert.deepStrictEqual(savedBatch.map((row) => row.id), ["video:0", "video:1", "video:2"]);
assert.deepStrictEqual(savedBatch.map((row) => row.annotation.word), ["fuck", "shit", "fuck"]);
assert.throws(() => annotation.applyAnnotation(batchState, batchState.items[0],
  { status: "swear", word: "shit", note: "" }), /complete caption batch/u);
assert.throws(() => annotation.applyCaptionBatch(batchState, grouped[0].captionGroup.id,
  batchLabels.map((row, index) => index ? row : { ...row, annotation: { status: "swear", word: "shit", note: "changed" } })), /overwrite reviewed/u);
assert.deepStrictEqual(batchState.items.sort((a, b) => a.tokenIndex - b.tokenIndex).map((item) => item.annotation.word), ["fuck", "shit", "fuck"]);
const correctionState = JSON.parse(JSON.stringify(batchState));
const corrections = correctionState.items.map(item => ({ id: item.id, annotation: item.annotation }));
const originalCorrection = JSON.parse(JSON.stringify(correctionState.items[0].annotation));
corrections[0] = { ...corrections[0], annotation: { ...originalCorrection, word: 'shit' } };
assert.throws(() => annotation.applyCaptionBatch(correctionState, grouped[0].captionGroup.id, corrections,
  [{ id: corrections[0].id, previous: { ...originalCorrection, word: 'bitch' } }]), /reload/u);
assert.deepStrictEqual(correctionState.items[0].annotation, originalCorrection);
const untouchedCorrection = correctionState.items[1].annotation;
annotation.applyCaptionBatch(correctionState, grouped[0].captionGroup.id, corrections,
  [{ id: corrections[0].id, previous: originalCorrection }]);
assert.strictEqual(correctionState.items[0].annotation.word, 'shit');
assert.strictEqual(correctionState.items[1].annotation, untouchedCorrection, 'untouched saved labels remain identical');

const priorBatch = { mode: "deepgram-review", items: JSON.parse(JSON.stringify(historyGroup.items)) };
const humanBefore = priorBatch.items[0].annotation;
const mixedLabels = priorBatch.items.map((item, i) => ({ id: item.id, annotation: i === 0 ? item.annotation :
  { status: i === 1 ? "swear" : "skipped", word: i === 1 ? "shit" : null, note: "" } }));
annotation.applyCaptionBatch(priorBatch, priorBatch.items[0].captionGroup.id, mixedLabels);
assert.strictEqual(priorBatch.items[0].annotation, humanBefore, "batch retains the original matching human label object");
assert.deepStrictEqual(priorBatch.items.map((item) => item.annotation.status), ["swear", "swear", "skipped"]);
const browserScript = annotation.html.match(/<script>([\s\S]*?)<\/script>/u)[1];
assert.doesNotThrow(() => new Function(browserScript));
async function testBrowser() {
  const vm = require("vm"), elements = new Map(), listeners = new Map();
  function element() {
    return { value: "", hidden: false, disabled: false, children: [], listeners: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      focus() {}, select() {}, matches() { return false; },
      play() { return Promise.resolve(); }, pause() {}, click() { this.onclick?.(); } };
  }
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element, addEventListener(name, handler) { listeners.set(name, handler); } };
  let requests = 0, resolveFetch, requestBody;
  const sandbox = { document, setTimeout, fetch(url, options) {
    requests++;assert.strictEqual(url, "/api/caption-batch");requestBody = JSON.parse(options.body);
    return new Promise(resolve => { resolveFetch = () => resolve({ ok: true,
      json: async () => ({ annotations: requestBody.labels }) }); });
  } };
  vm.createContext(sandbox);
  vm.runInContext(browserScript.trim().replace(/init\(\);$/u, "") + `
    globalThis.ui={setState(value){state=value;index=0},getIndex(){return index},show,play,previousEvent,
      nextPendingEvent,captionGroupLabels,saveCaptionGroup,getFields(){return groupFields},setIndex(value){index=value}};
  `, sandbox);
  const ui = sandbox.ui;
  const completedGroup = [0, 1].map((slot, i) => ({ ...makeSlot(slot, 30 + slot), id: 'other:'+slot,
    fixture: "other", captionGroup: { id: "other-group" },
    annotation: { status: i ? "no-swear-in-audio" : "swear", word: i ? null : "fuck", note: "completed" } }));
  const uiState = { mode: "deepgram-review", words: ALLOWED_WORDS, statusSet: annotation.statusSetFor("golden"), frequencies: {},
    items: [...JSON.parse(JSON.stringify(historyGroup.items)), ...completedGroup, makeSlot(3, 40)] };
  ui.setState(uiState);ui.show();
  for (const id of ["word", "save", "predicted"]) assert.strictEqual(elements.get(id).hidden, true, id);
  for (const id of ["standardControls", "common", "ruleBox", "skip"]) assert.strictEqual(elements.get(id).hidden, false, id);
  assert.strictEqual(elements.get("groupControls").hidden, false);
  const fields = ui.getFields();
  assert.strictEqual(fields[0].word.value, "fuck");
  assert.strictEqual(fields[0].word.readOnly, true);
  assert.strictEqual(fields[0].status.disabled, true);
  assert.deepStrictEqual(Array.from(fields[1].status.children, option => option.value), annotation.statusSetFor("golden"));
  fields[1].word.value = "shit";fields[1].note.value = "clear after replay";
  fields[2].note.value = "ordinary speech, not profanity";
  fields[2].status.value = "no-swear-in-audio";fields[2].status.onchange();
  assert.strictEqual(fields[1].word.value, "shit", "local status changes do not clear entered words");
  assert.strictEqual(uiState.items[2].annotation.status, "pending", "dropdown changes remain unsaved");
  const keyEvent = key => ({ key, target: element(), preventDefault() {} });
  listeners.get("keydown")(keyEvent("r"));
  assert.strictEqual(requests, 0, "word shortcuts only fill drafts, never save a partial group");
  for(const input of [fields[1].word, fields[1].note])assert.ok(input.listeners.keydown, "Enter works in each individual field");
  fields[1].word.onfocus();elements.get("precise").onclick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ui.captionGroupLabels()[1].annotation.ruleRecommendation)), { kind: "precise", rule: null });
  elements.get("clearRule").onclick();
  assert.strictEqual(elements.get("wide").hidden, false);
  ui.play();
  assert.strictEqual(elements.get("audio").currentTime, Math.max(0, Math.min(...historyGroup.items.map(item => item.timeSeconds)) - 1));
  const focusedEnd = Math.max(...historyGroup.items.map(item => item.timeSeconds)) + 2.5;
  let paused = false;elements.get("audio").pause = () => { paused = true; };
  elements.get("audio").currentTime = focusedEnd - 0.01;
  elements.get("audio").listeners.timeupdate();assert.strictEqual(paused, false);
  elements.get("audio").currentTime = focusedEnd;
  elements.get("audio").listeners.timeupdate();assert.ok(paused);
  ui.play(true);
  assert.strictEqual(elements.get("audio").currentTime, Math.min(...historyGroup.items.map(item => item.clipStart)));
  paused = false;elements.get("audio").currentTime = Math.max(...historyGroup.items.map(item => item.clipEnd));
  elements.get("audio").listeners.timeupdate();assert.ok(paused);
  elements.get("groupWords").value = "shit, fuck";
  await ui.saveCaptionGroup();assert.strictEqual(requests, 0, "sequence excludes completed and non-swear slots");
  elements.get("groupWords").value = "not-supported";
  await ui.saveCaptionGroup();assert.strictEqual(requests, 0, "all local selections must validate before a request");
  assert.strictEqual(uiState.items[1].annotation.status, "pending");
  elements.get("groupWords").value = "shit";
  const localLabels = ui.captionGroupLabels();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(localLabels[0].annotation)), reviewed.items[0].annotation);
  assert.deepStrictEqual(Array.from(localLabels, row => row.annotation.status), ["swear", "swear", "no-swear-in-audio"]);
  assert.strictEqual(localLabels[1].annotation.word, "shit");
  assert.strictEqual(localLabels[1].annotation.note, "clear after replay");
  assert.strictEqual(localLabels[2].annotation.note, "ordinary speech, not profanity");
  const save = ui.saveCaptionGroup();
  await ui.saveCaptionGroup();ui.previousEvent();
  assert.strictEqual(requests, 1, "saving guard prevents duplicate requests");
  assert.strictEqual(ui.getIndex(), 0, "saving guard prevents navigation while saving");
  resolveFetch();await save;
  assert.strictEqual(ui.getIndex(), 5, "next skips sibling slots and already completed groups");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(uiState.frequencies)), { fuck: 2, shit: 1 });
  ui.previousEvent();assert.strictEqual(ui.getIndex(), 3, "previous returns the previous distinct group");
  ui.previousEvent();assert.strictEqual(ui.getIndex(), 0);
  ui.show();assert.ok(ui.getFields().every(field => field.word.readOnly && field.status.disabled));
  await ui.saveCaptionGroup();assert.strictEqual(requests, 1, "completed group cannot be silently overwritten");
  assert.strictEqual((browserScript.match(/\$\('save'\)\.onclick=/gu) || []).length, 1);
  assert.ok(elements.get("groupWords").listeners.keydown, "sequence box supports Enter");

  // Restore the old workflow without allowing partial or accidental writes.
  const resetGroup = () => {
    const fresh = { ...uiState, items: JSON.parse(JSON.stringify(historyGroup.items)) };
    ui.setState(fresh);ui.show();return fresh;
  };
  const enterState = resetGroup();
  let editor = ui.getFields();
  editor[1].word.value = "shit";
  editor[1].word.listeners.keydown({ key: "Enter", preventDefault() {} });
  assert.strictEqual(requests, 1, "Enter advances an unfinished caption without saving partial labels");
  assert.ok(elements.get("groupCaption").textContent.includes("slot 3"));
  editor[2].word.value = "fuck";
  editor[2].word.listeners.keydown({ key: "Enter", preventDefault() {} });
  assert.strictEqual(requests, 2, "Enter in the final individual word field submits all slots");
  resolveFetch();await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(enterState.items.map(item => item.annotation.word), ["fuck", "shit", "fuck"]);

  const skipState = resetGroup();
  const priorHuman = JSON.stringify(skipState.items[0].annotation);
  editor = ui.getFields();editor[1].note.value = "unclear";
  editor[1].word.value = "unsupported draft";
  listeners.get("keydown")(keyEvent("u"));
  assert.strictEqual(requests, 3, "U submits an atomic skip of the remaining slots");
  assert.deepStrictEqual(Array.from(requestBody.labels, row => row.annotation.status), ["swear", "skipped", "skipped"]);
  resolveFetch();await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(JSON.stringify(skipState.items[0].annotation), priorHuman);
  assert.strictEqual(skipState.items[1].annotation.note, "unclear");

  for(const [button,status] of [["none","no-swear-in-audio"],["wrong","wrong-audio-fragment"],["nonenglish","not-english"]]){
    const fresh = resetGroup(), count = requests;
    const click = elements.get(button).onclick();
    assert.strictEqual(requests, count + 1);
    assert.deepStrictEqual(Array.from(requestBody.labels, row => row.annotation.status), ["swear",status,status]);
    resolveFetch();await click;
    assert.strictEqual(fresh.items[0].annotation.word, "fuck", "quick dispositions preserve reviewed words");
  }
  resetGroup();editor=ui.getFields();
  const count=requests;
  editor[1].word.onfocus();
  const quickWord=elements.get("common").children.find(button=>button.textContent.startsWith("shit"));
  assert.ok(quickWord);quickWord.onclick();
  assert.strictEqual(editor[1].word.value,"shit");
  assert.strictEqual(requests,count,"quick word buttons fill drafts, not partial labels");
  editor[1].word.onfocus();elements.get("manual").onclick();
  elements.get("manualRule").value="bull [__]";elements.get("manualRule").listeners.input();
  editor[2].word.value="fuck";
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ui.captionGroupLabels()[1].annotation.ruleRecommendation)),{kind:"manual",rule:"bull [__]"});
  editor[2].word.value="shi";
  editor[2].word.listeners.keydown({key:"Tab",preventDefault(){}});
  assert.strictEqual(editor[2].word.value,"shit","individual fields retain Tab completion");
  const editState=resetGroup();
  const originalSaved=JSON.stringify(editState.items[0].annotation);
  assert.strictEqual(ui.getFields()[0].word.readOnly,true);
  elements.get('editGroup').onclick();
  assert.strictEqual(ui.getFields()[0].word.readOnly,false);
  assert.strictEqual(elements.get('saveGroup').disabled,false);
  assert.strictEqual(ui.getFields()[0].status.value,'swear');
  ui.getFields()[0].word.value='shit';
  elements.get('cancelEdit').onclick();
  assert.strictEqual(ui.getFields()[0].word.value,'fuck');
  assert.strictEqual(JSON.stringify(editState.items[0].annotation),originalSaved);
  elements.get('editGroup').onclick();editor=ui.getFields();
  editor[0].word.value='shit';editor[1].word.value='fuck';editor[2].word.value='shit';
  const correctionSave=ui.saveCaptionGroup();
  assert.strictEqual(requestBody.edits.length,1);
  assert.strictEqual(JSON.stringify(requestBody.edits[0].previous),originalSaved);
  resolveFetch();await correctionSave;
  assert.strictEqual(editState.items[0].annotation.word,'shit','previously saved labels can be corrected explicitly');
  assert.strictEqual(elements.get('saveGroup').disabled,true);
  elements.get('editGroup').onclick();
  assert.strictEqual(elements.get('saveGroup').disabled,false,'fully reviewed captions are editable too');
  const changeStatus=elements.get('none').onclick();
  assert.strictEqual(requestBody.edits.length,3);
  assert.ok(requestBody.labels.every(row=>row.annotation.status==='no-swear-in-audio'));
  resolveFetch();await changeStatus;
  assert.ok(editState.items.every(item=>item.annotation.status==='no-swear-in-audio'));
  // Legacy per-slot Play retains configured bounds, focused Deepgram and false-fill behavior.
  for (const [mode, category, full, expectedStart, expectedEnd] of [
    ["golden", "agreement", false, 6, 17], ["deepgram-review", "agreement", false, 9, 12.5],
    ["deepgram-review", "agreement", true, 6, 17], ["false-fills", "false-fill", false, 9.5, 17],
    ["false-fills", "false-fill", true, 6, 17]
  ]) {
    ui.setState({ ...uiState, mode, items: [{ ...makeSlot(0, 10), category }] });ui.play(full);
    assert.strictEqual(elements.get("audio").currentTime, expectedStart);
    paused = false;elements.get("audio").currentTime = expectedEnd - 0.01;
    elements.get("audio").listeners.timeupdate();assert.strictEqual(paused, false);
    elements.get("audio").currentTime = expectedEnd;
    elements.get("audio").listeners.timeupdate();assert.strictEqual(paused, true);
  }
}
testBrowser().then(() => console.log("annotation tool tests passed")).catch(error => {
  console.error(error);process.exitCode = 1;
}).finally(() => {
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.rmSync(directory, { recursive: true, force: true });
});
