const assert = require("assert");

global.UncensoredRules = require("../src/rules");
const timedText = require("../src/timedtext");

function payload(windowPositions) {
  return JSON.stringify({
    wpWinPositions: windowPositions,
    events: [
      { tStartMs: 0, id: 1 },
      {
        tStartMs: 1000,
        dDurationMs: 10000,
        segs: [{ utf8: "one\nwhat " }, { utf8: "[__]" }, { utf8: " now" }]
      },
      { tStartMs: 5000, dDurationMs: 10000, segs: [{ utf8: "next page" }] }
    ]
  });
}

// The experiment supplies page lifetime as an overlapping duration and has no
// per-word offsets. Use the next fixed page to estimate word time and lifetime.
const fixed = timedText.collectTimedTextData(payload([{ rcRows: 2 }]), false);
assert.strictEqual(fixed.tokens[0].timeSeconds, 3);
assert.strictEqual(fixed.timeline[0].endTime, 5);

// Keep normal caption timing unchanged; deleting the temporary runtime block
// and this test removes experiment support.
const normal = timedText.collectTimedTextData(payload([]), false);
assert.strictEqual(normal.tokens[0].timeSeconds, 6);
assert.strictEqual(normal.timeline[0].endTime, 11);

console.log("experimental-fixed-captions.test.js passed");
