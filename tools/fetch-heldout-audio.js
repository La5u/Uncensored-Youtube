#!/usr/bin/env node
// Fetch audio for the post-freeze held-out fixture IDs via the VPN netns,
// mirroring download-paired-captions.js yt-dlp settings. Resumable; no modes.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const idsPath = process.env.FETCH_AUDIO_IDS || path.join(root, "tmp/heldout/post-freeze-manual-auto-ids.txt");
const audioDir = process.env.FETCH_AUDIO_DIR || path.join(root, "test-fixtures/audio");
const netns = process.env.HELDOUT_NETNS || "uncensored-vpn-us-free-137";
const requestSleep = Number(process.env.HELDOUT_SLEEP || 10);

const ids = fs.readFileSync(idsPath, "utf8").split("\n").filter(Boolean);
fs.mkdirSync(audioDir, { recursive: true });

function hasAudio(id) {
  return fs.readdirSync(audioDir).some((name) =>
    name.startsWith(`${id}.`) && /\.(?:m4a|webm|opus|mp3|wav)$/i.test(name));
}

function fetchOne(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const output = path.join(audioDir, `${id}.%(ext)s`);
  const command = [
    "sudo", "-n", "ip", "netns", "exec", netns, "runuser", "-u", "lasu", "--",
    "yt-dlp", "--ignore-config", "--socket-timeout", "30", "--sleep-requests", "4",
    "--no-playlist", "--no-overwrites",
    "-f", "ba[ext=webm]/ba", "-o", output, url
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
