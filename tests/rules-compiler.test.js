const assert = require("assert");
const compiler = require("../src/rules-compiler");

const prefixes = compiler.set("prefix", ["don't", "can't"]);
const suffixes = compiler.set("suffix", ["up", "you up"]);
const declaration = compiler.pattern`${prefixes} [fuck] ${suffixes}`;

assert.deepStrictEqual(compiler.expand(declaration), [
  "don't [fuck] up",
  "don't [fuck] you up",
  "can't [fuck] up",
  "can't [fuck] you up"
]);
assert.deepStrictEqual(
  compiler.compileGroups([compiler.group("fuck-up", [declaration])]).map((rule) => ({
    template: rule.template,
    candidates: rule.candidates
  })),
  [
    { template: "don't [__] up", candidates: ["fuck"] },
    { template: "don't [__] you up", candidates: ["fuck"] },
    { template: "can't [__] up", candidates: ["fuck"] },
    { template: "can't [__] you up", candidates: ["fuck"] }
  ]
);
assert.strictEqual(
  compiler.compileGroups([
    compiler.group("open", [compiler.pattern`try to [fuck|fucking] …`])
  ])[0].template,
  "try to [__] "
);
assert.throws(() => compiler.set("duplicate", ["same", "same"]), /Duplicate value/);
assert.throws(
  () => compiler.compileGroups([
    compiler.group("duplicate", [compiler.pattern`holy [shit]`, compiler.pattern`holy [fuck]`])
  ]),
  /Duplicate rule template/
);

const intensifier = compiler.set("intensifier", ["fucking", "motherfucking"]);
const grammar = compiler.compileFramePattern(
  compiler.frame`${compiler.set("subject", ["I", "you"])} ${compiler.slot(intensifier)} ${compiler.set("action", ["go", "stop"])}`
);
assert.deepStrictEqual(grammar.rule, {
  template: "<subject> [__] <action>",
  candidates: intensifier,
  role: "intensifier"
});
assert.ok(new RegExp(`^${grammar.phrase}$`, "iu").test("I [__] stop"));
assert.throws(
  () => compiler.frame`${compiler.set("subject", ["I"])} ${compiler.set("action", ["go"])}`,
  /exactly one/
);

console.log("rules-compiler.test.js passed");
