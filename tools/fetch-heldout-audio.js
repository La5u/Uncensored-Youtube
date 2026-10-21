#!/usr/bin/env node
// Resumable audio acquisition for an explicit ID queue. Raw captions are read only.
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { hasAudio, audioFiles, covers } = require("./audio-coverage");
const root = path.join(__dirname, "..");

function config(env = process.env) {
  const idsPath = path.resolve(env.FETCH_AUDIO_IDS || path.join(root, "tmp/heldout/post-freeze-manual-auto-ids.txt"));
  return {
    idsPath, audioDir: path.resolve(env.FETCH_AUDIO_DIR || path.join(root, "test-fixtures/audio")),
    fixturesDir: path.resolve(env.FETCH_FIXTURES_DIR || path.join(root, "test-fixtures")),
    netns: env.HELDOUT_NETNS || "uncensored-vpn-us-free-137",
    sleep: Number(env.HELDOUT_SLEEP || 10) * 1000,
    ledger: path.resolve(env.FETCH_AUDIO_LEDGER || `${idsPath}.audio-retries.json`)
  };
}

function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(temp, file);
}

function sections(id, fixturesDir) {
  const caption = path.join(fixturesDir, `${id}_auto.en.json3`);
  if (!fs.existsSync(caption)) return null;
  const times = (JSON.parse(fs.readFileSync(caption, "utf8")).events || []).flatMap((event) =>
    (event.segs || []).filter((seg) => /\[\s*__\s*\]/.test(seg.utf8 || ""))
      .map((seg) => ((event.tStartMs || 0) + (seg.tOffsetMs || 0)) / 1000)).sort((a, b) => a - b);
  const merged = [];
  for (const time of times) {
    const start = Math.max(0, Math.floor(time - 35)), end = Math.ceil(time + 30);
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  return merged.length ? merged : null;
}

function command(c, args) {
  const prefix = c.netns === "direct" ? [] : ["sudo", "-n", "ip", "netns", "exec", c.netns, "runuser", "-u", "lasu", "--"];
  // Timeout inside the namespace kills yt-dlp AND ffmpeg, even when the parent is unprivileged.
  const cmd = [...prefix, "timeout", "--kill-after=5s", "1800s", "yt-dlp", "--ignore-config",
    "--socket-timeout", "30", "--sleep-requests", "4", "--no-playlist", ...args];
  return execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024 });
}

// Called only while flock holds this video's lock; kernel locks automatically release on crash.
function fetchOne(c, id) {
  try {
    const windows = sections(id, c.fixturesDir);
    if (hasAudio(c.audioDir, id, windows)) return 0;
    const url = `https://www.youtube.com/watch?v=${id}`;
    const info = JSON.parse(command(c, ["--dump-single-json", "--skip-download", url]));
    if (info.id !== id || !Number.isFinite(info.duration) || info.duration <= 0) throw new Error("Missing source duration");
    atomicJson(path.join(c.audioDir, `${id}.source.json`), { videoId: id, duration: info.duration });
    if (hasAudio(c.audioDir, id, windows)) return 0;
    // Remove only invalid outputs, under the video lock. Valid sections are left untouched.
    for (const file of audioFiles(c.audioDir, id)) {
      const match = path.basename(file).match(/\.s(\d+)-(\d+)\.[^.]+$/);
      const range = match ? [Number(match[1]), Number(match[2])] : [0, info.duration];
      if (!covers(file, range[0], range[1], info.duration)) fs.unlinkSync(file);
    }
    const output = path.join(c.audioDir, windows ? `${id}.s%(section_start)d-%(section_end)d.%(ext)s` : `${id}.%(ext)s`);
    command(c, ["--no-overwrites", "-f", "ba[ext=webm]/ba", "-o", output,
      ...(windows || []).flatMap(([start, end]) => ["--download-sections", `*${start}-${end}`]),
      ...(windows ? ["--downloader-args", "ffmpeg_i:-rw_timeout 60000000", "--downloader-args", "ffmpeg_o:-copyts"] : []), url]);
    if (!hasAudio(c.audioDir, id, windows)) throw new Error("Downloaded audio does not cover all required windows");
    return 10; // fetched and validated, distinct from already present
  } catch (error) {
    const reason = String(error.stderr || error.message);
    console.error(`${id}: ${reason.slice(-500).replace(/[\r\n]+/g, " ")}`);
    // Generic "unavailable" and geo/network errors may recover on a later route.
    return /Private video|This video has been removed|account.*terminated|members.only|Join this channel to get access/i.test(reason) ? 20 : 1;
  }
}

