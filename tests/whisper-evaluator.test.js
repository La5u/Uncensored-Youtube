const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const evaluator = require("../tools/evaluate-whisper-only");

const args = evaluator.parseArgs(["--names", "one,two", "--limit", "3"]);
assert.deepStrictEqual([...args.names], ["one", "two"]);
assert.strictEqual(args.limit, 3);
assert.strictEqual(args.checkpointEvery, 25);
assert.strictEqual(args.fixtures, "test-fixtures");
assert.strictEqual(args.mode, "whisper-only");
assert.strictEqual(args.audioWindowKey, "shift=0;before=3;after=1.5");
const fixtureEntries = [{ name: "fixture" }];
assert.strictEqual(evaluator.normalizeFixtureManifest(fixtureEntries), fixtureEntries);
assert.strictEqual(evaluator.normalizeFixtureManifest({ fixtures: fixtureEntries }), fixtureEntries);
assert.strictEqual(evaluator.audioWindowKey({ shift: 0.25, before: 1, after: 2 }),
  "shift=0.25;before=1;after=2");
assert.notStrictEqual(evaluator.audioWindowKey(args), evaluator.audioWindowKey({ ...args, shift: 0.5 }));
assert.doesNotThrow(() => evaluator.validateTranscriptCacheWindow({ audioWindowKey: args.audioWindowKey }, args));
assert.throws(() => evaluator.validateTranscriptCacheWindow({}, args), /Transcript cache is incompatible.*missing/u);
assert.throws(() => evaluator.validateTranscriptCacheWindow({ audioWindowKey: "shift=1;before=3;after=1.5" }, args),
  /Regenerate it with --shift 0/u);
