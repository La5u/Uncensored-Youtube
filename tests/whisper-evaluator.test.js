const assert = require("assert");
const evaluator = require("../tools/evaluate-whisper-only");

const args = evaluator.parseArgs(["--names", "one,two", "--limit", "3"]);
assert.deepStrictEqual([...args.names], ["one", "two"]);
assert.strictEqual(args.limit, 3);
assert.strictEqual(args.fixtures, "test-fixtures");
assert.strictEqual(args.mode, "whisper-only");
assert.strictEqual(args.allowUnscored, false);
assert.strictEqual(evaluator.parseArgs(["--mode", "rules-only"]).mode, "rules-only");
assert.strictEqual(evaluator.parseArgs(["--mode", "rules+whisper"]).mode, "rules+whisper");
assert.throws(() => evaluator.parseArgs(["--mode", "invalid"]), /--mode/);

assert.deepStrictEqual(
  evaluator.wordsInText("That was fucking shit."),
  ["fucking", "shit"]
);
assert.deepStrictEqual(evaluator.wordsInText("FUC# SH@T"), ["fuck", "shit"]);

assert.deepStrictEqual(
  evaluator.expectedWords([
    { start: 1, end: 2, text: "fuck" },
    { start: 5, end: 6, text: "shit" }
  ], 2, 0.5),
  ["fuck"]
);

console.log("whisper-evaluator.test.js passed");
