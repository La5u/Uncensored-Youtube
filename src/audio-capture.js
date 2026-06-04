(function buildAudioCapture() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var rules = root.UncensoredRules;
  var sabrParser = root.UncensoredSabrParser;
  var runtime = root.browser || root.chrome;

  var SLICE_BEFORE_SECONDS = 1.25;
  var SLICE_AFTER_SECONDS = 1.25;
  var PLAYBACK_PRIORITY_SECONDS = 12;
  var VISIBLE_RESOLUTION_SECONDS = 12;
  var CLEAR_WHISPER_SCORE = 10;
  var TARGET_SAMPLE_RATE = 16000;
  var MAX_AUDIO_SEGMENTS = 12;
  var MAX_AUDIO_SECONDS = 90;
  var MAX_AUDIO_BYTES = 96 * 1024 * 1024;
  var CENSORED_TOKEN_REGEX = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "u");
  var CENSORED_TOKEN_GLOBAL_REGEX = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
  var pendingTokens = new Map();
  var resolvedTokens = new Map();
  var liveResolverStarted = false;
  var activeWhisperRequests = 0;
  var whisperQueueScheduled = false;
  var audioContext = null;
  var MAX_ACTIVE_WHISPER_REQUESTS = 1;
  var globalSabrParser = null;
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

  function resetForNavigation() {
    if (mediaAudio.videoId && currentVideoId() === mediaAudio.videoId) {
      pendingTokens.forEach(function retryToken(token) {
        token.resolving = false;
        token.attemptedCoverageEnd = 0;
      });
      activeWhisperRequests = 0;
      scheduleWhisperQueue();
      return;
    }

    pendingTokens.clear();
    resolvedTokens.clear();
    mediaAudio.videoId = "";
    mediaAudio.source = "";
    mediaAudio.loading = false;
    mediaAudio.buffer = null;
    mediaAudio.segments = [];
    mediaAudio.error = "";
    globalSabrParser = null;
  }

  // ── Whisper via background relay ──

  function bgMessage(type, data) {
    return new Promise(function bg(resolve) {
      try {
        runtime.runtime.sendMessage(Object.assign({ uncensoredWhisper: true, type: type }, data ? { data: data } : {}), function handleResponse(response) {
          resolve(response || {});
        });
      } catch (error) {
        resolve({});
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
    bgMessage("preload");
  }

  // ── Shared audio segment helpers ──

  function addAudioSegment(startTime, buffer, bytes) {
    var segment = {
      startTime: startTime,
      endTime: startTime + buffer.duration,
      buffer: buffer,
      bytes: bytes || 0
    };
    var duplicate = mediaAudio.segments.some(function hasSegment(existing) {
      return Math.abs(existing.startTime - segment.startTime) < 0.01 &&
        Math.abs(existing.endTime - segment.endTime) < 0.01;
    });
    if (duplicate) return;
    mediaAudio.videoId = mediaAudio.videoId || currentVideoId();
    mediaAudio.source = mediaAudio.source || "sabr";
    mediaAudio.loading = false;
    mediaAudio.error = "";
    mediaAudio.segments.push(segment);
    mediaAudio.segments.sort(function sortSegments(left, right) {
      return left.startTime - right.startTime;
    });
    compactMediaSegments(false);
    debugLog("sabr audio ready", {
      bytes: segment.bytes,
      startTime: segment.startTime,
      endTime: segment.endTime,
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      coveredSeconds: mediaAudio.segments.reduce(function totalCovered(total, item) {
        return total + Math.max(0, item.endTime - item.startTime);
      }, 0)
    });
    resolvePendingTokensFromMedia();
  }

  function decodeSabrSegment(segment) {
    if (!sabrParser || !sabrParser.chunksToArrayBuffer || !segment || !segment.chunks) return;
    var encoded = sabrParser.chunksToArrayBuffer(segment.chunks);
    currentAudioContext().then(function decode(context) {
      return context.decodeAudioData(encoded.slice(0));
    }).then(function decoded(buffer) {
      var startTime = typeof segment.header.startMs === "number" ? segment.header.startMs / 1000 : 0;
      addAudioSegment(startTime, buffer, encoded.byteLength);
    }, function decodeFailed(error) {
      debugLog("audio decode failed", error && (error.message || String(error)));
    });
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

    compactMediaSegments(false);
    mediaAudio.videoId = currentVideoId();
    mediaAudio.source = "sabr";
    mediaAudio.loading = true;
    if (!mediaAudio.segments) {
      mediaAudio.segments = [];
    }
    mediaAudio.promise = currentAudioContext().then(function decodeWithContext(context) {
      return context.decodeAudioData(base64ToArrayBuffer(detail.base64));
    }).then(function decoded(buffer) {
      var startTime = typeof detail.startMs === "number" ? detail.startMs / 1000 : 0;
      var segment = {
        startTime: startTime,
        endTime: startTime + buffer.duration,
        buffer: buffer,
        bytes: detail.segmentBytes || detail.bytes || 0
      };
      var duplicate;

      duplicate = mediaAudio.segments.some(function hasSegment(existing) {
        return Math.abs(existing.startTime - segment.startTime) < 0.01 &&
          Math.abs(existing.endTime - segment.endTime) < 0.01;
      });
      if (duplicate) {
        mediaAudio.loading = false;
        return buffer;
      }

      mediaAudio.segments.push(segment);
      mediaAudio.segments.sort(function sortSegments(left, right) {
        return left.startTime - right.startTime;
      });
      mediaAudio.buffer = buffer;
      mediaAudio.loading = false;
      mediaAudio.error = "";
      compactMediaSegments(false);
      debugLog("sabr audio ready", {
        itag: detail.itag,
        bytes: segment.bytes,
        startTime: segment.startTime,
        endTime: segment.endTime,
        duration: buffer.duration,
        sampleRate: buffer.sampleRate,
        coveredSeconds: mediaAudio.segments.reduce(function totalCovered(total, item) {
          return total + Math.max(0, item.endTime - item.startTime);
        }, 0)
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
      root.dispatchEvent(new CustomEvent("uncensored-whisper-resolution", {
        detail: JSON.stringify({
          tokenIndex: token.tokenIndex,
          word: word,
          source: source || "unknown"
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

  function isUsableWhisperDecision(token, decision) {
    if (!decision || !decision.word) {
      return false;
    }

    if (!options.rulesEnabled) {
      return true;
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

  function segmentForToken(token) {
    if (!token || !mediaAudio.segments || !mediaAudio.segments.length) {
      return null;
    }

    return mediaAudio.segments.find(function findSegment(segment) {
      return token.timeSeconds >= segment.startTime - SLICE_BEFORE_SECONDS &&
        token.timeSeconds <= segment.endTime;
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

  function applyResolvedWord(token, resolution) {
    var word = resolution && resolution.word;

    if (!word) {
      return;
    }

    token.resolved = true;
    rememberResolution(token, word, resolution.source);
    applyVisibleCaptionResolution(token, word, resolution.source);
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
    if (!options.whisperEnabled || !mediaAudio.segments.length || !pendingTokens.size) {
      return;
    }

    scheduleWhisperQueue();
  }

  function startAudioChunkStream(message) {
    if (!options.whisperEnabled || !message || !message.streamId) return;
    var videoId = message.videoId || currentVideoId();
    if (videoId && mediaAudio.videoId && mediaAudio.videoId !== videoId) {
      globalSabrParser = null;
      mediaAudio.videoId = videoId;
    } else if (videoId && !mediaAudio.videoId) {
      mediaAudio.videoId = videoId;
    }
    if (sabrParser && sabrParser.createParser && !globalSabrParser) {
      globalSabrParser = sabrParser.createParser({
        onSegment: decodeSabrSegment
      });
    }
    debugLog("background audio stream start", {
      streamId: message.streamId,
      url: String(message.url || "").slice(0, 120)
    });
  }

  function appendAudioStreamChunk(message) {
    if (!options.whisperEnabled || !message || !message.buffer || !globalSabrParser) return;
    globalSabrParser.push(message.buffer);
  }

  function endAudioChunkStream(message) {
    if (!message || message.error) {
      debugLog("background audio stream error", message && message.error);
    }
  }

  function warmupWhisperHost() {
    if (options.whisperEnabled) {
      warmupWhisper();
    }
  }

  function nextResolvableMediaToken() {
    var selected = null;
    var video = findVideo();
    var playbackTime = video ? video.currentTime : NaN;
    var hasPlaybackTime = isFinite(playbackTime);

    pendingTokenValues().forEach(function findToken(token) {
      var segment;
      var distance;

      if (!shouldResolveWithWhisper(token) || token.resolved || token.resolving) {
        return;
      }

      segment = segmentForToken(token);
      if (!segment) {
        return;
      }

      if (token.attemptedCoverageEnd && token.attemptedCoverageEnd >= segment.endTime) {
        return;
      }

      distance = hasPlaybackTime ? Math.abs(playbackTime - token.timeSeconds) : Infinity;
      if (hasPlaybackTime && distance > PLAYBACK_PRIORITY_SECONDS) {
        return;
      }

      if (!selected || distance < selected.distance) {
        selected = {
          token: token,
          segment: segment,
          distance: distance
        };
      }
    });

    return selected;
  }

  function compactPendingTokens() {
    pendingTokens.forEach(function deleteResolvedToken(token, key) {
      if (token.resolved) {
        pendingTokens.delete(key);
      }
    });
    compactMediaSegments(true);
  }

  function compactMediaSegments(clearWhenIdle) {
    var firstNeeded = Infinity;
    var coveredSeconds = 0;
    var coveredBytes = 0;

    pendingTokens.forEach(function findFirstNeeded(token) {
      if (!token.resolved && typeof token.timeSeconds === "number") {
        firstNeeded = Math.min(firstNeeded, token.timeSeconds);
      }
    });

    if (!isFinite(firstNeeded) && clearWhenIdle) {
      mediaAudio.segments = [];
      mediaAudio.buffer = null;
      return;
    }

    if (isFinite(firstNeeded)) {
      mediaAudio.segments = mediaAudio.segments.filter(function keepSegment(segment) {
        return segment.endTime >= firstNeeded - SLICE_BEFORE_SECONDS;
      });
    }
    mediaAudio.segments.sort(function sortSegments(left, right) {
      return left.startTime - right.startTime;
    });

    while (mediaAudio.segments.length > MAX_AUDIO_SEGMENTS) {
      mediaAudio.segments.shift();
    }

    coveredSeconds = mediaAudio.segments.reduce(function totalCoveredSeconds(total, segment) {
      return total + Math.max(0, segment.endTime - segment.startTime);
    }, 0);
    coveredBytes = mediaAudio.segments.reduce(function totalCoveredBytes(total, segment) {
      return total + Math.max(0, segment.bytes || 0);
    }, 0);

    while (mediaAudio.segments.length > 1 && (coveredSeconds > MAX_AUDIO_SECONDS || coveredBytes > MAX_AUDIO_BYTES)) {
      var removed = mediaAudio.segments.shift();

      coveredSeconds -= Math.max(0, removed.endTime - removed.startTime);
      coveredBytes -= Math.max(0, removed.bytes || 0);
    }

    mediaAudio.buffer = mediaAudio.segments.length ? mediaAudio.segments[mediaAudio.segments.length - 1].buffer : null;
  }

  function scheduleWhisperQueue() {
    if (whisperQueueScheduled || !root.setTimeout) {
      return;
    }

    whisperQueueScheduled = true;
    root.setTimeout(processWhisperQueue, 0);
  }

  function processWhisperQueue() {
    var next;

    whisperQueueScheduled = false;
    if (!options.whisperEnabled || !mediaAudio.segments.length || !pendingTokens.size || activeWhisperRequests >= MAX_ACTIVE_WHISPER_REQUESTS) {
      return;
    }

    next = nextResolvableMediaToken();
    if (!next) {
      compactPendingTokens();
      return;
    }

    next.token.resolving = true;
    next.token.attempted = true;
    next.token.attemptedByMedia = true;
    next.token.attemptedCoverageEnd = next.segment.endTime;
    activeWhisperRequests += 1;
    resolveTokenFromMedia(next.token).then(function mediaResolution(resolution) {
      applyResolvedWord(next.token, resolution);
    }).catch(function ignoreMediaResolution(error) {
      debugLog("media token unresolved", {
        tokenIndex: next.token.tokenIndex,
        error: error && (error.message || String(error))
      });
    }).finally(function clearMediaResolving() {
      activeWhisperRequests = Math.max(0, activeWhisperRequests - 1);
      next.token.resolving = false;
      if (!next.token.resolved) {
        pendingTokens.delete(tokenCacheKey(next.token));
      }
      compactPendingTokens();
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
          resolved: false,
          resolving: false
        }));
      }
    });

    debugLog("remembered timedtext tokens", {
      added: tokens.length,
      pending: pendingTokens.size
    });

    if (!pendingTokens.size) {
      return;
    }

    startLiveCaptionResolver();
    if (options.whisperEnabled) {
      warmupWhisperHost();
      preloadWhisper();
      if (mediaAudio.segments.length) {
        resolvePendingTokensFromMedia();
      } else {
        debugLog("pending tokens waiting for page audio", {
          pending: pendingTokens.size
        });
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

  function replaceFirst(text, from, to) {
    if (!from) {
      return text;
    }

    return text.replace(from, to);
  }

  function contextSideWords(text, keepRight) {
    var words = normalizeContext(text).split(/\s+/).filter(function useful(word) {
      return word && word !== rules.CENSORED_TOKEN && word !== "something" && word.length > 1;
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

    return wordsInOrder(beforeText, beforeWords) && wordsInOrder(afterText, afterWords);
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
      return true;
    }

    return false;
  }

  function applyVisibleCaptionResolution(token, word, source) {
    var segments = captionSegments();
    var captionText = segments.map(function segmentText(segment) {
      return segment.textContent || "";
    }).join(" ");
    var changed = false;
    var resolution = {
      context: token.context,
      word: word
    };

    if (rules.hasCensoredToken(captionText) && patchMatchingVisibleToken(segments, resolution)) {
      return true;
    }

    if (!options.rulesEnabled) {
      return false;
    }

    segments.forEach(function patchSegment(segment) {
      var text = segment.textContent || "";
      var patched = text;

      if (CENSORED_TOKEN_REGEX.test(patched)) {
        patched = patched.replace(CENSORED_TOKEN_REGEX, word);
      } else if (options.rulesEnabled && token.deterministicWord && patched.indexOf(token.deterministicWord) !== -1) {
        patched = replaceFirst(patched, token.deterministicWord, word);
      }

      if (patched !== text) {
        segment.textContent = patched;
        changed = true;
      }
    });

    return changed;
  }

  function applyResolvedVisibleMediaResolutions() {
    var video = findVideo();
    var playbackTime = video ? video.currentTime : NaN;
    var applied = 0;

    if (!resolvedTokens.size || !rules.hasCensoredToken(captionSegments().map(function segmentText(segment) {
      return segment.textContent || "";
    }).join(" "))) {
      return;
    }

    resolvedTokenValues().filter(function nearbyMediaResolution(resolution) {
      return resolution.source === "media" &&
        isFinite(playbackTime) &&
        typeof resolution.timeSeconds === "number" &&
        Math.abs(playbackTime - resolution.timeSeconds) <= VISIBLE_RESOLUTION_SECONDS;
    }).sort(function sortByDistance(left, right) {
      if (left.eventIndex === right.eventIndex &&
          typeof left.eventTokenIndex === "number" &&
          typeof right.eventTokenIndex === "number") {
        return left.eventTokenIndex - right.eventTokenIndex;
      }

      return Math.abs(playbackTime - left.timeSeconds) - Math.abs(playbackTime - right.timeSeconds);
    }).some(function applyNearbyResolution(resolution) {
      if (applied >= 4) {
        return true;
      }

      if (!rules.hasCensoredToken(captionSegments().map(function segmentText(segment) {
        return segment.textContent || "";
      }).join(" "))) {
        return true;
      }

      if (applyVisibleCaptionResolution(resolution, resolution.word, "media")) {
        applied += 1;
        return false;
      }

      return false;
    });
  }

  function startLiveCaptionResolver() {
    if (liveResolverStarted || !root.setInterval) {
      return;
    }

    liveResolverStarted = true;

    root.setInterval(function resolveVisibleTokens() {
      var video = findVideo();

      if (!video || (!pendingTokens.size && !resolvedTokens.size)) {
        return;
      }

      applyResolvedVisibleMediaResolutions();
      if (pendingTokens.size) {
        resolvePendingTokensFromMedia();
      }
    }, 250);
  }

  var exports = Object.freeze({
    setSabrAudioData: setSabrAudioData,
    startAudioChunkStream: startAudioChunkStream,
    appendAudioStreamChunk: appendAudioStreamChunk,
    endAudioChunkStream: endAudioChunkStream,
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
      if (options.whisperEnabled) {
        warmupWhisperHost();
        scheduleWhisperQueue();
      }
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
        pendingTokens: pendingTokenValues().map(function mapToken(token) {
          return {
            tokenIndex: token.tokenIndex,
            timeSeconds: token.timeSeconds,
            context: token.context,
            deterministicWord: token.deterministicWord,
            candidates: token.candidates,
            resolved: token.resolved,
            resolving: token.resolving,
            attempted: token.attempted,
            attemptedCoverageEnd: token.attemptedCoverageEnd || 0
          };
        }),
        resolvedTokens: resolvedTokenValues()
      };
    }
  });

  root.UncensoredAudioInference = exports;
  if (root.addEventListener) {
    root.addEventListener("yt-navigate-finish", resetForNavigation);
  }
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
