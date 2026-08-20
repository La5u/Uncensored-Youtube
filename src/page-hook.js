(function installUncensoredPageHook() {
  "use strict";

  var originalFetch = globalThis.fetch;
  var originalXHROpen = XMLHttpRequest.prototype.open;
  var settings = {
    rulesEnabled: false,
    whisperEnabled: true,
    audioEnabled: null
  };
  var audioReplacements = new Map();
  var nextAudioStreamId = 1;
  var nextAudioMessageId = 1;
  var pendingAudioMessages = new Map();
  var audioDecisionWaiters = [];
  var currentCaptionTrackId = "";
  var activeVideoId = currentVideoId();
  var navigationPending = false;
  var navigationWaiters = [];

  function currentVideoId() {
    try {
      var url = new URL(location.href);
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

  function safeJson(value) {
    try {
      return typeof value === "string" ? JSON.parse(value) : value;
    } catch (error) {
      return null;
    }
  }

  function syncVideo(videoId) {
    if (videoId === activeVideoId) return;
    activeVideoId = videoId;
    settings.audioEnabled = null;
    audioDecisionWaiters.splice(0).forEach(function cancelAudioDecision(resolve) {
      resolve(false);
    });
    pendingAudioMessages.forEach(function cancelPendingAudio(resolve, messageId) {
      pendingAudioMessages.delete(messageId);
      resolve();
    });
    audioReplacements.clear();
    currentCaptionTrackId = "";
  }

  globalThis.addEventListener("uncensored-settings", function updateSettings(event) {
    var detail = safeJson(event && event.detail);
    if (detail) {
      syncVideo(detail.videoId || currentVideoId());
      settings.rulesEnabled = detail.rulesEnabled !== false;
      settings.whisperEnabled = detail.whisperEnabled !== false;
      settings.audioEnabled = detail.audioEnabled;
      if (settings.audioEnabled !== null) {
        audioDecisionWaiters.splice(0).forEach(function resolveAudioDecision(resolve) {
          resolve(shouldCaptureAudio());
        });
      }
    }
  });

  function rememberResolution(detail) {
    detail = safeJson(detail);
    if (!detail || !Number.isInteger(detail.tokenIndex) || detail.tokenIndex < 0) return;

    var allowed = globalThis.UncensoredRules && globalThis.UncensoredRules.ALLOWED_WORDS;
    if (!Array.isArray(allowed) || typeof detail.word !== "string" ||
        allowed.indexOf(detail.word.toLowerCase()) === -1) return;

    var videoId = detail.videoId || currentVideoId();
    var trackId = detail.trackId || "";
    if (videoId !== currentVideoId() || trackId !== currentCaptionTrackId) return;

    audioReplacements.set(videoId + ":" + trackId + ":" + detail.tokenIndex, {
      videoId: videoId,
      trackId: trackId,
      tokenIndex: detail.tokenIndex,
      word: detail.word,
      source: detail.source || "unknown",
      evidence: detail.evidence || "none"
    });
  }

  function isTimedTextUrl(input) {
    var url = new URL(input, location.href);
    return url.href.indexOf("/api/timedtext") !== -1 && url.searchParams.get("fmt") === "json3";
  }

  function captionTrackId(input) {
    var url = new URL(input, location.href);
    return ["lang", "kind", "name", "tlang", "vssId"].map(function trackPart(name) {
      return name + "=" + (url.searchParams.get(name) || "");
    }).join("&");
  }

  function timedTextVideoId(input) {
    return new URL(input, location.href).searchParams.get("v") || currentVideoId();
  }

  function notifyTimedText(body, input, videoId) {
    var trackId = captionTrackId(input);

    syncVideo(videoId);
    if (trackId !== currentCaptionTrackId) {
      currentCaptionTrackId = trackId;
      audioReplacements.clear();
    }
    globalThis.setTimeout(function dispatchTimedText() {
      try {
        globalThis.dispatchEvent(new CustomEvent("uncensored-timedtext", {
          detail: JSON.stringify({
            body: body,
            trackId: trackId,
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
    if ((!videoId || videoId !== currentVideoId() || !response.captions) &&
        attempt < 8) {
      globalThis.setTimeout(function retryCaptionCheck() {
        notifyMissingCaptions(attempt + 1);
      }, 250);
      return;
    }
    if (!videoId || videoId !== currentVideoId()) return;
    if (response.captions) return;
    debugLog("no captions fallback", { videoId: videoId });
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
    var url = new URL(input, location.href);
    var mime;

    if (!/(^|\.)googlevideo\.com$/.test(url.hostname) || url.pathname.indexOf("/videoplayback") === -1) {
      return false;
    }

    mime = url.searchParams.get("mime") || "";
    return url.searchParams.get("sabr") === "1" || !mime || mime.indexOf("video/") !== 0;
  }

  function shouldCaptureAudio(videoId) {
    return settings.whisperEnabled && settings.audioEnabled === true &&
      (!videoId || videoId === currentVideoId());
  }

  function waitForAudioDecision() {
    if (settings.audioEnabled !== null) return Promise.resolve(shouldCaptureAudio());
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
        cloned.body.cancel().catch(function ignoreCancelError() {});
        return;
      }
      processClonedSabrResponse(cloned, streamId, videoId);
    });
  }

  // Chromium + Firefox: SABR audio arrives through readable Fetch response streams.
  function processClonedSabrResponse(cloned, streamId, videoId) {
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
      if (key.indexOf(keyPrefix) === 0 && (replacement.source === "media"
        ? settings.whisperEnabled : settings.rulesEnabled)) {
        replacements.push(replacement);
      }
    });
    return replacements;
  }

  // Chromium + Firefox: observe Fetch only for multiplexed SABR media.
  function uncensoredFetch() {
    var requestVideoId = currentVideoId();
    var requestDuringNavigation = navigationPending;

    return originalFetch.apply(this, arguments).then(function observeAudio(response) {
      try {
        if (settings.whisperEnabled && (navigationPending ||
            settings.audioEnabled !== false && currentVideoId()) &&
            isGoogleVideoPlaybackUrl(response.url)) {
          processSabrResponse(response, requestVideoId, requestDuringNavigation);
        }
      } catch (error) {
        debugLog("fetch observation failed", error && (error.message || String(error)));
      }
      return response;
    });
  }

  // Chromium + Firefox: selected-track JSON3 captions arrive through XHR, not Fetch.
  function uncensoredOpen(method, url) {
    var timedText = isTimedTextUrl(url);
    var videoId = timedText ? timedTextVideoId(url) : currentVideoId();
    var result = originalXHROpen.apply(this, arguments);

    if (timedText) {
      this.addEventListener("readystatechange", function onReadyStateChange() {
        if (this.readyState !== 4) return;
        this.removeEventListener("readystatechange", onReadyStateChange);
        if ((this.responseType !== "" && this.responseType !== "text") ||
            typeof this.responseText !== "string" || videoId !== currentVideoId()) return;

        notifyTimedText(this.responseText, url, videoId);
        var api = globalThis.UncensoredTimedText;
        var patchedBody = !api
          ? this.responseText
          : api.patchTimedTextBodyWithOverrides(
            this.responseText,
            replacementsForCurrentVideo(),
            settings.rulesEnabled,
            !settings.whisperEnabled
          );
        if (patchedBody === this.responseText) return;

        try {
          Object.defineProperty(this, "responseText", { value: patchedBody });
          Object.defineProperty(this, "response", { value: patchedBody });
        } catch (error) {}
      });
    }
    return result;
  }

  // Chromium can replace these wrappers during SPA navigation, so both are reinstalled.
  function installNetworkHooks() {
    globalThis.fetch = uncensoredFetch;
    XMLHttpRequest.prototype.open = uncensoredOpen;
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
    notifyMissingCaptions(0);
  });
})();
