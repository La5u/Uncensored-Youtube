const assert = require("assert");
const rules = require("../src/rules");
const data = require("../src/rules-data");
const compiler = require("../src/rules-compiler");

assert.deepStrictEqual(
  rules.ALLOWED_WORDS.filter((word) => !Object.values(data.WORD_ROLES).flat().includes(word)),
  []
);
assert.deepStrictEqual(
  rules.DETERMINISTIC_RULES.flatMap((rule) => rule.candidates)
    .filter((word) => data.WORD_ROLES.RECOGNITION_ONLY.includes(word)),
  []
);
assert.ok(rules.RULE_WORDS.every((word) => rules.ALLOWED_WORDS.includes(word)));
assert.deepStrictEqual(
  rules.ALLOWED_WORDS.filter((word) => !rules.RULE_WORDS.includes(word)),
  ["fuckery", "shitheads", "cocksucker", "dickheads", "dickwad", "twats", "cripple"]
);
const deterministicWords = rules.DETERMINISTIC_RULES
  .flatMap((rule) => rule.candidates.flatMap((candidate) => candidate.split(/\s+/)));
assert.deepStrictEqual(deterministicWords.filter((word) => !rules.RULE_WORDS.includes(word)), []);
const authoredRuleWords = new Set(deterministicWords.concat(
  data.RULE_GROUPS.frames.flatMap((group) => group.patterns
    .flatMap((value) => compiler.compileFramePattern(value).rule.candidates))
));
assert.deepStrictEqual(rules.RULE_WORDS.filter((word) => !authoredRuleWords.has(word)), []);