function lockedFetch(c, id) {
  const lockDir = path.join(c.audioDir, ".locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const result = spawnSync("flock", ["--nonblock", "--conflict-exit-code", "75", path.join(lockDir, id),
    process.execPath, __filename, "--one-id", id], { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  const reason = String(result.stderr || result.error?.message || "").trim().slice(-500);
  if (reason) console.error(reason);
  return { status: result.status ?? 1, reason };
}

async function runQueue(c, ids, execute = lockedFetch, pause = (ms) => new Promise((r) => setTimeout(r, ms))) {
  fs.mkdirSync(c.audioDir, { recursive: true });
  // Each invocation owns its ledger; flock also prevents two parents losing ledger updates.
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(c.ledger, "utf8")).failures || {}; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const failures = Object.fromEntries(ids.filter((id) => previous[id]).map((id) => [id, previous[id]]));
  let done = 0, skipped = 0, pending = ids.filter((id) => !failures[id]?.permanent);
  const recent = [];
  for (let pass = 0; pass < 3 && pending.length; pass += 1) {
    const retry = [];
    for (let i = 0; i < pending.length; i += 1) {
      const id = pending[i], started = Date.now();
      console.log(`[${new Date().toISOString()}] checking/fetching ${id}; item ETA unknown until validation/download completes.`);
      const outcome = execute(c, id);
      const { status, reason } = typeof outcome === "number" ? { status: outcome } : outcome;
      if (status === 0 || status === 10) {
        delete failures[id];
        if (status === 10) done += 1; else skipped += 1;
      } else {
        failures[id] = { attempts: (failures[id]?.attempts || 0) + 1, permanent: status === 20,
          reason: status === 75 ? "Video busy; deferred" : reason || (status === 20 ? "Source unavailable; see log" : "Acquisition or coverage validation failed; see log"),
          updatedAt: new Date().toISOString() };
        if (status !== 20) retry.push(id);
      }
      atomicJson(c.ledger, { updatedAt: new Date().toISOString(), failures });
      recent.push(Date.now() - started + c.sleep);
      if (recent.length > 10) recent.shift();
      const remaining = pending.length - i - 1;
      const minutes = recent.reduce((a, b) => a + b, 0) / recent.length * remaining / 60000;
      console.log(`Validated ${done} fetched, ${skipped} present; ${remaining} left in pass. ` +
        (recent.length >= 3 && minutes >= 1 ? `Pass ETA roughly ${Math.max(1, Math.floor(minutes * 0.7))}–${Math.ceil(minutes * 1.5)} min (uncertain); retry completion ETA unknown.` :
          "Pass ETA unknown (insufficient measured workload/throughput); retry completion ETA unknown."));
      await pause(c.sleep);
    }
    pending = retry;
    if (pending.length && pass < 2) await pause(30000 * 2 ** pass);
  }
  const failed = Object.keys(failures).length;
  console.log(`Audio fetch complete: ${done} fetched, ${skipped} already present, ${failed} failed. ETA ${failed ? "unknown for unresolved failures" : "0 for validated queue"}.`);
  return failed ? 1 : 0;
}

async function main() {
  const c = config();
  const ids = [...new Set(fs.readFileSync(c.idsPath, "utf8").split(/\r?\n/).filter(Boolean))];
  if (!ids.every((id) => /^[A-Za-z0-9_-]{11}$/.test(id))) throw new Error("Invalid video ID in queue");
  if (process.argv[2] === "--one-id") {
    const id = process.argv[3];
    if (!ids.includes(id)) throw new Error("Video is not in approved queue");
    return fetchOne(c, id);
  }
  // Queue ledger lock wraps the parent, while child video locks are shared across all queues.
  if (process.argv[2] !== "--queue-locked") {
    fs.mkdirSync(path.dirname(c.ledger), { recursive: true });
    return spawnSync("flock", ["--nonblock", "--conflict-exit-code", "75", `${c.ledger}.lock`,
      process.execPath, __filename, "--queue-locked"], { stdio: "inherit" }).status ?? 1;
  }
  return runQueue(c, ids);
}

if (require.main === module) main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
module.exports = { config, sections, fetchOne, lockedFetch, runQueue };
