#!/usr/bin/env node
// Resumable audio acquisition for an explicit ID queue. Raw captions are read only.
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");
const { hasAudio, audioFiles, covers, probeAudio, sourceDuration } = require("./audio-coverage");
const root = path.join(__dirname, "..");
const geographicRestriction = /not made this video available in your country/i;

function config(env = process.env) {
  const idsPath = path.resolve(env.FETCH_AUDIO_IDS || path.join(root, "tmp/heldout/post-freeze-manual-auto-ids.txt"));
  // Optional pacing override for the IDs file's directory, read at each start (live per-worker trials):
  // e.g. state/shard-1.pacing.json = {"sleep": 3, "sleepRequests": 1.5}.
  let pacing = {};
  try { pacing = JSON.parse(fs.readFileSync(`${path.dirname(idsPath)}.pacing.json`, "utf8")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    idsPath, audioDir: path.resolve(env.FETCH_AUDIO_DIR || path.join(root, "test-fixtures/audio")),
    fixturesDir: path.resolve(env.FETCH_FIXTURES_DIR || path.join(root, "test-fixtures")),
    netns: env.HELDOUT_NETNS || "uncensored-vpn-us-free-137",
    sleep: Number(pacing.sleep ?? (env.HELDOUT_SLEEP || 10)) * 1000,
    sleepRequests: String(pacing.sleepRequests ?? (env.HELDOUT_SLEEP_REQUESTS || 4)),
    // Videos fetched at once by one queue run, all inside the same network namespace.
    // Download the whole track from the metadata already fetched instead of extracting the page again.
    reuseInfo: Boolean(pacing.reuseInfo ?? env.FETCH_AUDIO_REUSE_INFO),
    parallel: Math.max(1, Math.floor(Number(pacing.parallel ?? (env.HELDOUT_PARALLEL || 1)))),
    // Optional {videoId: [[start, end], ...]}: precomputed windows replace caption-derived ones.
    windows: env.FETCH_AUDIO_WINDOWS ? JSON.parse(fs.readFileSync(env.FETCH_AUDIO_WINDOWS, "utf8")) : null,
    ledger: path.resolve(env.FETCH_AUDIO_LEDGER || `${idsPath}.audio-retries.json`),
    // Windowed fetches download the whole track and cut locally unless forced to "sections".
    method: env.FETCH_AUDIO_METHOD || "whole",
    wholeMax: Number(env.FETCH_AUDIO_WHOLE_MAX_MB || 1000) * 1e6
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
    "--socket-timeout", "30", "--sleep-requests", c.sleepRequests ?? "4", "--no-playlist", ...args];
  return execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024 });
}

// Windows not yet covered by a valid clip (source end from <id>.source.json).
function missing(c, id, windows) {
  const duration = sourceDuration(c.audioDir, id);
  return windows.filter(([start, end]) => !audioFiles(c.audioDir, id).some((file) => covers(file, start, end, duration)));
}

