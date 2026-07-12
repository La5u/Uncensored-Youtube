(function buildTimedText() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var rules = root.UncensoredRules || (typeof require === "function" ? require("./rules") : null);

  if (!rules) {
    root.UncensoredTimedText = Object.freeze({});
    return;
  }

  var CENSORED_TOKEN_REGEX = rules.CENSORED_TOKEN_REGEX;
  var CENSORED_TOKEN_COUNT_REGEX = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
  var deterministicAnalysisCache = null;

  function getEventText(event) {
    return event.segs.map(function collectText(seg) {
      return seg && typeof seg.utf8 === "string" ? seg.utf8 : "";
    }).join("");
  }

  function countCensoredTokens(text) {
    CENSORED_TOKEN_COUNT_REGEX.lastIndex = 0;
    var matches = text.match(CENSORED_TOKEN_COUNT_REGEX);

    return matches ? matches.length : 0;
  }

  function patchEventSegments(segs, replacements, tokenOffset) {
    var tokenIndex = tokenOffset;

    function replacementForToken(index) {
      var replacement = replacements.find(function findReplacement(candidate) {
        return index >= candidate.tokenIndex && index < candidate.tokenIndex + (candidate.tokenSpan || 1);
      });

      if (!replacement) {
        return null;
      }

      return (replacement.displayWord || replacement.word).split(/\s+/)[index - replacement.tokenIndex] || "";
    }

    segs.forEach(function patchSegment(seg) {
      if (!seg || typeof seg.utf8 !== "string") {
        return;
      }

      var patchedText = seg.utf8.replace(CENSORED_TOKEN_REGEX, function replaceToken(token) {
        var replacement = replacementForToken(tokenIndex);
        tokenIndex += 1;
        return replacement === null ? token : replacement;
      });

      if (patchedText !== seg.utf8) {
        seg.utf8 = patchedText;
      }
    });
  }

  function tokenTimeSeconds(event, seg) {
    var startMs = typeof event.tStartMs === "number" ? event.tStartMs : 0;
    var offsetMs = seg && typeof seg.tOffsetMs === "number" ? seg.tOffsetMs : 0;

    return (startMs + offsetMs) / 1000;
  }

  function unique(values) {
    var seen = Object.create(null);
    var result = [];

    values.forEach(function addUnique(value) {
      if (value && !seen[value]) {
        seen[value] = true;
        result.push(value);
      }
    });

    return result;
  }

  function deterministicCandidatePieces(replacement, pieceIndex) {
    var span = replacement.tokenSpan || 1;
    var candidates = replacement.rule.candidates.map(function candidatePiece(candidate) {
      var pieces = String(candidate).split(/\s+/);

      return pieces.length === span ? pieces[pieceIndex] : candidate;
    });
    var displayPieces = String(replacement.displayWord || replacement.word).split(/\s+/);

    return unique(candidates.concat(displayPieces[pieceIndex] || replacement.displayWord || replacement.word));
  }

  function deterministicTokenMap(replacements) {
    var byTokenIndex = new Map();

    replacements.forEach(function indexReplacement(replacement) {
      var span = replacement.tokenSpan || 1;
      var displayPieces = String(replacement.displayWord || replacement.word).split(/\s+/);
      var index;

      for (index = 0; index < span; index += 1) {
        byTokenIndex.set(replacement.tokenIndex + index, {
          word: displayPieces[index] || replacement.displayWord || replacement.word,
          candidates: deterministicCandidatePieces(replacement, index),
          replacement: replacement
        });
      }
    });

    return byTokenIndex;
  }

  function contextForToken(eventText, targetTokenIndex, firstEventTokenIndex, deterministicByTokenIndex, previousEventText) {
    var relativeTokenIndex = 0;
    var currentContext = eventText.replace(CENSORED_TOKEN_REGEX, function replaceOtherToken() {
      var absoluteTokenIndex = firstEventTokenIndex + relativeTokenIndex;
      var deterministic;

      relativeTokenIndex += 1;

      if (absoluteTokenIndex === targetTokenIndex) {
        return rules.CENSORED_TOKEN;
      }

      deterministic = deterministicByTokenIndex.get(absoluteTokenIndex);
      return deterministic && deterministic.word ? deterministic.word : "";
    });

    return ((previousEventText || "").replace(CENSORED_TOKEN_REGEX, "") + " " + currentContext).trim();
  }

  function adjacentTokenGroups(eventText) {
    var gaps = eventText.split(CENSORED_TOKEN_REGEX);
    var groups = [];
    var start = 0;
    var end;
    var index;

    for (end = 0; end < gaps.length - 1; end += 1) {
      if (end < gaps.length - 2 && !/\S/u.test(gaps[end + 1])) {
        continue;
      }
      for (index = start; index <= end; index += 1) {
        groups[index] = {
          index: index - start,
          count: end - start + 1
        };
      }
      start = end + 1;
    }

    return groups;
  }

  function collectCensoredTokens(payload, deterministicByTokenIndex) {
    var tokenIndex = 0;
    var tokens = [];
    var previousEventText = "";

    payload.events.forEach(function collectEventTokens(event, eventIndex) {
      if (!event || !Array.isArray(event.segs)) {
        return;
      }

      var eventText = getEventText(event);
      var eventTokenGroups = adjacentTokenGroups(eventText);
      var firstEventTokenIndex = tokenIndex;
      var eventTokenIndex = 0;

      event.segs.forEach(function collectSegmentTokens(seg, segIndex) {
        if (!seg || typeof seg.utf8 !== "string") {
          return;
        }

        seg.utf8.replace(CENSORED_TOKEN_REGEX, function collectToken() {
          var deterministic = deterministicByTokenIndex.get(tokenIndex);

          tokens.push({
            tokenIndex: tokenIndex,
            eventTokenIndex: eventTokenIndex,
            adjacentTokenIndex: eventTokenGroups[eventTokenIndex].index,
            adjacentTokenCount: eventTokenGroups[eventTokenIndex].count,
            eventIndex: eventIndex,
            eventText: eventText,
            previousEventText: previousEventText,
            segIndex: segIndex,
            timeSeconds: tokenTimeSeconds(event, seg),
            context: contextForToken(eventText, tokenIndex, firstEventTokenIndex, deterministicByTokenIndex, previousEventText),
            deterministicWord: deterministic ? deterministic.word : "",
            deterministicCandidates: deterministic ? deterministic.candidates : [],
            candidates: deterministic && deterministic.candidates.length
              ? deterministic.candidates
              : rules.ALLOWED_WORDS
          });
          tokenIndex += 1;
          eventTokenIndex += 1;
          return rules.CENSORED_TOKEN;
        });
      });
      if (eventText.trim()) {
        previousEventText = eventText;
      }
    });

    return tokens;
  }

  function deterministicAnalysis(payload, body, useDeterministic) {
    var deterministic = useDeterministic === true;
    var eventTexts;
    var result;

    if (typeof body === "string" &&
        deterministicAnalysisCache &&
        deterministicAnalysisCache.body === body &&
        deterministicAnalysisCache.deterministic === deterministic) {
      return deterministicAnalysisCache;
    }

    eventTexts = payload.events.map(function mapEventText(event) {
      return event && Array.isArray(event.segs) ? getEventText(event) : "";
    });
    result = deterministic ? rules.applyDeterministicRules(eventTexts.join("\n")) : { replacements: [] };

    if (typeof body === "string") {
      deterministicAnalysisCache = {
        body: body,
        deterministic: deterministic,
        eventTexts: eventTexts,
        result: result
      };
      return deterministicAnalysisCache;
    }

    return {
      eventTexts: eventTexts,
      result: result
    };
  }

  function patchTimedTextJson(payload) {
    return patchTimedTextJsonWithOverrides(payload, [], true);
  }

  function patchTimedTextJsonWithOverrides(payload, overrides, useDeterministic, body, resolveAmbiguous) {
    if (!payload || !Array.isArray(payload.events)) {
      return {
        payload: payload,
        patchCount: 0
      };
    }

    var analysis = deterministicAnalysis(payload, body, useDeterministic === true);
    var eventTexts = analysis.eventTexts;
    var result = analysis.result;
    var replacementByTokenIndex = new Map();
    var tokenOffset = 0;

    result.replacements.forEach(function mapDeterministicReplacement(replacement) {
      if (resolveAmbiguous !== false || replacement.rule.candidates.length === 1) {
        replacementByTokenIndex.set(replacement.tokenIndex, replacement);
      }
    });

    (overrides || []).forEach(function mapOverride(override) {
      if (!override || typeof override.tokenIndex !== "number" || !override.word) {
        return;
      }

      replacementByTokenIndex.set(override.tokenIndex, {
        tokenIndex: override.tokenIndex,
        tokenSpan: override.tokenSpan || 1,
        word: override.word,
        displayWord: override.displayWord || override.word
      });
    });

    payload.events.forEach(function patchEvent(event, eventIndex) {
      if (!event || !Array.isArray(event.segs)) {
        return;
      }

      var eventText = eventTexts[eventIndex];
      var eventTokenCount = countCensoredTokens(eventText);

      if (!eventTokenCount) {
        return;
      }

      var eventTokenEnd = tokenOffset + eventTokenCount;
      var eventReplacements = Array.from(replacementByTokenIndex.values()).filter(function filterEventReplacement(replacement) {
        var replacementEnd = replacement.tokenIndex + (replacement.tokenSpan || 1);

        return replacement.tokenIndex < eventTokenEnd && replacementEnd > tokenOffset;
      });

      if (!eventReplacements.length) {
        tokenOffset += eventTokenCount;
        return;
      }

      patchEventSegments(event.segs, eventReplacements, tokenOffset);
      tokenOffset += eventTokenCount;
    });

    return {
      payload: payload,
      patchCount: replacementByTokenIndex.size
    };
  }

  function patchTimedTextBody(body) {
    try {
      var result = patchTimedTextJson(JSON.parse(body));
      return result.patchCount > 0 ? JSON.stringify(result.payload) : body;
    } catch (error) {
      return body;
    }
  }

  function patchTimedTextBodyWithOverrides(body, overrides, useDeterministic, resolveAmbiguous) {
    try {
      var result = patchTimedTextJsonWithOverrides(JSON.parse(body), overrides, useDeterministic !== false, body, resolveAmbiguous);
      return result.patchCount > 0 ? JSON.stringify(result.payload) : body;
    } catch (error) {
      return body;
    }
  }

  function collectTimedTextTokens(body, useDeterministic) {
    try {
      var payload = JSON.parse(body);
      var result = deterministicAnalysis(payload, body, useDeterministic !== false).result;

      return collectCensoredTokens(payload, deterministicTokenMap(result.replacements));
    } catch (error) {
      return [];
    }
  }

  var exports = Object.freeze({
    patchTimedTextJson: patchTimedTextJson,
    patchTimedTextJsonWithOverrides: patchTimedTextJsonWithOverrides,
    patchTimedTextBody: patchTimedTextBody,
    patchTimedTextBodyWithOverrides: patchTimedTextBodyWithOverrides,
    collectTimedTextTokens: collectTimedTextTokens
  });

  root.UncensoredTimedText = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
