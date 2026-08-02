"use strict";

const fs = require("fs");
const path = require("path");
const compiler = require("../src/rules-compiler");
const data = require("../src/rules-data");
const rules = require("../src/rules");
const decision = require("../src/whisper-local");

const input = process.argv[2] || "corpus/generated/paired-rule-slots.json";
const output = process.argv[3] || "corpus/generated/paired-rule-audit.json";
const markdownOutput = /\.json$/i.test(output)
  ? output.replace(/\.json$/i, ".md")
  : `${output}.md`;
const rows = JSON.parse(fs.readFileSync(input, "utf8")).rows;
const SPLITS = ["train", "validation", "test"];

function normalized(value) {
  return decision.normalizeText(value || "").replace(/\s+/g, " ").trim();
}

function isCorrect(word, expected) {
  return normalized(word) === normalized(expected);
}

function increment(counts, key) {
  counts[key || "<abstain>"] = (counts[key || "<abstain>"] || 0) + 1;
}

function topCounts(counts) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

function splitFor(video) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(video)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  const bucket = (hash >>> 0) % 20;
  return bucket < 14 ? "train" : bucket < 17 ? "validation" : "test";
}

function selected(result) {
  const choice = result.decisions[0];
  return choice ? {
    template: choice.rule.template,
    candidates: choice.rule.candidates,
    tier: choice.tier,
    source: choice.source,
    word: choice.word
  } : null;
}

function emptyStats(template, candidates, tier) {
  return {
    template,
    candidates,
    tier,
    matched: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    abstained: 0,
    candidateCorrect: 0,
    expectedCounts: {},
    predictedCounts: {},
    splits: {
      train: { matched: 0, attempts: 0, correct: 0 },
      validation: { matched: 0, attempts: 0, correct: 0 },
      test: { matched: 0, attempts: 0, correct: 0 }
    },
    correctExamples: [],
    wrongExamples: [],
    counterfactual: {
      attempts: 0,
      correct: 0,
      splits: Object.fromEntries(SPLITS.map((name) => [
        name,
        { attempts: 0, correct: 0 }
      ])),
      predictedCounts: {},
      nextRuleCounts: {},
      transitions: {},
      examples: []
    }
  };
}

function metrics(value, totalRows) {
  return {
    ...value,
    precision: value.attempts ? value.correct / value.attempts : null,
    coverage: value.correct / totalRows
  };
}

function recommendationFor(stat, precisionDelta, correctDelta) {
  if (!stat.matched) return "unobserved";
  if (precisionDelta > 0 && correctDelta >= 0) return "pareto-delete";
  if (precisionDelta > 0 && correctDelta < 0) return "precision-tradeoff";
  if (precisionDelta <= 0 && correctDelta > 0) return "coverage-tradeoff";
  if (precisionDelta === 0 && correctDelta === 0) return "neutral";
  return "keep";
}

const frameRules = data.RULE_GROUPS.frames.flatMap((group) => (
  group.patterns.map((pattern) => compiler.compileFramePattern(pattern).rule)
));
const stats = new Map();

rules.DETERMINISTIC_RULES.concat(frameRules).forEach((rule) => {
  if (!stats.has(rule.template)) {
    stats.set(rule.template, emptyStats(rule.template, rule.candidates, "unobserved"));
  }
});
let attempts = 0;
let correct = 0;
const baselineSplits = Object.fromEntries(SPLITS.map((name) => [
  name,
  { rows: 0, attempts: 0, correct: 0 }
]));
const ownedRows = new Map();

rows.forEach((row) => {
  const split = splitFor(row.video);
  baselineSplits[split].rows += 1;
  const choice = selected(rules.applyDeterministicRules(row.context));
  if (!choice) return;

  const stat = stats.get(choice.template) ||
    emptyStats(choice.template, choice.candidates, choice.tier);
  const right = Boolean(choice.word) && isCorrect(choice.word, row.expected);
  const example = {
    video: row.video,
    context: row.context,
    expected: row.expected,
    predicted: normalized(choice.word)
  };

  stats.set(choice.template, stat);
  stat.tier = choice.tier;
  stat.matched += 1;
  increment(stat.expectedCounts, normalized(row.expected));
  increment(stat.predictedCounts, normalized(choice.word));
  stat.splits[split].matched += 1;
  stat.candidateCorrect += choice.candidates.some((candidate) => isCorrect(candidate, row.expected)) ? 1 : 0;
  if (choice.word) {
    attempts += 1;
    baselineSplits[split].attempts += 1;
    stat.attempts += 1;
    stat.splits[split].attempts += 1;
    if (right) {
      correct += 1;
      baselineSplits[split].correct += 1;
      stat.correct += 1;
      stat.splits[split].correct += 1;
      if (stat.correctExamples.length < 3) stat.correctExamples.push(example);
    } else {
      stat.wrong += 1;
      if (stat.wrongExamples.length < 5) stat.wrongExamples.push(example);
    }
  } else {
    stat.abstained += 1;
  }

  if (!ownedRows.has(choice.template)) ownedRows.set(choice.template, []);
  ownedRows.get(choice.template).push(row);
});

