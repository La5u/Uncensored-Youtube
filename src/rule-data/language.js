(function buildRuleLanguage() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var compiler = root.UncensoredRuleCompiler ||
    (typeof require === "function" ? require("../rules-compiler") : null);
  var set = compiler.set;
  var regexSet = compiler.regexSet;
  // Semantic roles are broader than either output vocabulary.
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

  // Conservative subset that deterministic context rules may emit.
  var RULE_WORDS = set("rule word", [
    "fuck", "fucks", "fuck's", "fucking", "fucked", "fucker", "fuckers",
    "motherfuck", "motherfucker", "motherfuckers", "motherfucking",
    "shit", "shithole", "shitting", "shithead", "shitter",
    "bitch", "bitches", "moron", "bullshit", "dipshit", "cock", "cocks",
    "arsehole", "asshole", "assholes", "dicked", "dicking", "dickin", "dickhead",
    "twat", "whore", "whores", "cunt", "cunts", "pussy", "pussies", "slut", "cum"
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
      "air", "annoying", "awful", "badass", "ball", "battle",
      "beast", "better", "brilliant", "cares", "chair", "christ", "concentrate",
      "creepy", "damage", "dark", "death", "double", "embarrassing", "fantastic",
       "fly", "freaky", "fun", "genius", "gross", "hair", "hammer",
      "fingers", "help", "hope", "horrible", "horse", "hot", "idiots", "key", "know",
      "legs", "long", "loud", "love", "map", "mental",
      "morons", "nerve", "nonsense",
      "party", "pay", "power", "reason", "record", "red", "robot",
      "same", "scary", "shark", "shoot", "slow", "sound", "speed", "suck",
      "sweet", "terrible", "terrifying", "tree", "trees", "useless",
       "wall", "worked", "worry",
      "adorable", "angry", "bear", "beautiful", "boat", "chaos",
      "bomb", "book", "boring", "broken", "cold", "cute",
      "deal", "demon", "dice", "dick", "died", "dope", "door",
      "doors", "dragon", "drink", "dumb", "eye", "fall", "finish",
      "food", "friend", "funny", "game", "garbage", "giant", "gold", "guy", "hand", "hate",
      "helmet", "high", "huge", "killed", "knew",
      "lucky", "mad", "massive", "monkey", "moon", "name", "perfect", "piece", "plan",
      "problem", "ring", "sad", "self", "serious", "sexy", "sit", "spell", "spells",
      "seen", "story", "strong", "stuck", "team", "throw", "tired", "town",
      "way", "waste", "weak", "wild", "worst",
      "ask", "arm", "arrows", "banana", "bank", "bouncing", "bother", "camera",
      "camp", "catch", "cheese", "chill", "classic", "cliff", "clothes", "coolest",
      "creep", "cursed", "dangerous", "destroyed", "doctor",
      "doubt", "dreadful", "effort", "empire", "feet", "fortune", "glass", "gorgeous", "hated",
      "heart", "higher", "horn", "horrifying", "laser", "lion", "lose", "miles",
      "minute", "nerds", "notes", "pain", "proud", "pull", "relax", "rifles", "rude",
      "shooting", "shoulder", "skull", "sociopath", "spider", "superhero", "tough",
      "trouble", "twisted", "war", "week", "weirdo", "worm",
      "podcast", "angle", "corner", "middle", "walls", "deep", "fire", "mountain",
      "year", "bananas", "google", "imbecile", "bridge", "windows", "intense", "noise",
      "movie", "hates", "school", "computer", "crush", "metric", "miserable", "matters",
      "crushing", "series", "action", "paid", "crushed", "blow", "bit of", "company",
      "impressive", "ugly", "target", "insanity", "short", "core", "master", "blast",
      "exhausted", "enormous", "purple", "wolf", "cell", "yellow", "river", "explode",
      "good", "old", "watch", "ride", "trash", "call", "person", "nice", "episode",
      "different", "bit", "life", "side", "eight", "shitty", "heard", "gone", "hurt",
      "internet", "walk", "read", "free", "tiny", "working", "train", "park", "solid",
      "20", "c", "controller", "ocean", "full", "check", "hear", "almost", "build",
      "videos", "luck", "find", "magic", "pipe", "tried", "comments", "cheap", "film",
      "crying", "duck", "rooster", "monster", "killing", "miss", "script", "email",
      "brown", "hearing", "nine", "vampire", "article", "drove", "response",
      "incompetent", "plus", "mom", "english", "gta", "floor", "city"
    ]
  ));
