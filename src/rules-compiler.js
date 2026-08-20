(function buildRuleCompiler() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var CENSORED_TOKEN = "[__]";

  function set(name, values) {
    var result = Array.from(values);

    if (!name || !result.length || result.some(function invalid(value) {
      return typeof value !== "string" || !value;
    })) {
      throw new Error("Rule sets need a name and at least one nonempty string");
    }

    if (new Set(result).size !== result.length) {
      throw new Error("Duplicate value in rule set " + name);
    }

    Object.defineProperty(result, "ruleSetName", { value: name });
    return Object.freeze(result);
  }

  function regexSet(name, source) {
    if (!name || !source) throw new Error("Regex rule sets need a name and source");
    return Object.freeze({ ruleSetName: name, regexSource: source });
  }

  function slot(words) {
    if (!Array.isArray(words) || !words.ruleSetName) {
      throw new Error("Slots need a named word-role set");
    }
    return Object.freeze({
      slotName: words.ruleSetName,
      candidates: words
    });
  }

  function declaration(parts, values, isFrame) {
    if (!parts || !parts.raw) {
      throw new Error((isFrame ? "frame" : "pattern") + " must be used as a tagged template");
    }
    if (isFrame && values.filter(function isSlot(value) {
      return value && value.slotName;
    }).length !== 1) {
      throw new Error("Frames need exactly one grammatical slot");
    }

    values.forEach(function validate(value) {
      var strings = Array.isArray(value) && value.every(function stringEntry(entry) {
        return typeof entry === "string" && entry;
      });
      if (value && value.slotName && isFrame) return;
      if (strings && (!isFrame || value.ruleSetName)) return;
      if (value && value.regexSource) return;
      if (typeof value === "string" && !isFrame) return;
      throw new Error((isFrame ? "Frame" : "Pattern") + " insertion is invalid");
    });

    return Object.freeze({
      parts: Object.freeze(Array.prototype.slice.call(parts)),
      values: Object.freeze(values)
    });
  }

  function pattern(parts) {
    return declaration(parts, Array.prototype.slice.call(arguments, 1), false);
  }

  function patterns(values) {
    if (!Array.isArray(values) || !values.length || values.some(function invalid(value) {
      return typeof value !== "string" || !value;
    })) {
      throw new Error("Patterns need a nonempty array of strings");
    }
    return values.map(function literalPattern(value) {
      var parts = [value];
      parts.raw = [value];
      return pattern(parts);
    });
  }

  function frame(parts) {
    return declaration(parts, Array.prototype.slice.call(arguments, 1), true);
  }

  function group(id, priority, patterns) {
    if (patterns === undefined) {
      patterns = priority;
      priority = null;
    }
    if (!id || priority !== null && !Number.isInteger(priority) ||
        !Array.isArray(patterns) || !patterns.length) {
      throw new Error("Rule groups need an id, optional integer priority, and patterns");
    }

    return Object.freeze({
      id: id,
      priority: priority,
      patterns: Object.freeze(patterns.slice())
    });
  }

  function finishPattern(value) {
    if (/\s$/u.test(value)) {
      throw new Error("Use an explicit … instead of trailing rule whitespace: " + value);
    }

    return /…$/u.test(value) ? value.slice(0, -1).replace(/\s*$/u, " ") : value;
  }

  function expand(patternValue) {
    var expanded = [patternValue.parts[0]];

    patternValue.values.forEach(function insert(value, valueIndex) {
      if (value && value.regexSource) {
        throw new Error("Regex sets can only be used by grammar patterns");
      }

      var alternatives = Array.isArray(value) ? value : [value];
      var nextPart = patternValue.parts[valueIndex + 1];
      var next = [];

      expanded.forEach(function prefix(valuePrefix) {
        alternatives.forEach(function alternative(entry) {
          next.push(valuePrefix + entry + nextPart);
        });
      });
      expanded = next;
    });

    return expanded.map(finishPattern);
  }

  function rule(authoredPattern, priority, groupId) {
    var candidateGroups = [];
    var template = authoredPattern.replace(/\[([^\]]+)\]/gu, function replaceCandidates(match, groupValue) {
      var candidates = groupValue.split("|");

      candidateGroups.push(candidates);
      return candidates[0].split(/\s+/u).map(function tokenPlaceholder() {
        return CENSORED_TOKEN;
      }).join(" ");
    });
    var candidates;

    if (!candidateGroups.length) {
      throw new Error("Rule pattern must include a swear in brackets: " + authoredPattern);
    }

    candidates = candidateGroups.length === 1
      ? candidateGroups[0]
      : [candidateGroups.map(function firstCandidate(groupValue) {
        return groupValue[0];
      }).join(" ")];

    var compiled = {
      template: template,
      candidates: Object.freeze(candidates)
    };
    if (priority !== null && priority !== undefined) {
      compiled.priority = priority;
      compiled.groupId = groupId;
    }
    return Object.freeze(compiled);
  }

  function compileGroups(groups) {
    var seen = new Map();
    var compiled = [];

    groups.slice().sort(function priorityOrder(left, right) {
      if (left.priority === null || right.priority === null) return 0;
      return left.priority - right.priority;
    }).forEach(function compileGroup(ruleGroup) {
      ruleGroup.patterns.forEach(function compilePattern(patternValue, patternIndex) {
        expand(patternValue).forEach(function compileExpanded(authoredPattern, expansionIndex) {
          var priority = ruleGroup.priority === null ? null :
            ruleGroup.priority * 1000000000 + patternIndex * 1000000 + expansionIndex;
          var compiledRule = rule(authoredPattern, priority, ruleGroup.id);
          var prior = seen.get(compiledRule.template);

          if (prior) {
            throw new Error("Duplicate rule template " + compiledRule.template +
              " in " + prior + " and " + ruleGroup.id);
          }

          seen.set(compiledRule.template, ruleGroup.id);
          compiled.push(compiledRule);
        });
      });
    });

    return Object.freeze(compiled);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function regexLiteral(value, softPunctuation) {
    return escapeRegExp(value)
      .replace(/'/g, "['\u2019]")
      .replace(/ /g, softPunctuation ? "[\\s,\"“”]+" : "\\s+");
  }

  function regexAlternatives(values) {
    return values.slice().sort(function longestFirst(left, right) {
      return right.length - left.length;
    }).map(regexLiteral).join("|");
  }

  function compileFramePattern(patternValue, priority, groupId) {
    var phrase = regexLiteral(patternValue.parts[0]);
    var description = patternValue.parts[0];
    var roleSlot;

    patternValue.values.forEach(function compileInsertion(value, index) {
      if (value && value.slotName) {
        roleSlot = value;
        description += CENSORED_TOKEN + patternValue.parts[index + 1];
        phrase += "\\[__\\]";
      } else {
        description += "<" + value.ruleSetName + ">" + patternValue.parts[index + 1];
        phrase += value.regexSource
          ? "(?:" + value.regexSource + ")"
          : "(?:" + regexAlternatives(value) + ")";
      }
      phrase += regexLiteral(patternValue.parts[index + 1]);
    });

    var compiledRule = {
      template: description,
      candidates: roleSlot.candidates,
      role: roleSlot.slotName
    };
    if (priority !== null && priority !== undefined) {
      compiledRule.priority = priority;
      compiledRule.groupId = groupId;
    }
    return Object.freeze({
      rule: Object.freeze(compiledRule),
      phrase: phrase
    });
  }

  var exports = Object.freeze({
    set: set,
    regexSet: regexSet,
    slot: slot,
    pattern: pattern,
    patterns: patterns,
    frame: frame,
    group: group,
    expand: expand,
    compileGroups: compileGroups,
    compileFramePattern: compileFramePattern,
    escapeRegExp: escapeRegExp,
    regexLiteral: regexLiteral,
    regexAlternatives: regexAlternatives
  });

  root.UncensoredRuleCompiler = exports;
  if (typeof module === "object" && module.exports) module.exports = exports;
})();
