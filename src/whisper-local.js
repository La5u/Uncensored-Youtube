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
          ? currentLocation.replace(/src\/(?:whisper-local|whisper-module-worker|whisper-worker)\.js(?:\?.*)?$/, "")
        : "";
  var DEFAULT_MODEL = "whisper-tiny.en";
  var MASKED_F_REGEX = /\bf\s*[*-]+(?=\s|[.,!?]|$)/giu;
  var MASKED_F_TEST_REGEX = /\bf\s*[*-]+(?=\s|[.,!?]|$)/iu;
  var MASKED_F_MARKER = "maskedfword";
  var transcriberPromise = null;

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

  function loadTransformers() {
    if (root.transformers && root.transformers.pipeline) {
      return Promise.resolve(root.transformers);
    }

    return Promise.reject(new Error("Transformers.js module is unavailable"));
  }

  function getTranscriber() {
    if (!transcriberPromise) {
      transcriberPromise = loadTransformers().then(function createPipeline(transformers) {
        if (!transformers || !transformers.pipeline) {
          throw new Error("Transformers.js pipeline is unavailable");
        }

        debugLog("loading whisper model", {
          model: DEFAULT_MODEL,
          baseUrl: baseUrl
        });

        if (transformers.env && transformers.env.localModelPath !== undefined) {
          transformers.env.localModelPath = baseUrl + "src/models/";
          transformers.env.allowRemoteModels = false;
          transformers.env.allowLocalModels = true;
          if (baseUrl.indexOf("chrome-extension://") === 0) {
            transformers.env.useBrowserCache = false;
            transformers.env.useWasmCache = false;
          }
        }

        if (transformers.env && transformers.env.backends && transformers.env.backends.onnx && transformers.env.backends.onnx.wasm) {
          transformers.env.backends.onnx.wasm.wasmPaths = {
            wasm: baseUrl + "src/vendor/ort-wasm-simd-threaded.asyncify.wasm"
          };
          transformers.env.backends.onnx.wasm.proxy = false;
          transformers.env.backends.onnx.wasm.numThreads = 1;
        }

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
      .replace(/\bf[\W_]*\*{2,}/g, " fuck ")
      .replace(/\bf[\W_]*-+/g, " fuck ")
      .replace(/\bf\*+/g, " fuck ")
      .replace(/[^a-z0-9']+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeTranscriptText(text) {
    return normalizeText(text)
      .replace(/\bmother\s+fucker\b/g, " motherfucker ")
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

  function transcriptEntries(transcript, candidates, fCandidatesBySlot) {
    var candidateByNormalizedWord = Object.create(null);
    var profanityIndex = 0;
    var markedTranscript = String(transcript || "").replace(MASKED_F_REGEX, " " + MASKED_F_MARKER + " ");

    (candidates || []).forEach(function indexCandidate(candidate) {
      candidateByNormalizedWord[normalizeText(candidate)] = candidate;
    });

    return normalizeTranscriptText(markedTranscript).split(" ").map(function resolveWord(word) {
      var candidate;

      if (word === MASKED_F_MARKER) {
        candidate = (fCandidatesBySlot && fCandidatesBySlot[profanityIndex] || [])[0] || "fuck";
      } else {
        candidate = candidateByNormalizedWord[word] || "";
      }
      if (candidate) profanityIndex += 1;
      return { word: word, candidate: candidate };
    });
  }

  function entryAfterAnchor(entries, previousWord, offset, afterIndex) {
    var anchor = normalizeText(previousWord).split(" ").pop();
    var match = -1;
    var matchCount = 0;

    if (!anchor) return -1;
    if (anchor === "too" || anchor === "two") anchor = "to";
    entries.forEach(function matchingAnchor(entry, index) {
      var word = entry.word === "too" || entry.word === "two" ? "to" : entry.word;
      var candidate = entries[index + 1 + (offset || 0)];
      if (index > afterIndex && word === anchor && candidate && candidate.candidate &&
          entries.slice(index + 1, index + 1 + (offset || 0)).every(function adjacentCandidate(next) {
            return next.candidate;
          })) {
        match = index + 1 + (offset || 0);
        matchCount += 1;
      }
    });
    return matchCount === 1 ? match : -1;
  }

  function wordAfterAnchor(entries, previousWord, offset) {
    var index = entryAfterAnchor(entries, previousWord, offset, -1);
    return index < 0 ? "" : entries[index].candidate;
  }

  function alignedSlotWords(entries, options) {
    var cursor = -1;

    return (options && options.previousWords || []).map(function alignSlot(previousWord, slotIndex) {
      var index = entryAfterAnchor(entries, previousWord,
        options.previousWordOffsets && options.previousWordOffsets[slotIndex], cursor);

      if (index < 0) {
        index = entries.findIndex(function nextUnusedProfanity(entry, entryIndex) {
          return entryIndex > cursor && entry.candidate;
        });
      }
      if (index < 0) return "";
      cursor = index;
      return entries[index].candidate;
    });
  }

  function decisionFromTranscript(transcript, candidates, context, options) {
    var fCandidates = options && options.fCandidates || [];
    if ((candidates || []).indexOf("cum") !== -1 && /\[\s*__\s*\]\s+joke\b/iu.test(context || "")) {
      transcript = String(transcript || "").replace(/\bcome(?=\s+joke\b)/giu, "cum");
    }
    var entries = transcriptEntries(transcript, candidates,
      options && options.fCandidatesBySlot || [fCandidates]);
    var words = entries.map(function candidateWord(entry) {
      return entry.candidate;
    }).filter(Boolean);
    var slotWords = alignedSlotWords(entries, options);
    var anchoredWord = wordAfterAnchor(entries, options && options.previousWord,
      options && options.previousWordOffset);
    var word;
    var evidence = "none";

    if (options && options.slotCount > 1) {
      word = slotWords[options.slotOrdinal || 0] || words[options.slotOrdinal || 0] || "";
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
      word = words[0] || "";
    }
    if (word && evidence === "none") evidence = "transcript";

    return {
      word: word,
      words: words,
      slotWords: slotWords,
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
