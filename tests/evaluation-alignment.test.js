const assert = require("assert");
const { align, groundTruthWords, manualSwearEvents } = require("../tools/evaluation-alignment");

assert.deepStrictEqual(
  groundTruthWords("F*** F**KING f*cked F***'s sh*t sh*tting s**t s***ing a**hole p***y p*ssy b*tch b***hes c*nt c*ck bulls**t fucken fuUUuck mothafuckaaaa motherf*cker"),
  ["fuck", "fucking", "fucked", "fuck's", "shit", "shitting", "shit", "shitting", "asshole", "pussy", "pussy", "bitch", "bitches", "cunt", "cock", "bullshit", "fucking", "fuck", "motherfucker", "motherfucker"]
);
assert.deepStrictEqual(groundTruthWords("duck sitting fake fact"), []);
assert.deepStrictEqual(
  groundTruthWords("nigger nigga niggas retarded retard faggots fuckboy fuckton shitstain shitface shitbird fuckwit fucko fuckup"),
  ["nigger", "nigga", "niggas", "retarded", "retard", "faggots", "fuck", "fuck", "shit", "shit", "shit", "fuckwit", "fucko", "fuckup"]
);
assert.deepStrictEqual(
  groundTruthWords("F’ING f'ing DICK HEAD Dick Heads ASSFUCKERY MotherfuckAAAA"),
  ["fucking", "fucking", "dickhead", "dickheads", "ass", "fuckery", "motherfucker"]
);
assert.deepStrictEqual(
  groundTruthWords("N***A n***as BETCH bish p*$$y clusterf*ck motherf*cking fatherf*cking f*ckhole F*CKFACE d*ck tr*nnies genderf*ck a*****e WTF"),
  ["nigga", "niggas", "bitch", "bitch", "pussy", "clusterfuck", "motherfucking", "fucking", "fuck", "fuckface", "dick", "trannies", "genderfuck", "asshole", "fuck"]
);
assert.deepStrictEqual(
  groundTruthWords("\\NNIGGERS fook fockin fokicng motherfuckin' shittin' fux cuntskelleton MIDGET SHEMALE"),
  ["niggers", "fuck", "fucking", "fucking", "motherfucking", "shitting", "fucks", "cuntskeleton", "midget", "shemale"]
);
assert.deepStrictEqual(groundTruthWords("He SHAT himself."), ["shat"]);

const events = manualSwearEvents({
  events: [{
    tStartMs: 1000,
    dDurationMs: 1000,
    segs: [{ utf8: "FUC# and shit" }]
  }]
});
assert.deepStrictEqual(events[0].words, ["fuck", "shit"]);

const aligned = align([
  { tokenIndex: 4, timeSeconds: 1.2, context: "[__]" },
  { tokenIndex: 5, timeSeconds: 1.8, context: "[__] show" },
  { tokenIndex: 6, timeSeconds: 10, context: "[__]" }
], events);
assert.strictEqual(aligned.expected.size, 2);
assert.strictEqual(aligned.expected.get(4), "fuck");
assert.strictEqual(aligned.expected.get(5), "shit");
assert.deepStrictEqual(aligned.mismatches.map((value) => value.tokenIndex), [6]);

const overridden = align([
  { tokenIndex: 9, timeSeconds: 20, context: "[__]" }
], [], { 9: ["bitch"] });
assert.strictEqual(overridden.expected.get(9), "bitch");

const contextEvents = manualSwearEvents({
  events: [{
    tStartMs: 14000,
    dDurationMs: 1000,
    segs: [{ utf8: "they will fuck this is good" }]
  }]
});
const contextAligned = align([
  { tokenIndex: 10, timeSeconds: 10, context: "they will [__] this is good" },
  { tokenIndex: 11, timeSeconds: 10, context: "they will [__]" }
], contextEvents);
assert.strictEqual(contextAligned.expected.get(10), "fuck");
assert.strictEqual(contextAligned.expected.has(11), false);

const ordinaryWord = align([{
  tokenIndex: 12,
  timeSeconds: 10,
  context: "they will [__] this is good"
}], manualSwearEvents({
  events: [{
    tStartMs: 14000,
    dDurationMs: 1000,
    segs: [{ utf8: "they will duck this is good but fuck elsewhere" }]
  }]
}));
assert.strictEqual(ordinaryWord.expected.has(12), false);

