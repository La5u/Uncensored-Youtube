'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer, parseArgs } = require('../tools/review-rules');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-rules-'));
  const dataset = path.join(directory, 'discovery.json');
  const leads = path.join(directory, 'leads.json');
  const output = path.join(directory, 'reviews.jsonl');
  const contexts = [
    { id: 'one', text: 'first [__] after' },
    { id: 'two', text: 'left [__] right [__] edge' },
    { id: 'three', text: 'first [__] after' },
    { id: 'edge', text: '[__] unique' },
    { id: 'far', text: 'a b c d e f g h [__] i j k l m n o p' }
  ];
  const rows = [
    { id: 'manual-positive', contextId: 'one', slotIndex: 0, targetOffset: 6, targetSpan: 4, expected: 'shit', expectedCandidates: ['shit'], labelStatus: 'known', pairClass: 'manual-auto', sourceId: 'source-manual', creator: 'A' },
    { id: 'manual-unknown', contextId: 'three', slotIndex: 0, targetOffset: 6, targetSpan: 4, expected: null, expectedCandidates: [], labelStatus: 'unknown', pairClass: 'manual-auto', sourceId: 'source-manual', creator: 'A' },
    { id: 'synthetic-counter', contextId: 'one', slotIndex: 0, targetOffset: 6, targetSpan: 4, expected: 'fuck', expectedCandidates: ['fuck'], labelStatus: 'known', pairClass: 'synthetic', sourceId: 'source-synthetic', creator: 'B' },
    { id: 'second-marker', contextId: 'two', slotIndex: 1, targetOffset: 18, targetSpan: 4, expected: 'shit', expectedCandidates: ['shit'], labelStatus: 'known', pairClass: 'manual-auto', sourceId: 'source-manual', creator: 'A' },
    { id: 'edge-target', contextId: 'edge', slotIndex: 0, targetOffset: 0, targetSpan: 4, expected: 'shit', expectedCandidates: ['shit'], labelStatus: 'known', pairClass: 'manual-auto', sourceId: 'source-manual', creator: 'A' },
    { id: 'far-context', contextId: 'far', slotIndex: 0, targetOffset: 16, targetSpan: 4, expected: 'shit', expectedCandidates: ['shit'], labelStatus: 'known', pairClass: 'manual-auto', sourceId: 'source-manual', creator: 'A' }
  ];
  const lead = (id, tier, target, token) => ({ id, tier, target, conditions: [{ offset: -1, token }], support: 3, precision: 1, creatorCount: 1,
    exampleIds: [tier === 'synthetic' ? 'synthetic-counter' : 'manual-positive'],
    examples: [{ id: tier === 'synthetic' ? 'synthetic-counter' : 'manual-positive' }] });
  const leadDocument = { discovery: { tiers: {
    'manual-auto': { leads: [lead('manual-lead', 'manual-auto', 'shit', 'first')] },
    synthetic: { leads: [lead('synthetic-lead', 'synthetic', 'shit', 'first')] }
  } } };
  fs.writeFileSync(dataset, JSON.stringify({ dataset: 'caption-discovery', contexts, rows, sources: [
    { id: 'source-manual', provenanceStatus: 'manual-source', report: 'manual-report' },
    { id: 'source-synthetic', provenanceStatus: 'synthetic-source', report: 'synthetic-report' }
  ] }));
  fs.writeFileSync(leads, JSON.stringify(leadDocument));
  return { directory, dataset, leads, output };
}

