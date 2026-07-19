const assert = require("assert");
const rules = require("../src/rules");

const examples = [
  ["holy [__]", "holy shit"],
  ["for [__] sake", "for fuck's sake"],
  ["[__] yeah.", "fuck yeah."],
  ["Stop. [__] you!", "Stop. Fuck you!"],
  ["Wait? [__] you.", "Wait? Fuck you."],
  ["[__] me", "fuck me"],
  ["what the [__]", "what the fuck"],
  ["You look like [__]", "You look like shit"],
  ["You don't know [__]", "You don't know shit"],
  ["I can't see [__]", "I can't see shit"],
  ["Cut the [__]", "Cut the bullshit"],
  ["Don't lose your [__]", "Don't lose your shit"],
  ["I might lose my [__]", "I might lose my shit"],
  ["Enough of this [__]", "Enough of this bullshit"],
  ["piece of [__]", "piece of shit"],
  ["shut the [__] up", "shut the fuck up"],
  ["Shut the [__] up", "Shut the fuck up"],
  ["scared the [__] out of me", "scared the shit out of me"],
  ["eat [__]", "eat shit"],
  ["son of a [__]", "son of a bitch"],
  ["that's [__]", "that's fucked"],
  ["that\u2019s [__]", "that\u2019s fucked"],
  ["[__] hell", "[__] hell"],
  ["[__] Hell", "[__] Hell"],
  ["Stop. [__] hell", "Stop. [__] hell"],
  ["EAT [__] AND DIE", "EAT SHIT AND DIE"],
  ["WHAT THE [__]", "WHAT THE FUCK"],
  ["THAT'S [__]", "THAT'S FUCKED"],
  ["you are SO [__] up", "you are SO FUCKED up"],
  ["Jesus [__] Christ", "Jesus fucking Christ"],
  ["God [__] dammit", "God fucking dammit"],
  ["bunch of [__]", "bunch of bullshit"],
  ["where the [__]", "where the fuck"],
  ["when the [__]", "when the fuck"],
  ["what in the [__] is going on", "what in the fuck is going on"],
  ["what is that [__]", "what is that shit"],
  ["this [__] is for kids", "this shit is for kids"],
  ["how [__] you are", "how shit you are"],
  ["what the [\u00a0__\u00a0] are you doing?", "what the fuck are you doing?"],
  ["Are you [__] serious?", "Are you fucking serious?"],
  ["Bull [__] [__], dude.", "Bull fucking shit, dude."],
  ["you're [__] useless", "you're fucking useless"],
  ["that is [__] embarrassing", "that is fucking embarrassing"],
  ["it's [__] raw", "it's fucking raw"],
  ["wake the [__] up", "wake the fuck up"],
  ["of [__] control", "of fucking control"],
  ["can't [__] concentrate", "can't fucking concentrate"],
  ["just [__] concentrate", "just fucking concentrate"],
  ["your [__] ass", "your [__] ass"],
  ["my [__] eyes", "my fucking eyes"],
  ["your [__] tongue", "your fucking tongue"],
  ["get the [__] away", "get the fuck away"],
  ["get the [__] out", "get the fuck out"],
  ["get the [__] outta here", "get the fuck outta here"],
  ["get the [__] down", "get the fuck down"],
  ["sit the [__] down", "sit the fuck down"],
  ["calm the [__] down", "calm the fuck down"],
  ["the [__] you doing?", "the fuck you doing?"],
  ["the [__] was that?", "the fuck was that?"],
  ["are you [__] with me?", "are you fucking with me?"],
  ["I'm just [__] with you", "I'm just fucking with you"],
  ["you dream about [__] me", "you dream about fucking me"],
  ["don't [__] up my movie", "don't fuck up my movie"],
  ["what the [__] going on?", "what the fuck's going on?"],
  ["I wish a [__] would", "I wish a bitch would"],
  ["all the [__] time", "all the fucking time"],
  ["so the [__] what?", "so the fuck what?"],
  ["you [__] my wife", "you fucked my wife"],
  ["I [__] it up", "I fucked it up"],
  ["They have [__] it", "They have fucked it"],
  ["It has [__] me", "It has fucked me"],
  ["That had [__] it", "That had fucked it"],
  ["He is [__] it", "He is fucking it"],
  ["It keeps [__] me", "It keeps fucking me"],
  ["I'm good at [__] it", "I'm good at fucking it"],
  ["They will [__] me", "They will fuck me"],
  ["I need to [__] it", "I need to fuck it"],
  ["It almost [__] me", "It almost fucked me"],
  ["They make you [__] up", "They make you fuck up"],
  ["You are [__] up", "You are fucking up"],
  ["You're [__] up", "You're fucking up"],
  ["They kept [__] up", "They kept fucking up"],
  ["it's so [__] up", "it's so fucked up"],
  ["Bunny's drugs were [__] with", "Bunny's drugs were fucked with"],
  ["this is some [__]", "this is some bullshit"],
  ["Good [__] question", "Good [__] question"],
  ["Good [__].", "Good shit."],
  ["I don't [__] understand", "I don't fucking understand"],
  ["do not [__] like this", "do not fucking like this"],
  ["don't [__] care", "don't fucking care"],
  ["you [__] idiot", "you fucking idiot"],
  ["a [__] camera", "a [__] camera"],
  ["no one [__] knows", "no one fucking knows"],
  ["so [__] fast", "so fucking fast"],
  ["don't even [__] care", "don't even fucking care"],
  ["every [__] [Music] time", "every fucking   time"],
  ["nobody gives a [__] about him", "nobody gives a fuck about him"],
  ["he [__] up", "he fucked up"],
  ["she [__] up", "she fucked up"],
  ["I [__] up", "I fucked up"],
  ["they [__] up", "they fucked up"],
  ["you dumb [__]", "you dumb fuck"],
  ["I'll be [__] pissed", "I'll be fucking pissed"],
  ["Are you [__] serious", "Are you fucking serious"],
  ["[__] idiots", "fucking idiots"],
  ["[__] starts getting", "shit starts getting"],
  ["[__] started getting", "shit started getting"],
  ["got so [__]", "got so [__]"],
  ["so [__] cool", "so fucking cool"],
  ["really [__] cool", "really fucking cool"],
  ["sons of [__]", "sons of bitches"],
  ["oh [__].", "oh shit."],
  ["scares the [__] out of me", "scares the shit out of me"],
  ["kick the [__] out", "kick the shit out"],
  ["don't give me [__] about it", "don't give me shit about it"],
  ["come on, you [__]", "come on, you bitch"],
  ["show some [__] respect", "show some fucking respect"],
  ["better not [__] things up", "better not fuck things up"],
  ["I will [__] you up", "I will fuck you up"],
  ["I'm gonna [__] him up", "I'm gonna fuck him up"],
  ["They have [__] up", "They have fucked up"],
  ["Stop [__] up", "Stop fucking up"],
  ["Go [__] yourself", "Go fuck yourself"],
  ["Oh my [__] God", "Oh my fucking God"],
  ["God [__] damn it", "God fucking damn it"],
  ["I swear to [__] God", "I swear to fucking God"],
  ["The last [__] time", "The last fucking time"],
  ["This [__] jump", "This fucking jump"],
  ["I'll [__] do it", "I'll fucking do it"],
  ["Just [__] tell me", "Just fucking tell me"],
  ["I'll [__] show you", "I'll fucking show you"],
  ["I'm gonna [__] murder you", "I'm gonna fucking murder you"],
  ["We can get [__].", "We can get fucked."],
  ["Let's get [__] up", "Let's get fucked up"],
  ["We are [__].", "We are fucked."],
  ["I have the smallest [__] mouse", "I have the smallest fucking mouse"],
];

