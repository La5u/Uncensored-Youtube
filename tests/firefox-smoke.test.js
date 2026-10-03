const test = require('node:test');
const assert = require('node:assert/strict');
const { options, validate, visibleSlotMatch, stopOwned, acquireLock, releaseLock, runtimeHashes } = require('../tools/firefox-smoke');
const { spawn, spawnSync } = require('child_process');
const config = { videoId: 'target', mode: 'whisper', until: 12, expected: ['shit'], seek: [5, 6] };
function fixture() {
  const sample = (time, epoch, at) => ({ type: 'sample', time, epoch, at, videoId: 'target',
    injected: true, webdriver: false, duration: 100, muted: true, volume: 0, ad: false, paused: false, ready: 4, text: 'shit', selectedTrack: {languageCode: 'en', kind: 'asr'}, ccButton: {pressed: 'true'} });
  return [{ type: 'mode', mode: 'whisper' },
    { type: 'captions', videoId: 'target', trackId: 'lang=en&kind=asr', blanks: 1, slots: [[7, 9, '[__]']] },
    { type: 'log', videoId: 'target', text: 'whisper model started' }, ...[0, 1, 2, 3, 4, 5].map(time => sample(time, 0, time * 1000)),
    sample(6, 1, 6000), { type: 'log', text: 'whisper resolved "shit" lead 1.0s', time: 6, epoch: 1, videoId: 'target', at: 6500 },
    ...[7, 8, 9, 10, 11, 12].map(time => sample(time, 1, time * 1000))];
}
test('CLI safety guards reject before launching browsers', () => {
  const tool = require.resolve('../tools/browser-smoke');
  for (const [args, message] of [
    [['--chromium-only', '--initial-only'], /require --workspace/],
    [['--headless', '--initial-only', '--pause=2'], /Unsupported Firefox flag/]
  ]) {
    const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
});
test('runtime pin detects changed packaged code', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uncensored-hashes-'));
  try {
    fs.writeFileSync(path.join(dir, 'runtime.js'), 'original');
    const original = runtimeHashes(dir);
    fs.writeFileSync(path.join(dir, 'note.txt'), 'not packaged');
    assert.deepEqual(runtimeHashes(dir), original);
    fs.writeFileSync(path.join(dir, 'runtime.js'), 'changed');
    assert.notDeepEqual(runtimeHashes(dir), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('native playback, seek and correlated visible restoration', () => assert.equal(validate(fixture(), config).passed, true));
for (const [name, change, expected] of [
  ['empty DOM', e => { if (e.type === 'sample') e.text = ''; }, /Empty visible/],
  ['wrong video', e => { if (e.type === 'sample') e.videoId = 'wrong'; }, /wrong video/],
  ['webdriver', e => { if (e.type === 'sample') e.webdriver = true; }, /Non-native/],
  ['manual visible captions', e => { if (e.type === 'sample') e.selectedTrack.kind = ''; }, /English automatic/],
  ['manual raw track', e => { if (e.type === 'captions') e.trackId = 'lang=en&kind='; }, /timedtext/],
  ['not muted', e => { if (e.type === 'sample') e.muted = false; }, /not muted/],
  ['nonzero volume', e => { if (e.type === 'sample') e.volume = 0.1; }, /not muted/],
  ['worker missing', e => { if (e.text === 'whisper model started') e.text = ''; }, /Worker/],
  ['post-seek missing', e => { if (e.type === 'log') e.epoch = 0; }, /post-decision/],
  ['natural word outside slot', e => { if (e.type === 'captions') e.slots = [[30, 32]]; }, /visible replacement/],
  ['no original blanks', e => { if (e.type === 'captions') e.blanks = 0; }, /timedtext/],
  ['no progress', e => { if (e.type === 'sample' && e.epoch === 0) e.time = 0; }, /progress/]
]) test(`rejects ${name}`, () => { const events = fixture(); events.forEach(change); assert.throws(() => validate(events, config), expected); });
test('off and rules have separate gates and need no worker', () => {
  const events = fixture().filter(e => e.type !== 'log');
  events[0].mode = 'off'; events.filter(e => e.type === 'sample').forEach(e => { e.text = '[__]'; });
  assert.equal(validate(events, { ...config, mode: 'off' }).passed, true);
  events[0].mode = 'rules'; events.push({ type: 'log', text: 'captions analyzed' });
  events.filter(e => e.type === 'sample').forEach(e => { e.text = 'shit'; });
  assert.equal(validate(events, { ...config, mode: 'rules' }).passed, true);
});
test('flags, aliases and single URL contract', () => {
  const base = ['--initial-only'];
  assert.equal(options(base).until, 90); assert.equal(options(base).rate, 1);
  assert.equal(options([...base, '--mode=hybrid']).mode, 'whisper-first');
  for (const flag of ['--pause=2', '--auto-next=1', '--via=home', '--unknown']) assert.throws(() => options([...base, flag]), /Unsupported/);
  assert.throws(() => options([]), /initial-only/);
  assert.throws(() => options([...base, 'https://www.youtube.com/watch?v=a', 'https://www.youtube.com/watch?v=b']), /one URL/);
});
test('cleanup signals only its owned process group', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise(resolve => child.once('spawn', resolve));
  await stopOwned(child);
  assert.ok(child.signalCode);
  await stopOwned(child);
  await stopOwned(undefined);
});

test('timing must be finite', () => {
  for (const flag of ['--until=Infinity', '--until=NaN', '--until=no', '--rate=Infinity', '--rate=NaN'])
    assert.throws(() => options(['--initial-only', flag]), /timing/);
  assert.equal(options(['--initial-only']).videoId, 'an5iFYcjWUM');
});
test('shared lock refuses competitors and releases ownership', async () => {
  const lock = await acquireLock();
  try { await assert.rejects(acquireLock(), /already running/); }
  finally { await releaseLock(lock); }
  const next = await acquireLock();
  await releaseLock(next);
});
test('cleanup escalates a timed-out owned group', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => child.stdout.once('data', resolve));
  await stopOwned(child);
  assert.equal(child.signalCode, 'SIGKILL');
});
test('spawn failure cleanup is bounded', async () => {
  const child = spawn('/nonexistent-uncensored-smoke', [], { detached: true });
  await new Promise(resolve => child.once('error', resolve));
  await stopOwned(child);
});
test('isolated console captures actual debug with latest epoch and JSON objects', () => {
  const vm = require('vm'), fs = require('fs');
  const events = [], listeners = {}, storage = {};
  const context = { SMOKE: { token: 'token', videoId: 'target' },
    console: Object.fromEntries(['debug', 'log', 'warn', 'error'].map(level => [level, () => {}])),
    localStorage: { setItem: (k, v) => { storage[k] = v; } },
    browser: { runtime: { sendMessage: data => { events.push(data.firefoxSmoke); return Promise.resolve(); } },
      storage: { local: { get: () => Promise.resolve({mode: 'whisper'}) } } },
    window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    document: { documentElement: { appendChild() {} }, createElement: () => ({dataset: {}}) } };
  context.browser.runtime.getURL = name => name;
  vm.runInNewContext(fs.readFileSync(require.resolve('../tools/firefox-smoke-content.js'), 'utf8'), context);
  listeners['firefox-smoke']({detail: JSON.stringify({type: 'seek', videoId: 'target', epoch: 1, time: 6})});
  context.console.debug('[uncensored] whisper model started', {ready: true});
  assert.equal(storage.uncensoredDebug, '1');
  assert.equal(events.at(-1).epoch, 1);
  assert.equal(events.at(-1).time, 6);
  assert.match(events.at(-1).text, /"ready":true/);
});
test('page timedtext JSON preserves late track identity', () => {
  const vm = require('vm'), fs = require('fs'), events = [], listeners = {};
  const context = { console: Object.fromEntries(['debug', 'log', 'warn', 'error'].map(level => [level, () => {}])),
    localStorage: {setItem() {}}, MutationObserver: class {observe() {}}, setInterval() {},
    CustomEvent: class {constructor(type, data) {this.type = type; this.detail = data.detail;}},
    window: {dispatchEvent: event => events.push(JSON.parse(event.detail)), addEventListener: (name, fn) => {listeners[name] = fn;}},
    document: {currentScript: {dataset: {config: '{}'}}, documentElement: {}, querySelectorAll: () => [],
      querySelector: selector => selector === '#movie_player' ? {getVideoData: () => ({video_id: 'new'})} : {currentTime: 3}} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../tools/firefox-smoke-page.js'), 'utf8'), context);
  listeners['uncensored-timedtext']({detail: JSON.stringify({videoId: 'old', body: {events: [{tStartMs: 1000, dDurationMs: 2000, segs: [{utf8: '[__]'}]}]}})});
  assert.equal(events[0].videoId, 'old');
  assert.equal(events[0].blanks, 1);
  assert.deepEqual(events[0].slots, [[1, 3, '[__]']]);
});

for (const [raw, visible, word, expected] of [
  ['What [__] now?', 'previous WHAT, Shit now! next', 'shit', true],
  ['shit [__] now', 'shit [__] now', 'shit', false],
  ['shit [__] now', 'shit hell now', 'shit', false],
  ['a [__] and [__] end', 'a shit and hell end', 'shit', true],
  ['a [__] and [__] end', 'a shit and [__] end', 'shit', true],
  ['[__]', 'shit [__]', 'shit', false],
  ['[__]', 'earlier shit later', 'shit', false],
  ['', 'shit', 'shit', false], ['normal shit', 'normal shit', 'shit', false]
]) test('raw slot match: ' + raw + ' -> ' + visible, () => assert.equal(visibleSlotMatch(raw, visible, word), expected));
test('rules requires explicit expected restoration', () => assert.throws(() => options(['--initial-only', '--mode=rules']), /requires --expect/));
test('lead summary includes late resolutions', () => {
  const events = fixture();
  events.push({type: 'log', videoId: 'target', text: 'whisper resolved "hell" lead -0.5s'});
  const result = validate(events, config);
  assert.equal(result.resolvedWords, 2); assert.equal(result.late, 1); assert.equal(result.minLead, -0.5);
});
for (const [name, change] of [
  ['legacy raw slots', e => {if (e.type === 'captions') e.slots = [[7, 9]];}],
  ['natural fixed word with blank', e => {if (e.type === 'captions') e.slots = [[7, 9, 'shit [__] now']]; if(e.type === 'sample') e.text = 'shit [__] now';}],
  ['paused', e => {if(e.type === 'sample') e.paused = true;}],
  ['not ready', e => {if(e.type === 'sample') e.ready = 0;}],
  ['video error', e => {if(e.type === 'sample') e.error = 3;}],
  ['worker error', e => {if(e.text === 'whisper model started') e.text += ' worker failed';}]
]) test('strict gate rejects ' + name, () => {const events = fixture(); events.forEach(change); assert.throws(() => validate(events, config));});
