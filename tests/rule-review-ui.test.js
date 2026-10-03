const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../tools/rule-review.html'), 'utf8');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const helperCode = between('    function filterCandidates(', '    function filtersFromControls(');
const candidate = (id, review = 'pending', tier = 'manual-auto') => ({ id, review, tier, target: 'shit', pattern: 'oh [word]' });
const context = vm.createContext({ Set, Map, String, Object, Array });
vm.runInContext(helperCode, context);
vm.runInContext(between('    function reviewShortcut(', "    document.addEventListener('keydown'"), context);

test('visible shortcuts cover judgments, narrowing, generalization, skip and editing', () => {
  for (const [key, action] of Object.entries({ a: 'accepted', r: 'rejected', n: 'narrow', g: 'generalize', s: 'skip', e: 'edit' })) {
    assert.equal(context.reviewShortcut({ key }), action);
    assert.equal(context.reviewShortcut({ key: key.toUpperCase() }), action);
    assert.equal(context.reviewShortcut({ key, typing: true }), null);
    assert.equal(context.reviewShortcut({ key, repeat: true }), null);
    assert.equal(context.reviewShortcut({ key, ctrlKey: true }), null);
  }
  assert.equal(context.reviewShortcut({ key: 'Enter', ctrlKey: true, typing: true }), 'save-edit');
  assert.equal(context.reviewShortcut({ key: 'Enter', metaKey: true, typing: true }), 'save-edit');
  assert.match(html, /Keyboard:.*too broad.*too narrow/);
});

test('multi-wildcard patterns are hidden by default without deleting them', () => {
  const items = [candidate('literal'), { ...candidate('one'), pattern: 'oh * [word]' },
    { ...candidate('many'), pattern: 'oh * * [word] *' }];
  assert.deepEqual(context.filterCandidates(items, {}).map(item => item.id), ['literal', 'one']);
  assert.deepEqual(context.filterCandidates(items, { showWildcards: true }).map(item => item.id), ['literal', 'one', 'many']);
  assert.equal(items.length, 3);
});

function harness({ fail = false, conflict = false } = {}) {
  const candidateB = candidate('b');
  const state = { detail: candidateB, drafts: { b: { pattern: 'oh [word]', target: 'shit', note: 'keep me', status: 'pending', dirty: true } }, busyCount: 0 };
  const saved = [];
  const errors = [];
  const saveCode = between('    async function saveReview(', '    function skipCandidate(');
  const local = vm.createContext({
    state,
    statuses: ['pending', 'accepted', 'rejected', 'generalize', 'narrow', 'suggestion'],
    currentDraft: () => state.drafts.b,
    draftFor: () => state.drafts.b,
    reviewRequest: context.reviewRequest,
    setBusy: busy => { state.busyCount += busy ? 1 : -1; },
    toast: () => {},
    showSaveError: message => errors.push(message),
    post: async (route, body) => {
      if (conflict) throw Object.assign(new Error('stale revision'), { status: 409 });
      if (fail) throw new Error('save failed');
      saved.push({ route, body });
    },
    load: async () => { state.current = conflict ? 'b' : 'next'; }
  });
  vm.runInContext(saveCode, local);
  return { state, saved, errors, save: status => local.saveReview(candidateB, status) };
}

test('accepted, rejected, and request choices map to an auto-advanceable status', () => {
  assert.equal(context.judgmentStatus('too broad'), 'narrow');
  assert.equal(context.judgmentStatus('too narrow'), 'generalize');
  assert.equal(context.judgmentStatus('different wording'), 'suggestion');
  const items = [candidate('a'), candidate('b'), candidate('c', 'accepted'), candidate('d')];
  for (const status of ['accepted', 'rejected', 'narrow', 'generalize', 'suggestion']) {
    const updated = items.map(item => item.id === 'b' ? { ...item, review: status } : item);
    assert.equal(context.nextPending(updated, 'b', { pendingOnly: true }), 'd');
  }
});

test('filter matching is target, tier, status, search, and pending aware', () => {
  const items = [candidate('a', 'pending', 'manual-auto'), candidate('b', 'accepted', 'synthetic')];
  assert.deepEqual(context.filterCandidates(items, { search: 'oh [word]', target: 'shit', tier: 'manual-auto', review: 'pending', pendingOnly: true }).map(item => item.id), ['a']);
  assert.deepEqual(context.filterCandidates(items, { search: '', target: '', tier: '', review: '', pendingOnly: false }).map(item => item.id), ['a', 'b']);
});

test('representative examples include contradictions, including other-tier, and stop at three', () => {
  const examples = {
    counterexample: { items: [{ id: 'other-contradiction', tier: 'synthetic', labelStatus: 'known', expected: 'clean' }] },
    positive: { items: [{ id: 'p1', labelStatus: 'known', expected: 'shit' }, { id: 'p2', labelStatus: 'known', expected: 'shit' }, { id: 'p3', labelStatus: 'known', expected: 'shit' }] },
    unknown: { items: [{ id: 'u1', labelStatus: 'unknown' }] }
  };
  const result = context.representativeExamples(examples, 'shit');
  assert.equal(result.length, 3);
  assert.equal(result[0].id, 'other-contradiction');
  assert.ok(result.some(example => example.id === 'other-contradiction'));
});

test('skip is session-only and does not create a review request', () => {
  const skipCode = between('    function skipCandidate(', '    async function preview(');
  const state = { items: [candidate('a'), candidate('b')], current: 'a', skipped: new Set(), busyCount: 0 };
  const main = { innerHTML: '' };
  let writes = 0;
  const local = vm.createContext({
    state,
    nextPending: context.nextPending,
    filtersFromControls: () => ({ pendingOnly: true }),
    selectCandidate: id => { state.current = id; },
    renderFilters: () => {},
    $: () => main,
    post: () => { writes += 1; }
  });
  vm.runInContext(skipCode, local);
  local.skipCandidate('a');
  assert.equal(state.current, 'b');
  assert.equal(state.items[0].review, 'pending');
  assert.equal(writes, 0);
});

test('saved review history is restored once, in order, excluding missing candidates', () => {
  const state = { items: [candidate('a', 'accepted'), candidate('b', 'rejected')], history: [], historyLoaded: false };
  const local = vm.createContext({ state, Set, Array });
  vm.runInContext(between('    function restoreHistory(', '    function rememberRule('), local);
  local.restoreHistory(['a', 'gone', 'b']);
  assert.deepEqual(Array.from(state.history), ['a', 'b']);
  state.history.pop();
  local.restoreHistory(['a', 'b']);
  assert.deepEqual(Array.from(state.history), ['a']);
});

test('previous rule revisits reviewed rules without filters and retains history on cancel or failure', async () => {
  const state = { current: 'a', drafts: {}, history: [], busyCount: 0, requestToken: 0 };
  const main = { innerHTML: '' };
  let fail = false;
  let confirm = true;
  const local = vm.createContext({
    state,
    window: { confirm: () => confirm },
    $: () => main,
    get: async () => {
      if (fail) throw new Error('offline');
      return { candidate: candidate(state.current, 'accepted') };
    },
    setBusy: busy => { state.busyCount += busy ? 1 : -1; },
    syncBusy: () => {},
    renderCurrent: () => {},
    loadRepresentatives: async () => {},
    renderError: () => {}
  });
  vm.runInContext(between('    function rememberRule(', '    function renderCurrent('), local);
  await local.selectCandidate('b');
  await local.selectCandidate('c');
  assert.deepEqual(state.history, ['a', 'b']);
  state.drafts.c = { dirty: true };
  confirm = false;
  await local.previousRule();
  assert.equal(state.current, 'c');
  assert.deepEqual(state.history, ['a', 'b']);
  confirm = true;
  fail = true;
  await local.previousRule();
  assert.deepEqual(state.history, ['a', 'b']);
  fail = false;
  await local.previousRule();
  assert.equal(state.current, 'b');
  assert.equal(state.detail.review, 'accepted');
  assert.deepEqual(state.history, ['a']);
  await local.previousRule();
  assert.equal(state.current, 'a');
  assert.equal(state.history.length, 0);
  assert.equal(state.drafts.c.dirty, true);
  await local.previousRule();
  assert.equal(state.current, 'a');
});

test('previous rule remains available after skipping the final pending rule', () => {
  const state = { items: [candidate('a')], current: 'a', detail: candidate('a'), skipped: new Set(), history: [], busyCount: 0 };
  const local = vm.createContext({
    state,
    nextPending: context.nextPending,
    filtersFromControls: () => ({ pendingOnly: true }),
    renderFilters: () => {},
    syncBusy: () => {},
    $: () => ({ innerHTML: '' })
  });
  vm.runInContext(between('    function rememberRule(', '    async function previousRule('), local);
  vm.runInContext(between('    function skipCandidate(', '    async function preview('), local);
  local.skipCandidate('a');
  assert.equal(state.current, null);
  assert.equal(state.detail, null);
  assert.deepEqual(state.history, ['a']);
});

test('failed save preserves the current draft and does not advance', async () => {
  const h = harness({ fail: true });
  await h.save('accepted');
  assert.equal(h.state.current, undefined);
  assert.equal(h.state.drafts.b.dirty, true);
  assert.equal(h.saved.length, 0);
  assert.match(h.errors[0], /save failed/);
});

test('409 refreshes the stale rule for retry without advancing or losing its draft', async () => {
  const h = harness({ conflict: true });
  await h.save('accepted');
  assert.equal(h.state.current, 'b');
  assert.equal(h.state.drafts.b.dirty, true);
  assert.match(h.errors[0], /stale revision/);
});

test('reviewDetails draft values are restored before editing', () => {
  const draftCode = between('    function draftFor(', '    function currentDraft(');
  const local = vm.createContext({ state: { drafts: {} } });
  vm.runInContext(draftCode, local);
  const result = local.draftFor({ id: 'x', pattern: 'mined [word]', target: 'word', review: 'pending', reviewDetails: { pattern: 'edited [word]', target: 'edited', note: 'drafted', status: 'suggestion' } });
  assert.deepEqual({ pattern: result.pattern, target: result.target, note: result.note, status: result.status }, { pattern: 'edited [word]', target: 'edited', note: 'drafted', status: 'suggestion' });
});

test('advanced details and metrics are hidden by default', () => {
  assert.match(html, /<details id="moreDetails" class="advanced">/);
  assert.doesNotMatch(html, /<details id="moreDetails"[^>]*open/);
  assert.doesNotMatch(html.slice(html.indexOf('<main'), html.indexOf('</main>')), /Precision|confidence|precision/);
  assert.match(html, /Candidate ID:/);
  assert.match(html, /renderExampleList\(\s*\$\('#representatives'\)[\s\S]*?candidate\.target,\s*true/);
  assert.match(html, /renderExampleList\(\$\('#allExamples'\)[\s\S]*?candidate\.target, false\)/);
});

test('compact representative excerpts highlight the selected second marker with bounded context', () => {
  const dom = {
    createTextNode: text => ({ type: 'text', text }),
    createElement: () => ({ type: 'mark', className: '', textContent: '' })
  };
  const local = vm.createContext({ document: dom });
  const captionCode = between('    function captionExcerpt(', '    function metricValue(');
  vm.runInContext(captionCode, local);
  const before = Array.from({ length: 10 }, (_, i) => `before${i}`).join(' ');
  const after = Array.from({ length: 10 }, (_, i) => `after${i}`).join(' ');
  const contextText = `${before} first marker middle\u00a0marker ${after}`;
  const firstMarker = contextText.indexOf('marker');
  const targetOffset = contextText.indexOf('marker', firstMarker + 1);
  const box = { parts: [], append(...parts) { this.parts.push(...parts); } };
  local.appendCaption(box, { context: contextText, targetOffset, targetSpan: 6 }, true);
  const mark = box.parts.find(part => part.type === 'mark');
  assert.equal(mark.textContent, 'marker');
  assert.equal(box.parts.filter(part => part.type === 'text' && part.text === '…').length, 2);
  const rendered = box.parts.map(part => part.type === 'mark' ? `[${part.textContent}]` : part.text).join('');
  assert.equal(rendered, '…before5 before6 before7 before8 before9 first marker middle\u00a0[marker] after0 after1 after2 after3 after4 after5 after6 after7…');
});

test('advanced example rendering keeps the full original context', () => {
  const dom = {
    createTextNode: text => ({ type: 'text', text }),
    createElement: () => ({ type: 'mark', className: '', textContent: '' })
  };
  const local = vm.createContext({ document: dom });
  vm.runInContext(between('    function captionExcerpt(', '    function metricValue('), local);
  const text = 'left\u00a0context second marker right';
  const start = text.indexOf('second');
  const box = { parts: [], append(...parts) { this.parts.push(...parts); } };
  local.appendCaption(box, { context: text, targetOffset: start, targetSpan: 6 });
  assert.equal(box.parts.filter(part => part.type === 'text' && part.text === '…').length, 0);
  assert.equal(box.parts.map(part => part.type === 'mark' ? part.textContent : part.text).join(''), text);
});
