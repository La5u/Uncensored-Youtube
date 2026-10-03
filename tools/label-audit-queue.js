#!/usr/bin/env node
"use strict";

// Diagnostic manifest only, not annotation input or validated scoring evidence.
const fs = require("fs");
const families = [
  ["fuck", "fucks", "fuck's", "fucked", "fucking", "fuckin", "fucker", "fuckers"],
  ["motherfuck", "motherfucker", "motherfuckers", "motherfucking"],
  ["dipshit", "dipshits"]
];
function sameFamily(a, b) {
  return a !== b && families.some(words => words.includes(a) && words.includes(b));
}
function buildQueue(audit) {
  if (!Array.isArray(audit.suspects)) throw new Error("Expected audit.suspects array");
  const confusions = new Map();
  const items = audit.suspects.map(row => {
    if (!row.fixture || !Number.isInteger(row.tokenIndex) || !Number.isFinite(row.time)) {
      throw new Error("Suspect lacks fixture/token/time identity");
    }
    const formCandidate = sameFamily(row.human, row.alt);
    const key = JSON.stringify([row.human, row.alt]);
    confusions.set(key, (confusions.get(key) || 0) + 1);
    return {
      set: row.set, fixture: row.fixture, tokenIndex: row.tokenIndex,
      timeSeconds: row.time, labelSource: row.source,
      humanWord: row.human, alternative: row.alt, votes: { ...row.votes },
      reason: row.swapWith !== undefined ? "possible-slot-swap" :
        formCandidate ? "word-form-review" : "word-or-span-review",
      // Partner timing must be read from the original caption/label, not inferred.
      relatedTokenIndices: row.swapWith === undefined ? [] : [row.swapWith],
      replayStartSeconds: Math.max(0, row.time - 3), replayEndSeconds: row.time + 3
    };
  });
  items.sort((a, b) => a.fixture.localeCompare(b.fixture) || a.timeSeconds - b.timeSeconds);
  return {
    evidenceStatus: "diagnostic only; listen before changing labels; not annotation input",
    items,
    confusions: [...confusions].map(([key, count]) => {
      const [human, alternative] = JSON.parse(key);
      return { human, alternative, count, sameFamily: sameFamily(human, alternative) };
    })
  };
}
if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error("Usage: node tools/label-audit-queue.js AUDIT.json > NEW-DIAGNOSTIC.json");
    process.exitCode = 1;
  } else console.log(JSON.stringify(buildQueue(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))), null, 2));
}
module.exports = { buildQueue, sameFamily };
