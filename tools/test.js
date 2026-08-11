const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const flags = new Set(process.argv.slice(2));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" }
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function benchmark() {
  const candidateReport = "corpus/generated/paired-rules-any-candidate-report.json";
  const reports = {
    "whisper-only": "corpus/generated/whisper-only-report.json",
    "rules-only": "corpus/generated/paired-rules-only-report.json",
    "rules+whisper": "corpus/generated/rules-whisper-report.json"
  };

  run("node", ["tools/evaluate-whisper-only.js", "--output", reports["whisper-only"]]);
  run("node", ["tools/evaluate-whisper-only.js", "--mode", "rules-only",
    "--discoverPaired", "true", "--skipMissing", "true", "--output", reports["rules-only"]]);
  run("node", ["tools/evaluate-whisper-only.js", "--mode", "rules-only",
    "--rulesScoring", "any-candidate", "--discoverPaired", "true",
    "--skipMissing", "true", "--output", candidateReport]);
  run("node", ["tools/evaluate-whisper-only.js", "--mode", "rules+whisper",
    "--transcripts", reports["whisper-only"], "--output", reports["rules+whisper"]]);

  const popup = fs.readFileSync(path.join(root, "src/popup.js"), "utf8");
  const popupModes = {
    "whisper-only": "whisper",
    "rules-only": "rules",
    "rules+whisper": "hybrid"
  };
  for (const [mode, file] of Object.entries(reports)) {
    const report = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    const summary = report.summary;
    const precision = (100 * summary.precision).toFixed(1);
    const coverage = (100 * summary.coverage).toFixed(1);
    const correct = summary.correctCount;
    const scored = summary.scoredCount;
    console.log(`${mode}: ${precision}% precision, ${coverage}% coverage (${correct}/${scored})`);
    const block = popup.match(new RegExp(`\\b${popupModes[mode]}:\\s*\\{([^}]*)\\}`));
    if (!block || !block[1].includes(`precision: "${precision}", coverage: "${coverage}"`)) {
      throw new Error(`Popup metrics are stale for ${mode}.`);
    }
  }
  const candidate = JSON.parse(fs.readFileSync(path.join(root, candidateReport), "utf8")).summary;
  console.log(`rules-any-candidate: ${(100 * candidate.precision).toFixed(1)}% precision, ` +
    `${(100 * candidate.coverage).toFixed(1)}% coverage (${candidate.correctCount}/${candidate.scoredCount})`);
  if (candidate.precision < 0.9) {
    throw new Error("Rules any-candidate precision fell below 90%.");
  }
}

function javascriptFiles(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : entry.name.endsWith(".js") ? [file] : [];
  });
}

for (const file of ["src", "tools", "tests"].flatMap(javascriptFiles)) {
  run("node", ["--check", file]);
}
for (const file of fs.readdirSync(path.join(root, "tests")).filter((name) => name.endsWith(".test.js")).sort()) {
  run("node", [path.join("tests", file)]);
}
run("./build.sh", ["1.5.0"]);
run("unzip", ["-tq", "dist/uncensored-youtube-firefox-1.5.0.zip"]);
run("unzip", ["-tq", "dist/uncensored-youtube-chromium-1.5.0.zip"]);
run("web-ext", ["lint", "--source-dir", "dist/firefox", "--warnings-as-errors"]);
if (flags.has("--benchmark") || flags.has("--all")) benchmark();
if (flags.has("--browsers") || flags.has("--all")) {
  run("node", ["tools/browser-smoke.js", ...process.argv.slice(2).filter(function browserArgument(arg) {
    return !["--all", "--benchmark", "--browsers"].includes(arg);
  })]);
}
