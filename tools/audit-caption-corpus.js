#!/usr/bin/env node
"use strict";

// Audit existing caption fixtures without contacting YouTube.  Pair filenames
// do not retain whether `_manual` is a real manual track or an alternate
// uncensored automatic track, so report metadata is applied first and unknown
// pairs stay visible instead of being silently mixed into either corpus.
const fs = require("fs");
const path = require("path");
const rules = require("../src/rules-data");
const { classifyPairKind } = require("./download-paired-captions");
const timedText = require("../src/timedtext");
const {
  align, eventText, groundTruthWords, manualSwearEvents, normalizeCompoundLabel
} = require("./evaluation-alignment");

const PAIR_CLASSES = new Set(["manual-auto", "auto-auto", "synthetic", "conflict"]);
const AUDIT_CLASSES = new Set([...PAIR_CLASSES, "unknown"]);
const EVIDENCE_POLICY = "exclude-explicitly-incomplete-v1";

function fixturePart(name) {
  const match = String(name).match(/^([A-Za-z0-9_-]{11}).*_(auto|manual)\.en\.json3$/u);
  return match ? { id: match[1], kind: match[2] } : null;
}

function fixturePairs(fixturesDir) {
  const pairs = new Map();
  if (!fs.existsSync(fixturesDir)) return pairs;
  fs.readdirSync(fixturesDir).forEach((name) => {
    const part = fixturePart(name);
    if (!part) return;
    const pair = pairs.get(part.id) || {};
    pair[part.kind] = path.join(fixturesDir, name);
    pairs.set(part.id, pair);
  });
  return pairs;
}

function mergeCounts(target, source) {
  Object.entries(source).forEach(([word, count]) => {
    target[word] = (target[word] || 0) + count;
  });
  return target;
}

function metadataText(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && !/^(?:NA|N\/A|unknown)$/iu.test(text) ? text : "";
}

function reportEvidenceStatus(report) {
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  if (hasOwn(report, "queueComplete") && typeof report.queueComplete !== "boolean") {
    throw new TypeError("report queueComplete must be boolean");
  }
  const channels = Array.isArray(report.channels) ? report.channels : [];
  channels.forEach((channel) => {
    if (hasOwn(channel, "queueComplete") && typeof channel.queueComplete !== "boolean") {
      throw new TypeError("channel queueComplete must be boolean");
    }
  });
  if (report.queueComplete === false || channels.some((channel) => channel.queueComplete === false)) {
    return "incomplete";
  }
  if (report.queueComplete === true || (channels.length > 0 &&
      channels.every((channel) => channel.queueComplete === true))) {
    return "complete";
  }
  return "legacy";
}

function reportPairItems(reportPaths) {
  return reportPaths.flatMap((reportPath) => {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch {
      return [];
    }
    const evidenceStatus = reportEvidenceStatus(report);
    const backfill = (report.provenance || []).flatMap((group) => (group.ids || []).map((id) => ({
      id: String(id),
      pairClass: PAIR_CLASSES.has(group.pairClass) ? group.pairClass : "unknown",
      pairKind: group.pairKind || "",
      creator: metadataText(group.creator),
      creatorId: metadataText(group.creatorId),
      creatorHandle: metadataText(group.creatorHandle),
      report: reportPath,
      evidenceStatus
    })));
    const downloads = (report.channels || []).flatMap((channel) => (channel.items || [])
      .filter((item) => item.status === "paired-saved" && item.id)
      .map((item) => {
        const mapped = classifyPairKind(item.pairKind);
        const pairClass = PAIR_CLASSES.has(item.pairClass)
          ? item.pairClass
          : mapped.pairClass;
        return {
          id: String(item.id),
          pairClass: PAIR_CLASSES.has(pairClass) ? pairClass : "unknown",
          pairKind: item.pairKind || "",
          creator: metadataText(item.creator) || metadataText(channel.creator) ||
            metadataText(channel.name) || metadataText(item.channel),
          creatorId: metadataText(item.creatorId) || metadataText(channel.creatorId) ||
            metadataText(channel.channelId),
          creatorHandle: metadataText(item.creatorHandle) || metadataText(channel.creatorHandle),
          report: reportPath,
          evidenceStatus
        };
      }));
    return backfill.concat(downloads);
  });
}

