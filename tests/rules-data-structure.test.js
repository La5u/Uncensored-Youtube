const assert = require("assert");
const crypto = require("crypto");
const compiler = require("../src/rules-compiler");
const data = require("../src/rules-data");

const groups = Object.values(data.RULE_GROUPS).flat();
assert.ok(groups.every((group) => Number.isInteger(group.priority)));
assert.strictEqual(new Set(groups.map((group) => group.priority)).size, groups.length);
assert.ok(data.RULE_GROUPS.exact.every((group) =>
  !/(mined|corpus|unpaired|extrapolated|creator)/.test(group.id)));

const plainRule = (rule) => ({
  template: rule.template,
  candidates: rule.candidates,
  ...(rule.role ? { role: rule.role } : {})
});
const plainGroups = (groups) => compiler.compileGroups(groups).map(plainRule);
const compiled = {
  exact: plainGroups(data.RULE_GROUPS.exact),
  productive: plainGroups(data.RULE_GROUPS.productive),
  lowConfidence: plainGroups(data.RULE_GROUPS.lowConfidence),
  fallback: plainGroups(data.RULE_GROUPS.fallback),
  frames: data.RULE_GROUPS.frames.flatMap((group) => group.patterns.map((value) => {
    const frame = compiler.compileFramePattern(value);
    return { rule: plainRule(frame.rule), phrase: frame.phrase };
  })),
  allowed: data.ALLOWED_WORDS,
  notCensored: data.NOT_CENSORED_WORDS,
  ruleWords: data.RULE_WORDS,
  roles: data.WORD_ROLES,
  priors: data.CANDIDATE_PRIORS
};
const digest = crypto.createHash("sha256").update(JSON.stringify(compiled)).digest("hex");
assert.strictEqual(digest, "d8a1daef660838e79992140516c659a3e7ac30a6f4bd61999575ec667882ba4b");
console.log("rules-data-structure.test.js passed");
