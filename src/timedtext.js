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

      return replacement.word.split(/\s+/)[index - replacement.tokenIndex] || "";
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

  function spokenUnitCount(text) {
    var units = text.match(/[a-z0-9]+(?:['’][a-z0-9]+)*|\[\s*__\s*\]/giu);

    return units ? units.length : 0;
  }

  function eventDurationMs(payload, event, eventIndex) {
    var startMs = typeof event.tStartMs === "number" ? event.tStartMs : 0;
    var durationMs = typeof event.dDurationMs === "number" ? event.dDurationMs : 0;
    var nextEvent = payload.events.slice(eventIndex + 1).find(function findNextTimedEvent(candidate) {
      return candidate && typeof candidate.tStartMs === "number" && candidate.tStartMs > startMs;
    });
    // Temporary: this identifies YouTube's fixed two-line caption experiment.
    var fixedPage = payload.wpWinPositions && payload.wpWinPositions.some(function twoRows(position) {
      return position && position.rcRows === 2;
    }) && event.segs.every(function untimed(seg) { return typeof seg.tOffsetMs !== "number"; }) &&
      event.segs.some(function lineBreak(seg) { return String(seg.utf8 || "").indexOf("\n") !== -1; });

    return nextEvent && (fixedPage || durationMs <= 0) ? nextEvent.tStartMs - startMs : durationMs;
  }

  function tokenTimeSeconds(payload, event, eventIndex, seg, segIndex, tokenOffset) {
    var startMs = typeof event.tStartMs === "number" ? event.tStartMs : 0;
    var offsetMs;
    var durationMs;
    var eventText;
    var units;

    if (typeof seg.tOffsetMs === "number") {
      return (startMs + seg.tOffsetMs) / 1000;
    }

    durationMs = eventDurationMs(payload, event, eventIndex);

    eventText = getEventText(event);
    units = spokenUnitCount(eventText);
    if (durationMs > 0 && units > 1) {
      offsetMs = durationMs * spokenUnitCount(
        event.segs.slice(0, segIndex).map(function precedingText(candidate) {
          return candidate && candidate.utf8 || "";
        }).join("") + seg.utf8.slice(0, tokenOffset)
      ) / units;
    } else {
      offsetMs = 0;
    }

    return (startMs + offsetMs) / 1000;
  }

  function deterministicCandidatePieces(replacement, pieceIndex) {
    var span = replacement.tokenSpan || 1;
    var candidates = replacement.rule.candidates.map(function candidatePiece(candidate) {
      var pieces = candidate.split(/\s+/);

      return pieces.length === span ? pieces[pieceIndex] : candidate;
    });
    var pieces = replacement.word.split(/\s+/);

    return Array.from(new Set(candidates.concat(pieces[pieceIndex] || replacement.word))).filter(Boolean);
  }

  function deterministicTokenMap(replacements) {
    var byTokenIndex = new Map();

    replacements.forEach(function indexReplacement(replacement) {
      var span = replacement.tokenSpan || 1;
      var pieces = replacement.word.split(/\s+/);
      var index;

      for (index = 0; index < span; index += 1) {
        byTokenIndex.set(replacement.tokenIndex + index, {
          word: pieces[index] || replacement.word,
          candidates: deterministicCandidatePieces(replacement, index),
          ambiguous: replacement.rule.candidates.length > 1,
          replacement: replacement
        });
      }
    });

    return byTokenIndex;
  }

  function contextForToken(visibleEvents, position, targetTokenIndex, firstEventTokenIndex, deterministicByTokenIndex, contextBefore, contextAfter) {
    var relativeTokenIndex = 0;
    var currentContext = visibleEvents[position].replace(CENSORED_TOKEN_REGEX, function replaceOtherToken() {
      var absoluteTokenIndex = firstEventTokenIndex + relativeTokenIndex;
      var deterministic;

      relativeTokenIndex += 1;

      if (absoluteTokenIndex === targetTokenIndex) {
        return rules.CENSORED_TOKEN;
      }

      deterministic = deterministicByTokenIndex.get(absoluteTokenIndex);
      return deterministic && deterministic.word ? deterministic.word : "…";
    });

    var start = Math.max(0, position - contextBefore);
    var end = Math.min(visibleEvents.length - 1, position + contextAfter);
    var parts = [];
    var index;

    for (index = start; index <= end; index += 1) {
      if (index === position) {
        parts.push(currentContext);
      } else {
        parts.push(visibleEvents[index].replace(CENSORED_TOKEN_REGEX, "…"));
      }
    }

    return parts.join(" ").trim();
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

  function lastWord(text) {
    var words = text.match(/[a-z0-9]+(?:['’][a-z0-9]+)*/giu);
    return words && words.length ? words[words.length - 1] : "";
  }

  function collectCensoredTokens(payload, deterministicByTokenIndex, fRulesByTokenIndex, options) {
    var tokenIndex = 0;
    var tokens = [];
    var previousWord = "";
    var previousWordOffset = 0;
    var visibleEvents = [];
    var positionByEventIndex = new Map();

    payload.events.forEach(function collectVisibleEvent(event, eventIndex) {
      if (!event || !Array.isArray(event.segs)) {
        return;
      }
      var text = getEventText(event);
      if (!text.trim()) {
        return;
      }
      positionByEventIndex.set(eventIndex, visibleEvents.length);
      visibleEvents.push(text);
    });

    payload.events.forEach(function collectEventTokens(event, eventIndex) {
      if (!event || !Array.isArray(event.segs)) {
        return;
      }

      var eventText = getEventText(event);
      var eventTokenGroups = adjacentTokenGroups(eventText);
      var firstEventTokenIndex = tokenIndex;
      var eventTokenIndex = 0;
      var contextBefore = options && options.contextBefore != null ? options.contextBefore : 1;
      var contextAfter = options && options.contextAfter != null ? options.contextAfter : 0;
      var position = positionByEventIndex.get(eventIndex);

      event.segs.forEach(function collectSegmentTokens(seg, segIndex) {
        var cursor = 0;

        if (!seg || typeof seg.utf8 !== "string") {
          return;
        }

        seg.utf8.replace(CENSORED_TOKEN_REGEX, function collectToken(match, offset) {
          var deterministic = deterministicByTokenIndex.get(tokenIndex);
          var fRule = fRulesByTokenIndex.get(tokenIndex);

          var word = lastWord(seg.utf8.slice(cursor, offset));
          if (word) {
            previousWord = word;
            previousWordOffset = 0;
          }

          tokens.push({
            tokenIndex: tokenIndex,
            eventTokenIndex: eventTokenIndex,
            adjacentTokenIndex: eventTokenGroups[eventTokenIndex].index,
            adjacentTokenCount: eventTokenGroups[eventTokenIndex].count,
            eventIndex: eventIndex,
            timeSeconds: tokenTimeSeconds(payload, event, eventIndex, seg, segIndex, offset),
            previousWord: previousWord,
            previousWordOffset: previousWordOffset,
            context: contextForToken(visibleEvents, position, tokenIndex, firstEventTokenIndex, deterministicByTokenIndex, contextBefore, contextAfter),
            deterministicWord: deterministic ? deterministic.word : "",
            deterministicCandidates: deterministic ? deterministic.candidates : [],
            deterministicAmbiguous: deterministic ? deterministic.ambiguous : false,
            deterministicRuleTemplate: deterministic ? deterministic.replacement.rule.template : "",
            deterministicRuleId: deterministic
              ? deterministic.replacement.rule.groupId + ":" + deterministic.replacement.rule.priority
              : "",
            deterministicTier: deterministic ? deterministic.replacement.tier : "",
            fCandidates: fRule ? fRule.candidates.filter(function fWord(candidate) {
              return candidate.toLowerCase().indexOf("fuck") !== -1;
            }) : [],
            candidates: deterministic && deterministic.candidates.length
              ? deterministic.candidates
              : rules.ALLOWED_WORDS
          });
          tokenIndex += 1;
          eventTokenIndex += 1;
          previousWordOffset += 1;
          cursor = offset + match.length;
          return rules.CENSORED_TOKEN;
        });
        var trailingWord = lastWord(seg.utf8.slice(cursor));
        if (trailingWord) {
          previousWord = trailingWord;
          previousWordOffset = 0;
        }
      });
    });

    return tokens;
  }

  function collectCaptionTimeline(payload) {
    var tokenIndex = 0;
    var events = [];

    payload.events.forEach(function collectEvent(event, eventIndex) {
      if (!event || !Array.isArray(event.segs)) return;

      var text = getEventText(event);
      var tokenCount = countCensoredTokens(text);
      var startTime = (typeof event.tStartMs === "number" ? event.tStartMs : 0) / 1000;

      if (text.trim()) {
        events.push({
          eventIndex: eventIndex,
          startTime: startTime,
          endTime: startTime + eventDurationMs(payload, event, eventIndex) / 1000,
          text: text,
          firstTokenIndex: tokenIndex,
          tokenCount: tokenCount
        });
      }
      tokenIndex += tokenCount;
    });

    events.forEach(function fillMissingEndTime(event, index) {
      if (event.endTime <= event.startTime) {
        event.endTime = events[index + 1] && events[index + 1].startTime > event.startTime
          ? events[index + 1].startTime
          : event.startTime + 5;
      }
    });
    return events;
  }

  function deterministicAnalysis(payload, body, useDeterministic) {
    var deterministic = useDeterministic;
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
    result = deterministic ? rules.applyDeterministicRules(eventTexts.join(" ")) : { replacements: [] };

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

  function patchTimedTextJsonWithOverrides(payload, overrides, useDeterministic, body, resolveAmbiguous) {
    if (!payload || !Array.isArray(payload.events)) {
      return {
        payload: payload,
        patchCount: 0
      };
    }

    var analysis = deterministicAnalysis(payload, body, useDeterministic);
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
        word: override.word
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

  function patchTimedTextBodyWithOverrides(body, overrides, useDeterministic, resolveAmbiguous) {
    try {
      var result = patchTimedTextJsonWithOverrides(JSON.parse(body), overrides, useDeterministic !== false, body, resolveAmbiguous);
      return result.patchCount > 0 ? JSON.stringify(result.payload) : body;
    } catch (error) {
      return body;
    }
  }

  function collectTimedTextData(body, useDeterministic, options) {
    try {
      var payload = JSON.parse(body);
      var parsed = Array.isArray(payload.events) && payload.events.length > 0;
      var ruleResult = deterministicAnalysis(payload, body, true).result;
      var result = useDeterministic === false ? { decisions: [] } : ruleResult;

      return {
        parsed: parsed,
        tokens: parsed ? collectCensoredTokens(
          payload,
          deterministicTokenMap(result.decisions || result.replacements),
          deterministicTokenMap(ruleResult.decisions || ruleResult.replacements),
          options
        ) : [],
        timeline: parsed ? collectCaptionTimeline(payload) : []
      };
    } catch (error) {
      return { parsed: false, tokens: [], timeline: [] };
    }
  }

  function collectTimedTextTokens(body, useDeterministic, options) {
    return collectTimedTextData(body, useDeterministic, options).tokens;
  }

  var exports = Object.freeze({
    patchTimedTextBodyWithOverrides: patchTimedTextBodyWithOverrides,
    collectTimedTextData: collectTimedTextData,
    collectTimedTextTokens: collectTimedTextTokens
  });

  root.UncensoredTimedText = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
