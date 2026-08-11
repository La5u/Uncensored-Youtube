(function buildRulePriors() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  // [word, probability, top-two margin, support].
  var CANDIDATE_PRIORS = Object.freeze({
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


  var exports = CANDIDATE_PRIORS;

  root.UncensoredRuleDataParts = root.UncensoredRuleDataParts || {};
  root.UncensoredRuleDataParts.priors = exports;
  if (typeof module === "object" && module.exports) module.exports = exports;
})();
