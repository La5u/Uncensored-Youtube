(function buildWhisperLocal() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var runtime = root.browser || root.chrome;
  var currentLocation = root.location && root.location.href || "";
  var baseUrl = runtime && runtime.runtime && runtime.runtime.getURL
    ? runtime.runtime.getURL("")
    : currentLocation
      ? currentLocation.replace(/src\/(?:whisper-local|whisper-module-worker)\.js(?:\?.*)?$/, "")
      : "";
  var DEFAULT_MODEL = "whisper-tiny.en";
  var transcriberPromise = null;
  var warmedUp = false;

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
          // "basic" halves decoder step time (2026-11-17); "all" fails to load the q8 decoder and
          // gains the encoder only ~3%.
          session_options: {
            graphOptimizationLevel: "basic"
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

  // Hybrid: a word heard by Whisper replaces the provisional rule fill (flagged so
  // it outranks the cached rule); if Whisper abstains, the rule fill remains.
  function arbitrateHybridResolution(ruleWord, resolution, ruleSource) {
    if (!resolution || !resolution.word) {
      return ruleWord ? Object.assign({
        word: ruleWord, words: [ruleWord], source: ruleSource || "deterministic", evidence: "rule"
      }, resolution && resolution.head ? { head: resolution.head } : {}) : resolution;
    }
    return ruleWord ? Object.assign({}, resolution, { hybridCrossFamily: true }) : resolution;
  }

  var SOT = [50257, 50362]; // <|startoftranscript|><|notimestamps|>
  var PAD = 50256;
  // Calibrated 2026-09-24 on development audio (docs/SESSION_HANDOFF.md): fill only
  // when the best candidate's log probability after the caption prefix is ≥ -4.
  var MIN_LOG_PROB = -4;
  // Each batch row copies the window's cross-attention cache; keep batches small.
  var BATCH = 4;

  function logProbs(data, offset, vocab) {
    var max = -Infinity;
    var sum = 0;
    var i;

    for (i = 0; i < vocab; i += 1) if (data[offset + i] > max) max = data[offset + i];
    for (i = 0; i < vocab; i += 1) sum += Math.exp(data[offset + i] - max);
    return function logProb(id) {
      return data[offset + id] - max - Math.log(sum);
    };
  }

  function logSumExp(left, right) {
    return Math.max(left, right) + Math.log1p(Math.exp(-Math.abs(left - right)));
  }

  function disposeAll(values, retained) {
    // Tensor wrappers can share an ORT tensor; never dispose borrowed or carried caches.
    var seen = new Set((retained || []).map(function identity(value) { return value && (value.ort_tensor || value); }));
    values.forEach(function dispose(value) {
      var identity = value && (value.ort_tensor || value);
      if (value && value.dispose && !seen.has(identity)) {
        seen.add(identity);
        value.dispose();
      }
    });
  }

  function repeat(transformers, tensor, count) {
    return transformers.cat(Array(count).fill(tensor), 0);
  }

  // Whisper pads every input with silence to 30 s (3000 frames), 61-63% of a typical window.
  // Encode only the real audio plus 2 s of silence (the encoder accepts fewer frames; see
  // docs/DEVELOPMENT.md): log-mel of the real audio (a zero tail keeps the last STFT window
  // identical), the rest filled with the value silence normalises to: (max(logMax - 8, log10(1e-10)) + 4) / 4.
  var SILENCE_TAIL_FRAMES = 200;
  async function extractFeatures(transformers, asr, audio) {
    var extractor = asr.processor.feature_extractor;
    var hop = extractor.config.hop_length;
    var maxFrames = extractor.config.nb_max_frames;
    var frames = Math.min(maxFrames, 2 * Math.ceil((audio.length / hop + SILENCE_TAIL_FRAMES) / 2));
    var waveform = new Float32Array(Math.min(audio.length + extractor.config.n_fft, maxFrames * hop));
    var mel;
    var used;
    var data = new Float32Array(extractor.config.feature_size * frames);
    var maxValue = -Infinity;
    var bin;
    var index;

    if (waveform.length === maxFrames * hop) {
      return (await asr.processor(audio)).input_features;
    }
    waveform.set(audio.subarray(0, waveform.length));
    mel = await extractor._extract_fbank_features(waveform);
    try {
      used = Math.min(mel.dims[1], frames);
      for (index = 0; index < mel.data.length; index += 1) maxValue = Math.max(maxValue, mel.data[index]);
      data.fill((Math.max(4 * maxValue - 4 - 8, -10) + 4) / 4);
      for (bin = 0; bin < mel.dims[0]; bin += 1) {
        data.set(mel.data.subarray(bin * mel.dims[1], bin * mel.dims[1] + used), bin * frames);
      }
      return new transformers.Tensor("float32", data, [1, mel.dims[0], frames]);
    } finally {
      mel.dispose();
    }
  }

  // One encoding serves every slot in the window.
  async function encodeAudio(transformers, asr, audio) {
    var features = await extractFeatures(transformers, asr, audio);
    try {
      // Fetch only the hidden state; the unused attention maps are ~216 MB per window.
      var encoded = await asr.model.sessions.model.run({ input_features: features.ort_tensor }, ["last_hidden_state"]);
      return new transformers.Tensor(encoded.last_hidden_state);
    } finally {
      features.dispose();
    }
  }

  // Closed-set scoring: teacher-force each candidate (lower-case and capitalised)
  // after the caption words heard since the window start, then the next caption
  // word. Gate on log P(candidate); choose among gated words by log P(candidate + next).
  // Every decision also carries `scores` (decoded words) and `prunedMax` (best first-token bound of
  // the variants not decoded; -Infinity when none), which the acoustic head reads.
  async function scoreCandidates(transformers, asr, hidden, candidates, options) {
    var tokenizer = asr.tokenizer;
    var model = asr.model;
    var encode = function encode(text) {
      return tokenizer.encode(text, { add_special_tokens: false });
    };
    var prefix = String(options && options.prefix || "").trim();
    var nextWord = normalizeText(options && options.nextWord || "").split(" ")[0] || "";
    var prefixIds = SOT.concat(prefix ? encode(" " + prefix) : []);
    var nextIds = nextWord ? encode(" " + nextWord) : [];
    var prefixTensor = new transformers.Tensor("int64", BigInt64Array.from(prefixIds.map(BigInt)), [1, prefixIds.length]);
    var pre;
    try {
      try {
        pre = await model({ encoder_outputs: hidden, decoder_input_ids: prefixTensor });
      } finally {
        prefixTensor.dispose();
      }
      var vocab = pre.logits.dims[2];
      var first = logProbs(pre.logits.data, (prefixIds.length - 1) * vocab, vocab);
      var scores = Object.create(null);
      // A variant's first token bounds its score. Keep variants within 2 of the gate
      // because capitalised and lower-case variants are summed per word.
      var live = [];
      var prunedMax = -Infinity;
      var start;
      var best = "";

      candidates.forEach(function addVariants(word) {
        [word, word.charAt(0).toUpperCase() + word.slice(1)].forEach(function addVariant(form, index) {
          var ids = encode(" " + form);
          if (index && form === word) return;
          if (first(ids[0]) >= MIN_LOG_PROB - 2) live.push({ word: word, ids: ids.concat(nextIds), length: ids.length });
          else prunedMax = Math.max(prunedMax, first(ids[0]));
        });
      });

      for (start = 0; start < live.length; start += BATCH) {
        var batch = live.slice(start, start + BATCH);
        var size = batch.length;
        var width = Math.max.apply(null, batch.map(function length(item) { return item.ids.length; }));
        var sums = batch.map(function firstToken(item) { return [first(item.ids[0])]; });
        var encoderBatch = null;
        var past = {};
        var step;

        try {
          encoderBatch = repeat(transformers, hidden, size);
          Object.keys(pre).forEach(function copyCache(name) {
            if (name.indexOf("present.") === 0) {
              past[name.replace("present.", "past_key_values.")] = repeat(transformers, pre[name], size);
            }
          });
          // The exported cached decoder has no causal mask across several new tokens,
          // so feed one token per step.
          for (step = 0; step < width - 1; step += 1) {
            var column = BigInt64Array.from(batch.map(function tokenAt(item) {
              return BigInt(item.ids[step] === undefined ? PAD : item.ids[step]);
            }));
            var stepTensor = new transformers.Tensor("int64", column, [size, 1]);
            var out = null;
            try {
              out = await model({
                encoder_outputs: encoderBatch,
                decoder_input_ids: stepTensor,
                past_key_values: past
              });
              var nextPast = Object.assign({}, past);

              batch.forEach(function addStep(item, row) {
                if (item.ids[step + 1] !== undefined) {
                  sums[row].push(logProbs(out.logits.data, row * vocab, vocab)(item.ids[step + 1]));
                }
              });
              Object.keys(out).forEach(function carryCache(name) {
                if (name.indexOf("present.") === 0 && name.indexOf(".encoder.") === -1) {
                  nextPast[name.replace("present.", "past_key_values.")] = out[name];
                }
              });
              disposeAll(Object.values(past), Object.values(nextPast));
              past = nextPast;
            } finally {
              stepTensor.dispose();
              if (out) disposeAll(Object.values(out), Object.values(past).concat(encoderBatch));
            }
          }
          batch.forEach(function addScore(item, row) {
            var word = sums[row].slice(0, item.length).reduce(function add(a, b) { return a + b; }, 0);
            var withNext = sums[row].reduce(function add(a, b) { return a + b; }, 0);
            var prior = scores[item.word];
            scores[item.word] = prior
              ? { word: logSumExp(prior.word, word), withNext: logSumExp(prior.withNext, withNext) }
              : { word: word, withNext: withNext };
          });
        } finally {
          disposeAll(Object.values(past).concat(encoderBatch));
        }
      }

      Object.keys(scores).forEach(function chooseWord(word) {
        if (scores[word].word < MIN_LOG_PROB) return;
        if (!best || scores[word].withNext > scores[best].withNext) best = word;
      });
      return Object.assign(best
        ? { word: best, words: [best], transcript: "", evidence: "candidate-score", score: scores[best].word }
        : emptyDecision(), {
        scores: Object.keys(scores).map(function scoreEntry(word) {
          return { word: word, logp: scores[word].word, withNext: scores[word].withNext };
        }),
        prunedMax: prunedMax
      });
    } finally {
      if (pre) disposeAll(Object.values(pre), [hidden]);
    }
  }

  function emptyDecision() {
    return { word: "", transcript: "", evidence: "none" };
  }

  // Each slot: { tokenIndex, prefix, nextWord, hybridRuleWord, hybridRuleSource }. The prefix is
  // text or timed caption words, where an earlier blank ({ tokenIndex }) is replaced by the
  // word heard for that slot in this window, else dropped: adjacent blanks would otherwise
  // share one prefix and repeat the same word.
  // Optional (off unless options.acousticHead is a parsed src/acoustic-head.js model and the slot
  // has `time`, seconds from the audio start): where the decoder abstained or nearly tied, the
  // acoustic head may fill the slot ("acoustic-head"). When the file carries fusion parameters, the
  // head is consulted on every slot and the fused word replaces the decoder's ("acoustic-fusion").
  // The prefix chain keeps the decoder's word.
  function applyAcousticHead(head, hidden, decision, seconds, candidates, fusion) {
    var api = root.UncensoredAcousticHead || require("./acoustic-head");
    if (!fusion && !api.uncertain(decision, MIN_LOG_PROB, head.margin)) return decision;
    var crop = api.crop(head, hidden.data, hidden.dims[1], seconds);
    var probs = api.forward(head, crop.x, crop.mask);
    var word = fusion ? api.fuse(head, probs, decision, candidates, MIN_LOG_PROB).word : api.choose(head, probs, candidates);
    // `head` (top word and probability) records that the head was consulted, filled or not.
    var consulted = Object.assign({}, decision, { head: api.top(head, probs) });
    return word && !(fusion && word === decision.word) ? Object.assign(consulted, {
      word: word, words: [word], evidence: fusion ? "acoustic-fusion" : "acoustic-head", decoderWord: decision.word || ""
    }) : consulted;
  }

  async function scoreSlots(transformers, asr, audio, candidates, slots, options) {
    var head = options && options.acousticHead;
    var fusion = Boolean(head && head.fusion);
    var hidden = await encodeAudio(transformers, asr, audio);
    var heard = Object.create(null);
    var decisions = [];
    var index;

    try {
      for (index = 0; index < slots.length; index += 1) {
        var slot = slots[index] || {};
        var decision = await scoreCandidates(transformers, asr, hidden, candidates, {
          nextWord: slot.nextWord,
          prefix: Array.isArray(slot.prefix) ? slot.prefix.map(function prefixWord(word) {
            return word.tokenIndex === undefined ? word.word : heard[word.tokenIndex];
          }).filter(Boolean).join(" ") : slot.prefix
        });
        if (slot.tokenIndex !== undefined) heard[slot.tokenIndex] = decision.word;
        if (head && typeof slot.time === "number") {
          decision = applyAcousticHead(head, hidden, decision, slot.time, candidates, fusion);
        }
        decisions.push(slot.hybridRuleWord
          ? arbitrateHybridResolution(slot.hybridRuleWord, decision, slot.hybridRuleSource)
          : decision);
      }
    } finally {
      hidden.dispose();
    }
    return decisions;
  }

  function transcribeDetailed(audio, candidates, context, options) {
    var slots = options && options.slots || [];

    if (!audio || !audio.length || !candidates || !candidates.length || !slots.length) {
      return Promise.resolve({ decisions: slots.map(emptyDecision) });
    }

    return getTranscriber().then(function score(asr) {
      var started = Date.now();
      return scoreSlots(root.transformers, asr, audio, candidates, slots, { acousticHead: options.acousticHead })
        .then(function wrap(decisions) {
          // Inference time (queue wait excluded) for the automatic mode; the first window after
          // the model loads is warm-up and not reported.
          var result = warmedUp ? { decisions: decisions, inferenceMs: Date.now() - started } : { decisions: decisions };
          warmedUp = true;
          return result;
        });
    }).catch(function reportInferenceFailure(error) {
      debugLog("whisper scoring failed", error ? {
        name: error.name || "", message: error.message || String(error),
        cause: error.cause ? String(error.cause) : "", stack: error.stack || ""
      } : "");
      // Empty decisions are terminal abstentions; inference failures must reach
      // the host so the bounded caller retry can distinguish them.
      throw error;
    });
  }

  var exports = Object.freeze({
    preload: function preload() {
      return getTranscriber().then(function loaded() { return true; });
    },
    transcribeDetailed: transcribeDetailed,
    scoreSlots: scoreSlots,
    normalizeText: normalizeText,
    arbitrateHybridResolution: arbitrateHybridResolution,
    MIN_LOG_PROB: MIN_LOG_PROB
  });

  root.UncensoredWhisperLocal = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
