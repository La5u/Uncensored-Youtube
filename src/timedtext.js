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

  function patchEventTokens(eventText, replacements, tokenOffset) {
    var tokenIndex = tokenOffset;
    var replacementsByToken = {};

    replacements.forEach(function mapReplacement(replacement) {
      replacementsByToken[replacement.tokenIndex] = replacement.displayWord || replacement.word;
    });

    return eventText.replace(rules.CENSORED_TOKEN_REGEX, function replaceToken() {
      var replacement = replacementsByToken[tokenIndex];
      var coveredReplacement = replacements.find(function findCovered(candidate) {
        var tokenSpan = candidate.tokenSpan || 1;
        return tokenIndex > candidate.tokenIndex && tokenIndex < candidate.tokenIndex + tokenSpan;
      });
      tokenIndex += 1;

      if (coveredReplacement) {
        return "";
      }

      return replacement || arguments[0];
    });
  }

  function patchTimedTextJson(payload) {
    var patchCount = 0;

    if (!payload || !Array.isArray(payload.events)) {
      return {
        payload: payload,
        patchCount: patchCount
      };
    }

    var eventTexts = payload.events.map(function mapEventText(event) {
      return event && Array.isArray(event.segs) ? getEventText(event) : "";
    });
    var result = rules.applyDeterministicRules(eventTexts.join("\n"));
    var tokenOffset = 0;

    payload.events.forEach(function patchEvent(event, eventIndex) {
      if (!event || !Array.isArray(event.segs)) {
        return;
      }

      var eventText = eventTexts[eventIndex];
      var eventTokenCount = countCensoredTokens(eventText);

      if (!eventTokenCount) {
        return;
      }

      var eventReplacements = result.replacements.filter(function filterEventReplacement(replacement) {
        return replacement.tokenIndex >= tokenOffset && replacement.tokenIndex < tokenOffset + eventTokenCount;
      });

      if (!eventReplacements.length) {
        tokenOffset += eventTokenCount;
        return;
      }

      var patchedEventText = patchEventTokens(eventText, eventReplacements, tokenOffset);
      event.segs = [
        Object.assign({}, event.segs[0], {
          utf8: patchedEventText
        })
      ];
      patchCount += eventReplacements.length;
      tokenOffset += eventTokenCount;
    });

    return {
      payload: payload,
      patchCount: patchCount
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

  return Object.freeze({
    patchTimedTextJson: patchTimedTextJson,
    patchTimedTextBody: patchTimedTextBody
  });
});
