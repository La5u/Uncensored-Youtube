'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectItems, run, ENDPOINT, MAX_REQUESTS } = require('../tools/deepgram-triage');

function report() {
  const fixtures = [];
  for (let c = 0; c < 4; c++) {
    const results = [];
    for (let i = 0; i < 5; i++) results.push({ tokenIndex: i, timeSeconds: i * 12, classification: i === 0 ? 'missed' : i === 1 ? 'different-swear' : i === 2 ? 'recognized-wrong-slot' : i === 3 ? 'unscored' : 'correct-exact', correct: i === 4, attempted: i !== 3, word: 'fuck', transcript: 'local words', expected: ['fuck'], recognizedWords: ['fucking'], nearTranscription: i === 2 ? 'near' : null });
    fixtures.push({ name: `f${c}`, creator: `creator${c}`, creatorId: `id${c}`, pairClass: 'manual-auto', audio: `/audio/${c}.m4a`, contentFingerprint: `fp${c}`, results });
  }
  return { complete: true, mode: 'whisper-only', summary: { pairClasses: { 'manual-auto': {} } }, rulesFingerprint: 'rules-fp', decisionFingerprint: 'decision-fp', audioWindowKey: 'shift=0', fixtures };
}

test('selection prioritizes failure classes, balances creators, and keeps review separate', () => {
  const selected = selectItems(report(), { limit: 20, audioExists: () => true });
  assert.equal(selected.length, 15);
  assert.equal(selected.filter(x => x.category === 'unscored-review').length, 1);
  assert.equal(selected.filter(x => x.category === 'control').length, 2);
  assert.ok(selected.slice(0, 12).every(x => x.category !== 'control' && x.category !== 'unscored-review'));
  const counts = selected.reduce((m, x) => m.set(x.creator, (m.get(x.creator) || 0) + 1), new Map());
  assert.ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1);
  assert.equal(selectItems(report(), { limit: MAX_REQUESTS + 10, audioExists: () => true }).length, 20);
  assert.equal(selectItems(report(), { limit: 10, audioExists: () => false }).length, 0);
});

test('run resumes completed items and stores mocked Deepgram response without credentials', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-triage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportFile = path.join(dir, 'report.json');
  const output = path.join(dir, 'tmp', 'snapshot.json');
  const data = report();
  fs.writeFileSync(reportFile, JSON.stringify(data));
  process.env.DEEPGRAM_API_KEY = 'mock-secret';
  t.after(() => { delete process.env.DEEPGRAM_API_KEY; });
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests++;
    assert.equal(url, ENDPOINT);
    assert.equal(options.headers.Authorization, 'Token mock-secret');
    return { ok: true, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'heard it', words: [{ word: 'heard', start: 0.1, end: 0.5, confidence: 0.99 }] }] }] } }) };
  };
  const audioToWav = () => Buffer.from('wav');
  const first = await run({ reportFile, output, limit: 2, fetchImpl, audioToWav, audioExists: () => true });
  assert.equal(first.selected, 2);
  assert.equal(requests, 2);
  const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(JSON.stringify(saved).includes('mock-secret'), false);
  assert.equal(Object.values(saved.items)[0].deepgramTranscript, 'heard it');
  requests = 0;
  await run({ reportFile, output, limit: 2, fetchImpl, audioToWav, audioExists: () => true });
  assert.equal(requests, 0);
});
