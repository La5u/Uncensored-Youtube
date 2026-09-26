const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  auditCaptionCorpus,
  buildProvenanceIndex,
  directSlotLabels,
  reportEvidenceStatus,
  fixturePart
} = require("../tools/audit-caption-corpus");

assert.deepStrictEqual(fixturePart("abcDEF12345_(title)_auto.en.json3"), {
  id: "abcDEF12345",
  kind: "auto"
});
assert.deepStrictEqual(directSlotLabels({ events: [{
  tStartMs: 1, dDurationMs: 2, segs: [{ utf8: "a [__] tail" }]
}] }, { events: [{
  tStartMs: 1, dDurationMs: 2, segs: [{ utf8: "a bitchy tail" }]
}] }), {
  labels: ["bitchy"],
  slotCount: 1,
  unknown: {}
});
assert.deepStrictEqual(directSlotLabels({ events: [{
  tStartMs: 1, dDurationMs: 2, segs: [{ utf8: "chicken [__] cowards" }]
}] }, { events: [{
  tStartMs: 1, dDurationMs: 2, segs: [{ utf8: "chicken shit cowards" }]
}] }), {
  labels: ["shit"],
  slotCount: 1,
  unknown: {}
});
assert.strictEqual(reportEvidenceStatus({ queueComplete: true, channels: [{ queueComplete: false }] }), "incomplete");
assert.strictEqual(reportEvidenceStatus({ queueComplete: false }), "incomplete");
assert.strictEqual(reportEvidenceStatus({ channels: [{ queueComplete: true }] }), "complete");
assert.strictEqual(reportEvidenceStatus({}), "legacy");
assert.throws(() => reportEvidenceStatus({ queueComplete: "yes" }), /boolean/);
assert.throws(() => reportEvidenceStatus({ channels: [{ queueComplete: 1 }] }), /boolean/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "caption-audit-"));
try {
  const fixtures = path.join(temp, "fixtures");
  fs.mkdirSync(fixtures);
  const reportPath = path.join(temp, "report.json");
  const backfillPath = path.join(temp, "backfill.json");
  const writeCaption = (name, text) => fs.writeFileSync(
    path.join(fixtures, name), JSON.stringify({ events: [{ segs: [{ utf8: text }] }] })
  );
  writeCaption("abcDEF12345_auto.en.json3", "[__]");
  writeCaption("abcDEF12345_manual.en.json3", "bitchy");
  writeCaption("zzzZZZ12345_auto.en.json3", "[__]");
  writeCaption("zzzZZZ12345_manual.en.json3", "sissy");
  writeCaption("incmp123456_auto.en.json3", "[__]");
  writeCaption("incmp123456_manual.en.json3", "clit");
  fs.writeFileSync(reportPath, JSON.stringify({ channels: [{ name: "Test Creator", items: [
    { id: "abcDEF12345", status: "paired-saved", pairKind: "creator-manual", creatorId: "UCtest" },
    { id: "zzzZZZ12345", status: "paired-saved", pairKind: "auto-en" },
    { id: "unknown12345", status: "paired-saved", pairKind: "future-kind" },
    { id: "explicit1234", status: "paired-saved", pairKind: "creator-manual",
      creator: "Explicit Creator", creatorId: "UCexplicit" }
  ] }] }));
  fs.writeFileSync(backfillPath, JSON.stringify({ provenance: [{
    pairClass: "synthetic", creatorHandle: "@backfill", ids: ["backfill123"]
  }] }));
  const incompletePath = path.join(temp, "incomplete.json");
  fs.writeFileSync(incompletePath, JSON.stringify({ queueComplete: false, provenance: [
    { pairClass: "manual-auto", ids: ["incmp123456"] },
    { pairClass: "manual-auto", ids: ["conflict12345"] }
  ] }));
  const completePath = path.join(temp, "complete.json");
  fs.writeFileSync(completePath, JSON.stringify({ queueComplete: true, provenance: [
    { pairClass: "auto-auto", ids: ["conflict12345"] }
  ] }));

  const index = buildProvenanceIndex([reportPath]);
  assert.strictEqual(index.get("abcDEF12345").pairClass, "manual-auto");
  assert.strictEqual(index.get("abcDEF12345").creator, "Test Creator");
  assert.strictEqual(index.get("abcDEF12345").creatorId, "UCtest");
  assert.strictEqual(index.get("explicit1234").creator, "Explicit Creator");
  assert.strictEqual(index.get("explicit1234").creatorId, "UCexplicit");
  assert.strictEqual(index.get("zzzZZZ12345").pairClass, "auto-auto");
  assert.strictEqual(index.get("unknown12345").pairClass, "unknown");
  assert.strictEqual(buildProvenanceIndex([backfillPath]).get("backfill123").pairClass, "synthetic");
  assert.strictEqual(buildProvenanceIndex([backfillPath]).get("backfill123").creatorHandle,
    "@backfill");
  assert.strictEqual(buildProvenanceIndex([reportPath, backfillPath]).get("backfill123").pairClass, "synthetic");
  const incompleteOnly = buildProvenanceIndex([incompletePath]).get("incmp123456");
  assert.strictEqual(incompleteOnly.pairClass, "manual-auto");
  assert.strictEqual(incompleteOnly.evidenceEligible, false);
  assert.deepStrictEqual(incompleteOnly.reportEvidence, { [incompletePath]: "incomplete" });
  const contradiction = buildProvenanceIndex([incompletePath, completePath]).get("conflict12345");
  assert.strictEqual(contradiction.pairClass, "conflict");
  assert.strictEqual(contradiction.evidenceEligible, true);
  const unknownSupportPath = path.join(temp, "unknown-support.json");
  fs.writeFileSync(unknownSupportPath, JSON.stringify({ provenance: [
    { pairClass: "unknown", ids: ["incmp123456"] }
  ] }));
  assert.strictEqual(buildProvenanceIndex([incompletePath, unknownSupportPath])
    .get("incmp123456").evidenceEligible, false);
  fs.writeFileSync(backfillPath, JSON.stringify({ provenance: [
    { pairClass: "manual-auto", ids: ["abcDEF12345"] },
    { pairClass: "synthetic", ids: ["abcDEF12345"] }
  ] }));
  assert.strictEqual(buildProvenanceIndex([backfillPath]).get("abcDEF12345").pairClass, "conflict");
  const result = auditCaptionCorpus({
    fixturesDir: fixtures,
    reportPaths: [reportPath, incompletePath],
    allowedWords: ["clit", "bitchy", "sissy"]
  });
  assert.strictEqual(result.groups["manual-auto"].pairs, 2);
  assert.strictEqual(result.groups["auto-auto"].pairs, 1);
  assert.strictEqual(result.groups["manual-auto"].alignedSlots, 2);
  assert.deepStrictEqual(result.groups["manual-auto"].unsupportedWordCounts, {});
  assert.deepStrictEqual(result.groups["manual-auto"].visibleWordCounts, {});
  assert.deepStrictEqual(result.groups["manual-auto"].censoredWordCandidates, { bitchy: 1 });
  assert.deepStrictEqual(result.vocabularyCandidates, { bitchy: 1 });
  assert.strictEqual(result.groups["manual-auto"].wordCounts.clit, 1);
  assert.deepStrictEqual(result.groups["manual-auto"].unsupportedCreators, {});
  assert.deepStrictEqual(result.groups["manual-auto"].absentAllowedWords, ["sissy"]);
  assert.strictEqual(result.groups["auto-auto"].alignedSlots, 1);
  assert.deepStrictEqual(result.groups["auto-auto"].censoredWordCandidates, {});
  assert.deepStrictEqual(result.groups["auto-auto"].unsupportedWordCounts, {});
  assert.deepStrictEqual(result.groups["auto-auto"].absentAllowedWords, ["clit", "bitchy"]);
  const filtered = auditCaptionCorpus({
    fixturesDir: fixtures,
    reportPaths: [reportPath],
    allowedWords: ["clit", "sissy"],
    notCensoredWords: ["bitchy"]
  });
  assert.deepStrictEqual(filtered.vocabularyCandidates, {});
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
const canonical = require("../tools/caption-pair-provenance.json");
assert.deepStrictEqual(
  canonical.provenance.reduce((counts, group) => {
    counts[group.pairClass] = (counts[group.pairClass] || 0) + group.ids.length;
    return counts;
  }, {}),
  { "manual-auto": 852, "auto-auto": 1, synthetic: 3 }
);
assert.strictEqual(new Set(canonical.provenance.flatMap((group) => group.ids)).size, 856);
console.log("caption-corpus-audit.test.js passed");
