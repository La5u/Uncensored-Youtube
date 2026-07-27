const assert = require("assert");
const rules = require("../src/rules");

const examples = [
  ["holy [__]", "holy shit"],
  ["for [__] sake", "for fuck's sake"],
  ["[__] yeah.", "fuck yeah."],
  ["Stop. [__] you!", "Stop. Fuck you!"],
  ["Wait? [__] you.", "Wait? Fuck you."],
  ["[__] me", "fuck me"],
  ["Are you [__] me?", "Are you shitting me?"],
  ["You gotta be [__] me.", "You gotta be shitting me."],
  ["Don't [__] me.", "Don't bullshit me."],
  ["[__] him up.", "fuck him up."],
  ["[__] all of you.", "fuck all of you."],
  ["[__] outta here.", "fuck outta here."],
  ["[__] you, I quit.", "fuck you, I quit."],
  ["[__] you too.", "fuck you too."],
  ["[__] you doing here?", "fuck you doing here?"],
  ["what the [__]", "what the fuck"],
  ["You look like [__]", "You look like [__]"],
  ["You don't know [__]", "You don't know [__]"],
  ["You don't know [__] about me", "You don't know shit about me"],
  ["I can't see [__]", "I can't see shit"],
  ["Cut the [__]", "Cut the [__]"],
  ["Don't lose your [__]", "Don't lose your shit"],
  ["I might lose my [__]", "I might lose my shit"],
  ["Enough of this [__]", "Enough of this [__]"],
  ["piece of [__]", "piece of shit"],
  ["piece of [__] [__]", "piece of fucking shit"],
  ["[__] piece of [__] [__] up", "fucking piece of fucking shit up"],
  ["write this [__] down", "write this shit down"],
  ["stole my [__]", "stole my shit"],
  ["[__] you all", "fuck you all"],
  ["the biggest crock of [__].", "the biggest crock of shit."],
  ["shut the [__] up", "shut the fuck up"],
  ["Shut the [__] up", "Shut the fuck up"],
  ["scared the [__] out of me", "scared the shit out of me"],
  ["eat [__]", "eat shit"],
  ["son of a [__]", "son of a bitch"],
  ["that's [__]", "that's [__]"],
  ["that\u2019s [__]", "that\u2019s [__]"],
  ["[__] hell", "fucking hell"],
  ["[__] Hell", "fucking Hell"],
  ["Stop. [__] hell", "Stop. Fucking hell"],
  ["EAT [__] AND DIE", "EAT SHIT AND DIE"],
  ["WHAT THE [__]", "WHAT THE FUCK"],
  ["THAT'S [__]", "THAT'S [__]"],
  ["you are SO [__] up", "you are SO FUCKED up"],
  ["Jesus [__] Christ", "Jesus fucking Christ"],
  ["God [__] dammit", "God fucking dammit"],
  ["bunch of [__]", "bunch of [__]"],
  ["where the [__]", "where the fuck"],
  ["when the [__]", "when the [__]"],
  ["what in the [__] is going on", "what in the fuck is going on"],
  ["what is that [__]", "what is that shit"],
  ["this [__] is for kids", "this shit is for kids"],
  ["how [__] you are", "how [__] you are"],
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
  ["your [__] ass", "your fucking ass"],
  ["my [__] eyes", "my fucking eyes"],
  ["your [__] tongue", "your fucking tongue"],
  ["get the [__] away", "get the fuck away"],
  ["get the [__] out", "get the fuck out"],
  ["get the [__] outta here", "get the fuck outta here"],
  ["get the [__] down", "get the fuck down"],
  ["get the [__] in there", "get the fuck in there"],
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
  ["you [__] my wife", "you [__] my wife"],
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
  ["Good [__].", "Good [__]."],
  ["I don't [__] understand", "I don't fucking understand"],
  ["do not [__] like this", "do not fucking like this"],
  ["don't [__] care", "don't fucking care"],
  ["you [__] idiot", "you fucking idiot"],
  ["a [__] camera", "a [__] camera"],
  ["no one [__] knows", "no one fucking knows"],
  ["so [__] fast", "so fucking fast"],
  ["don't even [__] care", "don't even fucking care"],
  ["Don't you [__] attack me.", "Don't you fucking attack me."],
  ["How [__] dare you?", "How fucking dare you?"],
  ["Did you [__] him?", "Did you [__] him?"],
  ["She [__] all of us over.", "She [__] all of us over."],
  ["every [__] [Music] time", "every fucking   time"],
  ["nobody gives a [__] about him", "nobody gives a shit about him"],
  ["he [__] up", "he fucked up"],
  ["she [__] up", "she fucked up"],
  ["I [__] up", "I fucked up"],
  ["they [__] up", "they fucked up"],
  ["you dumb [__]", "you dumb [__]"],
  ["I'll be [__] pissed", "I'll be fucking pissed"],
  ["Are you [__] serious", "Are you fucking serious"],
  ["[__] idiots", "fucking idiots"],
  ["[__] starts getting", "shit starts getting"],
  ["[__] started getting", "shit started getting"],
  ["got so [__]", "got so [__]"],
  ["so [__] cool", "so fucking cool"],
  ["really [__] cool", "really fucking cool"],
  ["sons of [__]", "sons of bitches"],
  ["those son of [__]", "those son of bitches"],
  ["oh [__].", "oh shit."],
  ["scares the [__] out of me", "scares the shit out of me"],
  ["kick the [__] out", "kick the shit out"],
  ["don't give me [__] about it", "don't give me shit about it"],
  ["come on, you [__]", "come on, you [__]"],
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
  ["The [__] car", "The fucking car"],
  ["Use your [__] phone", "Use your fucking phone"],
  ["They are [__] crazy", "They are fucking crazy"],
  ["They are so [__] bad.", "They are so fucking bad."],
  ["That's [__] awesome", "That's fucking awesome"],
  ["I [__] want this", "I fucking want this"],
  ["I'll [__] kill you", "I'll fucking kill you"],
  ["You couldn't [__] believe it", "You couldn't fucking believe it"],
  ["Are you [__] crazy?", "Are you fucking crazy?"],
  ["I don't know [__].", "I don't know [__]."],
  ["They can't do [__]!", "They can't do shit!"],
  ["It smells like [__].", "It smells like shit."],
  ["That looks like [__].", "That looks like [__]."],
  ["We're in deep [__].", "We're in deep shit."],
  ["I'll [__] you up", "I'll fuck you up"],
  ["I'll [__] do it", "I'll fucking do it"],
  ["Just [__] tell me", "Just fucking tell me"],
  ["I'll [__] show you", "I'll fucking show you"],
  ["I'm gonna [__] murder you", "I'm gonna fucking murder you"],
  ["We can get [__].", "We can get fucked."],
  ["We can get [__]", "We can get fucked"],
  ["pretty [__] great", "pretty fucking great"],
  ["Oh, my [__] God", "Oh, my fucking God"],
  ["like ah [__]", "like ah shit"],
  ["and [__] like that", "and shit like that"],
  ["I'm sick of this [__].", "I'm sick of this shit."],
  ["Everything is going to [__].", "Everything is going to shit."],
  ["The plan went to [__].", "The plan went to shit."],
  ["Then let's go to [__] Los Angeles.", "Then let's go to [__] Los Angeles."],
  ["I need to take a [__].", "I need to take a [__]."],
  ["Yeah, no [__].", "Yeah, no shit."],
  ["There is no [__].", "There is no [__]."],
  ["They treated me like [__].", "They treated me like shit."],
  ["We don't have [__].", "We don't have [__]."],
  ["I'm not telling you [__].", "I'm not telling you shit."],
  ["We saw some crazy [__].", "We saw some crazy shit."],
  ["Do you see this [__]?", "Do you see this shit?"],
  ["Cut that [__] out.", "Cut that shit out."],
  ["We're all [__].", "We're all fucked."],
  ["Tone it the [__] down.", "Tone it the fuck down."],
  ["Let's get [__] up", "Let's get fucked up"],
  ["We are [__].", "We are fucked."],
  ["I have the smallest [__] mouse", "I have the smallest fucking mouse"],
  ["You see the fox [__] its head.", "You see the fox cocks its head."],
  ["She [__] an eyebrow.", "She cocks an eyebrow."],
  ["I'm a consumer [__].", "I'm a consumer whore."],
  ["I need to empty the [__].", "I need to empty the shitter."],
  ["Are you using the [__]?", "Are you using the shitter?"],
  ["I don't use the [__] as much.", "I don't use the shitter as much."],
  ["I waited 917 [__] years.", "I waited 917 fucking years."],
  ["It happened 1,000 [__] times.", "It happened 1,000 fucking times."],
  ["That took twenty five [__] minutes.", "That took twenty five fucking minutes."],
  ["Where's this [__]?", "Where's this motherfucker?"],
  ["We were [__] around.", "We were dicking around."],
  ["It kind of [__] me over.", "It kind of dicked me over."],
  ["I'm getting [__] over.", "I'm getting fucked over."],
  ["Those wretched [__].", "Those wretched cunts."],
  ["Dying is for [__].", "Dying is for pussies."],
  ["We need a [__] ton of cables.", "We need a shit ton of cables."],
  ["Restart the whole [__] thing.", "Restart the whole fucking thing."],
  ["The fan base is [__] exhausting.", "The fan base is fucking exhausting."],
  ["That's the [__] right there.", "That's the shit right there."],
  ["They're kicking the [__] out of me.", "They're kicking the shit out of me."],
  ["She pushed the [__] out of him.", "She pushed the shit out of him."],
  ["I'm getting the [__] out of here.", "I'm getting the fuck out of here."],
  ["I have [__] no idea.", "I have fucking no idea."],
  ["It looks like a [__]", "It looks like a fucking"],
  ["Watch this [__].", "Watch this shit."],
  ["I deleted all that [__].", "I deleted all that shit."],
  ["Look at this [__]!", "Look at this shit!"],
  ["They're in the [__] bin.", "They're in the fucking bin."],
  ["That was [__] awesome.", "That was fucking awesome."],
  ["You ain't got [__] left.", "You ain't got shit left."],
  ["Woo [__] yeah!", "Woo fuck yeah!"],
  ["[__] yeah dude.", "fuck yeah dude."],
  ["That frightened the [__] out of me.", "That frightened the shit out of me."],
  ["Seriously, [__] that guy.", "Seriously, fuck that guy."],
  ["Why am I doing [__] like this?", "Why am I doing shit like this?"],
  ["They can [__] right off.", "They can fuck right off."],
  ["There is [__] all over the floor.", "There is shit all over the floor."],
  ["I want to [__] with them.", "I want to fuck with them."],
  ["I do dumb [__] all the time.", "I do dumb shit all the time."],
  ["I [__] you not.", "I shit you not."],
  ["Someone tried to [__] on it.", "Someone tried to shit on it."],
  ["It freaks me the [__] out.", "It freaks me the fuck out."],
  ["This is cool [__].", "This is cool shit."],
  ["That is really [__] good.", "That is really fucking good."],
  ["It was a [__] good attempt.", "It was a fucking good attempt."],
  ["I'm going to [__] leave.", "I'm going to fucking leave."],
  ["You want to [__] fight?", "You want to fucking fight?"],
  ["What are you [__] doing?", "What are you fucking doing?"],
  ["I don't want any of this [__].", "I don't want any of this shit."],
  ["There is a whole bunch of [__] here.", "There is a whole bunch of shit here."],
  ["There's so much [__] going on.", "There's so much shit going on."],
  ["That's [__] up.", "That's fucked up."],
  ["What's the [__] point?", "What's the fucking point?"],
  ["I am going to [__] die.", "I am going to fucking die."],
  ["Just [__] go.", "Just fucking go."],
  ["Well [__] you.", "Well fuck you."],
  ["[__] you dude.", "fuck you dude."],
  ["Come the [__] on.", "Come the fuck on."],
  ["I can [__] do this.", "I can fucking do this."],
  ["I can [__] with this.", "I can fuck with this."],
  ["I don't have [__] time.", "I don't have fucking time."],
  ["I have a [__] Photon cannon.", "I have a fucking Photon cannon."],
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
assert.strictEqual(rules.applyDeterministicRules("is [__] hard").text, "is fucking hard");
assert.strictEqual(rules.applyDeterministicRules("[__] you should not match").text, "[__] you should not match");
assert.strictEqual(rules.applyDeterministicRules("He [__] you.").text, "He [__] you.");
assert.strictEqual(rules.applyDeterministicRules("I got [__]").text, "I got [__]");
assert.strictEqual(rules.applyDeterministicRules("a complete [__]").text, "a complete [__]");
assert.strictEqual(rules.applyDeterministicRules("listen [__] up").text, "listen [__] up");
assert.strictEqual(rules.applyDeterministicRules("putting the kitchen to [__].").text, "putting the kitchen to [__].");
assert.strictEqual(rules.applyDeterministicRules("Tons of [__] You didn't").text, "Tons of [__] You didn't");
assert.strictEqual(rules.applyDeterministicRules("here [__] that is weird").text, "here [__] that is weird");
assert.strictEqual(rules.applyDeterministicRules("my own [__] facility").text, "my own [__] facility");
assert.strictEqual(rules.applyDeterministicRules("such [__] trash").text, "such [__] trash");
assert.strictEqual(rules.applyDeterministicRules("a [__] excuse").text, "a [__] excuse");
assert.strictEqual(rules.applyDeterministicRules("you [__] god damn it").text, "you [__] god damn it");
assert.strictEqual(rules.applyDeterministicRules("Oh [__] why").text, "Oh shit why");
assert.strictEqual(rules.applyDeterministicRules("Oh [__] I can").text, "Oh shit. I can");
assert.strictEqual(rules.applyDeterministicRules("oh [__] no").text, "oh shit no");
assert.strictEqual(rules.applyDeterministicRules("I don't [__].").text, "I don't [__].");
assert.strictEqual(rules.applyDeterministicRules("This [__].").text, "This [__].");
assert.strictEqual(rules.applyDeterministicRules("That [__].").text, "That [__].");
assert.strictEqual(rules.applyDeterministicRules("I don't [__] know").text, "I don't fucking know");
assert.strictEqual(rules.applyDeterministicRules("I don't [__] need that").text, "I don't fucking need that");
assert.strictEqual(rules.applyDeterministicRules("haven't even [__] defrosted").text, "haven't even fucking defrosted");
assert.strictEqual(rules.applyDeterministicRules("I would [__] know").text, "I would fucking know");
assert.strictEqual(rules.applyDeterministicRules("kind of [__].").text, "kind of [__].");
assert.strictEqual(rules.applyDeterministicRules("They are so [__].").text, "They are so [__].");
assert.strictEqual(rules.applyDeterministicRules("That's [__] unclear").text, "That's [__] unclear");
assert.strictEqual(rules.applyDeterministicRules("We are [__] people.").text, "We are [__] people.");
assert.strictEqual(rules.applyDeterministicRules("[__] rules").text, "[__] rules");
assert.strictEqual(rules.applyDeterministicRules("[__] [__] you").text, "[__] [__] you");
assert.strictEqual(rules.applyDeterministicRules("[__] [__] me").text, "[__] [__] me");
assert.strictEqual(rules.applyDeterministicRules("[__] it's over").text, "[__] it's over");
assert.strictEqual(rules.applyDeterministicRules("[__] you're late").text, "[__] you're late");
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
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "give a [__]").candidates, ["shit", "fuck"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "holy [__]").candidates, ["shit", "fuck", "fucking"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "oh [__]").candidates, ["shit", "fuck", "fucking"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "gives a [__]").candidates, ["shit", "fuck"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "was [__] around").candidates, ["dicking", "fucking", "dickin", "fucked"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "getting [__] over").candidates, ["fucked", "dicked"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "a [__] ton").candidates, ["shit", "fucking", "fuck"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "kicking the [__] out").candidates, ["shit", "fuck"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "watch this [__]").candidates, ["shit", "fuck", "fucking"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "all that [__]").candidates, ["shit", "fucking", "bullshit", "pussy", "fuck"]);

console.log("rules.test.js passed");