// Downloads the whole track (native downloader, ~40-130x real time; sections run at ~1x) to
// audio/.whole/, which coverage checks never list, then cuts each missing window straight into the
// compacted form (16 kHz mono Opus 32 kbit/s, true timestamps). Valid cuts are kept even when
// another window fails; the caller then fetches only the windows still missing.
function fetchWhole(c, id, url, info, windows, metaSeconds) {
  const seconds = windows.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(end, info.duration) - start), 0);
  // Skip when the track is known to be too large, or when windows are a tiny part of a long video.
  if (c.method !== "whole" || (info.filesize || info.filesize_approx) > c.wholeMax || info.duration > 60 * seconds) return;
  // Parallel lanes may each hold a whole track: keep room for one more plus the workers' 5 GB stop.
  const { bavail, bsize } = fs.statfsSync(c.audioDir);
  if (bavail * bsize < c.wholeMax + 5e9) { console.error(`${id}: low disk space; per-window fetch`); return; }
  const dir = path.join(c.audioDir, ".whole"), whole = path.join(dir, `${id}.whole`);
  const clear = () => fs.existsSync(dir) && fs.readdirSync(dir).filter((name) => name.startsWith(`${id}.`))
    .forEach((name) => fs.rmSync(path.join(dir, name), { force: true }));
  const infoFile = path.join(dir, `${id}.info.json`);
  const download = (reuse) => command(c, ["-f", "ba[ext=webm]/ba", "--max-filesize", String(c.wholeMax), "-o", whole,
    ...(reuse ? ["--load-info-json", infoFile] : [url])]);
  try {
    fs.mkdirSync(dir, { recursive: true });
    clear();
    if (c.reuseInfo) fs.writeFileSync(infoFile, JSON.stringify(info));
    const started = Date.now();
    try { download(c.reuseInfo); } catch (error) { // expired stream URLs give sporadic 403s; one fresh attempt
      if (!/HTTP Error 403/.test(String(error.stderr || error.message))) throw error;
      console.error(`${id}: whole-file download got HTTP 403; retrying once`);
      clear(); // a fresh extraction gets fresh stream URLs
      download(false);
    }
    if (!fs.existsSync(whole)) throw new Error("whole track not downloaded (size limit?)");
    // Audio tracks often end up to ~0.5 s before the reported duration (the cause of "short" final
    // cuts); the complete, fully decoded track proves the real source end.
    if (windows.some(([, end]) => end > info.duration - 2)) {
      let track = null; // a probe timeout on a very long track only skips the clamp
      try { track = probeAudio(whole); } catch (_) {}
      if (track && track.end < info.duration && info.duration - track.end < 2) {
        atomicJson(path.join(c.audioDir, `${id}.source.json`), { videoId: id, duration: track.end, metadataDuration: info.duration });
      }
    }
    const downloaded = Date.now(), duration = sourceDuration(c.audioDir, id), failed = [];
    for (const [start, end] of missing(c, id, windows)) {
      const name = `${id}.s${start}-${end}.webm`, clip = path.join(dir, name);
      const cut = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-threads", "2", "-ss", String(start), "-to", String(end),
        "-i", whole, "-map", "0:a:0", "-map_metadata", "-1", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k",
        "-copyts", clip], { encoding: "utf8", timeout: 600000 });
      // Only a clip that covers its window enters the audio dir, so a fallback never meets a short one.
      if (cut.status === 0 && covers(clip, start, end, duration)) fs.renameSync(clip, path.join(c.audioDir, name));
      else failed.push(`${name}: ${cut.status !== 0 ? `ffmpeg ${cut.status ?? cut.signal}: ${String(cut.stderr || cut.error?.message).trim().slice(-200)}`
        : `media ${JSON.stringify(probeAudio(clip))} vs window ${start}-${end}, source end ${duration}`}`);
    }
    if (failed.length) throw new Error(`cuts failed: ${failed.join("; ")}`);
    const secs = (from, to = Date.now()) => ((to - from) / 1000).toFixed(1);
    console.log(`${id}: whole-file fetch validated (${windows.length} windows; metadata ${metaSeconds} s, ` +
      `download ${secs(started, downloaded)} s, cuts+checks ${secs(downloaded)} s)`);
  } catch (error) {
    console.error(`${id}: whole-file fetch incomplete, fetching missing windows per window: ${String(error.stderr || error.message).slice(-400).replace(/[\r\n]+/g, " ")}`);
  } finally { clear(); }
}

// Called only while flock holds this video's lock; kernel locks automatically release on crash.
function fetchOne(c, id) {
  try {
    const windows = c.windows ? c.windows[id] : sections(id, c.fixturesDir);
    // With a windows file, a video without windows is an error, never a whole-file fetch.
    if (c.windows && !windows?.length) { console.error(`${id}: no windows listed; skipped`); return 20; }
    if (hasAudio(c.audioDir, id, windows)) return 0;
    const url = `https://www.youtube.com/watch?v=${id}`, metaStart = Date.now();
    const info = JSON.parse(command(c, ["--dump-single-json", "--skip-download", "-f", "ba[ext=webm]/ba", url]));
    if (info.id !== id || !Number.isFinite(info.duration) || info.duration <= 0) throw new Error("Missing source duration");
    // Keep a source end proven from the decoded track for this same reported duration.
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(path.join(c.audioDir, `${id}.source.json`), "utf8")); } catch (_) {}
    if (prior?.metadataDuration !== info.duration) atomicJson(path.join(c.audioDir, `${id}.source.json`), { videoId: id, duration: info.duration });
    if (hasAudio(c.audioDir, id, windows)) return 0;
    const duration = sourceDuration(c.audioDir, id);
    // Remove only invalid outputs, under the video lock. Valid sections are left untouched.
    for (const file of audioFiles(c.audioDir, id)) {
      const match = path.basename(file).match(/\.s(\d+)-(\d+)\.[^.]+$/);
      const range = match ? [Number(match[1]), Number(match[2])] : [0, duration];
      if (!covers(file, range[0], range[1], duration)) fs.unlinkSync(file);
    }
    if (windows) fetchWhole(c, id, url, info, windows, ((Date.now() - metaStart) / 1000).toFixed(1));
    if (hasAudio(c.audioDir, id, windows)) return 10;
    const output = path.join(c.audioDir, windows ? `${id}.s%(section_start)d-%(section_end)d.%(ext)s` : `${id}.%(ext)s`);
    command(c, ["--no-overwrites", "-f", "ba[ext=webm]/ba", "-o", output,
      ...(windows ? missing(c, id, windows) : []).flatMap(([start, end]) => ["--download-sections", `*${start}-${end}`]),
      ...(windows ? ["--downloader-args", "ffmpeg_i:-rw_timeout 60000000", "--downloader-args", "ffmpeg_o:-copyts"] : []), url]);
    if (!hasAudio(c.audioDir, id, windows)) throw new Error("Downloaded audio does not cover all required windows");
    return 10; // fetched and validated, distinct from already present
  } catch (error) {
    const reason = String(error.stderr || error.message);
    console.error(`${id}: ${reason.slice(-500).replace(/[\r\n]+/g, " ")}`);
    // A country restriction ends this run's attempts for the ID. A later route can try again.
    if (geographicRestriction.test(reason)) return 21;
    return /Private video|This video has been removed|account.*terminated|closed their YouTube account|blocked due to the claimed content|copyright claim|members.only|Join this channel to get access/i.test(reason) ? 20 : 1;
  }
}

