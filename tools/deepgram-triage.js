#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { audioSection } = require('./evaluate-whisper-only');

const REPORT = path.resolve('corpus/generated/dense-audio-v2-whisper-triage-current.json');
const ENDPOINT = 'https://api.deepgram.com/v1/listen?model=nova-3&language=en&profanity_filter=false';
const MAX_REQUESTS = 500;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stableId = s => hash(s).slice(0, 24);

function categoryFor(result) {
  if (result.classification === 'missed' || result.classification === 'different-swear') return 'missed-or-different-swear';
  if (result.classification === 'unscored' || result.classification === 'review' || result.expected?.length && !result.attempted) return 'unscored-review';
  if (result.nearTranscription || result.classification === 'recognized-wrong-slot' || (result.recognizedExpected === false && result.attempted)) return 'near-transcription-or-wrong-slot';
  if (result.correct === true || result.classification?.startsWith('correct-')) return 'control';
  return null;
}

function selectItems(report, { limit = MAX_REQUESTS, audioExists = fs.existsSync } = {}) {
  const cap = Math.max(0, Math.min(MAX_REQUESTS, Number(limit) || 0));
  const pools = { 'missed-or-different-swear': [], 'near-transcription-or-wrong-slot': [], control: [], 'unscored-review': [] };
  for (const fixture of report.fixtures || []) {
    if (fixture.pairClass !== 'manual-auto' || !Array.isArray(fixture.results) ||
        !fixture.audio || !audioExists(fixture.audio)) continue;
    for (const result of fixture.results) {
      const category = categoryFor(result);
      if (!category || !Number.isFinite(result.timeSeconds)) continue;
      const id = stableId(`${fixture.name}:${result.tokenIndex}:${fixture.contentFingerprint || ''}`);
      pools[category].push({ id, category, fixture, result, creator: fixture.creatorId || fixture.creator || fixture.name });
    }
  }
  for (const pool of Object.values(pools)) pool.sort((a, b) => a.id.localeCompare(b.id));
  // Give errors first priority, then wrong-slot/near-transcription cases. Reserve about
  // 10% for deterministic correct controls; review candidates remain explicitly separate.
  const controls = Math.min(pools.control.length, Math.round(cap * 0.10));
  const review = Math.min(pools['unscored-review'].length, Math.round(cap * 0.05));
  const prioritized = cap - controls - review;
  const chosen = [];
  chosen.push(...balancedTake(pools['missed-or-different-swear'], prioritized));
  let remaining = prioritized - chosen.length;
  chosen.push(...balancedTake(pools['near-transcription-or-wrong-slot'], remaining, chosen));
  remaining = prioritized - chosen.length;
  if (remaining > 0) chosen.push(...balancedTake(pools['missed-or-different-swear'], remaining, chosen));
  remaining = prioritized - chosen.length;
  if (remaining > 0) chosen.push(...balancedTake(pools['near-transcription-or-wrong-slot'], remaining, chosen));
  chosen.push(...balancedTake(pools['unscored-review'], review, chosen));
  chosen.push(...balancedTake(pools.control, controls, chosen));
  return chosen.slice(0, cap).map(({ id, category, fixture, result }) => ({
    id, category, creator: fixture.creatorId || fixture.creator || fixture.name,
    fixture: fixture.name, audio: fixture.audio, timeSeconds: result.timeSeconds,
    tokenIndex: result.tokenIndex, originalLabel: result.word || '', classification: result.classification || 'unscored',
    localTranscript: result.transcript || '', expected: result.expected || [], recognizedWords: result.recognizedWords || [],
    nearTranscription: result.nearTranscription || null,
    context: result.context || '', reviewContext: result.reviewContext || '',
    fixtureContentFingerprint: fixture.contentFingerprint || null
  }));
}

function balancedTake(items, count, already = []) {
  const seen = new Set(already.map(x => x.id));
  const counts = new Map();
  for (const item of already) counts.set(item.creator, (counts.get(item.creator) || 0) + 1);
  const groups = new Map();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    if (!groups.has(item.creator)) groups.set(item.creator, []);
    groups.get(item.creator).push(item);
  }
  const names = [...groups.keys()].sort();
  const out = [];
  while (out.length < count) {
    let progressed = false;
    names.sort((a, b) => (counts.get(a) || 0) - (counts.get(b) || 0) || a.localeCompare(b));
    for (const name of names) {
      const item = groups.get(name).shift();
      if (item) { out.push(item); counts.set(name, (counts.get(name) || 0) + 1); progressed = true; if (out.length >= count) break; }
    }
    if (!progressed) break;
  }
  return out;
}

