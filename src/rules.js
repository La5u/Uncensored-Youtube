(function buildRules() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;

  var CENSORED_TOKEN = "[__]";
  var CENSORED_TOKEN_REGEX = /\[\s*__\s*\]/gu;
  var SENTENCE_END_REGEX = /[.!?]/;

  // Non-censored words to note: shitty.
  var ALLOWED_WORDS = Object.freeze([
    "fuck",
    "fucks",
    "fuck's",
    "fucking",
    "shit",
    "shithole",
    "shitting",
    "bitch",
    "bitches",
    "twat",
    "moron",
    "bullshit",
    "dipshit", // dipsh?
    "fucker",
    "fuckers",
    "motherfucker",
    "cocksucker",
    "fucked",
    "pussy",
    "cock",
    "cockshit", //cocksh-?
    "arsehole",
    "asshole",
    "cunt",
    "cum",
    "cripple"
  ]);

  var SWEAR_SLOT = Object.freeze({
    INTENSIFIER: "[fucking]",
    NOUN_THING: "[shit|bullshit]",
    VERB: "[fuck]",
    PHRASAL_VERB: "[fuck]",
    INSULT_PERSON: "[bitch|asshole|moron|fucker|cunt]",
    SEXUAL_NOUN: "[cock|pussy]",
    STATE_ADJ: "[fucked]"
  });

  var SUBJECT_PRONOUNS = Object.freeze(["I", "you", "he", "she", "we", "they"]);
  var THIRD_PERSON_TARGETS = Object.freeze(["you", "he", "she", "they"]);
  var BE_FORMS = Object.freeze(["is", "was", "were", "I'm", "he's", "she's", "we're", "they're"]);
  var QUESTION_WORDS = Object.freeze(["what", "how", "where", "when", "who", "why"]);
  var FUCK_THE_SUFFIXES = Object.freeze(["up", "is", "are", "did", "do", "does", "am", "on", "you", "was", "were", "say", "want", "know", "can", "have", "outta"]);
  var FUCK_YOU_PREFIXES = Object.freeze([".", "!", "?", "and", "or", "yeah", "yeah,", "oh", "oh,", "no", "no,", "so", "dude", "dude,", "big"]);
  var FUCK_VERB_PREFIXES = Object.freeze(["I can", "can I", "wanting to", "wanted to", "wants to", "would rather", "would you rather", "would you rather we", "do you want to"]);
  var FUCK_UP_VERB_PREFIXES = Object.freeze([
    "don't",
    "do not",
    "didn't",
    "did not",
    "can't",
    "cannot",
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
    "you will"
  ]);
  var FUCK_UP_OBJECTS = Object.freeze([
    "this",
    "that",
    "it",
    "everything",
    "my life",
    "your life",
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
  var FUCKED_UP_PREFIXES = Object.freeze(["that's so", "so", "it's so", "really", "massively", "most", "kind of", "special kind of", "too", "real", "completely"]);
  var SHIT_NOUN_PREFIXES = Object.freeze(["full of", "jack", "eat", "beat the", "my own", "taking a", "do some", "cheap", "funny"]);
  var SHIT_OUT_PREFIXES = Object.freeze(["scaring", "scared", "freaked", "freaks", "irritates"]);
  var SHIT_TOGETHER_PREFIXES = Object.freeze(["get your", "get our", "get my", "pull your", "pull my", "got your", "got my"]);
  var SHIT_INITIAL_SUFFIXES = Object.freeze(["quality", "starts getting", "started getting", "hits the fan", "happens", "his pants"]);
  var FUCKING_TRAILING_WORDS = Object.freeze(["pissed", "useless", "stupid", "embarrassing", "raw", "concentrate", "idiot", "idiots", "nightmare", "terrible", "disgusting", "mental", "joke", "eyes", "tongue"]);
  var FUCKING_VERB_SUBJECTS = Object.freeze(SUBJECT_PRONOUNS.concat(["it", "no one", "nobody", "someone", "everybody"]));
  var FUCKING_VERBS = Object.freeze(["care", "dare", "did", "does", "hate", "jump", "kills", "knew", "know", "knows", "love", "need", "needs", "sucks", "told", "understand"]);
  var FUCKING_AUXILIARIES = Object.freeze(["can't", "can't even", "cannot", "couldn't", "didn't", "do not", "does not", "don't", "don't even", "doesn't", "haven't even", "let's", "shouldn't", "won't", "wouldn't"]);
  var FUCKING_BASE_VERBS = Object.freeze(["breathe", "care", "dare", "defrosted", "die", "do", "end", "get", "go", "know", "launch", "lie", "like", "move", "need", "redo", "stop", "suck", "touch", "understand", "work"]);
  var FUCKING_ADJECTIVE_PREFIXES = Object.freeze(["I'll be", "I'm", "you're", "he's", "she's", "we're", "they're", "it is", "that is", "this is", "are you", "is so", "I'm so", "you're so", "so", "really", "virtually"]);
  var FUCKING_ADJECTIVES = Object.freeze(["close", "confused", "cool", "dead", "done", "easy", "fast", "great", "happy", "hard", "high", "hot", "impossible", "insane", "nuts", "random", "sick", "smooth", "sorry", "tired"]);
  // Broad prefixes retained only when the full OpenSubtitles corpus had no errors.
  var SAFE_FUCKING_PREFIXES = Object.freeze(["absolutely", "can't even", "completely", "doesn't", "don't even", "entire", "genuinely", "great", "here", "million", "should have", "straight up", "that is", "they're", "this is"]);
  var BULLSHIT_PREFIXES = Object.freeze(["sounds like", "seems like", "feels like", "such", "pure", "corporate", "political", "marketing", "legal", "fake", "made up"]);
  var BULLSHIT_SUFFIXES = Object.freeze(["excuse", "claim", "argument", "reason", "rule", "policy", "explanation", "logic", "system"]);

  var FIXED_IDIOM_RULE_PATTERNS = Object.freeze([
    "no [shit].",
    [["start with this", "start this"], "[bullshit]"],
    "what is this [shit|bullshit]",
    "oh god oh [fuck]",
    [["fancy", "basic", "holy", "oh"], "[shit|fuck]"],
    "this [shit] happened",
    "all the [fucking] time",
    "all the [shit]",
    [["none of that", "that kind of", "this kind of", "this type of", "that type of"], "[shit]"],
    [["a load", "a crock", "pile", "sack"], "of [shit]"],
    "the actual [fuck]",
    "what in the [fuck]",
    "what is that [shit]",
    "you look like [shit]",
    "you don't know [shit]",
    "I can't see [shit]",
    "cut the [bullshit|shit]",
    [["lose your", "lose my"], "[shit]"],
    "enough of this [bullshit|shit]",
    "zero [fucking] deaths",
    "pure [fucking] respect",
    "piece of [fucking] ass",
    "apply that [shit]",
    ["I", "[shit]", ["my", "in my"]],
    "load of [shit]",
    [["live for", "redoing", "struggle at"], "this [shit]"],
    "respect women and [shit]",
    "all this [shit] again",
    "delete your [shit]",
    "pathetic little [moron]",
    "good [shit].",
    [["give a", "gives a"], "[fuck|shit]"],
    "bull [fucking] [shit]",
    "dumb [fuck|shit]",
    "this is some [bullshit]",
    [BULLSHIT_PREFIXES, "[bullshit]"],
    ["[bullshit]", BULLSHIT_SUFFIXES],
    "that [shit|bullshit].",
    "zero [fucks]"
  ]);

  var PHRASAL_VERB_RULE_PATTERNS = Object.freeze([
    "want to [fuck] ",
    "try to [fuck] ",
    "better not [fuck] things up",
    [FUCKING_WITH_PREFIXES, "[fucking] with"],
    [["dream about", "dream of"], "[fucking] "],
    [SUBJECT_PRONOUNS, "[fucked] it up"],
    [["was", "were"], "[fucked] with"],
    "don't you [fuck] with",
    "don't [fuck] with",
    [["have", "has", "had"], "[fucked]", ["it", "me"]],
    [["am", "is", "are", "was", "were"], "[fucking] it"],
    [["is", "was", "keeps"], "[fucking] me"],
    "good at [fucking] it",
    [["will", "can", "to"], "[fuck]", ["it", "me"]],
    "almost [fucked] me",
    ["[fuck]", ["yourself", "off"]],
    "[fuck|shit|bullshit|fucked] this",
    "[fuck|fucking|fucked] me",
    "[fuck|fucking|fucked|shit|bullshit|bitch] it",
    [FUCK_UP_VERB_PREFIXES, SWEAR_SLOT.PHRASAL_VERB + " up"],
    [FUCK_UP_VERB_PREFIXES, FUCK_UP_PRONOUN_SUFFIXES],
    [["make", "let", "help"], "you [fuck] up"],
    [SWEAR_SLOT.PHRASAL_VERB + " up", FUCK_UP_OBJECTS],
    ["to", "[fuck] up"],
    [PERFECT_PREFIXES, "[fucked] up"],
    [["keep", "keeps", "stop", "stopped"], "[fucking] up"],
    "kept [fucking|fucked] up",
    "you are [fucking] up",
    "you're [fucking|fucked] up",
    ["go", "[fuck]", ["yourself", "himself", "herself", "themselves"]],
    [["[fuck] you"], ["man", "game", "link", "piece of", "Jesus", "Jimmy", "everyone"]],
    "get [fucked] by",
    "you're getting [fucked] now",
    [["got", "get", "getting", "being", "been"], "[fucked] over"],
    "can get [fucked].",
    "let's get [fucked] up",
    [["we are", "we're", "is so", "I'm so", "you're so"], "[fucked]."],
    "shut the [fuck]",
    [SHIT_OUT_PREFIXES, "the [shit|fuck] out"],
    [["scares", "kick", "smack", "beat"], "the [shit] out"],
    "freaking the [fuck] out",
    [SHIT_TOGETHER_PREFIXES, "[shit] together"],
    [["make", "made"], "this [shit] up"]
  ]);

  var SYNTACTIC_GRAMMAR_RULE_PATTERNS = Object.freeze([
    "whatever the [fuck]",
    ["the [fuck]", FUCK_THE_SUFFIXES],
    ["get the [fuck]", ["away", "out", "outta", "down", "back", "over"]],
    [["sit", "calm", "slow", "stay"], "the [fuck] down"],
    "stay the [fuck] back",
    "the [fuck's] going on",
    "so the [fuck] what",
    "[fuck's] sake",
    [QUESTION_WORDS, "the [fuck]"],
    "did you just [fucking] call",
    [FUCK_YOU_PREFIXES, "[fuck] you"],
    [FUCK_VERB_PREFIXES, "[fuck] "],
    ["[fuck]", ["yeah."]],
    "flying [fuck]",
    "[fuck|shit|cock] all",
    "the [fuck] man",
    "[fuck] is this",
    "this [shit|bullshit].",
    "how [shit|fucked] you are",
    [SHIT_NOUN_PREFIXES, "[shit]"],
    [["piece", "pieces"], "of [shit]"],
    [["fucking", "dog", "horse"], "[shit]"],
    "absolute [shit] show",
    "don't give me [shit] about",
    [["miss", "sell"], "the [shit] out of"],
    [["tired of your", "tired of this"], "[bullshit|shit]"],
    "bunch of [bullshit|shit|bitches]",
    [["stuck up", "stuck up little"], "[bitch]"],
    ["[shit]", SHIT_INITIAL_SUFFIXES],
    "all [shit] themselves",
    "getting the [shit] kicked",

    [["your", "r", "his", "my"], "[shit] together"],
    "that's [fucked|bullshit]",
    "of [fucking] control",
    [["I", "he", "she", "we", "they"], "[fucked] up"],
    "you [fucked|fuck|fucking] up",
    [FUCKED_UP_PREFIXES, "[fucked] up"],
    [THIRD_PERSON_TARGETS, "[fucked] my"],
    [BE_FORMS.concat(["all", "team", "station", "fish station"]), "[fucked] up"],
    "re [fucked]."
  ]);

  var INSULT_NOUN_RULE_PATTERNS = Object.freeze([
    "wish a [bitch] would",
    "your [cock] shouldn't",
    "son of a [bitch]",
    "sons of [bitches]",
    "[bitch] and moan",
    "an [asshole|arsehole]",
    "sick [fuck|fucker].",
    "don't be a [pussy|bitch]",
    "come on, you [bitch]",
    [["am I the", "not the", "you are the", "call them a"], "[asshole]"]
  ]);

  var FUCKING_RULE_PATTERNS = Object.freeze([
    // Fixed expressions.
    "oh my [fucking] god",
    ["god", "[fucking]", ["damn it", "dammit", "damn"]],
    "jesus [fucking] christ",
    "swear to [fucking] god",
    "the last [fucking] time",
    "give me a [fucking] break",
    "[fucking] pieces of",
    [["be", "are you"], "[fucking] kidding"],

    // Verbs and commands.
    "I'll [fucking] do it",
    "just [fucking] do it",
    "I didn't [fucking] do it",
    ["just", "[fucking]", ["tell me", "tell us"]],
    ["I'll", "[fucking]", ["show you", "take the", "gut you"]],
    "I'm gonna [fucking] murder you",
    [FUCKING_VERB_SUBJECTS, "[fucking]", FUCKING_VERBS],
    [["I", "we", "they", "he"], "[fucking] do"],
    "you [fucking] do well",
    [["I", "we", "you", "she"], "[fucking] got"],
    ["I", "[fucking]", ["get", "work"]],
    "it [fucking] works",
    [FUCKING_AUXILIARIES, "[fucking]", FUCKING_BASE_VERBS],
    "have to [fucking] redo",
    "does not [fucking] ever end",
    "does this level [fucking] ever end",
    "can you [fucking] stop",
    ["just", "[fucking]", ["die", "snorted"]],
    "that [fucking] kills",
    "[fucking] unsubscribe",

    // Adjectives and adverbs.
    "being [fucking] nonchalant",
    [["are you", "I'm", "you're", "he's", "she's"], "[fucking] serious"],
    [FUCKING_ADJECTIVE_PREFIXES, "[fucking]", FUCKING_ADJECTIVES],
    [["goddamn", "god damn"], "[fucking] hot"],
    "that was [fucking] smooth",
    "I'll be [fucking] annoyed",
    "it's [fucking] impossible",
    "going to be [fucking] easy",
    "look how [fucking] far",
    "just [fucking] great",
    "not [fucking] funny",
    "a [fucking] dead",
    "[fucking] cancerous",
    "right [fucking] there",

    // Objects, people, places, and quantities.
    [["open", "shut"], "the [fucking] door"],
    [["get in", "stop"], "the [fucking] car"],
    [["get on", "stay on"], "the [fucking] ground"],
    [["get your", "keep your"], "[fucking] hands off"],
    "shut your [fucking] mouth",
    "do your [fucking] job",
    [["where's my", "where's the"], "[fucking] money"],
    ["every", "[fucking]", ["time", "day"]],
    [["goddamn", "god damn"], "[fucking] light"],
    "the [fucking] lights",
    "my [fucking] toes",
    "smallest [fucking] mouse",
    "no [fucking] space",
    "what a [fucking] load of",
    ["[fucking]", ["speedrun", "tail", "ripper"]],
    "that [fucking] place",
    "[fucking] speedun",
    "[fucking] piece of",
    "you [fucking] god",
    "no [fucking] sense",
    [["my", "where's my"], "[fucking] checkpoint"],
    [["my", "give me my"], "[fucking] lives"],
    "the [fucking] light",
    [["the", "this"], "[fucking]", ["level", "jump", "thing", "game", "hand", "sword", "cat", "boar", "fish"]],
    [["the", "these"], "[fucking]", ["places", "guys"]],
    "these [fucking] people",
    [["a", "this"], "[fucking]", ["rhythm game", "platform", "pig"]],
    "40 [fucking] minutes",
    "three [fucking] years",
    "500 [fucking] times",

    // Corpus-validated broad fallbacks stay last.
    [SAFE_FUCKING_PREFIXES, "[fucking] "],
    ["[fucking]", FUCKING_TRAILING_WORDS],
  ]);

  var FALLBACK_SAFE_RULE_PATTERNS = Object.freeze([
    [["chill", "knocked", "leave me"], "the [fuck]"],
    [["the [fuck]", "right [fuck]"], ["out", "away", "alone"]],
    "super [fucked] up",
    "show some [fucking] respect",
    "sit [fucking] still",
    "as [fuck]",
    // Broad fallbacks: keep these behind specific grammar and idioms.
    "this [shit] is"
  ]);

  var RULE_PATTERNS = Object.freeze([].concat(
    FIXED_IDIOM_RULE_PATTERNS,
    PHRASAL_VERB_RULE_PATTERNS,
    SYNTACTIC_GRAMMAR_RULE_PATTERNS,
    INSULT_NOUN_RULE_PATTERNS,
    FUCKING_RULE_PATTERNS,
    FALLBACK_SAFE_RULE_PATTERNS
  ));

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

  var DETERMINISTIC_RULES = Object.freeze(RULE_PATTERNS.flatMap(expandPatternEntry).map(pattern));

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
        (nextWordIsTitleCase(afterToken) && !/^\s+(?:hell|christ|god)\b/i.test(afterToken) && !(questionPhraseBeforeToken && pronounAfterToken) ? "." : "");
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
      regex: new RegExp((startsWithPunctuation ? "()" : "(^|[^\\p{L}\\p{N}_])") + "(" + escaped + ")" + (endsWithSpace ? "" : "(?=$|[^\\p{L}\\p{N}_])"), "giu")
    };
  }

  var COMPILED_RULES = DETERMINISTIC_RULES.map(compileRule);

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

  var RULE_TRIE = buildRuleTrie(COMPILED_RULES);

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
    });
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

    candidateRulesForText(normalizedText).forEach(function applyRule(compiled) {
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
