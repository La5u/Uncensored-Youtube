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

const invalidSegments = [];
const invalidParser = sabr.createParser({ onSegment: (segment) => invalidSegments.push(segment) });

assert.strictEqual(invalidParser.push(Uint8Array.from([20, 255, 255, 255, 255, 255]).buffer), false);
assert.strictEqual(invalidParser.push(payload.buffer), true);

assert.strictEqual(invalidSegments.length, 1);

const preservedInitSegments = [];
const preservedInitParser = sabr.createParser({ onSegment: (segment) => preservedInitSegments.push(segment) });

preservedInitParser.push(initPayload.buffer);
assert.strictEqual(preservedInitParser.push(Uint8Array.from([20, 255, 255, 255, 255, 255]).buffer), false);
preservedInitParser.push(mediaPayload.buffer);

assert.strictEqual(preservedInitSegments.length, 1);
assert.deepStrictEqual(Array.from(new Uint8Array(sabr.chunksToArrayBuffer(preservedInitSegments[0].chunks))), [10, 11, 20, 21, 22]);

const partialSegments = [];
const partialParser = sabr.createParser({ onSegment: (segment) => partialSegments.push(segment) });
const partial = new Uint8Array(300000);
let partialStopped = false;

partial.fill(255);

for (let index = 0; index < 8; index += 1) {
  const keepGoing = partialParser.push(partial.buffer);
  if (!keepGoing) {
    partialStopped = true;
    break;
  }
}

assert.strictEqual(partialStopped, true);
assert.strictEqual(partialSegments.length, 0);

console.log("sabr-parser.test.js passed");
