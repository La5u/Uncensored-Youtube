#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const fixtures = require("./dense-paired-audio-fixtures.json").fixtures;
const audioDir = path.join(root, "test-fixtures/audio");
const statusPath = path.join(root, "logs/dense-paired-audio-status.json");
const redownload = process.argv.includes("--redownload");
const positional = process.argv.slice(2).filter((value) => value !== "--redownload");
const jobs = Math.max(1, Number(positional[0]) || 2);
const browser = positional[1] || "firefox";
const state = { startedAt: new Date().toISOString(), total: fixtures.length, done: [], failed: [], active: [] };

fs.mkdirSync(audioDir, { recursive: true });
fs.mkdirSync(path.dirname(statusPath), { recursive: true });

function hasAudio(id) {
  return fs.readdirSync(audioDir).some((name) =>
    name.startsWith(`${id}.`) && /\.(?:m4a|webm|opus|mp3|wav)$/i.test(name));
}

function save() {
  state.updatedAt = new Date().toISOString();
  const temporary = `${statusPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, statusPath);
}

async function download(fixture) {
  if (hasAudio(fixture.videoId) && !redownload) {
    state.done.push(fixture.videoId);
    save();
    return;
  }
  if (redownload) {
    for (const name of fs.readdirSync(audioDir)) {
      if (name.startsWith(`${fixture.videoId}.`) && /\.(?:m4a|webm|opus|mp3|wav)$/i.test(name)) {
        fs.rmSync(path.join(audioDir, name));
      }
    }
  }
  state.active.push(fixture.videoId);
  save();
  for (let attempt = 0; attempt < 3 && !hasAudio(fixture.videoId); attempt += 1) {
    await new Promise((resolve) => {
      const child = spawn("yt-dlp", [
        "--ignore-config", "--cookies-from-browser", browser,
        "--no-playlist", "--no-overwrites", "--retries", "10", "--fragment-retries", "20",
        // Never fall back to an explicitly non-English alternate audio track. `^=?`
        // also accepts formats without language metadata (usually the original).
        "-f", "worstaudio[language^=?en][acodec!=none]",
        "-x", "--audio-format", "m4a",
        "-o", path.join(audioDir, `${fixture.videoId}.%(ext)s`),
        `https://www.youtube.com/watch?v=${fixture.videoId}`
      ], { stdio: "inherit" });
      child.on("error", () => resolve(-1));
      child.on("exit", (value) => resolve(value));
    });
  }
  state.active = state.active.filter((id) => id !== fixture.videoId);
  (hasAudio(fixture.videoId) ? state.done : state.failed).push(fixture.videoId);
  save();
}

let next = 0;
async function worker() {
  while (next < fixtures.length) await download(fixtures[next++]);
}

save();
Promise.all(Array.from({ length: jobs }, worker)).then(() => {
  state.finishedAt = new Date().toISOString();
  save();
  process.exitCode = state.failed.length ? 1 : 0;
});