const examples = [
  ["holy [__]", "holy shit"],
  ["Holy [__] I nearly fell.", "Holy shit. I nearly fell."],
  ["for [__] sake", "for fuck's sake"],
  ["[__] yeah.", "fuck yeah."],
  ["Stop. [__] you!", "Stop. Fuck you!"],
  ["Wait? [__] you.", "Wait? Fuck you."],
  ["[__] me", "fuck me"],
  ["Are you [__] me?", "Are you shitting me?"],
  ["You gotta be [__] me.", "You gotta be shitting me."],
  ["Don't [__] me.", "Don't fuck me."],
  ["[__] him up.", "fuck him up."],
  ["[__] all of you.", "fuck all of you."],
  ["[__] outta here.", "fuck outta here."],
  ["[__] you, I quit.", "fuck you, I quit."],
  ["[__] you too.", "fuck you too."],
  ["[__] you doing here?", "fuck you doing here?"],
  ["what the [__]", "what the fuck"],
  ["What the [__] you doing?", "What the fuck you doing?"],
  ["[__] it, I'm going.", "fuck it, I'm going."],
  ["[__] it. I'm going.", "fuck it. I'm going."],
  ["Yeah, [__] it.", "Yeah, fuck it."],
  ["I'll [__] it.", "I'll fuck it."],
  ["Just say [__] it.", "Just say fuck it."],
  ["Oh [__] me.", "Oh fuck me."],
  ["Are you [__] kidding me?", "Are you fucking kidding me?"],
  ["I have no [__] idea.", "I have no fucking idea."],
  ["I've seen some [__].", "I've seen some shit."],
  ["Did you see that [__] work?", "Did you see that shit work?"],
  ["I did that [__] so we could leave.", "I did that shit so we could leave."],
  ["Oh [__] that's close.", "Oh shit that's close."],
  ["[__] you I'm leaving.", "fuck you I'm leaving."],
  ["I don't want any of that [__].", "I don't want any of that shit."],
  ["Kick the [__] out of him.", "Kick the shit out of him."],
  ["You look like [__]", "You look like shit"],
  ["You don't know [__]", "You don't know shit"],
  ["You don't know [__] about me", "You don't know shit about me"],
  ["quit [__]", "quit fucking"],
  ["is the kind of [__]", "is the kind of shit"],
  ["[__] question", "fucking question"],
  ["[__] phone", "fucking phone"],
  ["the [__] are you", "the fuck are you"],
  ["you [__] kidding", "you fucking kidding"],
  ["no [__] way", "no fucking way"],
  ["Please [__] control yourself.", "Please fucking control yourself."],
  ["This is [__] interesting.", "This is fucking interesting."],
  ["I do not [__] trust them.", "I do not fucking trust them."],
  ["Same [__], different day.", "Same shit, different day."],
  ["[__] just got real.", "shit just got real."],
  ["If [__] goes south, leave.", "If shit goes south, leave."],
  ["They kicked the [__] out of it.", "They kicked the shit out of it."],
  ["This is too [__] much.", "This is too fucking much."],
  ["Stay right [__] here.", "Stay right fucking here."],
  ["This is [__], and you know it.", "This is bullshit, and you know it."],
  ["Where is the [__] milk?", "Where is the fucking milk?"],
  ["Are you [__] psychic?", "Are you fucking psychic?"],
  ["I [__] despise it.", "I fucking despise it."],
  ["Do not [__] steal it.", "Do not fucking steal it."],
  ["Get to the [__] point.", "Get to the fucking point."],
  ["Oh [__], wait!", "Oh shit, wait!"],
  ["[__] that dude.", "fuck that dude."],
  ["I have something to [__] say.", "I have something to fucking say."],
  ["They did some magic [__].", "They did some magic shit."],
  ["Ah [__] this game.", "Ah fuck this game."],
  ["We can figure [__] out.", "We can figure shit out."],
  ["He tried to [__] slap me.", "He tried to bitch slap me."],
  ["I can't see [__]", "I can't see shit"],
  ["Cut the [__]", "Cut the shit"],
  ["Don't lose your [__]", "Don't lose your shit"],
  ["I might lose my [__]", "I might lose my shit"],
  ["Enough of this [__]", "Enough of this shit"],
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
  ["the rotten [__] of a roadkill skunk", "the rotten asshole of a roadkill skunk"],
  ["that is weird [__] up", "that is weird fucked up"],
  ["this is a [__] up situation", "this is a fucked up situation"],
  ["get your [__] up", "get your shit up"],
  ["this [__] was everywhere", "this shit was everywhere"],
  ["finish this [__] now", "finish this shit now"],
  ["some [__] sick joke", "some fucking sick joke"],
  ["do not [__] with me", "do not fuck with me"],
  ["eat [__] and die", "eat shit and die"],
  ["who gives a [__] about that", "who gives a shit about that"],
  ["Maybe magic or some [__] like that", "Maybe magic or some shit like that"],
  ["That piece of [__] I warned you about", "That piece of shit. I warned you about"],
  ["Go take a [__] first", "Go take a shit first"],
  ["Forget that [__] I said", "Forget that shit I said"],
  ["Oh [__] this is bad", "Oh shit this is bad"],
  ["There is [__] in my shoe", "There is shit in my shoe"],
  ["I was [__] terrified", "I was fucking terrified"],
  ["This is really [__] strange", "This is really fucking strange"],
  ["She called me an ugly [__]", "She called me an ugly bitch"],
  ["We don't do [__] like that here", "We don't do shit like that here"],
  ["[__] are you serious?", "fuck are you serious?"],
  ["Oh [__] the door is open", "Oh shit the door is open"],
  ["[__] there was no warning", "shit there was no warning"],
  ["I can't believe this [__] happened", "I can't believe this shit happened"],
  ["Oh [__] oh my god", "Oh shit oh my god"],
  ["Oh [__] off already", "Oh fuck off already"],
  ["Put a [__] warning on it", "Put a fucking warning on it"],
  ["Just just [__] stop", "Just just fucking stop"],
  ["I feel like [__] today", "I feel like shit today"],
  ["Don't do that [__] again", "Don't do that shit again"],
  ["weird [__] statue", "weird fucking statue"],
  ["son of a [__]", "son of a bitch"],
  ["[__] hell", "fucking hell"],
  ["[__] Hell", "fucking Hell"],
  ["Stop. [__] hell", "Stop. Fucking hell"],
  ["EAT [__] AND DIE", "EAT SHIT AND DIE"],
  ["WHAT THE [__]", "WHAT THE FUCK"],
  ["you are SO [__] up", "you are SO FUCKED up"],
  ["Jesus [__] Christ", "Jesus fucking Christ"],
  ["God [__] dammit", "God fucking dammit"],
  ["where the [__]", "where the fuck"],
  ["when the [__]", "when the fuck"],
  ["sweet [__] all", "sweet fuck all"],
  ["for the love of [__]", "for the love of fuck"],
  ["[__] knows", "fuck knows"],
  ["[__] hit the fan", "shit hit the fan"],
  ["no [__] given", "no fucks given"],
  ["give two [__]", "give two fucks"],
  ["a [__] storm", "a shit storm"],
  ["bad [__] happens", "bad shit happens"],
  ["tough [__] if you miss it", "tough shit if you miss it"],
  ["funny as [__]", "funny as fuck"],
  ["sure as [__]", "sure as shit"],
  ["scared as [__]", "scared as shit"],
  ["creepy as [__]", "creepy as shit"],
  ["high as [__]", "high as fuck"],
  ["challenging as [__]", "challenging as fuck"],
  ["He said [__] this guy and left", "He said fuck this guy and left"],
  ["do this [__] thing", "do this shit thing"],
  ["do this [__]", "do this shit"],
  ["grow the [__] up", "grow the fuck up"],
  ["the actual [__]", "the actual fuck"],
  ["get your [__] together", "get your shit together"],
  ["blow the [__] out of it", "blow the shit out of it"],
  ["[__] this", "fuck this"],
  ["aw [__]", "aw fuck"],
  ["what in the [__] is going on", "what in the fuck is going on"],
  ["what is that [__]", "what is that shit"],
  ["this [__] is for kids", "this shit is for kids"],
  ["what the [\u00a0__\u00a0] are you doing?", "what the fuck are you doing?"],
  ["Are you [__] serious?", "Are you fucking serious?"],
  ["Why are you [__] jerking around?", "Why are you fucking jerking around?"],
  ["Bull [__] [__], dude.", "Bull fucking shit, dude."],
  ["you're [__] useless", "you're fucking useless"],
  ["that is [__] embarrassing", "that is fucking embarrassing"],
  ["it's [__] raw", "it's [__] raw"],
  ["wake the [__] up", "wake the fuck up"],
  ["of [__] control", "of fucking control"],
  ["can't [__] concentrate", "can't fucking concentrate"],
  ["just [__] concentrate", "just fucking concentrate"],
  ["your [__] ass", "your fucking ass"],
  ["my [__] eyes", "my fucking eyes"],
  ["your [__] tongue", "your [__] tongue"],
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
  ["You are [__] up", "You are fucked up"],
  ["You're [__] up", "You're fucked up"],
  ["They kept [__] up", "They kept fucking up"],
  ["it's so [__] up", "it's so fucked up"],
  ["It's so [__] annoying.", "It's so fucking annoying."],
  ["I don't give a [__] about it.", "I don't give a fuck about it."],
  ["Bunny's drugs were [__] with", "Bunny's drugs were fucked with"],
  ["I don't [__] understand", "I don't fucking understand"],
  ["do not [__] like this", "do not fucking like this"],
  ["don't [__] care", "don't fucking care"],
  ["you [__] idiot", "you fucking idiot"],
  ["a [__] camera", "a fucking camera"],
  ["no one [__] knows", "no one fucking knows"],
  ["so [__] fast", "so fucking fast"],
  ["don't even [__] care", "don't even fucking care"],
  ["Don't you [__] attack me.", "Don't you fucking attack me."],
  ["I [__] need this.", "I fucking need this."],
  ["There is no [__] need for that.", "There is no fucking need for that."],
  ["This time. [__] need those kids.", "This time. Fucking need those kids."],
  ["Cancel the [__] meeting.", "Cancel the fucking meeting."],
  ["You should be [__] ashamed.", "You should be fucking ashamed."],
  ["Did you hear that [__]?", "Did you hear that shit?"],
  ["That magical [__] again.", "That magical bullshit again."],
  ["Oh [__] yeah it's your room.", "Oh shit yeah it's your room."],
  ["Let me [__] try.", "Let me fucking try."],
  ["Just let me [__] win.", "Just let me fucking win."],
  ["Like [__] that.", "Like fuck that."],
  ["[__] if I know.", "fuck if I know."],
  ["Let's go [__] it.", "Let's go fuck it."],
  ["How [__] dare you?", "How fucking dare you?"],
  ["every [__] [Music] time", "every fucking   time"],
  ["nobody gives a [__] about him", "nobody gives a fuck about him"],
  ["he [__] up", "he fucked up"],
  ["she [__] up", "she fucked up"],
  ["I [__] up", "I fucked up"],
  ["they [__] up", "they fucked up"],
  ["I'll be [__] pissed", "I'll be fucking pissed"],
  ["Are you [__] serious", "Are you fucking serious"],
  ["[__] idiots", "fucking idiots"],
  ["got so [__]", "got so fucking"],
  ["so [__] cool", "so fucking cool"],
  ["really [__] cool", "really fucking cool"],
  ["sons of [__]", "sons of bitches"],
  ["those son of [__]", "those son of bitches"],
  ["oh [__].", "oh fuck."],
  ["scares the [__] out of me", "scares the shit out of me"],
  ["kick the [__] out", "kick the shit out"],
  ["don't give me [__] about it", "don't give me shit about it"],
  ["show some [__] respect", "show some fucking respect"],
  ["better not [__] things up", "better not fuck things up"],
  ["I will [__] you up", "I will fuck you up"],
  ["It might [__] me up", "It might fuck me up"],
  ["It'll [__] them up", "It'll fuck them up"],
  ["I'm gonna [__] him up", "I'm gonna fuck him up"],
  ["You have to [__] us", "You have to fuck us"],
  ["You better not [__] around", "You better not fuck around"],
  ["We'll [__] around", "We'll fuck around"],
  ["They cannot [__] that", "They cannot fuck that"],
  ["They can't do [__] anything", "They can't do fucking anything"],
  ["I don't [__] around", "I don't fuck around"],
  ["taking a [__]", "taking a shit"],
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
  ["I don't know [__].", "I don't know shit."],
  ["They can't do [__]!", "They can't do shit!"],
  ["It smells like [__].", "It smells like shit."],
  ["That looks like [__].", "That looks like shit."],
  ["We're in deep [__].", "We're in deep shit."],
  ["I'll [__] you up", "I'll fuck you up"],
  ["I'll [__] do it", "I'll fucking do it"],
  ["Just [__] tell me", "Just fucking tell me"],
  ["I'll [__] show you", "I'll fucking show you"],
  ["I'm gonna [__] murder you", "I'm gonna fucking murder you"],
  ["She's gonna [__] murder him", "She's gonna fucking murder him"],
  ["Never [__] stop", "Never fucking stop"],
  ["Gonna [__] kill him", "Gonna fucking kill him"],
  ["The same [__] thing", "The same fucking thing"],
  ["A [__] jet", "A fucking jet"],
  ["My [__] friends", "My fucking friends"],
  ["You [__] work", "You fucking work"],
  ["It [__] works", "It fucking works"],
  ["She doesn't have [__] time", "She doesn't have fucking time"],
  ["This was [__] absurd", "This was fucking absurd"],
  ["It is your [__] turn.", "It is your fucking turn."],
  ["The [__] wall", "The fucking wall"],
  ["It is [__] cool", "It is fucking cool"],
  ["Buckle the [__] up", "Buckle the fuck up"],
  ["Go the [__] to sleep", "Go the fuck to sleep"],
  ["You the [__] up", "You the fuck up"],
  ["We're being [__] with", "We're being fucked with"],
  ["I almost [__] that", "I almost fucked that"],
  ["Does it look [__] up?", "Does it look fucked up?"],
  ["We can get [__].", "We can get fucked."],
  ["We can get [__]", "We can get fucked"],
  ["pretty [__] great", "pretty fucking great"],
  ["Oh, my [__] God", "Oh, my fucking God"],
  ["like ah [__]", "like ah fuck"],
  ["and [__] like that", "and shit like that"],
  ["I'm sick of this [__].", "I'm sick of this shit."],
  ["Everything is going to [__].", "Everything is going to shit."],
  ["The plan went to [__].", "The plan went to shit."],
  ["I need to take a [__].", "I need to take a shit."],
  ["The crowd needs to make some [__] noise.", "The crowd needs to make some fucking noise."],
  ["Somebody took a [__] in the hallway.", "Somebody took a shit in the hallway."],
  ["I took a huge [__] in that bathroom.", "I took a huge shit in that bathroom."],
  ["The dog has done a huge [__] in the yard.", "The dog has done a huge shit in the yard."],
  ["Yeah, no [__].", "Yeah, no shit."],
  ["They treated me like [__].", "They treated me like shit."],
  ["We don't have [__].", "We don't have shit."],
  ["I'm not telling you [__].", "I'm not telling you shit."],
  ["We saw some crazy [__].", "We saw some crazy shit."],
  ["Have you been talking [__] about me?", "Have you been talking shit about me?"],
  ["They talk [__] right to your face.", "They talk shit right to your face."],
  ["He keeps talking [__] mate.", "He keeps talking shit mate."],
  ["We need to get [__] done.", "We need to get shit done."],
  ["They did [__] us.", "They did fuck us."],
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
  ["Are you using the [__]?", "Are you using the [__]?"],
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
  ["Watch this [__].", "Watch this shit."],
  ["I deleted all that [__].", "I deleted all that shit."],
  ["Look at this [__]!", "Look at this shit!"],
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
  ["I [__] you not.", "I shit you not."],
  ["Someone tried to [__] on it.", "Someone tried to shit on it."],
  ["It freaks me the [__] out.", "It freaks me the fuck out."],
  ["This is cool [__].", "This is cool shit."],
  ["Is that a [__] promise?", "Is that a fucking promise?"],
  ["You think you're [__] special?", "You think you're fucking special?"],
  ["What a mess, I'm [__] done.", "What a mess, I'm fucking done."],
  ["I [__] it in my pants.", "I shit it in my pants."],
  ["That is really [__] good.", "That is really fucking good."],
  ["It was a [__] good attempt.", "It was a fucking good attempt."],
  ["I'm going to [__] leave.", "I'm going to fucking leave."],
  ["You want to [__] fight?", "You want to fucking fight?"],
  ["What are you [__] doing?", "What are you fucking doing?"],
  ["I don't want any of this [__].", "I don't want any of this shit."],
  ["There is a whole bunch of [__] here.", "There is a whole bunch of shit here."],
  ["There's so much [__] going on.", "There's so much shit going on."],
  ["Throw that [__] away.", "Throw that shit away."],
  ["They're up to shady [__] behind the scenes.", "They're up to shady shit behind the scenes."],
  ["They're [__] losers.", "They're fucking losers."],
  ["We're having a [__] blast.", "We're having a fucking blast."],
  ["That is [__] impossible.", "That is fucking impossible."],
  ["That was the coolest [__] in the game.", "That was the coolest [__] in the game."],
  ["I would do dumb [__] like that.", "I would do dumb shit like that."],
  ["They don't do that [__] no more.", "They don't do that shit no more."],
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
  ["I hate that [__] dragon.", "I hate that fucking dragon."],
  ["That is [__] beautiful.", "That is fucking beautiful."],
  ["I have a [__] problem.", "I have a fucking problem."],
  ["Get the [__] away from me.", "Get the fuck away from me."],
  ["What the [__] was that?", "What the fuck was that?"],
  ["Get the [__] out of here.", "Get the fuck out of here."],
  ["We have been through some [__].", "We have been through some shit."],
  ["Can you figure this [__] out?", "Can you figure this shit out?"],
  ["This is a cluster [__].", "This is a cluster fuck."],
  ["That was [__] ridiculous.", "That was fucking ridiculous."],
  ["This is a little [__] up.", "This is a little fucked up."],
  ["I [__] did it.", "I fucking did it."],
  ["He was [__] furious.", "He was fucking furious."],
  ["We're out of the [__] woods.", "We're out of the fucking woods."],
  ["Back to the [__] game.", "Back to the fucking game."],
  ["Oh [__] balls.", "Oh fuck balls."],
  ["It was a complete [__] show.", "It was a complete shit show."],
  ["You don't [__] understand.", "You don't fucking understand."],
  ["She doesn't [__] care.", "She doesn't fucking care."],
  ["We [__] it up.", "We fucked it up."],
  ["Please don't [__] me.", "Please don't fuck me."],
  ["Of course it [__].", "Of course it fucking."],
  ["That is the sort of [__].", "That is the sort of shit."],
  ["We're all the way to [__].", "We're all the way to fucking."],
  ["Keep an eye on that [__].", "Keep an eye on that fucking."],
  ["I start [__] around.", "I start fucking around."],
  ["Absolute [__] chaos.", "Absolute fucking chaos."],
  ["He just [__].", "He just fucking."],
  ["This was a [__] surprise.", "This was a fucking surprise."],
  ["I've got [__] all over me.", "I've got shit all over me."],
  ["I have [__] to do.", "I have shit to do."],
  ["It's the [__] that I wanted.", "It's the shit that I wanted."],
  ["The dumbest [__] that I have ever done.", "The dumbest shit that I have ever done."],
  ["Uh well [__].", "Uh well shit."],
  ["She did a [__] one.", "She did a bullshit one."],

  ["Stay down [__].", "Stay down bitch."],
  ["What the absolute [__]?", "What the absolute fuck?"],
  ["He scared the [__] out of them.", "He scared the shit out of them."],
  ["The sparks just start [__] flying.", "The sparks just start fucking flying."],
  ["That was [__] epic.", "That was fucking epic."],
  ["I [__] lost.", "I fucking lost."],
  ["This [__] planet.", "This fucking planet."],
  ["It is my [__] turn.", "It is my fucking turn."],
  ["I'm full of [__].", "I'm full of shit."],
  ["Hurry the [__] up.", "Hurry the fuck up."],
  ["I feel like [__].", "I feel like shit."],
  ["Take a [__].", "Take a shit."],
  ["You sick [__]!", "You sick fuck!"],
  ["[__] son of a bitch.", "fucking son of a bitch."],
  ["That is such [__].", "That is such bullshit."],
  ["Play dead, [__]!", "Play dead, bitch!"],
  ["[__] the police.", "fuck the police."],
  ["You posh [__].", "You posh twat."],
  ["Stop [__]-shaming.", "Stop slut-shaming."],
  ["None of you [__] know me.", "None of you motherfuckers know me."],
  ["Jake to the [__] rescue.", "Jake to the motherfucking rescue."],
  ["I won't apologize for this [__].", "I won't apologize for this shit."],
  ["Cut the [__].", "Cut the shit."],
  ["You crazy [__].", "You crazy bitch."],
  ["This is [__].", "This is bullshit."],

  ["that's so [__] up", "that's so fucked up"],
  ["That's really [__] up.", "That's really fucked up."],
  ["this is just [__] up", "this is just fucked up"],
  ["will [__] it up", "will fuck it up"],
  ["Will [__] things up.", "Will fuck things up."],
  ["this [__] is funny", "this shit is funny"],
  ["Say [__] it and move.", "Say fuck it and move."],
  ["The most insane [__] ever.", "The most insane shit ever."],
  ["Some really good [__].", "Some really good shit."],
  ["I'm full of [__].", "I'm full of shit."],
  ["You're so full of [__].", "You're so full of shit."],
  ["You [__] up my plan.", "You fucked up my plan."],
  ["Yeah [__] me.", "Yeah fuck me."],
  ["What the [__] you want?", "What the fuck you want?"],
  ["For [__]'s sake.", "For fuck's sake."],
  ["What the [__]'s going on?", "What the fuck's going on?"],
  [">> No [__], that happened.", ">> No shit, that happened."],
  ["He ate [__] on the floor.", "He ate shit on the floor."],
  ["Do dumb [__].", "Do dumb shit."],
  ["Stop doing dumb [__].", "Stop doing dumb shit."],
  ["It's really [__] up.", "It's really fucked up."],
  ["Like really [__] up.", "Like really fucked up."],
  ["Yeah really [__] up.", "Yeah really fucked up."],
  ["I [__] hate it.", "I fucking hate it."],
  ["Just [__] stop it.", "Just fucking stop it."],
  ["Don't [__] touch it.", "Don't fucking touch it."],
  ["What the [__] is wrong with you?", "What the fuck is wrong with you?"],
  ["[__] you that's where it is.", "fuck you that's where it is."],
  ["Craig is an [__].", "Craig is an asshole."],
  ["Figure this [__] out.", "Figure this shit out."],
  ["Say some dumb [__].", "Say some dumb shit."],
  ["He said [__] it and left.", "He said fuck it and left."],
  ["I need to [__] it up.", "I need to fuck it up."],
  ["Oh [__] I did.", "Oh shit. I did."],
  ["Oh [__] I didn't.", "Oh shit. I didn't."],
  ["A [__] eating grin", "A shit eating grin"],
  ["You don't know jack [__].", "You don't know jack shit."],
  ["I couldn't see [__] in the dark.", "I couldn't see shit in the dark."],
  ["I didn't see [__] at all.", "I didn't see shit at all."],
  ["I can't see [__] anymore.", "I can't see shit anymore."],
  ["Shut this [__] up.", "Shut this fuck up."],
  ["I can't sing for [__].", "I can't sing for shit."],
  ["A [__] five year old.", "A fucking five year old."],
  ["This [__] is weird and bad.", "This shit is weird and bad."],
  ["A [__] effort.", "A fucking effort."],
];