// Asynchronous, so parallel lanes can run several videos at once.
function lockedFetch(c, id) {
  const lockDir = path.join(c.audioDir, ".locks");
  fs.mkdirSync(lockDir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn("flock", ["--nonblock", "--conflict-exit-code", "75", path.join(lockDir, id),
      process.execPath, __filename, "--one-id", id], { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-64 * 1024); });
    const finish = (status, error) => {
      const reason = String(stderr || error?.message || "").trim().slice(-500);
      if (reason) console.error(reason);
      resolve({ status: status ?? 1, reason });
    };
    child.on("error", (error) => finish(1, error));
    child.on("close", (status) => finish(status));
  });
}

async function runQueue(c, ids, execute = lockedFetch, pause = (ms) => new Promise((r) => setTimeout(r, ms))) {
  fs.mkdirSync(c.audioDir, { recursive: true });
  // Each invocation owns its ledger; flock also prevents two parents losing ledger updates.
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(c.ledger, "utf8")).failures || {}; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const failures = Object.fromEntries(ids.filter((id) => previous[id]).map((id) => [id, previous[id]]));
  let done = 0, skipped = 0;
  let pending = ids.filter((id) => !failures[id]?.permanent || geographicRestriction.test(failures[id].reason));
  const recent = [];
  let holdUntil = 0; // shared by all lanes: one lane's bot check or 429 pauses them all
  for (let pass = 0; pass < 3 && pending.length; pass += 1) {
    const retry = [], queue = [...pending];
    const lane = async () => {
      while (queue.length) {
        const delay = holdUntil - Date.now();
        if (delay > 0) {
          await pause(delay);
          continue;
        }
        const id = queue.shift(), started = Date.now();
        console.log(`[${new Date().toISOString()}] checking/fetching ${id}; item ETA unknown until validation/download completes.`);
        const outcome = await execute(c, id);
        const { status, reason } = typeof outcome === "number" ? { status: outcome } : outcome;
        if (status === 0 || status === 10) {
          delete failures[id];
          if (status === 10) done += 1; else skipped += 1;
        } else {
          failures[id] = { attempts: (failures[id]?.attempts || 0) + 1, permanent: status === 20,
            reason: status === 75 ? "Video busy; deferred" : reason || (status === 20 ? "Source unavailable; see log" : "Acquisition or coverage validation failed; see log"),
            updatedAt: new Date().toISOString() };
          if (status === 21) failures[id].route = c.netns;
          else if (status !== 20) retry.push(id);
        }
        if (c.parallel > 1 && /Sign in to confirm|not a bot|HTTP Error 429|Too Many Requests/i.test(reason || "")) {
          holdUntil = Date.now() + 120000;
          console.log(`${id}: bot check or 429; all lanes pause 120 s`);
        }
        atomicJson(c.ledger, { updatedAt: new Date().toISOString(), failures });
        recent.push(Date.now() - started + c.sleep);
        if (recent.length > 10) recent.shift();
        const remaining = queue.length;
        const minutes = recent.reduce((a, b) => a + b, 0) / recent.length * remaining / c.parallel / 60000;
        console.log(`Validated ${done} fetched, ${skipped} present; ${remaining} left in pass. ` +
          (recent.length >= 3 && minutes >= 1 ? `Pass ETA roughly ${Math.max(1, Math.floor(minutes * 0.7))}–${Math.ceil(minutes * 1.5)} min (uncertain); retry completion ETA unknown.` :
            "Pass ETA unknown (insufficient measured workload/throughput); retry completion ETA unknown."));
        await pause(c.sleep);
      }
    };
    await Promise.all(Array.from({ length: Math.min(c.parallel || 1, pending.length) }, lane));
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
module.exports = { config, sections, fetchOne, fetchWhole, lockedFetch, runQueue };
