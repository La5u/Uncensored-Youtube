(function buildAudioCapture() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var rules = root.UncensoredRules;
  var runtime = root.browser || root.chrome;

  var AUDIO_CONTEXT_SECONDS = 1.5;
  var VISIBLE_REAPPLY_SECONDS = 12;
  var CLEAR_WHISPER_SCORE = 10;
  var MAX_WHISPER_GROUP_TOKENS = 5;
  var MAX_WHISPER_GROUP_SECONDS = 4;
  var MEDIA_GAP_TOLERANCE_SECONDS = 0.05;
  var CAPTION_MUTATION_SELECTOR = ".ytp-caption-segment, .caption-window, .caption-visual-line, .ytp-caption-window-container";
  var TARGET_SAMPLE_RATE = 16000;
  var CENSORED_TOKEN_REGEX = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "u");
  var CENSORED_TOKEN_GLOBAL_REGEX = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
  var pendingTokens = new Map();
  var resolvedTokens = new Map();
  var failedTokens = new Map();
  var liveResolverStarted = false;
  var captionObserver = null;
  var visibleResolutionScheduled = false;
  var pendingVisibleGroups = new Map();
  var lastPatchedCaptionText = "";
  var activeWhisperRequests = 0;
  var whisperQueueScheduled = false;
  var audioContext = null;
  var decodeQueue = Promise.resolve();
  var whisperModelState = "idle";
  var navigationGeneration = 0;
  var MAX_ACTIVE_WHISPER_REQUESTS = 1;
  var mediaAudio = {
    videoId: "",
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

  function activeDocument() {
    return !root.document || !root.document.hidden;
  }

  function extractPathVideoId(pathname) {
    var match = pathname.match(/\/(live|shorts)\/([^/]+)/);
    return match ? match[2] : "";
  }

  function currentVideoId() {
    try {
      var url = new URL(root.location.href);
      return url.searchParams.get("v") || extractPathVideoId(url.pathname) || "";
    } catch (error) {
      return "";
    }
  }

  function resetForNavigation() {
    if (mediaAudio.videoId && currentVideoId() === mediaAudio.videoId) {
      scheduleWhisperQueue();
      return;
    }

    navigationGeneration += 1;
    pendingTokens.clear();
    resolvedTokens.clear();
    failedTokens.clear();
    mediaAudio.videoId = "";
    mediaAudio.segments = [];
    mediaAudio.error = "";
    lastPatchedCaptionText = "";
    pendingVisibleGroups.clear();
  }

  // ── Whisper via background relay ──

  function bgMessage(type, data) {
    var timeoutMs = type === "warmup" ? 10000 : 60000;
    return new Promise(function bg(resolve) {
      var message = Object.assign({ uncensoredWhisper: true, type: type }, data ? { data: data } : {});
      var resolved = false;
      var timer = root.setTimeout(function bgTimedOut() {
        if (!resolved) {
          resolved = true;
          debugLog("bgMessage timeout", { type: type });
          resolve({});
        }
      }, timeoutMs);

      function done(response) {
        if (!resolved) {
          resolved = true;
          root.clearTimeout(timer);
          resolve(response || {});
        }
      }

      try {
        if (root.browser && runtime === root.browser) {
          runtime.runtime.sendMessage(message).then(done, function ignorePromiseError() {
            done({});
          });
          return;
        }

        runtime.runtime.sendMessage(message, function handleResponse(response) {
          done(response);
        });
      } catch (error) {
        done({});
      }
    });
  }

  function whisperTranscribe(audio, candidates, context, options) {
    if (!audio || !audio.length || !candidates || !candidates.length) {
      return Promise.resolve({ word: "", score: 0, runnerUpScore: 0, transcript: "", forced: Boolean(options && options.force) });
    }
    var copy = audio.slice();
    return bgMessage("transcribe", {
      audio: copy.buffer,
      candidates: candidates,
      context: context,
      options: options
    }).then(function onDecision(response) {
      return response && response.decision ? response.decision : response;
    });
  }

  function warmupWhisper() {
    bgMessage("warmup");
  }

  function preloadWhisper() {
    if (whisperModelState !== "idle") {
      return;
    }

    whisperModelState = "loading";
    debugLog("whisper model starting");
    bgMessage("preload").then(function modelPreloaded(response) {
      if (response && (response.ready || response.ok)) {
        whisperModelState = "ready";
        debugLog("whisper model started");
      } else {
        whisperModelState = "idle";
        debugLog("whisper model failed to start");
      }
    });
  }

  // ── Shared audio segment helpers ──

  function addAudioSegment(startTime, buffer) {
    var segment = {
      startTime: startTime,
      endTime: startTime + buffer.duration,
      buffer: buffer
    };
    var duplicate = mediaAudio.segments.some(function hasSegment(existing) {
      return Math.abs(existing.startTime - segment.startTime) < 0.01 &&
        Math.abs(existing.endTime - segment.endTime) < 0.01;
    });
    if (duplicate) return Promise.resolve();
    mediaAudio.videoId = mediaAudio.videoId || currentVideoId();
    mediaAudio.error = "";
    mediaAudio.segments.push(segment);
    compactMediaSegments();
    resolvePendingTokensFromMedia();
    return Promise.resolve();
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

    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextCtor();
    }

    return Promise.resolve(audioContext);
  }

  function setSabrAudioData(detail) {
    var generation = navigationGeneration;

    if (!detail || !(detail.buffer instanceof ArrayBuffer)) {
      return decodeQueue;
    }

    decodeQueue = decodeQueue.then(function decodeNextSegment() {
      var decodeStartedAt = root.performance && root.performance.now ? root.performance.now() : 0;

      if (!options.whisperEnabled || !activeDocument()) {
        return null;
      }

      return currentAudioContext().then(function decodeWithContext(context) {
        return context.decodeAudioData(detail.buffer);
      }).then(function decodedWithTiming(buffer) {
        if (decodeStartedAt) {
          debugLog("sabr audio decoded", {
            itag: detail.itag,
            bytes: detail.bytes,
            startMs: detail.startMs,
            durationMs: buffer && typeof buffer.duration === "number" ? Math.round(buffer.duration * 1000) : 0,
            elapsedMs: Math.round(root.performance.now() - decodeStartedAt)
          });
        }
        return buffer;
      });
    }).then(function decoded(buffer) {
      if (!buffer || generation !== navigationGeneration) {
        return;
      }

      var startTime = typeof detail.startMs === "number" ? detail.startMs / 1000 : 0;

      return addAudioSegment(startTime, buffer);
    }).catch(function failed(error) {
      mediaAudio.error = error && (error.message || String(error));
      debugLog("sabr audio decode failed", {
        itag: detail.itag,
        bytes: detail.bytes,
        error: mediaAudio.error
      });
    });

    return decodeQueue;
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

  function mediaSegmentsForRange(startTime, endTime) {
    var cursor = startTime;
    var selected = [];

    mediaAudio.segments.slice().sort(function sortSegments(left, right) {
      return left.startTime - right.startTime;
    }).forEach(function collectSegment(segment) {
      if (cursor >= endTime || segment.endTime <= cursor || segment.startTime >= endTime) {
        return;
      }
      if (segment.startTime > cursor + MEDIA_GAP_TOLERANCE_SECONDS) {
        return;
      }

      selected.push(segment);
      cursor = Math.max(cursor, segment.endTime);
    });

    return cursor >= endTime - MEDIA_GAP_TOLERANCE_SECONDS ? selected : [];
  }

  function readMediaWindow(startTime, endTime) {
    var segments = mediaSegmentsForRange(startTime, endTime);
    var output = new Float32Array(Math.max(1, Math.round((endTime - startTime) * TARGET_SAMPLE_RATE)));

    if (!segments.length) {
      return null;
    }

    segments.forEach(function copySegment(segment) {
      var overlapStart = Math.max(startTime, segment.startTime);
      var overlapEnd = Math.min(endTime, segment.endTime);
      var source = readMediaSlice(
        segment.buffer,
        overlapStart - segment.startTime,
        overlapEnd - segment.startTime
      );
      var pcm = resampleLinear(source, segment.buffer.sampleRate, TARGET_SAMPLE_RATE);
      var outputStart = Math.max(0, Math.round((overlapStart - startTime) * TARGET_SAMPLE_RATE));
      var copyLength = Math.min(pcm.length, output.length - outputStart);

      if (copyLength > 0) {
        output.set(pcm.subarray(0, copyLength), outputStart);
      }
    });

    return output;
  }

  function tokenWindow(token) {
    return {
      startTime: Math.max(0, token.timeSeconds - AUDIO_CONTEXT_SECONDS),
      endTime: token.timeSeconds + AUDIO_CONTEXT_SECONDS
    };
  }

  function candidatesForToken(token) {
    var seen = Object.create(null);
    var candidates = [];
    var tokenCandidates = options.rulesEnabled && token && token.candidates && token.candidates.length ? token.candidates : [];

    tokenCandidates.concat(rules.ALLOWED_WORDS).forEach(function addCandidate(candidate) {
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
      .replace(/\[\s*__\s*\]/gu, rules.CENSORED_TOKEN)
      .replace(/[^a-z0-9_\[\]\s']+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenCacheKey(token) {
    return Math.round((token.timeSeconds || 0) * 10) + "\n" + normalizeContext(token.context);
  }

  function sortedTokenValues(tokenMap) {
    return Array.from(tokenMap.values()).sort(function sortByTime(left, right) {
      return (left.timeSeconds || 0) - (right.timeSeconds || 0);
    });
  }

  function pendingTokenValues() {
    return sortedTokenValues(pendingTokens);
  }

  function resolvedTokenValues() {
    return sortedTokenValues(resolvedTokens);
  }

  function sourcePriority(source) {
    return SOURCE_PRIORITY[source] || 0;
  }

  function notifyTimedTextResolution(token, word, source) {
    if (!token || typeof token.tokenIndex !== "number" || token.tokenIndex < 0 || !word || sourcePriority(source) < sourcePriority("context")) {
      return;
    }

    try {
      root.dispatchEvent(new root.CustomEvent("uncensored-whisper-resolution", {
        detail: JSON.stringify({
          tokenIndex: token.tokenIndex,
          word: word,
          source: source || "unknown",
          videoId: mediaAudio.videoId || currentVideoId()
        })
      }));
    } catch (error) {
      return;
    }
  }

  function rememberResolution(token, word, source) {
    var key;
    var existing;

    if (!token || !word) {
      return;
    }

    key = tokenCacheKey(token);
    existing = resolvedTokens.get(key);

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
      existing.eventIndex = token.eventIndex;
      existing.eventTokenIndex = token.eventTokenIndex;
      notifyTimedTextResolution(token, word, source || "unknown");
      return existing;
    }

    existing = {
      key: key,
      tokenIndex: token.tokenIndex,
      eventIndex: token.eventIndex,
      eventTokenIndex: token.eventTokenIndex,
      navigationGeneration: token.navigationGeneration,
      timeSeconds: token.timeSeconds,
      context: token.context,
      normalizedContext: normalizeContext(token.context),
      word: word,
      deterministicWord: token.deterministicWord || "",
      source: source || "unknown"
    };
    resolvedTokens.set(key, existing);

    notifyTimedTextResolution(token, word, source || "unknown");
    return existing;
  }

  function whisperRejectionReason(token, decision) {
    if (!decision) {
      return "missing decision";
    }

    if (!decision.word) {
      return "no word";
    }

    if (!options.rulesEnabled) {
      return "";
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

    if (failedTokens.has(token.tokenIndex)) {
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

    return whisperTranscribe(pcm16, candidatesForToken(token), token.context, {
      force: force,
      slotOrdinal: token.adjacentTokenIndex || 0,
      slotCount: token.adjacentTokenCount || 1
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
        rejectionReason: rejectionReason
      });

      if (rejectionReason) {
        failedTokens.set(token.tokenIndex, { reason: rejectionReason });
        debugLog("whisper failed", { tokenIndex: token.tokenIndex, reason: rejectionReason });
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

  function resolveTokenFromMedia(token) {
    return Promise.resolve().then(function mediaReady() {
      var window = tokenWindow(token);
      var pcm = readMediaWindow(window.startTime, window.endTime);

      if (!pcm) {
        throw new Error("Incomplete decoded media audio");
      }

      return transcribeTokenPcm(token, pcm, TARGET_SAMPLE_RATE, "media");
    }).catch(function logSingleTokenError(error) {
      var errorInfo = {
        tokenIndex: token.tokenIndex,
        timeSeconds: token.timeSeconds,
        error: error && (error.message || String(error)),
        stack: error && error.stack
      };
      debugLog("single token whisper error", errorInfo);
      if (console && console.warn) {
        console.warn("[uncensored] whisper single error", errorInfo);
      }
      throw error;
    });
  }

  function resolveTokenGroupFromMedia(group) {
    if (group.length < 2) {
      return resolveTokenFromMedia(group[0].token).then(function resolvedSingle(resolution) {
        applyResolvedWord(group[0].token, resolution);
        return resolution;
      });
    }

    return Promise.resolve().then(function mediaReady() {
      var first = group[0].token.timeSeconds;
      var last = group[group.length - 1].token.timeSeconds;
      var startTime = Math.max(0, first - AUDIO_CONTEXT_SECONDS);
      var endTime = last + AUDIO_CONTEXT_SECONDS;
      var pcm16 = readMediaWindow(startTime, endTime);
      var candidates = [];
      var seen = Object.create(null);
      var context = group.map(function groupContext(entry) {
        return entry.token.context || "";
      }).join(" ");

      if (!pcm16) {
        throw new Error("Incomplete decoded media audio");
      }

      group.forEach(function mergeCandidates(entry) {
        candidatesForToken(entry.token).forEach(function addCandidate(candidate) {
          if (candidate && !seen[candidate]) {
            seen[candidate] = true;
            candidates.push(candidate);
          }
        });
      });

      debugLog("whisper group slice", {
        eventIndex: group[0].token.eventIndex,
        tokens: group.map(function groupTokenIndex(entry) {
          return entry.token.tokenIndex;
        }),
        startTime: startTime,
        endTime: endTime,
        pcm16Samples: pcm16.length
      });

      return whisperTranscribe(pcm16, candidates, context, {
        force: true,
        slotOrdinal: 0,
        slotCount: group.length
      }).then(function applyGroupDecision(decision) {
        decision = decision || {};
        var words = Array.isArray(decision.words) ? decision.words : [];
        var completeGroup = words.length >= group.length;

        debugLog("whisper group decision", {
          eventIndex: group[0].token.eventIndex,
          words: words,
          transcript: decision.transcript || ""
        });

        group.forEach(function applyGroupWord(entry, index) {
          if (words[index]) {
            applyResolvedWord(entry.token, {
              tokenIndex: entry.token.tokenIndex,
              word: words[index],
              source: "media",
              score: decision.score,
              runnerUpScore: decision.runnerUpScore,
              transcript: decision.transcript,
              forced: decision.forced
            }, completeGroup);
          } else {
            failedTokens.set(entry.token.tokenIndex, { reason: "no positional word" });
            debugLog("whisper failed", { tokenIndex: entry.token.tokenIndex, reason: "no positional word" });
          }
        });

        if (completeGroup) {
          var visibleGroup = {
            tokens: group.map(function groupToken(entry) { return entry.token; }),
            words: words.slice(0, group.length)
          };
          pendingVisibleGroups.set(group[0].token.eventIndex, visibleGroup);
          applyVisibleTokenGroup(visibleGroup);
        }

        return decision;
      });
    });
  }

  function applyResolvedWord(token, resolution, deferVisible) {
    var word = resolution && resolution.word;

    if (!word || token.navigationGeneration !== navigationGeneration) {
      return;
    }

    token.resolved = true;
    rememberResolution(token, word, resolution.source);
    if (!deferVisible) {
      applyVisibleCaptionResolution(token, word, resolution.source);
    }
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
    if (!options.whisperEnabled || !activeDocument() || !mediaAudio.segments.length || !pendingTokens.size) {
      return;
    }

    scheduleWhisperQueue();
  }

  function warmupWhisperHost() {
    if (options.whisperEnabled && activeDocument()) {
      warmupWhisper();
    }
  }

  function nextResolvableMediaToken() {
    var selected = null;

    pendingTokenValues().forEach(function findToken(token) {
      var window;

      if (!shouldResolveWithWhisper(token) || token.resolved || token.resolving) {
        return;
      }

      window = tokenWindow(token);
      if (!mediaSegmentsForRange(window.startTime, window.endTime).length) {
        return;
      }

      if (!selected ||
          (token.timeSeconds || 0) < (selected.token.timeSeconds || 0) ||
          ((token.timeSeconds || 0) === (selected.token.timeSeconds || 0) &&
            (token.tokenIndex || 0) < (selected.token.tokenIndex || 0))) {
        selected = {
          token: token
        };
      }
    });

    return selected;
  }

  function findResolvableTokenGroup() {
    var next = nextResolvableMediaToken();
    var group;

    if (!next) {
      return null;
    }

    group = pendingTokenValues().filter(function collectGroupToken(token) {
      return token.eventIndex === next.token.eventIndex &&
        Math.abs((token.timeSeconds || 0) - (next.token.timeSeconds || 0)) <= MAX_WHISPER_GROUP_SECONDS &&
        shouldResolveWithWhisper(token) &&
        !token.resolved &&
        !token.resolving;
    }).sort(function sortGroup(left, right) {
      return (left.eventTokenIndex || 0) - (right.eventTokenIndex || 0);
    });

    while (group.length > MAX_WHISPER_GROUP_TOKENS) {
      if (group.indexOf(next.token) >= MAX_WHISPER_GROUP_TOKENS) {
        group.shift();
      } else {
        group.pop();
      }
    }

    if (!mediaSegmentsForRange(
      Math.max(0, group[0].timeSeconds - AUDIO_CONTEXT_SECONDS),
      group[group.length - 1].timeSeconds + AUDIO_CONTEXT_SECONDS
    ).length) {
      return null;
    }

    group = group.map(function mapGroupToken(token) {
      return {
        token: token
      };
    });

    if (group.length > 1) {
      debugLog("whisper group", {
        eventIndex: next.token.eventIndex,
        size: group.length,
        tokens: group.map(function mapGroupInfo(entry) {
          return entry.token.tokenIndex;
        })
      });
    }

    return group.length > 1 ? group : [next];
  }

  function compactPendingTokens() {
    pendingTokens.forEach(function deleteResolvedToken(token, key) {
      if (token.resolved || failedTokens.has(token.tokenIndex)) {
        pendingTokens.delete(key);
      }
    });
    compactMediaSegments();
  }

  function segmentNeeded(segment) {
    var needed = false;

    pendingTokens.forEach(function findCoveredToken(token) {
      var window = tokenWindow(token);

      if (!needed && shouldResolveWithWhisper(token) && !token.resolved &&
          segment.endTime > window.startTime && segment.startTime < window.endTime) {
        needed = true;
      }
    });

    return needed;
  }

  function segmentInBufferedRange(segment) {
    var video = findVideo();
    var buffered = video && video.buffered;
    var index;

    if (!buffered || typeof buffered.length !== "number") {
      return true;
    }

    for (index = 0; index < buffered.length; index += 1) {
      if (segment.endTime >= buffered.start(index) - AUDIO_CONTEXT_SECONDS &&
          segment.startTime <= buffered.end(index) + AUDIO_CONTEXT_SECONDS) {
        return true;
      }
    }

    return false;
  }

  function compactMediaSegments() {
    mediaAudio.segments.sort(function sortSegments(left, right) {
      return left.startTime - right.startTime;
    });
    mediaAudio.segments = mediaAudio.segments.filter(function keepNeededSegment(segment) {
      if (segmentNeeded(segment) || segmentInBufferedRange(segment)) {
        return true;
      }

      return false;
    });

    if (!mediaAudio.segments.length) {
      return;
    }
  }

  function scheduleWhisperQueue() {
    if (whisperQueueScheduled || !root.setTimeout) {
      return;
    }

    whisperQueueScheduled = true;
    root.setTimeout(processWhisperQueue, 0);
  }

  function processWhisperQueue() {
    var group;
    var queueStart;

    whisperQueueScheduled = false;
    if (!options.whisperEnabled || !activeDocument() || !mediaAudio.segments.length || !pendingTokens.size || activeWhisperRequests >= MAX_ACTIVE_WHISPER_REQUESTS) {
      return;
    }

    queueStart = typeof performance !== "undefined" ? performance.now() : 0;
    group = findResolvableTokenGroup();
    if (!group) {
      compactPendingTokens();
      return;
    }

    group.forEach(function markResolving(entry) {
      entry.token.resolving = true;
      entry.token.attempted = true;
    });
    activeWhisperRequests += 1;
    resolveTokenGroupFromMedia(group).then(function logResolutionTime(decision) {
      if (queueStart) {
        debugLog("whisper resolved", {
          tokens: group.map(function resolvedGroupToken(entry) {
            var resolution = resolvedTokens.get(tokenCacheKey(entry.token));
            return {
              tokenIndex: entry.token.tokenIndex,
              word: resolution && resolution.word || null
            };
          }),
          elapsedMs: Math.round(typeof performance !== "undefined" ? performance.now() - queueStart : 0),
          score: decision && decision.score
        });
      }
      return decision;
    }).catch(function logMediaResolutionError(error) {
      var errorInfo = {
        tokenIndex: group[0].token.tokenIndex,
        groupSize: group.length,
        error: error && (error.message || String(error)),
        stack: error && error.stack,
        elapsedMs: queueStart ? Math.round(typeof performance !== "undefined" ? performance.now() - queueStart : 0) : 0
      };
      debugLog("media token unresolved", errorInfo);
      if (console && console.warn) {
        console.warn("[uncensored] whisper group error", errorInfo);
      }

      group.forEach(function markFailed(entry) {
        if (!entry.token.resolved) {
          failedTokens.set(entry.token.tokenIndex, { reason: "transcription error" });
        }
      });
    }).finally(function clearMediaResolving() {
      activeWhisperRequests = Math.max(0, activeWhisperRequests - 1);
      group.forEach(function clearResolving(entry) {
        entry.token.resolving = false;
        if (entry.token.resolved || failedTokens.has(entry.token.tokenIndex)) {
          pendingTokens.delete(tokenCacheKey(entry.token));
        }
      });
      compactPendingTokens();
      var next = nextResolvableMediaToken();
      debugLog("whisper queue state", {
        activeRequests: activeWhisperRequests,
        pendingCount: pendingTokens.size,
        nextTokenIndex: next ? next.token.tokenIndex : null,
        activeDocument: activeDocument(),
        mediaStart: mediaAudio.segments.length ? mediaAudio.segments[0].startTime : null,
        mediaEnd: mediaAudio.segments.length ? mediaAudio.segments[mediaAudio.segments.length - 1].endTime : null
      });
      scheduleWhisperQueue();
    });
    if (activeWhisperRequests < MAX_ACTIVE_WHISPER_REQUESTS) {
      scheduleWhisperQueue();
    }
  }

  function rememberTimedTextTokens(tokens) {
    var existing = Object.create(null);

    if (!rules || !tokens || !tokens.length) {
      return;
    }

    pendingTokens.forEach(function markExisting(token) {
      existing[tokenCacheKey(token)] = true;
    });

    resolvedTokens.forEach(function markResolved(resolution) {
      if (options.rulesEnabled || resolution.source === "media") {
        existing[resolution.key] = true;
      }
    });

    tokens.forEach(function addPendingToken(token) {
      var key = tokenCacheKey(token);
      var contextWord = contextWordForToken(token);
      var resolved = resolvedTokens.get(key);

      token.navigationGeneration = navigationGeneration;

      if (resolved && resolved.word && (options.rulesEnabled || resolved.source === "media")) {
        applyVisibleCaptionResolution(token, resolved.word, resolved.source);
        return;
      }

      if (options.rulesEnabled && token.deterministicWord && !deterministicIsAmbiguous(token)) {
        rememberResolution(token, token.deterministicWord, "deterministic");
      }

      if (options.rulesEnabled && contextWord) {
        rememberResolution(token, contextWord, "context");
        applyVisibleCaptionResolution(token, contextWord, "context");
        return;
      }

      if (!existing[key] && shouldResolveWithWhisper(token)) {
        existing[key] = true;
        pendingTokens.set(key, Object.assign({}, token, {
          navigationGeneration: navigationGeneration,
          resolved: false,
          resolving: false
        }));
      }
    });

    if (!pendingTokens.size) {
      return;
    }

    startLiveCaptionResolver();
    if (options.whisperEnabled && activeDocument()) {
      warmupWhisperHost();
      preloadWhisper();
      if (mediaAudio.segments.length) {
        resolvePendingTokensFromMedia();
      }
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



  function captionSnapshot(segments) {
    var fullText = "";
    var entries = [];

    segments.forEach(function addSegment(segment, index) {
      var text = segment.textContent || "";

      if (index) {
        fullText += " ";
      }

      entries.push({
        segment: segment,
        start: fullText.length,
        text: text
      });
      fullText += text;
    });

    return {
      text: fullText,
      entries: entries
    };
  }

  function replaceTokenInSegment(entry, tokenStart, tokenText, word) {
    var localStart = tokenStart - entry.start;
    var text = entry.segment.textContent || "";

    entry.segment.textContent = text.slice(0, localStart) + word + text.slice(localStart + tokenText.length);
  }

  function contextSideWords(text, keepRight) {
    var words = normalizeContext(text).split(/\s+/).filter(function useful(word) {
      return word && word !== rules.CENSORED_TOKEN && word.length > 1;
    });

    return keepRight ? words.slice(0, 3) : words.slice(-3);
  }

  function wordsAtEdge(text, words, atEnd) {
    var normalizedText = normalizeContext(text);
    var phrase = words.join(" ");
    return atEnd
      ? normalizedText === phrase || normalizedText.slice(-(phrase.length + 1)) === " " + phrase
      : normalizedText === phrase || normalizedText.slice(0, phrase.length + 1) === phrase + " ";
  }

  function visibleTokenOccurrenceMatches(text, tokenStart, resolution) {
    var normalizedText = normalizeContext(text);
    var contextParts = normalizeContext(resolution.context).split(rules.CENSORED_TOKEN);
    var beforeWords = contextSideWords(contextParts[0] || "", false);
    var afterWords = contextSideWords(contextParts.slice(1).join(" "), true);
    var tokenMatch = tokenStart === null
      ? CENSORED_TOKEN_REGEX.exec(normalizedText)
      : {
        index: tokenStart,
        0: rules.CENSORED_TOKEN
      };

    if (!tokenMatch || tokenMatch.index === undefined) {
      return false;
    }

    var beforeText = normalizedText.slice(0, tokenMatch.index);
    var afterText = normalizedText.slice(tokenMatch.index + tokenMatch[0].length);
    var beforeMatches = beforeWords.length && wordsAtEdge(beforeText, beforeWords, true);
    var afterMatches = afterWords.length && wordsAtEdge(afterText, afterWords, false);
    var visibleAfterWords;

    if (!beforeWords.length && !afterWords.length) {
      return false;
    }

    if (beforeMatches || afterMatches) {
      return true;
    }

    visibleAfterWords = contextSideWords(afterText, true);
    if (!afterWords.length || visibleAfterWords.length < Math.min(2, afterWords.length)) {
      return false;
    }

    return wordsAtEdge(afterText, visibleAfterWords, false) && visibleAfterWords.every(function matchesKnownAfterPrefix(word, index) {
      return afterWords[index] === word;
    });
  }

  function normalizedTokenStartForOccurrence(text, occurrenceIndex) {
    var normalizedText = normalizeContext(text);
    var match;
    var index = 0;

    CENSORED_TOKEN_GLOBAL_REGEX.lastIndex = 0;
    while ((match = CENSORED_TOKEN_GLOBAL_REGEX.exec(normalizedText)) !== null) {
      if (index === occurrenceIndex) {
        return match.index;
      }

      index += 1;
    }

    return -1;
  }

  function patchMatchingVisibleToken(segments, resolution) {
    var snapshot = captionSnapshot(segments);
    var match;
    var occurrenceIndex = 0;

    CENSORED_TOKEN_GLOBAL_REGEX.lastIndex = 0;
    while ((match = CENSORED_TOKEN_GLOBAL_REGEX.exec(snapshot.text)) !== null) {
      var tokenStart = normalizedTokenStartForOccurrence(snapshot.text, occurrenceIndex);
      var entry = snapshot.entries.find(function findEntry(candidate) {
        return match.index >= candidate.start && match.index < candidate.start + candidate.text.length;
      });

      occurrenceIndex += 1;
      if (!entry || tokenStart < 0 || !visibleTokenOccurrenceMatches(snapshot.text, tokenStart, resolution)) {
        continue;
      }

      replaceTokenInSegment(entry, match.index, match[0], resolution.word);
      lastPatchedCaptionText = captionSnapshot(segments).text;
      return true;
    }

    return false;
  }

  function applyVisibleTokenGroup(group) {
    var segments = captionSegments();
    var visualLines = [];
    var selected;
    var snapshot;
    var matches = [];
    var match;

    segments.forEach(function collectVisualLine(segment) {
      var element = segment.closest && segment.closest(".caption-visual-line");
      var line = visualLines.find(function sameLine(candidate) { return candidate.element === element; });

      if (!line) {
        line = { element: element, segments: [] };
        visualLines.push(line);
      }
      line.segments.push(segment);
    });

    selected = visualLines.slice().reverse().find(function completeGroupLine(line) {
      var count = 0;
      var lineText = captionSnapshot(line.segments).text;
      CENSORED_TOKEN_GLOBAL_REGEX.lastIndex = 0;
      while (CENSORED_TOKEN_GLOBAL_REGEX.exec(lineText) !== null) {
        count += 1;
      }
      return count === group.words.length;
    });
    if (!selected) {
      return false;
    }

    snapshot = captionSnapshot(selected.segments);
    CENSORED_TOKEN_GLOBAL_REGEX.lastIndex = 0;
    while ((match = CENSORED_TOKEN_GLOBAL_REGEX.exec(snapshot.text)) !== null) {
      matches.push({ index: match.index, text: match[0] });
    }
    matches.map(function pairGroupWord(target, index) {
      return { target: target, word: group.words[index] };
    }).reverse().forEach(function replaceGroupToken(pair) {
      var entry = snapshot.entries.find(function findEntry(candidate) {
        return pair.target.index >= candidate.start &&
          pair.target.index < candidate.start + candidate.text.length;
      });

      if (entry) {
        replaceTokenInSegment(entry, pair.target.index, pair.target.text, pair.word);
      }
    });
    lastPatchedCaptionText = captionSnapshot(segments).text;
    return true;
  }

  function applyVisibleCaptionResolution(token, word, source, visibleSegments) {
    var segments = visibleSegments || captionSegments();
    var captionText = segments.map(function segmentText(segment) {
      return segment.textContent || "";
    }).join(" ");
    var resolution = {
      context: token.context,
      word: word
    };

    return rules.hasCensoredToken(captionText) && patchMatchingVisibleToken(segments, resolution);
  }

  function applyResolvedVisibleMediaResolutions() {
    var video = findVideo();
    var playbackTime = video ? video.currentTime : NaN;
    var segments = captionSegments();
    var captionText = captionSnapshot(segments).text;

    pendingVisibleGroups.forEach(function applyPendingGroup(group, eventIndex) {
      var lastToken = group.tokens[group.tokens.length - 1];

      if (isFinite(playbackTime) && playbackTime > lastToken.timeSeconds + VISIBLE_REAPPLY_SECONDS) {
        pendingVisibleGroups.delete(eventIndex);
        return;
      }
      if (applyVisibleTokenGroup(group)) {
        captionText = captionSnapshot(segments).text;
      }
    });

    if (!isFinite(playbackTime) || !rules.hasCensoredToken(captionText)) {
      return;
    }

    resolvedTokenValues().filter(function currentNearbyResolution(resolution) {
      return resolution.source === "media" &&
        !pendingVisibleGroups.has(resolution.eventIndex) &&
        resolution.navigationGeneration === navigationGeneration &&
        typeof resolution.timeSeconds === "number" &&
        Math.abs(playbackTime - resolution.timeSeconds) <= VISIBLE_REAPPLY_SECONDS;
    }).sort(function nearestResolution(left, right) {
      return Math.abs(playbackTime - left.timeSeconds) - Math.abs(playbackTime - right.timeSeconds);
    }).some(function applyNearbyResolution(resolution) {
      if (applyVisibleCaptionResolution(resolution, resolution.word, "media", segments)) {
        captionText = captionSnapshot(segments).text;
      }
      return !rules.hasCensoredToken(captionText);
    });
  }

  function scheduleVisibleCaptionResolution() {
    if (visibleResolutionScheduled) {
      return;
    }

    visibleResolutionScheduled = true;
    function resolveVisibleSoon() {
      visibleResolutionScheduled = false;
      applyResolvedVisibleMediaResolutions();
    }

    if (root.requestAnimationFrame) {
      root.requestAnimationFrame(resolveVisibleSoon);
    } else {
      root.setTimeout(resolveVisibleSoon, 16);
    }
  }

  function mutationNodeIsCaptionRelated(node) {
    var element = node && node.nodeType === 3 ? node.parentElement : node;
    return Boolean(element && element.closest && element.closest(CAPTION_MUTATION_SELECTOR));
  }

  function mutationIsCaptionRelated(mutation) {
    var nodes = mutation.addedNodes || [];
    var index;

    if (mutationNodeIsCaptionRelated(mutation.target)) {
      return true;
    }
    for (index = 0; index < nodes.length; index += 1) {
      if (mutationNodeIsCaptionRelated(nodes[index])) {
        return true;
      }
    }
    return false;
  }

  function watchCaptionMutations() {
    var MutationObserverCtor = root.MutationObserver;
    var target = root.document && root.document.querySelector("#movie_player, .html5-video-player");

    if (captionObserver || !MutationObserverCtor || !target) {
      return;
    }

    captionObserver = new MutationObserverCtor(function captionsChanged(mutations) {
      var captionText;

      if (!resolvedTokens.size || !Array.prototype.some.call(mutations || [], mutationIsCaptionRelated)) {
        return;
      }

      captionText = captionSnapshot(captionSegments()).text;
      if (captionText === lastPatchedCaptionText) {
        lastPatchedCaptionText = "";
        return;
      }
      scheduleVisibleCaptionResolution();
    });
    captionObserver.observe(target, {
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
    watchCaptionMutations();

    root.setInterval(function resolveVisibleTokens() {
      var video = findVideo();

      if (!captionObserver) {
        watchCaptionMutations();
      }
      if (!video || !activeDocument() || !pendingTokens.size) {
        return;
      }

      resolvePendingTokensFromMedia();
    }, 250);
  }

  var exports = Object.freeze({
    setSabrAudioData: setSabrAudioData,
    setOptions: function setOptions(nextOptions) {
      var previousRulesEnabled = options.rulesEnabled;

      nextOptions = nextOptions || {};
      options.rulesEnabled = nextOptions.rulesEnabled !== false;
      options.whisperEnabled = nextOptions.whisperEnabled !== false;
      if (previousRulesEnabled && !options.rulesEnabled) {
        resolvedTokens.forEach(function deleteRuleResolution(resolution, key) {
          if (resolution.source !== "media") {
            resolvedTokens.delete(key);
          }
        });
      }
      if (options.whisperEnabled && activeDocument()) {
        warmupWhisperHost();
        scheduleWhisperQueue();
      } else {
        mediaAudio.segments = [];
      }
    },
    rememberTimedTextTokens: rememberTimedTextTokens,
    startVisibleCaptionResolver: startLiveCaptionResolver,
    debugState: function debugState() {
      return {
        mediaAudio: {
          videoId: mediaAudio.videoId,
          ready: Boolean(mediaAudio.segments && mediaAudio.segments.length),
          segments: (mediaAudio.segments || []).map(function mapSegment(segment) {
            return {
              startTime: segment.startTime,
              endTime: segment.endTime,
              duration: segment.buffer.duration
            };
          }),
          error: mediaAudio.error
        },
        pendingTokens: pendingTokenValues().map(function mapToken(token) {
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
        resolvedTokens: resolvedTokenValues()
      };
    }
  });

  root.UncensoredAudioInference = exports;
  if (root.addEventListener) {
    root.addEventListener("yt-navigate-finish", resetForNavigation);
    root.addEventListener("visibilitychange", function onTabVisible() {
      if (!root.document || !root.document.hidden) {
        scheduleWhisperQueue();
      }
    });
  }
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
