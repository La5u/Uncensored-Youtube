(function buildRuleGrammar() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var compiler = root.UncensoredRuleCompiler ||
    (typeof require === "function" ? require("../rules-compiler") : null);
  var set = compiler.set;
  var slot = compiler.slot;
  var pattern = compiler.pattern;
  var patterns = compiler.patterns;
  var frame = compiler.frame;
  var group = compiler.group;
  var parts = root.UncensoredRuleDataParts;
  var vocabulary = parts.language;

  var SUBJECT_PRONOUNS = vocabulary.SUBJECT_PRONOUNS;
  var OBJECT_PRONOUNS = vocabulary.OBJECT_PRONOUNS;
  var POSSESSIVE_DETERMINERS = vocabulary.POSSESSIVE_DETERMINERS;
  var PLAIN_VERB_SUBJECTS = vocabulary.PLAIN_VERB_SUBJECTS;
  var THIRD_PERSON_SUBJECTS = vocabulary.THIRD_PERSON_SUBJECTS;
  var FUTURE_SUBJECTS = vocabulary.FUTURE_SUBJECTS;
  var NEGATED_SUBJECT_PREFIXES = vocabulary.NEGATED_SUBJECT_PREFIXES;
  var BE_FORMS = vocabulary.BE_FORMS;
  var FUCK_THE_SUFFIXES = vocabulary.FUCK_THE_SUFFIXES;
  var FUCK_YOU_PREFIXES = vocabulary.FUCK_YOU_PREFIXES;
  var FUCK_VERB_PREFIXES = vocabulary.FUCK_VERB_PREFIXES;
  var PHRASAL_UP_OBJECTS = vocabulary.PHRASAL_UP_OBJECTS;
  var PARTICIPLE_OBJECTS = vocabulary.PARTICIPLE_OBJECTS;
  var PERFECT_PREFIXES = vocabulary.PERFECT_PREFIXES;
  var GERUND_WITH_PREFIXES = vocabulary.GERUND_WITH_PREFIXES;
  var PARTICIPLE_MODIFIERS = vocabulary.PARTICIPLE_MODIFIERS;
  var FORCEFUL_ACTIONS = vocabulary.FORCEFUL_ACTIONS;
  var INTERJECTION_SUFFIXES = vocabulary.INTERJECTION_SUFFIXES;
  var SIMILE_PREFIXES = vocabulary.SIMILE_PREFIXES;
  var PRODUCTIVE_RULES = Object.freeze([
    group("productive/expressions", 2000, [
      pattern`${["go", "going", "gone"]} to [shit].`,
      pattern`${["yeah no", "yeah, no"]} [shit|fuck|fucking]`,
      pattern`look like [shit]$`,
      pattern`${["treat", "treated", "treating"]} ${OBJECT_PRONOUNS} like [shit]`,
      pattern`full of [shit]$`,
      pattern`cut that [shit] out`,
      pattern`like ah [fuck|shit]`,
      pattern`and [shit] ${["like that", "like", "and"]}`,
      pattern`[shit|fuck] out of me`,
      pattern`[fuck|fucked|fucking] ${["that guy", "this guy"]}`,
      pattern`[fuck] right off`,
      pattern`I [shit] you not`,
      pattern`to [shit|fucking] on`,
      pattern`the living [shit|fuck] out of`,
      pattern`clean this [shit] up`,
      pattern`watch this [shit|fuck|fucking]`,
      pattern`all this [shit|fucking|bullshit|pussy|fuck]`,
      pattern`${["this", "that"]} [shit] out`,
      pattern`${["got", "doesn't"]} [shit] to do`,
      pattern`making [shit] up`,
      pattern`get [shit] done`,
      pattern`${["better", "other", "some", "more", "enough", "plenty of", "a lot of", "a bunch of", "lots of"]} [shit] to do`,
      pattern`a lot of [shit|bullshit] ${["and", "around", "from", "going", "happened", "in", "so", "that", "to", "yeah"]}`,
      pattern`${["talks", "talked"]} [shit] ${["right", "now", "and", "when", "to", "about"]}`,
      pattern`throw that [shit] in`,
      pattern`shady [shit] ${["to", "and"]}`,
      pattern`[fucking] ${["losers", "rad", "impossible", "insane", "evil"]}`,
      pattern`do this [shit] …`,
      pattern`throwing [shit] at`,
      pattern`to [shit] ${["all over", "in"]}`,
      pattern`this [shit] for`,
      pattern`some [shit] out`,
      pattern`lot of [shit] ${["to", "in", "about"]}`,
      pattern`${["roll", "rolled", "rolling"]} like [shit]`,
      pattern`that's good [shit]`,
      pattern`smell like [shit]`,
      pattern`when [shit]`,
      pattern`of course it [fucking|fuck]`,
      pattern`going to be a [fucking|fuck|pussy]`,
      pattern`all the way to [fucking]`,
      pattern`eye on that [fucking]`,
      pattern`start [fucking] around`,
      pattern`don't [fuck] around`,
      pattern`just start [fucking]`,
      pattern`absolute [fucking] chaos`,
      pattern`he just [fucking|fucked]`,
      pattern`this was a [fucking|shit]`,
      pattern`a [fucking] surprise`,
      pattern`${POSSESSIVE_DETERMINERS} [fucking] turn`,
      pattern`${["that's really", "you're just", "it's pretty"]} [fucking] …`
    ]),

    group("productive/phrasal-verbs", 2010, [
      pattern`better not [fuck] things up`,
      pattern`[fuck] ${["him", "this"]} up`,
      pattern`${SUBJECT_PRONOUNS} [fucked|fuck|fucks|fucking] it up`,
      pattern`${GERUND_WITH_PREFIXES} [fucking] with`,
      pattern`${["dream about", "dream of"]} [fucking|shit] …`,
      pattern`were [fucked|fucking] with`,
      pattern`${["don't you", "don't", "I can"]} [fuck] with`,
      pattern`${["have", "has", "had"]} [fucked|fuck] ${["it", "me"]}`,
      pattern`${["am", "is", "are", "was", "were"]} [fucking|shit|fuck] it`,
      pattern`${["is", "was", "keeps"]} [fucking|fuck] me`,
      pattern`${["be", "were", "you're", "just"]} [dicking|fucking|fuck|dickin|fucked] around`,
      pattern`${["am", "is", "are", "was", "been", "being", "I'm", "he's", "she's", "we're", "they're"]} [fucking|dicking|fuck|dickin|fucked] around`,
      pattern`almost [fucked] me`,
      pattern`${["are you", "gotta be", "got to be", "to be"]} [shitting|fucking] me`,
      pattern`gonna [fuck|fucking] up`,
      pattern`wouldn't [fuck|fucked] up`,
      pattern`${["make", "let", "help"]} you [fuck] up`,
      pattern`[fuck] up ${PHRASAL_UP_OBJECTS}`,
      pattern`[fucked|fucking|fuck] up ${PARTICIPLE_OBJECTS}`,
      pattern`${PERFECT_PREFIXES} [fucked] up`,
      pattern`${["keeps", "stop", "stopped"]} [fucking] up`,
      pattern`kept [fucking|fucked] up`,
      pattern`${["you are", "you're"]} [fucked|fucking] up`,
      pattern`go [fuck] ${["himself", "herself", "themselves"]}`,
      pattern`[fuck|shit] you piece of`,
      pattern`[fuck] you ${["man", "game", "link", "Jesus", "Jimmy", "everyone", "I", "too", "doing", "dude", "and", "oh", "yeah", "bro"]}`,
      pattern`[fuck|shit] you all`,
      pattern`[fuck] you you`,
      pattern`[fuck] you,`,
      pattern`[fuck] all of you`,
      pattern`[fuck] outta here`,
      pattern`we're all [fucked|fucking]`,
      pattern`get [fucked] by`,
      pattern`you're getting [fucked] now`,
      pattern`kind of [dicked|fucked] me over`,
      pattern`${["got", "get", "getting", "being", "been"]} [fucked|dicked] over`,
      pattern`can get [fucked|shit|fuck]`,
      pattern`get [fucked] up`,
      pattern`${["we are", "we're", "is so", "I'm so", "you're so"]} [fucked].`,
      pattern`${["little", "got", "how", "pretty", "it's", "more", "like"]} [fucked] up`,
      pattern`shut the [fuck]`,
      pattern`get the [fuck|fucking] …`,
      pattern`[fuck|shit|motherfuckers|assholes|fucker|bitch|fucked] out of here`,
      pattern`[shit|fuck] out of them`,
      pattern`${["right", "back"]} the [fuck] …`,
      pattern`[fuck] was that`,
      pattern`[fuck] is up`,
      pattern`getting the [fuck] ${["out of", "out"]}`,
      pattern`[fuck] out of there`,
      pattern`${FORCEFUL_ACTIONS} the [shit|fuck] out`,
      pattern`${["freak", "freaked", "freaking"]} the [fuck|shit] out`,
      pattern`knock ${OBJECT_PRONOUNS} the [fuck] out`,
      pattern`${["slap", "slapped", "slapping", "slaps"]} the [shit|fuck] out`,
      pattern`something [fucked] up`,
      pattern`${["make", "made"]} this [shit] up`
    ]),

    group("productive/syntax", 2020, [
      pattern`${["what", "how", "who", "why", "when", "whatever"]} the [fuck]`,
      pattern`the [fuck] ${FUCK_THE_SUFFIXES}`,
      pattern`the [fuck|shit] ${["is", "you", "outta"]}`,
      pattern`come the [fuck] on`,
      pattern`buckle the [fuck]`,
      pattern`the [fuck's] going on`,
      pattern`the [fuck]'s`,
      pattern`[fuck's] sake`,
      pattern`for [fuck]'s sake`,
      pattern`>> no [shit]`,
      pattern`did you just [fucking] call`,
      pattern`how [fucking] ${["dare you", "dare"]}`,
      pattern`do you want to [fucking|fuck] …`,
      pattern`are you [fucking] ${["jerking", "liking"]}`,
      pattern`big [fuck|motherfucker] you`,
      pattern`${FUCK_YOU_PREFIXES} [fuck] you`,
      pattern`[fuck] you that's ${["what", "where", "who", "why", "when", "how"]}`,
      pattern`${FUCK_VERB_PREFIXES} [fuck] …`,
      pattern`no [fuck] that`,
      pattern`said [fuck] you`,
      pattern`[fuck] a duck`,
      pattern`to [fuck] the …`,
      pattern`[fuck] yeah.`,
      pattern`${["took a", "took a huge", "done a huge"]} [shit] in`,
      pattern`cheap [shit|pussy|motherfucker]`,
      pattern`${["fucking", "dog"]} [shit]`,
      pattern`${["absolute", "complete"]} [shit] show`,
      pattern`don't give me [shit] about`,
      pattern`${["give", "gives"]} a [fuck|shit]`,
      pattern`don't see [shit]`,
      pattern`${["same old", "the crazy", "some dumb"]} [shit]`,
      pattern`all the [shit] that`,
      pattern`[shit] your pants`,
      pattern`I call [bullshit]`,
      pattern`like a little [bitch]`,
      pattern`${["are you", "you"]} serious with this [shit]`,
      pattern`as [fucked] up as`,
      pattern`pretty [fucking] well`,
      pattern`important [shit]`,
      pattern`[shit] ${["going on", "at all", "that happened"]}`,
      pattern`[fuck] my life`,
      pattern`[fucking] damn it`,
      pattern`it's so [fucking] …`,
      pattern`who [fucking] knows`,
      pattern`${["sweet", "mother of"]} [fucking] Jesus`,
      pattern`strong as [fuck]`,
      pattern`[fucking] ${["sick of", "talk to"]}`,
      pattern`${["miss", "sell"]} the [shit] out of`,
      pattern`stuck up little [bitch]`,
      pattern`all [shit] themselves`,
      pattern`[cocks] ${["its head", "his head", "her head", "an eyebrow", "his eyebrow", "her eyebrow"]}`,
      pattern`[cock] ${["their head", "their eyebrow"]}`,
      pattern`${SUBJECT_PRONOUNS} [fucked|fuck|fucking|fuckers|fucks] up`,
      pattern`that's so [fucked|fucking] up`,
      pattern`${PARTICIPLE_MODIFIERS} [fucked] up`,
      pattern`${BE_FORMS.concat(["all", "team", "station"])} [fucked|fucking] up`,
      pattern`re [fucked].`
    ]),

    group("productive/insults", 2030, [
      pattern`wish a [bitch] would`,
      pattern`your [cock] shouldn't`,
      pattern`son of a [bitch]`,
      pattern`son of [bitches|bitch]`,
      pattern`sons of [bitches]`,
      pattern`[bitch] and moan`,
      pattern`an [asshole|arsehole]`,
      pattern`sick [fuck|fucker].`,
      pattern`consumer [whore]`,
      pattern`${["where is", "where's"]} this [motherfucker|fucking]`,
      pattern`wretched [cunts]`,
      pattern`is for [pussies]`
    ]),

    group("productive/contextual-fucking", 2040, [
      // Fixed expressions.
      pattern`these [fucking] people`,
      pattern`god [fucking] ${["damn it", "dammit", "damn"]}`,
      pattern`swear to [fucking] god`,
      pattern`[fucking] pieces of`,
      pattern`[fucking] ${["meeting", "text", "naked", "attack", "album"]}`,
      pattern`${PLAIN_VERB_SUBJECTS.concat(["be like", "going", "gonna"])} [fucking] need`,
      pattern`${["there is no", "."]} [fucking] need`,
      pattern`should be [fucking]`,
      pattern`${["hear", "let", "watch"]} that [shit]`,
      pattern`${["racist", "fun"]} [shit]`,
      pattern`magical [bullshit]`,
      pattern`[shit] I can`,
      pattern`oh [shit] yeah it's`,
      pattern`[fucking] ${["hit", "win", "loves", "try", "running"]}`,
      pattern`like [fuck] that`,
      pattern`let's go [fuck]`,
      pattern`[fuck] if I know`,
      pattern`[fuck] it okay`,

      // Verbs and commands.
      pattern`just [fucking] ${["tell me", "tell us", "die", "snorted", "go"]}`,
      pattern`${FUTURE_SUBJECTS} [fucking] ${["show you", "take the", "gut you"]}`,
      pattern`gonna [fucking] murder ${OBJECT_PRONOUNS}`,
      pattern`${PLAIN_VERB_SUBJECTS} [fucking] work`,
      pattern`${THIRD_PERSON_SUBJECTS} [fucking] works`,
      pattern`${PLAIN_VERB_SUBJECTS} ${["have", "had"]} [fucking] no`,
      pattern`${THIRD_PERSON_SUBJECTS} ${["has", "had"]} [fucking] no`,
      pattern`${["does not", "doesn't"]} [fucking] ever end`,
      pattern`does this level [fucking] ever end`,
      pattern`${PLAIN_VERB_SUBJECTS} don't have [fucking] time`,
      pattern`${THIRD_PERSON_SUBJECTS} doesn't have [fucking] time`,
      pattern`${["that", "this", "it"]} [fucking] kills`,
      pattern`[fucking] ${["unsubscribe", "cancerous"]}`,
      pattern`${["that", "this"]} was [fucking] …`,
      pattern`${NEGATED_SUBJECT_PREFIXES} [fucking|fuck] …`,
      pattern`${["he was", "that is a", "out of the", "back to the"]} [fucking] …`,
      pattern`[fucking] ${["do it", "did it"]}`,
      pattern`^[fucking] son of`,
      pattern`to [fucking] ${["do", "go", "die"]}`,
      pattern`oh my [fucking] …`,
      pattern`${["in your", "on a", "to a", "a giant", "massive", "single", "natural", "out of my", "over the"]} [fucking] …`,
      pattern`let's just [fucking] …`,

      // Adjectives and adverbs.
      pattern`being [fucking] nonchalant`,
      pattern`${["goddamn", "god damn"]} [fucking] ${["hot", "light"]}`,
      pattern`I'll be [fucking] annoyed`,
      pattern`just [fucking] great`,
      pattern`a [fucking] ${["good", "dead"]}`,
      pattern`right [fucking] there`,
      pattern`no [fucking] around`,
      pattern`${SIMILE_PREFIXES} like a [fucking] …`,
      pattern`uh oh [shit]`,
      pattern`oh [shit] ${INTERJECTION_SUFFIXES}`,
      pattern`you're like oh [shit]`,

      // Objects, people, places, and quantities.
      pattern`smallest [fucking] mouse`,
      pattern`[fucking|bitch] speedrun`,
      pattern`[fucking] ${["tail", "ripper", "speedun", "piece of"]}`,
      pattern`[fucking] ${["cool", "quit", "movies", "ar"]} *`,
      pattern`[fucking] * ${["year old", "million", "and shit", "it out"]}`
    ])
  ]);


  var WORD_ROLES = vocabulary.WORD_ROLES;
  var SUBJECT_PRONOUNS = vocabulary.SUBJECT_PRONOUNS;
  var FUTURE_SUBJECTS = vocabulary.FUTURE_SUBJECTS;
  var BASE_VERB_PREFIXES = vocabulary.BASE_VERB_PREFIXES;
  var BASE_VERB_QUESTION_PREFIXES = vocabulary.BASE_VERB_QUESTION_PREFIXES;
  var VERB_OBJECTS = vocabulary.VERB_OBJECTS;
  var VERB_PARTICLES = vocabulary.VERB_PARTICLES;
  var PHRASAL_VERB_PREFIXES = vocabulary.PHRASAL_VERB_PREFIXES;
  var PHRASAL_SUBJECT_MODALS = vocabulary.PHRASAL_SUBJECT_MODALS;
  var PHRASAL_PARTICLE_SUFFIXES = vocabulary.PHRASAL_PARTICLE_SUFFIXES;
  var PHRASAL_SUFFIXES = vocabulary.PHRASAL_SUFFIXES;
  var PARTICIPLE_FRAME_PREFIXES = vocabulary.PARTICIPLE_FRAME_PREFIXES;
  var PARTICIPLE_FRAME_SUFFIXES = vocabulary.PARTICIPLE_FRAME_SUFFIXES;
  var EXPLETIVE_DETERMINER_PREFIXES = vocabulary.EXPLETIVE_DETERMINER_PREFIXES;
  var EXPLETIVE_DETERMINER_SUFFIXES = vocabulary.EXPLETIVE_DETERMINER_SUFFIXES;
  var MASS_NOUN_PREFIXES = vocabulary.MASS_NOUN_PREFIXES;
  var AS_FUCK_ADJECTIVES = vocabulary.AS_FUCK_ADJECTIVES;
  var AS_SHIT_ADJECTIVES = vocabulary.AS_SHIT_ADJECTIVES;
  var INTENSIFIER_MODIFIERS = vocabulary.INTENSIFIER_MODIFIERS;
  var NEGATED_DO_PREFIXES = vocabulary.NEGATED_DO_PREFIXES;
  var INTENSIFIED_ADJECTIVES = vocabulary.INTENSIFIED_ADJECTIVES;
  var INTENSIFIER_DETERMINERS = vocabulary.INTENSIFIER_DETERMINERS;
  var INTENSIFIED_NOUNS = vocabulary.INTENSIFIED_NOUNS;
  var INTENSIFIER_COPULAS = vocabulary.INTENSIFIER_COPULAS;
  var INTENSIFIED_PREDICATES = vocabulary.INTENSIFIED_PREDICATES;
  var EMPHATIC_SUBJECTS = vocabulary.EMPHATIC_SUBJECTS;
  var EMPHATIC_ACTIONS = vocabulary.EMPHATIC_ACTIONS;
  var EMPHATIC_AUXILIARIES = vocabulary.EMPHATIC_AUXILIARIES;
  var EMPHATIC_AUXILIARY_ACTIONS = vocabulary.EMPHATIC_AUXILIARY_ACTIONS;
  var NUMBER = vocabulary.NUMBER;
  var COUNT_UNIT = vocabulary.COUNT_UNIT;
  var BASE_VERB = slot(WORD_ROLES.BASE_VERB);
  var EXPLETIVE = slot(WORD_ROLES.EXPLETIVE);
  var INTENSIFIER = slot(WORD_ROLES.INTENSIFIER);
  var PARTICIPLE = slot(WORD_ROLES.PARTICIPLE);
  var MASS_NOUN = slot(WORD_ROLES.MASS_NOUN);
  var SIMILE_FUCK = slot(set("simile fuck", ["fuck"]));
  var SIMILE_SHIT = slot(set("simile shit", ["shit"]));

  var ROLE_FRAMES = Object.freeze([
    group("frames/verb-intensifiers", 3000, [
      frame`${NEGATED_DO_PREFIXES} ${INTENSIFIER} ${VERB_OBJECTS}`
    ]),
    group("frames/base-verbs", 3010, [
      frame`${BASE_VERB_PREFIXES} ${BASE_VERB} ${VERB_OBJECTS}`,
      frame`${BASE_VERB_PREFIXES} ${BASE_VERB} ${VERB_PARTICLES}`,
      frame`${BASE_VERB_QUESTION_PREFIXES} ${BASE_VERB} ${VERB_PARTICLES}`
    ]),
    group("frames/expletives", 3020, [
      frame`${EXPLETIVE_DETERMINER_PREFIXES} the ${EXPLETIVE} ${EXPLETIVE_DETERMINER_SUFFIXES}`
    ]),
    group("frames/participles", 3030, [
      frame`${PARTICIPLE_FRAME_PREFIXES} ${PARTICIPLE} ${PARTICIPLE_FRAME_SUFFIXES}`
    ]),
    group("frames/intensifiers", 3040, [
      frame`${INTENSIFIER_DETERMINERS} ${INTENSIFIER} ${INTENSIFIED_NOUNS}`,
      frame`${INTENSIFIER_COPULAS} ${INTENSIFIER} ${INTENSIFIED_PREDICATES}`,
      frame`${EMPHATIC_SUBJECTS} ${INTENSIFIER} ${EMPHATIC_ACTIONS}`,
      frame`${EMPHATIC_AUXILIARIES} ${INTENSIFIER} ${EMPHATIC_AUXILIARY_ACTIONS}`,
      frame`${INTENSIFIER_MODIFIERS} ${INTENSIFIER} ${INTENSIFIED_ADJECTIVES}`,
      frame`${NUMBER} ${INTENSIFIER} ${COUNT_UNIT}`
    ]),
    group("frames/mass-nouns", 3050, [
      frame`${MASS_NOUN_PREFIXES} ${MASS_NOUN}`
    ]),
    group("frames/simile-expletives", 3060, [
      frame`${AS_FUCK_ADJECTIVES} as ${SIMILE_FUCK}`,
      frame`${AS_SHIT_ADJECTIVES} as ${SIMILE_SHIT}`
    ]),
    group("frames/phrasal-verbs", 3070, [
      frame`${PHRASAL_VERB_PREFIXES} ${BASE_VERB} ${PHRASAL_SUFFIXES}`,
      frame`${SUBJECT_PRONOUNS} ${PHRASAL_SUBJECT_MODALS} ${BASE_VERB} ${PHRASAL_PARTICLE_SUFFIXES}`,
      frame`${FUTURE_SUBJECTS} ${BASE_VERB} ${PHRASAL_PARTICLE_SUFFIXES}`
    ])
  ]);


  var QUESTION_WORDS = vocabulary.QUESTION_WORDS;
  var INTENSIFIED_TRAILING_WORDS = vocabulary.INTENSIFIED_TRAILING_WORDS;
  var VALIDATED_INTENSIFIER_SUFFIXES = vocabulary.VALIDATED_INTENSIFIER_SUFFIXES;
  var RARE_INTENSIFIER_SUFFIXES = vocabulary.RARE_INTENSIFIER_SUFFIXES;
  var SAFE_INTENSIFIER_PREFIXES = vocabulary.SAFE_INTENSIFIER_PREFIXES;
  var LOW_CONFIDENCE_RULES = Object.freeze([
    group("low-confidence/mass-nouns", 4000, [
      pattern`${[
        "of this", "for this", "do this", "my own", "into this"
      ]} [shit]$`,
      pattern`with that [shit]$`,
      pattern`cut the [shit]$`,
      pattern`load of [shit]$`,
      pattern`${["don't have", "looks like"]} [shit]$`,
      pattern`${["this is", "all the", "for your", "to his"]} [bullshit]$`
    ]),
    group("low-confidence/insults", 4010, [
      pattern`${["a little", "a crazy", "you crazy", "you fuckin'", "she's a"]} [bitch]$`,
      pattern`you [fucked] my wife`,
      pattern`are so [fucked]$`
    ]),
    group("low-confidence/rare-words", 4020, [
      pattern`posh [twat]`,
      pattern`acting the [twat]`,
      pattern`gutter [slut]`,
      pattern`[slut]-shaming`,
      pattern`a dirty [cunt]$`,
      pattern`ungrateful [cunt]$`,
      pattern`one of his [whores]`,
      pattern`burn the [fucker] down`,
      pattern`those [fuckers] ${["to", "don't"]}`,
      pattern`these [fuckers] and`,
      pattern`none of you [motherfuckers]`,
      pattern`those [assholes] aren't`,
      pattern`rich [assholes] are`,
      pattern`[assholes] are never`,
      pattern`lick my [pussy]`,
      pattern`[pussy] whip`,
      pattern`the [motherfucking] rescue`,
      pattern`straight to their [motherfucking]`,
      pattern`dried [cum]`,
      pattern`place is a [shithole]$`,
      pattern`you're the [dickhead] who`,
      pattern`named [shithead]`
    ])
  ]);

  var FALLBACK_RULES = Object.freeze([
    group("fallback/ambiguous", 5000, [
      pattern`${["oh", "ah", "aw", "ugh", "well"]} [fuck|shit]`,
      pattern`the [fuck|shit] out`,
      pattern`${["weird", "same"]} [shit|fucking] …`,
      pattern`all that [shit|bullshit]`,
      pattern`look at this [shit|fucking]`,
      pattern`what in the [fuck]`,
      pattern`${["what is that", "what is this"]} [shit|bullshit|fucking|motherfucker]`,
      pattern`${QUESTION_WORDS} the [fuck|fuck's|fucking|fuckers]`,
      pattern`${["bounce", "butt", "come", "drop", "go", "move", "moving", "spread", "walk", "want"]} the [fuck] out`,
      pattern`roll the [shit|fuck] out`,
      pattern`${["get me", "get you", "get him", "get her", "get us", "get them", "get 'em", "get everyone", "get that"]} the [fuck] out`,
      pattern`${["chill", "knocked", "leave me"]} the [fuck]`,
      pattern`right [fuck] ${["out", "away", "alone"]}`,
      pattern`super [fucked] up`,
      pattern`show some [fucking] respect`,
      pattern`sit [fucking] still`,
      pattern`[fuck|fucked|fucking|shitting] me`,
      pattern`[fuck|shit] yourself`,
      pattern`[fuck|fucking|fucked|shit] off`,
      pattern`this [shit|motherfucker|bitch|bullshit|fucker|fucking] is`,
      pattern`[fuck|fucking|fucked|shit|bullshit|bitch] it`,
      pattern`[fucking|shit|motherfuckers] eyes`,
      pattern`you're [fucking|fucked] …`,
      pattern`got the [fuck|shit] out`,
      pattern`got the [shit] kicked`,
      pattern`doesn't [fucking|shit|fuck] …`,
      pattern`you want to [fucking|fuck|shit] …`,
      pattern`wanted to [fuck|fucking] …`,
      pattern`[fucking] ${["epic", "lost"]}`,
      pattern`[fucking|shit] figure`,
      pattern`[fucking|bullshit] planet`,
      pattern`${SAFE_INTENSIFIER_PREFIXES} [fucking] …`,
      pattern`[fucking] ${INTENSIFIED_TRAILING_WORDS.concat(
        VALIDATED_INTENSIFIER_SUFFIXES,
        RARE_INTENSIFIER_SUFFIXES
      )}`,
      pattern`I'm a [fucking|fuck|bitch|whore] …`,
      pattern`have a [fucking|shit|bullshit] …`,
      pattern`there's a [fucking|fuck] …`,
      pattern`got a [fucking|shit|fucked] …`,
      pattern`[fucking|fuck|bitch] nothing`,
      pattern`[fucking|shit] sucks`,
      pattern`[shit|fucking] like this`,
      pattern`[shit] all over the`,
      pattern`[fucking|shit|asshole|fucked] thing`,
      pattern`[fucking|bitch|fuck|bullshit|pussy] ass`,
      pattern`[fucking|fuck|fuckers|motherfucker|fucker] kill`,
      pattern`[fucking|fuck] awesome`,
      pattern`${["ain't got", "the good"]} [shit] …`,
      pattern`all your [shit|fucking] …`,
      pattern`${["cuz", "to say"]} [fuck] …`,
      pattern`woo [fuck|bitches] …`,
    ])
  ]);


  var exports = Object.freeze({
    productive: PRODUCTIVE_RULES,
    frames: ROLE_FRAMES,
    lowConfidence: LOW_CONFIDENCE_RULES,
    fallback: FALLBACK_RULES
  });

  parts.grammar = exports;
  if (typeof module === "object" && module.exports) module.exports = exports;
})();
