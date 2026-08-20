const assert = require("assert");
const evaluator = require("../tools/evaluate-whisper-only");

const args = evaluator.parseArgs(["--names", "one,two", "--limit", "3"]);
assert.deepStrictEqual([...args.names], ["one", "two"]);
assert.strictEqual(args.limit, 3);
assert.strictEqual(args.retryAfter, 2.5);
assert.strictEqual(args.checkpointEvery, 25);
assert.strictEqual(args.fixtures, "test-fixtures");
assert.strictEqual(args.mode, "whisper-only");
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
  "--creatorManifest", "split.json", "--creatorSplit", "test"
]).creatorSplit, "test");
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
assert.strictEqual(evaluator.parseArgs(["--retryAfter", "0"]).retryAfter, 0);
assert.strictEqual(evaluator.transcriptContainsWord("Boom, and then", "boom"), true);
assert.strictEqual(evaluator.transcriptContainsWord("Nothing useful", "boom"), false);
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
assert.strictEqual(evaluator.reviewContextForToken([
  { eventIndex: 0, firstTokenIndex: 0, text: "one" },
  { eventIndex: 3, firstTokenIndex: 0, text: "two [__]" },
  { eventIndex: 7, firstTokenIndex: 1, text: "three [__]" },
  { eventIndex: 9, firstTokenIndex: 2, text: "four" }
], { eventIndex: 7, tokenIndex: 1 }), "one two … three [__] four");

assert.deepStrictEqual(
  evaluator.wordsInText("That was fucking shit."),
  ["fucking", "shit"]
);
assert.deepStrictEqual(evaluator.wordsInText("FUC# SH@T"), ["fuck", "shit"]);
assert.deepStrictEqual(
  [...evaluator.allowedExpectedWords(new Map([[0, "fuck"], [1, "ass"], [2, "nigga"]]))],
  [[0, "fuck"]]
);

assert.strictEqual(evaluator.isCorrect("fuuuuuck", ["fuck"], ""), true);
assert.strictEqual(evaluator.isCorrect("fuck", ["fuck's"], "[__] sake"), true);
assert.strictEqual(evaluator.isCorrect("fuck", ["fuck's"], "for [__]'s sake"), true);
assert.strictEqual(evaluator.isCorrect("fuck's", ["fuck's"], "for [__]'s sake"), false);

assert.strictEqual(evaluator.classifyResult({
  expected: ["shit"],
  correct: false,
  recognizedExpected: true,
  recognizedWords: ["fuck", "shit"],
  transcript: "what the fuck is this shit",
  context: "what the [__]"
}), "recognized-wrong-slot");
assert.strictEqual(evaluator.classifyResult({
  expected: ["shit"],
  correct: false,
  recognizedExpected: false,
  recognizedWords: [],
  transcript: "that was shift",
  context: "[__]"
}), "near-transcription");

assert.deepStrictEqual(
  evaluator.expectedWords([
    { start: 1, end: 2, text: "fuck" },
    { start: 5, end: 6, text: "shit" }
  ], 2, 0.5),
  ["fuck"]
);

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
