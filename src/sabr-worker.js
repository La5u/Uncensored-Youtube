importScripts("sabr-parser.js");

(function runSabrWorker(root) {
  "use strict";

  var sabr = root.UncensoredSabrParser;
  var parsers = new Map();
  var initByItag = new Map();

  function hasWebmHeader(chunks) {
    var chunk = chunks && chunks[0];

    return chunk && chunk.length >= 4 &&
      chunk[0] === 0x1a && chunk[1] === 0x45 &&
      chunk[2] === 0xdf && chunk[3] === 0xa3;
  }

  function hasAudioCodec(chunks) {
    var bytes = new Uint8Array(sabr.chunksToArrayBuffer(chunks || []));
    var text = new TextDecoder("latin1").decode(bytes);

    return text.indexOf("A_OPUS") !== -1 || text.indexOf("A_VORBIS") !== -1;
  }

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
    var state = { pending: new Map(), segments: [] };

    state.parser = sabr.createParser({
      onInitSegment: function rememberInit(itag, chunk) {
        var key = String(itag);
        var chunks = state.pending.get(key) || [];
        chunks.push(chunk.slice());
        state.pending.set(key, chunks);
      },
      onSegment: function emitSegment(segment) {
        var chunks = segment.chunks;
        var init = completeInitFor(state, segment.itag);

        if (!hasAudioCodec(init)) {
          return;
        }
        if (!hasWebmHeader(chunks)) {
          chunks = init.concat(chunks);
        }
        if (!hasWebmHeader(chunks)) {
          return;
        }

        var buffer = sabr.chunksToArrayBuffer(chunks);
        state.segments.push({
          itag: segment.itag,
          bytes: segment.bytes,
          startMs: typeof segment.header.startMs === "number" ? segment.header.startMs : null,
          buffer: buffer
        });
      }
    });

    parsers.set(streamId, state);
    return state;
  }

  root.onmessage = function onAudioMessage(event) {
    var message = event.data || {};
    var state;
    var segments;

    if (message.type === "start") {
      parsers.delete(message.streamId);
      parserFor(message.streamId);
    } else if (message.type === "chunk" && message.buffer) {
      state = parsers.get(message.streamId) || parserFor(message.streamId);
      state.segments.length = 0;
      state.parser.push(message.buffer);
    } else if (message.type === "end") {
      state = parsers.get(message.streamId);
      if (state) {
        state.parser.flush();
        state.pending.forEach(function publishInit(chunks, itag) {
          completeInitFor(state, itag);
        });
      }
      parsers.delete(message.streamId);
    }

    state = state || parsers.get(message.streamId);
    segments = state ? state.segments : [];
    root.postMessage({
      id: message.id,
      segments: segments
    }, segments.map(function transferSegment(segment) {
      return segment.buffer;
    }));
    if (state) {
      state.segments.length = 0;
    }
  };
})(globalThis);