function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { host: `127.0.0.1:${port}`, ...(encoded ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` } : {}), ...headers }
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* HTML is intentionally returned as text. */ }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (encoded) request.end(encoded); else request.end();
  });
}

async function withServer(run) {
  const files = fixture();
  const controller = createServer(files);
  const address = await controller.start(0);
  try { await run(address.port, files, controller); }
  finally { await controller.close(); fs.rmSync(files.directory, { recursive: true, force: true }); }
}

test('uses actual lead IDs, joins exact tier evidence, and keeps diagnostics separate', async () => withServer(async (port) => {
  const state = await request(port, 'GET', '/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.candidates.map(candidate => candidate.id), ['manual-lead', 'synthetic-lead']);
  const manual = state.body.candidates[0];
  assert.equal(manual.summary.total, 2);
  assert.equal(manual.summary.positive, 1);
  assert.equal(manual.summary.unknown, 1);
  assert.equal(manual.summary.support, 3);
  assert.equal(manual.rawExampleCounts.original, 1);
  const detail = await request(port, 'GET', `/api/candidate?id=${manual.id}&offset=0&limit=10`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.examples.items[0].provenanceStatus, 'manual-source');
  assert.equal(detail.body.examples.items[0].id, 'manual-positive');
  assert.equal(detail.body.examples.items[0].currentOutcome, 'abstain');
  assert.equal(detail.body.candidate.reviewDetails, null);
  assert.equal('rows' in detail.body.candidate, false);
  assert.equal('otherRows' in detail.body.candidate, false);
  const other = await request(port, 'GET', `/api/candidate?id=${manual.id}&scope=other&kind=counterexample&offset=0&limit=10`);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.examples.items.map(item => item.id), ['synthetic-counter']);
  assert.equal(other.body.examples.items[0].tier, 'synthetic');
  assert.deepEqual(other.body.examples.counts, { total: 1, positive: 0, counterexample: 1, unknown: 0 });
  const primaryAgain = await request(port, 'GET', `/api/candidate?id=${manual.id}&scope=primary&offset=0&limit=10`);
  assert.equal(primaryAgain.body.examples.total, 2);
  const invalidScope = await request(port, 'GET', `/api/candidate?id=${manual.id}&scope=invalid`);
  assert.equal(invalidScope.status, 400);
  const preview = await request(port, 'POST', '/api/preview', { revision: state.body.revision, pattern: 'right [__] edge', target: 'shit' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.tiers['manual-auto'].total, 1);
  const edgePreview = await request(port, 'POST', '/api/preview', { revision: state.body.revision, pattern: '* [__] unique', target: 'shit' });
  assert.equal(edgePreview.status, 200);
  assert.equal(edgePreview.body.examples.length, 0);
  assert.equal(edgePreview.body.discoveryOnly, true);
  const farPreview = await request(port, 'POST', '/api/preview', { revision: state.body.revision,
    pattern: 'a b c d e f g h [__] i j k l m n o p', target: 'shit' });
  assert.equal(farPreview.status, 200);
  assert.equal(farPreview.body.examples.some(example => example.id === 'far-context'), true);
  const overLimitPreview = await request(port, 'POST', '/api/preview', { revision: state.body.revision,
    pattern: 'a b c d e f g h i [__] i', target: 'shit' });
  assert.equal(overLimitPreview.status, 400);
  const invalidTarget = await request(port, 'POST', '/api/preview', { revision: state.body.revision, pattern: '[word]', target: 'not valid' });
  assert.equal(invalidTarget.status, 400);
  assert.equal(preview.body.validation.eligible, false);
}));

test('validates IDs, bodies, syntax, pagination, origin, and stale revisions', async () => withServer(async (port) => {
  const state = await request(port, 'GET', '/api/state');
  const invalidId = await request(port, 'POST', '/api/review', { revision: state.body.revision, id: 'not-a-candidate', status: 'accepted', pattern: '[word]', target: 'shit' });
  assert.equal(invalidId.status, 400);
  const primitive = await request(port, 'POST', '/api/custom', 'primitive');
  assert.equal(primitive.status, 400);
  const badPattern = await request(port, 'POST', '/api/preview', { revision: state.body.revision, pattern: '[shit]', target: 'shit' });
  assert.equal(badPattern.status, 400);
  const multipleMarkers = await request(port, 'POST', '/api/preview', { revision: state.body.revision, pattern: '[word] [word]', target: 'shit' });
  assert.equal(multipleMarkers.status, 400);
  const badPage = await request(port, 'GET', '/api/candidate?id=manual-lead&offset=-1');
  assert.equal(badPage.status, 400);
  const stale = await request(port, 'POST', '/api/custom', { revision: 'stale', pattern: '[word]', target: 'shit' });
  assert.equal(stale.status, 409);
  const multiline = await request(port, 'POST', '/api/custom', { revision: state.body.revision, pattern: 'note [word]', target: 'shit', note: 'line one\nline two' });
  assert.equal(multiline.status, 200);
  const nul = await request(port, 'POST', '/api/custom', { revision: state.body.revision, pattern: 'nul [word]', target: 'shit', note: 'bad\u0000note' });
  assert.equal(nul.status, 400);
  const longNote = await request(port, 'POST', '/api/custom', { revision: state.body.revision, pattern: 'long [word]', target: 'shit', note: 'x'.repeat(5001) });
  assert.equal(longNote.status, 400);
  const wrongHost = await request(port, 'GET', '/api/state', undefined, { host: 'evil.test' });
  assert.equal(wrongHost.status, 403);
  const wrongOrigin = await request(port, 'POST', '/api/custom', { revision: state.body.revision, pattern: '[word]', target: 'shit' }, { origin: `http://evil.test:${port}` });
  assert.equal(wrongOrigin.status, 403);
}));

