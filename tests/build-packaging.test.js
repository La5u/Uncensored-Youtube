const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercise real staging with tiny fixtures, not model copies or ZIP compression.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uncensored-packaging-'));
function put(file, content = 'fixture') {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
try {
  put('build.sh', fs.readFileSync(path.join(__dirname, '../build.sh')));
  for (const browser of ['chromium', 'firefox']) {
    put(`manifest.${browser}.json`, '{"version": "0.0.0"}');
    put(`dist/${browser}/src/stale.js`);
  }
  put('LICENSE');
  put('README.md');
  const runtime = ['timedtext.js', 'rule-data/exact.js', 'offscreen.html', 'popup.css',
    'icons/icon-16.png', 'vendor/runtime.mjs', 'vendor/runtime.wasm',
    'models/whisper/config.json', 'models/whisper/onnx/encoder_model_quantized.onnx'];
  const excluded = ['timedtext.js.pre-bandaid-backup', 'rules.js.bak', 'popup.css~',
    'notes.md', 'scratch.py', '__pycache__/scratch.pyc'];
  for (const file of [...runtime, ...excluded]) put(`src/${file}`);
  put('bin/zip', '#!/bin/sh\nfor arg do\n  case "$arg" in *.zip) : > "$arg";; esac\ndone\n');
  fs.chmodSync(path.join(root, 'bin/zip'), 0o755);
  const result = spawnSync('sh', [path.join(root, 'build.sh'), '1.2.3'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` }
  });
  assert.equal(result.status, 0, result.stderr);
  for (const browser of ['chromium', 'firefox']) {
    const output = path.join(root, 'dist', browser);
    for (const file of runtime) assert.equal(fs.readFileSync(path.join(output, 'src', file), 'utf8'), 'fixture');
    for (const file of [...excluded, 'stale.js']) assert.equal(fs.existsSync(path.join(output, 'src', file)), false, file);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'))).version, '1.2.3');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('Build packaging tests passed');
