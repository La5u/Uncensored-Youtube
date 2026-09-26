#!/usr/bin/env node
"use strict";

const path = require("path");
const rules = require("../src/rules");
const { buildFaithfulDataset } = require("./build-real-manual-auto-dataset");
const { censoredSlotCount } = require("./archived-rules-benchmark");
const { EVIDENCE_POLICY } = require("./audit-caption-corpus");
const { isCorrect } = require("./evaluate-whisper-only");

const root = path.join(__dirname, "..");
const label = (rule) => `${rule?.groupId || "rule"}:${rule?.template || ""}`;

function replay(dataset, traceContext = (context) => rules.applyDeterministicRules(context, { trace: true }).trace || [],
  applyContext = (context, options) => rules.applyDeterministicRules(context, options)) {
  if (dataset?.dataset !== "real-manual-auto" || dataset.mode !== "faithful" ||
      dataset.validation !== "faithful-only" || dataset.discoveryOnly !== false ||
      dataset.pairClass !== "manual-auto" || dataset.provenance?.evidencePolicy !== EVIDENCE_POLICY) {
    throw new Error("Shadow replay requires a faithful manual-auto dataset.");
  }
  const report = { mode: "read-only-shadow", dataset: "real-manual-auto", pairClass: "manual-auto",
    rows: dataset.rows.length, multiSlotExclusions: [], blockedByAbstention: 0,
    eligible: 0, correctGained: 0, wrongAdded: 0,
    counterfactual: { tested: 0, correct: 0, wrong: 0, unchangedAbstention: 0,
      noSelection: 0, selectedRuleMatchesProposal: 0, selectedRuleDiffersProposal: 0 },
    creators: {}, selectorPairs: {} };
  for (const row of dataset.rows) {
    if (row.evidenceEligible !== true || row.contextFaithful !== true ||
        !row.creatorKey || !row.expected) continue;
    if (censoredSlotCount(row.context) !== 1) {
      report.multiSlotExclusions.push(row.id);
      continue;
    }
    const trace = traceContext(row.context);
    const slot = trace.find((item) => item.tokenIndex === row.slotIndex && item.tokenSpan === 1);
    if (!slot || slot.winner?.status !== "abstain") continue;
    const alternative = slot.alternatives.find((item) => item.status === "blocked");
    if (!alternative) continue;
    if (!alternative.decision?.word) { report.blockedByAbstention += 1; continue; }
    report.eligible += 1;
    const correct = isCorrect(alternative.decision.word, [row.expected], row.context);
    const metric = correct ? "correctGained" : "wrongAdded";
    report[metric] += 1;
    const counterfactual = applyContext(row.context, { disabledRuleTemplate: slot.winner.rule.template });
    const selected = (counterfactual.decisions || []).find((item) => item.tokenIndex === row.slotIndex && item.tokenSpan === 1);
    const actual = report.counterfactual;
    actual.tested += 1;
    if (!selected) actual.noSelection += 1;
    else if (selected.source === "abstain" || !selected.word) actual.unchangedAbstention += 1;
    else actual[isCorrect(selected.word, [row.expected], row.context) ? "correct" : "wrong"] += 1;
    if (selected?.rule?.template === alternative.rule?.template) actual.selectedRuleMatchesProposal += 1;
    else actual.selectedRuleDiffersProposal += 1;
    const creator = report.creators[row.creatorKey] || { creator: row.creator, creatorKey: row.creatorKey,
      rows: 0, correctGained: 0, wrongAdded: 0 };
    creator.rows += 1; creator[metric] += 1; report.creators[row.creatorKey] = creator;
    const pairKey = `${label(slot.winner.rule)} -> ${label(alternative.rule)}`;
    const pair = report.selectorPairs[pairKey] || { rows: 0, correctGained: 0, wrongAdded: 0,
      counterfactualCorrect: 0, counterfactualWrong: 0, unchangedAbstention: 0,
      selectedRuleMatchesProposal: 0, selectedRuleDiffersProposal: 0 };
    pair.rows += 1; pair[metric] += 1;
    if (selected && selected.source !== "abstain" && selected.word) {
      pair[isCorrect(selected.word, [row.expected], row.context) ? "counterfactualCorrect" : "counterfactualWrong"] += 1;
    } else if (selected) pair.unchangedAbstention += 1;
    pair[selected?.rule?.template === alternative.rule?.template ? "selectedRuleMatchesProposal" : "selectedRuleDiffersProposal"] += 1;
    report.selectorPairs[pairKey] = pair;
  }
  report.multiSlotExclusions.sort();
  return report;
}

if (require.main === module) {
  try {
    const dataset = buildFaithfulDataset();
    const report = replay(dataset);
    const output = path.join(root, "tmp", "shadow-replay-abstaining-winner.json");
    require("fs").mkdirSync(path.dirname(output), { recursive: true });
    require("fs").writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output: path.relative(root, output), rows: report.rows,
      eligible: report.eligible, correctGained: report.correctGained, wrongAdded: report.wrongAdded,
      blockedByAbstention: report.blockedByAbstention,
      multiSlotExclusions: report.multiSlotExclusions.length }, null, 2));
  } catch (error) { console.error(error.message || error); process.exit(1); }
}

module.exports = { replay };
