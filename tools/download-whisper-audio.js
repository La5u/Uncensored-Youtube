const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const manifest = require("./whisper-audio-fixtures.json");
const outputDir = path.join(root, "tests/fixtures/audio");

fs.mkdirSync(outputDir, { recursive: true });

for (const item of manifest) {
  const output = path.join(outputDir, `${item.name}.%(ext)s`);
  const result = spawnSync("yt-dlp", [
    "--no-playlist",
    "-f",
    "ba[ext=webm]/ba",
    "-o",
    output,
    item.url
  ], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
