const assert = require("assert");
const rules = require("../src/rules");

const examples = [
  ["holy [__]", "holy shit (or fuck)"],
  ["for [__] sake", "for fuck's sake"],
  ["[__] yeah", "fuck yeah"],
  ["[__] you.", "fuck you."],
  ["[__] you!", "fuck you!"],
  ["[__] me", "fuck me"],
  ["what the [__]", "what the fuck"],
  ["[__] with", "fuck with"],
  ["piece of [__]", "piece of shit"],
  ["shut the [__] up", "shut the fuck up"],
  ["Shut the [__] up", "Shut the fuck up"],
  ["scared the [__] out of me", "scared the shit out of me"],
  ["eat [__]", "eat shit"],
  ["son of a [__]", "son of a bitch"],
  ["that's [__]", "that's fucked (or bullshit)"],
  ["that\u2019s [__]", "that\u2019s fucked (or bullshit)"],
  ["[__] hell", "fucking hell"],
  ["[__] Hell", "fucking Hell"],
  ["Stop. [__] hell", "Stop. Fucking hell"],
  ["EAT [__] AND DIE", "EAT SHIT AND DIE"],
  ["WHAT THE [__]", "WHAT THE FUCK"],
  ["THAT'S [__]", "THAT'S FUCKED (or BULLSHIT)"],
  ["Jesus [__] Christ", "Jesus fucking Christ"],
  ["Stressful as [__]", "Stressful as fuck"],
  ["God [__] dammit", "God fucking dammit"],
  ["bunch of [__]", "bunch of bullshit"],
  ["where the [__]", "where the fuck"],
  ["what in the [__] is going on", "what in the fuck is going on"],
  ["what is that [__]", "what is that shit"],
  ["how [__] you are", "how shit you are"],
  ["what the [\u00a0__\u00a0] are you doing?", "what the fuck are you doing?"],
  ["Are you [__] serious?", "Are you fucking serious?"],
  ["Bull [__] [__], dude.", "Bull fucking shit, dude."],
  ["haven't even [__] defrosted", "haven't even fucking defrosted"],
  ["you're [__] useless", "you're fucking useless"],
  ["that is [__] embarrassing", "that is fucking embarrassing"],
  ["it's [__] raw", "it's fucking raw"],
  ["stone [__] cold", "stone fucking cold"],
  ["stone cold [__]", "stone cold fucking"],
  ["wake the [__] up", "wake the fuck up"],
  ["of [__] control", "of fucking control"],
  ["fat [__] slob", "fat fucking slob"],
  ["can't [__] concentrate", "can't fucking concentrate"],
  ["just [__] concentrate", "just fucking concentrate"],
  ["your [__] ass", "your fucking ass"],
  ["my [__] eyes", "my fucking eyes"],
  ["your [__] tongue", "your fucking tongue"],
  ["get the [__] away", "get the fuck away"],
  ["get the [__] out", "get the fuck out"],
  ["Good [__] question", "Good fucking question"],
  ["putting the kitchen to [__]", "putting the kitchen to shit"],
  ["kitchen in the [__]", "kitchen in the shit"],
  ["I don't [__] understand", "I don't fucking understand"],
  ["do not [__] like this", "do not fucking like this"],
  ["don't [__] care", "don't fucking care"],
  ["you [__] idiot", "you fucking idiot"],
  ["a [__] camera", "a fucking camera"],
  ["no one [__] knows", "no one fucking knows"],
  ["so [__] fast", "so fucking fast"],
  ["this [__] game", "this fucking game"],
  ["I'm just [__] being weird", "I'm just fucking being weird"],
  ["you're [__] clever", "you're fucking clever"],
  ["don't even [__] care", "don't even fucking care"],
  ["every [__] [Music] time", "every fucking   time"],
  ["nobody gives a [__] about him", "nobody gives a fuck (or shit) about him"],
  ["you've [__] up", "you've fucked up"],
  ["you dumb [__]", "you dumb fuck (or shit)"],
  ["aren't going to do [__]", "aren't going to do shit"],
  ["I would [__] know", "I would fucking know"],
  ["I'll be [__] pissed", "I'll be fucking pissed"],
  ["Are you [__] serious", "Are you fucking serious"],
  ["This is [__] rad", "This is fucking rad"],
  ["I'm [__] bored", "I'm fucking bored"],
  ["I'm [__] terrified", "I'm fucking terrified"],
  ["place is [__] dead", "place is fucking dead"],
  ["was just [__] murdered", "was just fucking murdered"],
  ["That was [__] brilliant", "That was fucking brilliant"],
  ["keep them [__] quiet", "keep them fucking quiet"],
  ["person [__] creeping", "person fucking creeping"],
  ["ever [__] threaten me", "ever fucking threaten me"],
  ["that was [__] awful", "that was fucking awful"],
  ["[__] idiots", "fucking idiots"],
  ["[__] starts getting", "shit starts getting"],
  ["[__] started getting", "shit started getting"],
  ["[__] Starts getting", "shit. Starts getting"],
  ["got so [__]", "got so [__]"],
  ["so [__] cool", "so fucking cool"],
  ["really [__]", "really fucking"],
  ["[__] rules", "fucking rules"],
  ["[__] rules!", "fucking rules!"],
  ["sons of [__]", "sons of bitches"],
  ["oh, [__]", "oh, fuck"],
  ["oh [__].", "oh shit. (or fuck)"],
  ["get [__]", "get fucked"]
];