for (const [input, expected] of examples) {
  assert.strictEqual(rules.applyDeterministicRules(input, { ambiguous: "first" }).text, expected);
}

assert.strictEqual(rules.applyDeterministicRules("Who gives a [__] now?").text, "Who gives a shit now?");
assert.strictEqual(
  rules.applyDeterministicRules("Who gives a [__] about that?").text,
  "Who gives a shit about that?"
);
assert.strictEqual(
  rules.applyDeterministicRules("That was weird [__] yesterday.").text,
  "That was weird shit yesterday."
);
assert.strictEqual(
  rules.applyDeterministicRules("It is a weird [__] statue.").text,
  "It is a weird fucking statue."
);

assert.strictEqual(rules.applyDeterministicRules("holy [__] I touched it").text, "holy shit. I touched it");
assert.strictEqual(rules.applyDeterministicRules("I'll [__] it up").text, "I'll fuck it up");
assert.strictEqual(rules.applyDeterministicRules("just [__] around").text, "just fucking around");
assert.strictEqual(rules.applyDeterministicRules("they're [__] up right now").text, "they're fucking up right now");
assert.strictEqual(rules.applyDeterministicRules("scare the [__] out of me").text, "scare the shit out of me");
assert.strictEqual(rules.applyDeterministicRules("oh [__] That's bad").text, "oh shit. That's bad");
assert.strictEqual(rules.applyDeterministicRules("oh [__] This is bad").text, "oh shit. This is bad");
assert.strictEqual(
  rules.applyDeterministicRules("I don't give a [__] about it.").text,
  "I don't give a [__] about it."
);
assert.deepStrictEqual(
  rules.applyDeterministicRules("I don't give a [__] about it.").decisions[0].rule.candidates,
  ["fuck", "shit"]
);
assert.deepStrictEqual(
  rules.applyDeterministicRules("I don't give a [__] anymore.").decisions[0].rule.candidates,
  ["fuck", "shit"]
);
assert.deepStrictEqual(
  rules.applyDeterministicRules("Nobody gives a [__].").decisions[0].rule.candidates,
  ["fuck", "shit"]
);
assert.strictEqual(rules.applyDeterministicRules("[__] me").text, "[__] me");
assert.strictEqual(rules.applyDeterministicRules("watch this [__]").text, "watch this shit");
assert.strictEqual(rules.applyDeterministicRules("what the [__]", { ambiguous: "abstain" }).text, "what the fuck");
assert.strictEqual(rules.applyDeterministicRules("where the [__]", { ambiguous: "abstain" }).text, "where the [__]");
assert.deepStrictEqual(
  rules.applyDeterministicRules("watch this [__]").replacements.map((replacement) => ({
    source: replacement.source,
    score: replacement.score,
    margin: replacement.margin,
    support: replacement.support,
    tier: replacement.tier
  })),
  [{ source: "paired", score: 0.8649, margin: 0.7838, support: 37, tier: "productive" }]
);