ownedRows.forEach((ruleRows, template) => {
  const stat = stats.get(template);
  ruleRows.forEach((row) => {
    const split = splitFor(row.video);
    const baseline = selected(rules.applyDeterministicRules(row.context));
    const alternate = selected(rules.applyDeterministicRules(
      row.context,
      { disabledRuleTemplate: template }
    ));
    const word = alternate && alternate.word || "";
    const right = Boolean(word) && isCorrect(word, row.expected);

    if (word) {
      stat.counterfactual.attempts += 1;
      stat.counterfactual.splits[split].attempts += 1;
    }
    if (right) {
      stat.counterfactual.correct += 1;
      stat.counterfactual.splits[split].correct += 1;
    }
    increment(stat.counterfactual.predictedCounts, normalized(word));
    increment(stat.counterfactual.nextRuleCounts, alternate && alternate.template || "<none>");
    increment(
      stat.counterfactual.transitions,
      `${normalized(baseline && baseline.word) || "<abstain>"} → ` +
        `${normalized(word) || "<abstain>"}`
    );
    if (stat.counterfactual.examples.length < 5 &&
        normalized(word) !== normalized(baseline && baseline.word)) {
      stat.counterfactual.examples.push({
        video: row.video,
        context: row.context,
        expected: row.expected,
        predicted: normalized(baseline && baseline.word),
        withoutRule: normalized(word),
        nextRule: alternate && alternate.template || "",
        beforeCorrect: Boolean(baseline && baseline.word) &&
          isCorrect(baseline.word, row.expected),
        afterCorrect: right
      });
    }
  });
});

const ruleStats = [...stats.values()].map((stat) => {
  const afterAttempts = attempts - stat.attempts + stat.counterfactual.attempts;
  const afterCorrect = correct - stat.correct + stat.counterfactual.correct;
  const precision = stat.attempts ? stat.correct / stat.attempts : null;
  const candidatePrecision = stat.matched ? stat.candidateCorrect / stat.matched : null;
  const afterPrecision = afterAttempts ? afterCorrect / afterAttempts : 0;
  const precisionDelta = afterPrecision - correct / attempts;
  const correctDelta = afterCorrect - correct;
  const recommendation = recommendationFor(stat, precisionDelta, correctDelta);
  const deletionSplits = Object.fromEntries(SPLITS.map((name) => {
    const baseline = baselineSplits[name];
    const current = stat.splits[name];
    const alternate = stat.counterfactual.splits[name];
    const splitAttempts = baseline.attempts - current.attempts + alternate.attempts;
    const splitCorrect = baseline.correct - current.correct + alternate.correct;
    const splitPrecision = splitAttempts ? splitCorrect / splitAttempts : 0;
    return [name, {
      matched: current.matched,
      attempts: splitAttempts,
      correct: splitCorrect,
      precision: splitPrecision,
      coverage: splitCorrect / baseline.rows,
      attemptDelta: splitAttempts - baseline.attempts,
      correctDelta: splitCorrect - baseline.correct,
      precisionDelta: splitPrecision -
        (baseline.attempts ? baseline.correct / baseline.attempts : 0)
    }];
  }));
  const train = deletionSplits.train;
  const validation = deletionSplits.validation;
  const test = deletionSplits.test;
  const trainImproves = train.correctDelta >= 0 && train.precisionDelta > 0;
  const validationImproves = validation.correctDelta >= 0 &&
    validation.precisionDelta >= 0 &&
    (validation.correctDelta > 0 || validation.precisionDelta > 0);
  const testConsistent = test.correctDelta >= 0 && test.precisionDelta >= 0;
  const selectionSupport = stat.splits.train.matched + stat.splits.validation.matched;
  const deletionVerdict = !trainImproves ? "retain"
    : !validation.matched || !validationImproves ? "insufficient-validation"
      : selectionSupport < 10 ? "small-sample"
        : "delete-candidate";
  const deletionType = !stat.attempts ? "abstention-blocker"
    : stat.counterfactual.attempts < stat.attempts ? "bad-attempt-pruner"
      : "shadow-replacement";

  return {
    ...stat,
    precision,
    candidatePrecision,
    deletion: {
      attempts: afterAttempts,
      correct: afterCorrect,
      precision: afterPrecision,
      coverage: afterCorrect / rows.length,
      attemptDelta: afterAttempts - attempts,
      correctDelta,
      precisionDelta,
      splits: deletionSplits
    },
    recommendation,
    deletionVerdict,
    deletionType,
    selectionSupport,
    testConsistent
  };
}).sort((left, right) => (
  ({
    "pareto-delete": 0,
    "precision-tradeoff": 1,
    "coverage-tradeoff": 2,
    neutral: 3,
    keep: 4,
    unobserved: 5
  })[left.recommendation] -
  ({
    "pareto-delete": 0,
    "precision-tradeoff": 1,
    "coverage-tradeoff": 2,
    neutral: 3,
    keep: 4,
    unobserved: 5
  })[right.recommendation] ||
  right.matched - left.matched ||
  left.template.localeCompare(right.template)
));