function buildProvenanceIndex(reportPaths) {
  const records = new Map();
  reportPairItems(reportPaths).forEach((item) => {
    const record = records.get(item.id) || { id: item.id, classes: new Set(),
      pairKinds: new Set(), creators: new Set(), creatorIds: new Set(),
      creatorHandles: new Set(), reports: new Set(), reportEvidence: {}, eligibleClasses: new Set() };
    if (item.pairClass !== "unknown") record.classes.add(item.pairClass);
    if (item.pairKind) record.pairKinds.add(item.pairKind);
    if (item.creator) record.creators.add(item.creator);
    if (item.creatorId) record.creatorIds.add(item.creatorId);
    if (item.creatorHandle) record.creatorHandles.add(item.creatorHandle);
    record.reports.add(item.report);
    record.reportEvidence[item.report] = item.evidenceStatus;
    if (item.evidenceStatus !== "incomplete") record.eligibleClasses.add(item.pairClass);
    records.set(item.id, record);
  });
  return new Map([...records].map(([id, record]) => {
    const classes = [...record.classes];
    const creators = [...record.creators].sort();
    const creatorIds = [...record.creatorIds].sort();
    const creatorHandles = [...record.creatorHandles].sort();
    return [id, {
      id,
      pairClass: classes.length === 1 ? classes[0] : classes.length ? "conflict" : "unknown",
      pairKinds: [...record.pairKinds].sort(),
      creator: creators.length === 1 ? creators[0] : "",
      creatorId: creatorIds.length === 1 ? creatorIds[0] : "",
      creatorHandle: creatorHandles.length === 1 ? creatorHandles[0] : "",
      creators,
      reports: [...record.reports].sort(),
      reportEvidence: Object.fromEntries(Object.entries(record.reportEvidence).sort()),
      evidenceEligible: classes.length === 1 ? record.eligibleClasses.has(classes[0]) : record.eligibleClasses.size > 0
    }];
  }));
}

function emptyGroup() {
  return {
    pairs: 0,
    censoredSlots: 0,
    alignedSlots: 0,
    wordCounts: {},
    visibleWordCounts: {},
    unsupportedWordCounts: {},
    unsupportedCreators: {},
    unknownSlotTexts: {},
    eligibleWordCounts: {}
  };
}

function directSlotLabels(auto, manual) {
  if ((auto.events || []).length !== (manual.events || []).length ||
      !(auto.events || []).every((event, index) => (
        event.tStartMs === manual.events[index].tStartMs &&
        event.dDurationMs === manual.events[index].dDurationMs
      ))) return null;
  const labels = [];
  const unknown = {};
  let slotCount = 0;
  for (let index = 0; index < auto.events.length; index += 1) {
    const parts = eventText(auto.events[index]).split(/\[\s*__\s*\]/u);
    if (parts.length === 1) continue;
    slotCount += parts.length - 1;
    const source = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*?)");
    const match = new RegExp(`^${source}$`, "su").exec(eventText(manual.events[index]));
    if (!match) return null;
    match.slice(1).forEach((value) => {
      const words = groundTruthWords(value);
      if (words.length === 1) labels.push(normalizeCompoundLabel(words[0], eventText(auto.events[index])));
      else {
        const text = value.toLowerCase().replace(/\s+/gu, " ").trim() || "(empty)";
        unknown[text] = (unknown[text] || 0) + 1;
      }
    });
  }
  return { labels, slotCount, unknown };
}

