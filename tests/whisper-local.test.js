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
    "fuck shit, I don't know, fuck shit",
    ["fuck", "shit"],
    "I don't fudge that [__]. That was",
    {}
  ).word,
  ""
);
assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "I gotta go why? fucking asshole",
    ["fucking", "asshole"],
    "No, go away. [__]",
    { previousWord: "away" }
  ),
  {
    word: "asshole",
    words: ["fucking", "asshole"],
    slotWords: [],
    slotEvidence: [],
    transcript: "I gotta go why? fucking asshole",
    evidence: "transcript-tail"
  }
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "the fucking guy giving this bitch",
    ["fucking", "bitch"],
    "Always Sunny the [__]",
    { previousWord: "the" }
  ).word,
  "fucking"
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "go why fucking asshole",
    ["fucking", "asshole"],
    "go away [__] …",
    { previousWord: "away" }
  ).word,
  ""
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

const unanchoredAliasGuard = whisper.decisionFromTranscript(
  "more on shit",
  ["moron", "shit"],
  "[__]",
  {}
);
assert.deepStrictEqual(unanchoredAliasGuard.words, ["shit"]);
assert.strictEqual(unanchoredAliasGuard.word, "shit");

assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "Fuck, you know that get your shit together. Fuck, I want to hit you too, asshole.",
    ["fuck", "shit", "asshole"],
    "get your [__] together [__] I want to hit you too [__]",
    { slotCount: 3, previousWords: ["your", "together", "too"] }
  ).slotWords,
  ["shit", "fuck", "asshole"]
);

const anchoredRefinement = whisper.decisionFromTranscript(
  "what the fucking is this",
  ["fuck", "fucking"],
  "what the [__] is this",
  { previousWord: "the" }
);
assert.strictEqual(anchoredRefinement.word, "fuck");
assert.strictEqual(anchoredRefinement.evidence, "transcript-anchor");

const homophoneFallback = whisper.decisionFromTranscript(
  "go to shit",
  ["fuck", "shit"],
  "go too [__]",
  { previousWord: "too" }
);
assert.strictEqual(homophoneFallback.word, "shit");
assert.strictEqual(homophoneFallback.evidence, "transcript-anchor");

for (const [transcript, previousWord, expected] of [
  ["go for shit", "four", "shit"],
  ["you know fuck", "no", "fuck"],
  ["write shit down", "right", "shit"],
  ["hear fuck now", "here", "fuck"]
]) {
  const decision = whisper.decisionFromTranscript(
    transcript,
    ["fuck", "shit"],
    "anchor [__]",
    { previousWord }
  );
  assert.strictEqual(decision.word, expected);
  assert.strictEqual(decision.evidence, "transcript-anchor");
}

const exactAnchorPriority = whisper.decisionFromTranscript(
  "go to fuck but too shit",
  ["fuck", "shit"],
  "go too [__]",
  { previousWord: "too" }
);
assert.strictEqual(exactAnchorPriority.word, "shit");
assert.strictEqual(exactAnchorPriority.evidence, "transcript-anchor");

assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "say fuck then shit",
    ["fuck", "shit"],
    "say [__] then [__]",
    { slotCount: 2, previousWords: ["say", "missing"] }
  ).slotEvidence,
  ["transcript-anchor", "transcript"]
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
    "say fucking then fuck",
    ["fuck", "fucking"],
    "what the [__] is this Jesus [__] Christ",
    {
      contexts: ["what the [__] is this", "Jesus [__] Christ"],
      slotCount: 2,
      previousWords: ["say", "then"]
    }
  ).slotWords,
  ["fuck", "fucking"]
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

assert.strictEqual(
  whisper.decisionFromTranscript("you are such bits", ["bitch", "shit"], "such a [__]", {}).word,
  "bitch"
);
assert.deepStrictEqual(
  whisper.decisionFromTranscript("say shit bits", ["bitch", "shit"], "say [__]", { previousWord: "say" }).words,
  ["shit"]
);

for (const [article, word, expected] of [
  ["a", "bitch", "bitch"],
  ["an", "asshole", "asshole"],
  ["a", "asshole", ""],
  ["an", "bitch", ""]
]) {
  const decision = whisper.decisionFromTranscript(
    `he is ${article} ${word}`,
    ["asshole", "bitch"],
    `he is ${article} [__]`,
    { previousWord: article }
  );
  assert.strictEqual(decision.word, expected);
  if (!expected) assert.strictEqual(decision.evidence, "none");
}

