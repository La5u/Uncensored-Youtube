const assert = require("assert");
const sabr = require("../src/sabr-parser");

function varint(value) {
  const bytes = [];

  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  bytes.push(value);
  return bytes;
}

function part(type, data) {
  return Uint8Array.from(varint(type).concat(varint(data.length), Array.from(data)));
}

function header(fields) {
  return Uint8Array.from([]
    .concat(varint(8), varint(fields.headerId))
    .concat(varint(24), varint(fields.itag))
    .concat(varint(64), varint(fields.isInitSeg ? 1 : 0))
    .concat(varint(88), varint(fields.startMs || 0))
    .concat(varint(96), varint(fields.durationMs || 0)));
}

function concat(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;

  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.length;
  });
  return bytes;
}

const segments = [];
const parser = sabr.createParser({
  onSegment(segment) {
    segments.push(segment);
  }
});

const initHeader = header({ headerId: 1, itag: 140, isInitSeg: true });
const mediaHeader = header({ headerId: 2, itag: 140, startMs: 1200, durationMs: 300 });
const initPayload = concat([
  part(20, initHeader),
  part(21, Uint8Array.from([1, 10, 11]))
]);
const mediaPayload = concat([
  part(20, mediaHeader),
  part(21, Uint8Array.from([2, 20, 21, 22])),
  part(22, Uint8Array.from([2]))
]);
const payload = concat([
  initPayload,
  mediaPayload
]);

parser.push(payload.buffer.slice(0, 7));
parser.push(payload.buffer.slice(7));

assert.strictEqual(segments.length, 1);
assert.strictEqual(segments[0].itag, 140);
assert.strictEqual(segments[0].bytes, 3);
assert.strictEqual(segments[0].header.startMs, 1200);
assert.strictEqual(segments[0].header.durationMs, 300);
assert.deepStrictEqual(Array.from(new Uint8Array(sabr.chunksToArrayBuffer(segments[0].chunks))), [10, 11, 20, 21, 22]);

const left = [];
const right = [];
const leftParser = sabr.createParser({ onSegment: (segment) => left.push(segment) });
const rightParser = sabr.createParser({ onSegment: (segment) => right.push(segment) });

leftParser.push(payload.buffer.slice(0, 12));
rightParser.push(payload.buffer);
leftParser.push(payload.buffer.slice(12));

assert.strictEqual(left.length, 1);
assert.strictEqual(right.length, 1);
assert.deepStrictEqual(Array.from(new Uint8Array(sabr.chunksToArrayBuffer(left[0].chunks))), [10, 11, 20, 21, 22]);
assert.deepStrictEqual(Array.from(new Uint8Array(sabr.chunksToArrayBuffer(right[0].chunks))), [10, 11, 20, 21, 22]);

const longSegments = [];
const longParser = sabr.createParser({ onSegment: (segment) => longSegments.push(segment) });
const tenHoursMs = 10 * 60 * 60 * 1000;
longParser.push(initPayload.buffer);
longParser.push(concat([
  part(20, header({ headerId: 3, itag: 140, startMs: tenHoursMs, durationMs: 10000 })),
  part(21, Uint8Array.from([3, 30, 31])),
  part(22, Uint8Array.from([3]))
]).buffer);
assert.strictEqual(longSegments.length, 1);
assert.strictEqual(longSegments[0].header.startMs, tenHoursMs);

const unknownItagSegments = [];
const unknownItagParser = sabr.createParser({ onSegment: (segment) => unknownItagSegments.push(segment) });
unknownItagParser.push(concat([
  part(20, header({ headerId: 4, itag: 999, startMs: 2000, durationMs: 10000 })),
  part(21, Uint8Array.from([4, 40, 41])),
  part(22, Uint8Array.from([4]))
]).buffer);
assert.strictEqual(unknownItagSegments.length, 1);
assert.strictEqual(unknownItagSegments[0].itag, 999);

const flushedSegments = [];
const flushParser = sabr.createParser({ onSegment: (segment) => flushedSegments.push(segment) });
flushParser.push(concat([
  part(20, header({ headerId: 5, itag: 140, startMs: 3000, durationMs: 10000 })),
  part(21, Uint8Array.from([5, 50, 51]))
]).buffer);
assert.strictEqual(flushedSegments.length, 0);
flushParser.flush();
assert.strictEqual(flushedSegments.length, 1);
assert.deepStrictEqual(Array.from(flushedSegments[0].chunks[0]), [50, 51]);

const streamDecoder = sabr.createStreamDecoder();
const webmInit = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from("A_OPUS")]);
const decoderInit = concat([
  part(20, initHeader),
  part(21, concat([Uint8Array.from([1]), webmInit]))
]);
streamDecoder.push({ type: "start", streamId: 1 });
assert.deepStrictEqual(streamDecoder.push({ type: "chunk", streamId: 1, buffer: decoderInit.buffer }), []);
const decoded = streamDecoder.push({ type: "chunk", streamId: 1, buffer: mediaPayload.buffer });
assert.strictEqual(decoded.length, 1);
assert.strictEqual(decoded[0].startMs, 1200);
assert.strictEqual(decoded[0].durationMs, 300);
assert.deepStrictEqual(Array.from(new Uint8Array(decoded[0].buffer)), [...webmInit, 20, 21, 22]);

const splitInitDecoder = sabr.createStreamDecoder();
const splitWebmHeader = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);
const splitCodec = Uint8Array.from(Buffer.from("A_OPUS"));
const splitInitPayload = concat([
  part(20, header({ headerId: 6, itag: 140, isInitSeg: true })),
  part(21, concat([Uint8Array.from([6]), splitWebmHeader])),
  part(20, header({ headerId: 7, itag: 140, isInitSeg: true })),
  part(21, concat([Uint8Array.from([7]), splitCodec]))
]);
splitInitDecoder.push({ type: "start", streamId: 2 });
splitInitDecoder.push({ type: "chunk", streamId: 2, buffer: splitInitPayload.buffer });
const splitDecoded = splitInitDecoder.push({ type: "chunk", streamId: 2, buffer: mediaPayload.buffer });
assert.deepStrictEqual(
  Array.from(new Uint8Array(splitDecoded[0].buffer)),
  [...splitWebmHeader, ...splitCodec, 20, 21, 22]
);

const overflowDecoder = sabr.createStreamDecoder();
overflowDecoder.push({ type: "start", streamId: 1 });
overflowDecoder.push({ type: "chunk", streamId: 1, buffer: decoderInit.buffer.slice(0, 7) });
for (let streamId = 2; streamId <= 9; streamId += 1) {
  overflowDecoder.push({ type: "start", streamId });
}
overflowDecoder.push({ type: "chunk", streamId: 1, buffer: decoderInit.buffer.slice(7) });
const overflowDecoded = overflowDecoder.push({ type: "chunk", streamId: 1, buffer: mediaPayload.buffer });
assert.strictEqual(overflowDecoded.length, 1);
overflowDecoder.push({ type: "end", streamId: 2 });
assert.deepStrictEqual(
  overflowDecoder.push({ type: "chunk", streamId: 9, buffer: concat([decoderInit, mediaPayload]).buffer }),
  []
);

streamDecoder.push({ type: "end", streamId: 1 });
streamDecoder.reset();
const resumed = streamDecoder.push({ type: "chunk", streamId: 1, buffer: mediaPayload.buffer });
assert.strictEqual(resumed.length, 1);
assert.deepStrictEqual(Array.from(new Uint8Array(resumed[0].buffer)), [...webmInit, 20, 21, 22]);

console.log("sabr-parser.test.js passed");
