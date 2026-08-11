(function buildRuleData() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var parts = root.UncensoredRuleDataParts;

  if (typeof require === "function") {
    parts = {
      language: require("./rule-data/language"),
      exact: require("./rule-data/exact"),
      grammar: require("./rule-data/grammar"),
      priors: require("./rule-data/priors")
    };
  }

  var exports = Object.freeze({
    ALLOWED_WORDS: parts.language.ALLOWED_WORDS,
    RULE_WORDS: parts.language.RULE_WORDS,
    CANDIDATE_PRIORS: parts.priors,
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