const generationFingerprint = evaluator.transcriptGenerationFingerprint();
assert.ok(generationFingerprint);
const completeTranscriptCache = {
  mode: "whisper-only",
  complete: true,
  audioWindowKey: args.audioWindowKey,
  transcriptGenerationFingerprint: generationFingerprint,
  fixtures: [{ results: [{ audioWord: "fuck", audioScore: -0.5 }] }]
};
assert.doesNotThrow(() => evaluator.validateTranscriptCache(
  completeTranscriptCache, args, generationFingerprint
));
assert.throws(() => evaluator.validateTranscriptCache(
  { ...completeTranscriptCache, mode: "rules-only" }, args, generationFingerprint
), /rules-only/u);
assert.throws(() => evaluator.validateTranscriptCache(
  { ...completeTranscriptCache, complete: false }, args, generationFingerprint
), /incomplete/u);
assert.throws(() => evaluator.validateTranscriptCache(
  { ...completeTranscriptCache, transcriptGenerationFingerprint: "stale" }, args, generationFingerprint
), /transcript generation/u);
assert.doesNotThrow(() => evaluator.validateTranscriptCache(
  { ...completeTranscriptCache, mode: "rules+whisper" }, args, generationFingerprint
));
assert.strictEqual(args.allowUnscored, false);
assert.strictEqual(args.skipMissing, false);
assert.strictEqual(args.discoverPaired, false);
assert.strictEqual(args.discoverUnpaired, false);
assert.strictEqual(args.pairClass, "all");
assert.strictEqual(args.creatorSplit, "all");
assert.strictEqual(args.contextEvents, 4);
assert.strictEqual(args.rulesScoring, "strict");
assert.strictEqual(args.unpairedMinBlanks, 0);
assert.strictEqual(evaluator.parseArgs(["--discoverPaired", "true"]).discoverPaired, true);
assert.strictEqual(evaluator.parseArgs(["--discoverUnpaired", "true"]).discoverUnpaired, true);
assert.strictEqual(evaluator.parseArgs(["--pairClass", "auto-auto"]).pairClass, "auto-auto");
assert.throws(() => evaluator.parseArgs(["--pairClass", "invalid"]), /--pairClass/);
assert.strictEqual(evaluator.parseArgs([
  "--creatorManifest", "split.json", "--creatorSplit", "test", "--pairClass", "manual-auto"
]).creatorSplit, "test");
assert.throws(() => evaluator.parseArgs([
  "--creatorManifest", "split.json", "--creatorSplit", "test", "--pairClass", "auto-auto"
]), /manual-auto/u);
assert.throws(() => evaluator.parseArgs([
  "--creatorManifest", "split.json", "--creatorSplit", "test", "--pairClass", "manual-auto",
  "--skipMissing", "true"
]), /skipMissing/u);
assert.throws(() => evaluator.parseArgs(["--creatorSplit", "test"]), /requires --creatorManifest/u);
assert.strictEqual(evaluator.parseArgs(["--unpairedMinBlanks", "10"]).unpairedMinBlanks, 10);
assert.strictEqual(evaluator.parseArgs(["--mode", "rules-only"]).mode, "rules-only");
assert.strictEqual(
  evaluator.parseArgs(["--mode", "rules-only", "--rulesScoring", "any-candidate"]).rulesScoring,
  "any-candidate"
);
assert.throws(() => evaluator.parseArgs(["--rulesScoring", "any-candidate"]), /requires --mode rules-only/);
assert.throws(() => evaluator.parseArgs(["--rulesScoring", "invalid"]), /--rulesScoring/);
assert.strictEqual(evaluator.parseArgs(["--mode", "rules+whisper"]).mode, "rules+whisper");
assert.throws(() => evaluator.parseArgs(["--mode", "invalid"]), /--mode/);
assert.throws(() => evaluator.parseArgs(["--limit"]), /Missing value/);
assert.throws(() => evaluator.parseArgs(["--limit", "nope"]), /--limit/);
assert.throws(() => evaluator.parseArgs(["--unknown", "value"]), /Unknown option/);
assert.throws(() => evaluator.parseArgs(["--retryAfter", "0"]), /Unknown option/);
assert.strictEqual(evaluator.shouldTranscribeToken({ deterministicWord: "shit" }, "rules+whisper"), true);
assert.strictEqual(evaluator.shouldTranscribeToken({
  deterministicWord: "shit", deterministicAmbiguous: true
}, "rules+whisper"), true);
assert.strictEqual(evaluator.shouldTranscribeToken({
  deterministicWord: "shit", deterministicAmbiguous: false, deterministicTier: "exact"
}, "rules+whisper"), true);
assert.strictEqual(evaluator.shouldTranscribeToken({
  deterministicWord: "fucking", deterministicTier: "frame"
}, "rules+whisper"), true);
assert.strictEqual(evaluator.contextWordForToken({
  deterministicWord: "", context: "a [__] good"
}), "fucking");
assert.strictEqual(evaluator.shouldTranscribeToken({ deterministicWord: "shit" }, "whisper-only"), true);
assert.strictEqual(evaluator.shouldTranscribeToken({}, "rules-only"), false);
assert.strictEqual(evaluator.parseArgs(["--mode", "rules-first"]).mode, "rules-first");
assert.strictEqual(evaluator.shouldTranscribeToken({ deterministicWord: "shit" }, "rules-first"), false);
assert.strictEqual(evaluator.shouldTranscribeToken({ deterministicWord: "shit", deterministicAmbiguous: true }, "rules-first"), true);
assert.strictEqual(evaluator.shouldTranscribeToken({}, "rules-first"), true);
assert.strictEqual(evaluator.ruleQualityGate({
  template: "literal [__] rule", matchedCount: 4, precision: 1, candidateCount: 1, creatorCount: 2
}).passed, true);
assert.strictEqual(evaluator.ruleQualityGate({
  template: "literal [__] rule", matchedCount: 50, precision: 0.84, candidateCount: 1, creatorCount: 2
}).passed, false);
const longLiteralGate = evaluator.ruleQualityGate({
  template: "literal [__] rule", matchedCount: 6, precision: 0.85, candidateCount: 1, creatorCount: 2
});
assert.strictEqual(longLiteralGate.minimumSupport, 6);
assert.strictEqual(longLiteralGate.passed, true);
assert.strictEqual(evaluator.ruleQualityGate({
  template: "literal * [__] rule", matchedCount: 10, precision: 0.91, candidateCount: 1, creatorCount: 2
}).passed, false);
const twoCandidateGate = evaluator.ruleQualityGate({
  template: "literal [__] rule", matchedCount: 6, candidateCount: 2,
  candidatePrecision: 0.92, precision: 0.89, creatorCount: 2
});
assert.strictEqual(twoCandidateGate.passed, true);
assert.strictEqual(twoCandidateGate.deterministicPassed, false);
assert.strictEqual(evaluator.ruleQualityGate({
  template: "literal [__] rule", matchedCount: 9, candidateCount: 3,
  candidatePrecision: 1, creatorCount: 2
}).passed, false);
assert.strictEqual(evaluator.ruleQualityGate({
  template: "frame <verb> [__]", matchedCount: 6, candidateCount: 2,
  candidatePrecision: 1, creatorCount: 2
}).minimumSupport, 10);
assert.strictEqual(evaluator.ruleQualityGate({
  template: "literal [__] rule", matchedCount: 20, precision: 1, candidateCount: 1, creatorCount: 1
}).passed, false);

