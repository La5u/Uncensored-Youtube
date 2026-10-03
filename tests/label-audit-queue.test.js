"use strict";
const assert = require("assert/strict");
const { buildQueue, sameFamily } = require("../tools/label-audit-queue");
assert.equal(sameFamily("motherfucking", "motherfucker"), true);
assert.equal(sameFamily("fuck's", "fuck"), true);
assert.equal(sameFamily("dipshits", "dipshit"), true);
assert.equal(sameFamily("motherfucker", "fuck"), false);
assert.equal(sameFamily("shit", "fuck"), false);
assert.equal(sameFamily("fuck", "fuck"), false);
const audit = { suspects: [{ set: "frozen", fixture: "video", tokenIndex: 8,
  time: 1, human: "fucking", alt: "shit", votes: { whisper: "shit" },
  swapWith: 7, source: "labels.json" }] };
const before = JSON.stringify(audit);
const queue = buildQueue(audit);
assert.equal(JSON.stringify(audit), before);
assert.equal(queue.items[0].humanWord, "fucking");
assert.equal(queue.items[0].reason, "possible-slot-swap");
assert.deepEqual(queue.items[0].relatedTokenIndices, [7]);
assert.equal(queue.items[0].replayStartSeconds, 0);
queue.items[0].votes.whisper = "fuck";
assert.equal(audit.suspects[0].votes.whisper, "shit");
assert.throws(() => buildQueue({ suspects: [{ fixture: "video", tokenIndex: 1 }] }), /identity/);
console.log("label-audit-queue tests passed");
