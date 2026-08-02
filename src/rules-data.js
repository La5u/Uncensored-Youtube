(function buildRuleData() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var compiler = root.UncensoredRuleCompiler ||
    (typeof require === "function" ? require("./rules-compiler") : null);
  var set = compiler.set;
  var regexSet = compiler.regexSet;
  var slot = compiler.slot;
  var pattern = compiler.pattern;
  var frame = compiler.frame;
  var group = compiler.group;

  var WORD_ROLES = Object.freeze({
    BASE_VERB: set("base verb", ["fuck", "shit", "bitch", "motherfuck", "piss"]),
    THIRD_PERSON_VERB: set("third-person verb", ["fucks"]),
    POSSESSIVE_FORM: set("possessive form", ["fuck's"]),
    EXPLETIVE: set("expletive", ["fuck"]),
    INTENSIFIER: set("intensifier", ["fucking", "motherfucking"]),
    PARTICIPLE: set("participle", ["fucked", "dicked", "pissed"]),
    GERUND: set("gerund", ["fucking", "shitting", "dicking", "dickin", "pissing"]),
    SINGULAR_INSULT: set("singular insult", [
      "fucker", "motherfucker", "shithead", "bitch", "moron", "dipshit",
      "cocksucker", "arsehole", "asshole", "dickhead", "dickwad", "twat", "whore",
      "cunt", "pussy", "slut", "cripple", "ass", "bastard"
    ]),
    PLURAL_INSULT: set("plural insult", [
      "fuckers", "motherfuckers", "shitheads", "bitches", "assholes",
      "dickheads", "twats", "whores", "cunts", "pussies", "sluts", "asses", "bastards"
    ]),
    MASS_NOUN: set("mass noun", ["shit", "bullshit", "dogshit", "cum", "piss", "crap"]),
    SINGULAR_BODY_NOUN: set("singular body noun", ["cock", "pussy"]),
    PLURAL_BODY_NOUN: set("plural body noun", ["cocks"]),
    ADJECTIVE: set("adjective swear", ["slutty", "bitchy", "fuckable"]),
    PLACE_OR_EVENT_NOUN: set("place or event noun", ["shithole", "shitter", "shitshow"]),
    COMPOUND_NOUN: set("compound noun", ["shitballs", "clusterfuck", "fuckery"]),
    RECOGNITION_ONLY: set("recognition-only word", [
      "nigger", "niggas", "retarded", "retard", "faggots", "fuckwit", "fucko",
      "fuckup"
    ])
  });

  // Non-censored words to note: shitty, dick
  // Exclude compounds split by auto captions: [__] boy/ton -> fuck and
  // [__] stain/face/bird -> shit, not fuckboy/fuckton/shitstain/shitface/shitbird.
  // Keep this order stable: Whisper uses it to break otherwise equal matches.
  var ALLOWED_WORDS = set("allowed word", [
    "fuck", "fucks", "fuck's", "fucking", "fucked", "fucker", "fuckers", "fuckery",
    "motherfuck", "motherfucker", "motherfuckers", "motherfucking",
    "shit", "shithole", "shitting", "shithead", "shitheads", "shitter",
    "bitch", "bitches", "moron", "bullshit", "dipshit", "cock", "cocks",
    "cocksucker", "arsehole", "asshole", "assholes", "dicked", "dicking",
    "dickin", "dickhead", "dickheads", "dickwad", "twat", "twats", "whore", "whores",
    "cunt", "cunts", "pussy", "pussies", "slut", "cum", "cripple"
  ]);

  var SUBJECT_PRONOUNS = set("subject", ["I", "you", "he", "she", "it", "we", "they"]);
  var OBJECT_PRONOUNS = set("object", ["me", "you", "him", "her", "it", "us", "them"]);
  var POSSESSIVE_DETERMINERS = set("possessive", ["my", "your", "his", "her", "its", "our", "their"]);
  var PLAIN_VERB_SUBJECTS = set("plain-verb subject", ["I", "you", "we", "they"]);
  var THIRD_PERSON_SUBJECTS = set("third-person subject", ["he", "she", "it"]);
  var FUTURE_SUBJECTS = set("contracted future subject", [
    "I'll", "you'll", "he'll", "she'll", "it'll", "we'll", "they'll"
  ]);
  var NEGATED_SUBJECT_PREFIXES = set("negated subject", [
    "I don't", "we don't", "they don't", "he doesn't", "she doesn't"
  ]);
  var BE_FORMS = set("be form", ["is", "was", "were", "I'm", "he's", "she's", "we're", "they're"]);
  var QUESTION_WORDS = set("question word", ["where"]);
  var FUCK_THE_SUFFIXES = set("fuck-the suffix", [
    "are", "did", "do", "does", "am", "were", "know", "can", "have", "what"
  ]);
  var FUCK_YOU_PREFIXES = set("fuck-you prefix", [
    ".", "!", "?", "and", "or", "yeah", "yeah,", "no", "no,", "so",
    "dude", "dude,", "well", "go", "yes", "me"
  ]);
  var FUCK_VERB_PREFIXES = set("fuck verb prefix", [
    "wanting to", "would rather", "would you rather", "would you rather we"
  ]);
  var BASE_VERB_PREFIXES = set("base-verb prefix", [
    "to", "can", "can't", "cannot", "could", "couldn't", "did", "didn't",
    "do", "don't", "does", "doesn't", "will", "won't", "would", "wouldn't",
    "should", "shouldn't", "must", "might", "may", "need to", "needs to",
    "want to", "wants to", "wanted to", "going to", "gonna", "try to", "trying to"
  ]);
  var BASE_VERB_QUESTION_PREFIXES = set("base-verb question", [
    "did", "do", "does", "can", "could", "will", "would", "should", "might", "may"
  ].flatMap(function addSubject(auxiliary) {
    return SUBJECT_PRONOUNS.map(function questionPrefix(subject) {
      return auxiliary + " " + subject;
    });
  }));
  var VERB_OBJECTS = set("verb object", OBJECT_PRONOUNS.concat([
    "this", "that", "everything", "something", "anything", "everyone", "someone"
  ]));
  var VERB_PARTICLES = set("verb particle", ["around", "off", "up", "with"]);
  var PHRASAL_VERB_PREFIXES = set("phrasal-verb prefix", [
    "don't", "do not", "didn't", "did not", "can't", "cannot", "won't",
    "shouldn't", "couldn't", "better not", "try not to", "going to", "about to",
    "want to", "wanted to", "wants to", "need to", "needs to", "had to",
    "have to", "has to", "let me", "let's", "gonna", "wouldn't"
  ]);
  var PHRASAL_SUBJECT_MODALS = set("phrasal-verb modal", ["might", "will"]);
  var PHRASAL_OBJECT_SUFFIXES = set("phrasal-verb object suffix", OBJECT_PRONOUNS.map(function addUp(pronoun) {
    return pronoun + " up";
  }));
  var PHRASAL_PARTICLE_SUFFIXES = set("phrasal-particle suffix", VERB_PARTICLES.concat(PHRASAL_OBJECT_SUFFIXES));
  var PHRASAL_SUFFIXES = set("phrasal-verb suffix", VERB_OBJECTS.concat(PHRASAL_PARTICLE_SUFFIXES));
  var PHRASAL_UP_OBJECTS = set("phrasal-up object", [
    "the plan", "the game", "the mission", "the test", "the exam"
  ]);
  var PARTICIPLE_OBJECTS = set("participle object", ["everything", "the whole thing"]);
  var PERFECT_PREFIXES = set("perfect prefix", ["have", "has", "had", "I've", "you've", "we've", "they've"]);
  var GERUND_WITH_PREFIXES = set("gerund-with prefix", [
    "was", "I'm", "I'm just", "you're", "are you", "who's"
  ]);
  var PARTICIPLE_MODIFIERS = set("participle modifier", [
    "that's", "so", "really", "massively", "most", "kind of", "too", "real",
    "completely", "getting", "truly"
  ]);
  var PARTICIPLE_FRAME_PREFIXES = set("participle-frame prefix", ["being", "almost", "look"]);
  var PARTICIPLE_FRAME_SUFFIXES = set("participle-frame suffix", ["with", "that", "up"]);
  var EXPLETIVE_DETERMINER_PREFIXES = set("expletive-determiner prefix", [
    "back", "buckle", "get", "go", "how", "shut", "what", "whatever", "you"
  ]);
  var EXPLETIVE_DETERMINER_SUFFIXES = set("expletive-determiner suffix", [
    "okay", "this", "to", "up"
  ]);
  var MASS_NOUN_PREFIXES = set("mass-noun prefix", [
    "taking a", "in deep", "smells like",
    "can't do", "cannot do", "didn't do", "doesn't do", "doesn't know",
    "didn't say", "not telling you", "some crazy", "or some",
    "sick of this", "don't need this", "listen to this", "up with this",
    "you believe that", "seen some", "throw some", "some of this",
    "been through some", "got so much", "talk some", "act for", "can see",
    "he's full of", "some of that", "there's too much", "it's good",
    "seeing this", "some weird", "doing weird",
    "flaming", "beat the"
  ]);
  var FORCEFUL_ACTIONS = set("forceful action", [
    "scare", "scaring", "freaks", "irritates", "beating", "kick",
    "kicked", "kicking", "smack", "smacking", "shoot", "push", "pushed",
    "scares", "stab", "punch", "blow", "love", "annoy", "bore", "work"
  ]);
  var INTERJECTION_SUFFIXES = set("interjection suffix", [
    "uh", "but", "do", "sorry", "did", "look", "don't", "hold",
    "I forgot", "I should", "I can't", "I was", "I'll", "okay",
    "and I", "what are", "good"
  ]);
  var SIMILE_PREFIXES = set("simile prefix", [
    "feel", "feels", "sound", "just", "it's"
  ]);
  var AS_FUCK_ADJECTIVES = set("as-fuck adjective", [
    "annoying", "awesome", "bad", "beautiful", "big", "bright", "buff",
    "buggy", "busy", "challenging", "cheap", "cold", "crazy", "cute", "dark",
    "disrespectful", "dope", "dumb", "dusty", "easy", "elegant",
    "expensive", "freaky", "funny", "happy", "hard", "high",
    "huge", "imbalanced", "important", "intimidating", "long", "mean", "nasty",
    "poor", "quiet", "random", "raw", "real", "rich", "sad",
    "sexy", "short", "slow", "small", "smooth", "strong", "stupid", "sus", "swole",
    "thankful", "tough", "unsettling", "wet", "wild", "wise", "young"
  ]);

  var AS_SHIT_ADJECTIVES = set("as-shit adjective", [
    "annoyed", "bored", "boring", "broke", "calm", "close", "creepy", "dead", "deep",
    "drunk", "fast", "fat", "hot", "loud", "low", "mad",
    "old", "painful", "proud", "scared", "scary", "sure", "thick", "tight", "tired",
    "weak", "weird"
  ]);

  var SHARED_MODIFIERS = set("shared modifier", [
    "bad", "close", "dead", "easy", "great", "hard", "nuts", "scared"
  ]);
  var SHARED_STATES = set("shared state", [
    "done", "good", "hot", "huge", "impossible", "insane", "joking", "sick", "sorry"
  ]);
  var INTENSIFIED_BARE_NOUNS = set("intensified bare noun", [
    "day", "hell", "idiot", "joke", "mess", "mind", "money", "nightmare", "place", "sense", "time"
  ]);
  var INTENSIFIED_BARE_PREDICATES = set("intensified bare predicate", [
    "amazing", "crazy", "disgusting", "pathetic", "pissed", "ridiculous", "stupid", "weird"
  ]);
  var INTENSIFIED_TRAILING_WORDS = set("intensified trailing word", SHARED_MODIFIERS.concat(
    INTENSIFIED_BARE_NOUNS,
    INTENSIFIED_BARE_PREDICATES,
    [
      "air", "annoying", "awful", "badass", "ball", "bastard", "battle",
      "beast", "better", "brilliant", "cares", "chair", "christ", "concentrate",
      "creepy", "damage", "dark", "death", "double", "embarrassing", "fantastic",
      "fire", "fly", "freaky", "fun", "genius", "gross", "hair", "hammer",
      "fingers", "help", "hope", "horrible", "horse", "hot", "ice", "idiots", "key", "know",
      "legs", "long", "loud", "love", "map", "mean", "mental",
      "morons", "murder", "music", "nerve", "ninja", "nonsense",
      "party", "pay", "power", "raw", "reason", "record", "red", "robot",
      "same", "scary", "shark", "shoot", "slow", "sound", "speed", "suck",
      "sweet", "terrible", "terrifying", "tongue", "tree", "trees", "useless",
      "video", "wall", "water", "worked", "worry",
      // Each added suffix is >=85% "fucking" on at least 10 aligned caption slots.
      "adorable", "angry", "bear", "beautiful", "bird", "boat", "chaos",
      "bomb", "book", "boring", "broken", "cold", "cute",
      "deal", "demon", "dice", "dick", "died", "dope", "door",
      "doors", "dragon", "drink", "dumb", "eye", "fall", "find", "finish", "freak",
      "food", "friend", "funny", "game", "games", "garbage", "giant", "gold", "guy", "hand", "hate",
      "helmet", "high", "huge", "jump", "killed", "knew",
      "lucky", "mad", "massive", "monkey", "moon", "name", "nowhere", "perfect", "piece", "plan",
      "problem", "rage", "ring", "sad", "saw", "self", "serious", "sexy", "sit", "spell", "spells",
      "seen", "story", "strong", "stuck", "team", "tell", "throw", "tired", "town",
      "way", "waste", "weak", "wild", "worst",
      // Repeated >=90% paired-caption suffixes.
      "ask", "arm", "arrows", "bouncing", "bother", "camera", "catch", "cheese",
      "chill", "coolest", "creep", "cut", "dangerous", "destroyed", "doctor",
      "doubt", "dreadful", "feet", "fortune", "glass", "gorgeous", "hated",
      "heart", "hero", "higher", "laser", "lose", "miles", "minute", "pull",
      "relax", "rifles", "shooting", "skull", "spider", "tough", "war", "week",
      "weirdo"
    ]
  ));
  var INTENSIFIER_MODIFIERS = set("intensifier modifier", [
    "I'll be", "I'm", "you're", "he's", "she's", "we're", "they're", "it is",
    "that is", "this is", "are you", "is so", "is really", "it's so", "I'm so",
    "you're so", "they're so", "so", "really", "pretty", "virtually", "not", "was"
  ]);
  var NEGATED_DO_PREFIXES = set("negated do prefix", [
    "can't do", "cannot do", "couldn't do", "won't do", "wouldn't do",
    "didn't do", "don't do", "doesn't do"
  ]);
  var INTENSIFIED_ADJECTIVES = set("intensified adjective", SHARED_MODIFIERS.concat(
    SHARED_STATES,
    [
      "bruised", "cold", "confused", "cool", "fast", "funny", "happy",
      "high", "obvious", "proud", "random", "smooth", "strange", "tired"
    ]
  ));

  // Broad prefixes retained only at >=90% corpus precision.
  var SAFE_INTENSIFIER_PREFIXES = set("safe intensifier prefix", [
    "a great", "absolutely", "across the", "by a", "can't even", "didn't even", "don't even", "don't you",
    "down the", "entire", "even", "every", "feel", "for a", "from the",
    "genuinely", "god the", "got some", "had a", "have no",
    "give me the", "he's", "here we", "I can't", "I need to", "I'm going to", "into a",
    "into the", "is just", "just a", "just how", "look at the", "many", "million",
    "is this a", "it's like the", "let's do a", "need the", "not going to", "not gonna",
    "off the", "oh it's", "open the", "outright", "playing a", "put some",
    "she's", "sheer", "should have", "so", "stop", "straight up",
    "super", "that is", "that's just", "that's pretty", "the first", "there we",
    "there's no", "they're", "this whole", "through the", "to be",
    "use your", "very", "what are you", "what's the", "whole", "with a",
    "would be", "yeah you"
  ]);
  var EVALUATIVE_NOUN_PREFIXES = set("evaluative-noun prefix", ["seems like", "marketing", "legal", "made up"]);
  var EVALUATIVE_NOUN_SUFFIXES = set("evaluative-noun suffix", ["policy", "explanation"]);

  var INTENSIFIER_DETERMINERS = set("determiner", [
    "a", "an", "the", "this", "that", "these", "those", "my", "your", "his",
    "her", "our", "their", "every", "no", "same"
  ]);
  var INTENSIFIED_NOUNS = set("noun", INTENSIFIED_BARE_NOUNS.concat([
    "animal", "anchor", "ass", "asshole", "audience", "baby", "balls", "bar", "bed", "best", "boat", "bomb",
    "bitch", "body", "boar", "boss", "brains", "break", "business", "cake", "car",
    "cat", "chair", "cheater", "chicken", "choice", "checkpoint", "clothes", "clue", "cop", "cops", "coward",
    "announcer", "arms", "building", "cannonball", "chest", "city", "cross", "date", "deal", "death", "dick", "disaster", "dog", "door", "dragon", "drill", "eggplant",
    "epipen", "eye", "eyes", "fish",
    "face", "family", "fault", "finger", "fire", "floor", "game", "grain",
    "god", "ground", "gun", "guns", "guy", "guys", "hand", "hands", "head", "house",
    "footage", "hair", "hammer", "human", "idea", "iris", "island", "job", "jobs", "jump", "key", "keys", "kick", "kid", "kids",
    "kilo", "knife", "leg", "level", "liar", "lie", "life", "lights", "lives", "load", "loser", "lunatic",
    "legs", "map", "monster", "moon", "moron", "mother", "mouth", "music", "name", "night",
    "lady", "mouse", "neck", "nerd", "nose", "npc", "pants", "people", "phone", "picture", "piece", "pig", "places", "plane", "planet", "platform", "problem",
    "point", "psycho", "psychopath", "pulse", "rat", "robbery", "room", "rules", "shit",
    "rhythm game", "second", "ship", "shock", "sky", "slut", "soul", "space", "sperm", "street", "sun", "sword", "teenager", "teeth", "thing", "things",
    "stars", "throat", "thumbs", "toes", "tree", "trunk", "truck", "truth", "van", "video", "waste",
    "water", "way", "weapons", "wife", "window", "wings", "word", "words", "work", "world", "year",
    "wall", "zoomies", "friends", "jet", "mask"
  ]));
  var INTENSIFIER_COPULAS = set("copula", BE_FORMS.concat([
    "am", "are", "be", "been", "being", "you're", "it's", "that's", "are you"
  ]));
  var INTENSIFIED_PREDICATES = set("predicate", SHARED_STATES.concat(
    INTENSIFIED_BARE_PREDICATES,
    [
      "around", "awful", "awesome", "bullshit", "dead", "exhausting", "freezing",
      "adorable", "bad", "beautiful", "bored", "complicated", "cool", "creepy", "doing", "drinking", "fine", "gone",
      "great", "gross", "hard", "her", "hilarious", "incredible", "kidding", "open",
      "killing", "lying", "mad", "not", "nuts", "ready", "scary", "serious",
      "reloading", "starving", "talking", "terrible", "terrified", "terrifying", "trying",
      "ugly", "useless", "wrong"
    ]
  ));
  var EMPHATIC_SUBJECTS = set("emphatic subject", SUBJECT_PRONOUNS.concat(
    ["no one", "nobody", "someone", "everybody", "everyone"],
    FUTURE_SUBJECTS,
    [
    "I'm gonna", "you're gonna", "we're gonna", "they're gonna"
    ]
  ));
  var EMPHATIC_BASE_ACTIONS = set("base action", [
    "believe", "care", "dare", "die", "do", "get", "go", "kill", "know",
    "listen", "move", "need", "say", "see", "stop", "tell", "touch",
    "understand", "want"
  ]);
  var EMPHATIC_ACTIONS = set("emphatic action", EMPHATIC_BASE_ACTIONS.concat([
    "did", "died", "does", "doing", "find", "got", "hate", "hear", "hit", "jump",
    "kidding", "killed", "kills", "knew", "knows", "left", "let", "lied", "like",
    "look", "love", "missed", "nailed", "needs", "roll", "shot", "suck", "sucks",
    "hits", "run", "saying", "show", "start", "think", "told", "wanted", "warned", "worry"
  ]));
  var EMPHATIC_AUXILIARIES = set("emphatic auxiliary", [
    "can", "can't", "can't even", "cannot", "could", "couldn't", "didn't",
    "do not", "does not", "don't", "don't even", "don't you", "doesn't",
    "haven't even", "better not", "have to", "let's", "must", "should", "shouldn't",
    "gonna", "never", "wanted to", "will", "won't", "would", "wouldn't"
  ]);
  var EMPHATIC_AUXILIARY_ACTIONS = set("auxiliary action", EMPHATIC_BASE_ACTIONS.concat([
    "accept", "ask", "attack", "be", "brag", "breathe", "dance", "deal", "defrosted",
    "end", "fight", "find", "follow", "guess", "have", "help", "hit", "knock", "launch",
    "lie", "like", "look", "love", "matter", "murder", "party", "prove", "read", "redo",
    "remember", "scare", "stand", "start", "suck", "take", "talk", "think", "trust", "wait",
    "work", "worry"
  ]));

  var NUMBER_WORD_PATTERN = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)";
  var NUMBER_PATTERN = "(?:\\d+(?:[,.]\\d+)*|" + NUMBER_WORD_PATTERN +
    "(?:[-\\s]+" + NUMBER_WORD_PATTERN + "){0,3})";
  var NUMBER = regexSet("number", NUMBER_PATTERN);
  var COUNT_UNIT = regexSet("count unit", "(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|times?)");

  // Exact rules stay in priority order. Keep mined phrases separate from the
  // smaller reusable grammar below so broad generalizations remain auditable.
  var EXACT_RULES = Object.freeze([
    group("exact/corpus-phrases", [
      pattern`start with this [bullshit]`,
      pattern`holy [shit] ${["I", "you"]}`,
      pattern`holy [shit|fuck|fucking]`,
      pattern`this [shit] ${["happened", "was", "now"]}`,
      pattern`the rotten [asshole] of`,
      pattern`weird [fucked] up`,
      pattern`it's so [fucked] up`,
      pattern`a [fucked] up`,
      pattern`your [shit] up`,
      pattern`some [fucking] sick`,
      pattern`do not [fuck] with`,
      pattern`${["none of that", "that kind of", "this kind of", "this type of", "that type of"]} [shit]`,
      pattern`${["crock", "pile", "sack"]} of [shit]`,
      pattern`the actual [fuck]`,
      pattern`or some [shit]`,
      pattern`piece of [shit] I`,
      pattern`take a [shit]`,
      pattern`that [shit] ${["I", "but", "was", "to", "off", "is", "and", "as", "hurts", "down", "isn't", "show", "on", "like", "so"]}`,
      pattern`oh [shit] ${["this", "the", "oh my", "get", "is", "what's", "wow", "how", "um", "all", "so", "my bad"]}`,
      pattern`[shit] in my`,
      pattern`I was [fucking]`,
      pattern`is really [fucking]`,
      pattern`an ugly [bitch]`,
      pattern`[fuck] are you`,
      pattern`[shit] there was`,
      pattern`believe this [shit]`,
      pattern`oh [fuck] off`,
      pattern`put a [fucking]`,
      pattern`just just [fucking]`,
      pattern`feel like [shit]`,
      pattern`do that [shit]`,
      pattern`I'm not [fucking]`,
      pattern`he told [fucking]`,
      pattern`[fucked] up little`,
      pattern`own [shit] I`,
      pattern`I'm not no [asshole]`,
      pattern`man oh [shit]`,
      pattern`[fuck] yeah yes`,
      pattern`this [shit] I'm`,
      pattern`some [shit] ${["on", "that", "like", "you"]}`,
      pattern`to [fucking] get`,
      pattern`and just [fucking]`,
      pattern`going to get [fucking]`,
      pattern`games are [fucking]`,
      pattern`[shit] right and`,
      pattern`beats the [shit]`,
      pattern`and [shit] on`,
      pattern`in case [shit]`,
      pattern`really [fuck] with`,
      pattern`[shit] and get`,
      pattern`a mind [fuck]`,
      pattern`about this [shit]`,
      pattern`[shit] in a`,
      pattern`believe that [shit]`,
      pattern`we should [fucking]`,
      pattern`can you just [fucking]`,
      pattern`oh [fucking] hell`,
      pattern`stupid [shit] that`,
      pattern`[shit] my pants`,
      pattern`am I [fucking]`,
      pattern`do the same [shit]`,
      pattern`[shit] is like`,
      pattern`[fuck] them I`,
      pattern`not give a [shit]`,
      pattern`give a [fuck] what`,
      pattern`got that [shit]`,
      pattern`too [fucking] far`,
      pattern`really give a [shit]`,
      pattern`a piece of [shit]`,
      pattern`do I have to [fucking]`,
      pattern`are a [fucking]`,
      pattern`look like a [fucking]`,
      pattern`through some [shit]`,
      pattern`this [shit] too`,
      pattern`seen some [shit]`,
      pattern`of [shit] I'm`,
      pattern`direction oh [shit]`,
      pattern`like a bunch of [fucking]`,
      pattern`saying that [shit]`,
      pattern`and you [fucking]`,
      pattern`doing this [shit]`,
      pattern`this [shit] we`,
      pattern`you look [fucking]`,
      pattern`[fuck] that it's`,
      pattern`the coolest [shit]`,
      pattern`still a [fucking]`,
      pattern`did that [shit]`,
      pattern`in a [fucking]`,
      pattern`on the [fucking]`,
      pattern`be like [fuck]`,
      pattern`for that [shit]`,
      pattern`to [fuck] your`,
      pattern`to get some [pussy]`,
      pattern`I'm just [fucking]`,
      pattern`I'm like [fuck]`,
      pattern`out of [fucking]`,
      pattern`a [fucking] like`,
      pattern`[fucked] up I`,
      pattern`I just [fucking]`,
      pattern`all your [shit]`,
      pattern`up your [fucking]`,
      pattern`the [fuck] up`,
      pattern`a big [fucking]`,
      pattern`the [fuck] to`,
      pattern`me you [fucking]`,
      pattern`[shit] I want to`,
      pattern`of [shit] my`,
      pattern`[fucked] up this`,
      pattern`they're not [fucking]`,
      pattern`about that [shit]`,
      pattern`cuz I'm [fucking]`,
      pattern`from a [fucking]`,
      pattern`[fuck] am I`,
      pattern`a really [fucking]`,
      pattern`the [fuck] down`,
      pattern`I'm the [fucking]`,
      pattern`the [fuck] didn't`,
      pattern`it doesn't [fucking]`,
      pattern`over this [fucking]`,
      pattern`which is [fucking]`,
      pattern`[fuck] do I do`,
      pattern`I hate the [fucking]`,
      pattern`[shit] out of each`,
      pattern`game is [fucking]`,
      pattern`the [fuck] happened`,
      pattern`[fuck] away from`,
      pattern`that I'm [fucking]`,
      pattern`of [fucked] up`,
      pattern`yeah god [fucking]`,
      pattern`I am [fucking]`,
      pattern`much [shit] going`,
      pattern`[fucking] do that`,
      pattern`no god [fucking]`,
      pattern`having a [fucking]`,
      pattern`[shit] out of all`,
      pattern`sort of [shit]`,
      pattern`[shit] to me`,
      pattern`the [fuck] back`,
      pattern`the last [fucking]`,
      pattern`say [shit] ${["like", "about"]}`,
      pattern`some shady [shit]`,
      pattern`going to be [fucking]`,
      pattern`oh for [fuck's]`,
      pattern`guys [fuck] you`,
      pattern`the [asshole] for`,
      pattern`went to [shit]`,
      pattern`make [shit] up`,
      pattern`his [shit] together`,
      pattern`don't mean [shit]`,
      pattern`do stupid [shit]`,
      pattern`[shit] here we go again`,
      pattern`a pocket [pussy]`,
      pattern`goes to [shit]`,
      pattern`right [fucking] now`,
      pattern`won't do [shit]`,
      pattern`this [shit] happens`,
      pattern`jack [shit] about`,
      pattern`a [fucking] retard`,
      pattern`[fucked] over by`,
      pattern`do jack [shit]`,
      pattern`a [shit] post`,
      pattern`I [fucking] loved`,
      pattern`[shit] hits the`,
      pattern`don't [shit] on`,
      pattern`a flying [fuck]`,
      pattern`[fuck] all about`,
      pattern`[shit] you're right`,
      pattern`people [bitch] about`,
      pattern`[shit] eating grin`,
      pattern`kinda [fucked] up`,
      pattern`their [shit] together`,
      pattern`my [shit] together`,
      pattern`[fuck] the people`,
      pattern`a [fucking] child`,
      pattern`[shit] for brains`,
      pattern`your wet [pussy]`,
      pattern`saying [shit] ${["like", "about"]}`,
      pattern`turned to [shit]`,
      pattern`my hard [cock]`,
      pattern`[shit] going on in`,
      pattern`pull that [shit]`,
      pattern`[fucked] in the ass`,
      pattern`losing his [shit]`,
      pattern`a [fucking] dumbass`,
      pattern`a [fucking] legend`,
      pattern`then [fuck] ${["you", "them"]}`,
      pattern`be [fucked] up`,
      pattern`[fuck] you talking`,
      pattern`doing stupid [shit]`,
      pattern`done [fucked] up`,
      pattern`of [fucking] course`,
      pattern`no [shit] it's`,
      pattern`give zero [fucks]`,
      pattern`[fuck] you money`,
      pattern`where's the [fucking]`,
      pattern`this [shit] ain't`,
      pattern`[fuck] anyone who`,
      pattern`[shit] in the woods`,
      pattern`a gorgeous [pussy]`,
      pattern`the [fuck] would`,
      pattern`your [shit] together`,
      pattern`yeah [fuck] that`,
      pattern`a basic [bitch]`,
      pattern`man [fuck] this`,
      pattern`a [fucking] disgrace`,
      pattern`her [shit] together`,
      pattern`a karma [whore]`,
      pattern`trying to start [shit]`,
      pattern`[fuck] those people`,
      pattern`downvoted to [shit]`,
      pattern`scared the [shit]`,
      pattern`wanna [fuck] you`,
      pattern`[fuck] you if`,
      pattern`the [fuck] alone`,
      pattern`[shit] on the floor`,
      pattern`[fucked] up big`,
      pattern`gives no [fucks]`,
      pattern`it's my [fucking]`,
      pattern`even a [fucking]`,
      pattern`was talking [shit]`,
      pattern`[fucked] up thing`,
      pattern`freaked the [fuck]`,
      pattern`funniest [shit] I've`,
      pattern`calling [bullshit] on`,
      pattern`good little [slut]`,
      pattern`after all the [shit]`,
      pattern`but [fuck] that`,
      pattern`broken as [fuck]`,
      pattern`resting [bitch] face`,
      pattern`get [shit] on`,
      pattern`this [shit] show`,
      pattern`took a [shit]`,
      pattern`lose their [shit]`,
      pattern`to talk [shit]`,
      pattern`[fuck] all to`,
      pattern`the [asshole] in this`,
      pattern`your [pussy] looks`,
      pattern`[shit] compared to`,
      pattern`looked like [shit]`,
      pattern`can go [fuck]`,
      pattern`till you [cum]`,
      pattern`[fucking] listen to`,
      pattern`[fuck] those guys`,
      pattern`[shit] or get`,
      pattern`[cock] and ball`,
      pattern`[fucking] take it`,
      pattern`this kinda [shit]`,
      pattern`I'm [shit] at`,
      pattern`this [shit] when`,
      pattern`some bad [shit]`,
      pattern`doing that [shit]`,
      pattern`this [shit] all the`,
      pattern`gets [shit] on`,
      pattern`feeling like [shit]`,
      pattern`[shit] I forgot about`,
      pattern`an abusive [asshole]`,
      pattern`because [fuck] the`,
      pattern`[shit] beaten out`,
      pattern`just [fucking] stop`,
      pattern`go [fuck] yourselves`,
      pattern`a [fucking] rock`,
      pattern`just talking [shit]`,
      pattern`[fuck] the refs`,
      pattern`a [fucking] grip`,
      pattern`a chicken [shit]`,
      pattern`taste like [shit]`,
      pattern`the [fucking] puck`,
      pattern`[fucking] sex toy`,
      pattern`its [fucked] up`,
      pattern`[shit] its a`,
      pattern`turns to [shit]`,
      pattern`mean jack [shit]`,
      pattern`you [fucking] retard`,
      pattern`but for [fucks] sake`,
      pattern`[pussy] and ass`,
      pattern`I'd [fuck] you`,
      pattern`nah [fuck] that`,
      pattern`[fuck] you mean`,
      pattern`my thick [cock]`,
      pattern`way too [fucking]`,
      pattern`throw [shit] at`,
      pattern`like [shit] for`,
      pattern`[shit] that makes`,
      pattern`corrupt as [fuck]`,
      pattern`[shit] the bed in`,
      pattern`knows his [shit]`,
      pattern`are [shit] at`,
      pattern`no it [fucking]`,
      pattern`a [fucking] chance`,
      pattern`a [fucking] vibrator`,
      pattern`do [shit] ${["like", "for", "to", "so"]}`,
      pattern`[shit] went down`,
      pattern`ever the [fuck]`,
      pattern`played like [shit]`,
      pattern`mean [shit] if`,
      pattern`will [shit] on`,
      pattern`[fuck] is wrong`,
      pattern`the good [shit]`,
      pattern`the [fuck] over`,
      pattern`loving [shit] out`,
      pattern`pulled this [shit]`,
      pattern`post this [shit]`,
      pattern`a [fucking] douche`,
      pattern`[shit] for them`,
      pattern`do you want to [fuck]`,
      pattern`to [bitch] about`,
      pattern`[fuck] you to`,
      pattern`don't do [shit]`,
      pattern`I the [asshole]`,
      pattern`you like [shit]`,
      pattern`of [shit] for`,
      pattern`that good [shit]`,
      pattern`I'd rather [fuck]`,
      pattern`[fuck] the warriors`,
      pattern`said [fuck] this`,
      pattern`listen here you little [shit]`,
      pattern`this [shit] goes`,
      pattern`dumb [shit] and`,
      pattern`call [bullshit] on`,
      pattern`[shit] show that`,
      pattern`is [fucking] trash`,
      pattern`he does this [shit]`,
      pattern`a [fucking] weeb`,
      pattern`but [fuck] the`,
      pattern`off your [fucking]`,
      pattern`[shit] goes down`,
      pattern`stay the [fuck]`,
      pattern`say this [shit]`,
      pattern`to go [fuck]`,
      pattern`to [shit] the bed`,
      pattern`thank [fucking] god`,
      pattern`freak the [fuck]`,
      pattern`suck his [cock]`,
      pattern`you [fucking] son`,
      pattern`own [fucking] business`,
      pattern`seen a lot of [shit]`,
      pattern`gets [fucked] up`,
      pattern`that gay [shit]`,
      pattern`got [fucked] by`,
      pattern`gives zero [fucks]`,
      pattern`whenever the [fuck]`,
      pattern`an attention [whore]`,
      pattern`our [shit] together`,
      pattern`a [fucking] killer`,
      pattern`saying stupid [shit]`,
      pattern`piles of [shit]`,
      pattern`can [fuck] your`,
      pattern`to stir [shit]`,
      pattern`[fuck] them they`,
      pattern`much [shit] for`,
      pattern`wouldn't do [shit]`,
      pattern`making this [shit]`,
      pattern`[fuck] yeah let's`,
      pattern`a [fucking] hack`,
      pattern`me [fucking] sick`,
      pattern`is good [shit]`,
      pattern`blowing [shit] up`,
      pattern`this [shit] happen`,
      pattern`and [shit] will`,
      pattern`so [fuck] em`,
      pattern`[fuck] that noise`,
      pattern`i [fucking] wish`,
      pattern`they [shit] on`,
      pattern`getting [shit] done`,
      pattern`but [fuck] if`,
      pattern`saying [fuck] you`,
      pattern`how [fucking] good`,
      pattern`wherever the [fuck]`,
      pattern`can't hear [shit]`,
      pattern`a [fucking] alien`,
      pattern`get [fucked] and`,
      pattern`start no [shit]`,
      pattern`[fuck] them for`,
      pattern`other [shit] is`,
      pattern`[shit] i might`,
      pattern`bit [fucked] up`,
      pattern`kicking the [shit]`,
      pattern`is a bunch of [bullshit]`,
      pattern`those [fucked] up`,
      pattern`for [shitting] on`,
      pattern`say [fuck] a`,
      pattern`sick as [fuck]`,
      pattern`a [fucking] question`,
      pattern`who [shit] in`,
      pattern`sacks of [shit]`,
      pattern`[shit] out of him`,
      pattern`read the [fucking]`,
      pattern`type of [shit]`,
      pattern`some serious [shit]`,
      pattern`[shit] to say`,
      pattern`[fuck] you in`,
      pattern`because this [shit]`,
      pattern`[shit] about me`,
      pattern`this [shit] so`
    ]),

    group("exact/unpaired-captions", [
      pattern`like what the [fuck]`,
      pattern`you son of a [bitch]`,
      pattern`you piece of [shit]`,
      pattern`this piece of [shit]`,
      pattern`${["talking", "talk"]} [shit]`,
      pattern`like [fuck] it`,
      pattern`piss and [shit]`,
      pattern`if you [fuck] up`,
      pattern`${["being", "like"]} an [asshole]`,
      pattern`taking a [shit]`,
      pattern`that son of a [bitch]`,
      pattern`why the [fuck] you`,
      pattern`[fucking] ${["hilarious", "loser", "night", "dying", "children", "minds", "idea", "gay", "lazy", "brutal", "normal"]}`,
      pattern`[fuck] knows ${["why", "what", "how many"]}`,
      pattern`just kind of [fucking]$`,
      pattern`i'm a crazy [fucker]$`,
      pattern`${["oh", "me"]} what the [fuck]`,
      pattern`[fucking] ${["years", "sick", "rat"]}`,
      pattern`where the [fuck] you`,
      pattern`where the [shit] starts`,
      pattern`of crazy [shit]`,
      pattern`[fucking] loved`,
      pattern`in deep [shit]`,
      pattern`[fucking] kill me`,
      pattern`to do this [shit]`,
      pattern`it [fucked] me up`,
      pattern`[fucking] spot`,
      pattern`you don't know [shit]`,
      pattern`[fucking] break`,
      pattern`[fucking] child`,
      pattern`the [fuck] you think`,
      pattern`[fucking] ${["dollars", "blue"]}`,
      pattern`nobody gave a [shit]`,
      pattern`dirty as [fuck]`,
      pattern`[fuck] me you`,
      pattern`dumbest [shit] ever`,
      pattern`people don't give a [shit]`,
      pattern`[fucking] stab`,
      pattern`and [shit] you know`,
      pattern`${["be", "is", "you", "you're", "just", "was", "not", "of", "such", "he's", "are", "still", "me", "i'm", "what"]} an [asshole]`,
      pattern`[fucking] ${["retarded", "prick", "clown", "delicious", "difference", "psycho", "dragons", "lame", "clue", "bullet", "handle", "scumbag", "destroy"]}`,
      pattern`doesn't mean [shit]`,
      pattern`[fuck] ups`,
      pattern`treated like [shit]`,
      pattern`so [fuck] it`,
      pattern`[slut] shaming`,
      pattern`a son of a [bitch]`,
      pattern`sexy as [fuck]`,
      pattern`[pussy] lips`,
      pattern`but [fuck] me`,
      pattern`[fuck] it and`,
      pattern`how the [fuck] you`,
      pattern`[fuck] it why`,
      pattern`well [fuck] me`,
      pattern`hear [shit]`,
      pattern`racist piece of [shit]`,
      pattern`[shit] kicked`,
      pattern`did the same [shit]`,
      pattern`[fuck] it i'll`,
      pattern`remember [shit]`,
      pattern`smells like [shit]`,
      pattern`the son of a [bitch]`,
      pattern`same [shit] for`,
      pattern`means [fuck] all`,
      pattern`dumb piece of [shit]`,
      pattern`[fuck] buddies`
    ]),

    group("exact/fixed-phrases", [
      pattern`${["ah", "aw"]} [shit] here we`,
      pattern`${["ah", "aw"]} [shit], here we`,
      pattern`not the [asshole]$`,
      pattern`the same [shit]$`,
      pattern`was the [shit]$`,
      pattern`grow the [fuck] up`,
      pattern`permission to [cum] on your`,
      pattern`be the [asshole]$`,
      pattern`by the [pussy]$`,
      pattern`on earth [dipshit]$`,
      pattern`chill the [fuck] out`,
      pattern`[fuck] me I`,
      pattern`a beautiful [pussy]$`,
      pattern`${["get your", "get their"]} [shit] together`,
      pattern`${["on my", "around my"]} [cock]$`,
      pattern`playing like [shit]$`,
      pattern`to do [shit]$`,
      pattern`[fuck] yeah I`,
      pattern`this [fucking] question again`,
      pattern`couldn't see [shit]$`,
      pattern`[fuck] you for`,
      pattern`lost my [shit]$`,
      pattern`some stupid [shit]$`,
      pattern`so much [shit]$`,
      pattern`like absolute [shit]$`,
      pattern`[shit] like that`,
      pattern`talking mad [shit]`,
      pattern`which is [bullshit]$`,
      pattern`the [fuck] you say`,
      pattern`me the [fuck] out`,
      pattern`have a [shit] load of`,
      pattern`love to [cum] all over`,
      pattern`shut your [whore] mouth`,
      pattern`get that [shit] outta here`,
      pattern`don't know [shit]`,
      pattern`can't see [shit]`,
      pattern`${["lose your", "lose my"]} [shit|fucking]`,
      pattern`zero [fucking] deaths`,
      pattern`${["who", "nobody", "no one"]} gives a [fuck|shit] about`,
      pattern`weird [fucking] statue`,
      pattern`eat [shit] and die`,
      pattern`sweet [fuck] all`,
      pattern`[fuck] all$`,
      pattern`for the love of [fuck]`,
      pattern`^[fuck] knows`,
      pattern`${[".", "!", "?"]} [fuck] knows`,
      pattern`[shit] hit the fan`,
      pattern`${["that", "bad", "nature", "and"]} [shit] happens`,
      pattern`[shit] out of luck`,
      pattern`tough [shit] if`,
      pattern`^[fuck] this`,
      pattern`${[".", "!", "?"]} [fuck] this`,
      pattern`${[".", "!", "?"]} [fuck|shit] that`,
      pattern`${["no", "zero"]} [fucks] given`,
      pattern`${["give one", "give a single"]} [fuck]`,
      pattern`give two [fucks]`,
      pattern`[shit] storm`,
      pattern`pain in the [ass]$`,
      pattern`${["kick", "kicked", "kicking", "kiss", "bite", "bust", "busted", "busting"]} ${POSSESSIVE_DETERMINERS} [ass]$`,
      pattern`${["work", "laugh", "freeze", "freezing", "froze"]} ${POSSESSIVE_DETERMINERS} [ass] off`,
      pattern`${["take", "takes", "taking", "took"]} the [piss]$`,
      pattern`${["take", "takes", "taking", "took"]} the [piss] out of`,
      pattern`${["is", "was", "were", "I'm", "you're", "he's", "she's", "we're", "they're", "got", "getting"]} [pissed] off`,
      pattern`${["don't", "do not", "will", "would", "gonna", "going to", "trying to"]} [piss] ${OBJECT_PRONOUNS} off`,
      pattern`pure [fucking] respect`,
      pattern`piece of [fucking] ass`,
      pattern`piece of [fucking] [shit]`,
      pattern`write this [shit|fucking] down`,
      pattern`stole my [shit|fucking]`,
      pattern`apply that [shit]`,
      pattern`${["live for", "redoing", "struggle at"]} this [shit]`,
      pattern`respect women and [shit]`,
      pattern`all this [shit] again`,
      pattern`delete your [shit]`,
      pattern`pathetic little [moron|bitch]`,
      pattern`a [shit|fucking|fuck] ton`,
      pattern`that's the [shit] right there`,
      pattern`the whole [fucking] …`,
      pattern`bull [fucking] [shit]`,
      pattern`${EVALUATIVE_NOUN_PREFIXES} [bullshit]`,
      pattern`political [bullshit|shit]`,
      pattern`[bullshit] ${EVALUATIVE_NOUN_SUFFIXES}`,
      pattern`make some [fucking] noise`,
      pattern`zero [fucks].`,
      pattern`[fuck] yeah dude`,
      pattern`[fuck] it ${["I'm", "let's", "I"]}`,
      pattern`[fuck] it. ${["I'm", "let's", "I"]}`,
      pattern`${["yeah", "but", "ah"]} [fuck] it`,
      pattern`${["say", "I'll"]} [fuck] it`,
      pattern`oh [fuck] me`,
      pattern`freaking the [fuck]`,
      pattern`what the [fuck] you`,
      pattern`what the [fuck's] going on`,
      pattern`what the [fuck's] happening`,
      pattern`what the [fucking] hell`,
      pattern`[fucking] kidding me`,
      pattern`kick the [shit]`,
      pattern`I have no [fucking]`,
      pattern`that piece of [shit]`,
      pattern`to [fucking] kill`,
      pattern`${["empty the", "using the"]} [shitter]`,
      pattern`use the [shitter] as much`,
      pattern`cool [shit]`,
      pattern`see that [shit]`,
      pattern`oh [shit] ${["that's", "and"]}`,
      pattern`[fuck] you I'm`,
      pattern`any of this [shit|fucking]`,
      pattern`any of that [shit]`,
      pattern`a whole bunch of [shit|bullshit]`,
      pattern`the sort of [shit]`,
      pattern`got [shit] all over`,
      pattern`have [shit] to do`,
      pattern`the [shit] that I`,
      pattern`[shit] that I have`,
      pattern`uh well [shit]`,
      pattern`she did a [bullshit]`,
      pattern`stay down [bitch]`,
      pattern`what the absolute [fuck]`,
      pattern`cluster [fuck|clusterfuck]`,
      pattern`is such [bullshit]$`,
      pattern`you sick [fuck|fucker]$`,
      pattern`${["play dead", "play dead,"]} [bitch]$`,
      pattern`[fuck] the police`
    ]),

    group("exact/extrapolated", [
      pattern`said [fuck] it`,
      pattern`[fucking] ${["clowns", "shoes", "absurd", "toilet", "seasons", "dense", "illegal", "tragic", "ignorant", "jail", "prison", "dork", "body", "incredible", "difficult", "screaming", "lot", "psychopath", "delusional", "obvious", "matter", "smart", "get it", "times", "second", "retard", "pig", "strange", "nasty", "words", "roof"]}`,
      pattern`you sons of [bitches]`,
      pattern`wreck [shit]`,
      pattern`[fuck] it if`,
      pattern`[fuck] this i'm`,
      pattern`them by the [pussy]`,
      pattern`like dog [shit]`,
      pattern`him the [fuck] out`,
      pattern`the piece of [shit]`,
      pattern`i need a [fucking]`,
      pattern`${["and", "them", "been", "i"]} an [asshole]`,
      pattern`lying piece of [shit]`,
      pattern`none of this [shit]`,
      pattern`[fuck] me it's`,
      pattern`sick son of a [bitch]`,
      pattern`${["but what the", "or whatever the", "wait what the", "yo what the"]} [fuck]`,
      pattern`get in the [fucking]`,
      pattern`saying dumb [shit]`,
      pattern`giant piece of [shit]`,
      pattern`go [fuck] your`,
      pattern`[fuck] this and`,
      pattern`finally some good [fucking]`,
      pattern`${["doing", "did"]} [fuck] all`,
      pattern`stir [shit]`,
      pattern`${["give me a", "has no", "had no"]} [fucking]`,
      pattern`[shit] on for`,
      pattern`seeing [shit]`,
      pattern`don't [fuck] up`,
      pattern`doing [shit] like`,
      pattern`this [shit] makes`,
      pattern`who the [fuck] you`,
      pattern`[shit] from my`,
      pattern`where's my [fucking]`,
      pattern`what i [fucking]`,
      pattern`over a [fucking]`,
      pattern`the [fuck] you want`,
      pattern`fat piece of [shit]`,
      pattern`that [shit] away`
    ])
  ]);

  var PRODUCTIVE_RULES = Object.freeze([
    group("productive/expressions", [
      pattern`${["go", "going", "went", "gone"]} to [shit].`,
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
      pattern`${["freak", "freaks", "freaked", "freaking"]} me the [fuck] out`,
      pattern`the living [shit|fuck] out of`,
      pattern`${["clean this", "clean that"]} [shit] up`,
      pattern`watch this [shit|fuck|fucking]`,
      pattern`all this [shit|fucking|bullshit|pussy|fuck]`,
      pattern`${["this", "that"]} [shit] out`,
      pattern`${["got", "doesn't"]} [shit] to do`,
      pattern`making [shit] up`,
      pattern`get [shit] done`,
      pattern`${["doing", "saying", "talking", "some", "weird", "stupid", "dumb"]} [shit] like that`,
      pattern`${["better", "other", "some", "more", "enough", "plenty of", "a lot of", "a bunch of", "lots of"]} [shit] to do`,
      pattern`a lot of [shit|bullshit] ${["and", "around", "from", "going", "happened", "in", "so", "that", "to", "yeah"]}`,
      pattern`talking [shit] about`,
      pattern`${["talk", "talks", "talked"]} [shit] ${["right", "now", "and", "when", "to", "about"]}`,
      pattern`talking [shit] ${["as", "mate"]}`,
      pattern`so much [shit] going on`,
      pattern`throw that [shit] ${["away", "in"]}`,
      pattern`shady [shit] ${["behind", "to", "and"]}`,
      pattern`[fucking] losers`,
      pattern`having a [fucking] blast`,
      pattern`[fucking] ${["rad", "impossible", "insane", "evil"]}`,
      pattern`the coolest [shit] in`,
      pattern`would do dumb [shit] ${["cuz", "like", "and"]}`,
      pattern`do that [shit] ${["no", "it's", "I", "is", "and", "too"]}`,
      pattern`do this [fucking] …`,
      pattern`throwing [shit] at`,
      pattern`to [shit] ${["all over", "in"]}`,
      pattern`${["check", "figure", "sort", "work"]} that [shit] out`,
      pattern`this [shit] for`,
      pattern`some [shit] out`,
      pattern`lot of [shit] ${["to", "in", "and", "about"]}`,
      pattern`${["roll", "rolled", "rolling"]} like [shit]`,
      pattern`that's good [shit]`,
      pattern`smell like [shit]`,
      pattern`when [shit]`,
      pattern`beat the [shit]`,
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

    group("productive/phrasal-verbs", [
      pattern`better not [fuck] things up`,
      pattern`[fuck] him up`,
      pattern`[fuck] this up`,
      pattern`${SUBJECT_PRONOUNS} [fucked|fuck|fucks|fucking] it up`,
      pattern`${GERUND_WITH_PREFIXES} [fucking] with`,
      pattern`${["dream about", "dream of"]} [fucking|shit] …`,
      pattern`were [fucked|fucking|bitchy] with`,
      pattern`${["don't you", "don't", "I can"]} [fuck] with`,
      pattern`${["have", "has", "had"]} [fucked|fuck] ${["it", "me"]}`,
      pattern`${["am", "is", "are", "was", "were"]} [fucking|shit|fuck] it`,
      pattern`${["is", "was", "keeps"]} [fucking|fuck] me`,
      pattern`${["be", "were", "you're", "just"]} [dicking|fucking|fuck|dickin|fucked] around`,
      pattern`${["am", "is", "are", "was", "been", "being", "I'm", "he's", "she's", "we're", "they're"]} [fucking|dicking|fuck|dickin|fucked] around`,
      pattern`good at [fucking] it`,
      pattern`almost [fucked] me`,
      pattern`${["are you", "gotta be", "got to be", "to be"]} [shitting|fucking] me`,
      pattern`don't [fuck|bullshit|fucking] me`,
      pattern`gonna [fuck|fucking] up`,
      pattern`wouldn't [fuck|fucked] up`,
      pattern`${["make", "let", "help"]} you [fuck] up`,
      pattern`[fuck] up ${PHRASAL_UP_OBJECTS}`,
      pattern`[fucked|fucking|fuck] up ${PARTICIPLE_OBJECTS}`,
      pattern`${PERFECT_PREFIXES} [fucked] up`,
      pattern`${["keep", "keeps", "stop", "stopped"]} [fucking] up`,
      pattern`kept [fucking|fucked] up`,
      pattern`${["you are", "you're"]} [fucked|fucking] up`,
      pattern`go [fuck] ${["himself", "herself", "themselves"]}`,
      pattern`[fuck|shit] you piece of`,
      pattern`[fuck] you ${["man", "game", "link", "Jesus", "Jimmy", "everyone", "I", "too", "doing", "dude", "and"]}`,
      pattern`[fuck] you ${["oh", "yeah", "bro"]}`,
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

    group("productive/syntax", [
      pattern`${["what", "how", "who", "why", "when"]} the [fuck]`,
      pattern`whatever the [fuck]`,
      pattern`the [fuck] ${FUCK_THE_SUFFIXES}`,
      pattern`the [fuck] away`,
      pattern`the [fuck|shit] ${["is", "you", "outta"]}`,
      pattern`come the [fuck] on`,
      pattern`wake the [fuck] up`,
      pattern`hurry the [fuck] up`,
      pattern`buckle the [fuck]`,
      pattern`stay the [fuck] ${["away", "out", "down", "back", "over", "in"]}`,
      pattern`${["sit", "calm", "slow"]} the [fuck] down`,
      pattern`it the [fuck] down`,
      pattern`the [fuck's] going on`,
      pattern`[fuck's] sake`,
      pattern`did you just [fucking] call`,
      pattern`how [fucking] ${["dare you", "dare"]}`,
      pattern`do you want to [fucking|fuck] …`,
      pattern`are you [fucking] ${["gay", "jerking", "liking"]}`,
      pattern`big [fuck|motherfucker] you`,
      pattern`${FUCK_YOU_PREFIXES} [fuck] you`,
      pattern`${FUCK_VERB_PREFIXES} [fuck] …`,
      pattern`give a flying [fuck]`,
      pattern`no [fuck] that`,
      pattern`you know what [fuck] …`,
      pattern`said [fuck] you`,
      pattern`[fuck] a duck`,
      pattern`to [fuck] the …`,
      pattern`[fuck] yeah.`,
      pattern`take a [shit] ${["in", "on"]}`,
      pattern`${["took a", "took a huge", "done a huge"]} [shit] in`,
      pattern`cheap [shit|pussy|motherfucker]`,
      pattern`${["piece", "pieces"]} of [shit]`,
      pattern`fucking [shit]`,
      pattern`dog [shit|dogshit]`,
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
      pattern`it's so [fucking] …`,
      pattern`who [fucking] knows`,
      pattern`${["sweet", "mother of"]} [fucking] Jesus`,
      pattern`strong as [fuck]`,
      pattern`[fucking] ${["sick of", "talk to"]}`,
      pattern`${["miss", "sell"]} the [shit] out of`,
      pattern`stuck up little [bitch]`,
      pattern`all [shit] themselves`,
      pattern`getting the [shit] kicked`,
      pattern`[cocks] ${["its head", "his head", "her head", "an eyebrow", "his eyebrow", "her eyebrow"]}`,
      pattern`[cock] ${["their head", "their eyebrow"]}`,
      pattern`of [fucking] control`,
      pattern`${SUBJECT_PRONOUNS} [fucked|fuck|fucking|fuckers|fucks] up`,
      pattern`that's so [fucked|fucking] up`,
      pattern`${PARTICIPLE_MODIFIERS} [fucked] up`,
      pattern`${BE_FORMS.concat(["all", "team", "station"])} [fucked|fucking] up`,
      pattern`re [fucked].`
    ]),

    group("productive/insults", [
      pattern`wish a [bitch] would`,
      pattern`your [cock] shouldn't`,
      pattern`son of a [bitch]`,
      pattern`son of [bitches|bitch]`,
      pattern`sons of [bitches]`,
      pattern`[bitch] and moan`,
      pattern`an [asshole|arsehole]`,
      pattern`sick [fuck|fucker].`,
      pattern`am I the [asshole]`,
      pattern`consumer [whore]`,
      pattern`${["where is", "where's"]} this [motherfucker|fucking]`,
      pattern`wretched [cunts]`,
      pattern`is for [pussies]`
    ]),

    group("productive/contextual-fucking", [
      // Fixed expressions.
      pattern`the [fucking] light`,
      pattern`these [fucking] people`,
      pattern`god [fucking] ${["damn it", "dammit", "damn"]}`,
      pattern`jesus [fucking] christ`,
      pattern`swear to [fucking] god`,
      pattern`the last [fucking] time`,
      pattern`[fucking] pieces of`,

      // Verbs and commands.
      pattern`just [fucking] ${["do it", "tell me", "tell us", "die", "snorted", "go"]}`,
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
      pattern`[fucking] unsubscribe`,
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
      pattern`look how [fucking] far`,
      pattern`just [fucking] great`,
      pattern`a [fucking] ${["good", "dead"]}`,
      pattern`[fucking] cancerous`,
      pattern`right [fucking] there`,
      pattern`no [fucking] around`,
      pattern`${SIMILE_PREFIXES} like a [fucking] …`,
      pattern`uh oh [shit]`,
      pattern`oh [shit] ${INTERJECTION_SUFFIXES}`,
      pattern`you're like oh [shit]`,

      // Objects, people, places, and quantities.
      pattern`smallest [fucking] mouse`,
      pattern`[fucking|bitch] speedrun`,
      pattern`[fucking] ${["tail", "ripper", "speedun", "piece of"]}`
    ])
  ]);

  var BASE_VERB = slot(WORD_ROLES.BASE_VERB);
  var EXPLETIVE = slot(WORD_ROLES.EXPLETIVE);
  var INTENSIFIER = slot(WORD_ROLES.INTENSIFIER);
  var PARTICIPLE = slot(WORD_ROLES.PARTICIPLE);
  var MASS_NOUN = slot(WORD_ROLES.MASS_NOUN);
  var SIMILE_FUCK = slot(set("simile fuck", ["fuck"]));
  var SIMILE_SHIT = slot(set("simile shit", ["shit"]));

  var ROLE_FRAMES = Object.freeze([
    group("frames/verb-intensifiers", [
      frame`${NEGATED_DO_PREFIXES} ${INTENSIFIER} ${VERB_OBJECTS}`
    ]),
    group("frames/base-verbs", [
      frame`${BASE_VERB_PREFIXES} ${BASE_VERB} ${VERB_OBJECTS}`,
      frame`${BASE_VERB_PREFIXES} ${BASE_VERB} ${VERB_PARTICLES}`,
      frame`${BASE_VERB_QUESTION_PREFIXES} ${BASE_VERB} ${VERB_PARTICLES}`
    ]),
    group("frames/expletives", [
      frame`${EXPLETIVE_DETERMINER_PREFIXES} the ${EXPLETIVE} ${EXPLETIVE_DETERMINER_SUFFIXES}`
    ]),
    group("frames/participles", [
      frame`${PARTICIPLE_FRAME_PREFIXES} ${PARTICIPLE} ${PARTICIPLE_FRAME_SUFFIXES}`
    ]),
    group("frames/intensifiers", [
      frame`${INTENSIFIER_DETERMINERS} ${INTENSIFIER} ${INTENSIFIED_NOUNS}`,
      frame`${INTENSIFIER_COPULAS} ${INTENSIFIER} ${INTENSIFIED_PREDICATES}`,
      frame`${EMPHATIC_SUBJECTS} ${INTENSIFIER} ${EMPHATIC_ACTIONS}`,
      frame`${EMPHATIC_AUXILIARIES} ${INTENSIFIER} ${EMPHATIC_AUXILIARY_ACTIONS}`,
      frame`${INTENSIFIER_MODIFIERS} ${INTENSIFIER} ${INTENSIFIED_ADJECTIVES}`,
      frame`${NUMBER} ${INTENSIFIER} ${COUNT_UNIT}`
    ]),
    group("frames/mass-nouns", [
      frame`${MASS_NOUN_PREFIXES} ${MASS_NOUN}`
    ]),
    group("frames/simile-expletives", [
      frame`${AS_FUCK_ADJECTIVES} as ${SIMILE_FUCK}`,
      frame`${AS_SHIT_ADJECTIVES} as ${SIMILE_SHIT}`
    ]),
    group("frames/phrasal-verbs", [
      frame`${PHRASAL_VERB_PREFIXES} ${BASE_VERB} ${PHRASAL_SUFFIXES}`,
      frame`${SUBJECT_PRONOUNS} ${PHRASAL_SUBJECT_MODALS} ${BASE_VERB} ${PHRASAL_PARTICLE_SUFFIXES}`,
      frame`${FUTURE_SUBJECTS} ${BASE_VERB} ${PHRASAL_PARTICLE_SUFFIXES}`
    ])
  ]);

  var LOW_CONFIDENCE_RULES = Object.freeze([
    group("low-confidence/mass-nouns", [
      pattern`${[
        "of this", "for this", "do this", "my own", "into this"
      ]} [shit]$`,
      pattern`with that [shit]$`,
      pattern`cut the [shit]$`,
      pattern`load of [shit]$`,
      pattern`${["don't have", "looks like"]} [shit]$`,
      pattern`${["this is", "all the", "for your", "to his"]} [bullshit]$`
    ]),
    group("low-confidence/insults", [
      pattern`${["a little", "a crazy", "you crazy", "you fuckin'", "she's a"]} [bitch]$`,
      pattern`you [fucked] my wife`,
      pattern`are so [fucked]$`
    ]),
    group("low-confidence/rare-words", [
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
      pattern`named [shithead]`,
      pattern`was an absolute [shitshow]$`
    ])
  ]);

  var FALLBACK_RULES = Object.freeze([
    group("fallback/ambiguous", [
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
      pattern`[fucking] ${INTENSIFIED_TRAILING_WORDS}`,
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
      pattern`${["get", "go", "keep", "move", "run", "walk", "fly"]} the [fuck] away`
    ])
  ]);

  // Learned from FNV-1a video buckets 0-13 of 20 in the paired captions.
  // Values passing support >= 10, P >= .80, and margin >= .20 are
  // [word, probability, top-two margin, training support].
  var CANDIDATE_PRIORS = Object.freeze({
    "[__] <mass-noun suffix>": ["shit", 0.8824, 0.8627, 153],
    "[__] awesome": ["fucking", 0.9286, 0.9286, 42],
    "[__] like this": ["shit", 0.8333, 0.75, 12],
    "[__] nothing": ["fucking", 0.8333, 0.7333, 30],
    "[__] off": ["fuck", 0.8678, 0.8102, 295],
    "[__] out of here": ["fuck", 0.9677, 0.9355, 31],
    "[__] out of me": ["shit", 0.9722, 0.9444, 36],
    "[__] out of them": ["shit", 1, 1, 2],
    "[__] sucks": ["fucking", 0.9423, 0.9038, 52],
    "[__] that guy": ["fuck", 1, 1, 22],
    "[__] this guy": ["fuck", 1, 1, 3],
    "[__] thing": ["fucking", 0.9118, 0.8529, 34],
    "[__] yourself": ["fuck", 0.8611, 0.7222, 36],
    "<base-verb prefix> [__] <verb object>": ["fuck", 0.8713, 0.8366, 202],
    "<base-verb prefix> [__] <verb particle>": ["fuck", 0.956, 0.9505, 182],
    "<base-verb question> [__] <verb particle>": ["fuck", 1, 1, 10],
    "<contracted future subject> [__] <phrasal-particle suffix>": ["fuck", 1, 1, 3],
    "<copula> [__] <predicate>": ["fucking", 0.9779, 0.9779, 544],
    "<determiner> [__] <noun>": ["fucking", 0.9314, 0.9288, 1166],
    "<emphatic auxiliary> [__] <auxiliary action>": ["fucking", 0.9875, 0.9875, 321],
    "<emphatic subject> [__] <emphatic action>": ["fucking", 0.9608, 0.9608, 510],
    "<intensifier modifier> [__] <intensified adjective>": ["fucking", 0.9961, 0.9961, 254],
    "<mass-noun prefix> [__]": ["shit", 1, 1, 27],
    "<number> [__] <count unit>": ["fucking", 1, 1, 28],
    "<participle-frame prefix> [__] <participle-frame suffix>": ["fucked", 1, 1, 15],
    "<phrasal-verb prefix> [__] <phrasal-verb suffix>": ["fuck", 1, 1, 15],
    "a [__] ton": ["shit", 0.9474, 0.8947, 76],
    "all [__] up": ["fucked", 1, 1, 26],
    "all that [__]": ["shit", 0.9, 0.8, 10],
    "all this [__]": ["shit", 0.878, 0.8293, 82],
    "an [__]": ["asshole", 0.9777, 0.9609, 179],
    "any of this [__]": ["shit", 0.8947, 0.8421, 19],
    "are you [__] me": ["shitting", 1, 1, 2],
    "beating the [__] out": ["shit", 0.9091, 0.8182, 11],
    "cluster [__]": ["fuck", 1, 1, 15],
    "dog [__]": ["shit", 0.9194, 0.9194, 62],
    "don't [__] me": ["fuck", 0.9487, 0.9231, 39],
    "get the [__] ": ["fuck", 0.8858, 0.7991, 219],
    "going to be a [__]": ["fucking", 0.9167, 0.8333, 12],
    "gives a [__]": ["shit", 1, 1, 10],
    "got a [__] ": ["fucking", 0.8519, 0.7778, 27],
    "have a [__] ": ["fucking", 0.9268, 0.8537, 41],
    "how the [__]": ["fuck", 0.913, 0.8261, 23],
    "holy [__]": ["shit", 0.8395, 0.6914, 81],
    "I [__] it up": ["fucked", 0.8, 0.6, 35],
    "I [__] up": ["fucked", 0.8636, 0.7273, 44],
    "I don't [__] ": ["fucking", 0.9371, 0.9021, 143],
    "I'm a [__] ": ["fucking", 0.8444, 0.7778, 45],
    "is [__] up": ["fucked", 0.8667, 0.8, 15],
    "just [__] around": ["fucking", 1, 1, 2],
    "kick the [__] out": ["shit", 1, 1, 20],
    "scare the [__] out": ["shit", 1, 1, 2],
    "sick [__].": ["fuck", 1, 1, 2],
    "the [__] is": ["fuck", 0.9674, 0.9549, 399],
    "there's a [__] ": ["fucking", 0.96, 0.92, 25],
    "they're [__] up": ["fucking", 1, 1, 2],
    "this was a [__]": ["fucking", 1, 1, 2],
    "to [__] on": ["shit", 0.9286, 0.9286, 14],
    "was [__] up": ["fucked", 0.9286, 0.9286, 14],
    "watch this [__]": ["shit", 0.8649, 0.7838, 37],
    "we [__] up": ["fucked", 0.9167, 0.8333, 12],
    "what the [__]": ["fuck", 0.9119, 0.8821, 772],
    "who the [__]": ["fuck", 0.9268, 0.8537, 41],
    "why the [__]": ["fuck", 1, 1, 42],
    "weird [__] ": ["shit", 0.9231, 0.8462, 13]
  });

  var RULE_GROUPS = Object.freeze({
    exact: EXACT_RULES,
    productive: PRODUCTIVE_RULES,
    frames: ROLE_FRAMES,
    lowConfidence: LOW_CONFIDENCE_RULES,
    fallback: FALLBACK_RULES
  });

  var CONTINUING_PREFIX_SETS = Object.freeze([
    INTENSIFIER_DETERMINERS,
    INTENSIFIER_COPULAS,
    EMPHATIC_SUBJECTS,
    EMPHATIC_AUXILIARIES,
    INTENSIFIER_MODIFIERS
  ]);

  var exports = Object.freeze({
    ALLOWED_WORDS: ALLOWED_WORDS,
    CANDIDATE_PRIORS: CANDIDATE_PRIORS,
    WORD_ROLES: WORD_ROLES,
    RULE_GROUPS: RULE_GROUPS,
    CONTINUING_PREFIX_SETS: CONTINUING_PREFIX_SETS
  });

  root.UncensoredRuleData = exports;
  if (typeof module === "object" && module.exports) module.exports = exports;
})();