const recommendationNames = [
  "pareto-delete",
  "precision-tradeoff",
  "coverage-tradeoff",
  "neutral",
  "keep",
  "unobserved"
];
const deletionCandidates = ruleStats.filter((rule) => (
  rule.deletionVerdict === "delete-candidate"
)).map((rule) => rule.template);

function evaluate(disabledRuleTemplates) {
  const values = Object.fromEntries(SPLITS.map((name) => [
    name,
    { rows: 0, attempts: 0, correct: 0 }
  ]));
  rows.forEach((row) => {
    const split = splitFor(row.video);
    const value = values[split];
    value.rows += 1;
    const choice = selected(rules.applyDeterministicRules(row.context, {
      disabledRuleTemplates
    }));
    if (!choice || !choice.word) return;
    value.attempts += 1;
    if (isCorrect(choice.word, row.expected)) value.correct += 1;
  });
  return Object.fromEntries(SPLITS.map((name) => [
    name,
    metrics(values[name], values[name].rows)
  ]));
}

const report = {
  input,
  rows: rows.length,
  rules: ruleStats.length,
  baseline: {
    attempts,
    correct,
    precision: correct / attempts,
    coverage: correct / rows.length,
    splits: Object.fromEntries(SPLITS.map((name) => [
      name,
      metrics(baselineSplits[name], baselineSplits[name].rows)
    ]))
  },
  recommendations: Object.fromEntries(recommendationNames.map((name) => [
    name,
    ruleStats.filter((rule) => rule.recommendation === name).length
  ])),
  deletionCandidates: {
    count: deletionCandidates.length,
    templates: deletionCandidates,
    combined: evaluate(deletionCandidates)
  },
  ruleStats
};

