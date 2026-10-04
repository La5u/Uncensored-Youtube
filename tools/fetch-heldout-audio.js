#!/usr/bin/env node
// Fetch audio for the post-freeze held-out fixture IDs via the VPN netns,
// mirroring download-paired-captions.js yt-dlp settings. Resumable; no modes.
// Only the original stream around [__] slots is kept (no re-encode): every evaluator
// window starts <= 35 s before and ends <= 30 s after a slot. Stream-copy cuts snap back
// to a container cluster, so -copyts keeps each section's true start in its timestamps.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const idsPath = process.env.FETCH_AUDIO_IDS || path.join(root, "tmp/heldout/post-freeze-manual-auto-ids.txt");
const audioDir = process.env.FETCH_AUDIO_DIR || path.join(root, "test-fixtures/audio");
const netns = process.env.HELDOUT_NETNS || "uncensored-vpn-us-free-137";
const requestSleep = Number(process.env.HELDOUT_SLEEP || 10);
const fixturesDir = process.env.FETCH_FIXTURES_DIR || path.join(root, "test-fixtures");
const BEFORE = 35, AFTER = 30;

const ids = fs.readFileSync(idsPath, "utf8").split("\n").filter(Boolean);
fs.mkdirSync(audioDir, { recursive: true });

function hasAudio(id) {
  return fs.readdirSync(audioDir).some((name) =>
    name.startsWith(`${id}.`) && /\.(?:m4a|webm|opus|mp3|wav)$/i.test(name));
}

// Merged slot windows from the censored automatic track; null means the whole file.
function sections(id) {
  const caption = path.join(fixturesDir, `${id}_auto.en.json3`);
  if (!fs.existsSync(caption)) return null;
  const times = (JSON.parse(fs.readFileSync(caption, "utf8")).events || []).flatMap((event) =>
    (event.segs || []).filter((seg) => /\[\s*__\s*\]/.test(seg.utf8 || ""))
      .map((seg) => ((event.tStartMs || 0) + (seg.tOffsetMs || 0)) / 1000)).sort((a, b) => a - b);
  const merged = [];
  for (const time of times) {
    const start = Math.max(0, Math.floor(time - BEFORE)), end = Math.ceil(time + AFTER);
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end); else merged.push([start, end]);
  }
  return merged.length ? merged : null;
}

function fetchOne(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const windows = sections(id);
  const output = path.join(audioDir, windows ? `${id}.s%(section_start)d-%(section_end)d.%(ext)s` : `${id}.%(ext)s`);
  const command = [
    "sudo", "-n", "ip", "netns", "exec", netns, "runuser", "-u", "lasu", "--",
    "yt-dlp", "--ignore-config", "--socket-timeout", "30", "--sleep-requests", "4",
    "--no-playlist", "--no-overwrites",
    "-f", "ba[ext=webm]/ba", "-o", output,
    ...(windows || []).flatMap(([start, end]) => ["--download-sections", `*${start}-${end}`]),
    ...(windows ? ["--downloader-args", "ffmpeg_o:-copyts"] : []), url
  ];
  try {
    execFileSync(command[0], command.slice(1), { stdio: ["ignore", "ignore", "pipe"], timeout: 30 * 60 * 1000 });
    return true;
  } catch (error) {
    console.error(`  ${id}: ${String(error.stderr || error.message).split("\n").slice(-2).join(" ").slice(0, 200)}`);
    return false;
  }
}

(async () => {
  let done = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    if (hasAudio(id)) { skipped += 1; continue; }
    process.stdout.write(`[${new Date().toISOString()}] fetching ${id}\n`);
    if (fetchOne(id)) done += 1; else failed += 1;
    await new Promise((resolve) => setTimeout(resolve, requestSleep * 1000));
  }
  console.log(`Audio fetch complete: ${done} fetched, ${skipped} already present, ${failed} failed.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
