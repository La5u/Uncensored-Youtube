(function installUncensoredPageHook() {
  "use strict";

  var VERSION = 16;
  var originalFetch = globalThis.__uncensoredOriginalFetch || globalThis.fetch;
  var originalXHROpen = globalThis.__uncensoredOriginalXHROpen || XMLHttpRequest.prototype.open;
  var audioItags = Object.freeze({
    "139": true,
    "140": true,
    "141": true,
    "249": true,
    "250": true,
    "251": true,
    "599": true,
    "600": true
  });
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var audioReplacements = [];
  var sabrAudio = new Map();
  var probedSabrUrls = Object.create(null);
  var sabrCarry = new Uint8Array(0);
  var sabrHeaders = Object.create(null);
  var sabrDebug = {
    fetches: 0,
    xhrs: 0,
    probes: 0,
    probeBytes: 0,
    responses: 0,
    parsedParts: 0,
    emptyResponses: 0,
    parts: {},
    audioBytes: 0,
    lastItag: 0,
    lastHeaderId: -1,
    firstMediaBytes: "",
    lastUrl: "",
    lastBufferBytes: 0,
    lastPartTypes: [],
    lastProbeStatus: "",
    lastError: ""
  };

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

  globalThis.addEventListener("uncensored-settings", function updateSettings(event) {
    var detail = safeJson(event && event.detail);

    if (detail) {
      settings.rulesEnabled = detail.rulesEnabled !== false;
      settings.whisperEnabled = detail.whisperEnabled !== false;
    }
  });

  globalThis.addEventListener("uncensored-whisper-resolution", function rememberResolution(event) {
    var detail = safeJson(event && event.detail);
    var videoId = currentVideoId();

    if (!detail || typeof detail.tokenIndex !== "number" || !detail.word) {
      return;
    }

    audioReplacements = audioReplacements.filter(function keepDifferent(replacement) {
      return replacement.videoId !== videoId || replacement.tokenIndex !== detail.tokenIndex;
    });
    audioReplacements.push({
      videoId: videoId,
      tokenIndex: detail.tokenIndex,
      word: detail.word
    });
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

  function replacementsForCurrentVideo() {
    var videoId = currentVideoId();

    return audioReplacements.filter(function forVideo(replacement) {
      return replacement.videoId === videoId;
    });
  }

  function patchTimedTextBody(body) {
    var api = timedTextApi();

    if (!api || typeof body !== "string") {
      return body;
    }

    if (api.patchTimedTextBodyWithOverrides) {
      return api.patchTimedTextBodyWithOverrides(body, replacementsForCurrentVideo(), settings.rulesEnabled, settings.whisperEnabled);
    }

    return settings.rulesEnabled && api.patchTimedTextBody ? api.patchTimedTextBody(body) : body;
  }

  function isGoogleVideoAudioUrl(value) {
    var url;
    var mime;
    var itag;

    try {
      url = new URL(value, location.href);
    } catch (error) {
      return false;
    }

    if (!/(^|\.)googlevideo\.com$/.test(url.hostname) || url.pathname.indexOf("/videoplayback") === -1) {
      return false;
    }

    mime = url.searchParams.get("mime") || "";
    itag = url.searchParams.get("itag") || "";
    return mime.indexOf("audio/") === 0 || Boolean(audioItags[itag]);
  }

  function isGoogleVideoPlaybackUrl(value) {
    var url;

    try {
      url = new URL(value, location.href);
    } catch (error) {
      return false;
    }

    return /(^|\.)googlevideo\.com$/.test(url.hostname) &&
      url.pathname.indexOf("/videoplayback") !== -1;
  }

  function rememberSabrUrl(value) {
    try {
      sabrDebug.lastUrl = String(value || "").slice(0, 180);
    } catch (error) {
      sabrDebug.lastUrl = "";
    }
  }

  function parseCipher(cipher) {
    var params;

    if (!cipher) {
      return null;
    }

    try {
      params = new URLSearchParams(cipher);
    } catch (error) {
      return null;
    }

    return {
      url: params.get("url") || "",
      signature: params.get("s") || "",
      signatureParam: params.get("sp") || "signature"
    };
  }

  function formatIsAudio(format) {
    var mimeType = format && format.mimeType || "";

    return mimeType.indexOf("audio/") === 0 || Boolean(format && audioItags[String(format.itag)]);
  }

  function summarizeFormats(formats) {
    if (!Array.isArray(formats)) {
      return [];
    }

    return formats.filter(formatIsAudio).map(function summarize(format) {
      var cipher = parseCipher(format.signatureCipher || format.cipher || "");

      return {
        itag: format.itag,
        mimeType: format.mimeType || "",
        keys: Object.keys(format).sort(),
        hasUrl: Boolean(format.url),
        hasCipher: Boolean(format.signatureCipher || format.cipher),
        hasCipherUrl: Boolean(cipher && cipher.url),
        hasCipherSignature: Boolean(cipher && cipher.signature),
        url: format.url ? String(format.url).slice(0, 140) : "",
        cipherUrl: cipher && cipher.url ? cipher.url.slice(0, 140) : ""
      };
    });
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

  function scriptPlayerResponses() {
    var responses = [];

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
        responses.push({
          source: "script",
          response: JSON.parse(jsonText)
        });
        return true;
      } catch (error) {
        return false;
      }
    });

    return responses;
  }

  function playerResponses() {
    var responses = [];
    var raw;

    if (globalThis.ytInitialPlayerResponse) {
      responses.push({
        source: "ytInitialPlayerResponse",
        response: globalThis.ytInitialPlayerResponse
      });
    }

    raw = globalThis.ytplayer && globalThis.ytplayer.config &&
      globalThis.ytplayer.config.args && globalThis.ytplayer.config.args.player_response;
    if (typeof raw === "string") {
      try {
        responses.push({
          source: "ytplayer.config",
          response: JSON.parse(raw)
        });
      } catch (error) {}
    }

    return responses.concat(scriptPlayerResponses());
  }

  function serverAbrUrlsFromResponses() {
    var urls = [];

    playerResponses().forEach(function collect(item) {
      var url = item.response && item.response.streamingData && item.response.streamingData.serverAbrStreamingUrl;

      if (url && urls.indexOf(url) === -1) {
        urls.push(url);
      }
    });

    return urls;
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
        return {
          parts: parts,
          offset: offset
        };
      }

      size = readUmpVarint(bytes, type.offset);
      if (!size) {
        return {
          parts: parts,
          offset: offset
        };
      }

      dataStart = size.offset;
      if (dataStart + size.value > bytes.length) {
        return {
          parts: parts,
          offset: offset
        };
      }

      parts.push({
        type: type.value,
        data: bytes.slice(dataStart, dataStart + size.value)
      });
      offset = dataStart + size.value;
    }

    return {
      parts: parts,
      offset: offset
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
        } else if (field === 9) {
          header.sequenceNumber = value.value;
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

  function audioMimeForItag(itag) {
    var responses = playerResponses();
    var found = "";

    responses.some(function findInResponse(item) {
      var formats = item.response && item.response.streamingData && item.response.streamingData.adaptiveFormats;

      return Array.isArray(formats) && formats.some(function findFormat(format) {
        if (format && format.itag === itag && formatIsAudio(format)) {
          found = format.mimeType || "";
          return true;
        }
        return false;
      });
    });

    return found;
  }

  function appendSabrAudioChunk(header, chunk) {
    var key = String(header.itag || 0);
    var entry;

    if (!header.itag || !audioItags[key]) {
      return;
    }

    entry = sabrAudio.get(key);
    if (!entry) {
      entry = {
        itag: header.itag,
        mimeType: audioMimeForItag(header.itag),
        chunks: [],
        bytes: 0,
        dispatchedBytes: 0,
        hasInitSeg: false,
        hasMediaSeg: false
      };
      sabrAudio.set(key, entry);
    }

    if (!chunk.length) {
      return;
    }

    if (!sabrDebug.firstMediaBytes) {
      sabrDebug.firstMediaBytes = Array.prototype.slice.call(chunk.slice(0, 12)).map(function hex(byte) {
        return byte.toString(16).padStart(2, "0");
      }).join(" ");
    }

    if (header.isInitSeg) {
      entry.hasInitSeg = true;
      entry.chunks.unshift(chunk);
    } else {
      entry.hasMediaSeg = true;
      entry.chunks.push(chunk);
    }
    entry.bytes += chunk.length;
    sabrDebug.audioBytes += chunk.length;
    sabrDebug.lastItag = header.itag;
    sabrDebug.lastHeaderId = header.headerId === undefined ? -1 : header.headerId;
    dispatchSabrAudio(entry);
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

  function dispatchSabrAudio(entry) {
    if (!entry || !entry.hasInitSeg || !entry.hasMediaSeg || !entry.chunks.length || entry.bytes <= entry.dispatchedBytes) {
      return;
    }

    entry.dispatchedBytes = entry.bytes;
    try {
      globalThis.dispatchEvent(new CustomEvent("uncensored-sabr-audio", {
        detail: JSON.stringify({
          itag: entry.itag,
          mimeType: entry.mimeType,
          bytes: entry.bytes,
          base64: chunksToBase64(entry.chunks)
        })
      }));
    } catch (error) {
      sabrDebug.lastError = error && (error.message || String(error));
    }
  }

  function processSabrBuffer(buffer) {
    var bytes;
    var combined;
    var parsed;
    var parts;

    if (!buffer) {
      return;
    }

    sabrDebug.responses += 1;
    sabrDebug.lastBufferBytes = buffer.byteLength || 0;
    bytes = new Uint8Array(buffer);
    combined = new Uint8Array(sabrCarry.length + bytes.length);
    combined.set(sabrCarry, 0);
    combined.set(bytes, sabrCarry.length);
    parsed = parseUmpParts(combined);
    parts = parsed.parts;
    sabrCarry = combined.slice(parsed.offset);
    sabrDebug.parsedParts += parts.length;
    sabrDebug.lastPartTypes = parts.slice(0, 24).map(function mapType(part) {
      return part.type;
    });

    if (!parts.length) {
      sabrDebug.emptyResponses += 1;
      return;
    }

    parts.forEach(function handlePart(part) {
      sabrDebug.parts[part.type] = (sabrDebug.parts[part.type] || 0) + 1;
      if (part.type === 20) {
        var header = parseMediaHeader(part.data);
        if (header.headerId !== undefined) {
          sabrHeaders[header.headerId] = header;
        }
      } else if (part.type === 21 && part.data.length) {
        var headerId = part.data[0];
        var mediaHeader = sabrHeaders[headerId];
        if (mediaHeader) {
          appendSabrAudioChunk(mediaHeader, part.data.slice(1));
        }
      } else if (part.type === 22) {
        delete sabrHeaders[part.data[0]];
      }
    });
  }

  function processSabrResponse(response) {
    var clone = response.clone();
    var reader;

    if (!clone.body || !clone.body.getReader) {
      clone.arrayBuffer().then(function parseResponse(buffer) {
        processSabrBuffer(buffer);
      }).catch(function failed(error) {
        sabrDebug.lastError = error && (error.message || String(error));
      });
      return;
    }

    reader = clone.body.getReader();
    function readNext() {
      return reader.read().then(function handle(result) {
        if (result.done || !result.value) {
          return;
        }

        processSabrBuffer(result.value.buffer.slice(result.value.byteOffset, result.value.byteOffset + result.value.byteLength));
        return readNext();
      });
    }

    readNext().catch(function failed(error) {
      sabrDebug.lastError = error && (error.message || String(error));
    });
  }

  function processSabrXhr(xhr) {
    var response = xhr.response;

    try {
      if (response instanceof ArrayBuffer) {
        processSabrBuffer(response);
      } else if (response instanceof Blob) {
        response.arrayBuffer().then(processSabrBuffer).catch(function failed(error) {
          sabrDebug.lastError = error && (error.message || String(error));
        });
      }
    } catch (error) {
      sabrDebug.lastError = error && (error.message || String(error));
    }
  }

  function concatChunks(chunks, totalBytes) {
    var output = new Uint8Array(totalBytes);
    var offset = 0;

    chunks.forEach(function copy(chunk) {
      output.set(chunk, offset);
      offset += chunk.length;
    });

    return output.buffer;
  }

  function readSabrProbe(response, url) {
    var reader;
    var chunks = [];
    var totalBytes = 0;
    var maxBytes = 6 * 1024 * 1024;
    var maxReads = 96;
    var reads = 0;

    if (!response.body || !response.body.getReader) {
      return response.arrayBuffer().then(function processWholeBuffer(buffer) {
        sabrDebug.probeBytes += buffer.byteLength || 0;
        processSabrBuffer(buffer);
      });
    }

    reader = response.body.getReader();

    function readNext() {
      return reader.read().then(function handle(result) {
        var value = result.value;

        if (result.done || !value) {
          sabrDebug.probeBytes += totalBytes;
          processSabrBuffer(concatChunks(chunks, totalBytes));
          return;
        }

        chunks.push(value);
        totalBytes += value.length;
        reads += 1;
        if (totalBytes >= maxBytes || reads >= maxReads) {
          return reader.cancel().catch(function ignoreCancel() {}).then(function processPartial() {
            sabrDebug.probeBytes += totalBytes;
            processSabrBuffer(concatChunks(chunks, totalBytes));
          });
        }

        return readNext();
      });
    }

    sabrDebug.lastProbeStatus = "reading " + url.slice(0, 120);
    return readNext();
  }

  function probeSabrUrl(url) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timeout = controller ? setTimeout(function abortProbe() {
      controller.abort();
    }, 25000) : 0;

    if (!url || probedSabrUrls[url]) {
      return;
    }

    probedSabrUrls[url] = true;
    sabrDebug.probes += 1;
    rememberSabrUrl(url);
    sabrDebug.lastProbeStatus = "fetching";

    originalFetch.call(globalThis, url, {
      credentials: "include",
      signal: controller && controller.signal
    }).then(function gotResponse(response) {
      if (!response || !response.ok) {
        sabrDebug.lastProbeStatus = "http " + (response && response.status);
        return;
      }

      return readSabrProbe(response, url).then(function done() {
        sabrDebug.lastProbeStatus = "done";
      });
    }).catch(function failed(error) {
      sabrDebug.lastProbeStatus = "failed";
      sabrDebug.lastError = error && (error.message || String(error));
    }).then(function cleanup() {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
  }

  function scanSabrServerUrls() {
    serverAbrUrlsFromResponses().forEach(rememberSabrUrl);
  }

  function debugAudio() {
    scanSabrServerUrls();

    var responses = playerResponses();
    var video = document.querySelector("video");
    var audioFormats = [];
    var streamingData = responses.map(function summarize(item) {
      var data = item.response && item.response.streamingData || {};

      summarizeFormats(data.adaptiveFormats).forEach(function add(format) {
        audioFormats.push(Object.assign({ source: item.source }, format));
      });

      return {
        source: item.source,
        keys: Object.keys(data).sort(),
        hasServerAbrStreamingUrl: Boolean(data.serverAbrStreamingUrl),
        serverAbrStreamingUrl: data.serverAbrStreamingUrl ? String(data.serverAbrStreamingUrl).slice(0, 180) : "",
        hasHlsManifestUrl: Boolean(data.hlsManifestUrl),
        hasDashManifestUrl: Boolean(data.dashManifestUrl)
      };
    });
    var serverAbrStreamingUrls = serverAbrUrlsFromResponses();
    var report = {
      hookVersion: VERSION,
      hasTimedTextApi: Boolean(timedTextApi()),
      currentSrc: video && video.currentSrc || "",
      streamingData: streamingData,
      serverAbrStreamingUrls: serverAbrStreamingUrls,
      sabrOnly: Boolean(serverAbrStreamingUrls.length),
      sabr: sabrDebug,
      sabrAudio: Array.from(sabrAudio.values()).map(function summarizeEntry(entry) {
        return {
          itag: entry.itag,
          mimeType: entry.mimeType,
          bytes: entry.bytes,
          chunks: entry.chunks.length,
          dispatchedBytes: entry.dispatchedBytes,
          hasInitSeg: entry.hasInitSeg,
          hasMediaSeg: entry.hasMediaSeg
        };
      }),
      audioFormatCount: audioFormats.length,
      directUrlCount: audioFormats.filter(function hasUrl(format) { return format.hasUrl; }).length,
      cipherUrlCount: audioFormats.filter(function hasCipherUrl(format) { return format.hasCipherUrl; }).length,
      cipherSignatureCount: audioFormats.filter(function hasCipherSignature(format) { return format.hasCipherSignature; }).length,
      audioFormats: audioFormats
    };

    if (console && console.log) {
      console.log("[uncensored] audio debug", report);
      if (console.table) {
        console.table(report.streamingData);
        console.table([report.sabr]);
        console.table(report.sabrAudio);
        console.table(report.audioFormats.slice(0, 12));
      }
    }

    return report;
  }

  function debugAudioText() {
    return JSON.stringify(debugAudio(), null, 2);
  }

  globalThis.__uncensoredDebugAudio = debugAudio;
  globalThis.__uncensoredDebugAudioText = debugAudioText;
  globalThis.__uncensoredServerAbrUrls = function serverAbrUrls() {
    return debugAudio().serverAbrStreamingUrls;
  };
  globalThis.__uncensoredProbeSabr = function uncensoredProbeSabr() {
    serverAbrUrlsFromResponses().forEach(probeSabrUrl);
    return debugAudio();
  };
  globalThis.addEventListener("uncensored-probe-sabr", function onProbeSabrRequest() {
    serverAbrUrlsFromResponses().forEach(probeSabrUrl);
  });

  globalThis.fetch = function uncensoredFetch(input, init) {
    var url = requestUrl(input);

    return originalFetch.apply(this, arguments).then(function maybePatch(response) {
      if (isGoogleVideoPlaybackUrl(url)) {
        sabrDebug.fetches += 1;
        rememberSabrUrl(url);
        processSabrResponse(response);
      }

      if (!isTimedTextUrl(input)) {
        return response;
      }

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
    });
  };

  XMLHttpRequest.prototype.open = function uncensoredOpen(method, url) {
    var result;
    var isPlaybackUrl = isGoogleVideoPlaybackUrl(url);

    this.__uncensoredTimedTextUrl = isTimedTextUrl(url);
    this.__uncensoredSabrUrl = isPlaybackUrl;
    result = originalXHROpen.apply(this, arguments);

    if (isPlaybackUrl) {
      rememberSabrUrl(url);
      this.addEventListener("loadend", function onSabrLoadEnd() {
        if (!this.__uncensoredSabrUrl) {
          return;
        }

        sabrDebug.xhrs += 1;
        processSabrXhr(this);
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

  scanSabrServerUrls();
  globalThis.addEventListener("yt-navigate-finish", function onNavigate() {
    sabrAudio.clear();
    probedSabrUrls = Object.create(null);
    sabrCarry = new Uint8Array(0);
    sabrHeaders = Object.create(null);
    sabrDebug = {
      fetches: 0,
      xhrs: 0,
      probes: 0,
      probeBytes: 0,
      responses: 0,
      parsedParts: 0,
      emptyResponses: 0,
      parts: {},
      audioBytes: 0,
      lastItag: 0,
      lastHeaderId: -1,
      firstMediaBytes: "",
      lastUrl: "",
      lastBufferBytes: 0,
      lastPartTypes: [],
      lastProbeStatus: "",
      lastError: ""
    };
    scanSabrServerUrls();
  });
})();
