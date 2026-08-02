(function installUncensoredPageHook() {
  "use strict";

  var PATCH_CACHE_LIMIT = 16;
  var SAVED_RESOLUTION_KEY = "uncensoredSavedResolutions";
  var SAVED_RESOLUTION_LIMIT = 1000;
  var originalFetch = globalThis.__uncensoredOriginalFetch || globalThis.fetch;
  var originalXHROpen = globalThis.__uncensoredOriginalXHROpen || XMLHttpRequest.prototype.open;
  var settings = {
    rulesEnabled: false,
    whisperEnabled: true,
    audioNeeded: null,
    captureAudio: null
  };
  var audioReplacements = new Map();
  var audioReplacementVersion = 0;
  var patchedTimedTextCache = new Map();
  var nextAudioStreamId = 1;
  var nextAudioMessageId = 1;
  var pendingAudioMessages = new Map();
  var audioDecisionWaiters = [];
  var currentCaptionTrackId = "";
  var activeVideoId = currentVideoId();
  var navigationPending = false;
  var navigationWaiters = [];

  globalThis.__uncensoredOriginalFetch = originalFetch;
  globalThis.__uncensoredOriginalXHROpen = originalXHROpen;
  function timedTextApi() {
    return globalThis.UncensoredTimedText;
  }

  function allowedResolutionWord(word) {
    var rules = globalThis.UncensoredRules;
    var normalized;
    var collapsed;

    if (!rules || !Array.isArray(rules.ALLOWED_WORDS) || typeof word !== "string" || !word) {
      return false;
    }

    normalized = word.toLowerCase();
    if (rules.ALLOWED_WORDS.indexOf(normalized) !== -1) return true;
    if (!/^[a-z0-9']+$/.test(normalized) || !/([a-z0-9'])\1{2,}/.test(normalized)) return false;

    collapsed = normalized.replace(/([a-z0-9'])\1+/g, "$1");
    return rules.ALLOWED_WORDS.some(function allowedStretchedWord(candidate) {
      return candidate.replace(/([a-z0-9'])\1+/g, "$1") === collapsed;
    });
  }

  function extractPathVideoId(pathname) {
    var match = pathname.match(/\/(live|shorts)\/([^/]+)/);
    return match ? match[2] : "";
  }

  function currentVideoId() {
    try {
      var url = new URL(location.href);
      return url.searchParams.get("v") || extractPathVideoId(url.pathname) || "";
    } catch (error) {
      return "";
    }
  }

  function requestUrl(input) {
    if (typeof input === "string") {
      return input;
    }

    if (input && typeof input.url === "string") {
      return input.url;
    }

    return "";
  }

  function safeJson(value) {
    try {
      return typeof value === "string" ? JSON.parse(value) : value;
    } catch (error) {
      return null;
    }
  }

  function clearPatchedTimedTextCache() {
    patchedTimedTextCache.clear();
  }

  function stringHash(value) {
    var hash = 2166136261;
    var index;

    for (index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(36);
  }

  function patchedTimedTextCacheKey(body) {
    return [
      currentVideoId(),
      settings.rulesEnabled ? "1" : "0",
      audioReplacementVersion,
      body.length,
      stringHash(body)
    ].join(":");
  }

  function rememberPatchedTimedText(key, body, patchedBody) {
    if (patchedTimedTextCache.has(key)) {
      patchedTimedTextCache.delete(key);
    }

    patchedTimedTextCache.set(key, {
      body: body,
      patchedBody: patchedBody
    });

    while (patchedTimedTextCache.size > PATCH_CACHE_LIMIT) {
      patchedTimedTextCache.delete(patchedTimedTextCache.keys().next().value);
    }
  }

  function audioReplacementKey(videoId, trackId, tokenIndex) {
    return videoId + ":" + trackId + ":" + tokenIndex;
  }

  function readSavedResolutions(trackId) {
    var saved;

    try {
      saved = JSON.parse(globalThis.sessionStorage.getItem(SAVED_RESOLUTION_KEY) || "null");
      if (!saved || saved.videoId !== currentVideoId()) {
        if (saved) globalThis.sessionStorage.removeItem(SAVED_RESOLUTION_KEY);
        return [];
      }
      return saved.trackId === trackId && Array.isArray(saved.replacements)
        ? saved.replacements.slice(0, SAVED_RESOLUTION_LIMIT)
        : [];
    } catch (error) {
      return [];
    }
  }

  function saveCurrentResolutions() {
    var videoId = currentVideoId();
    var replacements = [];

    if (!videoId || !currentCaptionTrackId) return;
    audioReplacements.forEach(function saveReplacement(replacement) {
      if (replacements.length < SAVED_RESOLUTION_LIMIT && replacement.videoId === videoId &&
          replacement.trackId === currentCaptionTrackId) {
        replacements.push(replacement);
      }
    });
    try {
      globalThis.sessionStorage.setItem(SAVED_RESOLUTION_KEY, JSON.stringify({
        videoId: videoId,
        trackId: currentCaptionTrackId,
        replacements: replacements
      }));
    } catch (error) {}
  }

  function discardSavedResolutionsForOtherVideo() {
    var saved;

    try {
      saved = JSON.parse(globalThis.sessionStorage.getItem(SAVED_RESOLUTION_KEY) || "null");
      if (saved && saved.videoId !== currentVideoId()) {
        globalThis.sessionStorage.removeItem(SAVED_RESOLUTION_KEY);
      }
    } catch (error) {}
  }

  function syncVideo(videoId) {
    if (videoId === activeVideoId) return;
    activeVideoId = videoId;
    settings.audioNeeded = null;
    settings.captureAudio = null;
    audioDecisionWaiters.splice(0).forEach(function cancelAudioDecision(resolve) {
      resolve(false);
    });
    pendingAudioMessages.forEach(function cancelPendingAudio(resolve, messageId) {
      pendingAudioMessages.delete(messageId);
      resolve();
    });
    clearPatchedTimedTextCache();
    audioReplacements.clear();
    currentCaptionTrackId = "";
    audioReplacementVersion += 1;
  }

  globalThis.addEventListener("uncensored-settings", function updateSettings(event) {
    var detail = safeJson(event && event.detail);
    if (detail) {
      syncVideo(detail.videoId || currentVideoId());
      settings.rulesEnabled = detail.rulesEnabled !== false;
      settings.whisperEnabled = detail.whisperEnabled !== false;
      settings.audioNeeded = detail.audioNeeded;
      settings.captureAudio = detail.captureAudio;
      if (settings.captureAudio !== null) {
        audioDecisionWaiters.splice(0).forEach(function resolveAudioDecision(resolve) {
          resolve(shouldCaptureAudio());
        });
      }
      clearPatchedTimedTextCache();
    }
  });

  function applyResolution(tokenIndex, word, source, videoId, trackId, timeSeconds, normalizedContext) {
    var id = videoId || currentVideoId();

    if (typeof tokenIndex !== "number" || !word || trackId !== currentCaptionTrackId) {
      if (trackId !== currentCaptionTrackId) {
        debugLog("subtitle resolution ignored", {
          tokenIndex: tokenIndex,
          resolutionTrackId: trackId,
          currentCaptionTrackId: currentCaptionTrackId
        });
      }
      return;
    }

    audioReplacements.set(audioReplacementKey(id, trackId, tokenIndex), {
      videoId: id,
      trackId: trackId,
      tokenIndex: tokenIndex,
      word: word,
      source: source || "unknown",
      timeSeconds: timeSeconds,
      normalizedContext: normalizedContext || ""
    });
    audioReplacementVersion += 1;
    clearPatchedTimedTextCache();
    saveCurrentResolutions();
  }

  function rememberResolution(detail) {
    var videoId;

    detail = safeJson(detail);
    if (!detail || !Number.isInteger(detail.tokenIndex) || detail.tokenIndex < 0 ||
        !allowedResolutionWord(detail.word)) {
      return;
    }

    videoId = detail.videoId || currentVideoId();
    if (videoId !== currentVideoId()) {
      return;
    }
    applyResolution(detail.tokenIndex, detail.word, detail.source, videoId, detail.trackId || "",
      detail.timeSeconds, detail.normalizedContext);
  }

  function isTimedTextUrl(input) {
    var url = requestUrl(input);

    try {
      url = new URL(url, location.href);
    } catch (error) {
      return false;
    }

    return url.href.indexOf("/api/timedtext") !== -1 && url.searchParams.get("fmt") === "json3";
  }

  function captionTrackId(input) {
    var url;

    try {
      url = new URL(requestUrl(input), location.href);
      return ["lang", "kind", "name", "tlang", "vssId"].map(function trackPart(name) {
        return name + "=" + (url.searchParams.get(name) || "");
      }).join("&");
    } catch (error) {
      return "";
    }
  }

  function timedTextVideoId(input) {
    try {
      return new URL(requestUrl(input), location.href).searchParams.get("v") || currentVideoId();
    } catch (error) {
      return currentVideoId();
    }
  }

  function notifyTimedText(body, input, videoId) {
    var trackId = captionTrackId(input);
    var savedResolutions;

    syncVideo(videoId);
    if (trackId !== currentCaptionTrackId) {
      currentCaptionTrackId = trackId;
      audioReplacements.clear();
      audioReplacementVersion += 1;
      clearPatchedTimedTextCache();
    }
    savedResolutions = readSavedResolutions(trackId);
    globalThis.setTimeout(function dispatchTimedText() {
      try {
        globalThis.dispatchEvent(new CustomEvent("uncensored-timedtext", {
          detail: JSON.stringify({
            body: body,
            trackId: trackId,
            savedResolutions: savedResolutions,
            videoId: videoId
          })
        }));
      } catch (error) {}
    }, 0);
  }

  function notifyMissingCaptions(attempt) {
    var player = document.querySelector("#movie_player");
    var response;
    try {
      response = player && player.getPlayerResponse && player.getPlayerResponse();
    } catch (error) {}
    var videoId = response && response.videoDetails && response.videoDetails.videoId;
    var tracks = response && response.captions &&
      response.captions.playerCaptionsTracklistRenderer &&
      response.captions.playerCaptionsTracklistRenderer.captionTracks;

    if ((!videoId || videoId !== currentVideoId() || !response || !response.captions) &&
        attempt < 8) {
      globalThis.setTimeout(function retryCaptionCheck() {
        notifyMissingCaptions(attempt + 1);
      }, 250);
      return;
    }
    if (!videoId || videoId !== currentVideoId()) return;
    if (response && response.captions) return;
    debugLog("no captions fallback", {
      videoId: videoId,
      tracks: Array.isArray(tracks) ? tracks.length : null
    });
    globalThis.dispatchEvent(new CustomEvent("uncensored-no-captions", {
      detail: JSON.stringify({ videoId: videoId })
    }));
  }

  function postAudioMessage(message, transfer) {
    var messageId = nextAudioMessageId;

    nextAudioMessageId += 1;
    message.messageId = messageId;
    message.uncensoredSabrAudio = true;
    return new Promise(function waitForAudioRelay(resolve) {
      var timeout = globalThis.setTimeout(function audioRelayTimedOut() {
        pendingAudioMessages.delete(messageId);
        resolve();
      }, 120000);

      pendingAudioMessages.set(messageId, function audioRelayed() {
        globalThis.clearTimeout(timeout);
        resolve();
      });
      try {
        globalThis.postMessage(message, "*", transfer || []);
      } catch (error) {
        globalThis.clearTimeout(timeout);
        pendingAudioMessages.delete(messageId);
        debugLog("audio transfer failed", error && (error.message || String(error)));
        resolve();
      }
    });
  }

  globalThis.addEventListener("message", function audioMessageAcknowledged(event) {
    var message = event && event.data;
    var resolve;

    if (event.source !== globalThis || !message) {
      return;
    }

    if (message.uncensoredWhisperResolution) {
      rememberResolution(message.uncensoredWhisperResolution);
      return;
    }
    if (message.uncensoredSabrAck !== true) return;

    resolve = pendingAudioMessages.get(message.messageId);
    if (resolve) {
      pendingAudioMessages.delete(message.messageId);
      resolve();
    }
  });

  function debugEnabled() {
    try {
      return globalThis.localStorage && globalThis.localStorage.getItem("uncensoredDebug") === "1";
    } catch (error) {
      return false;
    }
  }

  function debugLog() {
    if (!debugEnabled() || !globalThis.console || !globalThis.console.debug) {
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
    globalThis.console.debug("[uncensored] " + message);
  }

  function isGoogleVideoPlaybackUrl(input) {
    var url;
    var mime;

    try {
      url = new URL(requestUrl(input), location.href);
    } catch (error) {
      return false;
    }

    if (!/(^|\.)googlevideo\.com$/.test(url.hostname) || url.pathname.indexOf("/videoplayback") === -1) {
      return false;
    }

    mime = url.searchParams.get("mime") || "";
    return url.searchParams.get("sabr") === "1" || !mime || mime.indexOf("video/") !== 0;
  }

  function shouldCaptureAudio(videoId) {
    return settings.whisperEnabled && settings.captureAudio === true &&
      (!videoId || videoId === currentVideoId());
  }

  function shouldObserveAudio() {
    return settings.whisperEnabled && (navigationPending ||
      settings.captureAudio !== false && currentVideoId());
  }

  function waitForAudioDecision(videoId) {
    if (settings.captureAudio !== null) return Promise.resolve(shouldCaptureAudio(videoId));
    return new Promise(function wait(resolve) {
      var timer;
      function finish(needed) {
        var index = audioDecisionWaiters.indexOf(finish);
        if (index !== -1) audioDecisionWaiters.splice(index, 1);
        globalThis.clearTimeout(timer);
        resolve(needed);
      }
      timer = globalThis.setTimeout(function decisionTimedOut() {
        finish(false);
      }, 15000);
      audioDecisionWaiters.push(finish);
    });
  }

  function waitForNavigationFinish() {
    if (!navigationPending) return Promise.resolve();
    return new Promise(function wait(resolve) {
      navigationWaiters.push(resolve);
    });
  }

  function releaseNavigationWaiters() {
    navigationWaiters.splice(0).forEach(function release(resolve) {
      resolve();
    });
  }

  function relaySabrBuffer(streamId, videoId, bufferPromise) {
    bufferPromise.then(function relayBuffer(buffer) {
      return postAudioMessage({ type: "chunk", streamId: streamId, videoId: videoId, buffer: buffer }, [buffer]);
    }).then(function finishBuffer() {
      postAudioMessage({ type: "end", streamId: streamId, videoId: videoId });
    }, function finishFailedBuffer() {
      postAudioMessage({ type: "end", streamId: streamId, videoId: videoId });
    });
  }

  function processSabrResponse(response, responseVideoId, duringNavigation) {
    var streamId = nextAudioStreamId;
    nextAudioStreamId += 1;
    var cloned = response.clone();

    waitForNavigationFinish().then(function navigationCommitted() {
      return waitForAudioDecision();
    }).then(function startWhenNeeded(needed) {
      var videoId = duringNavigation ? currentVideoId() : responseVideoId;
      if (!needed || !videoId || videoId !== currentVideoId()) {
        debugLog("audio stream skipped", {
          needed: needed,
          responseVideoId: responseVideoId,
          videoId: currentVideoId(),
          duringNavigation: duringNavigation
        });
        if (cloned.body) cloned.body.cancel().catch(function ignoreCancelError() {});
        return;
      }
      processClonedSabrResponse(cloned, streamId, videoId);
    });
  }

  function processClonedSabrResponse(cloned, streamId, videoId) {
    if (!cloned.body || typeof cloned.body.getReader !== "function") {
      postAudioMessage({ type: "start", streamId: streamId, videoId: videoId }).then(function startFullBuffer() {
        relaySabrBuffer(streamId, videoId, cloned.arrayBuffer());
      });
      return;
    }

    var reader = cloned.body.getReader();

    function pump() {
      return reader.read().then(function pumpResult(result) {
        var chunk;

        if (result.done || !shouldCaptureAudio(videoId)) {
          if (!result.done) {
            reader.cancel().catch(function ignoreCancelError() {});
          }
          return postAudioMessage({ type: "end", streamId: streamId, videoId: videoId });
        }

        chunk = result.value.byteOffset === 0 && result.value.byteLength === result.value.buffer.byteLength
          ? result.value.buffer
          : result.value.buffer.slice(result.value.byteOffset, result.value.byteOffset + result.value.byteLength);
        return postAudioMessage({ type: "chunk", streamId: streamId, videoId: videoId, buffer: chunk }, [chunk]).then(pump);
      }, function pumpError() {
        postAudioMessage({ type: "end", streamId: streamId, videoId: videoId });
      });
    }

    postAudioMessage({ type: "start", streamId: streamId, videoId: videoId }).then(pump);
  }

  function replacementsForCurrentVideo() {
    var videoId = currentVideoId();
    var keyPrefix = videoId + ":" + currentCaptionTrackId + ":";
    var replacements = [];

    audioReplacements.forEach(function collectReplacement(replacement, key) {
      if (key.indexOf(keyPrefix) === 0 && (settings.rulesEnabled || replacement.source === "media")) {
        replacements.push(replacement);
      }
    });
    return replacements;
  }

  function patchTimedTextBody(body) {
    var api = timedTextApi();
    var cacheKey;
    var cached;
    var patchedBody;

    if (!api || typeof body !== "string") {
      return body;
    }

    cacheKey = patchedTimedTextCacheKey(body);
    cached = patchedTimedTextCache.get(cacheKey);
    if (cached && cached.body === body) {
      patchedTimedTextCache.delete(cacheKey);
      patchedTimedTextCache.set(cacheKey, cached);
      return cached.patchedBody;
    }

    if (api.patchTimedTextBodyWithOverrides) {
      patchedBody = api.patchTimedTextBodyWithOverrides(
        body,
        replacementsForCurrentVideo(),
        settings.rulesEnabled,
        !settings.whisperEnabled
      );
    } else {
      patchedBody = settings.rulesEnabled && api.patchTimedTextBody ? api.patchTimedTextBody(body) : body;
    }

    rememberPatchedTimedText(cacheKey, body, patchedBody);
    return patchedBody;
  }

  function debugAudio() {
    var video = document.querySelector("video");
    var report = {
      hasTimedTextApi: Boolean(timedTextApi()),
      currentSrc: video && video.currentSrc || "",
      videoId: currentVideoId(),
      activeVideoId: activeVideoId,
      captionTrackId: currentCaptionTrackId,
      replacementCount: audioReplacements.size,
      audioNeeded: settings.audioNeeded,
      captureAudio: settings.captureAudio,
      navigationPending: navigationPending,
      pendingAudioMessages: pendingAudioMessages.size,
      fetchHook: globalThis.fetch === uncensoredFetch,
      xhrHook: XMLHttpRequest.prototype.open === uncensoredOpen
    };

    if (console && console.log) {
      console.log("[uncensored] audio debug " + JSON.stringify(report));
    }

    return report;
  }

  globalThis.__uncensoredDebugAudio = debugAudio;
  function uncensoredFetch(input, init) {
    var requestVideoId = currentVideoId();
    var requestDuringNavigation = navigationPending;
    var videoId = isTimedTextUrl(input) ? timedTextVideoId(input) : requestVideoId;

    return originalFetch.apply(this, arguments).then(function maybePatch(response) {
      if (shouldObserveAudio() &&
          (isGoogleVideoPlaybackUrl(response && response.url) || isGoogleVideoPlaybackUrl(input))) {
        processSabrResponse(response, requestVideoId, requestDuringNavigation);
      }

      if (isTimedTextUrl(input)) {
        if (videoId !== currentVideoId()) return response;
        if (!settings.rulesEnabled) {
          response.clone().text().then(function observeTimedText(body) {
            notifyTimedText(body, input, videoId);
          }, function ignoreTimedTextError() {});
          return response;
        }
        return response.clone().text().then(function rewriteTimedText(body) {
          var patchedBody;
          try {
            notifyTimedText(body, input, videoId);
            patchedBody = patchTimedTextBody(body);
          } catch (patchError) {
            debugLog("patchTimedTextBody failed", patchError && (patchError.message || String(patchError)));
            if (console && console.warn) {
              console.warn("[uncensored] patchTimedTextBody failed " + (patchError && (patchError.message || String(patchError))));
            }
            return response;
          }

          if (patchedBody === body) {
            return response;
          }

          return new Response(patchedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        }, function keepOriginal() {
          return response;
        });
      }

      return response;
    });
  }

  function uncensoredOpen(method, url) {
    var result;

    this.__uncensoredTimedTextUrl = isTimedTextUrl(url);
    this.__uncensoredTimedTextRequestUrl = url;
    this.__uncensoredVideoId = this.__uncensoredTimedTextUrl ? timedTextVideoId(url) : currentVideoId();
    result = originalXHROpen.apply(this, arguments);

    if (this.__uncensoredTimedTextUrl) {
      this.addEventListener("readystatechange", function onReadyStateChange() {
        var patchedBody;

        if (this.readyState !== 4 || (this.responseType !== "" && this.responseType !== "text") ||
            typeof this.responseText !== "string") {
          return;
        }
        if (this.__uncensoredVideoId !== currentVideoId()) return;

        try {
          notifyTimedText(this.responseText, this.__uncensoredTimedTextRequestUrl, this.__uncensoredVideoId);
          patchedBody = patchTimedTextBody(this.responseText);
        } catch (patchError) {
          debugLog("patchTimedTextBody XHR failed", patchError && (patchError.message || String(patchError)));
          if (console && console.warn) {
            console.warn("[uncensored] patchTimedTextBody XHR failed " + (patchError && (patchError.message || String(patchError))));
          }
          return;
        }

        if (patchedBody === this.responseText) {
          return;
        }

        try {
          Object.defineProperty(this, "responseText", {
            configurable: true,
            value: patchedBody
          });
          if (this.responseType === "" || this.responseType === "text") {
            Object.defineProperty(this, "response", {
              configurable: true,
              value: patchedBody
            });
          }
        } catch (error) {}
      });
    }

    return result;
  }

  function installNetworkHooks() {
    if (globalThis.fetch !== uncensoredFetch) {
      globalThis.fetch = uncensoredFetch;
    }

    if (XMLHttpRequest.prototype.open !== uncensoredOpen) {
      XMLHttpRequest.prototype.open = uncensoredOpen;
    }
  }

  installNetworkHooks();
  globalThis.setTimeout(function checkInitialCaptions() {
    notifyMissingCaptions(0);
  }, 0);

  globalThis.addEventListener("yt-navigate-start", function navigationStarted() {
    installNetworkHooks();
    releaseNavigationWaiters();
    navigationPending = true;
  });

  globalThis.addEventListener("yt-navigate-finish", function navigationFinished() {
    installNetworkHooks();
    navigationPending = false;
    releaseNavigationWaiters();
    syncVideo(currentVideoId());
    discardSavedResolutionsForOtherVideo();
    notifyMissingCaptions(0);
  });
})();
