(function buildWhisperLocal() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;

  var runtime = root.browser || root.chrome;
  var currentScript = root.document && root.document.currentScript;
  var currentLocation = root.location && root.location.href || "";
  var baseUrl = runtime && runtime.runtime && runtime.runtime.getURL
    ? runtime.runtime.getURL("")
    : currentScript && currentScript.src
      ? currentScript.src.replace(/src\/whisper-local\.js(?:\?.*)?$/, "")
      : currentLocation
          ? currentLocation.replace(/src\/(?:whisper-local|whisper-module-worker)\.js(?:\?.*)?$/, "")
        : "";
  var DEFAULT_MODEL = "whisper-tiny.en";
  var MASKED_F_REGEX = /\bf\s*[*#_\u2010-\u2015-]+(?=\s|[.,!?]|$)/giu;
  var MASKED_F_TEST_REGEX = /\bf\s*[*#_\u2010-\u2015-]+(?=\s|[.,!?]|$)/iu;
  var MASKED_F_MARKER = "maskedfword";
  var transcriberPromise = null;
  var ANCHOR_HOMOPHONES = {
    to: ["too", "two"],
    too: ["to", "two"],
    two: ["to", "too"],
    for: ["four"],
    four: ["for"],
    know: ["no"],
    no: ["know"],
    right: ["write", "rite"],
    write: ["right", "rite"],
    rite: ["right", "write"],
    there: ["their", "they're"],
    their: ["there", "they're"],
    "they're": ["there", "their"],
    your: ["you're"],
    "you're": ["your"],
    here: ["hear"],
    hear: ["here"],
    see: ["sea"],
    sea: ["see"]
  };

  function debugEnabled() {
    try {
      return root.localStorage && root.localStorage.getItem("uncensoredDebug") === "1";
    } catch (error) {
      return false;
    }
  }

  function debugLog() {
    if (!debugEnabled() || !root.console || !root.console.debug) {
      return;
    }

    var message = Array.prototype.map.call(arguments, function formatDebugValue(value) {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    }).join(" ");
    root.console.debug("[uncensored] " + message);
  }

  function errorDetails(error) {
    if (!error) {
      return "";
    }

    return {
      name: error.name || "",
      message: error.message || String(error),
      cause: error.cause ? String(error.cause) : "",
      stack: error.stack || ""
    };
  }

  function getTranscriber() {
    if (!transcriberPromise) {
      transcriberPromise = Promise.resolve(root.transformers).then(function createPipeline(transformers) {
        debugLog("loading whisper model", {
          model: DEFAULT_MODEL,
          baseUrl: baseUrl
        });

        transformers.env.localModelPath = baseUrl + "src/models/";
        transformers.env.allowRemoteModels = false;
        transformers.env.allowLocalModels = true;
        if (baseUrl.indexOf("chrome-extension://") === 0) {
          transformers.env.useBrowserCache = false;
          transformers.env.useWasmCache = false;
        }
        transformers.env.backends.onnx.wasm.wasmPaths = {
          wasm: baseUrl + "src/vendor/ort-wasm-simd-threaded.asyncify.wasm"
        };
        transformers.env.backends.onnx.wasm.proxy = false;
        transformers.env.backends.onnx.wasm.numThreads = 1;

        return transformers.pipeline("automatic-speech-recognition", DEFAULT_MODEL, {
          dtype: "q8",
          device: "wasm",
          session_options: {
            graphOptimizationLevel: "disabled"
          }
        }).then(function loaded(transcriber) {
          debugLog("whisper model ready");
          return transcriber;
        });
      }).catch(function resetFailedTranscriber(error) {
        transcriberPromise = null;
        throw error;
      });
    }

    return transcriberPromise;
  }

  function normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\u2019/g, "'")
      .replace(/\bmotha[\W_]*fucka+\b/g, " motherfucker ")
      .replace(/\bfuckin\b/g, " fucking ")
      .replace(/\bf[\W_]*\*[\W_]*c[\W_]*k[\W_]*i[\W_]*n[\W_]*g\b/g, " fucking ")
      .replace(/\bf[\W_]*\*[\W_]*c[\W_]*k\b/g, " fuck ")
      .replace(/\bsh[\W_]*\*[\W_]*t\b/g, " shit ")
      .replace(/\bf[\W_]*u[\W_]*c[\W_]*k(?:ing)?\b/g, function normalizeCensoredFuck(match) {
        return /ing\b/.test(match.replace(/[\W_]+/g, "")) ? " fucking " : " fuck ";
      })
      .replace(/\bsh[\W_]*i[\W_]*t\b/g, " shit ")
      .replace(/\bsh?\s*[*#_\u2010-\u2015-]+\s*t\b/g, " shit ")
      .replace(/\bb\s*[*#_\u2010-\u2015-]+\s*tch\b/g, " bitch ")
      .replace(/\bf\s*[*#_\u2010-\u2015-]+\s*(?:[ck]\s*)?ing\b/g, " fucking ")
      .replace(/f\s*[*#_\u2010-\u2015-]+\s*[ck]?(?=[^a-z0-9]|$)/g, " fuck ")
      .replace(/[^a-z0-9']+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeTranscriptText(text) {
    return normalizeText(text)
      .replace(/\bfu{3,}\b/g, " fuck ")
      .replace(/\bfu{2,}t\b/g, " fuck ")
      .replace(/\bshi{3,}\b/g, " shit ")
      .replace(/\bdickin'(?=\s|$)/g, " dickin ")
      .replace(/\bfuckingin'(?=\s|$)/g, " fucking ")
      .replace(/\b(?:ficking|fucken|vecking)\b/g, " fucking ")
      .replace(/\bfack\b/g, " fuck ")
      .replace(/\bbish\b/g, " bitch ")
      .replace(/\bpoozies\b/g, " pussies ")
      .replace(/\bmother\s+(fuckers?|fucking)\b/g, function joinMotherFucker(match, suffix) {
        return " mother" + suffix + " ";
      })
      .replace(/\bcock\s+sucker\b/g, " cocksucker ")
      .replace(/\bdip\s*shits?\b/g, " dip shit ")
      .replace(/\bship\s+storm\b/g, " shit storm ")
      .replace(/\bship\b/g, " shit ")
      .replace(/\bsheet\b/g, " shit ")
      .replace(/\bshoot\b/g, " shit ")
      .replace(/\bshuck(?:ing)?\b/g, " fuck ")
      .replace(/\bfuck(?:y|ie)\b/g, " fuck ")
      .replace(/\bfork\b/g, " fuck ")
      .replace(/\bduck\b/g, " fuck ")
      .replace(/\bbeach\b/g, " bitch ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function collapseStretchedWord(word) {
    return word.replace(/([a-z0-9'])\1+/g, "$1");
  }

  function transcriptEntries(transcript, candidates, fCandidatesBySlot) {
    var candidateByNormalizedWord = Object.create(null);
    var candidateByCollapsedWord = Object.create(null);
    var profanityIndex = 0;
    var markedTranscript = String(transcript || "").replace(MASKED_F_REGEX, " " + MASKED_F_MARKER + " ");

    (candidates || []).forEach(function indexCandidate(candidate) {
      var normalized = normalizeText(candidate);

      candidateByNormalizedWord[normalized] = candidate;
      candidateByCollapsedWord[collapseStretchedWord(normalized)] = candidate;
    });

    return normalizeTranscriptText(markedTranscript).split(" ").map(function resolveWord(word) {
      var candidate;

      if (word === MASKED_F_MARKER) {
        candidate = (fCandidatesBySlot && fCandidatesBySlot[profanityIndex] || [])[0] || "fuck";
      } else {
        candidate = candidateByNormalizedWord[word] || "";
        if (!candidate && /([a-z0-9'])\1{2,}/.test(word)) {
          candidate = candidateByCollapsedWord[collapseStretchedWord(word)] || "";
          if (candidate) candidate = word;
        }
      }
      if (candidate) profanityIndex += 1;
      return { word: word, candidate: candidate };
    });
  }

  function entryAfterAnchor(entries, previousWord, offset, afterIndex) {
    var anchor = normalizeText(previousWord).split(" ").pop();

    if (!anchor) return -1;
    function find(words) {
      return entries.reduce(function matchingAnchors(found, entry, index) {
        var candidate = entries[index + 1 + (offset || 0)];
        if (index > afterIndex && words.indexOf(entry.word) !== -1 && candidate && candidate.candidate &&
            entries.slice(index + 1, index + 1 + (offset || 0)).every(function adjacentCandidate(next) {
              return next.candidate;
            })) found.push(index + 1 + (offset || 0));
        return found;
      }, []);
    }

    var exact = find([anchor]);
    if (exact.length) return exact.length === 1 ? exact[0] : -1;
    var fallback = find(ANCHOR_HOMOPHONES[anchor] || []);
    return fallback.length === 1 ? fallback[0] : -1;
  }

  function alignedSlots(entries, options) {
    var cursor = -1;

    return (options && options.previousWords || []).map(function alignSlot(previousWord, slotIndex) {
      var index = entryAfterAnchor(entries, previousWord,
        options.previousWordOffsets && options.previousWordOffsets[slotIndex], cursor);
      var anchored = index >= 0;

      if (index < 0) {
        var reserved = (options.previousWords || []).slice(slotIndex + 1)
          .reduce(function reserveLaterAnchor(earliest, laterWord, laterIndex) {
            var laterSlot = slotIndex + 1 + laterIndex;
            var match = entryAfterAnchor(entries, laterWord,
              options.previousWordOffsets && options.previousWordOffsets[laterSlot], cursor);
            return match >= 0 && (earliest < 0 || match < earliest) ? match : earliest;
          }, -1);
        index = entries.findIndex(function nextUnusedProfanity(entry, entryIndex) {
          return entryIndex > cursor && (reserved < 0 || entryIndex < reserved) && entry.candidate;
        });
      }
      if (index < 0) return { word: "", evidence: "none" };
      cursor = index;
      return {
        word: entries[index].candidate,
        evidence: anchored ? "transcript-anchor" : "transcript"
      };
    });
  }

  function repairTranscriptForCandidates(transcript, candidates, allowWithExisting, context) {
    var candidateSet = new Set(candidates || []);
    var normalized = normalizeTranscriptText(transcript);
    var hasExisting = transcriptEntries(normalized, candidates, []).some(function hasCandidate(entry) {
      return Boolean(entry.candidate);
    });
    var value = String(transcript || "");
    var aliases = [
      [/\bmore\s+on\b/giu, "moron"],
      [/\bmorrow\b/giu, "moron"],
      [/\bshed\s*hole\b/giu, "shithole"],
      [/\bass\s+hole\b/giu, "asshole"],
      [/\bcocksy\b/giu, "cock"],
      [/\b(?:forkin|forking|fakin|fakins|fackin|fackins)\b/giu, "fucking"],
      [/\b(?:shh|shis|shiz)\b/giu, "shit"],
      [/\bbetch\b/giu, "bitch"],
      [/\bfock\b/giu, "fuck"]
    ];

    if (candidateSet.has("bitch") && !hasExisting) {
      value = value.replace(/\bbits\b/giu, " bitch ");
    }
    if (!allowWithExisting && hasExisting) return transcript;
    var normalizedContext = String(context || "").toLowerCase();
    if (candidateSet.has("cock") && (((normalizedContext.match(/\[\s*__\s*\]/gu) || []).length > 1) ||
        /(?:my|your|his|her|big|suck(?:ing)?)\s+\[\s*__\s*\]|\[\s*__\s*\]\s+push-ups\b/u.test(normalizedContext))) {
      value = value.replace(/\bcook\b/giu, " cock ");
    }
    if (candidateSet.has("shit") &&
        !/(?:night|day|work|gear)\s+\[\s*__\s*\]|\[\s*__\s*\]\s+(?:changed?|work|night|day|key|gear|schedule)\b/u.test(normalizedContext)) {
      value = value.replace(/\bshift\b/giu, " shit ");
    }
    if (candidateSet.has("shitting") &&
        /\[\s*__\s*\]\s+(?:myself|yourself|herself|himself|me|you|on)\b/u.test(normalizedContext)) {
      value = value.replace(/\bshedding\b/giu, " shitting ");
    }

    return aliases.reduce(function repair(repaired, alias) {
      return candidateSet.has(alias[1]) ? repaired.replace(alias[0], " " + alias[1] + " ") : repaired;
    }, value);
  }

  function repairTranscriptForContext(transcript, candidates, context) {
    var candidateSet = new Set(candidates || []);
    var value = String(transcript || "");
    var normalizedContext = String(context || "").toLowerCase();

    function replaceWhen(pattern, replacement, enabled) {
      if (enabled) value = value.replace(pattern, " " + replacement + " ");
    }

    replaceWhen(/\bobitious\b/giu, "bitches",
      candidateSet.has("bitches") && /sons?\s+of\s+\[\s*__\s*\]/u.test(normalizedContext));
    replaceWhen(/\bson'?s?\s+of\s+bitch\b/giu, "sons of bitches",
      candidateSet.has("bitches") && /sons?\s+of\s+\[\s*__\s*\]/u.test(normalizedContext));
    replaceWhen(/\bflocked\b/giu, "fucked",
      candidateSet.has("fucked") && /\[\s*__\s*\]\s+up\b/u.test(normalizedContext));
    replaceWhen(/\bfluke\b/giu, "fuck",
      candidateSet.has("fuck") && /get\s+the\s+\[\s*__\s*\]/u.test(normalizedContext));
    replaceWhen(/\bshout\b/giu, "fuck",
      candidateSet.has("fuck") && /shut\s+the\s+\[\s*__\s*\]\s+up\b/u.test(normalizedContext));
    replaceWhen(/\bfox\b/giu, "fuck",
      candidateSet.has("fuck") && /creature\s+of\s+the\s+\[\s*__\s*\]/u.test(normalizedContext));
    replaceWhen(/\bfock\b/giu, "fuck's",
      candidateSet.has("fuck's") && /\[\s*__\s*\]\s+sake\b/u.test(normalizedContext));
    return value;
  }

  function contextFWord(word, context) {
    var words;
    var slot;
    var previous;
    var previousTwo;
    var next;

    if (!/^(?:fuck|fucks|fuck's|fucking|fucked|fuckers?)$/.test(word)) return word;
    words = String(context || "").toLowerCase()
      .replace(/\u2019/g, "'")
      .replace(/\[\s*__\s*\]/g, " slot ")
      .replace(/[^a-z0-9']+/g, " ")
      .trim()
      .split(/\s+/);
    slot = words.indexOf("slot");
    if (slot < 0) return word;
    previous = words[slot - 1] || "";
    previousTwo = words[slot - 2] || "";
    next = words[slot + 1] || "";

    if (/^(?:what|whatever|where|who|why|how)$/.test(previousTwo) &&
        previous === "the" &&
        /^(?:is|are|was|were|did|do|does|am|this|that|what|who|why|how|where|when|you|i|we|they|he|she|it|up|out|off|happened|happening|going)$/.test(next)) {
      return "fuck";
    }
    if (previousTwo === "shut" && previous === "the" && next === "up") return "fuck";
    if ((previous === "jesus" && next === "christ") ||
        (previous === "god" && /^(?:damn|dammit)$/.test(next))) return "fucking";
    if (previous === "this" && /^(?:thing|game|guy|train|shit)$/.test(next)) return "fucking";
    if (previousTwo === "piece" && previous === "of" && next === "ass" && word === "fuck") {
      return "fucking";
    }
    if (/^(?:get|got|getting)$/.test(previous) &&
        (/^(?:up|by|over|now)$/.test(next) || previous === "getting" && !next)) return "fucked";
    return word;
  }

  function articleAllowsWord(word, context) {
    var beforeSlot = String(context || "").split(/\[\s*__\s*\]/u)[0] || "";
    var article = /\b(an?)\s*$/iu.exec(beforeSlot);

    if (!word || !article) return true;
    return article[1].toLowerCase() === (/^[aeiou]/iu.test(word) ? "an" : "a");
  }

  function hiddenCompoundPart(word, context) {
    var normalizedContext = String(context || "").toLowerCase();

    if (["fuck", "fucks", "fuck's"].indexOf(word) !== -1 &&
        /\[\s*__\s*\]\s+sake\b/u.test(normalizedContext)) return "fuck's";
    if (word === "clusterfuck" && /\bcluster\s+\[\s*__\s*\]/u.test(normalizedContext)) return "fuck";
    return word;
  }

  function candidateBeforeContextTail(candidates, context, transcript) {
    var marker = /\[\s*__\s*\]/u.exec(String(context || ""));
    var tail;
    var transcriptWords;
    var candidateSet;
    var matches = [];
    var index;

    if (!marker) return "";
    tail = normalizeText(String(context || "").slice(marker.index + marker[0].length))
      .split(" ").filter(Boolean);
    // An ellipsis means another hidden slot sits between this slot and the tail.
    if (!tail.length || /^\s*(?:…|\.\.\.)/u.test(String(context || "").slice(marker.index + marker[0].length))) {
      return "";
    }
    transcriptWords = normalizeText(transcript).split(" ").filter(Boolean);
    candidateSet = new Set(candidates || []);
    for (index = 0; index + tail.length <= transcriptWords.length; index += 1) {
      if (!tail.every(function matchesTail(word, offset) {
        return transcriptWords[index + offset] === word;
      }) || index === 0) {
        continue;
      }
      // Use the raw normalized transcript here. This deliberately excludes
      // approximate aliases such as "shh" -> "shit" from reanchoring.
      if (candidateSet.has(transcriptWords[index - 1])) matches.push(transcriptWords[index - 1]);
    }
    return matches.length && matches.every(function sameCandidate(word) {
      return word === matches[0];
    }) ? matches[0] : "";
  }

  function candidateAtTranscriptTail(candidates, context, transcript) {
    var marker = /\[\s*__\s*\]/u.exec(String(context || ""));
    var after;
    var entries;

    if (!marker) return "";
    after = String(context || "").slice(marker.index + marker[0].length).trim();
    if (/(?:…|\.\.)/u.test(after) || !/^[.,!?;:'"’\])]*$/u.test(after)) return "";
    entries = transcriptEntries(transcript, candidates, []);
    return entries.length && entries[entries.length - 1].candidate || "";
  }

  function decisionFromTranscript(transcript, candidates, context, options) {
    var originalTranscript = String(transcript || "");
    var fCandidates = options && options.fCandidates || [];
    var normalizedContext = String(context || "").toLowerCase();
    if (/(?:what|why)\s+the\s+\[\s*__\s*\]/u.test(normalizedContext)) {
      transcript = String(transcript || "").replace(/\b(?:waterfuck|fucka's|fucker's)\b/giu, "fuck");
    }
    if (/\[\s*__\s*\]\s+my\s+pants\b/u.test(normalizedContext)) {
      transcript = String(transcript || "").replace(/\bshits\b/giu, "shit");
    }
    if (/\[\s*__\s*\]\s+made\b/u.test(normalizedContext)) {
      transcript = String(transcript || "").replace(/\bfucka\b/giu, "fucker");
    }
    if (/\b(?:gambling|horse)\s+\[\s*__\s*\]/u.test(normalizedContext)) {
      transcript = String(transcript || "").replace(/\b(?:gamni|ho)shit\b/giu, "shit");
    }
    if (/(?:\b(?:these|those|y'all)\s+\[\s*__\s*\]|\[\s*__\s*\]\s+(?:are|were|have|want)\b)/u.test(normalizedContext)) {
      transcript = String(transcript || "").replace(/\bmotherfucker's\b/giu, "motherfuckers");
    } else if (/\b(?:this|that|a)\s+\[\s*__\s*\]|\[\s*__\s*\]\s+(?:is|was|has|does|started)\b/u.test(normalizedContext)) {
      transcript = String(transcript || "").replace(/\bmotherfucker's\b/giu, "motherfucker");
    }
    if ((candidates || []).indexOf("cum") !== -1 && /\[\s*__\s*\]\s+joke\b/iu.test(context || "")) {
      transcript = String(transcript || "").replace(/\bcome(?=\s+joke\b)/giu, "cum");
    }
    if ((candidates || []).indexOf("fuck's") !== -1 &&
        /\[\s*__\s*\]\s+sake\b/iu.test(context || "")) {
      transcript = String(transcript || "")
        .replace(/\b(?:fock|fox|flux|flax)(?=\s+sake\b)/giu, "fuck")
        .replace(/\b(?:fock|fox|flux|flax)(?=\s+like\b)/giu, "fuck");
      if ((candidates || []).indexOf("fuck") === -1) candidates = candidates.concat("fuck");
    }
    transcript = repairTranscriptForContext(transcript, candidates, context);
    transcript = repairTranscriptForCandidates(transcript, candidates,
      Boolean(options && (options.previousWord || options.previousWords || options.slotCount > 1)), context);
    var entries = transcriptEntries(transcript, candidates,
      options && options.fCandidatesBySlot || [fCandidates]);
    var words = entries.map(function candidateWord(entry) {
      return entry.candidate;
    }).filter(Boolean);
    var distinctWords = words.filter(function uniqueWord(candidate, index) {
      return words.indexOf(candidate) === index;
    });
    var slots = alignedSlots(entries, options);
    var slotWords = slots.map(function slotWord(slot) { return slot.word; });
    if (options && Array.isArray(options.contexts)) {
      slotWords = slotWords.map(function refineSlotWord(slotWord, slotIndex) {
        var slotContext = options.contexts[slotIndex];
        slotWord = (!MASKED_F_TEST_REGEX.test(String(transcript || "")) &&
          candidateBeforeContextTail(candidates, slotContext, originalTranscript)) || slotWord;
        slotWord = contextFWord(slotWord, slotContext);
        return articleAllowsWord(slotWord, slotContext) ? slotWord : "";
      });
    }
    var anchoredIndex = entryAfterAnchor(entries, options && options.previousWord,
      options && options.previousWordOffset, -1);
    var anchoredWord = anchoredIndex < 0 ? "" : entries[anchoredIndex].candidate;
    var decisionContext = options && Array.isArray(options.contexts)
      ? options.contexts[options.slotOrdinal || 0] : context;
    var tailWord = MASKED_F_TEST_REGEX.test(String(transcript || ""))
      ? "" : candidateBeforeContextTail(candidates, decisionContext, originalTranscript);
    if (!tailWord && !anchoredWord) {
      tailWord = candidateAtTranscriptTail(candidates, decisionContext, originalTranscript);
    }
    var word;
    var evidence = "none";

    if (options && options.slotCount > 1) {
      word = slotWords[options.slotOrdinal || 0] || words[options.slotOrdinal || 0] || "";
    } else if (tailWord && tailWord !== anchoredWord) {
      word = tailWord;
      evidence = "transcript-tail";
    } else if (anchoredWord) {
      word = anchoredWord;
      evidence = "transcript-anchor";
    } else if (MASKED_F_TEST_REGEX.test(String(transcript || ""))) {
      word = fCandidates[0] || "fuck";
      evidence = fCandidates.length ? "masked-f-rule" : "masked-f-fallback";
    } else if (fCandidates.length) {
      word = fCandidates.find(function matchingFRule(candidate) {
        return words.indexOf(candidate) !== -1;
      }) || words[0] || "";
    } else {
      word = distinctWords.length === 1 ? distinctWords[0] : "";
    }
    word = hiddenCompoundPart(word, context);
    var refinedWord = contextFWord(word, context);
    if (refinedWord !== word && evidence !== "transcript-anchor") evidence = "transcript-context";
    word = refinedWord;
    if (!articleAllowsWord(word, decisionContext)) {
      word = "";
      evidence = "none";
    } else if (word && evidence === "none") {
      evidence = "transcript";
    }

    return {
      word: word,
      words: words,
      slotWords: slotWords,
      slotEvidence: slots.map(function slotEvidence(slot, slotIndex) {
        return slotWords[slotIndex] ? slot.evidence : "none";
      }),
      transcript: transcript || "",
      evidence: evidence
    };
  }

  function transcribeDetailed(audio, candidates, context, options) {
    if (!audio || !audio.length || !candidates || !candidates.length) {
      return Promise.resolve({
        word: "",
        transcript: "",
        evidence: "none"
      });
    }

    return getTranscriber().then(function runTranscriber(transcriber) {
      return transcriber(audio, {
        max_new_tokens: Math.max(32, ((options && options.slotCount) || 1) * 4)
      });
    }).then(function chooseCandidate(result) {
      var transcript = typeof result === "string" ? result : result && result.text;
      return decisionFromTranscript(transcript, candidates, context, options);
    }).catch(function keepToken(error) {
      debugLog("whisper transcription failed", errorDetails(error));
      return {
        word: "",
        transcript: "",
        evidence: "none"
      };
    });
  }

  var exports = Object.freeze({
    preload: function preload() {
      return getTranscriber().then(function loaded() {
        return true;
      });
    },
    transcribeDetailed: transcribeDetailed,
    normalizeText: normalizeText,
    decisionFromTranscript: decisionFromTranscript
  });

  root.UncensoredWhisperLocal = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
