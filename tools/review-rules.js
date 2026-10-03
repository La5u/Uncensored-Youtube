#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');
const miner = require('./mine-context-leaves');
const runtimeRules = require('../src/rules');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = {
  port: 8767,
  dataset: path.join(ROOT, 'corpus/generated/caption-discovery.json'),
  leads: path.join(ROOT, 'corpus/generated/caption-discovery-leads.json'),
  output: path.join(ROOT, 'corpus/rules/rule-reviews.jsonl')
};
const STATUSES = new Set(['pending', 'accepted', 'rejected', 'generalize', 'narrow', 'suggestion']);
const KINDS = new Set(['all', 'positive', 'counterexample', 'unknown']);
const SCOPES = new Set(['primary', 'other', 'all']);
const OPPOSITE_TIERS = new Map([['manual-auto', 'synthetic'], ['synthetic', 'manual-auto']]);
const MAX_BODY = 64 * 1024;
const MAX_NOTE = 5000;
const RUNTIME_RULE_FILES = [
  path.join(ROOT, 'src/rules.js'),
  path.join(ROOT, 'src/rules-data.js'),
  path.join(ROOT, 'src/rules-compiler.js'),
  ...fs.readdirSync(path.join(ROOT, 'src/rule-data'))
    .filter(file => file.endsWith('.js'))
    .sort()
    .map(file => path.join(ROOT, 'src/rule-data', file))
];

function sha256(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;}

function runtimeRuleFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const file of RUNTIME_RULE_FILES) {
    hash.update(path.relative(ROOT, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

const RULE_FINGERPRINT = runtimeRuleFingerprint();

function stableId(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);}

function parseArgs(argv = process.argv.slice(2)) {
  const result = { ...DEFAULTS };
  const allowed = new Set(['port', 'dataset', 'leads', 'output']);
  for (let i = 0; i < argv.length; i += 1) {
    const match = argv[i].match(/^--(port|dataset|leads|output)(?:=(.*))?$/u);
    if (!match || !allowed.has(match[1])) throw new Error(`unknown flag: ${argv[i]}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '' || (match[1] === 'port' &&
      (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535))) throw new Error(`invalid --${match[1]}`);
    result[match[1]] = match[1] === 'port' ? Number(value) : value;
  }
  return result;
}

function lockPaths(file) { const stem = file.replace(/\.json$/u, ''); return [`${file}.lock`, `${stem}.lock`];}

function inputLocked(config) { return [config.dataset, config.leads].some(file => lockPaths(file).some(lock => fs.existsSync(lock)));}

function statSignature(file) { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;}

// A source is read only after two stats agree. This prevents a refresh from
// producing a snapshot made from two different generations of an input.
function readStable(file) {
  const before = statSignature(file);
  const bytes = fs.readFileSync(file);
  const confirmation = fs.readFileSync(file);
  const after = statSignature(file);
  if (before !== after || !bytes.equals(confirmation)) {
    const error = new Error(`input changed while reading: ${path.basename(file)}`);
    error.statusCode = 409;
    throw error;
  }
  return { bytes, signature: after, hash: sha256(bytes) };
}

function readJsonSource(file, previous) {
  const signature = statSignature(file);
  if (previous && previous.signature === signature) return previous;
  const source = readStable(file);
  try {
    return { ...source, value: JSON.parse(source.bytes.toString('utf8')) };
  } catch {
    const error = new Error(`invalid discovery input ${path.basename(file)}`);
    error.statusCode = 503;
    throw error;
  }
}

function canonicalToken(value) { return String(value ?? '').replace(/\[\s*__\s*\]/gu, '[__]').toLowerCase();}

function conditionKey(condition) { return `${Number(condition.offset)}:${canonicalToken(condition.token)}`;}

function renderPattern(conditions) {
  const byOffset = new Map(conditions.map(condition => [Number(condition.offset), canonicalToken(condition.token)]));
  const offsets = [...byOffset.keys()];
  if (!offsets.length) return '[word]';
  const left = Math.min(0, ...offsets);
  const right = Math.max(0, ...offsets);
  const tokens = [];
  for (let offset = left; offset <= right; offset += 1) {
    tokens.push(offset === 0 ? '[word]' : byOffset.get(offset) || '*');
  }
  return tokens.join(' ');
}

function sourceMap(dataset) {
  return new Map((Array.isArray(dataset.sources) ? dataset.sources : []).filter(source => source && typeof source.id === 'string')
    .map(source => [source.id, source]));
}

function makeContextMap(dataset) {
  return new Map((Array.isArray(dataset.contexts) ? dataset.contexts : []).filter(context => context && typeof context.id === 'string' && typeof context.text === 'string')
    .map(context => [context.id, context]));
}

function prepareRows(dataset, contexts) {
  const rows = [];
  const postings = new Map();
  for (const raw of Array.isArray(dataset.rows) ? dataset.rows : []) {
    const context = contexts.get(String(raw.contextId));
    if (!context) continue;
    const features = miner.discoveryFeatureVector(context.text, raw.slotIndex, miner.MAX_WINDOW_SIDE, miner.MAX_WINDOW_SIDE);
    if (!features) continue;
    const row = { raw, context: context.text, features, featureMap: new Map(features.map(feature => [feature.offset, canonicalToken(feature.token)])) };
    rows.push(row);
    for (const feature of features) {
      const key = conditionKey(feature);
      const list = postings.get(key) || [];
      list.push(row);
      postings.set(key, list);
    }
  }
  return { rows, postings };
}

function matchedRows(prepared, conditions) {
  const conditionKeys = conditions.map(conditionKey);
  const seed = conditionKeys.map(key => prepared.postings.get(key) || []).sort((a, b) => a.length - b.length)[0] || [];
  return seed.filter(row => conditions.every(condition => row.featureMap.get(condition.offset) === canonicalToken(condition.token)));
}

function leadCandidates(leadsDocument, prepared, reviews, customs, sources, sourceRevision) {
  const candidates = [];
  const tiers = leadsDocument.discovery && leadsDocument.discovery.tiers;
  if (!tiers || typeof tiers !== 'object') return candidates;

  for (const [tierName, tier] of Object.entries(tiers)) {
    if (!tier || !Array.isArray(tier.leads)) continue;
    for (const lead of tier.leads) {
      if (!lead || typeof lead.id !== 'string' || !Array.isArray(lead.conditions)) continue;
      const conditions = lead.conditions.map(condition => ({
        offset: Number(condition.offset),
        token: canonicalToken(condition.token)
      })).filter(condition => Number.isSafeInteger(condition.offset) && condition.token);
      if (!conditions.length) continue;
      const matched = matchedRows(prepared, conditions);
      const rows = matched.filter(row => (row.raw.pairClass || 'unknown') === tierName);
      const oppositeTier = OPPOSITE_TIERS.get(tierName);
      const otherRows = oppositeTier
        ? matched.filter(row => row.raw.pairClass === oppositeTier)
        : [];
      const review = reviews.get(lead.id);
      const staleHash = sha256(`${sourceRevision}:${RULE_FINGERPRINT}`);
      candidates.push({
        id: lead.id,
        pattern: renderPattern(conditions),
        target: String(lead.target || '').toLowerCase(),
        tier: tierName,
        custom: false,
        conditions,
        rows,
        otherRows,
        rawExampleCounts: {
          original: Array.isArray(lead.examples) ? lead.examples.length : Number(lead.support) || 0,
          joined: rows.length
        },
        summary: { ...leadStatistics(lead), ...summarize(rows, String(lead.target || '').toLowerCase()) },
        review: review?.status || 'pending',
        reviewDetails: review ? reviewDetails(review) : null,
        staleHash,
        stale: Boolean(review && review.staleHash !== staleHash),
        sourceRevision,
        ruleFingerprint: RULE_FINGERPRINT,
        sources
      });
    }
  }
  for (const definition of customs.values()) {
    const review = reviews.get(definition.id);
    const staleHash = sha256(`${sourceRevision}:${RULE_FINGERPRINT}`);
    candidates.push({
      id: definition.id,
      pattern: definition.pattern,
      target: definition.target,
      tier: 'unknown',
      custom: true,
      conditions: [],
      rows: [],
      otherRows: [],
      rawExampleCounts: { original: 0, joined: 0 },
      summary: { total: 0, positive: 0, counterexample: 0, unknown: 0, rawExampleCounts: { original: 0, joined: 0 } },
      review: review?.status || 'pending',
      reviewDetails: review ? reviewDetails(review) : { pattern: definition.pattern, target: definition.target, note: definition.note || '' },
      staleHash,
      stale: Boolean(review && review.staleHash !== staleHash),
      sourceRevision,
      ruleFingerprint: RULE_FINGERPRINT,
      sources
    });
  }
  return candidates;
}

function copyJson(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value));}

function leadStatistics(lead) {
  const result = copyJson(lead);
  if (result && typeof result === 'object') delete result.examples;
  return result;
}

function summarize(rows, target) {
  const result = { total: rows.length, positive: 0, counterexample: 0, unknown: 0 };
  for (const row of rows) {
    if (row.raw.labelStatus !== 'known') result.unknown += 1;
    else if (String(row.raw.expected || '').toLowerCase() === target) result.positive += 1;
    else result.counterexample += 1;
  }
  result.rawExampleCounts = { total: rows.length, positive: result.positive, counterexample: result.counterexample, unknown: result.unknown };
  return result;
}

function reviewDetails(review) {
  return { status: review.status, pattern: review.pattern, target: review.target, note: review.note || '', timestamp: review.timestamp,
    sourceRevision: review.sourceRevision, ruleFingerprint: review.ruleFingerprint, staleHash: review.staleHash };
}

function loadHistory(file) {
  const customDefinitions = new Map();
  const reviews = new Map();
  if (!fs.existsSync(file)) return { customDefinitions, reviews, corrupt: false, signature: 'missing' };
  const source = readStable(file);
  const text = source.bytes.toString('utf8');
  const lines = text.split('\n');
  let corrupt = text.length > 0 && !text.endsWith('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    try {
      const event = JSON.parse(lines[index]);
      if (!event || typeof event !== 'object' || Array.isArray(event) || event.version !== 1 || typeof event.type !== 'string' || typeof event.id !== 'string') throw new Error('invalid event');
      if (event.type === 'custom') {
        if (typeof event.pattern !== 'string' || typeof event.target !== 'string') throw new Error('invalid custom event');
        customDefinitions.set(event.id, event);
      } else if (event.type === 'review') {
        if (!STATUSES.has(event.status) || typeof event.pattern !== 'string' || typeof event.target !== 'string') throw new Error('invalid review event');
        reviews.delete(event.id); // Keep latest judgments in chronological order.
        reviews.set(event.id, event);
      } else throw new Error('unknown event');
    } catch {
      corrupt = true;
    }
  }
  return { customDefinitions, reviews, corrupt, signature: source.signature };
}

function checkOutputAlias(config) {
  const actual = file => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  const output = actual(config.output);
  if (output === actual(config.dataset) || output === actual(config.leads)) throw new Error('output must not alias source');
}

function parseNumber(value, fallback, maximum, minimum = 0) {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function validText(value, maximum, required = true, allowMultiline = false) {
  const controls = allowMultiline ? /[\u0000-\u0009\u000b-\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  return typeof value === 'string' && (!required || value.length > 0) && value.length <= maximum && !controls.test(value);
}

function optionalText(value, maximum, allowMultiline = false) {
  return value === undefined || validText(value, maximum, false, allowMultiline);
}

function validTarget(value) { return validText(value, 100) && !(/[\s\[\]*]/u.test(value));}

function patternTokens(pattern, maximumSide = null) {
  if (!validText(pattern, 1000)) return null;
  const tokens = pattern.trim().split(/\s+/u);
  if (!tokens.length || tokens.length > 32) return null;
  let wordMarkers = 0;
  let blankMarkers = 0;
  for (const token of tokens) {
    const normalized = canonicalToken(token);
    if (normalized === '[word]') wordMarkers += 1;
    else if (normalized === '[__]') blankMarkers += 1;
    else if (token.includes('[') || token.includes(']') || token === '*') {
      if (token !== '*') return null;
    } else if (token.includes('*')) return null;
  }
  if (!(wordMarkers === 1 || (wordMarkers === 0 && blankMarkers === 1))) return null;
  if (maximumSide !== null) {
    const marker = tokens.findIndex(token => canonicalToken(token) === '[word]' || canonicalToken(token) === '[__]');
    if (marker < 0 || marker > maximumSide || tokens.length - marker - 1 > maximumSide) return null;
  }
  return tokens;
}

function previewMatches(pattern, target, snapshot) {
  const tokens = patternTokens(pattern);
  if (!tokens || !validTarget(target)) return null;
  const marker = tokens.findIndex(token => canonicalToken(token) === '[word]');
  const targetMarker = marker >= 0 ? marker : tokens.findIndex(token => canonicalToken(token) === '[__]');
  const tiers = {};
  const examples = [];
  for (const row of snapshot.prepared.rows) {
    const actual = row.features;
    if (!actual) continue;
    const features = new Map(actual.map(feature => [feature.offset, feature.token]));
    const matches = tokens.every((token, index) => {
      const offset = index - targetMarker;
      const actualToken = offset === 0 ? '[__]' : features.get(offset);
      return actualToken !== undefined && tokenMatches(token, actualToken);
    });
    if (!matches) continue;
    const tier = row.raw.pairClass || 'unknown';
    const stats = tiers[tier] || (tiers[tier] = { total: 0, positive: 0, counterexample: 0, unknown: 0 });
    stats.total += 1;
    if (row.raw.labelStatus !== 'known') stats.unknown += 1;
    else if (String(row.raw.expected || '').toLowerCase() === String(target).toLowerCase()) stats.positive += 1;
    else stats.counterexample += 1;
    if (examples.length < 100) examples.push({ id: String(row.raw.id), expected: row.raw.expected ?? null,
      labelStatus: row.raw.labelStatus || 'unknown', tier, videoId: row.raw.videoId || null,
      targetOffset: row.raw.targetOffset, targetSpan: row.raw.targetSpan });
  }
  return { tiers, examples, discoveryOnly: true,
    validation: { eligible: false, status: 'discovery-only', evidence: 'not validation evidence' } };
}

function tokenMatches(patternToken, actualToken) {
  const pattern = canonicalToken(patternToken);
  if (pattern === '[word]') return canonicalToken(actualToken) === '[__]';
  if (pattern === '*') return !/^<(?:bos|eos)>$/iu.test(actualToken);
  return pattern === canonicalToken(actualToken);
}

function runtimeExample(row, source) {
  let prediction = null;
  try {
    const result = runtimeRules.applyDeterministicRules(row.context);
    const decision = (result.decisions || []).find(candidate => Number.isSafeInteger(candidate.tokenIndex) &&
      candidate.tokenIndex <= row.raw.slotIndex && candidate.tokenIndex + (candidate.tokenSpan || 1) > row.raw.slotIndex);
    prediction = decision?.word ? String(decision.word).toLowerCase() : null;
  } catch {
    prediction = null;
  }
  const known = row.raw.labelStatus === 'known' && row.raw.expected;
  const currentOutcome = !known ? (prediction ? 'unscored' : 'abstain') :
    prediction === String(row.raw.expected).toLowerCase() ? 'already-correct' : prediction ? 'wrong' : 'abstain';
  return {
    id: String(row.raw.id), context: row.context, expected: row.raw.expected ?? null,
    expectedCandidates: row.raw.expectedCandidates || [], labelStatus: row.raw.labelStatus || 'unknown',
    creator: row.raw.creator || null, creatorId: row.raw.creatorId || null, videoId: row.raw.videoId || null,
    timestamp: row.raw.timestamp ?? null, targetOffset: row.raw.targetOffset, targetSpan: row.raw.targetSpan,
    tier: row.raw.pairClass || 'unknown', provenanceStatus: source?.provenanceStatus || 'discovery',
    provenance: source || null, current: prediction, currentOutcome,
    features: row.features, tokenIndex: row.raw.slotIndex
  };
}

function publicCandidate(candidate) {
  const { rows, otherRows, sources, ...publicValue } = candidate;
  return publicValue;
}

function validateLeadReferences(leadsDocument, dataset) {
  const rowIds = new Set((Array.isArray(dataset.rows) ? dataset.rows : [])
    .map(row => row && typeof row.id === 'string' ? row.id : null).filter(Boolean));
  const missing = [];
  const tiers = leadsDocument.discovery && leadsDocument.discovery.tiers;
  if (!tiers || typeof tiers !== 'object') return;
  for (const tier of Object.values(tiers)) {
    for (const lead of Array.isArray(tier?.leads) ? tier.leads : []) {
      for (const field of ['exampleIds', 'counterexampleIds', 'unknownIds']) {
        for (const id of Array.isArray(lead[field]) ? lead[field] : []) {
          if (typeof id === 'string' && !rowIds.has(id)) missing.push(`${lead.id || '<unknown>'}:${field}:${id}`);
        }
      }
      for (const example of Array.isArray(lead.examples) ? lead.examples : []) {
        if (example && typeof example.id === 'string' && !rowIds.has(example.id)) {
          missing.push(`${lead.id || '<unknown>'}:examples:${example.id}`);
        }
      }
    }
  }
  if (missing.length) {
    const error = new Error(`discovery leads reference missing dataset rows: ${missing.slice(0, 5).join(', ')}`);
    error.statusCode = 503;
    throw error;
  }
}

function makeSnapshot(config, previous) {
  const dataset = readJsonSource(config.dataset, previous?.datasetSource);
  const leads = readJsonSource(config.leads, previous?.leadsSource);
  const sourceSignature = `${dataset.signature}:${leads.signature}`;
  const finalDatasetSignature = statSignature(config.dataset);
  const finalLeadsSignature = statSignature(config.leads);
  const locked = inputLocked(config);
  if (finalDatasetSignature !== dataset.signature || finalLeadsSignature !== leads.signature || locked) {
    const error = new Error(locked ? 'discovery inputs are locked' : 'discovery inputs changed while reading');
    error.statusCode = 409;
    throw error;
  }
  validateLeadReferences(leads.value, dataset.value);
  const history = loadHistory(config.output);
  if (previous && previous.sourceSignature === sourceSignature && previous.historySignature === history.signature) return previous;
  const sourceRevision = previous?.sourceSignature === sourceSignature
    ? previous.sourceRevision
    : sha256(Buffer.concat([dataset.bytes, leads.bytes]));
  const revision = sha256(JSON.stringify({ sourceRevision, ruleFingerprint: RULE_FINGERPRINT }));
  const contexts = previous?.sourceSignature === sourceSignature ? previous.contexts : makeContextMap(dataset.value);
  const prepared = previous?.sourceSignature === sourceSignature ? previous.prepared : prepareRows(dataset.value, contexts);
  const sources = previous?.sourceSignature === sourceSignature ? previous.sources : sourceMap(dataset.value);
  const candidates = leadCandidates(leads.value, prepared, history.reviews, history.customDefinitions, sources, sourceRevision);
  return { dataset: dataset.value, leads: leads.value, datasetSource: dataset, leadsSource: leads, prepared, contexts, sources, candidates, sourceSignature, sourceRevision, revision,
    history, historySignature: history.signature, rulesCodeHash: RULE_FINGERPRINT };
}

function json(res, status, value) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function validLocalRequest(req, port) {
  const match = String(req.headers.host || '').match(/^(localhost|127\.0\.0\.1):(\d+)$/u);
  return Boolean(match && Number(match[2]) === port);
}

function validOrigin(req, port) {
  try {
    const origin = new URL(String(req.headers.origin || ''));
    return origin.protocol === 'http:' && (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1') &&
      Number(origin.port) === port && origin.host === req.headers.host && (origin.pathname === '' || origin.pathname === '/');
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on('data', chunk => {
      length += chunk.length;
      if (length <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      if (length > MAX_BODY) return reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
        resolve(value);
      } catch {
        reject(Object.assign(new Error('JSON object required'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function appendEvent(file, event) {
  const history = loadHistory(file);
  if (history.corrupt) {
    const error = new Error('review history is corrupt; repair the JSONL file before writing');
    error.statusCode = 503;
    throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
}

function createServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  config.dataset = path.resolve(config.dataset);
  config.leads = path.resolve(config.leads);
  config.output = path.resolve(config.output);
  checkOutputAlias(config);
  let snapshot = null;
  let outputSignature = null;
  const serverRuleFingerprint = RULE_FINGERPRINT;

  function ensureRuntimeRulesUnchanged() {
    let current;
    try {
      current = runtimeRuleFingerprint();
    } catch {
      current = null;
    }
    if (current === serverRuleFingerprint) return;
    const error = new Error('runtime rule files changed; restart the review server');
    error.statusCode = 409;
    throw error;
  }

  function currentSnapshot(forWrite = false) {
    try {
      ensureRuntimeRulesUnchanged();
      const next = makeSnapshot(config, snapshot);
      if (!next.history.corrupt) {
        snapshot = next;
        outputSignature = next.historySignature;
      } else if (!snapshot) {
        const error = new Error('review history is corrupt');
        error.statusCode = 503;
        throw error;
      }
      return snapshot;
    } catch (error) {
      const transientInputError = error.statusCode === 409 &&
        /(?:locked|changed while reading)/u.test(error.message || '');
      if (!forWrite && snapshot && transientInputError) return snapshot;
      throw error;
    }
  }

  function refreshHistoryIfNeeded(value, forWrite = false) {
    if (value.historySignature === 'missing' && !fs.existsSync(config.output)) return value;
    const signature = fs.existsSync(config.output) ? statSignature(config.output) : 'missing';
    if (signature === outputSignature) return value;
    return currentSnapshot(forWrite);
  }

  function findCandidate(value, id) { return value.candidates.find(candidate => candidate.id === id); }

  async function handle(req, res) {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : Number(config.port);
    if (!validLocalRequest(req, port)) return json(res, 403, { error: 'invalid host' });
    const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = requestUrl.pathname;
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(302, { location: '/tools/rule-review.html' });
      return res.end();
    }
    if (req.method === 'GET' && pathname === '/tools/rule-review.html') {
      const file = path.join(ROOT, 'tools/rule-review.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    if (!pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (req.method === 'POST') {
      if (!validOrigin(req, port)) return json(res, 403, { error: 'origin mismatch' });
      if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers['content-type'] || ''))) return json(res, 415, { error: 'JSON required' });
      if (inputLocked(config)) return json(res, 409, { error: 'discovery inputs are locked' });
    }

    try {
      const forWrite = req.method !== 'GET';
      let state = currentSnapshot(forWrite);
      state = refreshHistoryIfNeeded(state, forWrite);
      if (req.method === 'GET' && pathname === '/api/state') {
        const candidates = state.candidates;
        const ids = new Set(candidates.map(candidate => candidate.id));
        const reviewHistory = [...state.history.reviews.keys()].filter(id => ids.has(id));
        return json(res, 200, { reviewHistory, revision: state.revision, sourceRevision: state.sourceRevision, ruleFingerprint: RULE_FINGERPRINT,
          candidates: candidates.map(publicCandidate), counts: { candidates: candidates.length,
            pending: candidates.filter(candidate => candidate.review === 'pending').length,
            accepted: candidates.filter(candidate => candidate.review === 'accepted').length,
            rejected: candidates.filter(candidate => candidate.review === 'rejected').length } });
      }
      if (req.method === 'GET' && pathname === '/api/candidate') {
        const id = requestUrl.searchParams.get('id');
        const offset = parseNumber(requestUrl.searchParams.get('offset') ?? undefined, 0, 100000000);
        const limit = parseNumber(requestUrl.searchParams.get('limit') ?? undefined, 20, 100, 1);
        const kind = requestUrl.searchParams.get('kind') || 'all';
        const scope = requestUrl.searchParams.get('scope') || 'primary';
        if (!validText(id, 512) || offset === null || limit === null || !KINDS.has(kind) || !SCOPES.has(scope)) return json(res, 400, { error: 'invalid candidate query' });
        const candidate = findCandidate(state, id);
        if (!candidate) return json(res, 404, { error: 'candidate not found' });
        const scopedRows = scope === 'primary' ? candidate.rows : scope === 'other' ? candidate.otherRows : candidate.rows.concat(candidate.otherRows);
        const rows = scopedRows.filter(row => kind === 'all' || kind === 'unknown' && row.raw.labelStatus !== 'known' ||
          kind === 'positive' && row.raw.labelStatus === 'known' && String(row.raw.expected || '').toLowerCase() === candidate.target ||
          kind === 'counterexample' && row.raw.labelStatus === 'known' && String(row.raw.expected || '').toLowerCase() !== candidate.target);
        const source = candidate.sources;
        const counts = summarize(scopedRows, candidate.target).rawExampleCounts;
        const items = rows.slice(offset, offset + limit).map(row => runtimeExample(row, source.get(String(row.raw.sourceId))));
        return json(res, 200, { revision: state.revision, candidate: publicCandidate(candidate), examples: { items, total: rows.length, counts } });
      }
      if (req.method !== 'POST' || !['/api/review', '/api/custom', '/api/preview'].includes(pathname)) return json(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if (inputLocked(config)) return json(res, 409, { error: 'discovery inputs are locked' });
      const fresh = currentSnapshot(true);
      if (fresh.revision !== state.revision || fresh.sourceRevision !== state.sourceRevision) return json(res, 409, { error: 'stale revision', revision: fresh.revision });
      state = fresh;
      if (typeof body.revision !== 'string' || body.revision !== state.revision) return json(res, 409, { error: 'stale revision', revision: state.revision });
      if (pathname === '/api/preview') {
        if (!validTarget(body.target) || !patternTokens(body.pattern, miner.MAX_WINDOW_SIDE)) return json(res, 400, { error: 'unsupported syntax' });
        return json(res, 200, previewMatches(body.pattern, body.target, state));
      }
      if (pathname === '/api/review') {
        const candidate = typeof body.id === 'string' ? findCandidate(state, body.id) : null;
        if (!candidate || !STATUSES.has(body.status) || !validText(body.pattern, 1000) || !validTarget(body.target) || !optionalText(body.note, MAX_NOTE, true)) return json(res, 400, { error: 'invalid review' });
        const timestamp = new Date().toISOString();
        appendEvent(config.output, { version: 1, type: 'review', revision: state.revision, id: candidate.id, status: body.status, pattern: body.pattern,
          target: body.target, note: body.note || '', timestamp, sourceRevision: state.sourceRevision,
          ruleFingerprint: RULE_FINGERPRINT, staleHash: sha256(`${state.sourceRevision}:${RULE_FINGERPRINT}`) });
        return json(res, 200, { ok: true, timestamp, sourceRevision: state.sourceRevision, ruleFingerprint: RULE_FINGERPRINT });
      }
      if (!validText(body.pattern, 1000) || !validTarget(body.target) || !optionalText(body.note, MAX_NOTE, true) || !patternTokens(body.pattern)) return json(res, 400, { error: 'invalid custom' });
      const id = `custom:${stableId({ pattern: body.pattern, target: body.target })}`;
      appendEvent(config.output, { version: 1, type: 'custom', revision: state.revision, id, pattern: body.pattern, target: body.target,
        note: body.note || '', timestamp: new Date().toISOString(), sourceRevision: state.sourceRevision,
        ruleFingerprint: RULE_FINGERPRINT, staleHash: sha256(`${state.sourceRevision}:${RULE_FINGERPRINT}`) });
      return json(res, 200, { id, revision: state.revision });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || 'request failed' });
    }
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(error => json(response, error.statusCode || 500, { error: error.message || 'request failed' }));
  });
  return {
    server,
    start(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); });
      });
    },
    close() { return new Promise(resolve => server.close(() => resolve())); },
    reload() { return currentSnapshot(true); }
  };
}

if (require.main === module) {
  const controller = createServer(parseArgs());
  controller.start().then(address => console.log(`Rule review listening on http://127.0.0.1:${address.port}`))
    .catch(error => { console.error(error.message || error); process.exit(1); });
}

module.exports = { args: parseArgs, parseArgs, createServer, discoveryFeatureVector: miner.discoveryFeatureVector };
