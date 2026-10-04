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
  assert.throws(() => pcmSlice(path.join(dir, "vid.s17-33.webm"), 30, 5), /No audio section covers/);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("audio-sections.test.js passed");
