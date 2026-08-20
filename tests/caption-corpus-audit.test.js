const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  auditCaptionCorpus,
  buildProvenanceIndex,
  directSlotLabels,
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
  fs.writeFileSync(backfillPath, JSON.stringify({ provenance: [
    { pairClass: "manual-auto", ids: ["abcDEF12345"] },
    { pairClass: "synthetic", ids: ["abcDEF12345"] }
  ] }));
  assert.strictEqual(buildProvenanceIndex([backfillPath]).get("abcDEF12345").pairClass, "conflict");
  const result = auditCaptionCorpus({
    fixturesDir: fixtures,
    reportPaths: [reportPath],
    allowedWords: ["clit", "bitchy", "sissy"]
  });
  assert.strictEqual(result.groups["manual-auto"].pairs, 1);
  assert.strictEqual(result.groups["auto-auto"].pairs, 1);
  assert.strictEqual(result.groups["manual-auto"].alignedSlots, 1);
  assert.deepStrictEqual(result.groups["manual-auto"].unsupportedWordCounts, {});
  assert.deepStrictEqual(result.groups["manual-auto"].visibleWordCounts, {});
  assert.deepStrictEqual(result.groups["manual-auto"].censoredWordCandidates, { bitchy: 1 });
  assert.deepStrictEqual(result.vocabularyCandidates, { bitchy: 1 });
  assert.deepStrictEqual(result.groups["manual-auto"].unsupportedCreators, {});
  assert.deepStrictEqual(result.groups["manual-auto"].absentAllowedWords, ["clit", "sissy"]);
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
