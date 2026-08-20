(function buildSabrParser() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;

  var MAX_CARRY_BYTES = 1024 * 1024;
  var MAX_PART_BYTES = 2 * 1024 * 1024;

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
      value = (first & 0x07) * Math.pow(2, 32) +
        bytes[offset + 1] + 256 * (bytes[offset + 2] + 256 * (bytes[offset + 3] + 256 * bytes[offset + 4]));
    }

    return {
      value: value,
      offset: offset + length
    };
  }

  function parseUmpParts(bytes) {
    var offset = 0;
    var parts = [];
    var invalid = false;

    while (offset < bytes.length) {
      var type = readUmpVarint(bytes, offset);
      var size;
      var dataStart;

      if (!type) {
        return { parts: parts, offset: offset, invalid: invalid };
      }

      size = readUmpVarint(bytes, type.offset);
      if (!size) {
        return { parts: parts, offset: offset, invalid: invalid };
      }

      if (size.value > MAX_PART_BYTES) {
        return { parts: parts, offset: offset, invalid: true };
      }

      dataStart = size.offset;
      if (dataStart + size.value > bytes.length) {
        return { parts: parts, offset: offset, invalid: invalid };
      }

      parts.push({
        type: type.value,
        data: bytes.subarray(dataStart, dataStart + size.value)
      });
      offset = dataStart + size.value;
    }

    return { parts: parts, offset: offset, invalid: invalid };
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
        if (field === 1) {
          header.headerId = value.value;
        } else if (field === 3) {
          header.itag = value.value;
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

  function createParser(options) {
    var carry = new Uint8Array(0);
    var headers = Object.create(null);
    var audio = new Map();
    var onSegment = options && options.onSegment;
    var onInitSegment = options && options.onInitSegment;

    function resetState() {
      carry = new Uint8Array(0);
      headers = Object.create(null);
      audio.clear();
    }

    function resetScratch() {
      carry = new Uint8Array(0);
      headers = Object.create(null);
    }

    function appendAudioChunk(header, chunk) {
      var key = String(header.itag);
      var entry;
      var segment;

      if (!header.itag || !chunk.length) {
        return;
      }

      entry = audio.get(key);
      if (!entry) {
        entry = {
          itag: header.itag,
          initChunks: [],
          activeSegments: Object.create(null)
        };
        audio.set(key, entry);
      }

      if (header.isInitSeg) {
        entry.initChunks.push(chunk);
        if (onInitSegment) {
          onInitSegment(header.itag, chunk);
        }
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

    function finalizeSegment(headerId) {
      var header = headers[headerId];
      var entry = audio.get(String(header && header.itag));
      var segment = entry && entry.activeSegments[String(headerId)];
      var chunks;

      if (!segment || !segment.chunks.length) {
        return;
      }

      delete entry.activeSegments[String(headerId)];
      chunks = entry.initChunks.concat(segment.chunks);
      if (onSegment) {
        onSegment({
          itag: segment.header.itag,
          header: segment.header,
          bytes: segment.bytes,
          chunks: chunks
        });
      }
    }

    return {
      push: function push(buffer) {
        var bytes;
        var combined;
        var parsed;

        if (!buffer) {
          return true;
        }

        bytes = new Uint8Array(buffer);
        combined = new Uint8Array(carry.length + bytes.length);
        combined.set(carry, 0);
        combined.set(bytes, carry.length);
        parsed = parseUmpParts(combined);
        if (parsed.invalid) {
          resetScratch();
          return false;
        }
        carry = combined.slice(parsed.offset);
        if (carry.length > MAX_CARRY_BYTES) {
          resetScratch();
          return false;
        }
        parsed.parts.forEach(function handlePart(part) {
          var headerId;
          var header;

          if (part.type === 20) {
            header = parseMediaHeader(part.data);
            if (header.headerId !== undefined) {
              headers[header.headerId] = header;
            }
          } else if (part.type === 21 && part.data.length) {
            headerId = readUmpVarint(part.data, 0);
            if (headerId && headers[headerId.value]) {
              appendAudioChunk(headers[headerId.value], part.data.slice(headerId.offset));
            }
          } else if (part.type === 22) {
            headerId = readUmpVarint(part.data, 0);
            if (headerId) {
              finalizeSegment(headerId.value);
              delete headers[headerId.value];
            }
          }
        });
        return true;
      },
      flush: function flush() {
        Object.keys(headers).forEach(finalizeSegment);
        carry = new Uint8Array(0);
      },
      reset: function reset() {
        resetState();
      }
    };
  }

  function hasWebmHeader(chunks) {
    var chunk = chunks && chunks[0];

    return chunk && chunk.length >= 4 &&
      chunk[0] === 0x1a && chunk[1] === 0x45 &&
      chunk[2] === 0xdf && chunk[3] === 0xa3;
  }

  function hasAudioCodec(chunks) {
    var bytes = new Uint8Array(chunksToArrayBuffer(chunks || []));
    var text = new TextDecoder("latin1").decode(bytes);

    return text.indexOf("A_OPUS") !== -1 || text.indexOf("A_VORBIS") !== -1;
  }

  function createStreamDecoder() {
    var PARSER_LIMIT = 8;
    var parsers = new Map();
    var ignoredStreams = new Set();
    var initByItag = new Map();

    function completeInitFor(state, itag) {
      var key = String(itag);
      var pending = state.pending.get(key);

      if (hasWebmHeader(pending)) {
        initByItag.set(key, pending);
        return pending;
      }

      return pending || initByItag.get(key);
    }

    function parserFor(streamId) {
      if (parsers.size >= PARSER_LIMIT) {
        ignoredStreams.add(streamId);
        return null;
      }
      var state = { pending: new Map(), segments: [] };

      state.parser = createParser({
        onInitSegment: function rememberInit(itag, chunk) {
          var key = String(itag);
          var chunks = state.pending.get(key) || [];
          chunks.push(chunk.slice());
          state.pending.set(key, chunks);
        },
        onSegment: function emitSegment(segment) {
          var chunks = segment.chunks;
          var init = completeInitFor(state, segment.itag);

          if (!hasAudioCodec(init)) return;
          if (!hasWebmHeader(chunks)) chunks = init.concat(chunks);
          if (!hasWebmHeader(chunks)) return;

          state.segments.push({
            startMs: typeof segment.header.startMs === "number" ? segment.header.startMs : null,
            durationMs: typeof segment.header.durationMs === "number" ? segment.header.durationMs : null,
            buffer: chunksToArrayBuffer(chunks)
          });
        }
      });

      parsers.set(streamId, state);
      return state;
    }

    return {
      push: function push(message) {
        var state;

        if (message.type === "start") {
          parsers.delete(message.streamId);
          ignoredStreams.delete(message.streamId);
          state = parserFor(message.streamId);
        } else if (message.type === "chunk" && message.buffer) {
          if (!ignoredStreams.has(message.streamId)) {
            state = parsers.get(message.streamId) || parserFor(message.streamId);
            if (state) state.parser.push(message.buffer);
          }
        } else if (message.type === "end") {
          ignoredStreams.delete(message.streamId);
          state = parsers.get(message.streamId);
          if (state) {
            state.parser.flush();
            state.pending.forEach(function publishInit(chunks, itag) {
              completeInitFor(state, itag);
            });
            parsers.delete(message.streamId);
          }
        }

        if (!state) return [];
        var segments = state.segments;
        state.segments = [];
        return segments;
      },
      reset: function reset() {
        parsers.clear();
        ignoredStreams.clear();
      }
    };
  }

  var exports = Object.freeze({
    createParser: createParser,
    createStreamDecoder: createStreamDecoder,
    chunksToArrayBuffer: chunksToArrayBuffer
  });

  root.UncensoredSabrParser = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
