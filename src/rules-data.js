(function buildRuleData() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var parts = root.UncensoredRuleDataParts;

  if (typeof require === "function") {
    parts = {
      language: require("./rule-data/language"),
      exact: require("./rule-data/exact"),
      grammar: require("./rule-data/grammar")
    };
  }

  // [word, probability, top-two margin, support].
  var CANDIDATE_PRIORS = Object.freeze({
    "[__] awesome": ["fucking", 0.9286, 0.9286, 42],
    "[__] nothing": ["fucking", 0.8333, 0.7333, 30],
    "[__] out of here": ["fuck", 0.9677, 0.9355, 31],
    "[__] out of me": ["shit", 0.9722, 0.9444, 36],
    "[__] out of them": ["shit", 1, 1, 2],
    "[__] that guy": ["fuck", 1, 1, 22],
    "[__] this guy": ["fuck", 1, 1, 3],
    "[__] thing": ["fucking", 0.9118, 0.8529, 34],
    "<base-verb prefix> [__] <verb particle>": ["fuck", 0.956, 0.9505, 182],
    "<base-verb question> [__] <verb particle>": ["fuck", 1, 1, 10],
    "<contracted future subject> [__] <phrasal-particle suffix>": ["fuck", 1, 1, 3],
    "<intensifier modifier> [__] <intensified adjective>": ["fucking", 0.9961, 0.9961, 254],
    "<number> [__] <count unit>": ["fucking", 1, 1, 28],
    "<participle-frame prefix> [__] <participle-frame suffix>": ["fucked", 1, 1, 15],
    "<phrasal-verb prefix> [__] <phrasal-verb suffix>": ["fuck", 1, 1, 15],
    "all [__] up": ["fucked", 1, 1, 26],
    "all that [__]": ["shit", 0.9, 0.8, 10],
    "an [__]": ["asshole", 0.9777, 0.9609, 179],
    "any of this [__]": ["shit", 0.8947, 0.8421, 19],
    "are you [__] me": ["shitting", 1, 1, 2],
    "beating the [__] out": ["shit", 0.9091, 0.8182, 11],
    "cluster [__]": ["fuck", 1, 1, 15],
    "get the [__] ": ["fuck", 0.8858, 0.7991, 219],
    "going to be a [__]": ["fucking", 0.9167, 0.8333, 12],
    "how the [__]": ["fuck", 0.913, 0.8261, 23],
    "I [__] it up": ["fucked", 0.8, 0.6, 35],
    "I [__] up": ["fucked", 0.8636, 0.7273, 44],
    "is [__] up": ["fucked", 0.8667, 0.8, 15],
    "just [__] around": ["fucking", 1, 1, 2],
    "kick the [__] out": ["shit", 1, 1, 20],
    "scare the [__] out": ["shit", 1, 1, 2],
    "sick [__].": ["fuck", 1, 1, 2],
    "there's a [__] ": ["fucking", 0.96, 0.92, 25],
    "they're [__] up": ["fucking", 1, 1, 2],
    "this was a [__]": ["fucking", 1, 1, 2],
    "to [__] on": ["shit", 0.9286, 0.9286, 14],
    "was [__] up": ["fucked", 0.9286, 0.9286, 14],
    "watch this [__]": ["shit", 0.8649, 0.7838, 37],
    "we [__] up": ["fucked", 0.9167, 0.8333, 12],
    "what the [__]": ["fuck", 0.9119, 0.8821, 772],
    "who the [__]": ["fuck", 0.9268, 0.8537, 41],
    "why the [__]": ["fuck", 1, 1, 42]
  });

  var exports = Object.freeze({
    ALLOWED_WORDS: parts.language.ALLOWED_WORDS,
    NOT_CENSORED_WORDS: parts.language.NOT_CENSORED_WORDS,
    RULE_WORDS: parts.language.RULE_WORDS,
    CANDIDATE_PRIORS: CANDIDATE_PRIORS,
    WORD_ROLES: parts.language.WORD_ROLES,
    RULE_GROUPS: Object.freeze({
      exact: parts.exact,
      productive: parts.grammar.productive,
      frames: parts.grammar.frames,
      lowConfidence: parts.grammar.lowConfidence,
      fallback: parts.grammar.fallback
    }),
    CONTINUING_PREFIX_SETS: parts.language.CONTINUING_PREFIX_SETS
  });

  root.UncensoredRuleData = exports;
  if (typeof module === "object" && module.exports) module.exports = exports;
})();
