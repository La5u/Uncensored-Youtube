#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");
const evaluator = require("./evaluate-whisper-only");
const { buildProvenanceIndex, defaultReports } = require("./audit-caption-corpus");

const root = path.join(__dirname, "..");
const DEFAULT_REPORTS = [
  "corpus/generated/paired-rules-only-report.json",
  "corpus/generated/youtube-rules-only-improved-final.json",
  "corpus/generated/unpaired-rules-only-final.json"
];
const DEFAULT_PROVENANCE_REPORTS = defaultReports(root);
const DEFAULT_OUTPUT = "corpus/generated/archived-rules-benchmark-summary.json";
const DEFAULT_MINIMUM_SLOTS = 200000;
const PAIR_CLASSES = ["synthetic", "manual-auto", "auto-auto", "unknown", "conflict"];
const PAIRED_RULES_REPORT = "paired-rules-only-report.json";

function labeledExpected(value) {
  return Array.isArray(value) ? value.filter((word) => String(word || "").trim()) : [];
}

function censoredSlotCount(value) {
  return (String(value || "").match(/\[\s*__\s*\]/gu) || []).length;
}

function parseMinimumSlots(value) {
  const minimumSlots = Number(value);
  if (!Number.isSafeInteger(minimumSlots) || minimumSlots < 0) {
    throw new Error("--minimum-slots must be a non-negative integer.");
  }
  return minimumSlots;
}

function sourceLabel(file) {
  const absolute = path.resolve(root, file);
  return path.relative(root, absolute) || absolute;
}

