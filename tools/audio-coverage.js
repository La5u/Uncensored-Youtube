// Media timestamps, not section filenames, determine coverage. Source end is explicit metadata.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const cache = new Map();
const EXT = /\.(?:m4a|webm|opus|mp3|wav)$/i;
const TOLERANCE = 0.08; // Opus padding / timestamp rounding, not missing seconds.

function sourceDuration(dir, id) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${id}.source.json`), "utf8"));
    return data.videoId === id && Number.isFinite(data.duration) && data.duration > 0 ? data.duration : null;
  } catch (_) { return null; }
}

function probeAudio(file) {
  try {
    const stat = fs.statSync(file);
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (cache.get(file)?.key === key) return cache.get(file).value;
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_packets",
      "-show_entries", "packet=pts_time,duration_time:format=start_time", "-of", "json", file],
    { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    let value = null;
    if (probe.status === 0 && !probe.stderr.trim()) {
      const body = JSON.parse(probe.stdout);
      const packets = (body.packets || []).map((p) => [Number(p.pts_time), Number(p.duration_time)]);
      if (packets.length && packets.every(([t, d]) => Number.isFinite(t) && Number.isFinite(d) && d > 0)) {
        const start = packets[0][0];
        let end = start, continuous = true;
        for (const [t, d] of packets) {
          if (t > end + TOLERANCE) continuous = false;
          end = Math.max(end, t + d);
        }
        const offset = Number(body.format?.start_time);
        const decode = continuous && spawnSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-f", "null", "-"],
          { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
        if (continuous && Number.isFinite(offset) && decode.status === 0 && !decode.stderr.trim()) {
          value = { start, end, offset };
        }
      }
    }
    if (cache.size >= 512) cache.clear();
    cache.set(file, { key, value });
    return value;
  } catch (_) { return null; }
}

function covers(file, start, end, duration = null) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  if (duration !== null) {
    if (start >= duration) return false;
    end = Math.min(end, duration);
  }
  const media = probeAudio(file);
  return Boolean(media && media.start <= Math.max(0, start) + TOLERANCE && media.end + TOLERANCE >= end);
}

function audioFiles(dir, id) {
  return fs.readdirSync(dir).filter((name) => EXT.test(name) &&
    (name.replace(EXT, "") === id || name.startsWith(`${id}.s`))).map((name) => path.join(dir, name));
}

function hasAudio(dir, id, windows) {
  const duration = sourceDuration(dir, id);
  // Whole-file completion also needs an independently acquired source duration.
  const required = windows || (duration ? [[0, duration]] : null);
  return Boolean(required && required.every(([start, end]) =>
    audioFiles(dir, id).some((file) => covers(file, start, end, duration))));
}

module.exports = { sourceDuration, probeAudio, covers, audioFiles, hasAudio };