for (const [input, expected] of examples) {
  assert.strictEqual(rules.applyDeterministicRules(input).text, expected);
}

assert.strictEqual(rules.applyDeterministicRules("hello [__] world").text, "hello [__] world");
assert.strictEqual(rules.formatWordCase("fucking", "that was WILD [__] today"), "FUCKING");
assert.strictEqual(rules.formatWordCase("fucking", "HAVING A [__] day"), "FUCKING");
assert.strictEqual(rules.formatWordCase("fucking", "having A [__] day"), "fucking");
assert.strictEqual(rules.formatWordCase("fucking", "I [__] hate this"), "fucking");
assert.strictEqual(rules.formatWordCase("fucking", "that was Wild [__] today"), "fucking");
assert.strictEqual(rules.applyDeterministicRules("this is clean").text, "this is clean");
assert.strictEqual(rules.applyDeterministicRules("are [__] wild").text, "are [__] wild");
assert.strictEqual(rules.applyDeterministicRules("is [__] hard").text, "is [__] hard");
assert.strictEqual(rules.applyDeterministicRules("[__] you should not match").text, "[__] you should not match");
assert.strictEqual(rules.applyDeterministicRules("He [__] you.").text, "He [__] you.");
assert.strictEqual(rules.applyDeterministicRules("I got [__]").text, "I got [__]");
assert.strictEqual(rules.applyDeterministicRules("a complete [__]").text, "a complete [__]");
assert.strictEqual(rules.applyDeterministicRules("listen [__] up").text, "listen [__] up");
assert.strictEqual(rules.applyDeterministicRules("putting the kitchen to [__].").text, "putting the kitchen to [__].");
assert.strictEqual(rules.applyDeterministicRules("Tons of [__] You didn't").text, "Tons of [__] You didn't");
assert.strictEqual(rules.applyDeterministicRules("Oh [__] why").text, "Oh shit why");
assert.strictEqual(rules.applyDeterministicRules("Oh [__] I can").text, "Oh shit. I can");
assert.strictEqual(rules.applyDeterministicRules("oh [__] no").text, "oh shit no");
assert.strictEqual(rules.applyDeterministicRules("I don't [__].").text, "I don't [__].");
assert.strictEqual(rules.applyDeterministicRules("I don't [__] know").text, "I don't fucking know");
assert.strictEqual(rules.applyDeterministicRules("I don't [__] need that").text, "I don't fucking need that");
assert.strictEqual(rules.applyDeterministicRules("haven't even [__] defrosted").text, "haven't even fucking defrosted");
assert.strictEqual(rules.applyDeterministicRules("I would [__] know").text, "I would [__] know");
assert.strictEqual(rules.applyDeterministicRules("kind of [__].").text, "kind of [__].");
assert.strictEqual(rules.applyDeterministicRules("They are so [__].").text, "They are so [__].");
assert.strictEqual(rules.applyDeterministicRules("We are [__] people.").text, "We are [__] people.");
assert.strictEqual(rules.applyDeterministicRules("[__] rules").text, "[__] rules");
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
  "Holy shit.\nThere's so much."
);
assert.strictEqual(
  rules.applyDeterministicRules("Holy [__] >> There is so much.").text,
  "Holy shit. >> There is so much."
);
assert.strictEqual(
  rules.applyDeterministicRules("so [__] confused").text,
  "so fucking confused"
);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "give a [__]").candidates, ["fuck", "shit"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "gives a [__]").candidates, ["fuck", "shit"]);

console.log("rules.test.js passed");
