(function exposeRules(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./rule-data"), require("./replacement-format"));
    return;
  }

  root.UncensoredRules = factory(root.UncensoredRuleData, root.UncensoredReplacementFormat);
})(typeof globalThis !== "undefined" ? globalThis : this, function buildRules(ruleData, replacementFormat) {
  "use strict";

  var CENSORED_TOKEN = "[__]";
  var CENSORED_TOKEN_REGEX = /\[\s*__\s*\]/gu;
  var ALLOWED_WORDS = ruleData.ALLOWED_WORDS;
  var DETERMINISTIC_RULES = ruleData.DETERMINISTIC_RULES;

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function compileRule(rule) {
    var endsWithSpace = /\s$/.test(rule.template);
    var escaped = escapeRegExp(rule.template)
      .replace(/\\\[__\\\]/g, "\\[__\\]")
      .replace(/'/g, "['\u2019]")
      .replace(/ /g, "\\s+");

    return {
      rule: rule,
      regex: new RegExp("(^|[^\\p{L}\\p{N}_])(" + escaped + ")" + (endsWithSpace ? "" : "(?=$|[^\\p{L}\\p{N}_])"), "giu")
    };
  }

  var COMPILED_RULES = DETERMINISTIC_RULES.map(compileRule);

  function findTokenRange(value) {
    CENSORED_TOKEN_REGEX.lastIndex = 0;
    var match;
    var firstMatch = null;
    var lastMatch = null;
    var count = 0;

    while ((match = CENSORED_TOKEN_REGEX.exec(value)) !== null) {
      if (!firstMatch) {
        firstMatch = match;
      }

      lastMatch = match;
      count += 1;
    }

    if (!firstMatch || !lastMatch) {
      return null;
    }

    if (lastMatch && /[.!?]/.test(value.charAt(lastMatch.index + lastMatch[0].length))) {
      lastMatch = {
        index: lastMatch.index,
        0: lastMatch[0] + value.charAt(lastMatch.index + lastMatch[0].length)
      };
    }

    return {
      start: firstMatch.index,
      end: lastMatch.index + lastMatch[0].length,
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
      var afterToken = text.slice(offset + token.length);

      if (/^\s*[.!?]/.test(afterToken) || !nextTextStartsSentence(afterToken)) {
        return token;
      }

      return token + ".";
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

    COMPILED_RULES.forEach(function applyRule(compiled) {
      var match;

      compiled.regex.lastIndex = 0;

      while ((match = compiled.regex.exec(normalizedText)) !== null) {
        var fullMatch = match[0];
        var prefix = match[1];
        var matchedText = match[2];
        var matchStart = match.index + prefix.length;
        var matchEnd = match.index + fullMatch.length;
        var tokenRange = findTokenRange(matchedText);

        if (!tokenRange || occupiedRanges.some(function overlaps(range) {
          return matchStart < range.end && matchEnd > range.start;
        })) {
          continue;
        }

        var tokenStart = matchStart + tokenRange.start;
        var tokenEnd = matchStart + tokenRange.end;

        if (/[.!?]/.test(normalizedText.charAt(tokenEnd))) {
          tokenEnd += 1;
        }

        if (tokenRange.count === 1 && isAdjacentToCensoredToken(normalizedText, tokenStart, tokenEnd)) {
          continue;
        }

        var beforeToken = normalizedText.slice(0, tokenStart);
        var afterToken = normalizedText.slice(tokenEnd);

        var formatted = replacementFormat.formatReplacement(compiled.rule, beforeToken, afterToken, matchedText);

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
          start: matchStart,
          end: matchEnd
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

  return Object.freeze({
    CENSORED_TOKEN: CENSORED_TOKEN,
    CENSORED_TOKEN_REGEX: CENSORED_TOKEN_REGEX,
    ALLOWED_WORDS: ALLOWED_WORDS,
    DETERMINISTIC_RULES: DETERMINISTIC_RULES,
    normalizeCensoredTokens: normalizeCensoredTokens,
    hasCensoredToken: hasCensoredToken,
    applyDeterministicRules: applyDeterministicRules
  });
});