const articleSlots = whisper.decisionFromTranscript(
  "an bitch and a asshole",
  ["asshole", "bitch"],
  "an [__] and a [__]",
  {
    contexts: ["an [__]", "a [__]"],
    slotCount: 2,
    previousWords: ["an", "a"]
  }
);
assert.deepStrictEqual(articleSlots.slotWords, ["", ""]);
assert.deepStrictEqual(articleSlots.slotEvidence, ["none", "none"]);

// When a short Whisper window contains several profanities, an exact visible
// tail is a safer placement anchor than the first profanity after the prefix.
assert.strictEqual(
  whisper.decisionFromTranscript(
    "Fuck you fucking shit flower",
    ["fuck", "fucking", "shit"],
    "piece of [__] Flower",
    { previousWord: "of" }
  ).word,
  "shit"
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "Peace are fucking shit. Go fuck.",
    ["fuck", "fucking", "shit"],
    "piece of [__] go",
    { previousWord: "of", previousWordOffset: 1 }
  ).word,
  "shit"
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "Fuck yourself. Peace out fucking ass.",
    ["fuck", "fucking"],
    "piece of [__] ass",
    { previousWord: "of" }
  ).word,
  "fucking"
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "out of my space as fucking shh ripper",
    ["fuck", "fucking", "shit"],
    "Get out of my spaces, [__] ripper",
    { previousWord: "spaces" }
  ).word,
  ""
);

assert.deepStrictEqual(
  whisper.decisionFromTranscript(
    "He's a cloth. Greg is a cook shit.",
    ["cock", "shit"],
    "[__] [__] [__]",
    { slotCount: 3 }
  ).words,
  ["cock", "shit"]
);

assert.strictEqual(
  whisper.decisionFromTranscript(
    "There you see that shift respect them",
    ["shit"],
    "there you see that [__] respect them",
    { previousWord: "that" }
  ).word,
  "shit"
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "I'm shedding myself",
    ["shitting"],
    "I'm [__] myself",
    { previousWord: "I'm" }
  ).word,
  "shitting"
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "Alright, fuck see I'm gonna let you cocksy, man",
    ["cock", "fuck"],
    "I'm gonna let you [__] see mine",
    { previousWord: "you" }
  ).word,
  "cock"
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "Let the cook work",
    ["shit"],
    "let the [__] work",
    { previousWord: "the" }
  ).word,
  ""
);
assert.strictEqual(
  whisper.decisionFromTranscript(
    "Let the cook work",
    ["cock"],
    "let the [__] work",
    { previousWord: "the" }
  ).word,
  ""
);
assert.strictEqual(
  whisper.decisionFromTranscript("The shift changed", ["shit"], "the [__] changed").word,
  ""
);
assert.strictEqual(
  whisper.decisionFromTranscript("I'm shedding light", ["shitting"], "I'm [__] light").word,
  ""
);

const videoGroup = whisper.decisionFromTranscript(
  "Oh, Greg is a cock shit. I want to hit you in the comments.",
  ["asshole", "cock", "shit"],
  "Craig is an [__] oh Craig is a [__]",
  { slotCount: 2, previousWords: ["an", "a"] }
);
assert.deepStrictEqual(videoGroup.slotWords, ["", "cock"]);
assert.deepStrictEqual(videoGroup.slotEvidence, ["none", "transcript-anchor"]);

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
  ["f-", ["fuck", "fucking"], "fuck"],
  ["f—", ["fuck", "fucking"], "fuck"],
  ["f***ing", ["fuck", "fucking"], "fucking"],
  ["f-ing", ["fuck", "fucking"], "fucking"],
  ["f**king", ["fuck", "fucking"], "fucking"],
  ["f**k", ["fuck", "fucking"], "fuck"],
  ["dawf**k", ["fuck", "fucking"], "fuck"],
  ["fuuuuuu", ["fuck", "fucking"], "fuck"],
  ["fuuut", ["fuck", "fucking"], "fuck"],
  ["sh-t", ["shit"], "shit"],
  ["b-tch", ["bitch"], "bitch"],
  ["ficking", ["fuck", "fucking"], "fucking"],
  ["fucken", ["fuck", "fucking"], "fucking"],
  ["fack", ["fuck", "fucking"], "fuck"],
  ["bish", ["bitch"], "bitch"],
  ["poozies", ["pussies"], "pussies"],
  ["mother fuckers", ["fuckers", "motherfuckers"], "motherfuckers"],
  ["a shedhole", ["shithole", "fuck"], "shithole"],
  ["a forked? forking mess", ["fucking", "shit"], "fucking"],
  ["oh shh", ["shit", "fuck"], "shit"],
  ["an ass hole", ["asshole", "fuck"], "asshole"],
  ["you're more on", ["moron", "fuck"], "moron"],
  ["god you morrow", ["moron", "fuck"], "moron"],
  ["flux like", ["fuck", "fuck's"], "fuck's"],
  ["fucks sake", ["fuck", "fucks", "fuck's"], "fuck's"],
  ["helicopter dickin'", ["dickin", "dicking"], "dickin"],
  ["stop fuckingin' with me", ["fuck", "fucking"], "fucking"]
].forEach(([transcript, candidates, expected]) => {
  assert.strictEqual(
    whisper.decisionFromTranscript(
      transcript,
      candidates,
      /(?:fucks sake|flux like)/.test(transcript) ? "[__] sake" : "[__]",
      {}
    ).word,
    expected
  );
});