test('persists definitions and later reviews without overwriting either history map', async () => {
  const files = fixture();
  let controller = createServer(files);
  let address = await controller.start(0);
  const state = await request(address.port, 'GET', '/api/state');
  const created = await request(address.port, 'POST', '/api/custom', { revision: state.body.revision, pattern: 'before [word]', target: 'fuck', note: 'keep\nme' });
  assert.equal(created.status, 200);
  const reviewed = await request(address.port, 'POST', '/api/review', { revision: state.body.revision, id: created.body.id, status: 'accepted', pattern: 'before [word]', target: 'fuck', note: 'review\nnote' });
  assert.equal(reviewed.status, 200);
  for (const id of ['manual-lead', created.body.id]) {
    const current = await request(address.port, 'GET', '/api/state');
    const result = await request(address.port, 'POST', '/api/review', {
      revision: current.body.revision, id, status: 'accepted',
      pattern: 'before [word]', target: 'fuck', note: 'review\nnote'
    });
    assert.equal(result.status, 200);
  }
  await controller.close();
  controller = createServer(files);
  address = await controller.start(0);
  try {
    const afterRestart = await request(address.port, 'GET', '/api/state');
    assert.deepEqual(afterRestart.body.reviewHistory, ['manual-lead', created.body.id]);
    const custom = afterRestart.body.candidates.find(candidate => candidate.id === created.body.id);
    assert.equal(custom.review, 'accepted');
    assert.equal(custom.reviewDetails.note, 'review\nnote');
    assert.equal(custom.reviewDetails.pattern, 'before [word]');
    assert.match(custom.reviewDetails.timestamp, /^\d{4}-/u);
    assert.equal(custom.stale, false);
  } finally { await controller.close(); fs.rmSync(files.directory, { recursive: true, force: true }); }
});

test('does not append after an input lock or a corrupt trailing JSONL event', async () => withServer(async (port, files) => {
  const state = await request(port, 'GET', '/api/state');
  fs.writeFileSync(`${files.dataset}.lock`, '');
  const cached = await request(port, 'GET', '/api/state');
  assert.equal(cached.status, 200);
  assert.equal(cached.body.revision, state.body.revision);
  const locked = await request(port, 'POST', '/api/custom', { revision: state.body.revision, pattern: '[word]', target: 'fuck' });
  assert.equal(locked.status, 409);
  fs.rmSync(`${files.dataset}.lock`);
  fs.appendFileSync(files.output, '{"version":1,"type":"review"');
  const corrupt = await request(port, 'POST', '/api/custom', { revision: state.body.revision, pattern: '[word]', target: 'fuck' });
  assert.equal(corrupt.status, 503);
  assert.equal(fs.readFileSync(files.output, 'utf8').split('\n').filter(Boolean).length, 1);
}));

test('keeps CLI flags strict and defaults to port 8767', () => {
  assert.equal(parseArgs([]).port, 8767);
  assert.equal(parseArgs(['--port', '9000']).port, 9000);
  assert.throws(() => parseArgs(['--unknown', 'x']), /unknown flag/u);
  assert.throws(() => parseArgs(['--port=0']), /invalid/u);
});

test('rejects missing lead example IDs from a stable dataset', async () => {
  const files = fixture();
  const leads = JSON.parse(fs.readFileSync(files.leads, 'utf8'));
  leads.discovery.tiers['manual-auto'].leads[0].exampleIds = ['missing-row'];
  fs.writeFileSync(files.leads, JSON.stringify(leads));
  const controller = createServer(files);
  const address = await controller.start(0);
  try {
    const state = await request(address.port, 'GET', '/api/state');
    assert.equal(state.status, 503);
  } finally {
    await controller.close();
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('requires a restart when runtime rule files change', async () => withServer(async (port) => {
  const state = await request(port, 'GET', '/api/state');
  const ruleFile = path.join(__dirname, '..', 'src/rule-data/exact.js');
  const original = fs.readFileSync(ruleFile);
  try {
    fs.writeFileSync(ruleFile, Buffer.concat([original, Buffer.from('\n')]));
    const changed = await request(port, 'POST', '/api/custom', { revision: state.body.revision, pattern: 'changed [word]', target: 'fuck' });
    assert.equal(changed.status, 409);
  } finally {
    fs.writeFileSync(ruleFile, original);
  }
}));

test('guards output aliases', () => {
  const files = fixture();
  assert.throws(() => createServer({ ...files, output: files.dataset }), /alias/u);
  fs.rmSync(files.directory, { recursive: true, force: true });
});
