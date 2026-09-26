#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const evaluator = require('./evaluate-whisper-only');
const rules = require('../src/rules');

const REVIEW = 'tmp/deepgram-audio-review.json';
const TRIAGE = 'tmp/deepgram-triage.json';
const OUTPUT = 'tmp/deepgram-human-comparison.json';
const WINDOW = 1.25;
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6;

function verifySource(review, key, file) {
  const raw = fs.readFileSync(file);
  const expected = review.sources?.[key]?.sha256?.replace(/^sha256:/, '');
  if (!expected || sha256(raw) !== expected) throw new Error(`${key} source SHA mismatch`);
  return JSON.parse(raw);
}

function matchingSlot(records, item) {
  return records.find(x => x.name === item.fixture)?.results?.find(x => x.tokenIndex === item.tokenIndex);
}

function add(table, key, outcome) {
  const row = table[key] ||= { labels: 0, attempted: 0, correct: 0 };
  row.labels++;
  if (outcome !== null) { row.attempted++; if (outcome) row.correct++; }
}
function metrics(table) {
  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)).map(([key, r]) => [key, {
    labeled: r.labels, attempted: r.attempted, correct: r.correct,
    attemptRate: r.labels ? r.attempted / r.labels : null,
    coverage: r.labels ? r.correct / r.labels : null,
    precision: r.attempted ? r.correct / r.attempted : null
  }]));
}

