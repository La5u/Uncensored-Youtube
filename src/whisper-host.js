(function runWhisperHost(root) {
  "use strict";

  var runtime = root.browser || root.chrome;
  var rules = root.UncensoredRules;
  var worker = null;
  var pending = new Map();
  var nextInternalId = 1000000;
  var audioContext = null;
  var activeVideoId = "";
  var activeChunkStreamId = 0;
  var audioSegments = [];
  var tokenQueue = new Map();
  var activeTranscribes = 0;
  var transcribeScheduled = false;
  var sabrCarry = new Uint8Array(0);
  var sabrHeaders = Object.create(null);
  var sabrAudio = new Map();
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
  var SLICE_BEFORE_SECONDS = 1.25;
  var SLICE_AFTER_SECONDS = 1.25;
  var TARGET_SAMPLE_RATE = 16000;
  var CLEAR_WHISPER_SCORE = 10;
  var MAX_ACTIVE_TRANSCRIBES = 2;
  var MAX_SEGMENTS = 18;

  function workerUrl() {
    return runtime && runtime.runtime && runtime.runtime.getURL
      ? runtime.runtime.getURL("src/whisper-module-worker.js")
      : "whisper-module-worker.js";
  }

  function postToParent(payload) {
    root.parent.postMessage(Object.assign({
      uncensoredWhisperHost: true
    }, payload), "*");
  }

  function postStatus(message) {
    postToParent({
      type: "status",
      ok: true,
      message: message
    });
  }

  function rejectAll(message) {
    pending.forEach(function rejectPending(record, id) {
      if (record && record.reject) {
        record.reject(new Error(message));
      } else {
        postToParent({
          id: id,
          ok: false,
          error: message
        });
      }
    });
    pending.clear();
  }

  function ensureWorker() {
    if (worker) {
      return worker;
    }

    worker = new Worker(workerUrl(), {
      type: "module"
    });
    postStatus("worker created");
    worker.onmessage = function onWorkerMessage(event) {
      var message = event.data || {};
      var record = pending.get(message.id);

      pending.delete(message.id);
      if (record && record.resolve) {
        if (message.ok) {
          record.resolve(message.decision || message);
        } else {
          record.reject(new Error(message.error || "Whisper worker failed"));
        }
        return;
      }

      postToParent(message);
    };
    worker.onerror = function onWorkerError(error) {
      var message = error && error.message ? error.message : "Whisper host worker error";

      postStatus(message);
      rejectAll(message);
      try {
        worker.terminate();
      } catch (terminateError) {}
      worker = null;
    };

    return worker;
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

  function appendAudioChunk(header, chunk) {
    var key = String(header.itag || 0);
    var entry;
    var segmentKey;
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

    segmentKey = String(header.headerId);
    segment = entry.activeSegments[segmentKey];
    if (!segment) {
      segment = {
        header: header,
        chunks: [],
        bytes: 0
      };
      entry.activeSegments[segmentKey] = segment;
    }
    segment.chunks.push(chunk);
    segment.bytes += chunk.length;
  }

  function chunksToArrayBuffer(chunks) {
    var length = chunks.reduce(function sum(total, chunk) {
      return total + chunk.length;
    }, 0);
    var bytes = new Uint8Array(length);
    var offset = 0;

    chunks.forEach(function copy(chunk) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    });

    return bytes.buffer;
  }

  function rememberDecodedSegment(header, encodedBytes, buffer) {
    var startTime = typeof header.startMs === "number" ? header.startMs / 1000 : 0;
    var segment = {
      startTime: startTime,
      endTime: startTime + buffer.duration,
      buffer: buffer,
      bytes: encodedBytes
    };
    var duplicate = audioSegments.some(function sameSegment(existing) {
      return Math.abs(existing.startTime - segment.startTime) < 0.01 &&
        Math.abs(existing.endTime - segment.endTime) < 0.01;
    });

    if (duplicate) {
      return;
    }

    audioSegments.push(segment);
    audioSegments.sort(function sortSegments(left, right) {
      return left.startTime - right.startTime;
    });
    while (audioSegments.length > MAX_SEGMENTS) {
      audioSegments.shift();
    }
    scheduleTranscribeQueue();
  }

  function finalizeAudioSegment(headerId) {
    var header = sabrHeaders[headerId];
    var key = String(header && header.itag || 0);
    var entry = sabrAudio.get(key);
    var segment = entry && entry.activeSegments && entry.activeSegments[String(headerId)];
    var chunks;
    var encoded;

    if (!entry || !entry.initChunks.length || !segment || !segment.chunks.length) {
      return;
    }

    delete entry.activeSegments[String(headerId)];
    chunks = entry.initChunks.concat(segment.chunks);
    encoded = chunksToArrayBuffer(chunks);
    currentAudioContext().then(function decode(context) {
      return context.decodeAudioData(encoded.slice(0));
    }).then(function decoded(buffer) {
      rememberDecodedSegment(segment.header || header || {}, encoded.byteLength, buffer);
    }, function failed(error) {
      postStatus("audio decode failed: " + (error && (error.message || String(error))));
    });
  }

  function processSabrBuffer(buffer) {
    var bytes = new Uint8Array(buffer);
    var combined = new Uint8Array(sabrCarry.length + bytes.length);
    var parsed;

    combined.set(sabrCarry, 0);
    combined.set(bytes, sabrCarry.length);
    parsed = parseUmpParts(combined);
    sabrCarry = combined.slice(parsed.offset);

    parsed.parts.forEach(function handlePart(part) {
      var headerId;

      if (part.type === 20) {
        var header = parseMediaHeader(part.data);
        if (header.headerId !== undefined) {
          sabrHeaders[header.headerId] = header;
        }
      } else if (part.type === 21 && part.data.length) {
        headerId = readSabrHeaderId(part.data);
        if (!headerId) {
          return;
        }
        if (sabrHeaders[headerId.value]) {
          appendAudioChunk(sabrHeaders[headerId.value], part.data.slice(headerId.offset));
        }
      } else if (part.type === 22) {
        headerId = readSabrHeaderId(part.data);
        if (!headerId) {
          return;
        }
        finalizeAudioSegment(headerId.value);
        delete sabrHeaders[headerId.value];
      }
    });
  }

  function resetStreamParser() {
    activeChunkStreamId = 0;
    sabrCarry = new Uint8Array(0);
    sabrHeaders = Object.create(null);
    sabrAudio.clear();
  }

  function resetAudioState(videoId) {
    activeVideoId = videoId || "";
    audioSegments = [];
    tokenQueue.clear();
    resetStreamParser();
  }

  function startAudioChunkStream(streamId, videoId, url) {
    if (!streamId) {
      return;
    }

    if (videoId && activeVideoId && activeVideoId !== videoId) {
      resetAudioState(videoId);
    } else if (videoId && !activeVideoId) {
      activeVideoId = videoId;
    }

    resetStreamParser();
    activeChunkStreamId = streamId;
  }

  function appendAudioStreamChunk(streamId, buffer) {
    if (!buffer || !streamId || activeChunkStreamId !== streamId) {
      return;
    }

    processSabrBuffer(buffer);
  }

  function endAudioChunkStream(streamId, error) {
    if (!streamId || activeChunkStreamId !== streamId) {
      return;
    }

    if (error) {
      postStatus("audio stream failed: " + error);
    }
    activeChunkStreamId = 0;
  }

  function normalizeContext(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\[\s*__\s*\]/gu, rules ? rules.CENSORED_TOKEN : "[__]")
      .replace(/[^a-z0-9_\[\]\s']+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenKey(token) {
    return Math.round((token.timeSeconds || 0) * 10) + "\n" + normalizeContext(token.context);
  }

  function rememberTokens(tokens, options) {
    (tokens || []).forEach(function remember(token) {
      if (!token || typeof token.timeSeconds !== "number") {
        return;
      }

      token.hostOptions = options || {};
      tokenQueue.set(tokenKey(token), token);
    });
    scheduleTranscribeQueue();
  }

  function segmentForToken(token) {
    return audioSegments.find(function findSegment(segment) {
      return token.timeSeconds >= segment.startTime - SLICE_BEFORE_SECONDS &&
        token.timeSeconds <= segment.endTime;
    }) || null;
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

    for (channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      var channel = buffer.getChannelData(channelIndex);

      for (sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
        output[sampleIndex] += channel[startSample + sampleIndex] / channels;
      }
    }

    return output;
  }

  function resampleLinear(input, sourceRate, targetRate) {
    var outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate));
    var output = new Float32Array(outputLength);
    var ratio = sourceRate / targetRate;
    var index;

    if (!input || !input.length || sourceRate === targetRate) {
      return input || new Float32Array(0);
    }

    for (index = 0; index < outputLength; index += 1) {
      var position = index * ratio;
      var leftIndex = Math.floor(position);
      var rightIndex = Math.min(leftIndex + 1, input.length - 1);
      var weight = position - leftIndex;

      output[index] = input[leftIndex] * (1 - weight) + input[rightIndex] * weight;
    }

    return output;
  }

  function candidatesForToken(token) {
    var seen = Object.create(null);
    var candidates = [];
    var tokenCandidates = token.hostOptions && token.hostOptions.rulesEnabled === false ? [] : token.candidates || [];

    tokenCandidates.concat(rules && rules.ALLOWED_WORDS || []).forEach(function add(candidate) {
      if (candidate && !seen[candidate]) {
        seen[candidate] = true;
        candidates.push(candidate);
      }
    });

    return candidates;
  }

  function whisperRejectionReason(token, decision) {
    if (!decision || !decision.word) {
      return "no word";
    }

    if (token.hostOptions && token.hostOptions.rulesEnabled === false) {
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

  function transcribePcm(pcm, token) {
    var id = nextInternalId;

    nextInternalId += 1;
    return new Promise(function wait(resolve, reject) {
      var audio = pcm.slice();

      pending.set(id, {
        resolve: resolve,
        reject: reject
      });
      ensureWorker().postMessage({
        id: id,
        type: "transcribe",
        audio: audio.buffer,
        candidates: candidatesForToken(token),
        context: token.context,
        options: {
          force: !token.deterministicWord || !(token.hostOptions && token.hostOptions.rulesEnabled !== false)
        }
      }, [audio.buffer]);
    });
  }

  function scheduleTranscribeQueue() {
    if (transcribeScheduled) {
      return;
    }

    transcribeScheduled = true;
    root.setTimeout(processTranscribeQueue, 0);
  }

  function processTranscribeQueue() {
    var selectedKey = "";
    var selectedToken = null;
    var selectedSegment = null;

    transcribeScheduled = false;
    if (activeTranscribes >= MAX_ACTIVE_TRANSCRIBES || !tokenQueue.size || !audioSegments.length) {
      return;
    }

    tokenQueue.forEach(function findReady(token, key) {
      var segment;

      if (selectedToken || token.resolving || token.resolved) {
        return;
      }

      segment = segmentForToken(token);
      if (segment) {
        selectedKey = key;
        selectedToken = token;
        selectedSegment = segment;
      }
    });

    if (!selectedToken) {
      return;
    }

    selectedToken.resolving = true;
    activeTranscribes += 1;
    (function transcribeSelected(token, key, segment) {
      var startTime = Math.max(segment.startTime, token.timeSeconds - SLICE_BEFORE_SECONDS) - segment.startTime;
      var endTime = Math.min(segment.endTime, token.timeSeconds + SLICE_AFTER_SECONDS) - segment.startTime;
      var sourcePcm = readMediaSlice(segment.buffer, startTime, endTime);
      var pcm = resampleLinear(sourcePcm, segment.buffer.sampleRate, TARGET_SAMPLE_RATE);

      transcribePcm(pcm, token).then(function resolved(decision) {
        var rejectionReason = whisperRejectionReason(token, decision);

        if (!rejectionReason) {
          token.resolved = true;
          tokenQueue.delete(key);
          postToParent({
            type: "audio-resolution",
            ok: true,
            resolution: {
              videoId: activeVideoId,
              token: token,
              word: decision.word,
              score: decision.score,
              runnerUpScore: decision.runnerUpScore,
              transcript: decision.transcript,
              forced: decision.forced
            }
          });
        }
      }).catch(function failed(error) {
        postStatus("audio transcribe failed: " + (error && (error.message || String(error))));
      }).finally(function done() {
        activeTranscribes -= 1;
        token.resolving = false;
        scheduleTranscribeQueue();
      });
    })(selectedToken, selectedKey, selectedSegment);
    if (activeTranscribes < MAX_ACTIVE_TRANSCRIBES) {
      scheduleTranscribeQueue();
    }
  }

  function forwardWorkerRequest(message) {
    pending.set(message.id, {});
    ensureWorker().postMessage({
      id: message.id,
      type: message.type,
      audio: message.audio,
      candidates: message.candidates,
      context: message.context,
      options: message.options
    }, message.audio ? [message.audio] : []);
  }

  root.addEventListener("message", function onParentMessage(event) {
    var message = event.data || {};

    if (!message.uncensoredWhisperHostRequest) {
      return;
    }

    try {
      if (message.type === "start-audio-chunk-stream") {
        startAudioChunkStream(message.streamId, message.videoId, message.url);
        return;
      }

      if (message.type === "audio-stream-chunk") {
        appendAudioStreamChunk(message.streamId, message.buffer);
        return;
      }

      if (message.type === "end-audio-chunk-stream") {
        endAudioChunkStream(message.streamId, message.error || "");
        return;
      }

      if (!message.id) {
        return;
      }

      postStatus("request " + message.type);
      if (message.type === "remember-audio-tokens") {
        rememberTokens(message.tokens, message.options);
        postToParent({
          id: message.id,
          ok: true,
          remembered: true
        });
        return;
      }

      forwardWorkerRequest(message);
    } catch (error) {
      pending.delete(message.id);
      postToParent({
        id: message.id,
        ok: false,
        error: error && (error.message || String(error))
      });
    }
  });

  postToParent({
    type: "ready",
    ok: true
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
