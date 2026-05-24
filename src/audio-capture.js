(function exposeAudioCapture(root, factory) {
  root.UncensoredAudioInference = factory(root, root.UncensoredRules, root.UncensoredWhisperLocal);
})(typeof globalThis !== "undefined" ? globalThis : this, function buildAudioCapture(root, rules, whisper) {
  "use strict";

  var runtime = root.browser || root.chrome;
  var SLICE_BEFORE_SECONDS = 1.25;
  var SLICE_AFTER_SECONDS = 1.25;
  var CLEAR_WHISPER_SCORE = 10;
  var TARGET_SAMPLE_RATE = 16000;
  var PENDING_CAPTION_TOKEN_REGEX = /\.\.\./u;
  var pendingTokens = [];
  var resolvedTokens = [];
  var liveResolverStarted = false;
  var cacheObserverStarted = false;
  var applyingCaptionPatch = false;
  var preloadStarted = false;
  var mediaAudio = {
    videoId: "",
    source: "",
    loading: false,
    buffer: null,
    segments: [],
    error: ""
  };
  var options = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var SOURCE_PRIORITY = Object.freeze({
    deterministic: 1,
    context: 2,
    media: 3
  });

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

  function findVideo() {
    return root.document && root.document.querySelector("video");
  }

  function currentVideoId() {
    try {
      return new URL(root.location.href).searchParams.get("v") || root.location.pathname;
    } catch (error) {
      return root.location && root.location.href ? root.location.href : "";
    }
  }

  function resampleLinear(input, sourceRate, targetRate) {
    if (!input || !input.length || sourceRate === targetRate) {
      return input || new Float32Array(0);
    }

    var outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
    var output = new Float32Array(outputLength);
    var ratio = sourceRate / targetRate;
    var index;

    for (index = 0; index < outputLength; index += 1) {
      var position = index * ratio;
      var leftIndex = Math.floor(position);
      var rightIndex = Math.min(leftIndex + 1, input.length - 1);
      var weight = position - leftIndex;

      output[index] = input[leftIndex] * (1 - weight) + input[rightIndex] * weight;
    }

    return output;
  }

  function currentAudioContext() {
    var AudioContextCtor = root.AudioContext || root.webkitAudioContext;

    if (!AudioContextCtor) {
      return Promise.reject(new Error("AudioContext is unavailable"));
    }

    return Promise.resolve(new AudioContextCtor());
  }

  function base64ToArrayBuffer(value) {
    var binary = root.atob(value || "");
    var bytes = new Uint8Array(binary.length);
    var index;

    for (index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer;
  }

  function setSabrAudioData(detailJson) {
    var detail;

    try {
      detail = JSON.parse(detailJson);
    } catch (error) {
      return;
    }

    if (!detail || !detail.base64) {
      return;
    }

    mediaAudio.videoId = currentVideoId();
    mediaAudio.source = "sabr";
    mediaAudio.loading = true;
    if (!mediaAudio.segments) {
      mediaAudio.segments = [];
    }
    mediaAudio.promise = currentAudioContext().then(function decodeWithContext(context) {
      return context.decodeAudioData(base64ToArrayBuffer(detail.base64));
    }).then(function decoded(buffer) {
      var segment = {
        startTime: 0,
        endTime: buffer.duration,
        buffer: buffer,
        bytes: detail.bytes || 0
      };

      if (mediaAudio.segments.length && mediaAudio.segments[0].endTime >= segment.endTime) {
        mediaAudio.loading = false;
        return mediaAudio.segments[0].buffer;
      }

      mediaAudio.segments = [segment];
      mediaAudio.buffer = buffer;
      mediaAudio.loading = false;
      mediaAudio.error = "";
      debugLog("sabr audio ready", {
        itag: detail.itag,
        bytes: detail.bytes,
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        coveredSeconds: segment.endTime
      });
      resolvePendingTokensFromMedia();
      return buffer;
    }).catch(function failed(error) {
      mediaAudio.loading = false;
      mediaAudio.error = error && (error.message || String(error));
      debugLog("sabr audio decode failed", {
        itag: detail.itag,
        bytes: detail.bytes,
        error: mediaAudio.error
      });
    });
  }

  function readMediaSlice(buffer, startTime, endTime) {
    var sampleRate = buffer.sampleRate;
    var startSample = Math.max(0, Math.floor(startTime * sampleRate));
    var endSample = Math.min(buffer.length, Math.ceil(endTime * sampleRate));
    var length = Math.max(0, endSample - startSample);
    var channels = buffer.numberOfChannels;
    var output = new Float32Array(length);
    var channelIndex;
    var sampleIndex;

    if (!length) {
      return output;
    }

    for (channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      var channel = buffer.getChannelData(channelIndex);

      for (sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
        output[sampleIndex] += channel[startSample + sampleIndex] / channels;
      }
    }

    return output;
  }

  function candidatesForToken(token) {
    var seen = Object.create(null);
    var candidates = [];

    (token && token.candidates && token.candidates.length ? token.candidates : []).concat(rules.ALLOWED_WORDS).forEach(function addCandidate(candidate) {
      if (candidate && !seen[candidate]) {
        seen[candidate] = true;
        candidates.push(candidate);
      }
    });

    return candidates;
  }

  function normalizeContext(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\.\.\./g, rules.CENSORED_TOKEN)
      .replace(/\[\s*__\s*\]/gu, rules.CENSORED_TOKEN)
      .replace(/[^a-z0-9_\[\]\s']+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenCacheKey(token) {
    return Math.round((token.timeSeconds || 0) * 10) + "\n" + normalizeContext(token.context);
  }

  function sourcePriority(source) {
    return SOURCE_PRIORITY[source] || 0;
  }

  function notifyTimedTextResolution(token, word, source) {
    if (!token || typeof token.tokenIndex !== "number" || token.tokenIndex < 0 || !word || sourcePriority(source) < sourcePriority("context")) {
      return;
    }

    try {
      root.dispatchEvent(new CustomEvent("uncensored-whisper-resolution", {
        detail: JSON.stringify({
          tokenIndex: token.tokenIndex,
          word: word
        })
      }));
    } catch (error) {
      return;
    }
  }

  function preloadWhisper() {
    if (preloadStarted || !options.whisperEnabled || !whisper || !whisper.preload) {
      return;
    }

    preloadStarted = true;
    whisper.preload().catch(function ignorePreloadError() {});
  }

  function rememberResolution(token, word, source) {
    var key;
    var existing;

    if (!token || !word) {
      return;
    }

    key = tokenCacheKey(token);
    existing = resolvedTokens.find(function findExisting(resolution) {
      return resolution.key === key;
    });

    if (existing) {
      if (sourcePriority(existing.source) > sourcePriority(source || "unknown")) {
        return;
      }

      existing.word = word;
      existing.source = source || "unknown";
      existing.deterministicWord = token.deterministicWord || existing.deterministicWord || "";
      existing.context = token.context || existing.context;
      existing.normalizedContext = normalizeContext(existing.context);
      existing.timeSeconds = token.timeSeconds;
      notifyTimedTextResolution(token, word, source || "unknown");
      startCaptionCacheObserver();
      return;
    }

    resolvedTokens.push({
      key: key,
      tokenIndex: token.tokenIndex,
      timeSeconds: token.timeSeconds,
      context: token.context,
      normalizedContext: normalizeContext(token.context),
      word: word,
      deterministicWord: token.deterministicWord || "",
      source: source || "unknown"
    });

    resolvedTokens.sort(function sortByTime(left, right) {
      return left.timeSeconds - right.timeSeconds;
    });

    startCaptionCacheObserver();
    notifyTimedTextResolution(token, word, source || "unknown");
  }

  function isUsableWhisperDecision(token, decision) {
    if (!decision || !decision.word) {
      return false;
    }

    if (!token.deterministicWord) {
      return true;
    }

    return decision.score >= CLEAR_WHISPER_SCORE && decision.score > decision.runnerUpScore;
  }

  function whisperRejectionReason(token, decision) {
    if (!decision) {
      return "missing decision";
    }

    if (!decision.word) {
      return "no word";
    }

    if (!token.deterministicWord) {
      return "";
    }

    if (decision.score < CLEAR_WHISPER_SCORE) {
      return "score below threshold";
    }

    if (decision.score <= decision.runnerUpScore) {
      return "runner-up tied or higher";
    }

    return "";
  }

  function deterministicIsAmbiguous(token) {
    return token && token.deterministicCandidates && token.deterministicCandidates.length > 1;
  }

  function shouldResolveWithWhisper(token) {
    if (!options.whisperEnabled || !token) {
      return false;
    }

    if (!options.rulesEnabled || !token.deterministicWord || token.visibleOnly) {
      return true;
    }

    return deterministicIsAmbiguous(token);
  }

  function transcribeTokenPcm(token, sourcePcm, sourceRate, source) {
    var pcm16 = resampleLinear(sourcePcm, sourceRate, TARGET_SAMPLE_RATE);
    var force = !token.deterministicWord || !options.rulesEnabled;

    debugLog("whisper slice", {
      tokenIndex: token.tokenIndex,
      timeSeconds: token.timeSeconds,
      context: token.context,
      deterministicWord: token.deterministicWord,
      source: source,
      sourceSamples: sourcePcm.length,
      pcm16Samples: pcm16.length,
      force: force
    });

    return whisper.transcribeDetailed(pcm16, candidatesForToken(token), token.context, {
      force: force
    }).then(function resolvedDecision(decision) {
      var rejectionReason = whisperRejectionReason(token, decision);

      debugLog("whisper decision", {
        tokenIndex: token.tokenIndex,
        source: source,
        word: decision && decision.word || "",
        score: decision && decision.score || 0,
        runnerUpScore: decision && decision.runnerUpScore || 0,
        transcript: decision && decision.transcript || "",
        forced: Boolean(decision && decision.forced),
        rejected: Boolean(rejectionReason),
        rejectionReason: rejectionReason,
        decision: decision
      });

      if (rejectionReason) {
        return null;
      }

      return {
        tokenIndex: token.tokenIndex,
        word: decision.word,
        source: source,
        score: decision.score,
        runnerUpScore: decision.runnerUpScore,
        transcript: decision.transcript,
        forced: decision.forced
      };
    });
  }

  function mediaAudioCoversToken(token) {
    return Boolean(segmentForToken(token));
  }

  function segmentForToken(token) {
    if (!token || !mediaAudio.segments || !mediaAudio.segments.length) {
      return null;
    }

    return mediaAudio.segments.find(function findSegment(segment) {
      return token.timeSeconds >= segment.startTime - SLICE_BEFORE_SECONDS &&
        token.timeSeconds <= segment.endTime + SLICE_AFTER_SECONDS;
    }) || null;
  }

  function resolveTokenFromMedia(token) {
    return Promise.resolve(segmentForToken(token)).then(function mediaReady(segment) {
      if (!segment) {
        throw new Error("No decoded media audio");
      }

      var buffer = segment.buffer;
      var startTime = Math.max(segment.startTime, token.timeSeconds - SLICE_BEFORE_SECONDS) - segment.startTime;
      var endTime = Math.min(segment.endTime, token.timeSeconds + SLICE_AFTER_SECONDS) - segment.startTime;
      var sourcePcm = readMediaSlice(buffer, startTime, endTime);

      return transcribeTokenPcm(token, sourcePcm, buffer.sampleRate, "media");
    });
  }

  function resolveToken(token) {
    if (!mediaAudio.segments.length) {
      debugLog("waiting for decoded media audio", {
        tokenIndex: token && token.tokenIndex
      });
      return Promise.resolve(null);
    }

    return resolveTokenFromMedia(token).catch(function unresolved(error) {
      debugLog("whisper unresolved", {
        tokenIndex: token && token.tokenIndex,
        error: error && (error.message || String(error))
      });
      return null;
    });
  }

  function applyResolvedWord(token, resolution) {
    var word = resolution && resolution.word;

    if (!word) {
      return;
    }

    token.resolved = true;
    rememberResolution(token, word, resolution.source);
    applyVisibleCaptionResolution(token, word);
  }

  function contextWordForToken(token) {
    var result;

    if (!token || token.deterministicWord || !rules.applyDeterministicRules) {
      return "";
    }

    result = rules.applyDeterministicRules(token.context || "");
    return result.replacements && result.replacements.length === 1
      ? result.replacements[0].word
      : "";
  }

  function resolvePendingTokensFromMedia() {
    if (!options.whisperEnabled || !mediaAudio.segments.length || !pendingTokens.length) {
      return;
    }

    pendingTokens.forEach(function resolveMediaToken(token) {
      if (!shouldResolveWithWhisper(token) || token.resolved || token.resolving || token.attemptedByMedia) {
        return;
      }

      if (!mediaAudioCoversToken(token)) {
        return;
      }

      token.resolving = true;
      token.attemptedByMedia = true;
      token.attempted = true;
      resolveTokenFromMedia(token).then(function mediaResolution(resolution) {
        applyResolvedWord(token, resolution);
      }).catch(function ignoreMediaResolution(error) {
        debugLog("media token unresolved", {
          tokenIndex: token.tokenIndex,
          error: error && (error.message || String(error))
        });
      }).finally(function clearMediaResolving() {
        token.resolving = false;
      });
    });
  }

  function rememberTimedTextTokens(tokens) {
    var existing = Object.create(null);

    if (!rules || !whisper || !tokens || !tokens.length) {
      return;
    }

    pendingTokens.forEach(function markExisting(token) {
      existing[token.timeSeconds + "\n" + token.context] = true;
    });

    tokens.forEach(function addPendingToken(token) {
      var key = token.timeSeconds + "\n" + token.context;
      var contextWord = contextWordForToken(token);

      if (options.rulesEnabled && token.deterministicWord && !deterministicIsAmbiguous(token)) {
        rememberResolution(token, token.deterministicWord, "deterministic");
      }

      if (options.rulesEnabled && contextWord) {
        rememberResolution(token, contextWord, "context");
        applyVisibleCaptionResolution(token, contextWord);
        return;
      }

      if (!existing[key] && shouldResolveWithWhisper(token)) {
        existing[key] = true;
        pendingTokens.push(Object.assign({}, token, {
          resolved: false,
          resolving: false
        }));
      }
    });

    debugLog("remembered timedtext tokens", {
      added: tokens.length,
      pending: pendingTokens.length
    });

    pendingTokens.sort(function sortByTime(left, right) {
      return left.timeSeconds - right.timeSeconds;
    });

    if (!pendingTokens.length) {
      return;
    }

    startLiveCaptionResolver();
    preloadWhisper();
    if (options.whisperEnabled && mediaAudio.segments.length) {
      resolvePendingTokensFromMedia();
    } else if (options.whisperEnabled) {
      debugLog("queued tokens waiting for decoded media audio", {
        pending: pendingTokens.length
      });
    }
  }

  function captionSegments() {
    var segments;

    if (!root.document) {
      return [];
    }

    segments = Array.prototype.slice.call(root.document.querySelectorAll(".ytp-caption-segment"));
    if (!segments.length) {
      segments = Array.prototype.slice.call(root.document.querySelectorAll(".caption-window span, .caption-visual-line span"));
    }

    return segments.filter(function keepLeafSegment(segment) {
      return !segments.some(function hasParentSegment(candidate) {
        return candidate !== segment && candidate.contains(segment);
      });
    });
  }

  function captionRoots() {
    if (!root.document) {
      return [];
    }

    return Array.prototype.slice.call(root.document.querySelectorAll(".caption-window, .caption-visual-line, .ytp-caption-window-container"));
  }

  function replaceFirst(text, from, to) {
    if (!from) {
      return text;
    }

    return text.replace(from, to);
  }

  function contextSideWords(text, keepRight) {
    var words = normalizeContext(text).split(/\s+/).filter(function useful(word) {
      return word && word !== rules.CENSORED_TOKEN && word !== "something" && word.length > 2;
    });

    return keepRight ? words.slice(0, 3) : words.slice(-3);
  }

  function wordsInOrder(text, words) {
    var index = 0;
    var normalizedText = normalizeContext(text);

    return words.every(function findWord(word) {
      var nextIndex = normalizedText.indexOf(word, index);

      if (nextIndex === -1) {
        return false;
      }

      index = nextIndex + word.length;
      return true;
    });
  }

  function visibleSlotMatchesResolution(text, resolution) {
    var normalizedText = normalizeContext(text);
    var contextParts = normalizeContext(resolution.context).split(rules.CENSORED_TOKEN);
    var beforeWords = contextSideWords(contextParts[0] || "", false);
    var afterWords = contextSideWords(contextParts.slice(1).join(" "), true);
    var tokenMatch = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "u").exec(normalizedText);
    var pendingMatch;
    var beforeText;
    var afterText;

    if (!tokenMatch || tokenMatch.index === undefined) {
      pendingMatch = PENDING_CAPTION_TOKEN_REGEX.exec(normalizedText);
      if (!pendingMatch || pendingMatch.index === undefined) {
        return false;
      }
      tokenMatch = pendingMatch;
    }

    beforeText = normalizedText.slice(0, tokenMatch.index);
    afterText = normalizedText.slice(tokenMatch.index + tokenMatch[0].length);

    return wordsInOrder(beforeText, beforeWords) && wordsInOrder(afterText, afterWords);
  }

  function applyVisibleCaptionResolution(token, word) {
    var segments = captionSegments();
    var captionText = segments.map(function segmentText(segment) {
      return segment.textContent || "";
    }).join(" ");
    var tokenRegex = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "u");
    var changed = false;

    if (rules.hasCensoredToken(captionText) && !visibleSlotMatchesResolution(captionText, {
      context: token.context
    })) {
      return false;
    }

    segments.forEach(function patchSegment(segment) {
      var text = segment.textContent || "";
      var patched = text;

      if (tokenRegex.test(patched)) {
        patched = patched.replace(tokenRegex, word);
      } else if (PENDING_CAPTION_TOKEN_REGEX.test(patched)) {
        patched = patched.replace(PENDING_CAPTION_TOKEN_REGEX, word);
      } else if (token.deterministicWord && patched.indexOf(token.deterministicWord) !== -1) {
        patched = replaceFirst(patched, token.deterministicWord, word);
      }

      if (patched !== text) {
        segment.textContent = patched;
        changed = true;
      }
    });

    return changed;
  }

  function patchCaptionTextNodes(resolution) {
    var tokenRegex = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "u");
    var changed = false;

    captionRoots().forEach(function patchRoot(captionRoot) {
      var walker = root.document.createTreeWalker(captionRoot, root.NodeFilter.SHOW_TEXT);
      var node;

      while ((node = walker.nextNode())) {
        var text = node.nodeValue || "";
        var patched = text;

        if (tokenRegex.test(patched) && visibleSlotMatchesResolution(captionRoot.textContent || "", resolution)) {
          patched = patched.replace(tokenRegex, resolution.word);
        } else if (PENDING_CAPTION_TOKEN_REGEX.test(patched) && visibleSlotMatchesResolution(captionRoot.textContent || "", resolution)) {
          patched = patched.replace(PENDING_CAPTION_TOKEN_REGEX, resolution.word);
        } else if (resolution.deterministicWord && patched.indexOf(resolution.deterministicWord) !== -1) {
          patched = replaceFirst(patched, resolution.deterministicWord, resolution.word);
        }

        if (patched !== text) {
          node.nodeValue = patched;
          changed = true;
        }
      }
    });

    return changed;
  }

  function applyCachedVisibleResolutions() {
    var segments = captionSegments();
    var changed = false;

    if (!resolvedTokens.length || applyingCaptionPatch) {
      return false;
    }

    applyingCaptionPatch = true;
    resolvedTokens.forEach(function patchResolution(resolution) {
      var tokenRegex = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "u");
      var captionText = segments.map(function segmentText(segment) {
        return segment.textContent || "";
      }).join(" ");
      var changedByResolution = false;

      if (rules.hasCensoredToken(captionText) && !visibleSlotMatchesResolution(captionText, resolution)) {
        return;
      }

      segments.some(function patchSegment(segment) {
        var text = segment.textContent || "";
        var patched;

        if (!tokenRegex.test(text) && !PENDING_CAPTION_TOKEN_REGEX.test(text) && (!resolution.deterministicWord || text.indexOf(resolution.deterministicWord) === -1)) {
          return false;
        }

        patched = tokenRegex.test(text)
          ? text.replace(tokenRegex, resolution.word)
          : PENDING_CAPTION_TOKEN_REGEX.test(text)
            ? text.replace(PENDING_CAPTION_TOKEN_REGEX, resolution.word)
            : replaceFirst(text, resolution.deterministicWord, resolution.word);
        if (patched !== text) {
          segment.textContent = patched;
          changed = true;
          changedByResolution = true;
          return true;
        }

        return false;
      });

      if (!changedByResolution && patchCaptionTextNodes(resolution)) {
        changed = true;
      }
    });
    applyingCaptionPatch = false;

    if (changed) {
      debugLog("reapplied cached caption resolutions", {
        count: resolvedTokens.length
      });
    }

    return changed;
  }

  function startCaptionCacheObserver() {
    if (cacheObserverStarted || !root.MutationObserver || !root.document || !root.document.body) {
      return;
    }

    cacheObserverStarted = true;

    new root.MutationObserver(function onCaptionMutation() {
      applyCachedVisibleResolutions();
    }).observe(root.document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function startLiveCaptionResolver() {
    if (liveResolverStarted || !root.setInterval) {
      return;
    }

    liveResolverStarted = true;

    root.setInterval(function resolveVisibleTokens() {
      var video = findVideo();

      if (!video || !pendingTokens.length) {
        applyCachedVisibleResolutions();
        return;
      }

      applyCachedVisibleResolutions();

      pendingTokens.forEach(function maybeResolve(token) {
        if (!mediaAudio.segments.length || !shouldResolveWithWhisper(token) || token.resolved || token.resolving || token.attempted) {
          return;
        }

        if (!mediaAudioCoversToken(token)) {
          return;
        }

        token.resolving = true;
        token.attempted = true;
        debugLog("live resolving token", {
          tokenIndex: token.tokenIndex,
          context: token.context
        });
        resolveToken(token).then(function applyResolution(resolution) {
          var word = resolution && resolution.word;

          if (word) {
            applyResolvedWord(token, resolution);
          }

          if (word) {
            debugLog("live patched caption", {
              tokenIndex: token.tokenIndex,
              word: word,
              source: resolution.source,
              score: resolution.score,
              transcript: resolution.transcript
            });
          } else {
            debugLog("live resolution not applied", {
              tokenIndex: token.tokenIndex,
              word: word || "",
              segments: captionSegments().map(function segmentText(segment) {
                return segment.textContent || "";
              })
            });
          }
        }).finally(function clearResolving() {
          token.resolving = false;
        });
      });

      pendingTokens = pendingTokens.filter(function keepUsefulToken(token) {
        return !token.resolved && (!token.attempted || !mediaAudioCoversToken(token));
      });
    }, 250);
  }

  return Object.freeze({
    setSabrAudioData: setSabrAudioData,
    setOptions: function setOptions(nextOptions) {
      nextOptions = nextOptions || {};
      options.rulesEnabled = nextOptions.rulesEnabled !== false;
      options.whisperEnabled = nextOptions.whisperEnabled !== false;
      preloadWhisper();
    },
    rememberTimedTextTokens: rememberTimedTextTokens,
    startVisibleCaptionResolver: startLiveCaptionResolver,
    resampleLinear: resampleLinear,
    debugState: function debugState() {
      return {
        mediaAudio: {
          videoId: mediaAudio.videoId,
          source: mediaAudio.source,
          loading: mediaAudio.loading,
          ready: Boolean(mediaAudio.segments && mediaAudio.segments.length),
          segments: (mediaAudio.segments || []).map(function mapSegment(segment) {
            return {
              startTime: segment.startTime,
              endTime: segment.endTime,
              duration: segment.buffer.duration,
              bytes: segment.bytes
            };
          }),
          error: mediaAudio.error
        },
        pendingTokens: pendingTokens.map(function mapToken(token) {
          return {
            tokenIndex: token.tokenIndex,
            timeSeconds: token.timeSeconds,
            context: token.context,
            deterministicWord: token.deterministicWord,
            candidates: token.candidates,
            resolved: token.resolved,
            resolving: token.resolving,
            attempted: token.attempted
          };
        }),
        resolvedTokens: resolvedTokens.slice()
      };
    }
  });
});
