#!/usr/bin/env node
"use strict";

// Local-only rule audit.  It replays the current engine; archived evaluator
// decisions and rule fingerprints are evidence sources, never trusted output.
const fs = require("fs");
const path = require("path");
const rules = require("../src/rules");
const data = require("../src/rules-data");
const compiler = require("../src/rules-compiler");
const timedText = require("../src/timedtext");
const whisper = require("../src/whisper-local");
const evaluator = require("./evaluate-whisper-only");
const { buildProvenanceIndex, defaultReports, fixturePairs } = require("./audit-caption-corpus");
const { align, eventText, manualSwearEvents } = require("./evaluation-alignment");
const {
  censoredSlotCount: censoredCount, labeledExpected: expectedArray,
  loadArchivedRows, DEFAULT_REPORTS
} = require("./archived-rules-benchmark");

const root = path.join(__dirname, "..");
const PAIR_CLASSES = new Set(["manual-auto", "auto-auto", "synthetic", "unknown", "conflict"]);
const DEFAULT_PAIR_CLASSES = new Set(["manual-auto"]);
const RECOMMENDATION_ORDER = { remove: 0, retire: 1, narrow: 2, candidate: 3, keep: 4, abstain: 5 };
// Synthetic and auto-auto rows are diagnostic, not promotion evidence.
const REAL_EVIDENCE_PAIR_CLASS = "manual-auto";

function ruleId(rule) {
  return `${rule.groupId || "rule"}:${rule.priority ?? ""}`;
}

function ruleTier(rule) {
  if (rule.groupId?.startsWith("fallback/")) return "fallback";
  if (rule.groupId?.startsWith("low-confidence/")) return "low";
  if (rule.groupId?.startsWith("productive/")) return "productive";
  if (rule.groupId?.startsWith("frames/")) return "frame";
  return "exact";
}

function frameRules() {
  return data.RULE_GROUPS.frames.flatMap((group) => group.patterns.map((pattern, index) => {
    const priority = group.id === "frames/single-intensifier-suffixes"
      ? 5000 * 1000000000 + 31 * 1000000 - 1
      : group.priority * 1000000000 + index * 1000000;
    const rule = compiler.compileFramePattern(pattern, priority, group.id).rule;
    const candidates = rule.candidates.filter((candidate) => candidate.split(/\s+/u)
      .every((word) => rules.RULE_WORDS.includes(word)));
    return candidates.length === rule.candidates.length ? rule : { ...rule, candidates };
  }));
}

