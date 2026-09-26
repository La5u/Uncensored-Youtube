'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { analyze, WINDOW } = require('../tools/analyze-deepgram-audio-review');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

test('scores swear annotations against local first choice and nearest timed DG allowed word', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepgram-human-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const whisperFile = path.join(dir, 'whisper.json');
  const triageFile = path.join(dir, 'triage.json');
  const reviewFile = path.join(dir, 'review.json');
  const output = path.join(dir, 'out.json');
  const slot = { name: 'fixture', results: [{ tokenIndex: 3, timeSeconds: 10, classification: 'missed' }] };
  fs.writeFileSync(whisperFile, JSON.stringify({ fixtures: [slot] }));
  fs.writeFileSync(triageFile, JSON.stringify({ items: { dg: { fixture: 'fixture', tokenIndex: 3, timeSeconds: 10,
    category: 'missed-or-different-swear', creator: 'creator', deepgramWords: [
      { word: 'fuck', start: 4.8, end: 5.2 }, { word: 'shit', start: 5.4, end: 5.6 }, { word: 'hello', start: 5, end: 5.1 }
    ] } } }));
  const triageRaw = fs.readFileSync(triageFile), whisperRaw = fs.readFileSync(whisperFile);
  fs.writeFileSync(reviewFile, JSON.stringify({ sources: {
    deepgramTriage: { sha256: `sha256:${hash(triageRaw)}` }, whisper: { path: whisperFile, sha256: `sha256:${hash(whisperRaw)}` }
  }, items: [
    { id: 'fixture:3', fixture: 'fixture', tokenIndex: 3, timeSeconds: 10, clipStart: 5, context: '[__]',
      whisper: { word: 'shit' }, annotation: { status: 'swear', word: 'fuck' } },
    { id: 'negative', annotation: { status: 'no-swear-in-audio' } },
    { id: 'pending', annotation: { status: 'pending' } }
  ] }));
  const result = analyze({ reviewFile, triageFile, whisperFile, output });
  assert.equal(WINDOW, 1.25);
  assert.equal(result.counts.swearLabels, 1);
  assert.equal(result.counts.aligned, 1);
  assert.equal(result.deepgram.all.correct, 1);
  assert.equal(result.localWhisper.all.correct, 0);
  assert.equal(result.results[0].deepgram.word, 'fuck');
  assert.equal(result.results[0].classification, 'missed');
  assert.equal(result.counts.negativeLabels['no-swear-in-audio'], 1);
  assert.equal(result.counts.pending, 1);
  assert.match(result.caveat, /Caption timestamp proxy not human timestamp/);
  assert.equal(JSON.parse(fs.readFileSync(output)).results.length, 1);
});

test('rejects stale source SHA', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepgram-human-sha-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const triageFile = path.join(dir, 'triage.json');
  const whisperFile = path.join(dir, 'whisper.json');
  const reviewFile = path.join(dir, 'review.json');
  fs.writeFileSync(triageFile, '{}');
  fs.writeFileSync(whisperFile, '{}');
  fs.writeFileSync(reviewFile, JSON.stringify({ sources: {
    deepgramTriage: { sha256: 'sha256:bad' }, whisper: { path: whisperFile, sha256: `sha256:${hash(fs.readFileSync(whisperFile))}` }
  }, items: [] }));
  assert.throws(() => analyze({ reviewFile, triageFile, whisperFile, output: path.join(dir, 'out.json') }), /deepgramTriage source SHA mismatch/);
});
