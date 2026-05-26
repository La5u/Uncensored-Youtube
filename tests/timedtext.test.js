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
assert.strictEqual(payload.events[0].segs.length, 6);
assert.strictEqual(payload.events[0].segs[3].utf8, " fuck");
assert.strictEqual(payload.events[0].segs[3].tOffsetMs, 1440);
assert.strictEqual(payload.events[1].segs[1].utf8, " [\u00a0__\u00a0]");
assert.strictEqual(payload.events[2].segs.map((seg) => seg.utf8).join(""), "Stop. Fucking hell");
assert.strictEqual(payload.events[3].segs.map((seg) => seg.utf8).join(""), "oh shit. Timmy");
assert.strictEqual(payload.events[5].segs.map((seg) => seg.utf8).join(""), "Fuck yeah.");
assert.strictEqual(payload.events[6].segs.map((seg) => seg.utf8).join(""), "Holy shit.");
assert.strictEqual(payload.events[9].segs.map((seg) => seg.utf8).join(""), "shit if something");
assert.ok(!payload.pens || !payload.pens.some((pen) => pen.fcForeColor === 8421504));
assert.ok(payload.events[3].segs.every((seg) => typeof seg.penId === "undefined"));
assert.ok(payload.events[6].segs.every((seg) => typeof seg.penId === "undefined"));

const body = JSON.stringify(payload);
assert.strictEqual(timedText.patchTimedTextBody(body), body);

const splitPayload = {
  events: [
    {
      segs: [
        { utf8: "Bull " },
        { utf8: "[__]", tOffsetMs: 100 }
      ]
    },
    {
      segs: [
        { utf8: "[__]", tOffsetMs: 200 },
        { utf8: ", dude.", tOffsetMs: 300 }
      ]
    }
  ]
};
const splitResult = timedText.patchTimedTextJson(splitPayload);

assert.strictEqual(splitResult.patchCount, 1);
assert.strictEqual(splitPayload.events[0].segs.map((seg) => seg.utf8).join(""), "Bull fucking");
assert.strictEqual(splitPayload.events[1].segs.map((seg) => seg.utf8).join(""), "shit, dude.");
assert.strictEqual(splitPayload.events[0].segs[1].utf8, "fucking");
assert.strictEqual(splitPayload.events[1].segs[0].utf8, "shit");
assert.strictEqual(splitPayload.events[0].segs[1].tOffsetMs, 100);
assert.strictEqual(splitPayload.events[1].segs[0].tOffsetMs, 200);

const audioPayload = {
  events: [
    {
      tStartMs: 10000,
      segs: [
        { utf8: "hello " },
        { utf8: "[__]", tOffsetMs: 750 }
      ]
    }
  ]
};

const tokens = timedText.collectTimedTextTokens(JSON.stringify(audioPayload));

assert.strictEqual(tokens.length, 1);
assert.strictEqual(tokens[0].timeSeconds, 10.75);
assert.deepStrictEqual(tokens[0].candidates.includes("fuck"), true);

const deterministicPayload = {
  events: [
    {
      tStartMs: 1000,
      segs: [
        { utf8: "Holy " },
        { utf8: "[__]", tOffsetMs: 250 }
      ]
    },
    {
      tStartMs: 2000,
      segs: [
        { utf8: "what the " },
        { utf8: "[__]", tOffsetMs: 250 }
      ]
    }
  ]
};
const deterministicTokens = timedText.collectTimedTextTokens(JSON.stringify(deterministicPayload));

assert.strictEqual(deterministicTokens.length, 2);
assert.strictEqual(deterministicTokens[0].deterministicWord, "shit");
assert.ok(deterministicTokens[0].candidates.includes("shit"));
assert.ok(deterministicTokens[0].candidates.includes("fuck"));
assert.strictEqual(deterministicTokens[1].deterministicWord, "fuck");

const ambiguousPayload = {
  events: [
    {
      tStartMs: 1000,
      segs: [
        { utf8: "oh " },
        { utf8: "[__]", tOffsetMs: 250 }
      ]
    }
  ]
};
const ambiguousTokens = timedText.collectTimedTextTokens(JSON.stringify(ambiguousPayload));

assert.strictEqual(ambiguousTokens.length, 1);
assert.strictEqual(ambiguousTokens[0].deterministicWord, "shit");
assert.deepStrictEqual(ambiguousTokens[0].deterministicCandidates, ["shit", "fuck"]);

const multiTokenPayload = {
  events: [
    {
      tStartMs: 1000,
      segs: [
        { utf8: "oh " },
        { utf8: "[__]", tOffsetMs: 100 },
        { utf8: " oh " },
        { utf8: "[__]", tOffsetMs: 200 },
        { utf8: " oh " },
        { utf8: "[__]", tOffsetMs: 300 }
      ]
    }
  ]
};
const multiTokens = timedText.collectTimedTextTokens(JSON.stringify(multiTokenPayload), false);

assert.deepStrictEqual(multiTokens.map((token) => token.eventTokenIndex), [0, 1, 2]);

const overridePayload = {
  events: [
    {
      segs: [
        { utf8: "what the " },
        { utf8: "[__]" },
        { utf8: " did you just " },
        { utf8: "[__]" },
        { utf8: " call me" }
      ]
    }
  ]
};
const overrideBody = timedText.patchTimedTextBodyWithOverrides(JSON.stringify(overridePayload), [
  { tokenIndex: 1, word: "fucking" }
], true);
const overrideResult = JSON.parse(overrideBody);

assert.strictEqual(overrideResult.events[0].segs.map((seg) => seg.utf8).join(""), "what the fuck did you just fucking call me");

console.log("timedtext.test.js passed");