assert.strictEqual(rules.formatWordCase("fucking", "that was WILD [__] today"), "FUCKING");
assert.strictEqual(rules.formatWordCase("fucking", "HAVING A [__] day"), "FUCKING");
assert.strictEqual(rules.formatWordCase("fucking", "having A [__] day"), "fucking");
assert.strictEqual(rules.formatWordCase("fucking", "I [__] hate this"), "fucking");
assert.strictEqual(rules.formatWordCase("fucking", "that was Wild [__] today"), "fucking");
assert.strictEqual(rules.applyDeterministicRules("this is clean").text, "this is clean");
assert.strictEqual(rules.applyDeterministicRules("are [__] wild").text, "are fucking wild");
assert.strictEqual(rules.applyDeterministicRules("is [__] hard").text, "is fucking hard");
assert.strictEqual(rules.applyDeterministicRules("You look like [__] idiot.").text, "You look like fucking idiot.");
assert.strictEqual(rules.applyDeterministicRules("Play dead, [__]! ♪").text, "Play dead, bitch! ♪");
assert.strictEqual(rules.applyDeterministicRules("a [__] excuse").text, "a fucking excuse");
assert.strictEqual(rules.applyDeterministicRules("Oh [__] why").text, "Oh [__] why");
assert.strictEqual(rules.applyDeterministicRules("Oh [__] I can").text, "Oh [__] I can");
assert.strictEqual(rules.applyDeterministicRules("oh [__] no").text, "oh [__] no");
assert.strictEqual(rules.applyDeterministicRules("I don't [__].").text, "I don't [__].");
assert.strictEqual(rules.applyDeterministicRules("This [__].").text, "This [__].");
assert.strictEqual(rules.applyDeterministicRules("That [__].").text, "That [__].");
assert.strictEqual(rules.applyDeterministicRules("I don't [__] know").text, "I don't fucking know");
assert.strictEqual(rules.applyDeterministicRules("I don't [__] need that").text, "I don't fucking need that");
assert.strictEqual(rules.applyDeterministicRules("haven't even [__] defrosted").text, "haven't even fucking defrosted");
assert.strictEqual(rules.applyDeterministicRules("I would [__] know").text, "I would fucking know");
assert.strictEqual(rules.applyDeterministicRules("They are so [__].").text, "They are so fucked.");
assert.strictEqual(rules.applyDeterministicRules("[__] [__] you").text, "[__] [__] you");
assert.strictEqual(rules.applyDeterministicRules("[__] [__] me").text, "[__] [__] me");
assert.strictEqual(rules.applyDeterministicRules("are you [__]\nserious").text, "are you fucking\nserious");
assert.strictEqual(rules.applyDeterministicRules("Bull [__] [__], dude.").text, "Bull fucking shit, dude.");
assert.strictEqual(rules.applyDeterministicRules("some sick [__] trying", { ambiguous: "first" }).text, "some sick [__] trying");
assert.strictEqual(rules.applyDeterministicRules("some sick [__] Trying", { ambiguous: "first" }).text, "some sick fuck. Trying");
assert.strictEqual(rules.applyDeterministicRules("YOU SICK [__] WHERE are", { ambiguous: "first" }).text, "YOU SICK FUCK. WHERE are");
assert.strictEqual(rules.applyDeterministicRules("SOME SICK [__] TRYING TO", { ambiguous: "first" }).text, "SOME SICK [__] TRYING TO");
assert.strictEqual(
  rules.applyDeterministicRules("That worked. [__] yeah.").text,
  "That worked. Fuck yeah."
);
assert.strictEqual(
  rules.applyDeterministicRules("Holy [__]\nThere's so much.", { ambiguous: "first" }).text,
  "Holy shit.\nThere's so much."
);
assert.strictEqual(
  rules.applyDeterministicRules("Holy [__]\nAnd then we left.", { ambiguous: "first" }).text,
  "Holy shit.\nAnd then we left."
);
assert.strictEqual(
  rules.applyDeterministicRules("Holy [__]\nGod knows why.", { ambiguous: "first" }).text,
  "Holy shit\nGod knows why."
);
assert.strictEqual(
  rules.applyDeterministicRules("Holy [__]\nKevin arrived.", { ambiguous: "first" }).text,
  "Holy shit.\nKevin arrived."
);
assert.strictEqual(
  rules.applyDeterministicRules("Holy [__] >> There is so much.", { ambiguous: "first" }).text,
  "Holy shit. >> There is so much."
);
assert.strictEqual(
  rules.applyDeterministicRules("so [__] confused").text,
  "so fucking confused"
);
assert.strictEqual(rules.applyDeterministicRules("not giving a [__] about it").text,
  "not giving a shit about it"
);
assert.strictEqual(rules.applyDeterministicRules("This mechanic sucks [__].").text,
  "This mechanic sucks shit."
);
assert.strictEqual(rules.applyDeterministicRules("Sucks. [__].").text, "Sucks. Shit.");
assert.strictEqual(rules.applyDeterministicRules("You don't [__] cheat.").text,
  "You don't fucking cheat."
);
assert.strictEqual(rules.applyDeterministicRules("It was sad and [__] up.").text,
  "It was sad and fucked up."
);
assert.strictEqual(rules.applyDeterministicRules("That [__] calms me down.").text,
  "That shit calms me down."
);
assert.strictEqual(rules.applyDeterministicRules("Oh [__], I dropped it.").text,
  "Oh shit, I dropped it."
);
assert.strictEqual(rules.applyDeterministicRules("don't [__] where you eat").text,
  "don't shit where you eat"
);
assert.strictEqual(rules.applyDeterministicRules("this [__] restaurant").text,
  "this fucking restaurant"
);
assert.strictEqual(rules.applyDeterministicRules("a [__] answer").text,
  "a fucking answer"
);
assert.strictEqual(rules.applyDeterministicRules("every [__] law").text,
  "every fucking law"
);
// The noun role requires a determiner; an expletive before “answer” is not
// inferred from the lexical noun alone.
assert.strictEqual(rules.applyDeterministicRules("[__], answer the phone").text,
  "[__], answer the phone"
);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "holy [__]").candidates, ["shit", "fuck", "fucking"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "was [__] around").candidates, ["fucking", "dicking", "fuck", "dickin", "fucked"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "getting [__] over").candidates, ["fucked", "dicked"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "a [__] ton").candidates, ["shit", "fucking", "fuck"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "kicking the [__] out").candidates, ["shit", "fuck"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "watch this [__]").candidates, ["shit", "fuck", "fucking"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "all that [__]").candidates, ["shit", "bullshit"]);
assert.deepStrictEqual(
  rules.DETERMINISTIC_RULES.filter((rule) => [
    "[__] is going ", "in a [__] ", "[__] cool", "it's a [__]$",
    "have the [__] ", "it was [__]$", "than [__] ", "lot of [__] going",
    "was a [__]$", "there's so much [__]", "scared the [__] out"
  ].includes(rule.template)),
  []
);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "what the [__]").candidates, ["fuck"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "[__] off").candidates, ["fuck", "fucking", "fucked", "shit"]);
assert.deepStrictEqual(rules.DETERMINISTIC_RULES.find((rule) => rule.template === "[__] me").candidates, ["fuck", "fucked", "fucking", "shitting"]);
assert.deepStrictEqual(
  [
    "ass", "piss", "pissed", "crap", "bastard", "sluts", "slutty",
    "bitchy", "shitshow", "dogshit", "clusterfuck", "fuckable", "nigger",
    "retarded", "fuckboy", "fuckton", "shitstain", "shitface", "shitbird"
  ]
    .filter((word) => rules.ALLOWED_WORDS.includes(word)),
  []
);
assert.ok(rules.DETERMINISTIC_RULES.every((rule) => rule.candidates.length));

console.log("rules.test.js passed");
