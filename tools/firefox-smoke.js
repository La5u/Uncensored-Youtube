const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const aliases = { 'rules-only': 'rules', 'whisper-only': 'whisper', hybrid: 'whisper-first', 'both-off': 'off' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function options(args) {
  const allowed = /^(--firefox-only|--headless|--workspace|--initial-only|--verbose|--direct|--mode=.+|--until=.+|--rate=.+|--seek=.+|--expect=.+|--artifacts=.+|https:\/\/.*)$/;
  for (const arg of args) if (!allowed.test(arg)) throw Error(`Unsupported Firefox flag: ${arg}`);
  const urls = args.filter(arg => arg.startsWith('https://'));
  if (urls.length > 1 || !args.includes('--initial-only')) throw Error('Firefox supports one URL with --initial-only only (no SPA/playlist coverage).');
  const get = (key, fallback) => args.find(arg => arg.startsWith(`--${key}=`))?.split('=').slice(1).join('=') ?? fallback;
  const url = urls[0] || 'https://www.youtube.com/watch?v=an5iFYcjWUM';
  const parsed = new URL(url);
  if (parsed.hostname !== 'www.youtube.com' || parsed.pathname !== '/watch' || !parsed.searchParams.get('v') || parsed.searchParams.has('list')) throw Error('Firefox requires a single YouTube watch URL without playlist.');
  const mode = aliases[get('mode')] || get('mode', 'whisper-first');
  const until = Number(get('until', 90)), rate = Number(get('rate', 1));
  const seek = get('seek')?.split(':').map(Number);
  if (!['off', 'rules', 'rules-first', 'whisper-first', 'whisper'].includes(mode) || !Number.isFinite(until) || !Number.isFinite(rate) || !(until > 0) || !(rate > 0) ||
      (seek && (seek.length !== 2 || !seek.every(n => Number.isFinite(n) && n >= 0) || until <= seek[1]))) throw Error('Invalid Firefox mode/timing.');
  if (mode === 'rules' && !get('expect', '').trim()) throw Error('Rules mode requires --expect (recommended for the default an5 video: --expect=shit).');
  return { url, videoId: parsed.searchParams.get('v'), mode, until, rate, seek,
    expected: get('expect', '').toLowerCase().split(',').filter(Boolean), artifacts: get('artifacts') };
}
// Match the whole raw slot, allowing rolling neighboring captions at word boundaries.
function visibleSlotMatch(raw, visible, word) {
  const normalize = text => String(text ?? '').toLowerCase().replace(/\[\s*__\s*\]/g, ' smokeblank ').replace(/[^\p{L}\p{N}']+/gu, ' ').trim();
  const parts = normalize(raw).split('smokeblank');
  if (parts.length < 2) return false;
  if (normalize(raw) === 'smokeblank') return normalize(visible) === normalize(word);
  const escape = text => text.trim().split(/\s+/).filter(Boolean).map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const pattern = parts.map(escape).join('\\s*([\\p{L}\\p{N}\\s\']+?)\\s*');
  const text = normalize(visible);
  for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}'])${pattern}(?![\\p{L}\\p{N}'])`, 'gu'))) {
    const replacements = match.slice(1);
    if (replacements.some(value => !value.includes('smokeblank') &&
        value.trim().split(/\s+/).includes(normalize(word)))) return true;
  }
  return false;
}
function validate(events, config) {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  assert(events.some(e => e.type === 'mode' && e.mode === config.mode), 'Mode not confirmed');
  const samples = events.filter(e => e.type === 'sample');
  assert(samples.length > 2, 'Missing playback telemetry');
  assert(samples.every(e => e.injected && e.webdriver === false && e.videoId === config.videoId && e.duration > config.until && !e.ad), 'Non-native, wrong video, ad, or invalid duration');
  assert(samples.every(e => e.muted && e.volume === 0), 'Playback not muted at zero volume');
  assert(samples.some(e => e.time >= config.until), 'Playback target not reached');
  for (const epoch of config.seek ? [0, 1] : [0]) {
    const group = samples.filter(e => e.epoch === epoch);
    let progress = 0;
    for (let i = 1; i < group.length; i++) {
      const a = group[i - 1], b = group[i], wall = (b.at - a.at) / 1000, media = b.time - a.time;
      if (a.paused === false && b.paused === false && a.ready > 0 && b.ready > 0 && wall > 0 && wall <= 2 && media > 0 && media <= wall * (config.rate || 1) * 1.5 + 0.2) progress += wall;
    }
    assert(progress >= 5, 'Missing actual playback progress');
  }
  if (config.seek) assert(samples.some(e => e.epoch === 1 && Math.abs(e.time - config.seek[1]) < 2), 'Seek did not land');
  const captions = samples.filter(e => e.text?.trim());
  assert(captions.length, 'Empty visible caption DOM');
  assert(captions.every(c => c.selectedTrack?.languageCode === 'en' && c.selectedTrack.kind === 'asr' && c.ccButton?.pressed === 'true'), 'Visible captions are not confirmed English automatic captions');
  const tracks = events.filter(e => e.type === 'captions' && e.videoId === config.videoId &&
    new URLSearchParams(e.trackId).get('lang') === 'en' && new URLSearchParams(e.trackId).get('kind') === 'asr');
  assert(tracks.some(e => e.blanks > 0), 'No original timedtext blanks');
  const slots = tracks.flatMap(e => e.slots || []);
  const atSlot = (c, slot) => slot.length === 3 && c.time >= slot[0] && c.time <= slot[1];
  const restored = (c, word) => slots.some(slot => atSlot(c, slot) && visibleSlotMatch(slot[2], c.text, word));
  assert(!samples.some(e => e.error) && !events.some(e => e.type === 'videoerror' ||
    (e.type === 'log' && e.videoId === config.videoId && /(?:whisper|worker).*(?:error|failed|failure)/i.test(e.text))), 'Worker or video error');
  if (config.mode === 'off') assert(captions.some(c => slots.some(slot => atSlot(c, slot) &&
    visibleSlotMatch(slot[2], c.text.replace(/\[\s*__\s*\]/g, 'smokeoffmarker'), 'smokeoffmarker'))), 'Off mode did not retain blanks at original slot');
  else {
    if (config.mode === 'rules') assert(config.expected?.length, 'Rules mode requires --expect');
    for (const word of config.expected) assert(captions.some(e => restored(e, word)), `Expected visible replacement missing: ${word}`);
    if (config.mode === 'rules') assert(events.some(e => e.type === 'log' && e.text.includes('captions analyzed')) &&
      captions.some(e => !/\[\s*__\s*\]/.test(e.text)), 'Rules analysis/visible output missing');
  }
  if (!['off', 'rules'].includes(config.mode)) {
    assert(events.some(e => e.type === 'log' && e.videoId === config.videoId &&
      /whisper model (started|ready)/.test(e.text)), 'Worker not ready');
    const resolved = events.filter(e => e.type === 'log' && /whisper resolved "(.+?)"/.test(e.text));
    const correlate = epoch => resolved.some(e => {
      const lead = e.text.match(/lead (-?[\d.]+)s/);
      const target = e.time + Number(lead?.[1]);
      return lead && e.videoId === config.videoId && e.epoch === epoch &&
        tracks.some(track => track.slots?.some(slot => slot.length === 3 && target >= slot[0] && target <= slot[1] &&
            captions.some(c => c.videoId === e.videoId && c.epoch === epoch && c.at >= e.at && atSlot(c, slot) &&
              visibleSlotMatch(slot[2], c.text, e.text.match(/whisper resolved "(.+?)"/)[1]))));
    });
    assert(correlate(config.seek ? 1 : 0), 'Missing post-decision visible audio word (post-seek when requested)');
  }
  const leads = events.filter(e => e.type === 'log' && e.videoId === config.videoId && /whisper resolved "/.test(e.text))
    .map(e => Number(e.text.match(/lead (-?[\d.]+)s/)?.[1])).filter(Number.isFinite);
  return { passed: true, samples: samples.length, captions: captions.length,
    resolvedWords: leads.length, late: leads.filter(lead => lead < 0).length, minLead: leads.length ? Math.min(...leads) : null };
}
async function acquireLock() {
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  const lock = spawn('flock', ['-n', path.join(root, 'tmp/browser-smoke.lock'), 'sh', '-c', 'echo locked; cat >/dev/null'], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  lock.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Smoke lock timed out')), 3000);
      const done = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      lock.once('error', done);
      lock.once('exit', () => done(Error('Browser smoke already running or flock unavailable')));
      lock.stdout.once('data', () => done());
    });
    return lock;
  } catch (error) { await stopOwned(lock); throw error; }
}
async function releaseLock(lock) {
  if (!lock?.pid) return;
  lock.stdin.end();
  if (lock.exitCode === null && lock.signalCode === null)
    await Promise.race([new Promise(resolve => lock.once('exit', resolve)), delay(3000)]);
  if (lock.exitCode === null && lock.signalCode === null) await stopOwned(lock);
}
async function stopOwned(child) {
  if (!child?.pid) return;
  const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() :
    new Promise(resolve => child.once('exit', resolve));
  const signal = name => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  // The owned process group may still contain descendants after the leader exits.
  signal('SIGKILL');
  await Promise.race([exited, delay(3000)]);
}
function runtimeHashes(directory, prefix = '') {
  return Object.fromEntries(fs.readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name), key = prefix + name;
    return fs.statSync(file).isDirectory() ? Object.entries(runtimeHashes(file, key + '/')) :
      /\.(js|mjs|json|html|css|png|wasm|onnx)$/.test(name) ? [[key, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]] : [];
  }));
}
async function run(args = process.argv.slice(2)) {
  const config = options(args);
  const supplies = fs.readdirSync('/sys/class/power_supply').map(name => `/sys/class/power_supply/${name}`);
  const read = (dir, key) => fs.existsSync(`${dir}/${key}`) ? fs.readFileSync(`${dir}/${key}`, 'utf8').trim() : '';
  if (supplies.some(dir => read(dir, 'type') === 'Battery') &&
      !supplies.some(dir => read(dir, 'type') !== 'Battery' && read(dir, 'online') === '1'))
    throw Error('Refusing heavy Firefox inference without confirmed AC power');
  const artifacts = path.resolve(config.artifacts || path.join(root, 'tmp', `firefox-smoke-${Date.now()}-${process.pid}`));
  if (!artifacts.startsWith(path.join(root, 'tmp') + path.sep)) throw Error('Artifacts must be under ignored tmp/');
  if (fs.existsSync(artifacts)) throw Error('Artifacts directory already exists');
  fs.mkdirSync(artifacts, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex'), events = [];
  const profile = path.join(artifacts, 'profile'), extension = path.join(artifacts, 'extension');
  let server, child, lock, sink, log;
  let result, interrupted;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    // flock inode persists: never unlink it. The wrapper holds the lock until stdin closes.
    lock = await acquireLock();
    const processes = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    if (processes.split('\n').some(line => /^\s*\d+\s+\S*(?:firefox|chromium|web-ext)\b/.test(line) &&
        /uncensored[-_]smoke|uncensored-(?:chromium|firefox)-smoke|web-ext.*(?:dist\/|\/extension)/.test(line)))
      throw Error('Another smoke browser is running');
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== `/${token}`) { res.writeHead(404).end(); return; }
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        try { const event = JSON.parse(body); if (event.token !== token || events.length >= 100000) throw Error('invalid telemetry');
          events.push(event); fs.appendFileSync(path.join(artifacts, 'telemetry.jsonl'), JSON.stringify(event) + '\n'); res.writeHead(204).end();
        } catch (_) { res.writeHead(400).end(); }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const staged = { ...config, token, endpoint: `http://127.0.0.1:${server.address().port}/${token}` };
    fs.cpSync(path.join(root, 'dist/firefox'), extension, { recursive: true });
    const hashes = runtimeHashes(path.join(extension, 'src'));
    if (JSON.stringify(hashes) !== JSON.stringify(runtimeHashes(path.join(root, 'src'))))
      throw Error('Firefox build is stale; rebuild before testing');
    fs.writeFileSync(path.join(artifacts, 'runtime-hashes.json'), JSON.stringify(hashes, null, 2));
    fs.mkdirSync(profile);
    const manifestPath = path.join(extension, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.permissions = [...new Set([...manifest.permissions, 'tabs', 'webRequest'])];
    manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'https://www.youtube.com/*', 'https://*.googlevideo.com/*', 'http://127.0.0.1/*'])];
    manifest.background.scripts.push('firefox-smoke-background.js');
    manifest.content_scripts.unshift({ matches: ['https://www.youtube.com/*'], js: ['firefox-smoke-content.js'], run_at: 'document_start' });
    manifest.web_accessible_resources.push({ resources: ['firefox-smoke-page.js'], matches: ['https://www.youtube.com/*'] });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(extension, 'firefox-smoke-background.js'),
      `browser.runtime.onMessage.addListener(message => { if (message?.firefoxSmoke?.token === ${JSON.stringify(token)}) return fetch(${JSON.stringify(staged.endpoint)}, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(message.firefoxSmoke)}).then(() => true); });\n` +
      `const reportNetwork = details => { const url = new URL(details.url); if (!url.pathname.includes('timedtext')) return; fetch(${JSON.stringify(staged.endpoint)}, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token:${JSON.stringify(token)}, type:'network', at:Date.now(), host:url.hostname, path:url.pathname, status:details.statusCode, error:details.error || null})}).catch(() => {}); };\n` +
      `browser.webRequest.onCompleted.addListener(reportNetwork, {urls:['https://www.youtube.com/*','https://*.googlevideo.com/*']}); browser.webRequest.onErrorOccurred.addListener(reportNetwork, {urls:['https://www.youtube.com/*','https://*.googlevideo.com/*']});\n` +
      `browser.storage.local.set({mode:${JSON.stringify(config.mode)}}).then(() => browser.tabs.create({url:${JSON.stringify(config.url)}}));`);
    fs.writeFileSync(path.join(extension, 'firefox-smoke-content.js'), `const SMOKE = ${JSON.stringify(staged)};\n` + fs.readFileSync(path.join(__dirname, 'firefox-smoke-content.js'), 'utf8'));
    fs.copyFileSync(path.join(__dirname, 'firefox-smoke-page.js'), path.join(extension, 'firefox-smoke-page.js'));
    fs.writeFileSync(path.join(profile, 'user.js'), 'user_pref("media.volume_scale", "0");\nuser_pref("media.cubeb.backend", "pulse");\nuser_pref("media.autoplay.default", 0);\n');
    const defaultSink = execFileSync('pactl', ['get-default-sink'], { encoding: 'utf8' }).trim();
    const sinkName = `uncensored_smoke_${process.pid}_${token.slice(0, 8)}`;
    sink = execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${sinkName}`], { encoding: 'utf8' }).trim();
    execFileSync('pactl', ['set-sink-mute', sinkName, '1']);
    execFileSync('pactl', ['set-sink-volume', sinkName, '0%']);
    const sinkState = JSON.parse(execFileSync('pactl', ['-f', 'json', 'list', 'sinks'], { encoding: 'utf8' }))
      .find(item => item.name === sinkName);
    if (!sinkState?.mute || !Object.values(sinkState.volume).every(channel => channel.value === 0) ||
        execFileSync('pactl', ['get-default-sink'], { encoding: 'utf8' }).trim() !== defaultSink)
      throw Error('Null sink not silent or global default changed');
    fs.writeFileSync(path.join(artifacts, 'audio-isolation.json'), JSON.stringify({ name: sinkName, index: sinkState.index, muted: true, volume: 0, defaultSink }, null, 2));
    log = fs.createWriteStream(path.join(artifacts, 'browser.log'));
    child = spawn('web-ext', ['run', '--source-dir', extension, '--firefox', '/usr/bin/firefox', '--firefox-profile', profile,
      '--keep-profile-changes', '--start-url', 'about:blank', '--no-reload', '--no-input', '--arg=-headless'],
    { cwd: root, detached: true, env: { ...process.env, PULSE_SINK: sinkName, MOZ_HEADLESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let launchError;
    child.on('error', error => { launchError = error; });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    const deadline = Date.now() + ((config.until + (config.seek?.[0] || 0)) / config.rate + 180) * 1000;
    let lastError;
    while (Date.now() < deadline) {
      if (supplies.some(dir => read(dir, 'type') === 'Battery') &&
          !supplies.some(dir => read(dir, 'type') !== 'Battery' && read(dir, 'online') === '1'))
        throw Error('AC power lost');
      if (interrupted) throw Error('Firefox smoke interrupted');
      if (launchError) throw launchError;
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Firefox launcher exited prematurely');
      try { result = validate(events, config); break; } catch (error) { lastError = error; }
      await delay(500);
    }
    if (!result) throw Error(`Firefox timed out: ${lastError?.message}`);
    return result;
  } catch (error) {
    const network = events.filter(event => event.type === 'network').slice(-20);
    const blocker = network.find(event => event.error || event.status >= 400);
    result = { passed: false, error: error.message, lastSample: events.findLast(event => event.type === 'sample'), network,
      captionFetchBlocker: blocker || null }; throw error;
  } finally {
    let cleanupError;
    try { await stopOwned(child); } catch (error) { cleanupError = error; }
    try {
      if (log) await new Promise(resolve => log.end(resolve));
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    } catch (error) { cleanupError ||= error; }
    if (sink && /^\d+$/.test(sink)) {
      try { execFileSync('pactl', ['unload-module', sink]); } catch (error) { cleanupError = error; }
    }
    for (const dir of [profile, extension]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { cleanupError ||= error; }
    }
    try { await releaseLock(lock); } catch (error) { cleanupError ||= error; }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (cleanupError) result = { passed: false, error: cleanupError.message };
    fs.writeFileSync(path.join(artifacts, 'summary.json'), JSON.stringify({ config, ...result }, null, 2));
    console.log(result?.passed
      ? `Firefox PASS: ${result.resolvedWords} audio decisions, ${result.late} late, minimum lead ${result.minLead ?? 'n/a'}s.`
      : `Firefox FAIL: ${result?.error || 'No result'}`);
    console.log(`Firefox artifacts: ${artifacts}`);
    if (cleanupError) throw cleanupError;
  }
}
module.exports = { run, validate, options, visibleSlotMatch, stopOwned, acquireLock, releaseLock, runtimeHashes };
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