const rules = require("../src/rules");
assert.strictEqual(rules.templatesMatch(["what the [__]"], "oh my god what the [__] was that"), true);
assert.strictEqual(rules.templatesMatch(["all your [__]"], "take all your [__] teeth next"), true);
assert.strictEqual(rules.templatesMatch(["what the [__]"], "this text has no censored slot"), false);
assert.strictEqual(rules.templatesMatch(["ghost [__] rule"], "all your [__] teeth"), false);

const { changedRuleTemplates, contentFingerprint } = evaluator;
const macro = evaluator.creatorMacro([
  { creator: "Alias A", creatorId: "UC-A", pairClass: "manual-auto", results: [
    { expected: ["fuck"], attempted: true, correct: true },
    { expected: ["shit"], attempted: true, correct: true }
  ] },
  { creator: "Creator B", creatorId: "UC-B", pairClass: "manual-auto", results: [
    { expected: ["fuck"], attempted: true, correct: true },
    { expected: ["shit"], attempted: true, correct: false }
  ] },
  { creator: "unknown", results: [{ expected: ["fuck"], attempted: true, correct: false }] }
]);
assert.strictEqual(macro.creatorCount, 2);
assert.strictEqual(macro.contributingCreatorCount, 2);
assert.strictEqual(macro.attemptedCreatorCount, 2);
assert.strictEqual(macro.precision, 0.75);
assert.strictEqual(macro.coverage, 0.75);
assert.deepStrictEqual(evaluator.creatorSplitForRecord(
  { creator: "Alias", creatorId: "UC-A" },
  { byName: new Map([["Alias", "validation"]]), byId: new Map([["UC-A", "test"]]) }
), "conflict");
assert.strictEqual(evaluator.creatorSplitForRecord(
  { creator: "Alias", creatorId: "UC-A" },
  { byName: new Map([["Alias", "test"]]), byId: new Map([["UC-A", "test"]]) }
), "test");
const frozenCreatorManifest = evaluator.loadCreatorManifest(
  "tools/caption-growth-heldout-test-manual-pilot.json"
);
assert.ok(frozenCreatorManifest.fingerprint);
assert.strictEqual(frozenCreatorManifest.manifest.version, 1);
assert.strictEqual(frozenCreatorManifest.manifest.prospective, true);
assert.strictEqual(frozenCreatorManifest.manifest.minimumCreators, 3);
assert.strictEqual(frozenCreatorManifest.manifest.minimumSlots, 30);
assert.ok([...frozenCreatorManifest.manifest.creators]
  .filter((creator) => creator.split === "test")
  .every((creator) => creator.channelId));