const visibleSwear = align([{
  tokenIndex: 17,
  timeSeconds: 10,
  context: "all that shit's for [__] engagement"
}], manualSwearEvents({
  events: [{
    tStartMs: 10000,
    dDurationMs: 1000,
    segs: [{ utf8: "all that shit's for fucking engagement" }]
  }]
}));
assert.strictEqual(visibleSwear.expected.get(17), "fucking");

const lexicalSteal = align([{
  tokenIndex: 30,
  timeSeconds: 5,
  context: "did you see that [__] beef cake"
}, {
  tokenIndex: 31,
  timeSeconds: 8,
  context: "beef cake of a [__] human being dude he"
}], manualSwearEvents({ events: [{
  tStartMs: 0,
  dDurationMs: 10000,
  segs: [{ utf8: "did you see that motherfucking beefcake of a motherfucking human being dude he was a bitch" }]
}] }));
assert.strictEqual(lexicalSteal.expected.has(30), false);
assert.strictEqual(lexicalSteal.expected.get(31), "motherfucking");

const splitCompound = align([{
  tokenIndex: 13,
  timeSeconds: 10,
  context: "what in the ass [__] was that"
}], manualSwearEvents({
  events: [{
    tStartMs: 10000,
    dDurationMs: 1000,
    segs: [{ utf8: "what in the assfuckery was that" }]
  }]
}));
assert.strictEqual(splitCompound.expected.get(13), "fuckery");

const splitChicken = align([{
  tokenIndex: 16,
  timeSeconds: 10,
  context: "they were chicken [__] about it"
}], manualSwearEvents({
  events: [{
    tStartMs: 10000,
    dDurationMs: 1000,
    segs: [{ utf8: "they were chickenshit about it" }]
  }]
}, true));
assert.strictEqual(splitChicken.expected.get(16), "shit");

const compoundLabels = align([
  { tokenIndex: 18, timeSeconds: 1, context: "middle of [__] nowhere" },
  { tokenIndex: 19, timeSeconds: 2, context: "you [__] cowards" },
  { tokenIndex: 20, timeSeconds: 3, context: "being a [__]" },
  { tokenIndex: 21, timeSeconds: 4, context: "any [__] face" }
], manualSwearEvents({ events: [
  { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "middle of dickshit nowhere" }] },
  { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: "you chickenshit cowards" }] },
  { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: "being a dickgirl" }] },
  { tStartMs: 4000, dDurationMs: 500, segs: [{ utf8: "any fuckface face" }] }
] }, true));
assert.strictEqual(compoundLabels.expected.get(18), "dickshit");
assert.strictEqual(compoundLabels.expected.get(19), "chickenshit");
assert.strictEqual(compoundLabels.expected.get(20), "dickgirl");
assert.strictEqual(compoundLabels.expected.get(21), "fuck");

const evaluationOnlyLabel = align([{
  tokenIndex: 14,
  timeSeconds: 1,
  context: "hello [__] there"
}, {
  tokenIndex: 15,
  timeSeconds: 3,
  context: "well [__] then"
}], manualSwearEvents({
  events: [{ tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "hello fuck there" }] },
    { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: "well NIGGA then" }] }]
}));
assert.strictEqual(evaluationOnlyLabel.expected.get(14), "fuck");
assert.strictEqual(evaluationOnlyLabel.expected.get(15), "nigga");

const offsetEvents = manualSwearEvents({ events: [
  { tStartMs: 50000, dDurationMs: 1000,
    segs: [{ utf8: "alpha one two fuck three four five" }] },
  { tStartMs: 60000, dDurationMs: 1000,
    segs: [{ utf8: "bravo one two shit three four five" }] },
  { tStartMs: 70000, dDurationMs: 1000,
    segs: [{ utf8: "charlie one two bitch three four five" }] }
] });
const offsetAligned = align([
  { tokenIndex: 20, timeSeconds: 1, context: "alpha one two [__] three four five" },
  { tokenIndex: 21, timeSeconds: 11, context: "bravo one two [__] three four five" },
  { tokenIndex: 22, timeSeconds: 21, context: "charlie one two [__] three four five" }
], offsetEvents);
assert.strictEqual(offsetAligned.expected.get(20), "fuck");
assert.strictEqual(offsetAligned.expected.get(21), "shit");
assert.strictEqual(offsetAligned.expected.get(22), "bitch");

console.log("evaluation-alignment.test.js passed");
