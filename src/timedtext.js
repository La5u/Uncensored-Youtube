(function exposeTimedText(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./rules"));
    return;
  }

  root.UncensoredTimedText = factory(root.UncensoredRules);
})(typeof globalThis !== "undefined" ? globalThis : this, function buildTimedText(rules) {
  "use strict";

  if (!rules) {
    return Object.freeze({});
  }

  function getEventText(event) {
    return event.segs.map(function collectText(seg) {
      return seg && typeof seg.utf8 === "string" ? seg.utf8 : "";
    }).join("");
  }

  function countCensoredTokens(text) {
    var tokenRegex = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
    var matches = text.match(tokenRegex);

    return matches ? matches.length : 0;
  }

  function patchEventSegments(segs, replacements, tokenOffset) {
    return patchEventSegmentsWithMask(segs, replacements, tokenOffset, false);
  }

  function patchEventSegmentsWithMask(segs, replacements, tokenOffset, maskUnresolved) {
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

      var patchedText = seg.utf8.replace(rules.CENSORED_TOKEN_REGEX, function replaceToken(token) {
        var replacement = replacementForToken(tokenIndex);
        tokenIndex += 1;
        return replacement === null ? (maskUnresolved ? "..." : token) : replacement;
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

  function contextForToken(eventText, targetTokenIndex, firstEventTokenIndex, deterministicByTokenIndex) {
    var relativeTokenIndex = 0;

    return eventText.replace(rules.CENSORED_TOKEN_REGEX, function replaceOtherToken() {
      var absoluteTokenIndex = firstEventTokenIndex + relativeTokenIndex;
      var deterministic;

      relativeTokenIndex += 1;

      if (absoluteTokenIndex === targetTokenIndex) {
        return rules.CENSORED_TOKEN;
      }

      deterministic = deterministicByTokenIndex.get(absoluteTokenIndex);
      return deterministic && deterministic.word ? deterministic.word : "something";
    });
  }

  function collectCensoredTokens(payload, deterministicByTokenIndex) {
    var tokenIndex = 0;
    var tokens = [];

    payload.events.forEach(function collectEventTokens(event, eventIndex) {
      if (!event || !Array.isArray(event.segs)) {
        return;
      }

      var eventText = getEventText(event);
      var firstEventTokenIndex = tokenIndex;

      event.segs.forEach(function collectSegmentTokens(seg, segIndex) {
        if (!seg || typeof seg.utf8 !== "string") {
          return;
        }

        seg.utf8.replace(rules.CENSORED_TOKEN_REGEX, function collectToken() {
          var deterministic = deterministicByTokenIndex.get(tokenIndex);

          tokens.push({
            tokenIndex: tokenIndex,
            eventIndex: eventIndex,
            segIndex: segIndex,
            timeSeconds: tokenTimeSeconds(event, seg),
            context: contextForToken(eventText, tokenIndex, firstEventTokenIndex, deterministicByTokenIndex),
            deterministicWord: deterministic ? deterministic.word : "",
            deterministicCandidates: deterministic ? deterministic.candidates : [],
            candidates: deterministic && deterministic.candidates.length
              ? deterministic.candidates
              : rules.ALLOWED_WORDS
          });
          tokenIndex += 1;
          return rules.CENSORED_TOKEN;
        });
      });
    });

    return tokens;
  }

  function patchTimedTextJson(payload) {
    return patchTimedTextJsonWithOverrides(payload, [], true);
  }

  function patchTimedTextJsonWithOverrides(payload, overrides, useDeterministic, maskUnresolved) {
    if (!payload || !Array.isArray(payload.events)) {
      return {
        payload: payload,
        patchCount: 0
      };
    }

    var eventTexts = payload.events.map(function mapEventText(event) {
      return event && Array.isArray(event.segs) ? getEventText(event) : "";
    });
    var result = useDeterministic ? rules.applyDeterministicRules(eventTexts.join("\n")) : { replacements: [] };
    var replacementByTokenIndex = new Map();
    var tokenOffset = 0;
    var maskedTokens = 0;

    result.replacements.forEach(function mapDeterministicReplacement(replacement) {
      replacementByTokenIndex.set(replacement.tokenIndex, replacement);
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

      if (!eventReplacements.length && !maskUnresolved) {
        tokenOffset += eventTokenCount;
        return;
      }

      patchEventSegmentsWithMask(event.segs, eventReplacements, tokenOffset, maskUnresolved);
      if (maskUnresolved) {
        maskedTokens += eventTokenCount;
      }
      tokenOffset += eventTokenCount;
    });

    return {
      payload: payload,
      patchCount: replacementByTokenIndex.size + maskedTokens
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

  function patchTimedTextBodyWithOverrides(body, overrides, useDeterministic, maskUnresolved) {
    try {
      var result = patchTimedTextJsonWithOverrides(JSON.parse(body), overrides, useDeterministic !== false, maskUnresolved === true);
      return result.patchCount > 0 ? JSON.stringify(result.payload) : body;
    } catch (error) {
      return body;
    }
  }

  function collectTimedTextTokens(body, useDeterministic) {
    try {
      var payload = JSON.parse(body);
      var eventTexts = payload.events.map(function mapEventText(event) {
        return event && Array.isArray(event.segs) ? getEventText(event) : "";
      });
      var result = useDeterministic !== false
        ? rules.applyDeterministicRules(eventTexts.join("\n"))
        : { replacements: [] };

      return collectCensoredTokens(payload, deterministicTokenMap(result.replacements));
    } catch (error) {
      return [];
    }
  }

  return Object.freeze({
    patchTimedTextJson: patchTimedTextJson,
    patchTimedTextJsonWithOverrides: patchTimedTextJsonWithOverrides,
    patchTimedTextBody: patchTimedTextBody,
    patchTimedTextBodyWithOverrides: patchTimedTextBodyWithOverrides,
    collectTimedTextTokens: collectTimedTextTokens
  });
});