assert.strictEqual(evaluator.isCanonicalCreatorId("UCXGcEdl8PDZPpqB5zjLoQ2w"), true);
assert.strictEqual(evaluator.isCanonicalCreatorId("UC-A"), false);
assert.strictEqual(evaluator.isProspectiveTestFixture({
  pairClass: "manual-auto", creator: "Unsubscribe Clips",
  creatorId: "UCXGcEdl8PDZPpqB5zjLoQ2w"
}, frozenCreatorManifest), true);
assert.strictEqual(evaluator.isProspectiveTestFixture({
  pairClass: "auto-auto", creatorId: "UCXGcEdl8PDZPpqB5zjLoQ2w"
}, frozenCreatorManifest), false);
const temporaryManifestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-manifest-"));
const duplicateNameManifest = path.join(temporaryManifestDirectory, "duplicate-name.json");
const duplicateName = JSON.parse(JSON.stringify(frozenCreatorManifest.manifest));
duplicateName.creators.push({
  name: duplicateName.creators[0].name,
  channelId: "UCsAWSuxD1PBs9i2Fuw2snrw",
  split: "test"
});
fs.writeFileSync(duplicateNameManifest, JSON.stringify(duplicateName));
assert.throws(() => evaluator.loadCreatorManifest(duplicateNameManifest), /Duplicate creator manifest name/u);
const duplicateIdManifest = JSON.parse(JSON.stringify(frozenCreatorManifest.manifest));
duplicateIdManifest.creators[1].channelId = duplicateIdManifest.creators[0].channelId;
const duplicateIdPath = path.join(temporaryManifestDirectory, "duplicate-id.json");
fs.writeFileSync(duplicateIdPath, JSON.stringify(duplicateIdManifest));
assert.throws(() => evaluator.loadCreatorManifest(duplicateIdPath), /Duplicate creator manifest channelId/u);
const futureManifest = JSON.parse(JSON.stringify(frozenCreatorManifest.manifest));
futureManifest.frozenAt = new Date(Date.now() + 60_000).toISOString();
const futureManifestPath = path.join(temporaryManifestDirectory, "future.json");
fs.writeFileSync(futureManifestPath, JSON.stringify(futureManifest));
assert.throws(() => evaluator.loadCreatorManifest(futureManifestPath), /non-future frozenAt/u);
const wrongVersionManifest = JSON.parse(JSON.stringify(frozenCreatorManifest.manifest));
wrongVersionManifest.version = 2;
const wrongVersionPath = path.join(temporaryManifestDirectory, "version-2.json");
fs.writeFileSync(wrongVersionPath, JSON.stringify(wrongVersionManifest));
assert.throws(() => evaluator.loadCreatorManifest(wrongVersionPath), /version 1/u);
const weakMethodManifest = JSON.parse(JSON.stringify(frozenCreatorManifest.manifest));
weakMethodManifest.method = "Creators selected for convenience after reviewing captions.";
const weakMethodPath = path.join(temporaryManifestDirectory, "weak-method.json");
fs.writeFileSync(weakMethodPath, JSON.stringify(weakMethodManifest));
assert.throws(() => evaluator.loadCreatorManifest(weakMethodPath), /pre-registered method/u);
fs.rmSync(temporaryManifestDirectory, { recursive: true, force: true });
assert.deepStrictEqual(evaluator.validateProspectiveSummary({
  scoredCount: 30, creatorMacro: { contributingCreatorCount: 3 }
}, frozenCreatorManifest.manifest), {
  valid: true, creatorCount: 3, scoredSlots: 30, minimumCreators: 3, minimumSlots: 30
});
assert.strictEqual(evaluator.validateProspectiveSummary({
  scoredCount: 29, creatorMacro: { contributingCreatorCount: 3 }
}, frozenCreatorManifest.manifest).valid, false);
assert.deepStrictEqual(
  changedRuleTemplates(
    [{ template: "a [__] ", candidates: ["fuck"] }, { template: "gone [__]", candidates: ["shit"] }],
    [{ template: "a [__] ", candidates: ["fuck", "shit"] }, { template: "new [__] rule", candidates: ["bitch"] }]
  ),
  { changed: ["a [__] ", "new [__] rule"], removed: ["gone [__]"] }
);
assert.deepStrictEqual(
  changedRuleTemplates(
    [{ template: "a [__]", candidates: ["fuck"] }, { template: "b [__]", candidates: ["shit"] }],
    [{ template: "a [__]", candidates: ["fuck"] }, { template: "new [__]", candidates: ["bitch"] },
      { template: "b [__]", candidates: ["shit"] }]
  ),
  { changed: ["new [__]"], removed: [] }
);
assert.strictEqual(contentFingerprint("hello world"), contentFingerprint("hello world"));
assert.notStrictEqual(contentFingerprint("hello world"), contentFingerprint("hello worle"));
assert.ok(evaluator.decisionFingerprint());
assert.strictEqual(evaluator.decisionFingerprint(), evaluator.decisionFingerprint());
const temporaryFixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-fixture-"));
const cacheFixture = { name: "fixture", censored: "fixture_auto.json3", uncensored: "fixture_manual.json3" };
fs.writeFileSync(path.join(temporaryFixtureDirectory, cacheFixture.censored), "censored-v1");
fs.writeFileSync(path.join(temporaryFixtureDirectory, cacheFixture.uncensored), "manual-v1");
const cachedFixtureFingerprint = evaluator.fixtureFingerprint(temporaryFixtureDirectory, cacheFixture);
const transcriptCache = { fixtures: [{ ...cacheFixture, contentFingerprint: cachedFixtureFingerprint,
  results: [{ tokenIndex: 0, transcript: "cached" }] }] };
