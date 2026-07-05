(function installUncensoredPageHook() {
  "use strict";

  var VERSION = 19;
  var PATCH_CACHE_LIMIT = 16;
  var originalFetch = globalThis.__uncensoredOriginalFetch || globalThis.fetch;
  var originalXHROpen = globalThis.__uncensoredOriginalXHROpen || XMLHttpRequest.prototype.open;
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var audioReplacements = new Map();
  var audioReplacementVersion = 0;
  var patchedTimedTextCache = new Map();
  var nextAudioStreamId = 1;
  var nextAudioMessageId = 1;
  var pendingAudioMessages = new Map();

  globalThis.__uncensoredOriginalFetch = originalFetch;
  globalThis.__uncensoredOriginalXHROpen = originalXHROpen;
  globalThis.__uncensoredYoutubeTimedTextHookVersion = VERSION;

  function timedTextApi() {
    return globalThis.UncensoredTimedText;
  }

  function currentVideoId() {
    try {
      return new URL(location.href).searchParams.get("v") || "";
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

  function audioReplacementKey(videoId, tokenIndex) {
    return videoId + ":" + tokenIndex;
  }

  globalThis.addEventListener("uncensored-settings", function updateSettings(event) {
    var detail = safeJson(event && event.detail);

    if (detail) {
      settings.rulesEnabled = detail.rulesEnabled !== false;
      settings.whisperEnabled = detail.whisperEnabled !== false;
      clearPatchedTimedTextCache();
    }
  });

  globalThis.addEventListener("uncensored-whisper-resolution", function rememberResolution(event) {
    var detail = safeJson(event && event.detail);
    var videoId = currentVideoId();

    if (!detail || typeof detail.tokenIndex !== "number" || !detail.word) {
      return;
    }

    audioReplacements.set(audioReplacementKey(videoId, detail.tokenIndex), {
      videoId: videoId,
      tokenIndex: detail.tokenIndex,
      word: detail.word,
      source: detail.source || "unknown"
    });
    audioReplacementVersion += 1;
    clearPatchedTimedTextCache();
  });

  function isTimedTextUrl(input) {
    var url = requestUrl(input);

    try {
      url = new URL(url, location.href);
    } catch (error) {
      return false;
    }

    return url.href.indexOf("/api/timedtext") !== -1 && url.searchParams.get("fmt") === "json3";
  }

  function notifyTimedText(body) {
    try {
      globalThis.dispatchEvent(new CustomEvent("uncensored-timedtext", {
        detail: body
      }));
    } catch (error) {
      return;
    }
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

    if (event.source !== globalThis || !message || message.uncensoredSabrAck !== true) {
      return;
    }

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

    globalThis.console.debug.apply(globalThis.console, ["[uncensored]"].concat(Array.prototype.slice.call(arguments)));
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
    return !mime || mime.indexOf("video/") !== 0;
  }

  function relaySabrBuffer(streamId, bufferPromise) {
    bufferPromise.then(function relayBuffer(buffer) {
      return postAudioMessage({ type: "chunk", streamId: streamId, buffer: buffer }, [buffer]);
    }).then(function finishBuffer() {
      postAudioMessage({ type: "end", streamId: streamId });
    }, function finishFailedBuffer() {
      postAudioMessage({ type: "end", streamId: streamId });
    });
  }

  function processSabrResponse(response) {
    var streamId = nextAudioStreamId;
    nextAudioStreamId += 1;
    var cloned = response.clone();

    if (!cloned.body || typeof cloned.body.getReader !== "function") {
      postAudioMessage({ type: "start", streamId: streamId }).then(function startFullBuffer() {
        relaySabrBuffer(streamId, cloned.arrayBuffer());
      });
      return;
    }

    var reader = cloned.body.getReader();

    function pump() {
      return reader.read().then(function pumpResult(result) {
        var chunk;

        if (result.done || !settings.whisperEnabled) {
          if (!result.done) {
            reader.cancel().catch(function ignoreCancelError() {});
          }
          return postAudioMessage({ type: "end", streamId: streamId });
        }

        chunk = result.value.byteOffset === 0 && result.value.byteLength === result.value.buffer.byteLength
          ? result.value.buffer
          : result.value.buffer.slice(result.value.byteOffset, result.value.byteOffset + result.value.byteLength);
        return postAudioMessage({ type: "chunk", streamId: streamId, buffer: chunk }, [chunk]).then(pump);
      }, function pumpError() {
        postAudioMessage({ type: "end", streamId: streamId });
      });
    }

    postAudioMessage({ type: "start", streamId: streamId }).then(pump);
  }

  function replacementsForCurrentVideo() {
    var videoId = currentVideoId();
    var keyPrefix = videoId + ":";
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
      patchedBody = api.patchTimedTextBodyWithOverrides(body, replacementsForCurrentVideo(), settings.rulesEnabled);
      rememberPatchedTimedText(cacheKey, body, patchedBody);
      return patchedBody;
    }

    patchedBody = settings.rulesEnabled && api.patchTimedTextBody ? api.patchTimedTextBody(body) : body;
    rememberPatchedTimedText(cacheKey, body, patchedBody);
    return patchedBody;
  }

  function debugAudio() {
    var video = document.querySelector("video");
    var report = {
      hookVersion: VERSION,
      hasTimedTextApi: Boolean(timedTextApi()),
      currentSrc: video && video.currentSrc || ""
    };

    if (console && console.log) {
      console.log("[uncensored] audio debug", report);
    }

    return report;
  }

  function debugAudioText() {
    return JSON.stringify(debugAudio(), null, 2);
  }

  globalThis.__uncensoredDebugAudio = debugAudio;
  globalThis.__uncensoredDebugAudioText = debugAudioText;
  function uncensoredFetch(input, init) {
    return originalFetch.apply(this, arguments).then(function maybePatch(response) {
      if (settings.whisperEnabled && isGoogleVideoPlaybackUrl(input)) {
        processSabrResponse(response);
      }

      if (isTimedTextUrl(input)) {
        return response.clone().text().then(function rewriteTimedText(body) {
          var patchedBody;

          notifyTimedText(body);
          patchedBody = patchTimedTextBody(body);
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
    result = originalXHROpen.apply(this, arguments);

    if (this.__uncensoredTimedTextUrl) {
      this.addEventListener("readystatechange", function onReadyStateChange() {
        var patchedBody;

        if (this.readyState !== 4 || typeof this.responseText !== "string") {
          return;
        }

        notifyTimedText(this.responseText);
        patchedBody = patchTimedTextBody(this.responseText);
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

  globalThis.addEventListener("yt-navigate-finish", function onNavigate() {
    clearPatchedTimedTextCache();
    audioReplacements.clear();
    audioReplacementVersion += 1;
  });
})();