function analyze({ reviewFile = REVIEW, triageFile = TRIAGE, whisperFile, output = OUTPUT } = {}) {
  const review = JSON.parse(fs.readFileSync(reviewFile));
  const triage = verifySource(review, 'deepgramTriage', triageFile);
  const sourceWhisper = whisperFile || review.sources.whisper.path;
  const whisper = verifySource(review, 'whisper', sourceWhisper);
  const dgItems = triage.items || {};
  const categories = {};
  const statuses = {};
  const totals = { swearLabels: 0, aligned: 0, excluded: 0, pending: 0, skipped: 0 };
  const byMethod = { localWhisper: {}, deepgram: {} };
  const byCreator = {};
  const byClassification = {};
  const negativeLabels = {};
  const results = [];

  for (const item of review.items || []) {
    const status = item.annotation?.status || 'missing';
    statuses[status] = (statuses[status] || 0) + 1;
    if (status !== 'swear') {
      if (['no-swear-in-audio', 'wrong-audio-fragment', 'not-english'].includes(status)) negativeLabels[status] = (negativeLabels[status] || 0) + 1;
      if (status === 'pending') totals.pending++;
      else if (status === 'skipped') totals.skipped++;
      else totals.excluded++;
      continue;
    }
    totals.swearLabels++;
    const dg = Object.values(dgItems).find(x => x.fixture === item.fixture && x.tokenIndex === item.tokenIndex);
    const source = matchingSlot(whisper.fixtures || [], item);
    const valid = dg && source && close(dg.timeSeconds, item.timeSeconds) && close(source.timeSeconds, item.timeSeconds) &&
      dg.fixture === item.fixture && dg.tokenIndex === item.tokenIndex;
    if (!valid) {
      totals.excluded++;
      categories['source-slot-or-timestamp-mismatch'] = (categories['source-slot-or-timestamp-mismatch'] || 0) + 1;
      results.push({ id: item.id, status: 'excluded-source-mismatch' });
      continue;
    }
    totals.aligned++;
    categories[dg.category || 'unknown'] = (categories[dg.category || 'unknown'] || 0) + 1;
    const expected = [item.annotation.word];
    const localWord = item.whisper?.word || '';
    const localAttempt = Boolean(localWord);
    const localCorrect = localAttempt ? evaluator.isCorrect(localWord, expected, item.context) : null;
    const target = item.timeSeconds - item.clipStart;
    let nearest = null;
    for (const word of dg.deepgramWords || []) {
      const value = String(word.word || '').toLowerCase().replace(/[^a-z']/g, '');
      if (!rules.ALLOWED_WORDS.includes(value) || !Number.isFinite(word.start) || !Number.isFinite(word.end)) continue;
      const midpoint = (word.start + word.end) / 2;
      const distance = Math.abs(midpoint - target);
      if (distance <= WINDOW && (!nearest || distance < nearest.distance)) nearest = { word: word.word, midpoint, distance };
    }
    const dgCorrect = nearest ? evaluator.isCorrect(nearest.word, expected, item.context) : null;
    const classification = source.classification || 'unknown';
    add(byMethod.localWhisper, 'all', localCorrect);
    add(byMethod.deepgram, 'all', dgCorrect);
    byClassification[classification] ||= { localWhisper: {}, deepgram: {} };
    add(byClassification[classification].localWhisper, 'all', localCorrect);
    add(byClassification[classification].deepgram, 'all', dgCorrect);
    const creator = dg.creator || 'unknown';
    byCreator[creator] ||= { localWhisper: {}, deepgram: {} };
    add(byCreator[creator].localWhisper, 'all', localCorrect);
    add(byCreator[creator].deepgram, 'all', dgCorrect);
    results.push({ id: item.id, fixture: item.fixture, tokenIndex: item.tokenIndex, creator, annotation: item.annotation.word,
      local: { word: localWord, attempted: localAttempt, correct: localCorrect }, classification,
      deepgram: { attempted: Boolean(nearest), word: nearest?.word || null, midpoint: nearest?.midpoint ?? null,
        distance: nearest?.distance ?? null, correct: dgCorrect } });
  }
  const outputData = {
    schemaVersion: 1, evidenceStatus: 'descriptive human review; not held-out evidence',
    sourceSha256: { review: sha256(fs.readFileSync(reviewFile)), triage: sha256(fs.readFileSync(triageFile)), whisper: sha256(fs.readFileSync(sourceWhisper)) },
    method: { humanLabels: 'annotation.status === swear only', deepgramCandidate: 'nearest timed allowed swear word to caption time within fixed ±1.25s; not selected by human word', windowSeconds: WINDOW },
    caveat: 'Caption timestamp proxy not human timestamp; human labels have no per-item provenance/timing and are not blinded to caption/context. Positive-only precision excludes almost all no-swear clips (only two labeled); review and triage selection are non-random. No held-out claims.',
    selectionBias: 'Deepgram items come from the existing stratified Whisper-triage selection (error classes, controls, and review items), not a random sample; human review coverage is also incomplete.',
    counts: { ...totals, statuses, negativeLabels, triageCategories: categories },
    localWhisper: metrics(byMethod.localWhisper), deepgram: metrics(byMethod.deepgram),
    byLocalClassification: Object.fromEntries(Object.entries(byClassification).map(([k, v]) => [k, { localWhisper: metrics(v.localWhisper), deepgram: metrics(v.deepgram) }])),
    byCreator: Object.fromEntries(Object.entries(byCreator).map(([k, v]) => [k, { localWhisper: metrics(v.localWhisper), deepgram: metrics(v.deepgram) }])),
    macroByCreator: Object.fromEntries(['localWhisper', 'deepgram'].map(method => [method, macro(byCreator, method)])), results
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(outputData, null, 2) + '\n');
  return outputData;
}
function macro(creators, method) {
  const rows = Object.values(creators).map(x => metrics(x[method]).all).filter(Boolean);
  const attempted = rows.filter(x => x.attempted);
  return { creatorCount: rows.length, precisionCreatorCount: attempted.length,
    precision: attempted.length ? attempted.reduce((s, x) => s + x.precision, 0) / attempted.length : null,
    coverage: rows.length ? rows.reduce((s, x) => s + x.coverage, 0) / rows.length : null };
}
if (require.main === module) {
  try { const report = analyze(); console.log(JSON.stringify({ output: OUTPUT, counts: report.counts, localWhisper: report.localWhisper, deepgram: report.deepgram })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { analyze, WINDOW };