assert.strictEqual(evaluator.transcriptCacheResults(transcriptCache.fixtures[0], cachedFixtureFingerprint)
  .get(0).transcript, "cached");
fs.writeFileSync(path.join(temporaryFixtureDirectory, cacheFixture.censored), "censored-v2");
const changedFixtureFingerprint = evaluator.fixtureFingerprint(temporaryFixtureDirectory, cacheFixture);
assert.notStrictEqual(changedFixtureFingerprint, cachedFixtureFingerprint);
assert.strictEqual(evaluator.transcriptCacheResults(transcriptCache.fixtures[0], changedFixtureFingerprint), null);
fs.rmSync(temporaryFixtureDirectory, { recursive: true, force: true });
assert.strictEqual(evaluator.reviewContextForToken([
  { eventIndex: 0, firstTokenIndex: 0, text: "one" },
  { eventIndex: 3, firstTokenIndex: 0, text: "two [__]" },
  { eventIndex: 7, firstTokenIndex: 1, text: "three [__]" },
  { eventIndex: 9, firstTokenIndex: 2, text: "four" }
], { eventIndex: 7, tokenIndex: 1 }), "one two … three [__] four");

assert.deepStrictEqual(
  [...evaluator.allowedExpectedWords(new Map([[0, "fuck"], [1, "ass"], [2, "nigga"]]))],
  [[0, "fuck"]]
);

assert.strictEqual(evaluator.isCorrect("fuuuuuck", ["fuck"], ""), true);
assert.strictEqual(evaluator.isCorrect("fuck", ["fuck's"], "[__] sake"), true);
assert.strictEqual(evaluator.isCorrect("fuck", ["fuck's"], "for [__]'s sake"), true);
assert.strictEqual(evaluator.isCorrect("fuck's", ["fuck's"], "for [__]'s sake"), false);

assert.strictEqual(evaluator.classifyResult({ expected: [], word: "fuck" }), "unscored");
assert.strictEqual(evaluator.classifyResult({ expected: ["shit"], correct: true, word: "shit" }), "correct-exact");
assert.strictEqual(evaluator.classifyResult({ expected: ["shit"], correct: false, word: "fuck" }), "different-swear");
assert.strictEqual(evaluator.classifyResult({ expected: ["shit"], correct: false, word: "" }), "missed");

