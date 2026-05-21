(function exposeReplacementFormat(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  root.UncensoredReplacementFormat = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function buildReplacementFormat() {
  "use strict";

  var CENSORED_TOKEN_REGEX = /\[\s*__\s*\]/gu;

  function capitalizeWord(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function shouldCapitalizeReplacement(beforeMatch) {
    return /[.!?]\s*$/.test(beforeMatch);
  }

  function nextWordIsTitleCase(afterMatch) {
    var match = afterMatch.match(/^\s*["'(\[]*(?:I\b|[A-Z][a-z]+)/);
    return Boolean(match);
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

    return /[.!?]/.test(punctuation) ? punctuation : "";
  }

  function formatWord(word, beforeMatch, afterMatch, matchedText, allowPunctuation) {
    var formatted = isUppercaseContext(matchedText)
      ? word.toUpperCase()
      : shouldCapitalizeReplacement(beforeMatch)
        ? capitalizeWord(word)
        : word;

    if (allowPunctuation && !/[.!?]$/.test(formatted)) {
      formatted += punctuationAfterToken(matchedText) ||
        (nextWordIsTitleCase(afterMatch) && !/^\s+(?:hell|christ)\b/i.test(afterMatch) ? "." : "");
    }

    return formatted;
  }

  function formatAlternative(primary, alternative, beforeToken, afterToken, matchedText) {
    var formatted = formatWord(alternative, beforeToken, afterToken, matchedText, false);

    if (/^[A-Z]/.test(primary) && /^[a-z]/.test(formatted)) {
      return capitalizeWord(formatted);
    }

    return formatted;
  }

  function formatReplacement(rule, beforeToken, afterToken, matchedText) {
    var primary = formatWord(rule.candidates[0], beforeToken, afterToken, matchedText, true);

    var alternatives = rule.candidates.slice(1).map(function formatAlt(candidate) {
      return formatAlternative(primary, candidate, beforeToken, afterToken, matchedText);
    });

    return {
      word: primary,
      displayWord: alternatives.length ? primary + " (or " + alternatives.join("/") + ")" : primary
    };
  }

  return Object.freeze({
    formatReplacement: formatReplacement
  });
});
