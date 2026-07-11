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
    "bitch",
    "bitches",
    "twat",
    "moron",
    "bullshit",
    "fucker",
    "fuckers",
    "motherfucker",
    "cocksucker",
    "fucked",
    "pussy",
    "cock",
    "arsehole",
    "asshole",
    "cunt"
  ]);

  var SWEAR_SLOT = Object.freeze({
    INTERJECTION: "[fuck|shit]",
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
  var BE_FORMS = Object.freeze(["is", "was", "were", "I'm", "you're", "he's", "she's", "we're", "they're"]);
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
  var FUCKING_WITH_PREFIXES = Object.freeze(["are you", "I'm", "I'm just", "you're", "who's"]);
  var FUCKED_UP_PREFIXES = Object.freeze(["that's so", "so", "it's so", "really", "massively", "most", "kind of", "special kind of", "too", "real", "completely"]);
  var SHIT_NOUN_PREFIXES = Object.freeze(["full of", "jack", "eat", "beat the", "my own", "taking a", "do some", "cheap", "funny"]);
  var SHIT_OUT_PREFIXES = Object.freeze(["scaring", "scared", "freaked", "freaks", "irritates"]);
  var SHIT_TOGETHER_PREFIXES = Object.freeze(["get your", "get our", "get my", "pull your", "pull my", "got your", "got my"]);
  var SHIT_INITIAL_SUFFIXES = Object.freeze(["quality", "starts getting", "started getting", "hits the fan", "happens", "his pants"]);
  var FUCKING_TRAILING_WORDS = Object.freeze(["kill", "pissed", "serious", "useless", "stupid", "embarrassing", "raw", "crazy", "concentrate", "idiot", "idiots", "nightmare", "terrible", "disgusting", "mental", "joke", "eyes", "ass", "tongue"]);
  var INTERJECTION_PREFIXES = Object.freeze([".", "!", "?", ",", "ah,", "ugh", "damn", "man", "dude", "bro", "yo", "well", "wait", "okay", "ok", "no", "yes", "yeah", "yep"]);
  var INTERJECTION_SUFFIXES = Object.freeze([".", "!", "?", ",", "man", "dude", "bro", "no", "yes", "okay", "wait"]);
  var FUCKING_BEFORE_ANYTHING_PREFIXES = Object.freeze([
    "too",
    "very",
    "actually",
    "literally",
    "basically",
    "completely",
    "totally",
    "seriously",
    "genuinely",
    "properly",
    "straight up",
    "sort of",
    "kinda",
    "sorta",
    "that is",
    "this is",
    "it is",
    "were"
  ]);
  var BULLSHIT_PREFIXES = Object.freeze(["sounds like", "seems like", "feels like", "such", "pure", "corporate", "political", "marketing", "legal", "fake", "made up"]);
  var BULLSHIT_SUFFIXES = Object.freeze(["excuse", "claim", "argument", "reason", "rule", "policy", "explanation", "logic", "system"]);
  var FUCKING_ADVERB_PREFIXES = Object.freeze([
    "no one",
    "do not",
    "don't",
    "don't even",
    "can't even",
    "not",
    "not even",
    "no",
    "I can't",
    "can't",
    "I'm",
    "I'm not",
    "we're",
    "you're",
    "he's",
    "she's",
    "they're",
    "so",
    "you",
    "they",
    "really",
    "how to",
    "to be",
    "my",
    "your",
    "your own",
    "that",
    "it",
    "it's",
    "was"
  ]);
  var FUCKING_INTENSIFIER_PREFIXES = Object.freeze([
    "I",
    "we",
    "me",
    "here",
    "now",
    "right now",
    "yeah",
    "yes",
    "come here",
    "should have",
    "haven't even",
    "doesn't",
    "might",
    "going to",
    "have to",
    "let's",
    "stop"
  ]);
  var FUCKING_NOUN_PREFIXES = Object.freeze([
    "the",
    "of",
    "to",
    "in the",
    "on the",
    "at the",
    "these",
    "all",
    "more",
    "big",
    "great",
    "whole",
    "entire",
    "raw",
    "sticky",
    "lazy",
    "clumsy",
    "thick",
    "complete",
    "absolutely",
    "million",
    "two"
  ]);

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
    ["[fuck]", ["yourself", "this", "me", "off", "it"]],
    [FUCK_UP_VERB_PREFIXES, SWEAR_SLOT.PHRASAL_VERB + " up"],
    [SWEAR_SLOT.PHRASAL_VERB + " up", FUCK_UP_OBJECTS],
    ["to", "[fuck] up"],
    [["got", "get", "getting", "being", "been"], "[fucked] over"],
    "shut the [fuck]",
    [SHIT_OUT_PREFIXES, "the [shit|fuck] out"],
    [["scares", "kick", "smack", "beat"], "the [shit] out"],
    "freaking the [fuck] out",
    [SHIT_TOGETHER_PREFIXES, "[shit] together"],
    "make this [shit] up",
    "made this [shit] up"
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
    "[fuck] all",
    "the [fuck] man",
    "[fuck] is this",
    "this [shit|bullshit].",
    "how [shit|fucked] you are",
    [SHIT_NOUN_PREFIXES, "[shit]"],
    [["piece", "pieces"], "of [shit]"],
    [["fucking", "dog", "horse"], "[shit]"],
    "absolute [shit] show",
    "don't give me [shit] about",
    "miss the [shit] out of",
    "sell the [shit] out of",
    [["tired of your", "tired of this"], "[bullshit|shit]"],
    "bunch of [bullshit|shit|bitches]",
    "stuck up [bitch]",
    "stuck up little [bitch]",
    ["[shit]", SHIT_INITIAL_SUFFIXES],
    "all [shit] themselves",
    "getting the [shit] kicked",

    [["your", "r", "his", "my"], "[shit] together"],
    "that's [fucked|bullshit]",
    "of [fucking] control",
    " [fucking|fuck] around",
    [SUBJECT_PRONOUNS, "[fucked] up"],
    [FUCKED_UP_PREFIXES, "[fucked] up"],
    [THIRD_PERSON_TARGETS, "[fucked] my"],
    [BE_FORMS.concat(["all", "kept", "team", "station", "fish station"]), "[fucked] up"],
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

  var INTENSIFIER_RULE_PATTERNS = Object.freeze([
    "every [fucking] ",
    "good [fucking] ",
    "a [fucking] ",
    "[fucking] pieces of",
    "[fucking] hell",
    [["be", "are you"], "[fucking] kidding"],
    "being [fucking] nonchalant",
    "give me a [fucking] break",
    "god [fucking] dammit",
    "jesus [fucking] christ",
    "that's [fucking] ",
    [FUCKING_INTENSIFIER_PREFIXES, "[fucking] "],
    [FUCKING_ADVERB_PREFIXES, "[fucking] "],
    ["[fucking]", FUCKING_TRAILING_WORDS],
  ]);

  var FALLBACK_SAFE_RULE_PATTERNS = Object.freeze([
    [INTERJECTION_PREFIXES, SWEAR_SLOT.INTERJECTION],
    [SWEAR_SLOT.INTERJECTION, INTERJECTION_SUFFIXES],
    [[".", "!", "?"], "[fuck|shit]."],
    [["ah", "aw", "ahh"], "[shit|fuck]"],
    [["chill", "knocked", "leave me"], "the [fuck]"],
    [["the [fuck]", "right [fuck]"], ["out", "away", "alone"]],
    "super [fucked] up",
    "show some [fucking] respect",
    "sit [fucking] still",
    "as [fuck]",
    // Broad fallbacks: keep these behind specific grammar and idioms.
    "this [shit] is",
    [FUCKING_BEFORE_ANYTHING_PREFIXES, SWEAR_SLOT.INTENSIFIER + " "],
    [FUCKING_NOUN_PREFIXES, "[fucking] "]
  ]);

  var RULE_PATTERNS = Object.freeze([].concat(
    FIXED_IDIOM_RULE_PATTERNS,
    PHRASAL_VERB_RULE_PATTERNS,
    SYNTACTIC_GRAMMAR_RULE_PATTERNS,
    INSULT_NOUN_RULE_PATTERNS,
    INTENSIFIER_RULE_PATTERNS,
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

    var prefixes = Array.isArray(entry[0]) ? entry[0] : [entry[0]];
    var suffixes = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
    var patterns = [];

    prefixes.forEach(function expandPrefix(prefix) {
      suffixes.forEach(function expandSuffix(suffix) {
        patterns.push(joinPattern(prefix, suffix));
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
    var primary = isUppercaseContext(matchedText)
      ? rule.candidates[0].toUpperCase()
      : shouldCapitalizeReplacement(beforeToken)
        ? capitalizeWord(rule.candidates[0])
        : rule.candidates[0];

    if (!/[.!?]$/.test(primary)) {
      primary += punctuationAfterToken(matchedText) ||
        (nextWordIsTitleCase(afterToken) && !/^\s+(?:hell|christ)\b/i.test(afterToken) && !(questionPhraseBeforeToken && pronounAfterToken) ? "." : "");
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
    if (/^\s*(?:hell|christ)\b/i.test(afterToken)) {
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
    applyDeterministicRules: applyDeterministicRules
  });

  root.UncensoredRules = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
