const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pcmSlice } = require("../tools/evaluate-whisper-only");

// Windowed audio must decode exactly like the full file at the same media time.
if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
  console.log("audio-sections.test.js skipped: ffmpeg unavailable");
  return;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-sections-"));
try {
  const full = path.join(dir, "vid.webm");
  const ffmpeg = (...args) => assert.strictEqual(spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]).status, 0);
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=220:duration=40,vibrato=f=3", "-c:a", "libopus", full);
  // Same cut as fetch-heldout-audio.js: stream copy snaps back to a cluster; -copyts keeps the true start.
  ffmpeg("-ss", "17", "-to", "33", "-i", full, "-c", "copy", "-copyts", path.join(dir, "vid.s17-33.webm"));

  for (const time of [17, 20.5, 28]) {
    const expected = pcmSlice(full, time, 5);
    const actual = pcmSlice(path.join(dir, "vid.s17-33.webm"), time, 5);
    assert.strictEqual(actual.length, expected.length);
    assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) < 1e-6), `section differs at ${time}s`);
  }
  assert.throws(() => pcmSlice(path.join(dir, "vid.s17-33.webm"), 10, 5), /No audio section covers/);
  // The last AVAILABLE section is not evidence of the source end.
  assert.throws(() => pcmSlice(path.join(dir, "vid.s17-33.webm"), 30, 5), /No audio section covers/);
  // A real source end permits a clamped window only with independent duration metadata.
  ffmpeg("-ss", "35", "-i", full, "-c", "copy", "-copyts", path.join(dir, "vid.s35-40.webm"));
  assert.throws(() => pcmSlice(path.join(dir, "vid.s17-33.webm"), 30, 5), /No audio section covers/);
  assert.throws(() => pcmSlice(path.join(dir, "vid.s35-40.webm"), 37, 5), /No audio section covers/);
  fs.writeFileSync(path.join(dir, "vid.source.json"), JSON.stringify({ videoId: "vid", duration: 40 }));
  const expected = pcmSlice(full, 37, 5);
  const actual = pcmSlice(path.join(dir, "vid.s35-40.webm"), 37, 5);
  // A section cut through the file end decodes ~1 ms shifted (Opus padding); allow <= 2 ms.
  assert.ok(Math.abs(actual.length - expected.length) <= 32);
  const error = (shift) => expected.slice(100, -100).reduce((sum, value, i) => sum + Math.abs(value - actual[i + 100 + shift]), 0) / (expected.length - 200);
  assert.ok(Array.from({ length: 65 }, (_, i) => error(i - 32)).some((mean) => mean < 1e-3), "clamped last section differs");

  const truncated = path.join(dir, "truncated.webm");
  ffmpeg("-to", "33", "-i", full, "-c", "copy", truncated);
  assert.throws(() => pcmSlice(truncated, 30, 5), /No audio coverage/);
  fs.unlinkSync(path.join(dir, "vid.source.json"));
  assert.throws(() => pcmSlice(full, 37, 5), /No audio coverage/);
  fs.writeFileSync(path.join(dir, "vid.source.json"), JSON.stringify({ videoId: "vid", duration: 40 }));
  assert.ok(pcmSlice(full, 37, 5).length > 0);
  fs.writeFileSync(path.join(dir, "broken.webm"), "corrupt");
  assert.throws(() => pcmSlice(path.join(dir, "broken.webm"), 0, 5), /No audio coverage/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("audio-sections.test.js passed");
