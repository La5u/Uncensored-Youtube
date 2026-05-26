(function installUncensoredPageHook() {
  "use strict";

  var VERSION = 17;
  var PATCH_CACHE_LIMIT = 16;
  var audioItags = Object.freeze({
    "139": true, "140": true, "141": true,
    "249": true, "250": true, "251": true,
    "599": true, "600": true
  });
  var originalFetch = globalThis.__uncensoredOriginalFetch || globalThis.fetch;
  var originalXHROpen = globalThis.__uncensoredOriginalXHROpen || XMLHttpRequest.prototype.open;
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var audioReplacements = new Map();
  var audioReplacementVersion = 0;
  var patchedTimedTextCache = new Map();
  var sabrAudio = new Map();
  var sabrCarry = new Uint8Array(0);
  var sabrHeaders = Object.create(null);
  var fetchedAudioUrls = Object.create(null);

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
      if (settings.whisperEnabled) {
        fetchGoogleAudio();
      }
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

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    var index;

    for (index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }

    return btoa(binary);
  }

  function dispatchGoogleAudio(buffer, startMs) {
    if (!buffer || !buffer.byteLength) {
      return;
    }

    try {
      globalThis.dispatchEvent(new CustomEvent("uncensored-sabr-audio", {
        detail: JSON.stringify({
          bytes: buffer.byteLength,
          startMs: startMs || 0,
          base64: arrayBufferToBase64(buffer)
        })
      }));
    } catch (error) {}
  }

  function extractBalancedObject(text, openIndex) {
    var depth = 0;
    var index;
    var quote = "";
    var escaped = false;

    for (index = openIndex; index < text.length; index += 1) {
      var character = text[index];

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = "";
        }
        continue;
      }

      if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(openIndex, index + 1);
        }
      }
    }

    return "";
  }

  function scriptPlayerResponse() {
    var found = null;

    Array.prototype.slice.call(document.scripts || []).some(function parseScript(script) {
      var text = script && script.textContent || "";
      var marker = text.indexOf("ytInitialPlayerResponse");
      var openIndex;
      var jsonText;

      if (marker === -1) {
        return false;
      }

      openIndex = text.indexOf("{", marker);
      jsonText = openIndex === -1 ? "" : extractBalancedObject(text, openIndex);
      if (!jsonText) {
        return false;
      }

      try {
        found = JSON.parse(jsonText);
        return true;
      } catch (error) {
        return false;
      }
    });

    return found;
  }

  function playerResponse() {
    var raw;

    if (globalThis.ytInitialPlayerResponse) {
      return globalThis.ytInitialPlayerResponse;
    }

    raw = globalThis.ytplayer && globalThis.ytplayer.config &&
      globalThis.ytplayer.config.args && globalThis.ytplayer.config.args.player_response;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch (error) {}
    }

    return scriptPlayerResponse();
  }

  function formatIsAudio(format) {
    var mimeType = format && format.mimeType || "";

    return mimeType.indexOf("audio/") === 0 || Boolean(format && audioItags[String(format.itag)]);
  }

  function isFetchableGoogleAudioUrl(value) {
    var url;

    try {
      url = new URL(value, location.href);
    } catch (error) {
      return false;
    }

    return (url.protocol === "https:" || url.protocol === "http:") &&
      /(^|\.)googlevideo\.com$/.test(url.hostname) &&
      url.pathname.indexOf("/videoplayback") !== -1;
  }

  function audioFormatScore(format) {
    var itag = String(format && format.itag || "");
    var bitrate = typeof format.bitrate === "number" ? format.bitrate : 0;

    if (itag === "249" || itag === "250" || itag === "251") {
      return 1000000 - bitrate;
    }

    return 2000000 - bitrate;
  }

  function bestGoogleAudioUrl() {
    var response = playerResponse();
    var formats = response && response.streamingData && response.streamingData.adaptiveFormats;

    if (!Array.isArray(formats)) {
      return "";
    }

    formats = formats.filter(function hasDirectAudioUrl(format) {
      return format && format.url && formatIsAudio(format) && isFetchableGoogleAudioUrl(format.url);
    }).sort(function sortAudioFormats(left, right) {
      return audioFormatScore(left) - audioFormatScore(right);
    });

    return formats[0] && formats[0].url || "";
  }

  function fetchGoogleAudio() {
    var url = bestGoogleAudioUrl();

    if (!settings.whisperEnabled || !url || fetchedAudioUrls[url]) {
      return;
    }

    fetchedAudioUrls[url] = true;
    originalFetch.call(globalThis, url, {
      credentials: "include"
    }).then(function gotAudio(response) {
      if (!response || !response.ok) {
        return null;
      }

      return response.arrayBuffer();
    }).then(function gotAudioBuffer(buffer) {
      dispatchGoogleAudio(buffer, 0);
    }, function ignoreAudioFetchError() {});
  }

  function readUmpVarint(bytes, offset) {
    var first = bytes[offset];
    var length;
    var value;

    if (first === undefined) {
      return null;
    }

    length = first < 128 ? 1 : first < 192 ? 2 : first < 224 ? 3 : first < 240 ? 4 : 5;
    if (offset + length > bytes.length) {
      return null;
    }

    if (length === 1) {
      value = first;
    } else if (length === 2) {
      value = (first & 0x3f) + 64 * bytes[offset + 1];
    } else if (length === 3) {
      value = (first & 0x1f) + 32 * (bytes[offset + 1] + 256 * bytes[offset + 2]);
    } else if (length === 4) {
      value = (first & 0x0f) + 16 * (bytes[offset + 1] + 256 * (bytes[offset + 2] + 256 * bytes[offset + 3]));
    } else {
      value = bytes[offset + 1] + 256 * (bytes[offset + 2] + 256 * (bytes[offset + 3] + 256 * bytes[offset + 4]));
    }

    return {
      value: value,
      offset: offset + length
    };
  }

  function parseUmpParts(bytes) {
    var offset = 0;
    var parts = [];

    while (offset < bytes.length) {
      var type = readUmpVarint(bytes, offset);
      var size;
      var dataStart;

      if (!type) {
        return { parts: parts, offset: offset };
      }

      size = readUmpVarint(bytes, type.offset);
      if (!size) {
        return { parts: parts, offset: offset };
      }

      dataStart = size.offset;
      if (dataStart + size.value > bytes.length) {
        return { parts: parts, offset: offset };
      }

      parts.push({
        type: type.value,
        data: bytes.slice(dataStart, dataStart + size.value)
      });
      offset = dataStart + size.value;
    }

    return { parts: parts, offset: offset };
  }

  function readSabrHeaderId(data) {
    return readUmpVarint(data, 0);
  }

  function newSabrParseState() {
    return {
      carry: new Uint8Array(0),
      headers: Object.create(null)
    };
  }

  function readProtoVarint(bytes, offset) {
    var shift = 0;
    var value = 0;

    while (offset < bytes.length) {
      var byte = bytes[offset];

      value += (byte & 0x7f) * Math.pow(2, shift);
      offset += 1;
      if (!(byte & 0x80)) {
        return {
          value: value,
          offset: offset
        };
      }
      shift += 7;
    }

    return null;
  }

  function parseMediaHeader(bytes) {
    var offset = 0;
    var header = {};

    while (offset < bytes.length) {
      var tag = readProtoVarint(bytes, offset);
      var field;
      var wire;
      var value;
      var length;

      if (!tag || tag.value === 0) {
        break;
      }

      offset = tag.offset;
      field = tag.value >> 3;
      wire = tag.value & 7;

      if (wire === 0) {
        value = readProtoVarint(bytes, offset);
        if (!value) {
          break;
        }
        offset = value.offset;
        if (field === 3) {
          header.itag = value.value;
        } else if (field === 1) {
          header.headerId = value.value;
        } else if (field === 8) {
          header.isInitSeg = Boolean(value.value);
        } else if (field === 11) {
          header.startMs = value.value;
        } else if (field === 12) {
          header.durationMs = value.value;
        }
      } else if (wire === 2) {
        length = readProtoVarint(bytes, offset);
        if (!length) {
          break;
        }
        offset = length.offset + length.value;
      } else if (wire === 5) {
        offset += 4;
      } else if (wire === 1) {
        offset += 8;
      } else {
        break;
      }
    }

    return header;
  }

  function chunksToBase64(chunks) {
    var length = chunks.reduce(function sum(total, chunk) {
      return total + chunk.length;
    }, 0);
    var bytes = new Uint8Array(length);
    var offset = 0;
    var binary = "";
    var index;

    chunks.forEach(function copy(chunk) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    });

    for (index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }

    return btoa(binary);
  }

  function appendSabrAudioChunk(header, chunk) {
    var key = String(header.itag || 0);
    var entry;
    var segment;

    if (!header.itag || !audioItags[key] || !chunk.length) {
      return;
    }

    entry = sabrAudio.get(key);
    if (!entry) {
      entry = {
        itag: header.itag,
        initChunks: [],
        activeSegments: Object.create(null)
      };
      sabrAudio.set(key, entry);
    }

    if (header.isInitSeg) {
      entry.initChunks.push(chunk);
      return;
    }

    segment = entry.activeSegments[String(header.headerId)];
    if (!segment) {
      segment = {
        header: header,
        chunks: [],
        bytes: 0
      };
      entry.activeSegments[String(header.headerId)] = segment;
    }
    segment.chunks.push(chunk);
    segment.bytes += chunk.length;
  }

  function dispatchSabrAudioSegment(headerId, header) {
    header = header || sabrHeaders[headerId];
    var entry = sabrAudio.get(String(header && header.itag || 0));
    var segment = entry && entry.activeSegments && entry.activeSegments[String(headerId)];

    if (!entry || !entry.initChunks.length || !segment || !segment.chunks.length) {
      return;
    }

    delete entry.activeSegments[String(headerId)];
    try {
      globalThis.dispatchEvent(new CustomEvent("uncensored-sabr-audio", {
        detail: JSON.stringify({
          itag: entry.itag,
          bytes: segment.bytes,
          segmentBytes: segment.bytes,
          startMs: typeof segment.header.startMs === "number" ? segment.header.startMs : null,
          durationMs: typeof segment.header.durationMs === "number" ? segment.header.durationMs : null,
          base64: chunksToBase64(entry.initChunks.concat(segment.chunks))
        })
      }));
    } catch (error) {}
  }

  function processSabrBuffer(buffer, state) {
    var bytes;
    var combined;
    var parsed;

    if (!buffer) {
      return;
    }

    state = state || {
      carry: sabrCarry,
      headers: sabrHeaders
    };
    bytes = new Uint8Array(buffer);
    combined = new Uint8Array(state.carry.length + bytes.length);
    combined.set(state.carry, 0);
    combined.set(bytes, state.carry.length);
    parsed = parseUmpParts(combined);
    state.carry = combined.slice(parsed.offset);
    if (state.headers === sabrHeaders) {
      sabrCarry = state.carry;
    }

    parsed.parts.forEach(function handlePart(part) {
      var headerId;
      var header;

      if (part.type === 20) {
        header = parseMediaHeader(part.data);
        if (header.headerId !== undefined) {
          state.headers[header.headerId] = header;
        }
      } else if (part.type === 21 && part.data.length) {
        headerId = readSabrHeaderId(part.data);
        if (!headerId) {
          return;
        }
        if (state.headers[headerId.value]) {
          appendSabrAudioChunk(state.headers[headerId.value], part.data.slice(headerId.offset));
        }
      } else if (part.type === 22) {
        headerId = readSabrHeaderId(part.data);
        if (!headerId) {
          return;
        }
        dispatchSabrAudioSegment(headerId.value, state.headers[headerId.value]);
        delete state.headers[headerId.value];
      }
    });
  }

  function processSabrResponse(response) {
    var clone = response.clone();
    var reader;
    var state = newSabrParseState();

    if (!clone.body || !clone.body.getReader) {
      clone.arrayBuffer().then(function parseBuffer(buffer) {
        processSabrBuffer(buffer, state);
      }, function ignoreAudioError() {});
      return;
    }

    reader = clone.body.getReader();
    function readNext() {
      return reader.read().then(function handle(result) {
        if (result.done || !result.value) {
          return;
        }

        processSabrBuffer(result.value.buffer.slice(result.value.byteOffset, result.value.byteOffset + result.value.byteLength), state);
        return readNext();
      });
    }

    readNext().catch(function ignoreAudioError() {});
  }

  function processSabrXhr(xhr) {
    var state = newSabrParseState();

    try {
      if (xhr.response instanceof ArrayBuffer) {
        processSabrBuffer(xhr.response, state);
      } else if (xhr.response instanceof Blob) {
        xhr.response.arrayBuffer().then(function parseBuffer(buffer) {
          processSabrBuffer(buffer, state);
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
  globalThis.setTimeout(fetchGoogleAudio, 0);
  globalThis.setTimeout(fetchGoogleAudio, 1500);
  globalThis.addEventListener("load", fetchGoogleAudio);
  globalThis.addEventListener("pageshow", fetchGoogleAudio);

  globalThis.fetch = function uncensoredFetch(input, init) {
    return originalFetch.apply(this, arguments).then(function maybePatch(response) {
      if (isGoogleVideoPlaybackUrl(input)) {
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
  };

  XMLHttpRequest.prototype.open = function uncensoredOpen(method, url) {
    var result;

    this.__uncensoredTimedTextUrl = isTimedTextUrl(url);
    this.__uncensoredSabrUrl = isGoogleVideoPlaybackUrl(url);
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
  };

  globalThis.addEventListener("yt-navigate-finish", function onNavigate() {
    clearPatchedTimedTextCache();
    audioReplacementVersion += 1;
    sabrAudio.clear();
    sabrCarry = new Uint8Array(0);
    sabrHeaders = Object.create(null);
    fetchedAudioUrls = Object.create(null);
    globalThis.setTimeout(fetchGoogleAudio, 0);
    globalThis.setTimeout(fetchGoogleAudio, 1500);
  });
})();