for (const [input, expected] of examples) {
  assert.strictEqual(rules.applyDeterministicRules(input).text, expected);
}

assert.strictEqual(rules.applyDeterministicRules("hello [__] world").text, "hello [__] world");
assert.strictEqual(rules.applyDeterministicRules("this is clean").text, "this is clean");
assert.strictEqual(rules.applyDeterministicRules("are [__] wild").text, "are [__] wild");
assert.strictEqual(rules.applyDeterministicRules("is [__] hard").text, "is [__] hard");
assert.strictEqual(rules.applyDeterministicRules("[__] you should not match").text, "[__] you should not match");
assert.strictEqual(rules.applyDeterministicRules("Tons of [__] You didn't").text, "Tons of [__] You didn't");
assert.strictEqual(rules.applyDeterministicRules("Oh [__] why").text, "Oh [__] why");
assert.strictEqual(rules.applyDeterministicRules("Oh [__] I can").text, "Oh shit. (or fuck) I can");
assert.strictEqual(rules.applyDeterministicRules("oh [__] no").text, "oh [__] no");
assert.strictEqual(rules.applyDeterministicRules("I don't [__].").text, "I don't [__].");
assert.strictEqual(rules.applyDeterministicRules("I don't [__] know").text, "I don't fucking know");
assert.strictEqual(rules.applyDeterministicRules("I don't [__] need that").text, "I don't fucking need that");
assert.strictEqual(rules.applyDeterministicRules("[__] [__] you").text, "[__] [__] you");
assert.strictEqual(rules.applyDeterministicRules("[__] [__] me").text, "[__] [__] me");
assert.strictEqual(rules.applyDeterministicRules("are you [__]\nserious").text, "are you fucking\nserious");
assert.strictEqual(rules.applyDeterministicRules("Bull [__] [__], dude.").text, "Bull fucking shit, dude.");
assert.strictEqual(rules.applyDeterministicRules("some sick [__] trying").text, "some sick [__] trying");
assert.strictEqual(rules.applyDeterministicRules("some sick [__] Trying").text, "some sick fuck. Trying");
assert.strictEqual(rules.applyDeterministicRules("YOU SICK [__] WHERE are").text, "YOU SICK FUCK. WHERE are");
assert.strictEqual(rules.applyDeterministicRules("SOME SICK [__] TRYING TO").text, "SOME SICK [__] TRYING TO");
assert.strictEqual(
  rules.applyDeterministicRules("That worked. [__] yeah.").text,
  "That worked. Fuck yeah."
);
assert.strictEqual(
  rules.applyDeterministicRules("Holy [__]\nThere's so much.").text,
  "Holy shit. (or fuck)\nThere's so much."
);
assert.strictEqual(
  rules.applyDeterministicRules("so [__] confused").text,
  "so fucking confused"
);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "give a [__]").candidates, ["fuck", "shit"]);

console.log("rules.test.js passed");
