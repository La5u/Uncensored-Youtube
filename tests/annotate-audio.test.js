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
  annotation.html.includes("e.key==='/'&&!e.target.matches('input,textarea,[contenteditable]')") &&
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

fs.rmSync(directory, { recursive: true, force: true });
console.log("annotation tool tests passed");