function sha256File(file) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(path.resolve(root, file))).digest("hex")}`;
}

function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function benchmarkPairClass(record) {
  return record && PAIR_CLASSES.includes(record.pairClass) ? record.pairClass : "unknown";
}

function provenanceFields(record) {
  return {
    pairClass: benchmarkPairClass(record),
    creator: record?.creator || "unknown",
    creatorId: record?.creatorId || "",
    creatorHandle: record?.creatorHandle || "",
    evidenceEligible: record?.evidenceEligible !== false,
    reportEvidence: record?.reportEvidence || {}
  };
}

function isPreferredSyntheticSource(source) {
  const name = path.basename(source);
  return name === PAIRED_RULES_REPORT || /^(?:paired|paired-rules-only)\.json$/u.test(name);
}

function shouldReplaceFixture(previous, candidate, selectionPolicy) {
  const previousFaithfulRows = previous.rows.filter((row) => row.contextFaithful).length;
  const candidateFaithfulRows = candidate.rows.filter((row) => row.contextFaithful).length;
  if (candidateFaithfulRows !== previousFaithfulRows) return candidateFaithfulRows > previousFaithfulRows;
  if (selectionPolicy === "source-precedence") {
    if (candidate.pairClass === "synthetic") {
      const candidatePreferred = isPreferredSyntheticSource(candidate.source);
      const previousPreferred = isPreferredSyntheticSource(previous.source);
      if (candidatePreferred !== previousPreferred) return candidatePreferred;
    }
    // The caller supplies reports in a stable path order.  Unlike the legacy
    // policy, selection never changes because one version has more labels.
    return compareText(candidate.source, previous.source) < 0;
  }
  if (candidate.pairClass === "synthetic") {
    const candidatePreferred = isPreferredSyntheticSource(candidate.source);
    const previousPreferred = isPreferredSyntheticSource(previous.source);
    if (candidatePreferred !== previousPreferred) return candidatePreferred;
    // Synthetic overlaps use report priority, never a changing label count.
    return candidate.sourceIndex < previous.sourceIndex;
  }
  // Reports are processed by priority, so a strict comparison keeps the
  // earlier report's candidate when labeled-row counts tie.
  return candidate.labeledRows > previous.labeledRows;
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function membershipSort(left, right) {
  return compareText(left.join("\u0000"), right.join("\u0000"));
}

function normalizedObservationContext(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim()
    .replace(/\[\s*__\s*\]/gu, "[__]").toLowerCase();
}

function observationKey(row) {
  return JSON.stringify([
    normalizedObservationContext(row.context),
    row.expected.map((word) => String(word).trim().toLowerCase()),
    row.pairClass,
    row.creator,
    row.creatorId,
    row.creatorHandle
  ]);
}

function loadArchivedRows(reportPaths = DEFAULT_REPORTS,
  provenanceReports = DEFAULT_PROVENANCE_REPORTS, options = {}) {
  const selectionPolicy = options.selectionPolicy || "labeled-rows";
  const resolvedProvenanceReports = provenanceReports.map((file) => path.resolve(root, file));
  const provenance = buildProvenanceIndex(resolvedProvenanceReports);
  const fixtureVersions = new Map();
  const observationsById = new Map();
  const sources = reportPaths.map((file) => ({
    path: sourceLabel(file),
    sha256: sha256File(file),
    inputRows: 0,
    inputLabeledRows: 0,
    inputUnlabeledRows: 0,
    retainedRows: 0,
    retainedLabeledRows: 0,
    retainedUnlabeledRows: 0
  }));
  let inputRows = 0;
  let duplicateFixtureVersions = 0;
  let duplicateFixtures = 0;
  const repeatedFixtureIds = new Set();

  reportPaths.forEach((file, sourceIndex) => {
    const report = JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8"));
    for (const [fixtureOccurrenceIndex, fixture] of (report.fixtures || []).entries()) {
      const fixtureId = String(fixture && (fixture.name || fixture.videoId) || "");
      if (!fixtureId) continue;
      const fields = provenanceFields(provenance.get(fixtureId));
      const rows = [];
      for (const raw of fixture.results || []) {
        if (!raw || !Number.isInteger(raw.tokenIndex)) continue;
        const expected = labeledExpected(raw.expected);
        const row = {
          id: JSON.stringify([fixtureId, raw.tokenIndex]),
          fixture: fixtureId,
          tokenIndex: raw.tokenIndex,
          context: String(raw.context ?? raw.reviewContext ?? ""),
          originalContext: typeof raw.originalContext === "string" ? raw.originalContext : "",
          contextFaithful: typeof raw.originalContext === "string" && raw.originalContext.trim().length > 0 &&
            raw.contextFaithful !== false &&
            (censoredSlotCount(raw.originalContext) <= 1 ||
              (Number.isSafeInteger(raw.slotIndex) && raw.slotIndex >= 0)),
          slotIndex: Number.isSafeInteger(raw.slotIndex) && raw.slotIndex >= 0 ? raw.slotIndex : 0,
          expected,
          labeled: expected.length > 0,
          source: sources[sourceIndex].path,
          sourceIndex,
          fixtureOccurrenceIndex,
          ...fields
        };
        rows.push(row);
        const observations = observationsById.get(row.id) || [];
        observations.push(row);
        observationsById.set(row.id, observations);
        inputRows += 1;
        sources[sourceIndex].inputRows += 1;
        sources[sourceIndex][row.labeled ? "inputLabeledRows" : "inputUnlabeledRows"] += 1;
      }

      const candidate = {
        rows,
        labeledRows: rows.filter((row) => row.labeled).length,
        source: sources[sourceIndex].path,
        sourceIndex,
        ...fields
      };
      const previous = fixtureVersions.get(fixtureId);
      if (!previous) {
        fixtureVersions.set(fixtureId, candidate);
        continue;
      }

      duplicateFixtureVersions += 1;
      if (!repeatedFixtureIds.has(fixtureId)) {
        repeatedFixtureIds.add(fixtureId);
        duplicateFixtures += 1;
      }
      if (shouldReplaceFixture(previous, candidate, selectionPolicy)) fixtureVersions.set(fixtureId, candidate);
    }
  });

  const slots = new Map();
  for (const candidate of fixtureVersions.values()) {
    for (const row of candidate.rows) {
      // The fixture version is selected before slots are keyed, so rows from
      // competing caption versions can never be mixed.
      if (!slots.has(row.id) || (row.contextFaithful && !slots.get(row.id).contextFaithful)) {
        slots.set(row.id, row);
      }
    }
  }

  const slotConflictIds = new Set();
  for (const row of slots.values()) {
    // Diagnostics from a discarded whole-fixture version must not poison the
    // selected version. Same-source duplicates within that version remain a
    // real conflict.
    const observations = (observationsById.get(row.id) || []).filter((observation) =>
      observation.sourceIndex === row.sourceIndex &&
      observation.fixtureOccurrenceIndex === row.fixtureOccurrenceIndex);
    if (new Set(observations.map(observationKey)).size > 1) slotConflictIds.add(row.id);
    const source = sources[row.sourceIndex];
    source.retainedRows += 1;
    source[row.labeled ? "retainedLabeledRows" : "retainedUnlabeledRows"] += 1;
  }
  const rows = [...slots.values()].map(({ sourceIndex, fixtureOccurrenceIndex, ...row }) => row);
  const selectedFixtures = [...fixtureVersions].map(([fixture, candidate]) => [
    fixture, candidate.source, candidate.pairClass, candidate.creator
  ]).sort(membershipSort);
  const selectedRows = rows.map((row) => [row.fixture, String(row.tokenIndex), row.source])
    .sort(membershipSort);
  const duplicateSlots = [];
  const exactDuplicateSlots = [];
  const conflicts = [];
  [...observationsById.entries()].sort(([left], [right]) => compareText(left, right))
    .forEach(([id, observations]) => {
      if (observations.length < 2) return;
      const signatures = new Set(observations.map(observationKey));
      const detail = {
        id,
        fixture: observations[0].fixture,
        tokenIndex: observations[0].tokenIndex,
        occurrences: observations.length,
        sources: [...new Set(observations.map((row) => row.source))].sort(compareText)
      };
      duplicateSlots.push(detail);
      if (signatures.size === 1) exactDuplicateSlots.push(detail);
      else conflicts.push({
        ...detail,
        observations: observations.map((row) => ({
          source: row.source,
          context: row.context,
          expected: row.expected.slice(),
          pairClass: row.pairClass,
          creator: row.creator,
          creatorId: row.creatorId,
          creatorHandle: row.creatorHandle
        })).sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)))
      });
    });
  const provenanceSources = resolvedProvenanceReports.map((file) => ({
    path: sourceLabel(file),
    sha256: sha256File(file)
  }));
  return {
    rows,
    inputRows,
    duplicateRows: inputRows - rows.length,
    duplicateFixtures,
    duplicateFixtureVersions,
    selectedFixtureVersions: fixtureVersions.size,
    sources,
    provenanceSources,
    indexedPairCount: provenance.size,
    selectedFixtureMembershipHash: sha256Json(selectedFixtures),
    selectedRowMembershipHash: sha256Json(selectedRows),
    slotConflictIds: [...slotConflictIds].sort(compareText),
    duplicateDiagnostics: {
      duplicateSlots,
      exactDuplicateSlots,
      conflicts,
      conflictFixtures: [...new Set(conflicts.map((conflict) => conflict.fixture))].sort(compareText)
    },
    selectionPolicy
  };
}

function emptyReplayStats() {
  return {
    replayedSlots: 0,
    predictedSlots: 0,
    labeled: { slots: 0, attemptedCount: 0, correctCount: 0 },
    unlabeled: { slots: 0, predictedCount: 0 },
    fixtures: new Set(),
    creators: new Map()
  };
}

function finishReplayStats(stats) {
  stats.labeled.precision = stats.labeled.attemptedCount
    ? stats.labeled.correctCount / stats.labeled.attemptedCount : 0;
  stats.labeled.coverage = stats.labeled.slots ? stats.labeled.correctCount / stats.labeled.slots : 0;
  stats.labeled.accuracy = stats.labeled.coverage;
  stats.unlabeled.predictionRate = stats.unlabeled.slots
    ? stats.unlabeled.predictedCount / stats.unlabeled.slots : 0;
  const creators = Object.fromEntries([...stats.creators.entries()].sort(([left], [right]) =>
    left.localeCompare(right)).map(([creator, value]) => [creator, {
    fixtureCount: value.fixtures.size,
    slots: value.slots
  }]));
  const { fixtures, creators: creatorMap, ...result } = stats;
  result.fixtureCount = fixtures.size;
  result.creators = creators;
  return result;
}

function replayArchivedRows(rows) {
  const overall = emptyReplayStats();
  const groups = Object.fromEntries(PAIR_CLASSES.map((pairClass) => [pairClass, emptyReplayStats()]));

  for (const row of rows) {
    const pairClass = PAIR_CLASSES.includes(row.pairClass) ? row.pairClass : "unknown";
    const targets = [overall, groups[pairClass]];
    const creator = row.creator || "unknown";
    const decision = rules.applyDeterministicRules(row.context).decisions[0] || null;
    const predicted = decision && decision.word || "";
    for (const target of targets) {
      target.replayedSlots += 1;
      target.fixtures.add(row.fixture);
      const creatorStats = target.creators.get(creator) || { fixtures: new Set(), slots: 0 };
      creatorStats.fixtures.add(row.fixture);
      creatorStats.slots += 1;
      target.creators.set(creator, creatorStats);
      if (predicted) {
        target.predictedSlots += 1;
        if (!row.labeled) target.unlabeled.predictedCount += 1;
      }
      if (!row.labeled) {
        target.unlabeled.slots += 1;
        continue;
      }
      target.labeled.slots += 1;
      if (predicted) {
        target.labeled.attemptedCount += 1;
        if (evaluator.isCorrect(predicted, row.expected, row.context)) {
          target.labeled.correctCount += 1;
        }
      }
    }
  }

  const result = finishReplayStats(overall);
  result.pairClasses = Object.fromEntries(Object.entries(groups).map(([pairClass, stats]) => [
    pairClass, finishReplayStats(stats)
  ]));
  return result;
}

function runArchivedBenchmark({ reportPaths = DEFAULT_REPORTS,
  provenanceReports = DEFAULT_PROVENANCE_REPORTS, outputPath = DEFAULT_OUTPUT,
  minimumSlots = DEFAULT_MINIMUM_SLOTS } = {}) {
  minimumSlots = parseMinimumSlots(minimumSlots);
  const loaded = loadArchivedRows(reportPaths, provenanceReports);
  const conflictingIds = new Set(loaded.slotConflictIds);
  const replayRows = loaded.rows.filter((row) => !conflictingIds.has(row.id));
  const excludedConflictSlots = loaded.rows.length - replayRows.length;
  if (replayRows.length < minimumSlots) {
    throw new Error(`Archived benchmark retained ${replayRows.length} replayable slots ` +
      `(excluded ${excludedConflictSlots} conflicting slots); minimum-slots is ${minimumSlots}.`);
  }
  const replay = replayArchivedRows(replayRows);
  if (replay.replayedSlots < minimumSlots) {
    throw new Error(`Archived benchmark replayed ${replay.replayedSlots} slots; ` +
      `minimum-slots is ${minimumSlots}.`);
  }
  const report = {
    version: 2,
    benchmark: "archived-rules-regression",
    generatedAt: new Date().toISOString(),
    complete: true,
    selectionPolicy: {
      fixtureVersion: "whole-fixture",
      syntheticPreferredSource: PAIRED_RULES_REPORT
    },
    sources: loaded.sources,
    provenance: {
      reports: loaded.provenanceSources,
      indexedPairCount: loaded.indexedPairCount
    },
    integrity: {
      algorithm: "sha256",
      sourceHashes: Object.fromEntries(loaded.sources.map((source) => [source.path, source.sha256])),
      provenanceHashes: Object.fromEntries(loaded.provenanceSources.map((source) => [source.path, source.sha256])),
      selectedFixtureMembershipHash: loaded.selectedFixtureMembershipHash,
      selectedRowMembershipHash: loaded.selectedRowMembershipHash
    },
    rulesFingerprint: evaluator.rulesFingerprint(),
    rulesAuxFingerprint: evaluator.auxiliaryRulesFingerprint(),
    rulesEngineFingerprint: evaluator.rulesEngineFingerprint(),
    summary: {
      inputRows: loaded.inputRows,
      duplicateRows: loaded.duplicateRows,
      duplicateFixtures: loaded.duplicateFixtures,
      duplicateFixtureVersions: loaded.duplicateFixtureVersions,
      selectedFixtureVersions: loaded.selectedFixtureVersions,
      retainedSlots: loaded.rows.length,
      excludedConflictSlots,
      // Archive replay remains diagnostic; promotion consumers exclude these rows.
      incompleteProvenanceSlots: replayRows.filter((row) => row.evidenceEligible === false).length,
      replayedSlots: replay.replayedSlots,
      predictedSlots: replay.predictedSlots,
      labeledSlots: replay.labeled.slots,
      unlabeledSlots: replay.unlabeled.slots,
      labeled: replay.labeled,
      unlabeled: replay.unlabeled,
      pairClasses: replay.pairClasses
    }
  };
  const destination = path.resolve(root, outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function parseArgs(argv) {
  const args = { reportPaths: DEFAULT_REPORTS, provenanceReports: DEFAULT_PROVENANCE_REPORTS,
    outputPath: DEFAULT_OUTPUT, minimumSlots: DEFAULT_MINIMUM_SLOTS };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") args.outputPath = argv[++index];
    else if (argv[index] === "--minimum-slots") args.minimumSlots = parseMinimumSlots(argv[++index]);
    else if (argv[index] === "--provenance-report") {
      if (args.provenanceReports === DEFAULT_PROVENANCE_REPORTS) args.provenanceReports = [];
      args.provenanceReports.push(argv[++index]);
    } else throw new Error(`Unknown option ${argv[index]}.`);
  }
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = runArchivedBenchmark(args);
    console.log(JSON.stringify({ output: args.outputPath, summary: report.summary }, null, 2));
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = { DEFAULT_REPORTS, DEFAULT_PROVENANCE_REPORTS, DEFAULT_MINIMUM_SLOTS,
  censoredSlotCount, compareText, labeledExpected, loadArchivedRows, replayArchivedRows,
  runArchivedBenchmark, parseArgs };