function auditCaptionCorpus({
  fixturesDir,
  reportPaths = [],
  allowedWords = rules.ALLOWED_WORDS,
  notCensoredWords = rules.NOT_CENSORED_WORDS,
  pairClasses = AUDIT_CLASSES
}) {
  const provenance = buildProvenanceIndex(reportPaths);
  const notCensored = new Set(notCensoredWords);
  const pairs = fixturePairs(fixturesDir);
  const groups = {
    "manual-auto": emptyGroup(),
    "auto-auto": emptyGroup(),
    synthetic: emptyGroup(),
    unknown: emptyGroup(),
    conflict: emptyGroup()
  };
  const unpaired = [];
  for (const [id, pair] of pairs) {
    if (!pair.auto || !pair.manual) {
      unpaired.push({ id, hasAuto: Boolean(pair.auto), hasManual: Boolean(pair.manual) });
      continue;
    }
    const provenanceRecord = provenance.get(id) || {};
    const pairClass = provenanceRecord.pairClass || "unknown";
    if (!pairClasses.has(pairClass)) continue;
    const group = groups[pairClass] || groups.unknown;
    let autoBody;
    let auto;
    let manual;
    try {
      autoBody = fs.readFileSync(pair.auto, "utf8");
      auto = JSON.parse(autoBody);
      manual = JSON.parse(fs.readFileSync(pair.manual, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const direct = directSlotLabels(auto, manual);
    const visibleText = (auto.events || []).map(eventText).join(" ")
      .replace(/\[\s*__\s*\]/gu, " ");
    const visibleCounts = {};
    groundTruthWords(visibleText).forEach((word) => {
      visibleCounts[word] = (visibleCounts[word] || 0) + 1;
    });
    const tokens = direct ? null : timedText.collectTimedTextData(autoBody, false).tokens;
    // Unknown non-identical tracks cannot be assigned to a trustworthy source
    // tier, so avoid an expensive speculative alignment until provenance is recovered.
    const expected = direct ? direct.labels
      : pairClass === "unknown" || pairClass === "conflict" ? []
        : [...align(tokens, manualSwearEvents(manual, true)).expected.values()];
    const targetCounts = {};
    expected.forEach((word) => { targetCounts[word] = (targetCounts[word] || 0) + 1; });
    const allowed = new Set(allowedWords);
    const unsupported = Object.fromEntries(Object.entries(targetCounts)
      .filter(([word]) => !allowed.has(word)));
    group.pairs += 1;
    group.censoredSlots += direct ? direct.slotCount : tokens.length;
    group.alignedSlots += expected.length;
    mergeCounts(group.wordCounts, targetCounts);
    mergeCounts(group.visibleWordCounts, visibleCounts);
    if (provenanceRecord.evidenceEligible) {
      mergeCounts(group.eligibleWordCounts, targetCounts);
    }
    mergeCounts(group.unsupportedWordCounts, unsupported);
    if (provenanceRecord.creator) {
      Object.keys(unsupported).forEach((word) => {
        const creators = group.unsupportedCreators[word] || [];
        if (!creators.includes(provenanceRecord.creator)) creators.push(provenanceRecord.creator);
        group.unsupportedCreators[word] = creators;
      });
    }
    if (direct) mergeCounts(group.unknownSlotTexts, direct.unknown);
  }
  Object.entries(groups).forEach(([pairClass, group]) => {
    Object.values(group.unsupportedCreators).forEach((creators) => creators.sort());
    group.distinctWords = Object.keys(group.wordCounts).length;
    group.unalignedSlots = group.censoredSlots - group.alignedSlots;
    group.absentAllowedWords = allowedWords.filter((word) => !group.wordCounts[word]);
    // Only manual-auto pairs are authoritative for vocabulary discovery.
    // Keep the other tiers' word counts and visible-label diagnostics, but do
    // not expose them as additions that a later pass could promote.
    group.censoredWordCandidates = pairClass === "manual-auto"
      ? Object.fromEntries(Object.entries(group.eligibleWordCounts)
        .filter(([word]) => !group.visibleWordCounts[word] && !notCensored.has(word)))
      : {};
    group.visibleWordCandidates = Object.fromEntries(Object.entries(group.wordCounts)
      .filter(([word]) => group.visibleWordCounts[word] || notCensored.has(word)));
    delete group.eligibleWordCounts;
  });
  return {
    version: 1,
    fixturesDir,
    reports: reportPaths,
    allowedWordCount: allowedWords.length,
    indexedPairCount: provenance.size,
    vocabularyCandidates: groups["manual-auto"].censoredWordCandidates,
    groups,
    unpaired,
    provenance: [...provenance.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
}

function defaultReports(root) {
  const generated = path.join(root, "corpus/generated");
  const reports = fs.existsSync(generated) ? fs.readdirSync(generated)
    .filter((name) => /^(?:paired-caption|synthetic-auto|caption-growth).*\.json$/u.test(name))
    .map((name) => path.join(generated, name))
    .filter((file) => {
      try {
        const report = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(report.provenance) || Array.isArray(report.channels);
      } catch {
        // Keep malformed matching inputs visible to callers that validate
        // provenance rather than silently dropping them.
        return true;
      }
    }).sort() : [];
  const backfill = path.join(root, "tools/caption-pair-provenance.json");
  return fs.existsSync(backfill) ? reports.concat(backfill) : reports;
}

function parseArgs(argv) {
  const root = path.join(__dirname, "..");
  const args = {
    fixtures: path.join(root, "test-fixtures"),
    reports: defaultReports(root),
    pairClasses: new Set(AUDIT_CLASSES),
    output: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixtures") args.fixtures = argv[++index];
    else if (value === "--report") args.reports.push(argv[++index]);
    else if (value === "--pair-class") args.pairClasses = new Set(argv[++index].split(","));
    else if (value === "--output") args.output = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  const invalidClasses = [...args.pairClasses].filter((value) => !AUDIT_CLASSES.has(value));
  if (invalidClasses.length) throw new Error(`Unknown pair class: ${invalidClasses.join(", ")}`);
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const result = auditCaptionCorpus({
    fixturesDir: path.resolve(args.fixtures),
    reportPaths: args.reports.map((file) => path.resolve(file)),
    pairClasses: args.pairClasses
  });
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) fs.writeFileSync(path.resolve(args.output), output);
  else process.stdout.write(output);
}

module.exports = {
  auditCaptionCorpus,
  buildProvenanceIndex,
  EVIDENCE_POLICY,
  reportEvidenceStatus,
  reportPairItems,
  defaultReports,
  directSlotLabels,
  fixturePairs,
  fixturePart
};
