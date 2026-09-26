"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { replay } = require("../tools/shadow-replay-abstaining-winner");
const { EVIDENCE_POLICY } = require("../tools/audit-caption-corpus");

const dataset = (rows) => ({ dataset: "real-manual-auto", mode: "faithful", validation: "faithful-only",
  discoveryOnly: false, pairClass: "manual-auto", provenance: { evidencePolicy: EVIDENCE_POLICY }, rows });
const row = (id, context, expected = "shit") => ({ id, context, expected, slotIndex: 0,
  evidenceEligible: true, contextFaithful: true, creator: "Creator", creatorKey: "name:creator" });
const traceContext = () => [{ tokenIndex: 0, tokenSpan: 1,
  winner: { status: "abstain", rule: { groupId: "winner", template: "x [word]" } },
  alternatives: [
    { status: "blocked", rule: { groupId: "blocked", template: "x [word]" }, decision: { word: "shit" } },
    { status: "blocked", rule: { groupId: "later", template: "x [word]" }, decision: { word: "damn" } }
  ] }];

test("shadow replay counts the first filled blocked alternative and excludes multi-slot rows", () => {
  const report = replay(dataset([row("single", "x [__]", "shit"), row("multi", "x [__] and [__]")]), traceContext);
  assert.equal(report.correctGained, 1);
  assert.equal(report.wrongAdded, 0);
  assert.deepEqual(report.multiSlotExclusions, ["multi"]);
  assert.equal(Object.values(report.selectorPairs)[0].rows, 1);
});

test("shadow replay reports wrong additions and requires faithful manual-auto evidence", () => {
  const report = replay(dataset([row("wrong", "x [__]", "damn")]), traceContext);
  assert.equal(report.wrongAdded, 1);
  assert.throws(() => replay({ ...dataset([]), mode: "archived" }), /faithful manual-auto/u);
  assert.throws(() => replay({ ...dataset([]), provenance: {} }), /faithful manual-auto/u);
  assert.equal(replay(dataset([{ ...row("bad", "x [__]"), evidenceEligible: false }]), traceContext).eligible, 0);
});

test("counterfactual replay reports the actual choice after disabling the winner", () => {
  const cases = [
    { name: "chain of abstentions", decisions: [{ tokenIndex: 0, tokenSpan: 1, source: "abstain",
      word: "", rule: { template: "middle" } }], expected: "unchangedAbstention", matches: false },
    { name: "different winning rule", decisions: [{ tokenIndex: 0, tokenSpan: 1, source: "rule",
      word: "damn", rule: { template: "later" } }], expected: "wrong", matches: false },
    { name: "proposed alternative selected", decisions: [{ tokenIndex: 0, tokenSpan: 1, source: "rule",
      word: "shit", rule: { template: "x [word]" } }], expected: "correct", matches: true }
  ];
  for (const scenario of cases) {
    const report = replay(dataset([row(scenario.name, "x [__]", "shit")]), traceContext,
      (_context, options) => {
        assert.equal(options.disabledRuleTemplate, "x [word]");
        return { decisions: scenario.decisions };
      });
    assert.equal(report.counterfactual[scenario.expected], 1, scenario.name);
    assert.equal(report.counterfactual.selectedRuleMatchesProposal, scenario.matches ? 1 : 0, scenario.name);
    assert.equal(report.counterfactual.selectedRuleDiffersProposal, scenario.matches ? 0 : 1, scenario.name);
    assert.equal(report.correctGained, 1, "proposal metric remains separate");
  }
});

test("an earlier abstaining alternative still blocks later fills", () => {
  const trace = () => [{ ...traceContext()[0], alternatives: [
    { status: "blocked", rule: { template: "first" }, decision: null },
    ...traceContext()[0].alternatives
  ] }];
  const report = replay(dataset([row("blocked", "x [__]")]), trace);
  assert.equal(report.blockedByAbstention, 1);
  assert.equal(report.correctGained, 0);
  assert.equal(report.eligible, 0);
});
