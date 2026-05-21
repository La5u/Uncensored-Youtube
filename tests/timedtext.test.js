const assert = require("assert");
const timedText = require("../src/timedtext");

const payload = {
  wireMagic: "pb3",
  events: [
    {
      tStartMs: 42000,
      dDurationMs: 2500,
      wWinId: 1,
      segs: [
        { utf8: "\"Timmy," },
        { utf8: " what", tOffsetMs: 960 },
        { utf8: " the", tOffsetMs: 1200 },
        { utf8: " [\u00a0__\u00a0]", tOffsetMs: 1440 },
        { utf8: " are", tOffsetMs: 1680 },
        { utf8: " you", tOffsetMs: 1919 }
      ]
    },
    {
      tStartMs: 44480,
      dDurationMs: 3919,
      wWinId: 1,
      segs: [
        { utf8: "hello" },
        { utf8: " [\u00a0__\u00a0]" },
        { utf8: " world" }
      ]
    },
    {
      tStartMs: 47000,
      dDurationMs: 1200,
      wWinId: 1,
      segs: [
        { utf8: "Stop." },
        { utf8: " [\u00a0__\u00a0]" },
        { utf8: " hell" }
      ]
    },
    {
      tStartMs: 49000,
      dDurationMs: 1200,
      wWinId: 1,
      segs: [
        { utf8: "oh" },
        { utf8: " [\u00a0__\u00a0]" },
        { utf8: " Timmy" }
      ]
    },
    {
      tStartMs: 51000,
      dDurationMs: 1200,
      wWinId: 1,
      segs: [
        { utf8: "Nice." }
      ]
    },
    {
      tStartMs: 52000,
      dDurationMs: 1200,
      wWinId: 1,
      segs: [
        { utf8: "[\u00a0__\u00a0]" },
        { utf8: " yeah." }
      ]
    },
    {
      tStartMs: 53000,
      dDurationMs: 1200,
      wWinId: 1,
      segs: [
        { utf8: "Holy" },
        { utf8: " [\u00a0__\u00a0]" }
      ]
    },
    {
      tStartMs: 54000,
      dDurationMs: 1200,
      wWinId: 1,
      segs: [
        { utf8: "There's more." }
      ]
    },
    {
      tStartMs: 55000,
      dDurationMs: 1200,
      wWinId: 1,
      segs: [
        { utf8: "Holy" }
      ]
    },
    {
      tStartMs: 56000,
      dDurationMs: 1200,
      wWinId: 1,
      segs: [
        { utf8: "[\u00a0__\u00a0]" },
        { utf8: " if something" }
      ]
    }
  ]
};

const result = timedText.patchTimedTextJson(payload);

assert.strictEqual(result.patchCount, 6);
assert.strictEqual(payload.events[0].segs.map((seg) => seg.utf8).join(""), "\"Timmy, what the fuck are you");
assert.strictEqual(payload.events[1].segs[1].utf8, " [\u00a0__\u00a0]");
assert.strictEqual(payload.events[2].segs.map((seg) => seg.utf8).join(""), "Stop. Fucking hell");
assert.strictEqual(payload.events[3].segs.map((seg) => seg.utf8).join(""), "oh shit. (or fuck) Timmy");
assert.strictEqual(payload.events[5].segs.map((seg) => seg.utf8).join(""), "Fuck yeah.");
assert.strictEqual(payload.events[6].segs.map((seg) => seg.utf8).join(""), "Holy shit. (or fuck)");
assert.strictEqual(payload.events[9].segs.map((seg) => seg.utf8).join(""), "shit (or fuck) if something");
assert.ok(!payload.pens || !payload.pens.some((pen) => pen.fcForeColor === 8421504));
assert.ok(payload.events[3].segs.every((seg) => typeof seg.penId === "undefined"));
assert.ok(payload.events[6].segs.every((seg) => typeof seg.penId === "undefined"));

const body = JSON.stringify(payload);
assert.strictEqual(timedText.patchTimedTextBody(body), body);

console.log("timedtext.test.js passed");
