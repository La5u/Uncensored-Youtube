(function buildRules() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;

  var compiler = root.UncensoredRuleCompiler ||
    (typeof require === "function" ? require("./rules-compiler") : null);
  var data = root.UncensoredRuleData ||
    (typeof require === "function" ? require("./rules-data") : null);

  if (!compiler || !data) {
    throw new Error("Rule compiler and data must load before rules.js");
  }

  var CENSORED_TOKEN = "[__]";
  var CENSORED_TOKEN_REGEX = /\[\s*__\s*\]/gu;
  var WILDCARD_TOKEN = "*";
  var WILDCARD_REGEX = "\\S+";
  var RULE_WORD_REGEX = /[*]|\[__\]|[\p{L}\p{N}_']+/gu;
  var SENTENCE_END_REGEX = /[.!?]/;
  var QUESTION_PHRASE_REGEX = /(?:whatever|what|how|why|where|who|when)\s+the\s*$/i;
  var PRONOUN_START_REGEX = /^\s*(?:I|you|he|she|they|we|it)\b/;
  var GO_TO_PREFIX_REGEX = /\b(?:go|going|went|gone)\s+to\s*$/i;
  var COMMON_SENTENCE_STARTS = Object.freeze(new Set([
    "a", "an", "and", "are", "as", "at", "be", "because", "but", "by",
    "can", "could", "did", "do", "does", "for", "from", "had", "has",
    "have", "he", "her", "here", "how", "if", "in", "is", "it", "its",
    "may", "might", "my", "no", "not", "of", "oh", "on", "or", "our",
    "she", "should", "so", "that", "the", "their", "then", "there",
    "these", "they", "this", "those", "to", "trying", "was", "we", "were", "what",
    "when", "where", "which", "who", "why", "will", "with", "would", "yes",
    "you", "your"
  ]));
  var ALLOWED_WORDS = data.ALLOWED_WORDS;
  var ALLOWED_WORD_SET = new Set(ALLOWED_WORDS);

  function allowedRule(rule) {
    var candidates = rule.candidates.filter(function allowedCandidate(candidate) {
      return candidate.split(/\s+/u).every(function allowedWord(word) {
        return ALLOWED_WORD_SET.has(word);
      });
    });

    if (candidates.length === rule.candidates.length) return rule;
    return Object.freeze({
      template: rule.template,
      candidates: Object.freeze(candidates)
    });
  }

  function compileAllowedGroups(groups) {
    return Object.freeze(compiler.compileGroups(groups).map(allowedRule)
      .filter(function nonemptyRule(rule) {
        return rule.candidates.length;
      }));
  }

  var EXACT_RULE_COUNT = compileAllowedGroups(data.RULE_GROUPS.exact).length;
  var SPECIFIC_GROUPS = data.RULE_GROUPS.exact.concat(data.RULE_GROUPS.productive);
  var SPECIFIC_RULE_COUNT = compileAllowedGroups(SPECIFIC_GROUPS).length;
  var LOW_CONFIDENCE_GROUPS = data.RULE_GROUPS.lowConfidence || [];
  var FALLBACK_RULE_START = compileAllowedGroups(SPECIFIC_GROUPS.concat(LOW_CONFIDENCE_GROUPS)).length;
  var DETERMINISTIC_RULES = compileAllowedGroups(
    SPECIFIC_GROUPS.concat(LOW_CONFIDENCE_GROUPS, data.RULE_GROUPS.fallback)
  );
  var openEndedPrefixes = DETERMINISTIC_RULES.filter(function openEndedRule(candidate) {
    return /\[__\]\s$/.test(candidate.template);
  }).map(function openEndedPrefix(candidate) {
    return candidate.template.replace(/\[__\]\s$/, "").trim();
  });
  var CONTINUING_PREFIXES = Object.freeze(data.CONTINUING_PREFIX_SETS.reduce(
    function appendContinuingSet(prefixes, values) {
      return prefixes.concat(values);
    },
    openEndedPrefixes
  ).filter(function uniqueNonemptyPrefix(prefix, index, prefixes) {
    return prefix && prefixes.indexOf(prefix) === index;
  }));
  var CONTINUING_PREFIX_REGEX = new RegExp(
    "(^|[^\\p{L}\\p{N}_'’])(?:" + compiler.regexAlternatives(CONTINUING_PREFIXES) + ")\\s*$",
    "iu"
  );

  function capitalizeWord(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function shouldCapitalizeReplacement(beforeMatch) {
    return /[.!?]\s*$/.test(beforeMatch);
  }

  function nextTextStartsSentence(afterToken) {
    var match = /^\s*["'(\[]*([A-Za-z]+)\b/.exec(afterToken);
    var word;

    if (!match) return false;
    word = match[1];
    return COMMON_SENTENCE_STARTS.has(word.toLowerCase()) &&
      (/^[A-Z][a-z]+$/.test(word) ||
        (/^[A-Z]{2,}$/.test(word) && /^\s+[a-z]/.test(afterToken.slice(match[0].length))));
  }

  function nextTextIsTitleCased(afterToken) {
    return /^\s*["'(\[]*(?:I\b|[A-Z][a-z]|[A-Z]{2,}\s+[a-z])/.test(afterToken);
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

  function formatReplacement(word, beforeToken, afterToken, matchedText) {
    var questionPhraseBeforeToken = QUESTION_PHRASE_REGEX.test(beforeToken);
    var pronounAfterToken = PRONOUN_START_REGEX.test(afterToken);
    var primary = (previousWordIsUppercase(beforeToken) || isUppercaseContext(matchedText))
      ? word.toUpperCase()
      : shouldCapitalizeReplacement(beforeToken)
        ? capitalizeWord(word)
        : word;
    // "I" is inherently capitalized, but after a filled exclamation it still
    // reliably begins the next clause and needs display punctuation.

    if (!/[.!?]$/.test(primary)) {
      var newCaptionAfter = /^\s*>>/.test(afterToken) ||
        nextTextStartsSentence(afterToken) || /^\s*I\b/.test(afterToken) ||
        nextTextIsTitleCased(afterToken);
      primary += punctuationAfterToken(matchedText) ||
        (newCaptionAfter && !/^\s*["'(\[]*(?:hell|christ|god)\b/i.test(afterToken) &&
          !phraseContinuesAfterToken(beforeToken) &&
          !(questionPhraseBeforeToken && pronounAfterToken) ? "." : "");
    }

    return primary;
  }

  function compileRule(rule, index) {
    var startsSentence = /^\^/.test(rule.template);
    var endsWithSpace = /\s$/.test(rule.template);
    var endsSentence = /\$$/.test(rule.template);
    var template = rule.template;
    if (startsSentence) template = template.slice(1);
    if (endsSentence) template = template.slice(0, -1);
    var startsWithPunctuation = /^[.!?]/.test(template);
    if (endsWithSpace) template = template.replace(/\s+$/, "");
    var escaped = compiler.escapeRegExp(template)
      .replace(/\\\[__\\\]/g, "\\[__\\]")
      .replace(/'/g, "['\u2019]")
      .replace(/ /g, "\\s+")
      .replace(/\\\*/g, WILDCARD_REGEX);
    var suffix = endsSentence
      ? "(?=[^\\p{L}\\p{N}_'’]*$)"
      : endsWithSpace ? "(?=\\s|$)" : "(?=$|[^\\p{L}\\p{N}_'’])";

    return {
      index: index,
      rule: rule,
      regex: new RegExp((startsSentence ? "(^)" : startsWithPunctuation ? "()" : "(^|[^\\p{L}\\p{N}_'’])") +
        "(" + escaped + ")" +
        suffix, "giu")
    };
  }

  var RULE_ENTRIES = DETERMINISTIC_RULES.map(function createRuleEntry(rule, index) {
    return {
      index: index,
      rule: rule,
      regex: null
    };
  });

  function ensureCompiled(entry) {
    if (!entry.regex) {
      entry.regex = compileRule(entry.rule, entry.index).regex;
    }
    return entry;
  }

  function compileExpressionRule(compiledPattern, index) {
    return {
      index: index,
      rule: compiledPattern.rule,
      regex: new RegExp("(^|[^\\p{L}\\p{N}_'’])(" + compiledPattern.phrase +
        ")(?=$|[^\\p{L}\\p{N}_'’])", "giu")
    };
  }

  // Reusable grammatical slots run after contextual expressions but before
  // broad fallbacks.
  var ROLE_FRAME_PATTERNS = data.RULE_GROUPS.frames.reduce(function collectRoleFrames(patterns, ruleGroup) {
    return patterns.concat(ruleGroup.patterns);
  }, []);
  var COMPILED_ROLE_FRAMES = Object.freeze(ROLE_FRAME_PATTERNS.map(function allowedRoleFrame(patternValue) {
    var compiled = compiler.compileFramePattern(patternValue);
    var rule = allowedRule(compiled.rule);

    return { rule: rule, phrase: compiled.phrase };
  }).map(function compileRoleFrame(patternValue, index) {
    return compileExpressionRule(patternValue, RULE_ENTRIES.length + index);
  }));

  function trieNode() {
    return {
      children: new Map(),
      rules: []
    };
  }

  function ruleWords(text) {
    return normalizeCensoredTokens(text).toLowerCase().replace(/\u2019/g, "'").match(RULE_WORD_REGEX) || [];
  }

  function ruleWordSpans(text) {
    var normalized = normalizeCensoredTokens(text).toLowerCase().replace(/\u2019/g, "'");
    var words = [];
    var spans = [];
    var matcher = RULE_WORD_REGEX;
    var match;

    while ((match = matcher.exec(normalized)) !== null) {
      words.push(match[0]);
      spans.push({ start: match.index, end: match.index + match[0].length });
    }

    return { words: words, spans: spans };
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

  var RULE_TRIE = buildRuleTrie(RULE_ENTRIES);
  var MAX_RULE_WORDS = DETERMINISTIC_RULES.reduce(function longestRule(length, rule) {
    return Math.max(length, ruleWords(rule.template).length);
  }, 0);

  function candidateRuleData(text) {
    var wordData = ruleWordSpans(text);
    var words = wordData.words;
    var spans = wordData.spans;
    var selected = new Map();
    var ranges = new Map();
    var starts = new Set();
    var startIndex;

    words.forEach(function collectBlankStarts(word, wordIndex) {
      if (word !== CENSORED_TOKEN) return;
      for (startIndex = Math.max(0, wordIndex - MAX_RULE_WORDS + 1);
        startIndex <= wordIndex; startIndex += 1) {
        starts.add(startIndex);
      }
    });

    starts.forEach(function scanCandidateStart(startIndex) {
      (function walkRulePath(node, wordIndex) {
        var exact;
        var wildcard;

        if (wordIndex > startIndex) {
          node.rules.forEach(function rememberRule(compiled) {
            selected.set(compiled.index, compiled);
            if (!ranges.has(compiled.index)) ranges.set(compiled.index, []);
            ranges.get(compiled.index).push({
              start: spans[startIndex].start,
              end: spans[wordIndex - 1].end
            });
          });
        }

        if (wordIndex >= words.length) {
          return;
        }

        exact = node.children.get(words[wordIndex]);
        wildcard = node.children.get(WILDCARD_TOKEN);
        if (exact) walkRulePath(exact, wordIndex + 1);
        if (wildcard && wildcard !== exact) walkRulePath(wildcard, wordIndex + 1);
      })(RULE_TRIE, startIndex);
    });

    return {
      rules: Array.from(selected.values()).sort(function sortByRuleOrder(left, right) {
        return left.index - right.index;
      }).map(ensureCompiled),
      ranges: ranges
    };
  }

  function orderCandidateRules(candidates) {
    var lowConfidenceOffset = candidates.findIndex(function isLowConfidence(compiled) {
      return compiled.index >= SPECIFIC_RULE_COUNT;
    });
    var fallbackOffset = candidates.findIndex(function isFallback(compiled) {
      return compiled.index >= FALLBACK_RULE_START;
    });

    lowConfidenceOffset = lowConfidenceOffset < 0 ? candidates.length : lowConfidenceOffset;
    fallbackOffset = fallbackOffset < 0 ? candidates.length : fallbackOffset;
    // Narrow rare-word phrases must beat broad grammatical frames.
    return candidates.slice(0, lowConfidenceOffset)
      .concat(
        candidates.slice(lowConfidenceOffset, fallbackOffset),
        COMPILED_ROLE_FRAMES,
        candidates.slice(fallbackOffset)
      );
  }

  function tierForRule(compiled) {
    if (compiled.index < EXACT_RULE_COUNT) return "exact";
    if (compiled.index < SPECIFIC_RULE_COUNT) return "productive";
    if (compiled.index < FALLBACK_RULE_START) return "low";
    if (compiled.index < RULE_ENTRIES.length) return "fallback";
    return "frame";
  }

  function candidateDecision(rule, policy) {
    var prior;

    if (!rule.candidates.length) return null;
    if (rule.candidates.length === 1) {
      return { word: rule.candidates[0], score: 1, margin: 1, support: 0, source: "rule" };
    }
    if (policy === "first") {
      return { word: rule.candidates[0], score: 0, margin: 0, support: 0, source: "first" };
    }
    if (policy === "abstain") return null;

    prior = data.CANDIDATE_PRIORS[rule.template];
    if (!prior || rule.candidates.indexOf(prior[0]) === -1) return null;

    return {
      word: prior[0],
      score: prior[1],
      margin: prior[2],
      support: prior[3],
      source: "paired"
    };
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

  function phraseContinuesAfterToken(beforeToken) {
    return CONTINUING_PREFIX_REGEX.test(beforeToken);
  }

  function exactRuleContinuesAfterToken(text, tokenStart, tokenEnd, candidateData) {
    var candidates = candidateData.rules || candidateData;

    return candidates.some(function matchesExactContinuation(compiled) {
      var ranges;

      if (compiled.index >= EXACT_RULE_COUNT) return false;
      ranges = candidateData.ranges && candidateData.ranges.get(compiled.index) || [];
      return ranges.some(function checkRange(range) {
        var source;
        var windowStart;
        var match;

        if (range.start > tokenStart || range.end <= tokenEnd) return false;
        windowStart = Math.max(0, range.start - 32);
        source = text.slice(windowStart, Math.min(text.length, range.end + 32));
        compiled.regex.lastIndex = 0;
        while ((match = compiled.regex.exec(source)) !== null) {
          var matchStart = windowStart + match.index + match[1].length;
          var matchEnd = matchStart + match[2].length;
          if (matchStart <= tokenStart && matchEnd > tokenEnd) return true;
        }
        return false;
      });
    });
  }

  function insertVirtualSentencePunctuation(text) {
    var exactCandidateData;

    return text.replace(CENSORED_TOKEN_REGEX, function punctuateToken(token, offset) {
      var beforeToken = text.slice(0, offset);
      var afterToken = text.slice(offset + token.length);

      if (/^\s*[.!?]/.test(afterToken)) {
        return token;
      }

      if (QUESTION_PHRASE_REGEX.test(beforeToken) && PRONOUN_START_REGEX.test(afterToken)) {
        return token;
      }

      // A title-cased destination is not a new caption after an intensifier.
      if (GO_TO_PREFIX_REGEX.test(beforeToken)) {
        return token;
      }

      if (phraseContinuesAfterToken(beforeToken)) {
        return token;
      }

      exactCandidateData = exactCandidateData || candidateRuleData(text);
      if (exactRuleContinuesAfterToken(text, offset, offset + token.length, exactCandidateData)) {
        return token;
      }

      return /^\s*>>/.test(afterToken) ||
        (nextTextIsTitleCased(afterToken) && !/^\s*(?:hell|christ|god)\b/i.test(afterToken))
        ? token + "." : token;
    });
  }

  function isAdjacentToCensoredToken(text, tokenStart, tokenEnd) {
    return /\[\s*__\s*\]\s*$/.test(text.slice(0, tokenStart)) ||
      /^\s*\[\s*__\s*\]/.test(text.slice(tokenEnd));
  }

  function applyDeterministicRules(text, options) {
    var normalizedText = insertVirtualSentencePunctuation(ignoreNonSpeechLabels(normalizeCensoredTokens(text)));
    var policy = options && options.ambiguous || "score";

    if (typeof normalizedText !== "string" || normalizedText.indexOf(CENSORED_TOKEN) === -1) {
      return {
        text: text,
        replacements: [],
        decisions: []
      };
    }

    var replacements = [];
    var decisions = [];
    var occupiedRanges = [];

    var candidateData = candidateRuleData(normalizedText);

    orderCandidateRules(candidateData.rules).forEach(function applyRule(compiled) {
      if (options && options.disabledRuleTemplate === compiled.rule.template) return;
      if (options && options.disabledRuleTemplates &&
          options.disabledRuleTemplates.indexOf(compiled.rule.template) !== -1) return;
      var ranges = candidateData.ranges.get(compiled.index);
      var startsSentence = /^\^/.test(compiled.rule.template);
      var endsSentence = /\$$/.test(compiled.rule.template);
      var fullScan = !ranges;
      var seenMatches = new Set();
      var matchCount = 0;

      function scanMatches(source, windowStart, range, scanAll) {
        var match;

        compiled.regex.lastIndex = 0;
        while ((match = compiled.regex.exec(source)) !== null) {
          var fullMatch = match[0];
          var prefix = match[1];
          var matchedText = match[2];
          var globalMatchIndex = windowStart + match.index;
          var matchKey = globalMatchIndex + ":" + fullMatch.length;
          var matchStart = globalMatchIndex + prefix.length;
          var matchEnd = globalMatchIndex + fullMatch.length;

          var tokenRange = findTokenRange(matchedText);

          if (!tokenRange) continue;

          var tokenStart = matchStart + tokenRange.start;
          var tokenEnd = matchStart + tokenRange.end;

          if (SENTENCE_END_REGEX.test(normalizedText.charAt(tokenEnd))) {
            tokenEnd += 1;
          }

          if (!scanAll && (tokenStart < range.start || tokenStart >= range.end)) continue;

          if (endsSentence && !/^[^\p{L}\p{N}_'’]*$/u.test(normalizedText.slice(matchEnd))) continue;

          if (seenMatches.has(matchKey)) continue;
          seenMatches.add(matchKey);
          matchCount += 1;

          if (occupiedRanges.some(function overlaps(occupied) {
            return tokenStart < occupied.end && tokenEnd > occupied.start;
          })) continue;

          if (tokenRange.count === 1 && isAdjacentToCensoredToken(normalizedText, tokenStart, tokenEnd)) continue;

          var beforeToken = normalizedText.slice(0, tokenStart);
          var afterToken = normalizedText.slice(tokenEnd);
          var formattingText = normalizedText.slice(matchStart, Math.max(matchEnd, tokenEnd));

          var decision = candidateDecision(compiled.rule, policy);

          if (!decision) {
            decisions.push({
              rule: compiled.rule,
              tier: tierForRule(compiled),
              score: 0,
              margin: 0,
              support: 0,
              source: "abstain",
              word: "",
              tokenIndex: tokenIndexBefore(normalizedText, tokenStart),
              tokenSpan: tokenRange.count,
              textStart: tokenStart,
              textEnd: tokenEnd
            });
            occupiedRanges.push({ start: tokenStart, end: tokenEnd });
            continue;
          }

          var formattedWord = formatReplacement(decision.word, beforeToken, afterToken, formattingText);

          var replacement = {
            rule: compiled.rule,
            tier: tierForRule(compiled),
            score: decision.score,
            margin: decision.margin,
            support: decision.support,
            source: decision.source,
            word: formattedWord,
            tokenIndex: tokenIndexBefore(normalizedText, tokenStart),
            tokenSpan: tokenRange.count,
            textStart: tokenStart,
            textEnd: tokenEnd
          };
          replacements.push(replacement);
          decisions.push(replacement);

          occupiedRanges.push({
            start: tokenStart,
            end: tokenEnd
          });
        }
        return matchCount;
      }

      (fullScan ? [{ start: 0, end: normalizedText.length }] : ranges).forEach(function scanRange(range) {
        var windowStart = fullScan || startsSentence ? 0 : Math.max(0, range.start - 32);
        var windowEnd = fullScan ? normalizedText.length : Math.min(normalizedText.length, range.end + 32);
        scanMatches(fullScan ? normalizedText : normalizedText.slice(windowStart, windowEnd),
          windowStart, range, fullScan);
      });

      // Word windows are normally exact. Fall back for punctuation-heavy or
      // cross-cue rows where the lexical range was only an approximation.
      if (!fullScan && matchCount < ranges.length) {
        scanMatches(normalizedText, 0, { start: 0, end: normalizedText.length }, true);
      }
      });

    replacements.sort(function sortByPosition(left, right) {
      return left.textStart - right.textStart;
    });
    decisions.sort(function sortByPosition(left, right) {
      return left.textStart - right.textStart;
    });

    if (!replacements.length) {
      return {
        text: text,
        replacements: replacements,
        decisions: decisions
      };
    }

    var cursor = 0;
    var patchedParts = [];

    replacements.forEach(function applyReplacement(replacement) {
      patchedParts.push(normalizedText.slice(cursor, replacement.textStart));
      patchedParts.push(replacement.word);
      cursor = replacement.textEnd;
    });

    patchedParts.push(normalizedText.slice(cursor));

    return {
      text: patchedParts.join(""),
      replacements: replacements,
      decisions: decisions
    };
  }

  function templatesMatch(templates, text) {
    var candidateData = candidateRuleData(text);

    return templates.some(function matchesTemplate(template) {
      var entry = RULE_ENTRIES.find(function findRule(compiled) {
        return compiled.rule.template === template;
      });
      return Boolean(entry && candidateData.ranges.has(entry.index));
    });
  }

  function templateMatches(template, text) {
    return templatesMatch([template], text);
  }

  var exports = Object.freeze({
    CENSORED_TOKEN: CENSORED_TOKEN,
    CENSORED_TOKEN_REGEX: CENSORED_TOKEN_REGEX,
    ALLOWED_WORDS: ALLOWED_WORDS,
    DETERMINISTIC_RULES: DETERMINISTIC_RULES,
    normalizeCensoredTokens: normalizeCensoredTokens,
    formatWordCase: formatWordCase,
    applyDeterministicRules: applyDeterministicRules,
    templatesMatch: templatesMatch,
    templateMatches: templateMatches
  });

  root.UncensoredRules = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
