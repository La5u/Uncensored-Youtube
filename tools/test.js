const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const flags = new Set(process.argv.slice(2));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

function benchmark() {
  const reports = {
    "whisper-only": "corpus/generated/whisper-only-report.json",
    "rules-only": "corpus/generated/rules-only-report.json",
    "rules+whisper": "corpus/generated/rules-whisper-report.json"
  };

  run("node", ["tools/evaluate-whisper-only.js", "--output", reports["whisper-only"]]);
  run("node", ["tools/evaluate-whisper-only.js", "--mode", "rules-only", "--output", reports["rules-only"]]);
  run("node", ["tools/evaluate-whisper-only.js", "--mode", "rules+whisper",
    "--transcripts", reports["whisper-only"], "--output", reports["rules+whisper"]]);

  const popup = fs.readFileSync(path.join(root, "src/popup.html"), "utf8");
  let slots = 0;
  let videos = 0;
  for (const [mode, file] of Object.entries(reports)) {
    const report = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    const results = report.fixtures.flatMap((fixture) => fixture.results || []);
    const scored = results.filter((result) => result.expected && result.expected.length);
    const attempted = scored.filter((result) => result.word);
    const correct = scored.filter((result) => result.correct);
    const precision = (100 * correct.length / attempted.length).toFixed(1);
    const coverage = (100 * correct.length / scored.length).toFixed(1);
    console.log(`${mode}: ${precision}% precision, ${coverage}% coverage (${correct.length}/${scored.length})`);
    if (!popup.includes(`${precision}% precision`) || !popup.includes(`${coverage}% correct coverage`)) {
      throw new Error(`Popup metrics are stale for ${mode}.`);
    }
    if (mode === "whisper-only") {
      slots = scored.length;
      videos = report.fixtures.filter((fixture) => fixture.scoredCount).length;
    }
  }
  if (!popup.includes(`${slots.toLocaleString("en-US")} scored slots from ${videos} videos`)) {
    throw new Error("Popup benchmark sample size is stale.");
  }
}

for (const file of fs.readdirSync(path.join(root, "tests")).filter((name) => name.endsWith(".test.js")).sort()) {
  run("node", [path.join("tests", file)]);
}
run("./build.sh", ["1.3.0"]);
run("unzip", ["-tq", "dist/uncensored-youtube-firefox-1.3.0.zip"]);
run("unzip", ["-tq", "dist/uncensored-youtube-chromium-1.3.0.zip"]);
run("web-ext", ["lint", "--source-dir", "dist/firefox", "--warnings-as-errors"]);
run("npm", ["audit", "--omit=dev"]);

if (flags.has("--benchmark") || flags.has("--all")) benchmark();
if (flags.has("--browsers") || flags.has("--all")) {
  run("node", ["tools/browser-smoke.js", ...process.argv.slice(2).filter(function browserArgument(arg) {
    return !["--all", "--benchmark", "--browsers"].includes(arg);
  })]);
}
