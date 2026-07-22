const assert = require("assert");
const whisper = require("../src/whisper-local");

assert.strictEqual(
  whisper.decisionFromTranscript(
    "What the fuck did you just f* call me?",
    ["fuck", "fucking"],
    "What the fuck did you just [__] call",
    { fCandidates: ["fucking"] }
  ).word,
  "fucking"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "What the fuck did you just fucking call me?",
    ["fuck", "fucking"],
    "What the fuck did you just [__] call",
    { fCandidates: ["fucking"] }
  ).word,
  "fucking"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "called being f* nonchalant",
    ["fuck", "fucking"],
    "called being [__] nonchalant. Like, I",
    { fCandidates: ["fucking"] }
  ).word,
  "fucking"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "shut the f* up",
    ["fuck", "fucking"],
    "shut the [__] up",
    { fCandidates: ["fuck"] }
  ).word,
  "fuck"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "Fuck, you know that get your shit together fucking",
    ["fuck", "shit", "fucking"],
    "get your [__] together",
    { previousWord: "your" }
  ).word,
  "shit"
);

assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "Fuck, you know that get your shit together. Fuck, I want to hit you too, asshole.",
    ["fuck", "shit", "asshole"],
    "get your [__] together [__] I want to hit you too [__]",
    { slotCount: 3, previousWords: ["your", "together", "too"] }
  ).slotWords,
  ["shit", "fuck", "asshole"]
);

assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "Get your shit together fucking hit you to asshole, but well the one fucking",
    ["fuck", "shit", "fucking", "asshole"],
    "[__] I want to hit you too [__]",
    { slotCount: 2, previousWords: ["together", "too"] }
  ).slotWords,
  ["fucking", "asshole"]
);

assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "say fuck shit now",
    ["fuck", "shit"],
    "say [__] [__] now",
    { slotCount: 2, previousWords: ["say", "say"], previousWordOffsets: [0, 1] }
  ).slotWords,
  ["fuck", "shit"]
);

assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "Fuck you and they asked, you fucking piece of fucking shit of fucking hate you.",
    ["fuck", "fucking", "shit"],
    "[__] piece of [__] [__] up [__]",
    {
      slotCount: 4,
      previousWords: ["you", "of", "of", "up"],
      previousWordOffsets: [0, 0, 1, 0]
    }
  ).slotWords,
  ["fucking", "fucking", "shit", "fucking"]
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "you can do it even if this is a ship storm",
    ["fuck", "shit", "fucking"],
    "this is a [__] storm",
    {}
  ).word,
  "shit"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "what do you think of going dipshits to get back",
    ["fuck", "shit", "fucking"],
    "going dip [__] to get",
    {}
  ).word,
  "shit"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "why do you have to be such a beach",
    ["bitch", "fuck", "shit"],
    "such a [__]",
    {}
  ).word,
  "bitch"
);

assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "He's a cloth. Greg is a cook shit.",
    ["cock", "shit"],
    "[__] [__] [__]",
    { slotCount: 3 }
  ).words,
  ["shit"]
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "he just f* walked in",
    ["fuck", "fucking"],
    "he just [__] walked in",
    {}
  ).word,
  "fuck"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "of dick stains in a v-FUCKY!",
    ["fuck", "shit", "fucking"],
    "stains in of it [__] you I'm after space",
    {}
  ).word,
  "fuck"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "",
    ["fuck", "shit"],
    "what the [__] is this",
    {}
  ).word,
  ""
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "hello there",
    ["fuck", "shit"],
    "what the [__] is this",
    {}
  ).word,
  ""
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "put a come joke in my video",
    ["cum", "fuck"],
    "put a [__] joke in my video",
    {}
  ).word,
  "cum"
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "come on and get the fork out",
    ["cum", "fuck"],
    "come on and get the [__] out",
    {}
  ).word,
  "fuck"
);

[
  ["You're ahead aboutcha, you'll be fine. Fuuuuck!", "fuuuuck"],
  ["This is shiiiiit!", "shiiiiit"],
  ["You biiiiitch!", "biiiiitch"]
].forEach(([transcript, expected]) => {
  assert.strictEqual(
    whisper.decisionFromTranscript(
      transcript,
      ["fuck", "shit", "bitch"],
      "you'll be fine [__]",
      {}
    ).word,
    expected
  );
});

Promise.all([
  whisper.transcribeDetailed(new Float32Array(), ["fuck", "shit"], "what the [__]", {}),
  whisper.transcribeDetailed(new Float32Array([0.1]), ["fuck", "shit"], "what the [__]", {})
]).then((decisions) => {
  assert.deepStrictEqual(decisions.map((decision) => decision.word), ["", ""]);
  console.log("whisper-local.test.js passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
