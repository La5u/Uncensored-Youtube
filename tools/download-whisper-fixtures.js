const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const manifest = require("./whisper-audio-fixtures.json");
const outputDir = path.join(root, "test-fixtures");
const requested = new Set(process.argv.slice(2));
const fixtures = requested.size
  ? manifest.filter((item) => requested.has(item.name))
  : manifest;

if (!fixtures.length || requested.size !== fixtures.length) {
  throw new Error("Unknown fixture ID.");
}

fs.mkdirSync(path.join(outputDir, "audio"), { recursive: true });

for (const item of fixtures) {
  const commands = [
    [item.censored, ["--write-auto-subs", "--sub-langs", "en", "--sub-format", "json3", "--skip-download", "-o", path.join(outputDir, `${item.name}_auto.%(ext)s`)]],
    [item.uncensored, ["--write-subs", "--sub-langs", "en", "--sub-format", "json3", "--skip-download", "-o", path.join(outputDir, `${item.name}_manual.%(ext)s`)]],
    ["audio", ["-f", "ba[ext=webm]/ba", "-o", path.join(outputDir, "audio", `${item.name}.%(ext)s`)]]
  ];

  for (const [file, args] of commands) {
    const exists = file === "audio"
      ? fs.readdirSync(path.join(outputDir, "audio")).some((name) => name.startsWith(`${item.name}.`))
      : fs.existsSync(path.join(outputDir, file));
    if (exists) continue;

    const result = spawnSync("yt-dlp", ["--no-playlist", "--no-overwrites", ...args, item.url], {
      stdio: "inherit"
    });

    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }

  if (commands.some(([file]) => file !== "audio" && !fs.existsSync(path.join(outputDir, file)))) {
    throw new Error(`Missing English caption track for ${item.name}.`);
  }
}