function percent(value) {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function cell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const potentialRules = ruleStats.filter((rule) => (
  rule.recommendation === "pareto-delete" || rule.deletionVerdict !== "retain"
));
const detailLines = potentialRules.flatMap((rule) => [
  `### ${cell(rule.template)}`,
  "",
  `- Verdict: ${rule.deletionVerdict}; ${rule.deletionType}; tier ${rule.tier}.`,
  `- Candidates: ${rule.candidates.join(", ") || "none"}.`,
  `- Current: ${rule.correct}/${rule.attempts} correct, ${percent(rule.precision)} precision; ` +
    `${rule.abstained} abstentions across ${rule.matched} matches.`,
  `- Candidate inclusion: ${rule.candidateCorrect}/${rule.matched} ` +
    `(${percent(rule.candidatePrecision)}).`,
  `- Expected distribution: ${topCounts(rule.expectedCounts) || "none"}.`,
  `- Current predictions: ${topCounts(rule.predictedCounts) || "none"}.`,
  `- Without-rule predictions: ${topCounts(rule.counterfactual.predictedCounts) || "none"}.`,
  `- Revealed rules: ${topCounts(rule.counterfactual.nextRuleCounts) || "none"}.`,
  `- Decision transitions: ${topCounts(rule.counterfactual.transitions) || "none"}.`,
  `- Without this rule: Δ attempts ${rule.deletion.attemptDelta}, ` +
    `Δ correct ${rule.deletion.correctDelta}, ` +
    `Δ precision ${(rule.deletion.precisionDelta * 100).toFixed(4)} pp.`,
  `- Split Δ correct/precision: train ${rule.deletion.splits.train.correctDelta}/` +
    `${(rule.deletion.splits.train.precisionDelta * 100).toFixed(4)} pp; validation ` +
    `${rule.deletion.splits.validation.correctDelta}/` +
    `${(rule.deletion.splits.validation.precisionDelta * 100).toFixed(4)} pp; test ` +
    `${rule.deletion.splits.test.correctDelta}/` +
    `${(rule.deletion.splits.test.precisionDelta * 100).toFixed(4)} pp.`,
  "",
  ...(rule.wrongExamples.length ? [
    "Observed errors:",
    "",
    ...rule.wrongExamples.map((example) => (
      `- ${cell(example.context)} — expected ${example.expected}, predicted ` +
      `${example.predicted || "abstain"} (${example.video})`
    )),
    ""
  ] : []),
  ...(rule.counterfactual.examples.length ? [
    "Changed decisions when removed:",
    "",
    ...rule.counterfactual.examples.map((example) => (
      `- ${cell(example.context)} — expected ${example.expected}; ` +
      `${example.predicted || "abstain"} → ${example.withoutRule || "abstain"} via ` +
      `${example.nextRule || "no later rule"} (${example.video})`
    )),
    ""
  ] : [])
]);

const markdown = [
  "# Paired-caption rule audit",
  "",
  `Rows: ${report.rows.toLocaleString()}. Rules/components: ${report.rules.toLocaleString()}.`,
  "",
  `Baseline: ${report.baseline.correct.toLocaleString()} correct / ` +
    `${report.baseline.attempts.toLocaleString()} attempts = ` +
    `${percent(report.baseline.precision)} precision, ${percent(report.baseline.coverage)} coverage.`,
  "",
  "| Split | Rows | Attempts | Correct | Precision | Coverage |",
  "|---|---:|---:|---:|---:|---:|",
  ...SPLITS.map((name) => {
    const value = report.baseline.splits[name];
    return `| ${name} | ${value.rows} | ${value.attempts} | ${value.correct} | ` +
      `${percent(value.precision)} | ${percent(value.coverage)} |`;
  }),
  "",
  "A `pareto-delete` result means the one-rule removal improved aggregate precision " +
    "without losing a correct answer. Tradeoffs are not deletion recommendations.",
  "",
  "Deletion candidates use train and validation only. Test results are reported as a " +
    "locked consistency check and never affect selection.",
  "",
  `${report.deletionCandidates.count} rules improved train and did not regress validation. ` +
    "Their combined result (diagnostic only):",
  "",
  "| Split | Attempts | Correct | Precision | Coverage |",
  "|---|---:|---:|---:|---:|",
  ...SPLITS.map((name) => {
    const value = report.deletionCandidates.combined[name];
    return `| ${name} | ${value.attempts} | ${value.correct} | ` +
      `${percent(value.precision)} | ${percent(value.coverage)} |`;
  }),
  "",
  "| Status | Tier | Rule | Matched | Attempts | Correct | Rule P | Candidate P | " +
    "Δ correct | Δ precision | Val ΔC/P | Test ΔC/P | Verdict |",
  "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ...ruleStats.map((rule) => (
    `| ${rule.recommendation} | ${rule.tier} | ${cell(rule.template)} | ` +
    `${rule.matched} | ${rule.attempts} | ${rule.correct} | ${percent(rule.precision)} | ` +
    `${percent(rule.candidatePrecision)} | ${rule.deletion.correctDelta} | ` +
    `${(rule.deletion.precisionDelta * 100).toFixed(4)} pp | ` +
    `${rule.deletion.splits.validation.correctDelta}/` +
    `${(rule.deletion.splits.validation.precisionDelta * 100).toFixed(4)} pp | ` +
    `${rule.deletion.splits.test.correctDelta}/` +
    `${(rule.deletion.splits.test.precisionDelta * 100).toFixed(4)} pp | ` +
    `${rule.deletionVerdict}/${rule.deletionType} |`
  )),
  "",
  "## Potential-deletion details",
  "",
  ...detailLines
].join("\n");

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(markdownOutput, markdown);
console.log(JSON.stringify({
  output,
  markdownOutput,
  rules: report.rules,
  baseline: report.baseline,
  recommendations: report.recommendations
}, null, 2));
