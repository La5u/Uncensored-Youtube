(function installUncensoredPageHook() {
  "use strict";

  var VERSION = 18;
  var PATCH_CACHE_LIMIT = 16;
  var sabrParser = globalThis.UncensoredSabrParser;
  var originalFetch = globalThis.__uncensoredOriginalFetch || globalThis.fetch;
  var originalXHROpen = globalThis.__uncensoredOriginalXHROpen || XMLHttpRequest.prototype.open;
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var audioReplacements = new Map();
  var audioReplacementVersion = 0;
  var patchedTimedTextCache = new Map();
  var lastSabrAudioDetail = "";
  var initChunksByItag = Object.create(null);

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

  function notifySabrAudio(detailJson) {
    try {
      globalThis.dispatchEvent(new CustomEvent("uncensored-sabr-audio", {
        detail: detailJson
      }));
    } catch (error) {
      return;
    }
  }

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

  globalThis.addEventListener("uncensored-request-sabr-audio", function replaySabrAudio() {
    if (lastSabrAudioDetail) {
      notifySabrAudio(lastSabrAudioDetail);
    }
  });

  function isGoogleVideoPlaybackUrl(input) {
    var url;

    try {
      url = new URL(requestUrl(input), location.href);
    } catch (error) {
      return false;
    }

    return /(^|\.)googlevideo\.com$/.test(url.hostname) &&
      url.pathname.indexOf("/videoplayback") !== -1;
  }

  function makeSabrParser() {
    if (!sabrParser || !sabrParser.createParser) {
      return null;
    }

    return sabrParser.createParser({
      onInitSegment: function onInitSegment(itag, chunk) {
        var key = String(itag);
        if (!initChunksByItag[key]) {
          initChunksByItag[key] = [];
        }
        initChunksByItag[key].push(chunk);
      },
      onSegment: function onSegment(segment) {
        var key = String(segment.itag);
        var cached = initChunksByItag[key];
        var chunks = segment.chunks;

        if (cached && cached.length) {
          var totalBytes = chunks.reduce(function sum(len, c) { return len + c.byteLength; }, 0);
          if (totalBytes <= segment.bytes) {
            chunks = cached.concat(chunks);
          }
        }

        lastSabrAudioDetail = JSON.stringify({
          itag: segment.itag,
          bytes: segment.bytes,
          segmentBytes: segment.bytes,
          startMs: typeof segment.header.startMs === "number" ? segment.header.startMs : null,
          durationMs: typeof segment.header.durationMs === "number" ? segment.header.durationMs : null,
          base64: sabrParser.chunksToBase64(chunks)
        });
        notifySabrAudio(lastSabrAudioDetail);
      }
    });
  }

  function processSabrResponse(input, response) {
    var parser = makeSabrParser();
    if (!parser) return;

    var cloned = response.clone();
    if (!cloned.body || typeof cloned.body.getReader !== "function") {
      cloned.arrayBuffer().then(function processFullBuffer(buffer) {
        parser.push(buffer);
      }, function ignoreAudioErrorFallback() {});
      return;
    }

    var reader = cloned.body.getReader();

    function pump() {
      return reader.read().then(function pumpResult(result) {
        if (result.done) return;

        parser.push(result.value);
        return pump();
      }, function pumpError() {});
    }

    pump();
  }

  function processSabrXhr(xhr) {
    var parser = makeSabrParser();

    if (!parser) {
      return;
    }

    try {
      if (xhr.response instanceof ArrayBuffer) {
        parser.push(xhr.response);
      } else if (xhr.response instanceof Blob) {
        xhr.response.arrayBuffer().then(function parseBuffer(buffer) {
          parser.push(buffer);
        }, function ignoreAudioError() {});
      }
    } catch (error) {}
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
      if (isGoogleVideoPlaybackUrl(input)) {
        processSabrResponse(input, response);
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
    this.__uncensoredSabrUrl = isGoogleVideoPlaybackUrl(url) ? requestUrl(url) : "";
    result = originalXHROpen.apply(this, arguments);

    if (this.__uncensoredSabrUrl) {
      this.addEventListener("loadend", function onSabrLoadEnd() {
        if (this.__uncensoredSabrUrl) {
          processSabrXhr(this);
        }
      });
    }

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
  if (globalThis.setInterval) {
    globalThis.setInterval(installNetworkHooks, 1000);
  }

  globalThis.addEventListener("yt-navigate-finish", function onNavigate() {
    clearPatchedTimedTextCache();
    audioReplacements.clear();
    audioReplacementVersion += 1;
    lastSabrAudioDetail = "";
  });
})();