function atomicSave(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

function getWav(audio, timeSeconds) {
  const start = Math.max(0, timeSeconds - 5);
  const { file, offset } = audioSection(audio, start, 10);
  const proc = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(start - offset), '-i', file, '-t', '10', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
  if (proc.status !== 0 || !proc.stdout?.length) throw new Error('audio conversion failed');
  return proc.stdout;
}

function extractWords(data) {
  const alt = data?.results?.channels?.[0]?.alternatives?.[0] || {};
  return { transcript: alt.transcript || '', words: (alt.words || []).map(w => ({ word: w.word, start: w.start, end: w.end, confidence: w.confidence })) };
}

async function requestTranscript(wav, apiKey, fetchImpl = fetch) {
  let lastStatus;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/wav' }, body: wav, signal: AbortSignal.timeout(45000) });
      if (response.ok) return await response.json();
      lastStatus = response.status;
      if (![429, 500, 502, 503, 504].includes(response.status)) break;
    } catch { lastStatus = 'network'; }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Deepgram request failed (${lastStatus || 'unknown'})`);
}

async function run({ reportFile = REPORT, output = 'tmp/deepgram-triage.json', limit = MAX_REQUESTS, fetchImpl = fetch, audioToWav = getWav, audioExists = fs.existsSync } = {}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  const rawReport = fs.readFileSync(reportFile);
  const report = JSON.parse(rawReport);
  if (report.complete !== true || report.mode !== 'whisper-only' ||
      Object.keys(report.summary?.pairClasses || {}).some(c => c !== 'manual-auto')) {
    throw new Error('Expected a complete manual-auto whisper-only diagnostic report');
  }
  const selected = selectItems(report, { limit, audioExists });
  const snapshot = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
  const reportFingerprint = hash(rawReport);
  if (snapshot && snapshot.reportFingerprint !== reportFingerprint) {
    throw new Error('Output belongs to a different report; choose a new output path');
  }
  const prior = snapshot?.items || {};
  const state = { schemaVersion: 1, evidenceStatus: 'diagnostic-only; no automatic truth claims', report: path.relative(process.cwd(), reportFile), reportFingerprint, provider: 'Deepgram', model: 'nova-3', language: 'en', profanityFilter: false, clipSeconds: 10, provenance: { rulesFingerprint: report.rulesFingerprint || null, decisionFingerprint: report.decisionFingerprint || null, transcriptGenerationFingerprint: report.transcriptGenerationFingerprint || null, audioWindowKey: report.audioWindowKey || null }, selectedCount: selected.length, selectionOrder: selected.map(item => item.id), items: { ...prior } };
  for (const item of selected) {
    if (state.items[item.id]?.status === 'complete') {
      delete state.items[item.id].audioFingerprint; // historical misnomer: this was a fixture-content fingerprint
      Object.assign(state.items[item.id], { context: item.context, reviewContext: item.reviewContext,
        fixtureContentFingerprint: item.fixtureContentFingerprint });
    }
  }
  if (!apiKey && selected.some(item => state.items[item.id]?.status !== 'complete')) {
    throw new Error('Set DEEPGRAM_API_KEY in the environment to transcribe unfinished items');
  }
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const item = selected[cursor++];
      if (state.items[item.id]?.status === 'complete') continue;
      try {
        const wav = audioToWav(item.audio, item.timeSeconds);
        const dg = extractWords(await requestTranscript(wav, apiKey, fetchImpl));
        state.items[item.id] = { ...item, status: 'complete', deepgramTranscript: dg.transcript, deepgramWords: dg.words };
      } catch (error) {
        // Never persist exception text: transports may include request headers.
        state.items[item.id] = { ...item, status: 'error', error: error.message === 'audio conversion failed' ? 'audio conversion failed' : 'request failed' };
      }
      atomicSave(output, state);
    }
  }
  await Promise.all([worker(), worker()]);
  atomicSave(output, state);
  return { selected: selected.length, completed: selected.filter(x => state.items[x.id]?.status === 'complete').length, output };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
  run({ output: value('--output') || 'tmp/deepgram-triage.json', limit: value('--limit') || MAX_REQUESTS })
    .then(summary => console.log(JSON.stringify(summary)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { categoryFor, selectItems, extractWords, requestTranscript, run, ENDPOINT, MAX_REQUESTS };