var VALIDATED_INTENSIFIER_SUFFIXES = set("validated intensifier suffix",
    "1 10 12 2 2018 30 30s 360 80 9 90s aaa abandon absolute abusive account acid act adam ads advantage advertisement advil afraid afterlife ages agony aircraft ale alex amateur american ammo among anal aneurysm anime answer answers anti anxiety anywhere app appeal area armored ashamed assassin attempt audacity austin axe backstory baked bam ban band bangers banging banned banter barrel baseball bath bay beef been bees beg begging berserk bethy bible billionaire bin birds bizarre blame blanket bleep bless blocking bloom bob bombs boners bones bonkers bonus boo boogie books bored bounce bowl bowling boxes brain breaking breaks brian brick bright brittany broad bronze broom bruce brute bs bucks bug bugs bull bully bunch bunk bunny burgers bush busted busy butterfly ca calm cameron caravan career caring case casserole castles cave ceiling celebrate character characters charade childhood chinese chipmunks choke chopped christian christmas circle clear cleared clears clever clicks clip clock clocked closet clowning clutch coconut coin comedy comma commit companies completely complex comprehend confident confused conservative consistent controls cooking corpse counter country coward crack crap created creativity creatures credits creed creeping crew criminal crit crobat crocodile cross crow crowd cruel cult cups curb currency cyber d8 dairy dam damnit daniel dart dashing dave dealers debate deck degrees delightful depend desert deserve design desperate destroying devil devious dialogue diaper diarrhea dicks dies digital dignity dime dinosaur direction dirty display dm dodging dog's dogma dolphin donkey doodle dookie dot dots download drag dramatic draw dress drinking drive driving drone dropped drown drowned drug drunkard dudes dug duggar duke dumped dungeons dunk dust eagle earned eats elbow electric elementary elevators emails emoji emotional emotionally empathy emperor empowered empty enemy enforcers enjoy entrance envelope epstein eradicate eric errands euphoria excellent exercise exhausting exist expensive eyeball eyeballs faces faded families fanfiction farming fat father fay fear fell fellas feral fiddle field fiery files fill fired fitting five fix flare flash flashlight flashlights flat flesh focus fool foot football force forgot fortress freaked freedom fresh fucked function funeral funniest furniture gamble game's gameplay gamers garden gaslighting gate gatorade gear gears generic ghost girl's girlfriend girls gladiator glare glue gnome goblins gods golf goof gosh grab grand graphics gray greatest green grey grim grind gruesome guns gut gz hacked hackers hacks hallway handled handsome happy harm hateful hauling hawk heading heal heaven heavy heel helped heroes hers hide hideout hiding hippo history hm hog holds home homophobic honest hook hooray horses hp huckleberry huffing hunter hurricane husband hysterical image incest inch industrial industry information infuriating inquisition insufferable insult interested invisible invitations iphones irish irony island issues item jack jacked jackpot janitor jazz jealous jes jetpack joe johnny joking joseph journey judge juice juicy july jumping jurassic kaiju karate ketchup keth kick kicking kid's kills kirby kiss kitten knee kraken lamp land lava leaders leap leaving led legacy legendary letterman levels lever liar library limit limiter line liquid literal living lizard location log loop lowest madness magical magician making mana mario marissa market mars matrix max mayonnaise mcdonald's meant meat mech medal medical medicine melee memory merch messed messing messy metal metaverse mic microphone mid mini minions mirrors missionary models moments monkeys monsters monstrosity mosquito motion mouse murdered mushroom mysterious na nailed nation nazi neat neo nerves nervous nft ninth note nuke obama obliterated obnoxious office older opening opera opinion opposite options ordeal order oven own palm paramount pardon parkour partner passed password patience patreon paying penguin penis percy personality pervert perverts phases photocopier physical pigs pimps pin pistol pit pixar places plant plants plastic platforming playstation plot point poke poland pond positive pot potentially potion pounds powerhouse powerpoint practicing prayer precious pregnant president pretentious pricks prime privileged producers product program project prone pronouns pudding pumped punching puppy purpose pushes puts puzzles quarters queen quiet ra race radio rain raise raised rakes rampage range raven ray religion religious remaster remembered ren repeating replay request resident responding rest ret revenge rift righteous rip ripping road rocked rocks rogue roller rong room roommate rope rotten ruin rule sadistic salt samurai satan savages saving saying scam scar scares scene scientific score scratch screen scrotum scum scumbags seat sentence sewers shake shank shield shock shocking shop shove shreds shrink sign signs sin singer single sink sip siren skeleton skeletons skin skulls slam slaves slick slime slob smoking smooth sneak soft solution song sorcerer speak spike spikes spill spins spirits spy square st standing stands starbucks state stayed sterling sticks stinky stomach stone stones storage stranger stream street stressful string studs stuffed style sunrise surge surrounded swamp swim swing swings swivel sworn syphilis system t taco tag tai tangled tank tapestry taps targets tase teachers teddy tedious teeth teleport teleports television telling terminator test teu texted theme therapy thick threaten threw thrilled timeline titties toast toddler tomatoes tommy tool top touch tower towers trade traffic trail treat triangle trick tricky triggered trivia troll truth turkey tv u undertale underwear universe unreasonable upset upsetting vicious vile vince voice volume vomit votes wacky waffle waitress ward waves weep werewolf whack whale wheel whiffs whipping whoo wicked wide wig wii wings winning witch wizards won woods worried worse worship worth worthless wrapped write writer x xbox yacht yank yard".split(" "));
  // Rare but unambiguous concrete nouns kept separate from the multi-video set.
  var RARE_INTENSIFIER_SUFFIXES = set("rare intensifier suffix",
    "aberrations aisle assassins backrooms bacteria benches blowdart cataclysm constellation contraptions crossbows earwigs fireworks flashbang hamster impostor jpegs leeches migraines orangutan parachute scalpers switchblade teammates tortoise utensils xenomorph".split(" "));
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
    "wall", "zoomies", "friends", "jet", "mask", "answer", "law", "restaurant"
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


  var CONTINUING_PREFIX_SETS = Object.freeze([
    INTENSIFIER_DETERMINERS,
    INTENSIFIER_COPULAS,
    EMPHATIC_SUBJECTS,
    EMPHATIC_AUXILIARIES,
    INTENSIFIER_MODIFIERS
  ]);

  var vocabulary = Object.freeze({
    SUBJECT_PRONOUNS: SUBJECT_PRONOUNS,
    OBJECT_PRONOUNS: OBJECT_PRONOUNS,
    POSSESSIVE_DETERMINERS: POSSESSIVE_DETERMINERS,
    PLAIN_VERB_SUBJECTS: PLAIN_VERB_SUBJECTS,
    THIRD_PERSON_SUBJECTS: THIRD_PERSON_SUBJECTS,
    FUTURE_SUBJECTS: FUTURE_SUBJECTS,
    NEGATED_SUBJECT_PREFIXES: NEGATED_SUBJECT_PREFIXES,
    BE_FORMS: BE_FORMS,
    QUESTION_WORDS: QUESTION_WORDS,
    FUCK_THE_SUFFIXES: FUCK_THE_SUFFIXES,
    FUCK_YOU_PREFIXES: FUCK_YOU_PREFIXES,
    FUCK_VERB_PREFIXES: FUCK_VERB_PREFIXES,
    BASE_VERB_PREFIXES: BASE_VERB_PREFIXES,
    BASE_VERB_QUESTION_PREFIXES: BASE_VERB_QUESTION_PREFIXES,
    VERB_OBJECTS: VERB_OBJECTS,
    VERB_PARTICLES: VERB_PARTICLES,
    PHRASAL_VERB_PREFIXES: PHRASAL_VERB_PREFIXES,
    PHRASAL_SUBJECT_MODALS: PHRASAL_SUBJECT_MODALS,
    PHRASAL_OBJECT_SUFFIXES: PHRASAL_OBJECT_SUFFIXES,
    PHRASAL_PARTICLE_SUFFIXES: PHRASAL_PARTICLE_SUFFIXES,
    PHRASAL_SUFFIXES: PHRASAL_SUFFIXES,
    PHRASAL_UP_OBJECTS: PHRASAL_UP_OBJECTS,
    PARTICIPLE_OBJECTS: PARTICIPLE_OBJECTS,
    PERFECT_PREFIXES: PERFECT_PREFIXES,
    GERUND_WITH_PREFIXES: GERUND_WITH_PREFIXES,
    PARTICIPLE_MODIFIERS: PARTICIPLE_MODIFIERS,
    PARTICIPLE_FRAME_PREFIXES: PARTICIPLE_FRAME_PREFIXES,
    PARTICIPLE_FRAME_SUFFIXES: PARTICIPLE_FRAME_SUFFIXES,
    EXPLETIVE_DETERMINER_PREFIXES: EXPLETIVE_DETERMINER_PREFIXES,
    EXPLETIVE_DETERMINER_SUFFIXES: EXPLETIVE_DETERMINER_SUFFIXES,
    MASS_NOUN_PREFIXES: MASS_NOUN_PREFIXES,
    FORCEFUL_ACTIONS: FORCEFUL_ACTIONS,
    INTERJECTION_SUFFIXES: INTERJECTION_SUFFIXES,
    SIMILE_PREFIXES: SIMILE_PREFIXES,
    AS_FUCK_ADJECTIVES: AS_FUCK_ADJECTIVES,
    AS_SHIT_ADJECTIVES: AS_SHIT_ADJECTIVES,
    SHARED_MODIFIERS: SHARED_MODIFIERS,
    SHARED_STATES: SHARED_STATES,
    INTENSIFIED_BARE_NOUNS: INTENSIFIED_BARE_NOUNS,
    INTENSIFIED_BARE_PREDICATES: INTENSIFIED_BARE_PREDICATES,
    INTENSIFIED_TRAILING_WORDS: INTENSIFIED_TRAILING_WORDS,
    VALIDATED_INTENSIFIER_SUFFIXES: VALIDATED_INTENSIFIER_SUFFIXES,
    RARE_INTENSIFIER_SUFFIXES: RARE_INTENSIFIER_SUFFIXES,
    INTENSIFIER_MODIFIERS: INTENSIFIER_MODIFIERS,
    NEGATED_DO_PREFIXES: NEGATED_DO_PREFIXES,
    INTENSIFIED_ADJECTIVES: INTENSIFIED_ADJECTIVES,
    SAFE_INTENSIFIER_PREFIXES: SAFE_INTENSIFIER_PREFIXES,
    EVALUATIVE_NOUN_PREFIXES: EVALUATIVE_NOUN_PREFIXES,
    EVALUATIVE_NOUN_SUFFIXES: EVALUATIVE_NOUN_SUFFIXES,
    INTENSIFIER_DETERMINERS: INTENSIFIER_DETERMINERS,
    INTENSIFIED_NOUNS: INTENSIFIED_NOUNS,
    INTENSIFIER_COPULAS: INTENSIFIER_COPULAS,
    INTENSIFIED_PREDICATES: INTENSIFIED_PREDICATES,
    EMPHATIC_SUBJECTS: EMPHATIC_SUBJECTS,
    EMPHATIC_BASE_ACTIONS: EMPHATIC_BASE_ACTIONS,
    EMPHATIC_ACTIONS: EMPHATIC_ACTIONS,
    EMPHATIC_AUXILIARIES: EMPHATIC_AUXILIARIES,
    EMPHATIC_AUXILIARY_ACTIONS: EMPHATIC_AUXILIARY_ACTIONS,
    NUMBER_WORD_PATTERN: NUMBER_WORD_PATTERN,
    NUMBER_PATTERN: NUMBER_PATTERN,
    NUMBER: NUMBER,
    COUNT_UNIT: COUNT_UNIT,
    CONTINUING_PREFIX_SETS: CONTINUING_PREFIX_SETS
  });
  var exports = Object.freeze(Object.assign({
    ALLOWED_WORDS: ALLOWED_WORDS,
    RULE_WORDS: RULE_WORDS,
    WORD_ROLES: WORD_ROLES
  }, vocabulary));

  root.UncensoredRuleDataParts = root.UncensoredRuleDataParts || {};
  root.UncensoredRuleDataParts.language = exports;
  if (typeof module === "object" && module.exports) module.exports = exports;
})();
