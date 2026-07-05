(function buildAudioCapture() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var rules = root.UncensoredRules;
  var runtime = root.browser || root.chrome;

  var SLICE_BEFORE_SECONDS = 1.25;
  var SLICE_AFTER_SECONDS = 1.25;
  var VISIBLE_RESOLUTION_SECONDS = 12;
  var CLEAR_WHISPER_SCORE = 10;
  var MAX_WHISPER_GROUP_TOKENS = 5;
  var MAX_WHISPER_GROUP_SECONDS = 4;
  var CAPTION_MUTATION_SELECTOR = ".ytp-caption-segment, .caption-window, .caption-visual-line, .ytp-caption-window-container";
  var TARGET_SAMPLE_RATE = 16000;
  var CENSORED_TOKEN_REGEX = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "u");
  var CENSORED_TOKEN_GLOBAL_REGEX = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
  var pendingTokens = new Map();
  var resolvedTokens = new Map();
  var liveResolverStarted = false;
  var visibleResolutionScheduled = false;
  var activeWhisperRequests = 0;
  var whisperQueueScheduled = false;
  var audioContext = null;
  var decodeQueue = Promise.resolve();
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
        token.attemptedCoverageEnd = 0;
      });
      scheduleWhisperQueue();
      return;
    }

    pendingTokens.clear();
    resolvedTokens.clear();
    mediaAudio.videoId = "";
    mediaAudio.segments = [];
    mediaAudio.error = "";
  }

  // ── Whisper via background relay ──

  function bgMessage(type, data) {
    return new Promise(function bg(resolve) {
      var message = Object.assign({ uncensoredWhisper: true, type: type }, data ? { data: data } : {});
      var result;

      try {
        if (root.browser && runtime === root.browser) {
          result = runtime.runtime.sendMessage(message);
          result.then(function handlePromiseResponse(response) {
            resolve(response || {});
          }, function ignorePromiseError() {
            resolve({});
          });
          return;
        }

        runtime.runtime.sendMessage(message, function handleResponse(response) {
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
    if (!detail || !(detail.buffer instanceof ArrayBuffer)) {
      return decodeQueue;
    }

    decodeQueue = decodeQueue.then(function decodeNextSegment() {
      var decodeStartedAt = root.performance && root.performance.now ? root.performance.now() : 0;

      if (!options.whisperEnabled) {
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
      if (!buffer) {
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

  function segmentForToken(token, afterEndTime) {
    if (!token || !mediaAudio.segments || !mediaAudio.segments.length) {
      return null;
    }

    return mediaAudio.segments.find(function findSegment(segment) {
      if (afterEndTime && segment.endTime <= afterEndTime) {
        return false;
      }

      return token.timeSeconds >= segment.startTime - SLICE_BEFORE_SECONDS &&
        token.timeSeconds <= segment.endTime;
    }) || null;
  }

  function resolveTokenFromMedia(token, selectedSegment) {
    return Promise.resolve(selectedSegment || segmentForToken(token)).then(function mediaReady(segment) {
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

  function resolveTokenGroupFromMedia(group) {
    if (group.length < 2) {
      return resolveTokenFromMedia(group[0].token, group[0].segment).then(function resolvedSingle(resolution) {
        applyResolvedWord(group[0].token, resolution);
      });
    }

    return Promise.resolve(group[0].segment).then(function mediaReady(segment) {
      var buffer = segment.buffer;
      var first = group[0].token.timeSeconds;
      var last = group[group.length - 1].token.timeSeconds;
      var startTime = Math.max(segment.startTime, first - SLICE_BEFORE_SECONDS) - segment.startTime;
      var endTime = Math.min(segment.endTime, last + SLICE_AFTER_SECONDS) - segment.startTime;
      var sourcePcm = readMediaSlice(buffer, startTime, endTime);
      var pcm16 = resampleLinear(sourcePcm, buffer.sampleRate, TARGET_SAMPLE_RATE);
      var candidates = [];
      var seen = Object.create(null);
      var context = group.map(function groupContext(entry) {
        return entry.token.context || "";
      }).join(" ");

      group.forEach(function mergeCandidates(entry) {
        candidatesForToken(entry.token).forEach(function addCandidate(candidate) {
          if (candidate && !seen[candidate]) {
            seen[candidate] = true;
            candidates.push(candidate);
          }
        });
      });

      return whisperTranscribe(pcm16, candidates, context, {
        force: true,
        slotOrdinal: 0,
        slotCount: group.length
      }).then(function applyGroupDecision(decision) {
        decision = decision || {};
        var words = Array.isArray(decision.words) ? decision.words : [];

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
            });
          }
        });
      });
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

  function warmupWhisperHost() {
    if (options.whisperEnabled) {
      warmupWhisper();
    }
  }

  function nextResolvableMediaToken() {
    var selected = null;

    pendingTokenValues().forEach(function findToken(token) {
      var segment;

      if (!shouldResolveWithWhisper(token) || token.resolved || token.resolving) {
        return;
      }

      segment = segmentForToken(token, token.attemptedCoverageEnd || 0);
      if (!segment) {
        return;
      }

      if (!selected ||
          (token.timeSeconds || 0) < (selected.token.timeSeconds || 0) ||
          ((token.timeSeconds || 0) === (selected.token.timeSeconds || 0) &&
            (token.tokenIndex || 0) < (selected.token.tokenIndex || 0))) {
        selected = {
          token: token,
          segment: segment
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
      var segment = segmentForToken(token, token.attemptedCoverageEnd || 0);

      return segment === next.segment &&
        token.eventIndex === next.token.eventIndex &&
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

    group = group.map(function mapGroupToken(token) {
      return {
        token: token,
        segment: next.segment
      };
    });

    return group.length > 1 ? group : [next];
  }

  function compactPendingTokens() {
    pendingTokens.forEach(function deleteResolvedToken(token, key) {
      if (token.resolved) {
        pendingTokens.delete(key);
      }
    });
    compactMediaSegments();
  }

  function segmentNeeded(segment) {
    var needed = false;

    pendingTokens.forEach(function findCoveredToken(token) {
      if (!needed && shouldResolveWithWhisper(token) && !token.resolved &&
          (!token.attemptedCoverageEnd || token.attemptedCoverageEnd < segment.endTime) &&
          token.timeSeconds >= segment.startTime - SLICE_BEFORE_SECONDS &&
          token.timeSeconds <= segment.endTime) {
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
      if (segment.endTime >= buffered.start(index) - SLICE_BEFORE_SECONDS &&
          segment.startTime <= buffered.end(index) + SLICE_AFTER_SECONDS) {
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

    whisperQueueScheduled = false;
    if (!options.whisperEnabled || !mediaAudio.segments.length || !pendingTokens.size || activeWhisperRequests >= MAX_ACTIVE_WHISPER_REQUESTS) {
      return;
    }

    group = findResolvableTokenGroup();
    if (!group) {
      compactPendingTokens();
      return;
    }

    group.forEach(function markResolving(entry) {
      entry.token.resolving = true;
      entry.token.attempted = true;
      entry.token.attemptedCoverageEnd = entry.segment.endTime;
    });
    activeWhisperRequests += 1;
    resolveTokenGroupFromMedia(group).catch(function ignoreMediaResolution(error) {
      debugLog("media token unresolved", {
        tokenIndex: group[0].token.tokenIndex,
        error: error && (error.message || String(error))
      });
    }).finally(function clearMediaResolving() {
      activeWhisperRequests = Math.max(0, activeWhisperRequests - 1);
      group.forEach(function clearResolving(entry) {
        entry.token.resolving = false;
        if (!entry.token.resolved && entry.token.timeSeconds + SLICE_AFTER_SECONDS <= entry.segment.endTime) {
          pendingTokens.delete(tokenCacheKey(entry.token));
        }
      });
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

    if (!pendingTokens.size) {
      return;
    }

    startLiveCaptionResolver();
    if (options.whisperEnabled) {
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

  function contextSideWords(text, keepRight) {
    var words = normalizeContext(text).split(/\s+/).filter(function useful(word) {
      return word && word !== rules.CENSORED_TOKEN && word.length > 1;
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
    var visibleAfterWords;

    if (!beforeWords.length && !afterWords.length) {
      return false;
    }

    if (!wordsInOrder(beforeText, beforeWords)) {
      return false;
    }

    if (wordsInOrder(afterText, afterWords)) {
      return true;
    }

    visibleAfterWords = contextSideWords(afterText, true);
    if (!beforeWords.length && !visibleAfterWords.length) {
      return false;
    }

    return visibleAfterWords.every(function matchesKnownAfterPrefix(word, index) {
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
    var applied = 0;
    var segments = captionSegments();
    var captionText = segments.map(function segmentText(segment) {
      return segment.textContent || "";
    }).join(" ");

    if (!resolvedTokens.size || !rules.hasCensoredToken(captionText)) {
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

      if (!rules.hasCensoredToken(captionText)) {
        return true;
      }

      if (applyVisibleCaptionResolution(resolution, resolution.word, "media", segments)) {
        applied += 1;
        captionText = segments.map(function segmentText(segment) {
          return segment.textContent || "";
        }).join(" ");
        return false;
      }

      return false;
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
    } else if (root.setTimeout) {
      root.setTimeout(resolveVisibleSoon, 16);
    }
  }

  function mutationNodeIsCaptionRelated(node) {
    var element = node && node.nodeType === 3 ? node.parentElement : node;

    return Boolean(element && element.closest && element.closest(CAPTION_MUTATION_SELECTOR));
  }

  function mutationIsCaptionRelated(mutation) {
    var addedNodes = mutation.addedNodes || [];
    var index;

    if (mutationNodeIsCaptionRelated(mutation.target)) {
      return true;
    }

    for (index = 0; index < addedNodes.length; index += 1) {
      if (mutationNodeIsCaptionRelated(addedNodes[index])) {
        return true;
      }
    }

    return false;
  }

  function watchCaptionMutations() {
    var MutationObserverCtor = root.MutationObserver;
    var target = root.document && (root.document.body || root.document.documentElement);

    if (!MutationObserverCtor || !target) {
      return;
    }

    new MutationObserverCtor(function captionsChanged(mutations) {
      if (resolvedTokens.size && Array.prototype.some.call(mutations || [], mutationIsCaptionRelated)) {
        scheduleVisibleCaptionResolution();
      }
    }).observe(target, {
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

      if (!video || !pendingTokens.size) {
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
      if (options.whisperEnabled) {
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