function allRuleDefinitions() {
  const seen = new Set();
  return rules.DETERMINISTIC_RULES.concat(frameRules()).filter((rule) => {
    const id = ruleId(rule);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function normalized(value) {
  return whisper.normalizeText(value || "").replace(/\s+/gu, " ").trim();
}

// timedtext deliberately replaces the other blanks in a token's context with
// deterministic words/ellipsis.  That is useful to the runtime, but it is not
// the input on which a rule was matched.  Reconstruct the original event window
// for local fixtures so multi-slot rules can be audited without that rewrite.
function originalTokenContexts(body, contextBefore = 1, contextAfter = 0) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Map();
  }
  if (!payload || !Array.isArray(payload.events)) return new Map();

  const events = [];
  let tokenIndex = 0;
  payload.events.forEach((event, eventIndex) => {
    const text = eventText(event);
    const count = censoredCount(text);
    if (text.trim()) events.push({ eventIndex, text, firstTokenIndex: tokenIndex, count });
    tokenIndex += count;
  });
  const result = new Map();
  events.forEach((event, position) => {
    for (let localIndex = 0; localIndex < event.count; localIndex += 1) {
      const first = Math.max(0, position - contextBefore);
      const last = Math.min(events.length, position + contextAfter + 1);
      const contextEvents = events.slice(first, last);
      const slotIndex = contextEvents.slice(0, position - first)
        .reduce((count, item) => count + item.count, 0) + localIndex;
      result.set(event.firstTokenIndex + localIndex, {
        context: contextEvents.map((item) => item.text).join(" ").replace(/\s+/gu, " ").trim(),
        slotIndex
      });
    }
  });
  return result;
}

function decisionPiece(value, span, offset) {
  const pieces = String(value || "").split(/\s+/u).filter(Boolean);
  return span > 1 && pieces.length === span ? pieces[offset] || "" : String(value || "");
}

function candidatePieces(candidates, span, offset) {
  return [...new Set((candidates || []).map((candidate) =>
    decisionPiece(candidate, span, offset)).filter(Boolean))];
}

function currentChoice(context, slotIndex = 0, disabledRuleTemplate) {
  if (!Number.isInteger(slotIndex) || slotIndex < 0) return null;
  const result = rules.applyDeterministicRules(context, disabledRuleTemplate
    ? { disabledRuleTemplate }
    : undefined);
  const choice = (result.decisions || []).find((decision) => {
    const start = Number.isInteger(decision.tokenIndex) ? decision.tokenIndex : 0;
    const span = Number.isInteger(decision.tokenSpan) && decision.tokenSpan > 0 ? decision.tokenSpan : 1;
    return start <= slotIndex && start + span > slotIndex;
  });
  if (!choice) return null;
  const start = Number.isInteger(choice.tokenIndex) ? choice.tokenIndex : 0;
  const span = Number.isInteger(choice.tokenSpan) && choice.tokenSpan > 0 ? choice.tokenSpan : 1;
  const offset = slotIndex - start;
  return {
    ruleId: ruleId(choice.rule),
    template: choice.rule.template,
    groupId: choice.rule.groupId || "",
    priority: choice.rule.priority,
    tier: choice.tier || ruleTier(choice.rule),
    candidates: candidatePieces(choice.rule.candidates, span, offset),
    word: decisionPiece(choice.word, span, offset),
    decisionWord: choice.word || "",
    tokenIndex: start,
    tokenSpan: span,
    slotOffset: offset,
    source: choice.source || ""
  };
}

function localRows(fixturesDir, provenance, pairClasses) {
  const pairs = fixturePairs(fixturesDir);
  const rows = [];
  for (const [id, pair] of pairs) {
    if (!pair.auto || !pair.manual) continue;
    const record = provenance.get(id) || {};
    const pairClass = record.pairClass || "unknown";
    if (!pairClasses.has(pairClass)) continue;
    let body;
    let manual;
    try {
      body = fs.readFileSync(pair.auto, "utf8");
      manual = JSON.parse(fs.readFileSync(pair.manual, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const originalContexts = originalTokenContexts(body, 1, 0);
    const tokens = timedText.collectTimedTextData(body, false, {
      contextBefore: 1,
      contextAfter: 0
    }).tokens.map((token) => ({
      ...token,
      context: originalContexts.get(token.tokenIndex)?.context || token.context
    }));
    const expected = align(tokens, manualSwearEvents(manual, true)).expected;
    tokens.forEach((token) => {
      const original = originalContexts.get(token.tokenIndex);
      rows.push({
        id: `local:${id}:${token.tokenIndex}`,
        fixture: id,
        tokenIndex: token.tokenIndex,
        slotIndex: original?.slotIndex ?? 0,
        context: original?.context || token.context,
        originalContext: original?.context || "",
        contextFaithful: Boolean(original),
        contextSource: original ? "fixture-original" : "derived-transformed",
        expected: expected.has(token.tokenIndex) ? [expected.get(token.tokenIndex)] : [],
        pairClass,
        creator: record.creator || "",
        creatorId: record.creatorId || "",
        creatorHandle: record.creatorHandle || "",
        sourceKinds: ["local"],
        auditSourceKinds: ["local"],
        sourceFiles: [path.relative(root, fixturesDir) || fixturesDir],
        evidenceEligible: record?.evidenceEligible !== false,
        reportEvidence: record?.reportEvidence || {}
      });
    });
  }
  return rows;
}

function archivedRows(reportPaths, provenanceReports, pairClasses) {
  const loaded = loadArchivedRows(reportPaths, provenanceReports);
  const conflictingIds = new Set(loaded.slotConflictIds || []);
  return {
    rows: loaded.rows.filter((row) => pairClasses.has(row.pairClass)).map((row) => {
      const originalContext = typeof row.originalContext === "string" ? row.originalContext : "";
      const contextFaithful = row.contextFaithful === true && Boolean(originalContext) &&
        (censoredCount(originalContext) <= 1 ||
          (Number.isInteger(row.slotIndex) && row.slotIndex >= 0));
      return {
        ...row,
        id: `archive:${row.id}`,
        slotIndex: Number.isInteger(row.slotIndex) && row.slotIndex >= 0 ? row.slotIndex : 0,
        context: originalContext || row.context,
        originalContext,
        contextFaithful,
        contextSource: contextFaithful ? "archived-original" : "archived-transformed",
        slotConflict: conflictingIds.has(row.id) || Boolean(row.slotConflict),
        sourceKinds: ["archive"],
        auditSourceKinds: ["archive"],
        sourceFiles: [row.source]
      };
    }),
    loaded
  };
}

function observationKey(row) {
  return [row.fixture, row.tokenIndex, row.context, expectedArray(row.expected).join("|")].join("\u0000");
}

function slotKey(row) {
  return [row.fixture, row.tokenIndex].join("\u0000");
}

function sourcePriority(row) {
  // A fixture rebuilt from the original caption wins over an archived context
  // that may already contain replacements.  The ordering is deterministic for
  // duplicate local rows as well.
  return [row.contextFaithful ? 0 : 1, row.sourceKinds?.includes("local") ? 0 : 1,
    row.sourceKinds?.includes("archive") ? 1 : 0];
}

function compareRows(left, right) {
  const leftPriority = sourcePriority(left);
  const rightPriority = sourcePriority(right);
  for (let index = 0; index < leftPriority.length; index += 1) {
    if (leftPriority[index] !== rightPriority[index]) return leftPriority[index] - rightPriority[index];
  }
  return observationKey(left).localeCompare(observationKey(right));
}

function expectedKey(row) {
  return expectedArray(row.expected).map((word) => normalized(word)).join("|");
}

function mergeRows(archive, local) {
  const all = archive.concat(local);
  const archiveKeys = new Set(archive.map(observationKey));
  const localKeys = new Set(local.map(observationKey));
  const archiveSlots = new Set(archive.map(slotKey));
  const localSlots = new Set(local.map(slotKey));
  const bySlot = new Map();
  all.forEach((row) => {
    const key = slotKey(row);
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(row);
  });

  const rows = [];
  const slotConflicts = [];
  for (const [key, variants] of bySlot) {
    const ordered = variants.slice().sort(compareRows);
    const selected = {
      ...ordered[0],
      sourceKinds: [...(ordered[0].sourceKinds || [])],
      sourceFiles: [...(ordered[0].sourceFiles || [])]
    };
    ordered.slice(1).forEach((row) => {
      selected.sourceKinds.push(...(row.sourceKinds || []));
      selected.sourceFiles.push(...(row.sourceFiles || []));
    });
    selected.sourceKinds = [...new Set(selected.sourceKinds)].sort();
    selected.auditSourceKinds = [...new Set(ordered[0].auditSourceKinds || ordered[0].sourceKinds || [])].sort();
    selected.sourceFiles = [...new Set(selected.sourceFiles)].sort();

    const expectedVariants = [...new Set(variants.map(expectedKey))];
    if (expectedVariants.length > 1 || variants.some((row) => row.slotConflict)) {
      selected.slotConflict = true;
      slotConflicts.push({
        slot: key.split("\u0000"),
        selected: observationKey(selected),
        expectedVariants,
        observations: variants.map((row) => ({
          sourceKinds: row.sourceKinds || [],
          sourceFiles: row.sourceFiles || [],
          context: row.context || "",
          expected: expectedArray(row.expected)
        }))
      });
    }
    rows.push(selected);
  }
  return {
    rows,
    slotConflicts,
    overlap: {
      exactObservationCount: [...archiveKeys].filter((key) => localKeys.has(key)).length,
      exactSlotCount: [...archiveSlots].filter((key) => localSlots.has(key)).length,
      archiveOnlyObservations: archiveKeys.size - [...archiveKeys].filter((key) => localKeys.has(key)).length,
      localOnlyObservations: localKeys.size - [...localKeys].filter((key) => archiveKeys.has(key)).length
    }
  };
}

function emptyBucket() {
  return { rows: 0, scoredRows: 0, attempts: 0, correct: 0 };
}

function finishBucket(bucket) {
  return {
    ...bucket,
    precision: bucket.attempts ? bucket.correct / bucket.attempts : 0,
    coverage: bucket.scoredRows ? bucket.correct / bucket.scoredRows : 0
  };
}

function addBucket(bucket, row, attempted, correct) {
  bucket.rows += 1;
  if (!row.expected.length) return;
  bucket.scoredRows += 1;
  if (attempted) bucket.attempts += 1;
  if (correct) bucket.correct += 1;
}

function creatorKey(row) {
  // Match the faithful dataset's identity policy; placeholders are not creators.
  const id = typeof row.creatorId === "string" ? row.creatorId.trim() : "";
  if (/^UC[A-Za-z0-9_-]{22}$/u.test(id)) return `id:${id}`;
  const name = typeof row.creator === "string"
    ? row.creator.trim().normalize("NFKC").replace(/\s+/gu, " ").toLowerCase() : "";
  return name && !/^(?:anonymous|na|n\/a|none|null|unknown)(?: creator)?$/u.test(name)
    ? `name:${name}` : "unknown";
}

function emptyRule(definition) {
  return {
    ruleId: ruleId(definition),
    template: definition.template,
    groupId: definition.groupId || "",
    priority: definition.priority,
    tier: ruleTier(definition),
    candidates: definition.candidates,
    matchedCount: 0,
    scoredMatchedCount: 0,
    evidenceMatchedCount: 0,
    evidenceCandidateCorrectCount: 0,
    evidenceAttemptedCount: 0,
    evidenceCorrectCount: 0,
    realEvidenceMatchedCount: 0,
    realEvidenceCandidateCorrectCount: 0,
    realEvidenceAttemptedCount: 0,
    realEvidenceCorrectCount: 0,
    realEvidenceCreators: new Set(),
    conflictMatchedCount: 0,
    attemptedCount: 0,
    correctCount: 0,
    wrongCount: 0,
    abstainedCount: 0,
    unlabeledAttemptedCount: 0,
    candidateCorrectCount: 0,
    expectedCounts: {},
    predictedCounts: {},
    creatorCounts: new Map(),
    pairClasses: {},
    sources: {},
    overlapRules: {},
    examples: { correct: [], wrong: [], changed: [] },
    without: {
      attempts: 0, correct: 0, wrong: 0, correctLost: 0, wrongAvoided: 0,
      correctGained: 0, wrongIntroduced: 0, predictedCounts: {}, nextRuleCounts: {},
      transitions: {}, overlapCount: 0
    },
    recommendationWithout: { attempts: 0, correct: 0, correctLost: 0, wrongAvoided: 0 }
  };
}

function increment(object, key) {
  const name = key || "<none>";
  object[name] = (object[name] || 0) + 1;
}

function creatorBucket(stat, row) {
  const key = creatorKey(row);
  const bucket = stat.creatorCounts.get(key) || {
    creator: row.creator || (key === "unknown" ? "unknown" : key),
    creatorId: row.creatorId || "",
    matched: 0,
    scored: 0,
    attempts: 0,
    correct: 0,
    wrong: 0,
    labeledEvidence: 0
  };
  stat.creatorCounts.set(key, bucket);
  return bucket;
}

function addRuleOutcome(stat, row, choice, correct, candidateCorrect) {
  const scored = row.expected.length > 0;
  const evidenceEligible = scored && row.pairClass !== "conflict";
  const realEvidenceEligible = scored && row.pairClass === REAL_EVIDENCE_PAIR_CLASS;
  const attempted = Boolean(choice.word);
  stat.matchedCount += 1;
  stat.scoredMatchedCount += Number(scored);
  stat.evidenceMatchedCount += Number(evidenceEligible);
  stat.evidenceCandidateCorrectCount += Number(evidenceEligible && candidateCorrect);
  stat.evidenceAttemptedCount += Number(evidenceEligible && attempted);
  stat.conflictMatchedCount += Number(scored && row.pairClass === "conflict");
  stat.realEvidenceMatchedCount += Number(realEvidenceEligible);
  stat.realEvidenceCandidateCorrectCount += Number(realEvidenceEligible && candidateCorrect);
  stat.realEvidenceAttemptedCount += Number(realEvidenceEligible && attempted);
  stat.attemptedCount += Number(scored && attempted);
  stat.unlabeledAttemptedCount += Number(!scored && attempted);
  stat.correctCount += Number(scored && correct);
  stat.evidenceCorrectCount += Number(evidenceEligible && correct);
  stat.realEvidenceCorrectCount += Number(realEvidenceEligible && correct);
  if (realEvidenceEligible && creatorKey(row) !== "unknown") {
    stat.realEvidenceCreators.add(creatorKey(row));
  }
  stat.wrongCount += Number(scored && attempted && !correct);
  stat.abstainedCount += Number(!attempted);
  stat.candidateCorrectCount += Number(scored && candidateCorrect);
  row.expected.forEach((word) => increment(stat.expectedCounts, normalized(word)));
  if (choice.word) increment(stat.predictedCounts, normalized(choice.word));
  const creator = creatorBucket(stat, row);
  creator.matched += 1;
  creator.scored += Number(scored);
  creator.labeledEvidence += Number(evidenceEligible && creatorKey(row) !== "unknown");
  creator.attempts += Number(scored && attempted);
  creator.correct += Number(scored && correct);
  creator.wrong += Number(scored && attempted && !correct);
  const pair = stat.pairClasses[row.pairClass] || (stat.pairClasses[row.pairClass] = emptyBucket());
  addBucket(pair, row, attempted, correct);
  for (const source of row.auditSourceKinds || row.sourceKinds || []) {
    const sourceBucket = stat.sources[source] || (stat.sources[source] = emptyBucket());
    addBucket(sourceBucket, row, attempted, correct);
  }
  const example = {
    fixture: row.fixture,
    tokenIndex: row.tokenIndex,
    context: row.context,
    expected: row.expected,
    predicted: choice.word || "",
    creator: row.creator || "unknown",
    source: row.auditSourceKinds || row.sourceKinds
  };
  if (scored && correct && stat.examples.correct.length < 3) stat.examples.correct.push(example);
  if (scored && attempted && !correct && stat.examples.wrong.length < 5) stat.examples.wrong.push(example);
}

function resolveInputFiles(files, label, allowEmpty = false) {
  if (!Array.isArray(files) || (!allowEmpty && !files.length)) {
    throw new Error(`At least one ${label} is required.`);
  }
  return files.map((file) => {
    if (typeof file !== "string" || !file.trim()) throw new Error(`Invalid ${label} path.`);
    const resolved = path.resolve(root, file);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`Missing ${label}: ${file}`);
    }
    if (!stat.isFile()) throw new Error(`${label} is not a file: ${file}`);
    return resolved;
  });
}

function readInputJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${path.relative(root, file) || file}`);
  }
}

function validateArchivedReport(file) {
  const report = readInputJson(file, "archived report");
  const where = (message) => { throw new Error(`${message}: ${path.relative(root, file) || file}`); };
  if (!report || typeof report !== "object" || Array.isArray(report) || !Array.isArray(report.fixtures)) where("Invalid archived report fixtures");
  if (report.complete !== undefined && report.complete !== true) where("Archived report is incomplete");
  if (report.mode !== undefined && report.mode !== "rules-only") where("Archived report mode is not rules-only");
  report.fixtures.forEach((fixture, fixtureIndex) => {
    if (!fixture || typeof fixture !== "object" || typeof (fixture.name || fixture.videoId) !== "string" || !(fixture.name || fixture.videoId).trim()) where(`Invalid archived fixture ${fixtureIndex}`);
    if (fixture.results !== undefined && !Array.isArray(fixture.results)) where(`Invalid archived results for fixture ${fixtureIndex}`);
    (fixture.results || []).forEach((row, rowIndex) => {
      const at = (message) => where(`${message} ${fixtureIndex}:${rowIndex}`);
      if (!row || !Number.isSafeInteger(row.tokenIndex) || row.tokenIndex < 0) at("Invalid archived token index");
      if (row.expected !== undefined && (!Array.isArray(row.expected) || row.expected.some((word) => typeof word !== "string" || !word.trim()))) at("Invalid archived expected label");
      if (row.context !== undefined && typeof row.context !== "string") at("Invalid archived context");
      if (row.reviewContext !== undefined && typeof row.reviewContext !== "string") at("Invalid archived review context");
      if (typeof (row.context ?? row.reviewContext) !== "string" || !(row.context ?? row.reviewContext).trim()) at("Archived row has no context");
      if (row.originalContext !== undefined && typeof row.originalContext !== "string") at("Invalid archived original context");
      if (row.contextFaithful !== undefined && typeof row.contextFaithful !== "boolean") at("Invalid archived context fidelity");
      if (row.slotIndex !== undefined && (!Number.isSafeInteger(row.slotIndex) || row.slotIndex < 0)) at("Invalid archived slot index");
      if (row.contextFaithful === true && (!row.originalContext || typeof row.originalContext !== "string")) at("Faithful archived row has no original context");
      if (row.contextFaithful === true && censoredCount(row.originalContext) > 1 && row.slotIndex === undefined) at("Faithful multi-slot row has no slot index");
    });
  });
  return report;
}

function validateProvenanceReport(file) {
  const report = readInputJson(file, "provenance report");
  const where = (message) => { throw new Error(`${message}: ${path.relative(root, file) || file}`); };
  const strings = (object, fields, message, index) => fields.forEach((field) => {
    if (object[field] !== undefined && object[field] !== null && typeof object[field] !== "string") where(`${message} ${field} ${index}`);
  });
  if (!report || typeof report !== "object" || Array.isArray(report)) where("Invalid provenance report");
  if (report.provenance === undefined && report.channels === undefined) where("No provenance entries or channels");
  if (report.provenance !== undefined && !Array.isArray(report.provenance)) where("Invalid provenance entries");
  (report.provenance || []).forEach((group, index) => {
    if (!group || typeof group !== "object" || !Array.isArray(group.ids) || !group.ids.length) where(`Invalid provenance group ${index}`);
    const ids = new Set();
    group.ids.forEach((id) => { if (typeof id !== "string" || !id.trim() || ids.has(id)) where(`Invalid provenance id in group ${index}`); ids.add(id); });
    if (group.pairClass !== undefined && (typeof group.pairClass !== "string" || group.pairClass && !PAIR_CLASSES.has(group.pairClass))) where(`Invalid provenance pair class ${index}`);
    strings(group, ["creator", "creatorId", "creatorHandle"], "Invalid provenance", index);
  });
  if (report.channels !== undefined && !Array.isArray(report.channels)) where("Invalid provenance channels");
  (report.channels || []).forEach((channel, index) => {
    if (!channel || typeof channel !== "object") where(`Invalid provenance channel ${index}`);
    strings(channel, ["creator", "creatorId", "creatorHandle", "name", "channel", "channelId"], "Invalid channel", index);
    if (channel.items !== undefined && !Array.isArray(channel.items)) where(`Invalid provenance channel items ${index}`);
    (channel.items || []).forEach((item, itemIndex) => {
      if (!item || typeof item !== "object") where(`Invalid provenance item ${index}:${itemIndex}`);
      if (item.status === "paired-saved" && (typeof item.id !== "string" || !item.id.trim())) where(`Paired provenance item has no id ${index}:${itemIndex}`);
      if (item.pairClass !== undefined && (typeof item.pairClass !== "string" || item.pairClass && !PAIR_CLASSES.has(item.pairClass))) where(`Invalid item pair class ${index}:${itemIndex}`);
      strings(item, ["creator", "creatorId", "creatorHandle", "channel", "channelId"], "Invalid item", `${index}:${itemIndex}`);
    });
  });
  return report;
}

function validateAuditInputs(reportPaths, provenanceReports) {
  const reports = resolveInputFiles(reportPaths, "archived report");
  const provenance = resolveInputFiles(provenanceReports, "provenance report", true);
  reports.forEach(validateArchivedReport);
  provenance.forEach(validateProvenanceReport);
  return { reports, provenance };
}

function auditCurrentRules({
  fixturesDir = path.join(root, "test-fixtures"),
  reportPaths = DEFAULT_REPORTS,
  provenanceReports = defaultReports(root),
  pairClasses = DEFAULT_PAIR_CLASSES,
  minimumMatches = 4,
  minimumCreators = 2
} = {}) {
  pairClasses = new Set(pairClasses);
  const invalid = [...pairClasses].filter((value) => !PAIR_CLASSES.has(value));
  if (invalid.length) throw new Error(`Unknown pair class: ${invalid.join(", ")}`);
  if (!Number.isInteger(minimumMatches) || minimumMatches < 1 ||
      !Number.isInteger(minimumCreators) || minimumCreators < 1) {
    throw new Error("minimumMatches and minimumCreators must be positive integers.");
  }
  const inputs = validateAuditInputs(reportPaths, provenanceReports);
  reportPaths = inputs.reports;
  provenanceReports = inputs.provenance;
  const provenance = buildProvenanceIndex(provenanceReports);
  const archived = archivedRows(reportPaths, provenanceReports, pairClasses);
  const local = localRows(path.resolve(root, fixturesDir), provenance, pairClasses);
  const merged = mergeRows(archived.rows, local);
  const definitions = allRuleDefinitions();
  const stats = new Map(definitions.map((definition) => [ruleId(definition), emptyRule(definition)]));
  const baseline = emptyBucket();
  const recommendationBaseline = emptyBucket();
  const bySource = {};
  const byPairClass = {};
  const overlaps = new Map();
  const exclusions = { nonFaithfulContext: 0, slotConflict: 0, incompleteProvenance: 0 };

  merged.rows.forEach((row) => {
    row.expected = expectedArray(row.expected);
    // Archived evaluator reports retain transformed contexts, not the original
    // multi-slot input.  They remain in selection/provenance diagnostics, but
    // are not used to make current-rule or deletion claims.
    if (row.slotConflict) {
      exclusions.slotConflict += 1;
      return;
    }
    if (!row.contextFaithful) {
      exclusions.nonFaithfulContext += 1;
      return;
    }
    if (row.evidenceEligible === false) {
      exclusions.incompleteProvenance += 1;
      return;
    }
    const choice = currentChoice(row.context, row.slotIndex);
    const attempted = Boolean(choice?.word);
    const correct = attempted && evaluator.isCorrect(choice.word, row.expected, row.context);
    addBucket(baseline, row, attempted, correct);
    if (row.pairClass === REAL_EVIDENCE_PAIR_CLASS) addBucket(recommendationBaseline, row, attempted, correct);
    for (const source of row.auditSourceKinds || row.sourceKinds || []) addBucket(bySource[source] || (bySource[source] = emptyBucket()), row, attempted, correct);
    addBucket(byPairClass[row.pairClass] || (byPairClass[row.pairClass] = emptyBucket()), row, attempted, correct);
    if (!choice) return;
    const stat = stats.get(choice.ruleId) || emptyRule({
      template: choice.template, groupId: choice.groupId, priority: choice.priority,
      candidates: choice.candidates
    });
    stats.set(choice.ruleId, stat);
    const candidateCorrect = choice.candidates.some((candidate) =>
      evaluator.isCorrect(candidate, row.expected, row.context));
    addRuleOutcome(stat, row, choice, correct, candidateCorrect);

    const alternate = currentChoice(row.context, row.slotIndex, choice.template);
    const alternateWord = alternate?.word || "";
    const alternateCorrect = Boolean(alternateWord) &&
      evaluator.isCorrect(alternateWord, row.expected, row.context);
    increment(stat.without.predictedCounts, normalized(alternateWord));
    increment(stat.without.nextRuleCounts, alternate?.ruleId || "<none>");
    increment(stat.without.transitions, `${normalized(choice.word) || "<none>"} -> ${normalized(alternateWord) || "<none>"}`);
    const alternateAttempted = Boolean(alternateWord);
    const alternateWrong = row.expected.length > 0 && alternateAttempted && !alternateCorrect;
    const currentWrong = row.expected.length > 0 && attempted && !correct;
    stat.without.attempts += Number(alternateAttempted && row.expected.length > 0);
    stat.without.correct += Number(alternateCorrect);
    stat.without.wrong += Number(alternateWrong);
    // These are row-level effects, unlike correctDelta, which is aggregate net coverage.
    stat.without.correctLost += Number(row.expected.length > 0 && correct && !alternateCorrect);
    stat.without.wrongAvoided += Number(currentWrong && !alternateWrong);
    stat.without.correctGained += Number(row.expected.length > 0 && !correct && alternateCorrect);
    if (row.pairClass === REAL_EVIDENCE_PAIR_CLASS) {
      stat.recommendationWithout.attempts += Number(alternateAttempted && row.expected.length > 0);
      stat.recommendationWithout.correct += Number(alternateCorrect);
      stat.recommendationWithout.correctLost += Number(row.expected.length > 0 && correct && !alternateCorrect);
      stat.recommendationWithout.wrongAvoided += Number(currentWrong && !alternateWrong);
    }
    stat.without.wrongIntroduced += Number(row.expected.length > 0 && !currentWrong && alternateWrong);
    if (alternate) {
      stat.without.overlapCount += 1;
      increment(stat.overlapRules, alternate.ruleId);
      const edgeKey = `${choice.ruleId}\u0000${alternate.ruleId}`;
      const edge = overlaps.get(edgeKey) || {
        fromRuleId: choice.ruleId,
        fromTemplate: choice.template,
        toRuleId: alternate.ruleId,
        toTemplate: alternate.template,
        count: 0,
        creators: new Set()
      };
      edge.count += 1;
      const creator = creatorKey(row);
      if (row.expected.length && row.pairClass !== "conflict" && creator !== "unknown") {
        edge.creators.add(creator);
      }
      overlaps.set(edgeKey, edge);
    }
    if (stat.examples.changed.length < 5 && normalized(alternateWord) !== normalized(choice.word)) {
      stat.examples.changed.push({
        ...row,
        predicted: choice.word || "",
        withoutRule: alternateWord,
        nextRule: alternate?.template || "",
        beforeCorrect: Boolean(correct),
        afterCorrect: Boolean(alternateCorrect)
      });
    }
  });

  const baselineFinished = finishBucket(baseline);
  const recommendationBaselineFinished = finishBucket(recommendationBaseline);
  const finalized = [...stats.values()].map((stat) => {
    const afterAttempts = baseline.attempts - stat.attemptedCount + stat.without.attempts;
    const afterCorrect = baseline.correct - stat.correctCount + stat.without.correct;
    const precisionDelta = (afterAttempts ? afterCorrect / afterAttempts : 0) - baselineFinished.precision;
    const correctDelta = afterCorrect - baseline.correct;
    const recommendationAfterAttempts = recommendationBaseline.attempts - stat.realEvidenceAttemptedCount + stat.recommendationWithout.attempts;
    const recommendationAfterCorrect = recommendationBaseline.correct - stat.realEvidenceCorrectCount + stat.recommendationWithout.correct;
    const recommendationPrecisionDelta = (recommendationAfterAttempts
      ? recommendationAfterCorrect / recommendationAfterAttempts : 0) - recommendationBaselineFinished.precision;
    const recommendationCorrectDelta = recommendationAfterCorrect - recommendationBaseline.correct;
    const creatorCount = [...stat.creatorCounts.values()].filter((bucket) => bucket.labeledEvidence > 0).length;
    const evidence = stat.realEvidenceMatchedCount >= minimumMatches && stat.realEvidenceCreators.size >= minimumCreators;
    const candidatePrecision = stat.evidenceMatchedCount
      ? stat.evidenceCandidateCorrectCount / stat.evidenceMatchedCount : 0;
    const realEvidenceCreatorCount = stat.realEvidenceCreators.size;
    const realEvidencePrecision = stat.realEvidenceAttemptedCount
      ? stat.realEvidenceCorrectCount / stat.realEvidenceAttemptedCount : 0;
    const realEvidenceCandidatePrecision = stat.realEvidenceMatchedCount
      ? stat.realEvidenceCandidateCorrectCount / stat.realEvidenceMatchedCount : 0;
    const qualityGate = evaluator.ruleQualityGate({
      template: stat.template,
      matchedCount: stat.realEvidenceMatchedCount,
      candidateCount: stat.candidates.length || 1,
      precision: realEvidencePrecision,
      candidatePrecision: realEvidenceCandidatePrecision,
      creatorCount: realEvidenceCreatorCount
    });
    const qualityEvidence = stat.realEvidenceMatchedCount >= Math.max(
      minimumMatches, qualityGate.minimumSupport
    ) && realEvidenceCreatorCount >= Math.max(minimumCreators, qualityGate.minimumCreators);
    let recommendation;
    let reason;
    if (!stat.evidenceMatchedCount || !evidence) {
      recommendation = "candidate";
      reason = !stat.realEvidenceMatchedCount
        ? (stat.conflictMatchedCount ? "conflicting provenance excluded from evidence" : "no manual-auto labeled matches")
        : "insufficient labeled or creator-diverse support";
    } else if (stat.recommendationWithout.correctLost === 0 && recommendationPrecisionDelta > 0) {
      recommendation = "remove";
      reason = "coverage-preserving deletion improves manual-auto precision";
    } else if (qualityEvidence && !qualityGate.deterministicPassed &&
        stat.recommendationWithout.correctLost > 0 && stat.recommendationWithout.wrongAvoided > 0 && recommendationPrecisionDelta > 0) {
      recommendation = "retire";
      reason = "real evidence fails the deterministic quality gate; precision-first retirement avoids observed wrong outputs";
    } else if (realEvidenceCandidatePrecision > realEvidencePrecision && stat.candidates.length > 1) {
      recommendation = "candidate";
      reason = "candidate set covers more labels than the forced choice";
    } else if (stat.realEvidenceAttemptedCount === stat.realEvidenceCorrectCount) {
      recommendation = stat.realEvidenceAttemptedCount === 0 ? "abstain" : "keep";
      reason = stat.realEvidenceAttemptedCount === 0
        ? "rule abstained on all labeled matches" : "no observed labeled errors";
    } else if (recommendationCorrectDelta < 0) {
      recommendation = "narrow";
      reason = "deletion loses correct answers while errors remain";
    } else {
      recommendation = "keep";
      reason = "deletion is not an aggregate improvement";
    }
    stat.creatorCounts = Object.fromEntries([...stat.creatorCounts.entries()].sort(([left], [right]) => left.localeCompare(right)));
    Object.values(stat.creatorCounts).forEach((bucket) => {
      bucket.precision = bucket.attempts ? bucket.correct / bucket.attempts : 0;
    });
    Object.values(stat.pairClasses).forEach((bucket) => Object.assign(bucket, finishBucket(bucket)));
    Object.values(stat.sources).forEach((bucket) => Object.assign(bucket, finishBucket(bucket)));
    stat.precision = stat.attemptedCount ? stat.correctCount / stat.attemptedCount : 0;
    stat.coverage = stat.scoredMatchedCount ? stat.correctCount / stat.scoredMatchedCount : 0;
    stat.candidatePrecision = candidatePrecision;
    stat.creatorCount = creatorCount;
    stat.realEvidenceCreatorCount = realEvidenceCreatorCount;
    stat.realEvidencePrecision = realEvidencePrecision;
    stat.realEvidenceCandidatePrecision = realEvidenceCandidatePrecision;
    stat.precisionFirstEvidenceSufficient = qualityEvidence;
    stat.qualityGate = qualityGate;
    stat.correctLost = stat.without.correctLost;
    stat.wrongAvoided = stat.without.wrongAvoided;
    stat.aggregatePrecisionDelta = precisionDelta;
    stat.namedCreatorCount = creatorCount;
    stat.evidenceSufficient = evidence;
    stat.overlapCount = stat.without.overlapCount;
    stat.overlapRate = stat.matchedCount ? stat.overlapCount / stat.matchedCount : 0;
    stat.without = {
      ...stat.without,
      precision: stat.without.attempts ? stat.without.correct / stat.without.attempts : 0,
      correctDelta,
      attemptsDelta: afterAttempts - baseline.attempts,
      precisionDelta,
      nextRuleCount: Object.values(stat.without.nextRuleCounts).reduce((sum, value) => sum + value, 0)
    };
    stat.recommendation = recommendation;
    stat.recommendationReason = reason;
    delete stat.realEvidenceCreators;
    return stat;
  }).sort((left, right) => (RECOMMENDATION_ORDER[left.recommendation] ?? Number.MAX_SAFE_INTEGER) -
    (RECOMMENDATION_ORDER[right.recommendation] ?? Number.MAX_SAFE_INTEGER) ||
    right.matchedCount - left.matchedCount || left.ruleId.localeCompare(right.ruleId));

  const toPublicEdge = (edge) => ({ ...edge, creators: [...edge.creators].sort(), creatorCount: edge.creators.size });
  const finishedSources = Object.fromEntries(Object.entries(bySource).map(([key, value]) => [key, finishBucket(value)]));
  const finishedPairs = Object.fromEntries(Object.entries(byPairClass).map(([key, value]) => [key, finishBucket(value)]));
  return {
    version: 2,
    audit: "current-rule-audit",
    limitations: {
      ruleClaims: "faithful original fixture contexts only",
      counterfactualClaims: "faithful original fixture contexts only",
      archivedTransformedContextsExcluded: exclusions.nonFaithfulContext,
      slotConflictsExcluded: exclusions.slotConflict,
      incompleteProvenanceExcluded: exclusions.incompleteProvenance
    },
    generatedAt: new Date().toISOString(),
    ruleSet: {
      rulesFingerprint: evaluator.rulesFingerprint(),
      rulesAuxFingerprint: evaluator.auxiliaryRulesFingerprint(),
      rulesEngineFingerprint: evaluator.rulesEngineFingerprint(),
      deterministicCount: rules.DETERMINISTIC_RULES.length,
      frameCount: frameRules().length,
      totalCount: definitions.length
    },
    selection: {
      pairClasses: [...pairClasses].sort(),
      fixturesDir: path.relative(root, path.resolve(root, fixturesDir)) || fixturesDir,
      reportPaths: reportPaths.map((file) => path.relative(root, path.resolve(root, file)) || file),
      provenanceReports: provenanceReports.map((file) => path.relative(root, path.resolve(root, file)) || file),
      minimumMatches,
      minimumCreators,
      exclusions: { ...exclusions },
      indexedPairCount: provenance.size,
      archivedRetainedRows: archived.rows.length,
      archivedFaithfulRows: archived.rows.filter((row) => row.contextFaithful && !row.slotConflict).length,
      archivedSources: archived.loaded.sources,
      archivedProvenanceSources: archived.loaded.provenanceSources,
      localRows: local.length,
      localFaithfulRows: local.filter((row) => row.contextFaithful && !row.slotConflict).length,
      retainedRows: merged.rows.length,
      auditedRows: baseline.rows,
      excludedRows: exclusions.nonFaithfulContext + exclusions.slotConflict + exclusions.incompleteProvenance,
      nonFaithfulContextRows: exclusions.nonFaithfulContext,
      slotConflictRows: exclusions.slotConflict,
      incompleteProvenanceRows: exclusions.incompleteProvenance,
      slotConflictCount: merged.slotConflicts.length,
      archivedSlotConflictCount: (archived.loaded.slotConflictIds || []).length,
      deduplicatedRows: archived.rows.length + local.length - merged.rows.length
    },
    baseline: {
      ...baselineFinished,
      bySource: finishedSources,
      pairClasses: finishedPairs
    },
    overlap: {
      ...merged.overlap,
      slotConflictCount: merged.slotConflicts.length,
      slotConflicts: merged.slotConflicts,
      rulePairCount: overlaps.size,
      rulePairs: [...overlaps.values()].map(toPublicEdge).sort((left, right) => right.count - left.count ||
        left.fromRuleId.localeCompare(right.fromRuleId) || left.toRuleId.localeCompare(right.toRuleId))
    },
    recommendationCounts: Object.fromEntries(["keep", "retire", "narrow", "candidate", "remove", "abstain"].map((name) => [
      name, finalized.filter((stat) => stat.recommendation === name).length
    ])),
    rules: finalized
  };
}

function parseArgs(argv) {
  const args = {
    fixturesDir: "test-fixtures",
    reportPaths: DEFAULT_REPORTS.slice(),
    provenanceReports: defaultReports(root),
    pairClasses: new Set(DEFAULT_PAIR_CLASSES),
    output: "",
    minimumMatches: 4,
    minimumCreators: 2
  };
  let reportsSpecified = false;
  let provenanceSpecified = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) {
        throw new Error(`Missing value for ${value}.`);
      }
      return argv[++index];
    };
    if (value === "--fixtures") args.fixturesDir = next();
    else if (value === "--report") {
      if (!reportsSpecified) args.reportPaths = [];
      reportsSpecified = true;
      args.reportPaths.push(next());
    } else if (value === "--provenance-report") {
      if (!provenanceSpecified) args.provenanceReports = [];
      provenanceSpecified = true;
      args.provenanceReports.push(next());
    } else if (value === "--pair-class") args.pairClasses = new Set(next().split(",").filter(Boolean));
    else if (value === "--output") args.output = next();
    else if (value === "--minimum-matches") args.minimumMatches = Number(next());
    else if (value === "--minimum-creators") args.minimumCreators = Number(next());
    else throw new Error(`Unknown option: ${value}.`);
  }
  if (!args.reportPaths.length) throw new Error("At least one --report is required.");
  const invalidClasses = [...args.pairClasses].filter((value) => !PAIR_CLASSES.has(value));
  if (invalidClasses.length) throw new Error(`Unknown pair class: ${invalidClasses.join(", ")}`);
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = auditCurrentRules(args);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) {
      const destination = path.resolve(root, args.output);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, output);
      console.log(JSON.stringify({ output: args.output, baseline: report.baseline, recommendations: report.recommendationCounts }, null, 2));
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  allRuleDefinitions,
  auditCurrentRules,
  currentChoice,
  localRows,
  mergeRows,
  parseArgs,
  validateAuditInputs,
  ruleId
};
