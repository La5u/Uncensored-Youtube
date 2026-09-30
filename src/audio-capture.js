(function buildAudioCapture() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;
  var rules = root.UncensoredRules;
  var runtime = root.browser || root.chrome;

  // Candidate scoring hears the caption words spoken before the slot.
  var AUDIO_BEFORE_SECONDS = 3;
  var AUDIO_AFTER_SECONDS = 1.5;
  // Whisper encodes 30 s regardless, so one window serves every slot inside it.
  var WINDOW_SECONDS = 30;
  var AUDIO_DECODE_TIMEOUT_MS = 15000;
  var WHISPER_RETRY_DELAY_MS = 250;
  var WHISPER_MAX_RETRIES = 1;
  var MEDIA_GAP_TOLERANCE_SECONDS = 0.05;
  var TIMELINE_EVENT_RADIUS = 4;
  var TIMELINE_TIME_RADIUS_SECONDS = 15;
  var CAPTION_MUTATION_SELECTOR = ".ytp-caption-segment, .caption-window, .caption-visual-line, .ytp-caption-window-container";
  var TARGET_SAMPLE_RATE = 16000;
  var CENSORED_TOKEN_GLOBAL_REGEX = new RegExp(rules.CENSORED_TOKEN_REGEX.source, "gu");
  var pendingTokens = new Map();
  var resolvedTokens = new Map();
  var failedTokens = new Set();
  var captionObserver = null;
  var captionObserverTarget = null;
  var visibleResolutionScheduled = false;
  var captionTimeline = [];
  var captionTokens = [];
  var captionTrackId = "";
  var captionGeneration = 0;
  var seekGeneration = 0;
  var observedVideo = null;
  var lastPatchedCaptionText = "";
  var whisperBusy = false;
  var whisperQueueScheduled = false;
  var audioContext = null;
  var decodeQueue = Promise.resolve();
  // Retained PCM supplies completed dedup; this map owns queued/in-flight work only.
  var decodingSegmentStarts = new Map();
  var whisperModelState = "idle";
  var navigationGeneration = 0;
  var activeVideoId = "";
  var tokenMetadataKnown = false;
  var mediaAudio = {
    videoId: "",
    segments: []
  };
  var options = {
    rulesEnabled: true,
    whisperEnabled: true,
    whisperFirst: false,
    audioEnabled: true
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

  function mediaTimestamp(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  }

  function findVideo() {
    return root.document.querySelector("video");
  }

  function currentVideoId() {
    try {
      var url = new URL(root.location.href);
      if (url.pathname === "/watch") {
        var videoId = url.searchParams.get("v");
        if (videoId) return videoId;
      }
      var match = url.pathname.match(/^\/(?:live|shorts)\/([^/]+)/);
      return match ? match[1] : "";
    } catch (error) {
      return "";
    }
  }

  function resetForNavigation() {
    navigationGeneration += 1;
    tokenMetadataKnown = false;
    pendingTokens.clear();
    resolvedTokens.clear();
    failedTokens.clear();
    mediaAudio.videoId = "";
    mediaAudio.segments = [];
    decodingSegmentStarts.clear();
    lastPatchedCaptionText = "";
    captionTimeline = [];
    captionTokens = [];
    captionTrackId = "";
    captionGeneration += 1;
    seekGeneration += 1;
    stopCaptionWatching();
  }

  function syncVideo(videoId) {
    var current = currentVideoId();

    if (videoId && videoId !== current) return false;
    videoId = videoId || current;
    if (videoId === activeVideoId) return true;
    resetForNavigation();
    activeVideoId = videoId;
    mediaAudio.videoId = videoId;
    if (videoId) debugLog("new video", videoId);
    return true;
  }

  // ── Whisper via extension host ──

  function bgMessage(type, data) {
    var timeoutMs = 60000;
    return new Promise(function bg(resolve, reject) {
      var message = Object.assign({ uncensoredWhisper: true, type: type }, data ? { data: data } : {});
      var resolved = false;
      var timer = root.setTimeout(function bgTimedOut() {
        if (!resolved) {
          resolved = true;
          debugLog("bgMessage timeout", { type: type });
          reject(new Error("Whisper host timed out"));
        }
      }, timeoutMs);

      function done(response) {
        if (!resolved) {
          resolved = true;
          root.clearTimeout(timer);
          if (!response || response.error) {
            reject(new Error(response && response.error || "No Whisper host response"));
          } else {
            resolve(response);
          }
        }
      }

      try {
        if (root.browser && runtime === root.browser) {
          runtime.runtime.sendMessage(message).then(done, function handlePromiseError(error) {
            if (!resolved) {
              resolved = true;
              root.clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error || "Whisper host failed")));
            }
          });
          return;
        }

        runtime.runtime.sendMessage(message, function handleResponse(response) {
          var error = runtime.runtime.lastError;
          done(error ? { error: error.message || String(error) } : response);
        });
      } catch (error) {
        if (!resolved) {
          resolved = true;
          root.clearTimeout(timer);
          reject(error);
        }
      }
    });
  }

  function whisperTranscribe(audio, candidates, context, options, retryAllowed) {
    if (!audio || !audio.length || !candidates || !candidates.length) {
      return Promise.resolve({ word: "", transcript: "", evidence: "none" });
    }

    // Capture epochs, not just mutable token fields: a mode switch can requeue
    // the same slot while its old host request is still outstanding.
    var navigation = navigationGeneration;
    var caption = captionGeneration;
    var seek = seekGeneration;
    function checkCurrentRequest() {
      if (navigation !== navigationGeneration || caption !== captionGeneration ||
          seek !== seekGeneration || retryAllowed && !retryAllowed()) {
        var error = new Error("Whisper request superseded");
        error.cancelled = true;
        throw error;
      }
    }

    function attempt(retriesLeft) {
      var copy = audio.slice();
      return bgMessage("transcribe", {
        audio: copy.buffer,
        candidates: candidates,
        context: context,
        options: options
      }).then(function onDecision(response) {
        checkCurrentRequest();
        var decision = response.decision || response;
        if (!Array.isArray(decision.decisions)) throw new Error("Invalid Whisper decision");
        return decision;
      }).catch(function retryTransient(error) {
        checkCurrentRequest();
        if (error.cancelled || !retryAllowed || retriesLeft <= 0) throw error;
        return new Promise(function waitForRetry(resolve) {
          root.setTimeout(resolve, WHISPER_RETRY_DELAY_MS);
        }).then(function retryWhenReady() {
          checkCurrentRequest();
          return attempt(retriesLeft - 1);
        });
      });
    }

    return attempt(WHISPER_MAX_RETRIES);
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
        if (root.console && root.console.warn) {
          root.console.warn("[uncensored] whisper model failed to start", response && response.error || "No response");
        }
      }
    }, function modelPreloadFailed(error) {
      whisperModelState = "idle";
      debugLog("whisper model failed to start", error && (error.message || String(error)));
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
    if (duplicate) return;
    mediaAudio.videoId = mediaAudio.videoId || currentVideoId();
    mediaAudio.segments.push(segment);
    compactMediaSegments();
    scheduleWhisperQueue();
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
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new root.AudioContext();
    }

    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch(function ignoreResumeError() {});
    }

    return Promise.resolve(audioContext);
  }

  function closeAudioContext() {
    var context = audioContext;

    audioContext = null;
    if (context && context.state !== "closed" && context.close) {
      context.close().catch(function ignoreCloseError() {});
    }
  }

  function decodeAudio(context, buffer) {
    var timer;

    return Promise.race([
      context.decodeAudioData(buffer),
      new Promise(function decodeTimeout(resolve, reject) {
        timer = root.setTimeout(function timedOut() {
          reject(new Error("Audio decode timed out"));
        }, AUDIO_DECODE_TIMEOUT_MS);
      })
    ]).finally(function clearDecodeTimeout() {
      root.clearTimeout(timer);
    });
  }

  function setSabrAudioData(detail) {
    var segmentKey;

    if (detail && detail.videoId && detail.videoId !== currentVideoId()) return decodeQueue;
    syncVideo(detail && detail.videoId);
    var generation = navigationGeneration;

    if (!detail || !(detail.buffer instanceof ArrayBuffer)) {
      return decodeQueue;
    }
    if (!encodedSegmentNeeded(detail)) {
      return decodeQueue;
    }

    segmentKey = Number.isFinite(detail.startMs) ? Math.round(detail.startMs) : null;
    if (segmentKey !== null && (decodingSegmentStarts.has(segmentKey) ||
        mediaAudio.segments.some(function retainedSegment(segment) {
          return Math.round(segment.startTime * 1000) === segmentKey;
        }))) return decodeQueue;
    var reservation = {};
    if (segmentKey !== null) decodingSegmentStarts.set(segmentKey, reservation);

    function stillNeeded() {
      return generation === navigationGeneration && options.whisperEnabled &&
        options.audioEnabled && encodedSegmentNeeded(detail);
    }

    decodeQueue = decodeQueue.then(function decodeNextSegment() {
      if (!stillNeeded()) return null;

      return currentAudioContext().then(function decodeWithContext(context) {
        return stillNeeded() ? decodeAudio(context, detail.buffer) : null;
      });
    }).then(function decoded(buffer) {
      if (!buffer || generation !== navigationGeneration ||
          !options.whisperEnabled || !options.audioEnabled) {
        return;
      }

      var startTime = typeof detail.startMs === "number" ? detail.startMs / 1000 : 0;

      debugLog("audio decoded", mediaTimestamp(startTime));
      return addAudioSegment(startTime, buffer);
    }).catch(function failed(error) {
      debugLog("audio decode failed", error && (error.message || String(error)));
    }).finally(function releaseDecodeReservation() {
      // Navigation may have reserved this start again for a different video.
      if (segmentKey !== null && decodingSegmentStarts.get(segmentKey) === reservation) {
        decodingSegmentStarts.delete(segmentKey);
      }
    });

    return decodeQueue;
  }

  function encodedSegmentNeeded(detail) {
    var startTime;
    var endTime;
    var needed = false;

    if (!tokenMetadataKnown || !Number.isFinite(detail.startMs) || !Number.isFinite(detail.durationMs)) {
      return true;
    }
    startTime = detail.startMs / 1000;
    endTime = startTime + detail.durationMs / 1000;
    pendingTokens.forEach(function findCoveredToken(token) {
      if (!needed && tokenNeedsAudio(token, startTime, endTime)) needed = true;
    });
    return needed;
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

    mediaAudio.segments.forEach(function collectSegment(segment) {
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
      startTime: Math.max(0, token.timeSeconds - AUDIO_BEFORE_SECONDS),
      endTime: token.timeSeconds + AUDIO_AFTER_SECONDS
    };
  }

  function candidatesForToken() {
    // Hybrid runs the same full-vocabulary recognizer as Whisper-only; rules
    // never restrict what audio may recognize.
    return rules.ALLOWED_WORDS;
  }

  function normalizeContext(text) {
    return text
      .toLowerCase()
      .replace(/\[\s*__\s*\]/gu, rules.CENSORED_TOKEN)
      .replace(/[^a-z0-9_\[\]\s']+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenCacheKey(token) {
    return token.tokenIndex + "\n" + Math.round(token.timeSeconds * 10) +
      "\n" + normalizeContext(token.context);
  }

  function pendingTokenValues() {
    return Array.from(pendingTokens.values());
  }

  function resolutionForTokenIndex(tokenIndex) {
    var token = captionTokens.find(function currentToken(candidate) {
      return candidate.tokenIndex === tokenIndex;
    });

    return token ? resolvedTokens.get(tokenCacheKey(token)) : null;
  }

  function resolutionPriority(resolution) {
    if (resolution.source === "media") {
      return resolution.evidence === "transcript-anchor" || resolution.hybridCrossFamily ? 3 : 1;
    }
    return resolution.source === "context" || resolution.source === "deterministic" ? 2 : 0;
  }

  function resolutionEnabled(resolution) {
    return resolution.source === "media" ? options.whisperEnabled : options.rulesEnabled;
  }

  function notifyTimedTextResolution(token, word, source, evidence) {
    var detail;

    if (typeof token.tokenIndex !== "number" || token.tokenIndex < 0 ||
        !word || source === "deterministic") {
      return;
    }

    try {
      detail = JSON.stringify({
        tokenIndex: token.tokenIndex,
        word: word,
        source: source,
        evidence: evidence,
        videoId: mediaAudio.videoId || currentVideoId(),
        trackId: captionTrackId
      });
      root.postMessage({ uncensoredWhisperResolution: detail }, "*");
    } catch (error) {
      return;
    }
  }

  function rememberResolution(token, word, source, evidence, hybridCrossFamily) {
    var key;
    var existing;
    var candidate;

    if (!word || !tokenIsCurrent(token)) {
      return;
    }

    source = source || "unknown";
    evidence = evidence || "none";
    word = rules.formatWordCase(word, token.context);
    key = tokenCacheKey(token);
    existing = resolvedTokens.get(key);
    candidate = { source: source, evidence: evidence, hybridCrossFamily: Boolean(hybridCrossFamily) };

    if (existing) {
      if (resolutionPriority(existing) > resolutionPriority(candidate)) return;
      existing.word = word;
      existing.source = source;
      existing.evidence = evidence;
      existing.hybridCrossFamily = candidate.hybridCrossFamily;
    } else {
      existing = { tokenIndex: token.tokenIndex, word: word, source: source, evidence: evidence,
        hybridCrossFamily: candidate.hybridCrossFamily };
      resolvedTokens.set(key, existing);
    }
    notifyTimedTextResolution(token, word, source, evidence);
    watchCaptionMutations();
    scheduleVisibleCaptionResolution();
    return existing;
  }

  function tokenIsCurrent(token) {
    return token.navigationGeneration === navigationGeneration &&
      token.captionGeneration === captionGeneration;
  }

  // "Rules first" leaves unambiguous rule fills to the rules; "Whisper first" checks
  // every slot and lets audio replace the provisional fill.
  function shouldResolveWithWhisper(token) {
    if (!options.whisperEnabled || failedTokens.has(tokenCacheKey(token))) return false;
    return options.whisperFirst || !options.rulesEnabled || !token.deterministicWord ||
      Boolean(token.deterministicAmbiguous);
  }

  function markWhisperFailed(token) {
    if (tokenIsCurrent(token)) failedTokens.add(tokenCacheKey(token));
  }

  function prefixFrom(token, startTime) {
    return (token.precedingWords || []).filter(function inWindow(word) {
      return word.time >= startTime;
    }).map(function wordText(word) { return word.word; }).join(" ");
  }

  function resolveGroupFromMedia(group) {
    var startTime = tokenWindow(group[0]).startTime;
    var pcm = readMediaWindow(startTime, tokenWindow(group[group.length - 1]).endTime);

    if (!pcm) return Promise.reject(new Error("Incomplete decoded media audio"));
    debugLog("whisper window", {
      tokens: group.map(function tokenIndex(token) { return token.tokenIndex; }),
      time: mediaTimestamp(startTime)
    });
    return whisperTranscribe(pcm, candidatesForToken(), "", {
      slots: group.map(function slot(token) {
        return {
          prefix: prefixFrom(token, startTime),
          nextWord: token.nextWord,
          hybridRuleWord: options.rulesEnabled && (token.deterministicWord || token.contextWord) || "",
          hybridRuleSource: token.contextWord ? "context" : "deterministic"
        };
      })
    }, function canRetryGroup() {
      return group.every(tokenIsCurrent) && options.whisperEnabled && options.audioEnabled;
    }).then(function resolvedDecisions(result) {
      return group.map(function resolution(token, index) {
        var decision = result.decisions[index] || {};

        debugLog("whisper decision", { token: token.tokenIndex, word: decision.word || "", evidence: decision.evidence });
        if (!decision.word) {
          markWhisperFailed(token);
          return null;
        }
        return {
          tokenIndex: token.tokenIndex,
          word: decision.word,
          source: "media",
          evidence: decision.evidence,
          hybridCrossFamily: Boolean(decision.hybridCrossFamily)
        };
      });
    });
  }

  function applyResolvedWord(token, resolution) {
    var word;

    word = resolution && resolution.word;

    if (!word || !tokenIsCurrent(token)) {
      return;
    }

    token.resolved = true;
    rememberResolution(token, word, resolution.source, resolution.evidence,
      resolution.hybridCrossFamily);
  }

  function contextWordForToken(token) {
    var result;

    if (token.deterministicWord) return "";

    result = rules.applyDeterministicRules(token.context);
    return result.replacements && result.replacements.length === 1
      ? result.replacements[0].word
      : "";
  }

  function playheadSeconds() {
    var video = findVideo();
    return video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
  }

  // Slots the viewer has already passed are not scored and their audio is released;
  // they stay pending so seeking back makes them eligible again.
  function tokenPassed(token) {
    return token.timeSeconds < playheadSeconds() - 1;
  }

  // Audio is needed for the 30 s before an unresolved upcoming slot, so it can share
  // a window with earlier slots.
  function tokenNeedsAudio(token, startTime, endTime) {
    var window = tokenWindow(token);
    return shouldResolveWithWhisper(token) && !token.resolved && !tokenPassed(token) &&
      endTime > window.endTime - WINDOW_SECONDS && startTime < window.endTime;
  }

  // Score the next slot the viewer will see first so its word is ready before the
  // caption is drawn. Later slots join its window while the window stays within
  // Whisper's 30 s and their audio is already decoded.
  function nextResolvableMediaGroup() {
    var ordered = pendingTokenValues().filter(function resolvable(token) {
      var window = tokenWindow(token);
      return shouldResolveWithWhisper(token) && !token.resolved && !token.resolving && !tokenPassed(token) &&
        mediaSegmentsForRange(window.startTime, window.endTime).length;
    }).sort(function upcomingFirst(left, right) {
      return left.timeSeconds - right.timeSeconds;
    });
    var startTime = ordered.length ? tokenWindow(ordered[0]).startTime : 0;
    var group = [];

    ordered.some(function addToWindow(token) {
      var endTime = tokenWindow(token).endTime;
      if (group.length && (endTime > startTime + WINDOW_SECONDS || !mediaSegmentsForRange(startTime, endTime).length)) {
        return true;
      }
      group.push(token);
      return false;
    });
    return group.length ? group : null;
  }

  function compactPendingTokens() {
    pendingTokens.forEach(function deleteResolvedToken(token, key) {
      if (token.resolved || failedTokens.has(tokenCacheKey(token))) pendingTokens.delete(key);
    });
    compactMediaSegments();
  }

  function segmentNeeded(segment) {
    var needed = false;

    pendingTokens.forEach(function findCoveredToken(token) {
      if (!needed && tokenNeedsAudio(token, segment.startTime, segment.endTime)) needed = true;
    });

    return needed;
  }

  function compactMediaSegments() {
    mediaAudio.segments.sort(function sortSegments(left, right) {
      return left.startTime - right.startTime;
    });
    mediaAudio.segments = mediaAudio.segments.filter(function keepNeededSegment(segment) {
      return !tokenMetadataKnown || segmentNeeded(segment);
    });
  }

  function scheduleWhisperQueue() {
    if (whisperQueueScheduled) return;

    whisperQueueScheduled = true;
    root.setTimeout(processWhisperQueue, 0);
  }

  function processWhisperQueue() {
    var group;

    whisperQueueScheduled = false;
    if (!options.whisperEnabled || !mediaAudio.segments.length || !pendingTokens.size || whisperBusy) {
      return;
    }

    group = nextResolvableMediaGroup();
    if (!group) {
      compactPendingTokens();
      return;
    }

    group.forEach(function markResolving(token) { token.resolving = true; });
    whisperBusy = true;
    resolveGroupFromMedia(group).then(function applyMediaResolutions(resolutions) {
      group.forEach(function applyResolution(token, index) {
        var resolution = resolutions[index];
        applyResolvedWord(token, resolution);
        if (resolution && tokenIsCurrent(token)) {
          // Positive lead: the word was ready before its caption could be displayed.
          debugLog("whisper resolved", JSON.stringify(resolution.word),
            "lead " + (token.timeSeconds - playheadSeconds()).toFixed(1) + "s");
        }
      });
    }).catch(function logMediaResolutionError(error) {
      debugLog("media window unresolved", {
        tokens: group.map(function tokenIndex(token) { return token.tokenIndex; }),
        error: error && (error.message || String(error))
      });

      if (!error || !error.cancelled) group.forEach(function markFailed(token) {
        if (!token.resolved) markWhisperFailed(token);
      });
    }).finally(function clearMediaResolving() {
      whisperBusy = false;
      group.forEach(function clearResolving(token) {
        token.resolving = false;
        if (pendingTokens.get(tokenCacheKey(token)) === token &&
            (token.resolved || failedTokens.has(tokenCacheKey(token)))) {
          pendingTokens.delete(tokenCacheKey(token));
        }
      });
      compactPendingTokens();
      scheduleWhisperQueue();
    });
  }

  function rememberTimedTextTokens(tokens) {
    var existing = Object.create(null);

    tokenMetadataKnown = true;
    if (!tokens || !tokens.length) {
      compactMediaSegments();
      return;
    }

    pendingTokens.forEach(function markExisting(token) {
      existing[tokenCacheKey(token)] = true;
    });

    resolvedTokens.forEach(function markResolved(resolution, key) {
      if (resolutionEnabled(resolution) && resolution.source === "media") existing[key] = true;
    });

    tokens.forEach(function addPendingToken(token) {
      var key = tokenCacheKey(token);
      var contextWord = contextWordForToken(token);
      var resolved = resolvedTokens.get(key);

      token.navigationGeneration = navigationGeneration;
      token.captionGeneration = captionGeneration;
      token.contextWord = contextWord;

      // A cached rule fill still gets a Whisper check when the mode asks for one.
      if (resolved && resolved.word && resolutionEnabled(resolved) &&
          (resolved.source === "media" || !shouldResolveWithWhisper(token))) {
        if (options.rulesEnabled && (token.deterministicWord || contextWord) &&
            !options.whisperEnabled &&
            resolutionPriority(resolved) < 2) {
          rememberResolution(token, token.deterministicWord || contextWord,
            contextWord ? "context" : "deterministic", "rule");
        }
        scheduleVisibleCaptionResolution();
        return;
      }

      if (options.rulesEnabled && token.deterministicWord && !token.deterministicAmbiguous) {
        rememberResolution(token, token.deterministicWord, "deterministic");
      }

      if (options.rulesEnabled && contextWord) {
        rememberResolution(token, contextWord, "context");
        scheduleVisibleCaptionResolution();
      }

      if (!shouldResolveWithWhisper(token)) {
        pendingTokens.delete(key);
      } else if (!existing[key]) {
        existing[key] = true;
        pendingTokens.set(key, Object.assign({}, token, {
          navigationGeneration: navigationGeneration,
          resolved: false,
          resolving: false
        }));
      }
    });

    if (options.whisperEnabled && pendingTokens.size) {
      preloadWhisper();
      if (mediaAudio.segments.length) scheduleWhisperQueue();
    }
    if (pendingTokens.size) watchCaptionMutations();
  }

  function rememberTimedTextData(data, trackId, videoId) {
    var trackChanged;

    if (!syncVideo(videoId)) return;
    data = data || { tokens: [], timeline: [] };
    trackId = trackId || "";
    trackChanged = captionTrackId !== trackId;

    if (trackChanged) {
      captionTrackId = trackId;
      captionGeneration += 1;
      pendingTokens.clear();
      resolvedTokens.clear();
      failedTokens.clear();
      lastPatchedCaptionText = "";
    }
    if (trackChanged || data.timeline && data.timeline.length) {
      captionTimeline = data.timeline || [];
    }
    captionTokens = (data.tokens || []).map(function copyCaptionToken(token) {
      return Object.assign({}, token);
    });
    rememberTimedTextTokens(captionTokens);
    if (pendingTokens.size || resolvedTokens.size) {
      watchVideoSeeks();
      scheduleVisibleCaptionResolution();
    } else {
      stopCaptionWatching();
    }
  }

  function captionSegments() {
    var segments = Array.prototype.slice.call(root.document.querySelectorAll(".ytp-caption-segment"));
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

  function nearbyTimelineWords(playhead) {
    var nearestIndex = -1;
    var nearestDistance = Infinity;

    captionTimeline.forEach(function findNearestEvent(event, index) {
      var distance = playhead < event.startTime
        ? event.startTime - playhead
        : playhead > event.endTime ? playhead - event.endTime : 0;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    if (nearestIndex < 0) return [];

    return captionTimeline.slice(
      Math.max(0, nearestIndex - TIMELINE_EVENT_RADIUS),
      nearestIndex + TIMELINE_EVENT_RADIUS + 1
    ).filter(function nearPlayhead(event) {
      return event.endTime >= playhead - TIMELINE_TIME_RADIUS_SECONDS &&
        event.startTime <= playhead + TIMELINE_TIME_RADIUS_SECONDS;
    }).reduce(function flattenEvents(words, event) {
      var eventTokenIndex = 0;
      normalizeContext(event.text).split(/\s+/).filter(Boolean).forEach(function appendWord(word) {
        words.push({
          word: word,
          tokenIndex: word === rules.CENSORED_TOKEN ? event.firstTokenIndex + eventTokenIndex++ : -1
        });
      });
      return words;
    }, []);
  }

  function visibleTokenMapping(text) {
    var video = findVideo();
    var visibleWords = normalizeContext(text).split(/\s+/).filter(Boolean);
    var timelineWords = nearbyTimelineWords(video && Number.isFinite(video.currentTime) ? video.currentTime : 0);
    var matches = new Map();
    var start;

    if (!visibleWords.length || !visibleWords.includes(rules.CENSORED_TOKEN)) return null;
    for (start = 0; start + visibleWords.length <= timelineWords.length; start += 1) {
      var mapping = [];
      var anchors = 0;
      var visibleSlot = 0;
      var valid = visibleWords.every(function wordMatches(visibleWord, offset) {
        var timelineWord = timelineWords[start + offset];
        var resolution;

        if (timelineWord.word !== rules.CENSORED_TOKEN) {
          if (timelineWord.word === visibleWord) anchors += 1;
          return timelineWord.word === visibleWord;
        }
        if (visibleWord === rules.CENSORED_TOKEN) {
          mapping[visibleSlot++] = timelineWord.tokenIndex;
          return true;
        }
        resolution = resolutionForTokenIndex(timelineWord.tokenIndex);
        return Boolean(resolution && normalizeContext(resolution.word) === visibleWord);
      });

      if (valid && anchors && mapping.length) {
        matches.set(mapping.join(","), mapping);
      }
    }
    return matches.size === 1 ? matches.values().next().value : null;
  }

  function applyResolvedVisibleTimeline() {
    var segments = captionSegments();
    var snapshot = captionSnapshot(segments);
    var mapping = visibleTokenMapping(snapshot.text);
    var replacements = [];
    var match;
    var ordinal = 0;

    if (!mapping) return false;
    CENSORED_TOKEN_GLOBAL_REGEX.lastIndex = 0;
    while ((match = CENSORED_TOKEN_GLOBAL_REGEX.exec(snapshot.text)) !== null) {
      var resolution = resolutionForTokenIndex(mapping[ordinal++]);
      var entry = snapshot.entries.find(function findEntry(candidate) {
        return match.index >= candidate.start && match.index < candidate.start + candidate.text.length;
      });
      if (entry && resolution && resolutionEnabled(resolution)) {
        replacements.push({ entry: entry, index: match.index, text: match[0], word: resolution.word });
      }
    }
    replacements.reverse().forEach(function replaceVisibleSlot(replacement) {
      replaceTokenInSegment(replacement.entry, replacement.index, replacement.text, replacement.word);
    });
    if (replacements.length) lastPatchedCaptionText = captionSnapshot(segments).text;
    return replacements.length > 0;
  }

  function scheduleVisibleCaptionResolution() {
    var generation = seekGeneration;

    if (visibleResolutionScheduled) {
      return;
    }

    visibleResolutionScheduled = true;
    function resolveVisibleSoon() {
      visibleResolutionScheduled = false;
      if (generation !== seekGeneration) {
        scheduleVisibleCaptionResolution();
        return;
      }
      applyResolvedVisibleTimeline();
    }

    root.requestAnimationFrame(resolveVisibleSoon);
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
    var target = root.document.querySelector("#movie_player, .html5-video-player");

    watchVideoSeeks();
    if (!target || captionObserver && captionObserverTarget === target) {
      return;
    }
    if (captionObserver) captionObserver.disconnect();

    captionObserver = new root.MutationObserver(function captionsChanged(mutations) {
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
    captionObserverTarget = target;
  }

  function stopCaptionWatching() {
    if (captionObserver) captionObserver.disconnect();
    captionObserver = null;
    captionObserverTarget = null;
    if (observedVideo) {
      observedVideo.removeEventListener("seeking", captionSeekStarted);
      observedVideo.removeEventListener("seeked", captionSeekFinished);
    }
    observedVideo = null;
  }

  function watchVideoSeeks() {
    var video = findVideo();

    if (!video || video === observedVideo) return;
    if (observedVideo) {
      observedVideo.removeEventListener("seeking", captionSeekStarted);
      observedVideo.removeEventListener("seeked", captionSeekFinished);
    }
    observedVideo = video;
    observedVideo.addEventListener("seeking", captionSeekStarted);
    observedVideo.addEventListener("seeked", captionSeekFinished);
  }

  function captionSeekStarted() {
    seekGeneration += 1;
    lastPatchedCaptionText = "";
    scheduleVisibleCaptionResolution();
    scheduleWhisperQueue();
  }

  function captionSeekFinished() {
    scheduleVisibleCaptionResolution();
    scheduleWhisperQueue();
  }

  var exports = Object.freeze({
    setSabrAudioData: setSabrAudioData,
    setOptions: function setOptions(nextOptions) {
      var previousRulesEnabled = options.rulesEnabled;
      var previousWhisperEnabled = options.whisperEnabled;
      var previousWhisperFirst = options.whisperFirst;

      nextOptions = nextOptions || {};
      if (!syncVideo(nextOptions.videoId)) return;
      options.rulesEnabled = nextOptions.rulesEnabled !== false;
      options.whisperEnabled = nextOptions.whisperEnabled !== false;
      options.whisperFirst = nextOptions.whisperFirst === true;
      options.audioEnabled = nextOptions.audioEnabled !== false;
      if (previousRulesEnabled !== options.rulesEnabled || previousWhisperEnabled !== options.whisperEnabled ||
          previousWhisperFirst !== options.whisperFirst) {
        captionGeneration += 1;
        pendingTokens.clear();
        failedTokens.clear();
        resolvedTokens.forEach(function deleteDisabledResolution(resolution, key) {
          if (!resolutionEnabled(resolution)) resolvedTokens.delete(key);
        });
        rememberTimedTextTokens(captionTokens);
      }
      if (options.whisperEnabled && options.audioEnabled && pendingTokens.size) {
        preloadWhisper();
        scheduleWhisperQueue();
      } else {
        mediaAudio.segments = [];
        closeAudioContext();
      }
      if (resolvedTokens.size || options.whisperEnabled && pendingTokens.size) {
        watchCaptionMutations();
      } else {
        stopCaptionWatching();
      }
    },
    rememberTimedTextData: rememberTimedTextData,
    pendingTokenValues: pendingTokenValues,
    mediaAudio: mediaAudio
  });

  root.UncensoredAudioInference = exports;
  root.addEventListener("yt-navigate-finish", function navigationFinished() {
    syncVideo(currentVideoId());
    if (pendingTokens.size || resolvedTokens.size) {
      watchCaptionMutations();
      scheduleVisibleCaptionResolution();
      scheduleWhisperQueue();
    }
  });
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
