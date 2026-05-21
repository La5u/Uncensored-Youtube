(function exposeRuleData(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.UncensoredRuleData = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function buildRuleData() {
  "use strict";

  var ALLOWED_WORDS = Object.freeze([
    "fuck",
    "fuck's",
    "fucking",
    "shit",
    "bitch",
    "bitches",
    "fag",
    "twat",
    "moron",
    "bullshit",
    "fucker",
    "fuckers",
    "motherfucker",
    "fucked",
    "pussy",
    "cock",
    "arsehole",
    "asshole",
    "cunt"
  ]);

  function rule(template) {
    return Object.freeze({
      template: template,
      candidates: Object.freeze(Array.prototype.slice.call(arguments, 1))
    });
  }

  function prefixedRules(prefix, words, replacement) {
    return words.map(function createPrefixedRule(word) {
      return rule(prefix + " " + word, replacement);
    });
  }

  var FUCKING_SUFFIXES = Object.freeze([
    "kill",
    "know",
    "call",
    "pissed",
    "serious",
    "defrosted",
    "cool",
    "stupid",
    "awful",
    "embarrassing",
    "crazy",
    "amazing",
    "raw",
    "rules",
    "slob",
    "losers",
    "rad",
    "bored",
    "terrified",
    "dead",
    "cold",
    "murdered",
    "brilliant",
    "quiet",
    "creeping",
    "threaten",
    "understand",
    "concentrate",
    "confused",
    "useless",
    "idiots",
    "care",
    "game",
    "being",
    "clever", "eyes", "ass", "tongue"
  ]);

  var DETERMINISTIC_RULES = Object.freeze([
    rule("holy [__]", "shit", "fuck"),
    rule("give a [__]", "fuck", "shit"),
    rule("gives a [__]", "fuck", "shit"),
    rule("that's [__]", "fucked", "bullshit"),
    rule("every [__] time", "fucking"),
    rule("bull [__] [__]", "fucking shit"),
    rule("the [__] up", "fuck"), // both for wake the fuck up and shut the fuck up
    rule("of [__] control", "fucking"),
    rule("get the [__] away", "fuck"),
    rule("get the [__] out", "fuck"),
    rule("good [__] question", "fucking"),
    rule("to [__].", "shit"),
    rule("no one [__] ", "fucking"),
    rule("do not [__] ", "fucking"),
    rule("don't [__] ", "fucking"),
    rule("I'm not [__]", "fucking"),

    rule("[__] up", "fucked"),
    rule("dumb [__]", "fuck", "shit"),
    rule("oh [__].", "shit", "fuck"),

    rule("full of [__]", "shit"),
    rule("jack [__]", "shit"),
    rule("an [__]", "asshole", "arsehole"),
    rule("[__] sake", "fuck's"),
    rule("[__] yeah", "fuck"),
    rule("[__] you.", "fuck"),
    rule("[__] yourself", "fuck"),
    rule("[__] me", "fuck"),
    rule("[__] off", "fuck"),
    rule("[__] it", "fuck"),
    rule("sick [__].", "fuck"),
    rule("what the [__]", "fuck"),
    rule("how the [__]", "fuck"),
    rule("where the [__]", "fuck"),
    rule("what in the [__]", "fuck"),
    rule("what is that [__]", "shit"),
    rule("how [__] you are", "shit"),
    rule("who the [__]", "fuck"),
    rule("as [__]", "fuck"),
    rule("piece of [__]", "shit"),
    rule("eat [__]", "shit"),
    rule("scared the [__] out of", "shit", "fuck"),
    rule("son of a [__]", "bitch"),
    rule("[__] and moan", "bitch"),
    rule("sons of [__]", "bitches"),
    rule("[__] hell", "fucking"),
    rule("bunch of [__]", "bullshit", "shit", "bitches"),

    rule("god [__] dammit", "fucking"),
    rule("do [__] all", "fuck"),

    rule("beat the [__]", "shit"),
    rule("[__] starts getting", "shit"),
    rule("[__]. starts getting", "shit"),
    rule("[__] started getting", "shit"),
    rule("[__]. started getting", "shit"),
    rule("[__] hits the fan", "shit"),
    rule("jesus [__] christ", "fucking"),
    rule("[__] with", "fuck"),
    rule("really [__] ", "fucking"),
    rule("so [__] ", "fucking"),
    rule("oh, [__]", "fuck"),
    rule("get [__]", "fucked"),
    rule("you [__] ", "fucking"),
    rule("a [__] ", "fucking")
  ].concat(prefixedRules("[__]", FUCKING_SUFFIXES, "fucking")));

  return Object.freeze({
    ALLOWED_WORDS: ALLOWED_WORDS,
    DETERMINISTIC_RULES: DETERMINISTIC_RULES
  });
});
