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
  var SLOT_MARKER = "slotmarker";
  var SLOT_TOKEN_REGEX = /\[\s*__\s*\]/gu;
  var CONTEXT_PATTERNS = Object.freeze([
    [new RegExp("what the " + SLOT_MARKER), ["fuck"]],
    [new RegExp("why the " + SLOT_MARKER), ["fuck"]],
    [new RegExp("how the " + SLOT_MARKER), ["fuck"]],
    [new RegExp("who the " + SLOT_MARKER), ["fuck"]],
    [new RegExp("where the " + SLOT_MARKER), ["fuck"]],
    [new RegExp("the " + SLOT_MARKER + " (?:is|are|was|were|did|does|do|you|am|can)"), ["fuck"]],
    [new RegExp("shut the " + SLOT_MARKER + " up"), ["fuck"]],
    [new RegExp("shut the " + SLOT_MARKER + "$"), ["fuck"]],
    [new RegExp("get the " + SLOT_MARKER), ["fuck"]],
    [new RegExp(SLOT_MARKER + " you"), ["fuck"]],
    [new RegExp("for " + SLOT_MARKER + " sake"), ["fuck's", "fuck"]],
    [new RegExp(SLOT_MARKER + " sake"), ["fuck's", "fuck"]],
    [new RegExp("holy " + SLOT_MARKER), ["shit", "fuck"]],
    [new RegExp("oh " + SLOT_MARKER), ["shit", "fuck"]],
    [new RegExp("a lot of " + SLOT_MARKER), ["shit"]],
    [new RegExp("piece of " + SLOT_MARKER), ["shit"]],
    [new RegExp("your " + SLOT_MARKER), ["shit", "fucking", "bullshit"]],
    [new RegExp("my " + SLOT_MARKER), ["fucking", "shit"]],
    [new RegExp("every .* " + SLOT_MARKER + " seconds?"), ["fucking"]],
    [new RegExp("so " + SLOT_MARKER), ["fucking"]],
    [new RegExp("did you just " + SLOT_MARKER), ["fucking"]],
    [new RegExp("not " + SLOT_MARKER + " \\w+"), ["fucking"]],
    [new RegExp("being " + SLOT_MARKER + " \\w+"), ["fucking"]],
    [new RegExp(SLOT_MARKER + " (?:filter|awesome|convert|pirate|installs|look|watch|seconds?)"), ["fucking", "bullshit"]],
    [new RegExp(SLOT_MARKER + " (?:tsundere|nonchalant)"), ["fucking"]],
    [new RegExp(SLOT_MARKER + " it"), ["fuck"]],
    [new RegExp(SLOT_MARKER + " instead"), ["shit"]],
    [new RegExp(SLOT_MARKER + " to do"), ["shit"]],
    [new RegExp("beat the " + SLOT_MARKER + " out"), ["shit"]],
    [new RegExp(SLOT_MARKER + " explain"), ["fucking"]],
    [new RegExp(SLOT_MARKER + " pirate"), ["fucking"]],
    [new RegExp("stupid ass " + SLOT_MARKER), ["bitch", "motherfucker", "fucker"]],
    [new RegExp(SLOT_MARKER + " family"), ["fucking"]],
    [new RegExp(SLOT_MARKER + " cringe"), ["fucking"]]
  ]);
  var GIVE_A_SLOT_REGEX = new RegExp("give[s]? a " + SLOT_MARKER);
  var THE_SLOT_REGEX = new RegExp("the " + SLOT_MARKER);
  var SHUT_THE_SLOT_REGEX = new RegExp("shut the " + SLOT_MARKER + "(?: up)?$|shut the " + SLOT_MARKER + " up");
  var SLOT_OBJECT_REGEX = new RegExp(SLOT_MARKER + " (?:filter|convert|pirate|installs|look|seconds?)");
  var SLOT_INTENSIFIER_REGEX = new RegExp("did you just " + SLOT_MARKER + "|not " + SLOT_MARKER + " \\w+|being " + SLOT_MARKER + " \\w+|" + SLOT_MARKER + " (?:tsundere|nonchalant)");
  var SLOT_SHIT_REGEX = new RegExp(SLOT_MARKER + " to do|a lot of " + SLOT_MARKER + "|beat the " + SLOT_MARKER + " out");
  var OH_HOLY_SLOT_REGEX = new RegExp("oh " + SLOT_MARKER + "|holy " + SLOT_MARKER);
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

    root.console.debug.apply(root.console, ["[uncensored]"].concat(Array.prototype.slice.call(arguments)));
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

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  function contextCandidates(context) {
    var normalized = normalizeText(String(context || "").replace(SLOT_TOKEN_REGEX, " " + SLOT_MARKER + " "));
    var candidates = [];

    CONTEXT_PATTERNS.forEach(function testPattern(entry) {
      if (entry[0].test(normalized)) {
        candidates = candidates.concat(entry[1]);
      }
    });

    return unique(candidates);
  }

  function wordsAroundSlot(context) {
    var normalized = normalizeText(String(context || "").replace(SLOT_TOKEN_REGEX, " " + SLOT_MARKER + " "));
    var words = normalized.split(/\s+/);
    var slotIndex = words.indexOf(SLOT_MARKER);

    if (slotIndex === -1) {
      return {
        before: [],
        after: []
      };
    }

    return {
      before: words.slice(Math.max(0, slotIndex - 3), slotIndex).filter(function keepWord(word) {
        return word !== SLOT_MARKER;
      }),
      after: words.slice(slotIndex + 1, slotIndex + 4).filter(function keepWord(word) {
        return word !== SLOT_MARKER;
      })
    };
  }

  function phrasePrior(candidate, context) {
    var normalized = normalizeText(String(context || "").replace(SLOT_TOKEN_REGEX, " " + SLOT_MARKER + " "));
    var candidateText = normalizeText(candidate);

    if (GIVE_A_SLOT_REGEX.test(normalized)) {
      return candidateText === "fuck" || candidateText === "shit" ? 4 : 0;
    }

    if (/what|why|how|who|where/.test(normalized) && THE_SLOT_REGEX.test(normalized)) {
      return candidateText === "fuck" ? 5 : 0;
    }

    if (SHUT_THE_SLOT_REGEX.test(normalized)) {
      return candidateText === "fuck" ? 4 : 0;
    }

    if (SLOT_OBJECT_REGEX.test(normalized)) {
      return candidateText === "fucking" ? 4 : 0;
    }

    if (SLOT_INTENSIFIER_REGEX.test(normalized)) {
      return candidateText === "fucking" ? 5 : 0;
    }

    if (SLOT_SHIT_REGEX.test(normalized)) {
      return candidateText === "shit" ? 4 : 0;
    }

    if (OH_HOLY_SLOT_REGEX.test(normalized)) {
      return candidateText === "shit" ? 3 : candidateText === "fuck" ? 2 : 0;
    }

    return 0;
  }

  function scoreCandidate(transcript, candidate, context) {
    var normalizedTranscript = normalizeTranscriptText(transcript);
    var rawTranscript = String(transcript || "").toLowerCase();
    var candidateText = normalizeText(candidate);
    var around = wordsAroundSlot(context);
    var candidateRegex = new RegExp("(^|\\s)" + escapeRegExp(candidateText) + "(?=\\s|$)");
    var ambiguousCensoredFuck = /(^|\s)f\s*[*-]+(?=\s|$)/.test(rawTranscript);
    var score = phrasePrior(candidate, context);

    if (candidateRegex.test(normalizedTranscript) && !(ambiguousCensoredFuck && candidateText === "fuck")) {
      score += 10;
    }

    around.before.forEach(function scoreBefore(word) {
      if (word && normalizedTranscript.indexOf(word + " " + candidateText) !== -1) {
        score += 3;
      }
    });

    around.after.forEach(function scoreAfter(word) {
      if (word && normalizedTranscript.indexOf(candidateText + " " + word) !== -1) {
        score += 3;
      }
    });

    var contextDerived = contextCandidates(context);
    if (contextDerived.indexOf(candidate) !== -1) {
      score += 4;
    }

    if (candidateText === "fucking" && /(^|\s)f\s*[*-]+\s/.test(rawTranscript)) {
      score += 8;
    }

    return score;
  }

  function transcriptCandidates(transcript, candidates) {
    var allowed = (candidates || []).map(normalizeText);

    return normalizeTranscriptText(transcript).split(" ").filter(function allowedCandidate(word) {
      return allowed.indexOf(word) !== -1;
    });
  }

  function rankedCandidatesFromTranscript(transcript, candidates, context) {
    var contextDerived = contextCandidates(context);
    var candidatePool = unique(contextDerived.concat(candidates || []));

    return candidatePool.map(function normalizeCandidate(candidate) {
      return {
        original: candidate,
        normalized: normalizeText(candidate),
        score: scoreCandidate(transcript, candidate, context)
      };
    }).sort(function sortByScore(left, right) {
      return right.score - left.score;
    });
  }

  function decisionFromTranscript(transcript, candidates, context, options) {
    var force = options && options.force;

    if (options && options.slotCount > 1) {
      var words = transcriptCandidates(transcript, candidates);
      var positional = words[options.slotOrdinal || 0];

      return {
        word: positional || "",
        words: words,
        score: positional ? scoreCandidate(transcript, positional, context) : 0,
        runnerUpScore: 0,
        transcript: transcript || "",
        forced: Boolean(force)
      };
    }

    var ranked = rankedCandidatesFromTranscript(transcript, candidates, context);
    var positive = ranked.filter(function hasScore(candidate) {
      return candidate.score > 0;
    });
    var best = positive[0] || ranked[0];
    var runnerUp = positive[1] || ranked[1] || null;

    if (!best) {
      return {
        word: "",
        score: 0,
        runnerUpScore: 0,
        transcript: transcript || "",
        forced: Boolean(force)
      };
    }

    if (positive.length && (force || positive.length === 1 || best.score > (runnerUp ? runnerUp.score : 0))) {
      return {
        word: best.original,
        score: best.score,
        runnerUpScore: runnerUp ? runnerUp.score : 0,
        transcript: transcript || "",
        forced: Boolean(force)
      };
    }

    return {
      word: "",
      score: best.score,
      runnerUpScore: runnerUp ? runnerUp.score : 0,
      transcript: transcript || "",
      forced: false
    };
  }

  function fallbackDecision(candidates, context, options) {
    var decision = decisionFromTranscript("", candidates, context, options);

    if (decision.score <= 0 && options && options.force) {
      var fallbackCandidates = unique(contextCandidates(context).concat(candidates || []));
      if (fallbackCandidates.length) {
        decision.word = fallbackCandidates[0];
        decision.forced = true;
      }
    } else if (decision.score <= 0) {
      decision.word = "";
    }

    return decision;
  }

  function transcribeDetailed(audio, candidates, context, options) {
    if (!audio || !audio.length || !candidates || !candidates.length) {
      return Promise.resolve(options && options.force
        ? fallbackDecision(candidates, context, options)
        : {
          word: "",
          score: 0,
          runnerUpScore: 0,
          transcript: "",
          forced: false
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
      return options && options.force
        ? fallbackDecision(candidates, context, options)
        : {
          word: "",
          score: 0,
          runnerUpScore: 0,
          transcript: "",
          forced: false
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
