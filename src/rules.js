(function buildRules() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;

  var CENSORED_TOKEN = "[__]";
  var CENSORED_TOKEN_REGEX = /\[\s*__\s*\]/gu;
  var SENTENCE_END_REGEX = /[.!?]/;

  var WORD_FAMILIES = Object.freeze({
    fuck: Object.freeze(["fuck", "fucks", "fuck's", "fucking", "fucked", "fucker", "fuckers", "fuckery"]),
    motherfucker: Object.freeze(["motherfuck", "motherfucker", "motherfuckers", "motherfucking"]),
    shit: Object.freeze(["shit", "shithole", "shitting", "shithead", "shitheads", "shitter"]),
    bitch: Object.freeze(["bitch", "bitches"]),
    cock: Object.freeze(["cock", "cocks", "cocksucker"]),
    asshole: Object.freeze(["arsehole", "asshole", "assholes"]),
    dick: Object.freeze(["dicked", "dicking", "dickin", "dickhead", "dickheads"]),
    twat: Object.freeze(["twat", "twats"]),
    whore: Object.freeze(["whore", "whores"]),
    cunt: Object.freeze(["cunt", "cunts"]),
    pussy: Object.freeze(["pussy", "pussies"])
  });

  // Non-censored words to note: shitty, dick
  var ALLOWED_WORDS = Object.freeze([].concat(
    WORD_FAMILIES.fuck,
    WORD_FAMILIES.motherfucker,
    WORD_FAMILIES.shit,
    WORD_FAMILIES.bitch,
    ["moron", "bullshit", "dipshit"],
    WORD_FAMILIES.cock,
    WORD_FAMILIES.asshole,
    WORD_FAMILIES.dick,
    WORD_FAMILIES.twat,
    WORD_FAMILIES.whore,
    WORD_FAMILIES.cunt,
    WORD_FAMILIES.pussy,
    ["slut", "cum", "cripple"]
  ));

  var SUBJECT_PRONOUNS = Object.freeze(["I", "you", "he", "she", "we", "they"]);
  var BE_FORMS = Object.freeze(["is", "was", "were", "I'm", "he's", "she's", "we're", "they're"]);
  var QUESTION_WORDS = Object.freeze(["what", "how", "where", "who", "why"]);
  var FUCK_THE_SUFFIXES = Object.freeze(["is", "are", "did", "do", "does", "am", "you", "was", "were", "say", "want", "know", "can", "have", "outta", "what"]);
  var FUCK_YOU_PREFIXES = Object.freeze([".", "!", "?", "and", "or", "yeah", "yeah,", "no", "no,", "so", "dude", "dude,", "big", "well", "go", "to", "yes", "me"]);
  var FUCK_VERB_PREFIXES = Object.freeze(["wanting to", "wanted to", "would rather", "would you rather", "would you rather we", "do you want to"]);
  var FUCK_UP_VERB_PREFIXES = Object.freeze([
    "don't", "do not",
    "didn't", "did not",
    "can't", "cannot",
    "won't",
    "wouldn't",
    "shouldn't",
    "couldn't",
    "better not",
    "try not to",
    "going to",
    "gonna",
    "about to",
    "want to",
    "wanted to",
    "wants to",
    "need to",
    "needs to",
    "had to",
    "have to",
    "has to",
    "let me",
    "let's",
    "I might",
    "you might",
    "I will",
    "you will",
    "I'll"
  ]);
  var PHRASAL_UP_OBJECTS = Object.freeze([
    "everything",
    "the whole thing",
    "the plan",
    "the game",
    "the mission",
    "the test",
    "the exam"
  ]);
  var FUCK_UP_PRONOUN_SUFFIXES = Object.freeze(["[fuck] you up", "[fuck] him up", "[fuck] her up", "[fuck] us up", "[fuck] them up"]);
  var PERFECT_PREFIXES = Object.freeze(["have", "has", "had", "I've", "you've", "we've", "they've"]);
  var FUCKING_WITH_PREFIXES = Object.freeze(["are you", "I'm", "I'm just", "you're", "who's"]);
  var FUCKED_UP_PREFIXES = Object.freeze(["that's", "that's so", "so", "it's so", "really", "massively", "most", "kind of", "special kind of", "too", "real", "completely"]);
  var SHIT_NOUN_PREFIXES = Object.freeze(["eat", "taking a", "cheap", "funny"]);
  var SHIT_OUT_PREFIXES = Object.freeze(["scaring", "scared", "freaks", "irritates"]);
  var SHIT_OUT_ACTIONS = Object.freeze([
    "beat", "beating", "kick", "kicked", "kicking", "smack", "smacking",
    "shoot", "push", "pushed", "scares", "stab", "punch"
  ]);
  var SHIT_TOGETHER_PREFIXES = Object.freeze(["get your", "get our", "get my", "pull your", "pull my", "got your", "got my"]);
  var SHIT_INITIAL_SUFFIXES = Object.freeze(["quality", "starts getting", "started getting", "hits the fan", "happens", "his pants"]);
  var FUCKING_SHARED_FALLBACK_WORDS = Object.freeze(["bad", "close", "dead", "easy", "great", "hard", "nuts", "scared"]);
  var FUCKING_SHARED_STATE_WORDS = Object.freeze(["done", "good", "hot", "huge", "impossible", "insane", "joking", "sick", "sorry"]);
  var FUCKING_BARE_NOUNS = Object.freeze([
    "day", "eyes", "hell", "idiot", "joke", "mess", "mind", "money", "nightmare", "place", "sense", "time"
  ]);
  var FUCKING_BARE_PREDICATES = Object.freeze(["amazing", "crazy", "disgusting", "pathetic", "pissed", "ridiculous", "stupid", "weird"]);
  var FUCKING_TRAILING_WORDS = Object.freeze(FUCKING_SHARED_FALLBACK_WORDS.concat(
    FUCKING_BARE_NOUNS, FUCKING_BARE_PREDICATES, [
    "air", "annoying", "badass", "ball", "bastard", "battle",
    "beast", "better", "brilliant", "cares", "chair", "christ", "concentrate",
    "creepy", "damage", "dark", "death", "double", "embarrassing", "fantastic",
    "fire", "fly", "freaky", "fun", "genius", "gross", "hair", "hammer",
    "help", "hope", "horrible", "horse", "ice", "idiots", "key", "know",
    "legs", "long", "loud", "love", "made", "map", "mean", "mental",
    "morons", "move", "murder", "music", "nerve", "ninja", "nonsense",
    "party", "pay", "power", "raw", "reason", "record", "red", "robot", "roll",
    "same", "scary", "shark", "shoot", "slow", "sound", "speed", "suck",
    "sweet", "terrible", "terrifying", "tongue", "tree", "trees", "useless",
    "video", "wall", "water", "work",
    "worked", "worry"
  ]));
  var FUCKING_ADJECTIVE_PREFIXES = Object.freeze(["I'll be", "I'm", "you're", "he's", "she's", "we're", "they're", "it is", "that is", "this is", "are you", "is so", "I'm so", "you're so", "so", "really", "pretty", "virtually", "not", "was"]);
  var FUCKING_ADJECTIVES = Object.freeze(FUCKING_SHARED_FALLBACK_WORDS.concat(
    FUCKING_SHARED_STATE_WORDS, [
    "bruised", "cold", "confused", "cool", "fast", "funny", "happy",
    "high", "obvious", "proud", "random", "smooth", "strange", "tired"
  ]));
  // Broad prefixes retained only at >=90% corpus precision.
  var SAFE_FUCKING_PREFIXES = Object.freeze([
    "absolutely", "big", "by a", "can't even", "didn't even",
    "doesn't", "don't even", "don't you", "down the", "entire", "even", "every",
    "feel", "for a", "from the", "genuinely", "get some", "god the", "got some",
    "got the", "great", "had a", "have no", "have to", "he's", "I can't",
    "I need to", "I'm", "I'm going to", "in a", "into a", "into the", "is just",
    "just a", "just how", "look at the", "many", "million", "not going to",
    "not gonna", "off the", "oh it's", "outright",
    "put some", "she's", "sheer", "should have", "so", "so many", "stop",
    "straight up", "super", "than", "that is", "that's just", "that's pretty",
    "the first", "there's no", "they're", "this is", "through the", "to be",
    "too", "very", "what are you", "whole", "with a", "with the", "would be",
    "yeah you", "you want to", "you're"
  ]);
  var BULLSHIT_PREFIXES = Object.freeze(["seems like", "corporate", "political", "marketing", "legal", "made up"]);
  var BULLSHIT_SUFFIXES = Object.freeze(["rule", "policy", "explanation"]);
  var FUCKING_DETERMINERS = Object.freeze(["a", "an", "the", "this", "that", "these", "those", "my", "your", "his", "her", "our", "their", "every", "no"]);
  var FUCKING_NOUNS = Object.freeze(FUCKING_BARE_NOUNS.concat([
    "animal", "anchor", "ass", "asshole", "baby", "balls", "bar", "bed", "best",
    "bitch", "body", "boar", "boss", "brains", "break", "business", "cake", "car",
    "cheater", "chicken", "choice", "checkpoint", "clothes", "clue", "cop", "cops", "coward",
    "date", "deal", "dick", "disaster", "dog", "door", "drill", "epipen", "fish",
    "face", "family", "fault", "finger", "floor", "grain",
    "god", "ground", "gun", "guns", "guy", "guys", "hand", "hands", "head", "house",
    "idea", "island", "job", "jobs", "jump", "keys", "kid", "kids",
    "kilo", "knife", "leg", "level", "liar", "lie", "life", "lights", "lives", "load", "loser", "lunatic",
    "monster", "moron", "mother", "mouth", "name", "night",
    "nose", "pants", "phone", "picture", "pig", "places", "platform", "problem",
    "point", "psycho", "psychopath", "pulse", "rat", "robbery", "room", "rules", "shit",
    "rhythm game", "slut", "space", "street", "sword", "teenager", "thing", "things", "throat", "toes", "trunk", "truck",
    "truth", "van", "waste", "way", "weapons", "wife", "window", "word", "words",
    "world", "year"
  ]));
  var FUCKING_COPULAS = Object.freeze(BE_FORMS.concat(["am", "are", "be", "been", "being", "you're", "it's", "that's", "are you"]));
  var FUCKING_PREDICATES = Object.freeze(FUCKING_SHARED_STATE_WORDS.concat(
    FUCKING_BARE_PREDICATES, [
      "around", "awful", "awesome", "bullshit", "dead", "exhausting", "freezing",
      "gone", "great", "hard", "her", "hilarious", "incredible", "kidding",
      "killing", "lying", "mad", "not", "nuts", "serious", "starving", "talking",
      "terrified", "trying", "wrong"
  ]));
  var FUCKING_SUBJECTS = Object.freeze(SUBJECT_PRONOUNS.concat([
    "it", "no one", "nobody", "someone",
    "everybody", "everyone", "I'll", "you'll", "he'll", "she'll", "we'll",
    "they'll", "I'm gonna", "you're gonna", "we're gonna", "they're gonna"
  ]));
  var FUCKING_BASE_ACTIONS = Object.freeze([
    "believe", "care", "dare", "die", "do", "get", "go", "kill", "know",
    "listen", "move", "need", "say", "see", "stop", "tell", "touch",
    "understand", "want"
  ]);
  var FUCKING_ACTIONS = Object.freeze(FUCKING_BASE_ACTIONS.concat([
    "did", "does", "doing", "find", "got", "hate", "hear", "jump", "kidding",
    "killed", "kills", "knew", "knows", "left", "let", "lied", "love", "needs",
    "shot", "sucks", "think", "told", "warned"
  ]));
  var FUCKING_AUXILIARY_PREFIXES = Object.freeze([
    "can", "can't", "can't even", "cannot", "could", "couldn't", "didn't",
    "do not", "does not", "don't", "don't even", "don't you", "doesn't", "haven't even", "better not",
    "let's", "must", "should", "shouldn't", "will", "won't", "would", "wouldn't"
  ]);
  var FUCKING_AUXILIARY_ACTIONS = Object.freeze(FUCKING_BASE_ACTIONS.concat([
    "attack", "be", "breathe", "defrosted", "end", "fight", "have", "launch",
    "lie", "like", "look", "matter", "party", "redo", "stand", "start", "suck",
    "talk", "trust", "work"
  ]));
  var NUMBER_WORD_PATTERN = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)";
  var NUMBER_PATTERN = "(?:\\d+(?:[,.]\\d+)*|" + NUMBER_WORD_PATTERN + "(?:[-\\s]+" + NUMBER_WORD_PATTERN + "){0,3})";
  var COUNT_UNIT_PATTERN = "(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|times?)";

  // Tier 1: exact idioms. These must win over every productive or fallback rule.
  var EXACT_IDIOM_RULE_PATTERNS = Object.freeze([
    [["start with this", "start this"], "[bullshit]"],
    "holy [shit|fuck|fucking]",
    "this [shit] happened",
    [["none of that", "that kind of", "this kind of", "this type of", "that type of"], "[shit]"],
    [["crock", "pile", "sack"], "of [shit]"],
    "the actual [fuck]",
    "don't know [shit] about",
    "can't see [shit]",
    [["lose your", "lose my"], "[shit]"],
    "zero [fucking] deaths",
    "pure [fucking] respect",
    "piece of [fucking] ass",
    "piece of [fucking] [shit]",
    "write this [shit|fucking] down",
    "stole my [shit]",
    "apply that [shit]",
    [["live for", "redoing", "struggle at"], "this [shit]"],
    "respect women and [shit]",
    "all this [shit] again",
    "delete your [shit]",
    "pathetic little [moron|bitch]",
    [["give a", "gives a"], "[shit|fuck]"],
    "a [shit|fucking|fuck] ton",
    "that's the [shit] right there",
    "the whole [fucking] ",
    "bull [fucking] [shit]",
    "this is some [bullshit]",
    [BULLSHIT_PREFIXES, "[bullshit]"],
    ["[bullshit]", BULLSHIT_SUFFIXES],
    "zero [fucks].",
    "[fuck] yeah dude",
    [["empty the", "using the"], "[shitter]"],
    "use the [shitter] as much",
    "cool [shit]",
    "any of this [shit|fucking]",
    "a whole bunch of [shit|bullshit]",
    "there's so much [shit|fucking]",
    "lot of [shit|fucking] going"
  ]);

  // Tier 2: productive expressions with enough context to remain high precision.
  var PRODUCTIVE_EXPRESSION_RULE_PATTERNS = Object.freeze([
    [["in deep", "smells like"], "[shit]"],
    [["can't do", "cannot do", "didn't do", "doesn't know", "didn't say", "not telling you"], "[shit]"],
    [["go", "going", "went", "gone"], "to [shit]."],
    [["yeah no", "yeah, no", "me like", "some crazy", "see this"], "[shit]"],
    ["or some", "[shit]"],
    "of that [shit|fucking|bullshit|fuck|fucker]",
    [["sick of", "don't need", "listen to", "up with"], "this [shit]"],
    "you believe that [shit]",
    "cut that [shit] out",
    "like ah [shit]",
    "and [shit] like that",
    "[shit|fuck] out of me",
    "[fuck|fucked|fucking] that guy",
    "[fuck] right off",
    "to [fuck|shit] with",
    "[shit] all the time",
    "I [shit|fuck] you not",
    "to [shit|fucking] on",
    [["freak", "freaks", "freaked", "freaking"], "me the [fuck] out"],
    "the living [shit] out of",
    [["clean this", "clean that"], "[shit] up"],
    "like a [fucking|bitch|shit|moron|fuck]",
    "watch this [shit|fuck|fucking]",
    [["all this", "all that"], "[shit|fucking|bullshit|pussy|fuck]"],
    [["look at this", "look at that"], "[shit|fucking|fuck|bullshit|whore|fucker]"]
  ]);

  var PHRASAL_VERB_RULE_PATTERNS = Object.freeze([
    "try to [fucking|fuck|shit] ",
    "better not [fuck] things up",
    "[fuck] him up",
    [FUCKING_WITH_PREFIXES, "[fucking] with"],
    [["dream about", "dream of"], "[fucking] "],
    [["I", "he", "she", "we", "they"], "[fucked] it up"],
    "were [fucked] with",
    "don't you [fuck] with",
    "don't [fuck] with",
    "I can [fuck] with",
    [["have", "has", "had"], "[fucked]", ["it", "me"]],
    [["am", "is", "are", "was", "were"], "[fucking] it"],
    [["is", "was", "keeps"], "[fucking] me"],
    [["am", "is", "are", "was", "were", "be", "been", "being", "I'm", "you're", "he's", "she's", "we're", "they're", "just"], "[dicking|fucking|dickin|fucked] around"],
    "good at [fucking] it",
    [["will", "can", "to"], "[fuck] me"],
    "almost [fucked] me",
    [["are you", "gotta be", "got to be", "to be"], "[shitting] me"],
    "don't [bullshit] me",
    [FUCK_UP_VERB_PREFIXES, "[fuck] up"],
    [FUCK_UP_VERB_PREFIXES, FUCK_UP_PRONOUN_SUFFIXES],
    [["make", "let", "help"], "you [fuck] up"],
    ["[fuck] up", PHRASAL_UP_OBJECTS],
    ["to", "[fuck] up"],
    [PERFECT_PREFIXES, "[fucked] up"],
    [["keep", "keeps", "stop", "stopped"], "[fucking] up"],
    "kept [fucking|fucked] up",
    "you are [fucking] up",
    "you're [fucking|fucked] up",
    ["go", "[fuck]", ["himself", "herself", "themselves"]],
    [["[fuck] you"], ["man", "game", "link", "piece of", "Jesus", "Jimmy", "everyone", "all", "I", "too", "doing", "dude", "and"]],
    "[fuck] you,",
    [["[fuck] all of you", "[fuck] outta here"]],
    "we're all [fucked]",
    "get [fucked] by",
    "you're getting [fucked] now",
    "kind of [dicked|fucked] me over",
    [["got", "get", "getting", "being", "been"], "[fucked|dicked] over"],
    "can get [fucked]",
    "get [fucked] up",
    [["we are", "we're", "is so", "I'm so", "you're so"], "[fucked]."],
    "shut the [fuck]",
    "getting the [fuck] out of",
    [SHIT_OUT_PREFIXES, "the [shit|fuck] out"],
    "freaked the [fuck|shit] out",
    [SHIT_OUT_ACTIONS, "the [shit|fuck] out"],
    "freaking the [fuck|shit] out",
    [SHIT_TOGETHER_PREFIXES, "[shit] together"],
    [["make", "made"], "this [shit] up"]
  ]);

  var SYNTACTIC_RULE_PATTERNS = Object.freeze([
    "whatever the [fuck]",
    ["the [fuck]", FUCK_THE_SUFFIXES],
    "come the [fuck] on",
    "wake the [fuck] up",
    [["get the", "stay the"], "[fuck]", ["away", "out", "outta", "down", "back", "over", "in"]],
    [["sit", "calm", "slow"], "the [fuck] down"],
    "it the [fuck] down",
    "the [fuck's] going on",
    "[fuck's] sake",
    "did you just [fucking] call",
    "how [fucking] dare you",
    [["oh", "oh,"], "[fuck|shit] you"],
    [FUCK_YOU_PREFIXES, "[fuck] you"],
    [FUCK_VERB_PREFIXES, "[fuck] "],
    "flying [fuck]",
    "[fuck] yeah.",
    [SHIT_NOUN_PREFIXES, "[shit]"],
    [["piece", "pieces"], "of [shit]"],
    [["fucking", "dog", "horse"], "[shit]"],
    "absolute [shit] show",
    "don't give me [shit] about",
    [["miss", "sell"], "the [shit] out of"],
    [["stuck up", "stuck up little"], "[bitch]"],
    ["[shit]", SHIT_INITIAL_SUFFIXES],
    "all [shit] themselves",
    "getting the [shit] kicked",
    ["[cocks]", ["its head", "his head", "her head", "their head", "an eyebrow", "his eyebrow", "her eyebrow", "their eyebrow"]],

    [["your", "r", "his", "my"], "[shit] together"],
    "of [fucking] control",
    [["I", "he", "she", "they"], "[fucked] up"],
    "you [fucked|fuck|fucking|fuckers] up",
    [FUCKED_UP_PREFIXES, "[fucked] up"],
    [["he", "she", "they"], "[fucked] my"],
    [BE_FORMS.concat(["all", "team", "station", "fish station"]), "[fucked] up"],
    "re [fucked]."
  ]);

  var INSULT_NOUN_RULE_PATTERNS = Object.freeze([
    "wish a [bitch] would",
    "your [cock] shouldn't",
    "son of a [bitch]",
    [["son of", "sons of"], "[bitches]"],
    "[bitch] and moan",
    "an [asshole|arsehole]",
    "sick [fuck|fucker].",
    "am I the [asshole]",
    "call them a [asshole]",
    "consumer [whore]",
    [["where is", "where's"], "this [motherfucker]"],
    "wretched [cunts]",
    "is for [pussies]"
  ]);

  var CONTEXTUAL_FUCKING_RULE_PATTERNS = Object.freeze([
    // Fixed expressions.
    [["the", "this"], "[fucking]", ["game", "cat"]],
    "the [fucking] light",
    "these [fucking] people",
    ["god", "[fucking]", ["damn it", "dammit", "damn"]],
    "jesus [fucking] christ",
    "swear to [fucking] god",
    "the last [fucking] time",
    "[fucking] pieces of",
    // Verbs and commands.
    "just [fucking] do it",
    ["just", "[fucking]", ["tell me", "tell us"]],
    ["I'll", "[fucking]", ["show you", "take the", "gut you"]],
    "gonna [fucking] murder you",
    "I [fucking] work",
    "it [fucking] works",
    [["I have", "I had", "you have", "you had", "we have", "we had", "they have", "they had"], "[fucking] no"],
    "have to [fucking] redo",
    "does not [fucking] ever end",
    "does this level [fucking] ever end",
    "don't have [fucking] time",
    ["just", "[fucking]", ["die", "snorted"]],
    "that [fucking] kills",
    "[fucking] unsubscribe",

    // Adjectives and adverbs.
    "being [fucking] nonchalant",
    [["goddamn", "god damn"], "[fucking] hot"],
    "I'll be [fucking] annoyed",
    "look how [fucking] far",
    "just [fucking] great",
    "a [fucking] good",
    "a [fucking] dead",
    "[fucking] cancerous",
    "right [fucking] there",

    // Objects, people, places, and quantities.
    [["goddamn", "god damn"], "[fucking] light"],
    "smallest [fucking] mouse",
    ["[fucking]", ["speedrun", "tail", "ripper"]],
    "[fucking] speedun",
    "[fucking] piece of",
    "to [fucking] die",
    "just [fucking] go",
  ]);

  // Tier 4: ambiguous fallbacks. Tier 3 grammar rules are compiled below.
  var FALLBACK_RULE_PATTERNS = Object.freeze([
    "what in the [fuck]",
    [["what is that", "what is this"], "[shit|bullshit|fucking|motherfucker]"],
    [QUESTION_WORDS, "the [fuck|fucking|fuckers]"],
    [["back", "bounce", "butt", "come", "drop", "go", "move", "moving", "roll", "spread", "walk", "want"], "the [fuck] out"],
    [["get me", "get you", "get him", "get her", "get us", "get them", "get 'em", "get everyone", "get that"], "the [fuck] out"],
    [["chill", "knocked", "leave me"], "the [fuck]"],
    ["right [fuck]", ["out", "away", "alone"]],
    "super [fucked] up",
    "show some [fucking] respect",
    "sit [fucking] still",
    "[fuck] me",
    ["[fuck]", ["yourself", "off"]],
    "this [shit|motherfucker|bitch|bullshit|fucker|fucking] is",
    "oh [shit|fuck|fucking]",
    "[fuck|shit|bullshit|fucked|fucking|bitch|motherfucker|fucker] this",
    "[fuck|fucking|fucked|shit|bullshit|bitch] it",
    [SAFE_FUCKING_PREFIXES, "[fucking] "],
    ["[fucking]", FUCKING_TRAILING_WORDS],
    "in the [fucking|shit|fuck] ",
    "I'm a [fucking|fuck|bitch|whore] ",
    "have a [fucking|shit|bullshit] ",
    "there's a [fucking|fuck] ",
    "got a [fucking|shit|fucked] ",
    "[fucking|shit|fuck|bitch] cool",
    "[fucking|fuck|bitch] nothing",
    "[fucking|shit] sucks",
    "[shit|fucking] like this",
    "[shit] all over the",
    "[fucking|shit|asshole|fucked] thing",
    "[fucking|bitch|fuck|bullshit|pussy] ass",
    "[fucking|fuck|fuckers|motherfucker|fucker] kill",
    "[fucking|fuck] awesome",
    "completely [fucking|fucked|fuck|bitch|shit] ",
    "were [fucking|bullshit|shit|asshole|assholes|shitting] ",
    "let's [fucking|fuck|fucker] ",
    "can I [fucking|fuck|shit] ",
    [["ain't got", "do cool", "the good"], "[shit] "],
    "all your [shit|fucking] ",
    [["cuz", "to say"], "[fuck] "],
    "woo [fuck|bitches] ",
    "[fuck|cock] away"
  ]);

  var EXACT_RULE_PATTERNS = EXACT_IDIOM_RULE_PATTERNS;
  var PRODUCTIVE_RULE_PATTERNS = Object.freeze([].concat(
    PRODUCTIVE_EXPRESSION_RULE_PATTERNS,
    PHRASAL_VERB_RULE_PATTERNS,
    SYNTACTIC_RULE_PATTERNS,
    INSULT_NOUN_RULE_PATTERNS,
    CONTEXTUAL_FUCKING_RULE_PATTERNS
  ));
  var SPECIFIC_RULE_PATTERNS = Object.freeze(EXACT_RULE_PATTERNS.concat(PRODUCTIVE_RULE_PATTERNS));
  var RULE_PATTERNS = Object.freeze(SPECIFIC_RULE_PATTERNS.concat(FALLBACK_RULE_PATTERNS));

  function rule(template) {
    return Object.freeze({
      template: template,
      candidates: Object.freeze(Array.prototype.slice.call(arguments, 1))
    });
  }

  function placeholderFor(candidate) {
    return candidate.split(/\s+/).map(function tokenPlaceholder() {
      return CENSORED_TOKEN;
    }).join(" ");
  }

  function pattern(value) {
    var candidateGroups = [];
    var template = value.replace(/\[([^\]]+)\]/g, function replaceCandidates(match, group) {
      var candidates = group.split("|");

      candidateGroups.push(candidates);
      return placeholderFor(candidates[0]);
    });

    if (!candidateGroups.length) {
      throw new Error("Rule pattern must include candidates in brackets: " + value);
    }

    var candidates = candidateGroups.length === 1
      ? candidateGroups[0]
      : [candidateGroups.map(function firstCandidate(group) {
        return group[0];
      }).join(" ")];

    return rule.apply(null, [template].concat(candidates));
  }

  function joinPattern(prefix, suffix) {
    if (!prefix) {
      return suffix;
    }

    if (!suffix) {
      return prefix;
    }

    return /\s$/.test(prefix) || /^\s/.test(suffix) ? prefix + suffix : prefix + " " + suffix;
  }

  function expandPatternEntry(entry) {
    if (typeof entry === "string") {
      return [entry];
    }

    // Three-part entries are [prefixes, "[candidate|alternatives]", suffixes].
    var prefixes = Array.isArray(entry[0]) ? entry[0] : [entry[0]];
    var middle = entry.length === 3 ? entry[1] : "";
    var suffixValue = entry.length === 3 ? entry[2] : entry[1];
    var suffixes = Array.isArray(suffixValue) ? suffixValue : [suffixValue];
    var patterns = [];

    prefixes.forEach(function expandPrefix(prefix) {
      suffixes.forEach(function expandSuffix(suffix) {
        patterns.push(joinPattern(joinPattern(prefix, middle), suffix));
      });
    });

    return patterns;
  }

  var SPECIFIC_RULE_COUNT = SPECIFIC_RULE_PATTERNS.flatMap(expandPatternEntry).length;
  var DETERMINISTIC_RULES = Object.freeze(RULE_PATTERNS.flatMap(expandPatternEntry).map(pattern));
  var CONTINUING_PREFIXES = Object.freeze([].concat(
    DETERMINISTIC_RULES.filter(function openEndedRule(candidate) {
      return /\[__\]\s$/.test(candidate.template);
    }).map(function openEndedPrefix(candidate) {
      return candidate.template.replace(/\[__\]\s$/, "").trim();
    }),
    FUCKING_DETERMINERS,
    FUCKING_COPULAS,
    FUCKING_SUBJECTS,
    FUCKING_AUXILIARY_PREFIXES,
    FUCKING_ADJECTIVE_PREFIXES
  ).filter(function nonemptyPrefix(prefix, index, prefixes) {
    return prefix && prefixes.indexOf(prefix) === index;
  }));
  var CONTINUING_PREFIX_REGEX = new RegExp(
    "(^|[^\\p{L}\\p{N}_'’])(?:" + regexAlternatives(CONTINUING_PREFIXES) + ")\\s*$",
    "iu"
  );

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function capitalizeWord(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function shouldCapitalizeReplacement(beforeMatch) {
    return /[.!?]\s*$/.test(beforeMatch);
  }

  function nextWordIsTitleCase(afterMatch) {
    return /^\s*["'(\[]*(?:I\b|[A-Z][a-z]+)/.test(afterMatch);
  }

  function isUppercaseContext(matchedText) {
    var letters = matchedText
      .replace(CENSORED_TOKEN_REGEX, "")
      .replace(/[^A-Za-z]/g, "");

    return letters.length > 1 && letters === letters.toUpperCase();
  }

  function previousWordIsUppercase(text) {
    var words = String(text || "").match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [];
    var letters;

    do {
      letters = (words.pop() || "").replace(/[^A-Za-z]/g, "");
    } while (letters.length === 1 && words.length);

    return letters.length > 1 && letters === letters.toUpperCase();
  }

  function formatWordCase(word, context) {
    var tokenIndex = String(context || "").search(CENSORED_TOKEN_REGEX);
    var beforeToken = tokenIndex < 0 ? context : String(context).slice(0, tokenIndex);

    return previousWordIsUppercase(beforeToken) ? String(word).toUpperCase() : word;
  }

  function punctuationAfterToken(matchedText) {
    CENSORED_TOKEN_REGEX.lastIndex = 0;
    var match;
    var punctuation = "";

    while ((match = CENSORED_TOKEN_REGEX.exec(matchedText)) !== null) {
      punctuation = matchedText.charAt(match.index + match[0].length);
    }

    return SENTENCE_END_REGEX.test(punctuation) ? punctuation : "";
  }

  function formatReplacement(rule, beforeToken, afterToken, matchedText) {
    var questionPhraseBeforeToken = /(?:whatever|what|how|why|where|who|when)\s+the\s*$/i.test(beforeToken);
    var pronounAfterToken = /^\s*(?:I|you|he|she|they|we|it)\b/.test(afterToken);
    var primary = (previousWordIsUppercase(beforeToken) || isUppercaseContext(matchedText))
      ? rule.candidates[0].toUpperCase()
      : shouldCapitalizeReplacement(beforeToken)
        ? capitalizeWord(rule.candidates[0])
        : rule.candidates[0];

    if (!/[.!?]$/.test(primary)) {
      primary += punctuationAfterToken(matchedText) ||
        (nextWordIsTitleCase(afterToken) && !phraseContinuesAfterToken(beforeToken) &&
          !/^\s+(?:hell|christ|god)\b/i.test(afterToken) &&
          !(questionPhraseBeforeToken && pronounAfterToken) ? "." : "");
    }

    return {
      word: primary,
      displayWord: primary
    };
  }

  function compileRule(rule, index) {
    var endsWithSpace = /\s$/.test(rule.template);
    var startsWithPunctuation = /^[.!?]/.test(rule.template);
    var escaped = escapeRegExp(rule.template)
      .replace(/\\\[__\\\]/g, "\\[__\\]")
      .replace(/'/g, "['\u2019]")
      .replace(/ /g, "\\s+");

    return {
      index: index,
      rule: rule,
      regex: new RegExp((startsWithPunctuation ? "()" : "(^|[^\\p{L}\\p{N}_'’])") + "(" + escaped + ")" +
        (endsWithSpace ? "" : "(?=$|[^\\p{L}\\p{N}_'’])"), "giu")
    };
  }

  var RULE_ENTRIES = DETERMINISTIC_RULES.map(function createRuleEntry(rule, index) {
    return {
      index: index,
      rule: rule,
      regex: null
    };
  });

  function ensureCompiled(entry) {
    if (!entry.regex) {
      entry.regex = compileRule(entry.rule, entry.index).regex;
    }
    return entry;
  }

  function regexAlternatives(values) {
    return values.slice().sort(function longestFirst(left, right) {
      return right.length - left.length;
    }).map(function compileAlternative(value) {
      return escapeRegExp(value).replace(/'/g, "['\u2019]").replace(/ /g, "\\s+");
    }).join("|");
  }

  function compileExpressionRule(template, word, phrase, index) {
    return {
      index: index,
      rule: rule(template, word),
      regex: new RegExp("(^|[^\\p{L}\\p{N}_'’])(" + phrase + ")(?=$|[^\\p{L}\\p{N}_'’])", "giu")
    };
  }

  function compileGrammarRule(template, word, prefixes, suffixes, index) {
    return compileExpressionRule(template, word, "(?:" + regexAlternatives(prefixes) +
      ")\\s+\\[__\\]\\s+(?:" + regexAlternatives(suffixes) + ")", index);
  }

  // Tier 3: reusable grammar frames. They run after contextual expressions but
  // before broad fallbacks.
  var COMPILED_GRAMMAR_RULES = Object.freeze([
    compileGrammarRule("<determiner> [__] <noun>", "fucking", FUCKING_DETERMINERS, FUCKING_NOUNS, RULE_ENTRIES.length),
    compileGrammarRule("<copula> [__] <predicate>", "fucking", FUCKING_COPULAS, FUCKING_PREDICATES, RULE_ENTRIES.length + 1),
    compileGrammarRule("<subject> [__] <action>", "fucking", FUCKING_SUBJECTS, FUCKING_ACTIONS, RULE_ENTRIES.length + 2),
    compileGrammarRule("<auxiliary> [__] <action>", "fucking", FUCKING_AUXILIARY_PREFIXES, FUCKING_AUXILIARY_ACTIONS, RULE_ENTRIES.length + 3),
    compileGrammarRule("<modifier> [__] <adjective>", "fucking", FUCKING_ADJECTIVE_PREFIXES, FUCKING_ADJECTIVES, RULE_ENTRIES.length + 4),
    compileExpressionRule("<number> [__] <count unit>", "fucking", NUMBER_PATTERN + "\\s+\\[__\\]\\s+" + COUNT_UNIT_PATTERN, RULE_ENTRIES.length + 5)
  ]);

  function trieNode() {
    return {
      children: new Map(),
      rules: []
    };
  }

  function ruleWords(text) {
    return normalizeCensoredTokens(text).toLowerCase().replace(/\u2019/g, "'").match(/\[__\]|[\p{L}\p{N}_']+/gu) || [];
  }

  function buildRuleTrie(compiledRules) {
    var rootNode = trieNode();

    compiledRules.forEach(function addRule(compiled) {
      var words = ruleWords(compiled.rule.template);
      var node = rootNode;

      words.forEach(function addWord(word) {
        if (!node.children.has(word)) {
          node.children.set(word, trieNode());
        }
        node = node.children.get(word);
      });
      node.rules.push(compiled);
    });

    return rootNode;
  }

  var RULE_TRIE = buildRuleTrie(RULE_ENTRIES);

  function candidateRulesForText(text) {
    var words = ruleWords(text);
    var selected = new Map();
    var startIndex;

    for (startIndex = 0; startIndex < words.length; startIndex += 1) {
      var node = RULE_TRIE;
      var wordIndex = startIndex;

      while (wordIndex < words.length && node.children.has(words[wordIndex])) {
        node = node.children.get(words[wordIndex]);
        node.rules.forEach(function rememberRule(compiled) {
          selected.set(compiled.index, compiled);
        });
        wordIndex += 1;
      }
    }

    return Array.from(selected.values()).sort(function sortByRuleOrder(left, right) {
      return left.index - right.index;
    }).map(ensureCompiled);
  }

  function orderedRulesForText(text) {
    var candidates = candidateRulesForText(text);
    var fallbackOffset = candidates.findIndex(function isFallback(compiled) {
      return compiled.index >= SPECIFIC_RULE_COUNT;
    });

    fallbackOffset = fallbackOffset < 0 ? candidates.length : fallbackOffset;
    return candidates.slice(0, fallbackOffset)
      .concat(COMPILED_GRAMMAR_RULES, candidates.slice(fallbackOffset));
  }

  function findTokenRange(value) {
    CENSORED_TOKEN_REGEX.lastIndex = 0;
    var match;
    var firstMatch = null;
    var end = 0;
    var count = 0;

    while ((match = CENSORED_TOKEN_REGEX.exec(value)) !== null) {
      if (!firstMatch) {
        firstMatch = match;
      }

      end = match.index + match[0].length;
      count += 1;
    }

    if (!firstMatch) {
      return null;
    }

    if (SENTENCE_END_REGEX.test(value.charAt(end))) {
      end += 1;
    }

    return {
      start: firstMatch.index,
      end: end,
      count: count
    };
  }

  function tokenIndexBefore(value, endOffset) {
    var textBeforeToken = value.slice(0, endOffset);
    CENSORED_TOKEN_REGEX.lastIndex = 0;
    var matches = textBeforeToken.match(CENSORED_TOKEN_REGEX);

    return matches ? matches.length : 0;
  }

  function normalizeCensoredTokens(text) {
    if (typeof text !== "string") {
      return text;
    }

    return text.replace(/\u00a0/g, " ").replace(CENSORED_TOKEN_REGEX, CENSORED_TOKEN);
  }

  function ignoreNonSpeechLabels(text) {
    return text.replace(/\[(?!\s*__\s*\])[^\]\n]*\]/g, " ");
  }

  function hasCensoredToken(text) {
    if (typeof text !== "string") {
      return false;
    }

    CENSORED_TOKEN_REGEX.lastIndex = 0;
    return CENSORED_TOKEN_REGEX.test(text.replace(/\u00a0/g, " "));
  }

  function nextTextStartsSentence(afterToken) {
    if (/^\s*(?:hell|christ|god)\b/i.test(afterToken)) {
      return false;
    }

    return /^\s*["'(\[]*(?:I\b|[A-Z][a-z]|[A-Z]{2,}\s+[a-z])/.test(afterToken);
  }

  function phraseContinuesAfterToken(beforeToken) {
    return CONTINUING_PREFIX_REGEX.test(beforeToken);
  }

  function insertVirtualSentencePunctuation(text) {
    return text.replace(CENSORED_TOKEN_REGEX, function punctuateToken(token, offset) {
      var beforeToken = text.slice(0, offset);
      var afterToken = text.slice(offset + token.length);

      if (/^\s*[.!?]/.test(afterToken)) {
        return token;
      }

      if (/(?:whatever|what|how|why|where|who|when)\s+the\s*$/i.test(beforeToken) && /^\s*(?:I|you|he|she|they|we|it)\b/.test(afterToken)) {
        return token;
      }

      // A title-cased destination is not a new caption after an intensifier.
      if (/\b(?:go|going|went|gone)\s+to\s*$/i.test(beforeToken)) {
        return token;
      }

      if (phraseContinuesAfterToken(beforeToken)) {
        return token;
      }

      return /^\s*>>/.test(afterToken) || nextTextStartsSentence(afterToken) ? token + "." : token;
    });
  }

  function isAdjacentToCensoredToken(text, tokenStart, tokenEnd) {
    return /\[\s*__\s*\]\s*$/.test(text.slice(0, tokenStart)) ||
      /^\s*\[\s*__\s*\]/.test(text.slice(tokenEnd));
  }

  function applyDeterministicRules(text) {
    var normalizedText = insertVirtualSentencePunctuation(ignoreNonSpeechLabels(normalizeCensoredTokens(text)));

    if (typeof normalizedText !== "string" || normalizedText.indexOf(CENSORED_TOKEN) === -1) {
      return {
        text: text,
        replacements: []
      };
    }

    var replacements = [];
    var occupiedRanges = [];

    orderedRulesForText(normalizedText).forEach(function applyRule(compiled) {
      var match;

      compiled.regex.lastIndex = 0;

      while ((match = compiled.regex.exec(normalizedText)) !== null) {
        var fullMatch = match[0];
        var prefix = match[1];
        var matchedText = match[2];
        var matchStart = match.index + prefix.length;
        var matchEnd = match.index + fullMatch.length;
        var tokenRange = findTokenRange(matchedText);

        if (!tokenRange) {
          continue;
        }

        var tokenStart = matchStart + tokenRange.start;
        var tokenEnd = matchStart + tokenRange.end;

        if (SENTENCE_END_REGEX.test(normalizedText.charAt(tokenEnd))) {
          tokenEnd += 1;
        }

        if (occupiedRanges.some(function overlaps(range) {
          return tokenStart < range.end && tokenEnd > range.start;
        })) {
          continue;
        }

        if (tokenRange.count === 1 && isAdjacentToCensoredToken(normalizedText, tokenStart, tokenEnd)) {
          continue;
        }

        var beforeToken = normalizedText.slice(0, tokenStart);
        var afterToken = normalizedText.slice(tokenEnd);
        var formattingText = normalizedText.slice(matchStart, Math.max(matchEnd, tokenEnd));

        var formatted = formatReplacement(compiled.rule, beforeToken, afterToken, formattingText);

        replacements.push({
          rule: compiled.rule,
          word: formatted.word,
          displayWord: formatted.displayWord,
          tokenIndex: tokenIndexBefore(normalizedText, tokenStart),
          tokenSpan: tokenRange.count,
          textStart: tokenStart,
          textEnd: tokenEnd
        });

        occupiedRanges.push({
          start: tokenStart,
          end: tokenEnd
        });
      }
      });

    replacements.sort(function sortByPosition(left, right) {
      return left.textStart - right.textStart;
    });

    if (!replacements.length) {
      return {
        text: text,
        replacements: replacements
      };
    }

    var cursor = 0;
    var patchedParts = [];

    replacements.forEach(function applyReplacement(replacement) {
      patchedParts.push(normalizedText.slice(cursor, replacement.textStart));
      patchedParts.push(replacement.displayWord);
      cursor = replacement.textEnd;
    });

    patchedParts.push(normalizedText.slice(cursor));

    return {
      text: patchedParts.join(""),
      replacements: replacements
    };
  }

  var exports = Object.freeze({
    CENSORED_TOKEN: CENSORED_TOKEN,
    CENSORED_TOKEN_REGEX: CENSORED_TOKEN_REGEX,
    ALLOWED_WORDS: ALLOWED_WORDS,
    DETERMINISTIC_RULES: DETERMINISTIC_RULES,
    normalizeCensoredTokens: normalizeCensoredTokens,
    hasCensoredToken: hasCensoredToken,
    formatWordCase: formatWordCase,
    applyDeterministicRules: applyDeterministicRules
  });

  root.UncensoredRules = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