[
  ["The first boss, and then I flocked up, man.", ["fucked"], "I [__] up", "fucked"],
  ["Get that fluke away from me, trap.", ["fuck"], "get the [__]", "fuck"],
  ["Shout out, get up!", ["fuck"], "shut the [__] up", "fuck"],
  ["That creature of the fox.", ["fuck"], "creature of the [__]", "fuck"],
  ["BUCKET FOR FOCK SAGMAN!", ["fuck", "fuck's"], "[__] sake", "fuck's"],
  ["You whiny son's obitious, okay?", ["bitches"], "sons of [__]", "bitches"],
  ["Wonder which one of you whiny sons of bitch is like", ["bitches"], "sons of [__]", "bitches"],
  ["shit first, then morrow", ["moron", "shit"], "first [__]", "moron"]
].forEach(([transcript, candidates, context, expected]) => {
  assert.strictEqual(
    whisper.decisionFromTranscript(transcript, candidates, context,
      transcript.includes("morrow") ? { previousWord: "then" } : {}).word,
    expected
  );
});

assert.strictEqual(
  whisper.decisionFromTranscript("fock sake", ["fuck's"], "[__] sake", {}).word,
  "fuck's"
);

[
  ["waterfuck is this", ["fuck"], "why the [__] is this", "fuck"],
  ["fucka's going on", ["fuck", "fucker"], "what the [__] is going on", "fuck"],
  ["I would have shits my pants", ["shit"], "I would have [__] my pants", "shit"],
  ["fucka made it", ["fucker"], "the [__] made it", "fucker"],
  ["horse hoshit", ["shit"], "some horse [__] here", "shit"],
  ["these motherfucker's left", ["motherfucker", "motherfuckers"], "these [__] left", "motherfuckers"],
  ["this motherfucker's started", ["motherfucker", "motherfuckers"], "this [__] started", "motherfucker"]
].forEach(([transcript, candidates, context, expected]) => {
  assert.strictEqual(whisper.decisionFromTranscript(transcript, candidates, context, {}).word, expected);
});

[
  ["clusterfuck", "a cluster [__]", "fuck"]
].forEach(([transcript, context, expected]) => {
  assert.strictEqual(
    whisper.decisionFromTranscript(
      transcript,
      ["shit", "fuck", "clusterfuck"],
      context,
      {}
    ).word,
    expected
  );
});

[
  ["fucking", "whatever the [__] you want", "fuck"],
  ["fucking", "shut the [__] up", "fuck"],
  ["fuck", "Jesus [__] Christ", "fucking"],
  ["fuck", "this [__] train", "fucking"],
  ["fuck", "you're getting [__] now", "fucked"],
  ["fucking", "how the [__] game works", "fucking"],
  ["fuck", "piece of [__] ass", "fucking"],
  ["fucked", "the [__] up bee", "fucked"],
  ["shit", "Jesus [__] Christ", "shit"]
].forEach(([transcript, context, expected]) => {
  assert.strictEqual(
    whisper.decisionFromTranscript(
      transcript,
      ["fuck", "fucking", "fucked", "shit"],
      context,
      {}
    ).word,
    expected
  );
});

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