const summary = evaluator.summarize([
  {
    results: [
      { expected: ["fuck"], word: "fuck", candidates: ["fuck"], attempted: true, correct: true,
        classification: "correct-exact", ruleId: "exact:test", ruleTemplate: "what [__]",
        ruleTier: "exact" },
      { expected: ["shit"], word: "fuck", candidates: ["fuck"], attempted: true, correct: false,
        classification: "different-swear", ruleId: "exact:test", ruleTemplate: "what [__]",
        ruleTier: "exact" },
      { expected: ["bitch"], word: "", correct: false, classification: "missed" },
      { expected: [], word: "fuck", correct: false, classification: "unscored" }
    ], creator: "Test Creator"
  },
  { skipped: true, manualCensoredCount: 2 }
]);
assert.strictEqual(summary.scoredCount, 3);
assert.strictEqual(summary.unscoredCount, 1);
assert.strictEqual(summary.alignmentRate, 0.75);
assert.strictEqual(summary.manualCensoredCount, 2);
assert.strictEqual(summary.manualCensoredFixtureCount, 1);
assert.strictEqual(summary.reviewFixtureCount, 0);
assert.strictEqual(summary.reviewUnscoredCount, 0);
assert.strictEqual(summary.contributingFixtureCount, 1);
assert.strictEqual(summary.fillRate, 0.75);
assert.strictEqual(summary.attemptedCount, 2);
assert.strictEqual(summary.correctCount, 1);
assert.strictEqual(summary.precision, 0.5);
assert.strictEqual(summary.coverage, 1 / 3);
assert.strictEqual(summary.accuracy, summary.coverage);
assert.deepStrictEqual(summary.pairClasses.unknown, {
  fixtureCount: 1,
  evaluatedCount: 4,
  scoredCount: 3,
  attemptedCount: 2,
  correctCount: 1,
  precision: 0.5,
  coverage: 1 / 3
});
assert.deepStrictEqual(summary.ruleMetrics, [{
  ruleId: "exact:test",
  template: "what [__]",
  tier: "exact",
  matchedCount: 2,
  attemptedCount: 2,
  correctCount: 1,
  candidateCorrectCount: 1,
  pairClasses: {
    unknown: { matchedCount: 2, attemptedCount: 2, correctCount: 1, precision: 0.5 }
  },
  precision: 0.5,
  candidateCount: 1,
  candidatePrecision: 0.5,
  creatorCount: 1,
  qualityGate: {
    passed: false,
    deterministicPassed: false,
    score: 0.5,
    minimumSupport: 4,
    minimumPrecision: 0.9,
    deterministicMinimumPrecision: 0.9,
    minimumCreators: 2,
    generalized: false
  }
}]);
assert.deepStrictEqual(summary.topConfusions, [
  { pair: "bitch <- (none)", count: 1 },
  { pair: "shit <- fuck", count: 1 }
]);

const candidateSummary = evaluator.summarize([{ results: [
  {
    expected: ["shit"], word: "", candidates: ["shit", "fuck"], attempted: true,
    candidateScoring: true, correct: true, classification: "correct-normalized-variant"
  },
  {
    expected: ["bitch"], word: "", candidates: ["shit", "fuck"], attempted: true,
    candidateScoring: true, correct: false, classification: "missed"
  },
  {
    expected: ["fuck"], word: "", candidates: [], attempted: false,
    candidateScoring: true, correct: false, classification: "missed"
  }
] }]);
assert.strictEqual(candidateSummary.attemptedCount, 2);
assert.strictEqual(candidateSummary.correctCount, 1);
assert.strictEqual(candidateSummary.precision, 0.5);
assert.strictEqual(candidateSummary.coverage, 1 / 3);
assert.deepStrictEqual(candidateSummary.topConfusions, [
  { pair: "bitch <- shit|fuck", count: 1 },
  { pair: "fuck <- (none)", count: 1 }
]);

const multiTokenSummary = evaluator.summarize([
  { creator: "one", results: [
    { expected: ["fucking"], candidates: ["fucking"], attempted: true, correct: true,
      ruleId: "exact:multi", ruleTemplate: "piece of [__] [__]", ruleTier: "exact" },
    { expected: ["shit"], candidates: ["shit"], attempted: true, correct: true,
      ruleId: "exact:multi", ruleTemplate: "piece of [__] [__]", ruleTier: "exact" }
  ] },
  { creator: "two", results: [
    { expected: ["fucking"], candidates: ["fucking"], attempted: true, correct: true,
      ruleId: "exact:multi", ruleTemplate: "piece of [__] [__]", ruleTier: "exact" },
    { expected: ["shit"], candidates: ["shit"], attempted: true, correct: true,
      ruleId: "exact:multi", ruleTemplate: "piece of [__] [__]", ruleTier: "exact" }
  ] }
]).ruleMetrics[0];
assert.strictEqual(multiTokenSummary.candidateCount, 1);
assert.strictEqual(multiTokenSummary.qualityGate.minimumSupport, 4);

console.log("whisper-evaluator.test.js passed");
