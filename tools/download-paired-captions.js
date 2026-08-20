#!/usr/bin/env node
/**
 * Download paired censored/uncensored YouTube captions, with audio fallbacks.
 *
 * Re-running resumes from the report and skips both saved pairs and checked videos.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const fixturesDir = path.join(root, "test-fixtures");
const audioDir = path.join(fixturesDir, "audio");
const channelsPath = path.join(__dirname, "paired-caption-channels.json");
const reportPath = path.join(root, "corpus/generated/paired-caption-download-report.json");
const checkedLedgerPath = path.join(root, "corpus/generated/checked-video-ledger.json");
const CENSORED_RE = /\[\s*__\s*\]/gu;
const { ALLOWED_WORDS } = require("../src/rules-data");
const { groundTruthWords } = require("./evaluation-alignment");
const ALLOWED_WORDS_RE = new RegExp(
  `(^|[^A-Za-z0-9])(?:${ALLOWED_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['\\u2019]")).join("|")})(?=$|[^A-Za-z0-9])`,
  "giu"
);

// Keep the legacy pairKind (it is present in old reports), but give every
// saved pair a stable provenance classification.  The fixture filenames
// intentionally stay `_auto`/`_manual` for evaluator compatibility. In a
// pairClass, the first word is the uncensored track and the second is the
// censored automatic track (for example, auto-auto is the high-value pair);
// synthetic is kept separate because its censored side was generated locally.
const PAIR_PROVENANCE = Object.freeze({
  "creator-manual": { pairClass: "manual-auto", censoredKind: "auto-censored", uncensoredKind: "manual" },
  "subtitle-en": { pairClass: "manual-auto", censoredKind: "auto-censored", uncensoredKind: "manual" },
  "auto-en": { pairClass: "auto-auto", censoredKind: "auto-censored", uncensoredKind: "auto-uncensored" },
  "auto-en-en": { pairClass: "auto-auto", censoredKind: "auto-censored", uncensoredKind: "auto-uncensored" },
  // These values occur in historical reports produced by the old synthetic
  // fallback. They are not equivalent to a real censored automatic track.
  synthetic: { pairClass: "synthetic", censoredKind: "synthetic-censored", uncensoredKind: "unknown" },
  "synthetic-auto": { pairClass: "synthetic", censoredKind: "synthetic-censored", uncensoredKind: "auto-uncensored" }
});
const PAIR_PROVENANCE_VERSION = 1;
const CHECKED_LEDGER_VERSION = 1;
const NEGATIVE_CHECK_STATUSES = new Set([
  "no-manual",
  "no-automatic",
  "no-censored-slots",
  "already-censored-auto",
  "no-allowed-words",
  "no-usable-gt",
  "audio-failed"
]);
const CHECKED_VIDEO_TYPES = new Set([
  "synthetic-auto", "auto-auto", "manual-auto", "audio", "paired"
]);

function classifyPairKind(pairKind) {
  const provenance = PAIR_PROVENANCE[pairKind];
  return provenance ? { ...provenance } : {
    pairClass: "",
    censoredKind: "",
    uncensoredKind: ""
  };
}

function summarizePairItems(items) {
  const counts = { manualAuto: 0, autoAuto: 0, synthetic: 0 };
  for (const item of items || []) {
    if (item.status !== "paired-saved") continue;
    const pairClass = item.pairClass || classifyPairKind(item.pairKind).pairClass;
    if (pairClass === "manual-auto") counts.manualAuto += 1;
    else if (pairClass === "auto-auto") counts.autoAuto += 1;
    else if (pairClass === "synthetic") counts.synthetic += 1;
  }
  return counts;
}

function checkedVideoType(args) {
  if (args.syntheticAutoOnly) return "synthetic-auto";
  if (args.autoAutoOnly) return "auto-auto";
  if (args.manualAutoOnly) return "manual-auto";
  if (args.pairTarget === 0 && args.audioTarget > 0) return "audio";
  return "paired";
}

function checkedVideoKey(videoId, checkType) {
  return `${videoId}|${checkType}`;
}

function emptyCheckedVideoLedger() {
  return { version: CHECKED_LEDGER_VERSION, checks: Object.create(null) };
}

function loadCheckedVideoLedger(filePath = checkedLedgerPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && parsed.version === CHECKED_LEDGER_VERSION &&
        parsed.checks && typeof parsed.checks === "object" && !Array.isArray(parsed.checks)) {
      const checks = Object.fromEntries(Object.entries(parsed.checks).filter(([key, status]) => {
        const separator = key.indexOf("|");
        return separator > 0 && CHECKED_VIDEO_TYPES.has(key.slice(separator + 1)) &&
          NEGATIVE_CHECK_STATUSES.has(status);
      }));
      return { version: CHECKED_LEDGER_VERSION, checks };
    }
  } catch { /* an absent or incomplete ledger is safe to rebuild */ }
  return emptyCheckedVideoLedger();
}

function saveCheckedVideoLedger(ledger, filePath = checkedLedgerPath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomic(filePath, JSON.stringify(ledger));
}

function hasCheckedVideo(ledger, videoId, checkType) {
  return NEGATIVE_CHECK_STATUSES.has(ledger?.checks?.[checkedVideoKey(videoId, checkType)]);
}

function recordCheckedVideo(ledger, videoId, checkType, status) {
  if (!videoId || !checkType || !NEGATIVE_CHECK_STATUSES.has(status)) return false;
  const key = checkedVideoKey(videoId, checkType);
  if (ledger.checks[key] === status) return false;
  ledger.checks[key] = status;
  return true;
}

function checkedVideoTypeFromReport(report) {
  return checkedVideoType({
    syntheticAutoOnly: report.syntheticAutoOnly === true,
    autoAutoOnly: report.autoAutoOnly === true,
    manualAutoOnly: report.manualAutoOnly === true,
    pairTarget: Number(report.pairTarget) || 0,
    audioTarget: Number(report.audioTarget) || 0
  });
}

function importCheckedVideoReports(ledger, reportsDir, excludePath) {
  if (!fs.existsSync(reportsDir)) return false;
  const excluded = excludePath ? path.resolve(excludePath) : "";
  let changed = false;
  for (const name of fs.readdirSync(reportsDir)) {
    if (!name.endsWith("-report.json")) continue;
    const filePath = path.join(reportsDir, name);
    if (path.resolve(filePath) === excluded || fs.existsSync(`${filePath}.lock`)) continue;
    let report;
    try {
      report = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch { continue; }
    if (!report || typeof report !== "object" || Array.isArray(report)) continue;
    const checkType = checkedVideoTypeFromReport(report);
    for (const channel of report.channels || []) {
      for (const item of channel.items || []) {
        if (recordCheckedVideo(ledger, item.id, item.checkType || checkType, item.status)) {
          changed = true;
        }
      }
    }
  }
  return changed;
}

function distributedSample(items, limit) {
  if (!limit || items.length <= limit) return items;
  if (limit === 1) return [items[0]];
  return Array.from({ length: limit }, (_, index) =>
    items[Math.round(index * (items.length - 1) / (limit - 1))]);
}

function parseArgs(argv) {
  const args = {
    channels: "",
    revisit: "false",
    "dry-run": "false",
    "synthetic-auto-only": "false",
    "auto-auto-only": "false",
    "manual-auto-only": "false",
    "max-check": "50",
    "pair-target": "12",
    "audio-target": "3",
    "audio-slot-threshold": "10",
    "new-slot-cap": "0",
    "skip-after-clean": "12",
    "list-limit": "80",
    "sample-per-channel": "0",
    jobs: "2",
    retries: "2",
    "retry-delay": "15",
    "request-sleep": "1",
    "max-global-429": "4",
    config: channelsPath,
    report: reportPath,
    "checked-ledger": checkedLedgerPath,
    "cookies-from-browser": ""
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = "true";
    else {
      args[key] = next;
      i += 1;
    }
  }
  args.dryRun = args["dry-run"] === "true";
  args.syntheticAutoOnly = args["synthetic-auto-only"] === "true";
  args.autoAutoOnly = args["auto-auto-only"] === "true";
  args.manualAutoOnly = args["manual-auto-only"] === "true";
  args.revisit = args.revisit === "true";
  args.maxCheck = Number(args["max-check"]);
  args.pairTarget = Number(args["pair-target"]);
  args.audioTarget = Number(args["audio-target"]);
  args.audioSlotThreshold = Number(args["audio-slot-threshold"]);
  args.newSlotCap = Number(args["new-slot-cap"]);
  args.skipAfterClean = Number(args["skip-after-clean"]);
  args.listLimit = Number(args["list-limit"]);
  args.samplePerChannel = Number(args["sample-per-channel"]);
  args.jobs = Number(args.jobs);
  args.retries = Number(args.retries);
  args.retryDelay = Number(args["retry-delay"]);
  args.requestSleep = Number(args["request-sleep"]);
  args.maxGlobal429 = Number(args["max-global-429"]);
  args.cookiesFromBrowser = String(args["cookies-from-browser"]).trim();
  args.checkedLedger = String(args["checked-ledger"]).trim() || checkedLedgerPath;
  const positive = [args.maxCheck, args.listLimit, args.jobs, args.retryDelay];
  const nonnegative = [args.pairTarget, args.audioTarget, args.audioSlotThreshold,
    args.skipAfterClean, args.retries, args.newSlotCap, args.maxGlobal429,
    args.samplePerChannel];
  if (!positive.every((n) => Number.isInteger(n) && n > 0) ||
      !nonnegative.every((n) => Number.isInteger(n) && n >= 0) ||
      !Number.isFinite(args.requestSleep) || args.requestSleep < 0) {
    throw new Error("Limits/jobs must be positive; targets and thresholds may be zero.");
  }
  args.channelFilter = new Set(String(args.channels).split(",").map((s) => s.trim()).filter(Boolean));
  if ([args.syntheticAutoOnly, args.autoAutoOnly, args.manualAutoOnly].filter(Boolean).length > 1) {
    throw new Error("Caption pair-only modes are mutually exclusive.");
  }
  return args;
}

let retryCount = 2;
let retryDelayMs = 15000;
let blockedUntil = 0;
let cookiesArgs = [];
let requestSleepSeconds = 1;
let maxGlobal429 = 4;
let consecutiveGlobal429 = 0;
let runAborted = false;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function transientFailure(result) {
  return result.status !== 0 &&
    /(?:HTTP Error 429|Too Many Requests|confirm you.re not a bot|temporar(?:y|ily)|timed? out|connection reset|failed to resolve|name or service not known|network is unreachable)/i
      .test(`${result.stdout}\n${result.stderr}`);
}

async function waitForBackoff() {
  while (Date.now() < blockedUntil) await sleep(blockedUntil - Date.now());
}

function runYtDlp(ytArgs) {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", ["--sleep-requests", String(requestSleepSeconds),
      ...cookiesArgs, ...ytArgs], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({
      status: 1,
      stdout,
      stderr: `${stderr}\n${error.message}`
    }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runYtDlpWithRetry(ytArgs) {
  let result;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    await waitForBackoff();
    result = await runYtDlp(ytArgs);
    if (!transientFailure(result)) {
      consecutiveGlobal429 = 0;
      return result;
    }
    if (attempt < retryCount) {
      const delay = retryDelayMs * (2 ** attempt);
      blockedUntil = Math.max(blockedUntil, Date.now() + delay);
      console.warn(`[yt-dlp] transient failure; retrying after ${delay / 1000}s`);
    }
  }
  result.transient = true;
  if (/HTTP Error 429|Too Many Requests|confirm you.re not a bot/i
    .test(`${result.stdout}\n${result.stderr}`)) {
    consecutiveGlobal429 += 1;
    if (maxGlobal429 && consecutiveGlobal429 >= maxGlobal429) {
      runAborted = true;
      result.abortRun = true;
    }
  }
  blockedUntil = Math.max(blockedUntil, Date.now() + retryDelayMs * 8);
  console.warn(`[yt-dlp] rate limited; pausing new requests for ${retryDelayMs * 8 / 1000}s`);
  return result;
}

function throwIfTransient(result) {
  if (!result.transient) return;
  const error = new Error("yt-dlp transient failure");
  error.transient = true;
  error.abortRun = result.abortRun;
  throw error;
}

async function listEntries(source, limit) {
  const expanded = source.startsWith("ytsearch:")
    ? `ytsearch${limit}:${source.slice("ytsearch:".length)}`
    : source;
  const result = await runYtDlpWithRetry([
    "--flat-playlist",
    "--playlist-end", String(limit),
    "--print", "%(id)s\t%(title)s\t%(channel)s\t%(channel_id)s\t%(webpage_url)s",
    "--ignore-errors",
    expanded
  ]);
  throwIfTransient(result);
  if (result.status !== 0 && !result.stdout) {
    return { error: (result.stderr || "list failed").trim(), entries: [] };
  }
  const entries = String(result.stdout || "").split("\n").map((line) => {
    const [id, title, channel, channelId, url] = line.trim().split("\t");
    if (!id || id === "NA" || id.length < 6) return null;
    return {
      id,
      title: title || id,
      channel: channel || "",
      channelId: channelId === "NA" ? "" : channelId,
      url: url && url !== "NA" ? url : `https://www.youtube.com/watch?v=${id}`
    };
  }).filter(Boolean);
  if (!entries.length) {
    return { error: (result.stderr || "empty listing").trim(), entries: [] };
  }
  return { error: "", entries };
}

function existingFixtures() {
  const autos = new Set();
  const manuals = new Set();
  for (const name of fs.readdirSync(fixturesDir)) {
    let match = name.match(/^([A-Za-z0-9_-]{11})_auto\.en\.json3$/);
    if (match) autos.add(match[1]);
    match = name.match(/^([A-Za-z0-9_-]{11})_manual\.en\.json3$/);
    if (match) manuals.add(match[1]);
  }
  const paired = new Set([...autos].filter((id) => manuals.has(id)));
  const audioOnly = new Set();
  if (fs.existsSync(audioDir)) {
    for (const name of fs.readdirSync(audioDir)) {
      const match = name.match(/^([A-Za-z0-9_-]{11})\./);
      if (match && autos.has(match[1]) && !manuals.has(match[1])) audioOnly.add(match[1]);
    }
  }
  return { autos, manuals, paired, audioOnly };
}

function readCaptionText(filePath) {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return (json.events || []).map((event) =>
      Array.isArray(event.segs) ? event.segs.map((seg) => seg.utf8 || "").join("") : ""
    ).join(" ");
  } catch {
    return "";
  }
}

function countCensored(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  const matches = fs.readFileSync(filePath, "utf8").match(CENSORED_RE);
  return matches ? matches.length : 0;
}

function hasSwears(filePath) {
  ALLOWED_WORDS_RE.lastIndex = 0;
  return ALLOWED_WORDS_RE.test(readCaptionText(filePath));
}

function synthesizeCensoredCaption(sourcePath, destinationPath) {
  const payload = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  let slots = 0;
  for (const event of payload.events || []) {
    for (const segment of event.segs || []) {
      segment.utf8 = String(segment.utf8 || "").replace(ALLOWED_WORDS_RE, (match, prefix) => {
        slots += 1;
        return `${prefix}[__]`;
      });
    }
  }
  if (slots) fs.writeFileSync(destinationPath, JSON.stringify(payload));
  return slots;
}

function captionEvents(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return (payload.events || []).map((event) => ({
      start: Number(event.tStartMs || 0),
      end: Number(event.tStartMs || 0) + Number(event.dDurationMs || 0),
      text: (event.segs || []).map((segment) => segment.utf8 || "").join("")
    }));
  } catch {
    return [];
  }
}

function hasTimedGroundTruth(censoredPath, uncensoredPath, requireSameTimeline = false) {
  const censoredEvents = captionEvents(censoredPath);
  const uncensoredEvents = captionEvents(uncensoredPath);
  const sameTimeline = censoredEvents.length === uncensoredEvents.length &&
    censoredEvents.every((event, index) => (
      event.start === uncensoredEvents[index].start && event.end === uncensoredEvents[index].end
    ));
  let found = false;
  const valid = sameTimeline && censoredEvents.every((event, index) => {
    CENSORED_RE.lastIndex = 0;
    if (!CENSORED_RE.test(event.text)) return true;
    found = true;
    const pattern = event.text.split(/\[\s*__\s*\]/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("([\\s\\S]*?)");
    const match = new RegExp(`^${pattern}$`, "u").exec(uncensoredEvents[index].text);
    return Boolean(match && match.slice(1).every((replacement) => (
      requireSameTimeline ? groundTruthWords(replacement).length : /\p{L}/u.test(replacement)
    )));
  });
  if (found && valid) return true;
  if (requireSameTimeline) return false;
  const censored = censoredEvents.filter((event) => {
    CENSORED_RE.lastIndex = 0;
    return CENSORED_RE.test(event.text);
  });
  const uncensored = uncensoredEvents.filter((event) => groundTruthWords(event.text).length);
  return censored.some((slot) => uncensored.some((candidate) => (
    candidate.start <= slot.end + 1500 && candidate.end >= slot.start - 1500
  )));
}

function hasAudio(videoId) {
  return fs.existsSync(audioDir) &&
    fs.readdirSync(audioDir).some((name) => name.startsWith(`${videoId}.`));
}

function removeFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore cleanup failures */ }
}

function writeAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, contents);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    removeFile(temporaryPath);
    throw error;
  }
}

function acquireReportLock(filePath) {
  const lockPath = `${filePath}.lock`;
  try {
    const descriptor = fs.openSync(lockPath, "wx");
    fs.writeFileSync(descriptor, String(process.pid));
    fs.closeSync(descriptor);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = fs.readFileSync(lockPath, "utf8").trim() || "unknown";
    throw new Error(`Report is already being written by PID ${owner}: ${filePath}`);
  }
  let released = false;
  const stop = (code) => () => {
    release();
    process.exit(code);
  };
  const stopInt = stop(130);
  const stopTerm = stop(143);
  const release = () => {
    if (released) return;
    released = true;
    removeFile(lockPath);
    process.removeListener("exit", release);
    process.removeListener("SIGINT", stopInt);
    process.removeListener("SIGTERM", stopTerm);
  };
  process.once("exit", release);
  process.once("SIGINT", stopInt);
  process.once("SIGTERM", stopTerm);
  return release;
}

function cleanupVariants(videoId, keep = []) {
  const kept = new Set(keep.map((filePath) => path.basename(filePath)));
  for (const name of fs.readdirSync(fixturesDir)) {
    if (!name.startsWith(`${videoId}_`) || !name.endsWith(".json3") || kept.has(name)) continue;
    if (/_(?:auto|manual)\.en(?:-|$)/.test(name) || name.includes(".en-") || name.includes("_gt.")) {
      removeFile(path.join(fixturesDir, name));
    }
  }
}

async function downloadCaption(url, videoId, kind, lang) {
  const suffix = kind === "auto" ? "_auto" : "_manual";
  const template = path.join(fixturesDir, `${videoId}${suffix}.%(ext)s`);
  const flags = kind === "auto"
    ? ["--write-auto-subs", "--sub-langs", lang]
    : ["--write-subs", "--sub-langs", lang];
  const result = await runYtDlpWithRetry([
    "--no-playlist", "--no-overwrites",
    ...flags, "--sub-format", "json3", "--skip-download",
    "-o", template, url
  ]);
  throwIfTransient(result);

  const preferred = path.join(fixturesDir, `${videoId}${suffix}.en.json3`);
  const candidates = fs.readdirSync(fixturesDir)
    .filter((name) => name.startsWith(`${videoId}${suffix}.`) && name.endsWith(".json3"))
    .map((name) => path.join(fixturesDir, name));
  if (!candidates.length) return "";
  const exact = candidates.find((filePath) => filePath.endsWith(`.${lang}.json3`))
    || candidates.find((filePath) => filePath.endsWith(".en.json3"))
    || candidates[0];
  if (exact !== preferred) fs.renameSync(exact, preferred);
  for (const filePath of candidates) {
    if (filePath !== exact && filePath !== preferred) removeFile(filePath);
  }
  return fs.existsSync(preferred) ? preferred : "";
}

async function probe(url) {
  const result = await runYtDlpWithRetry([
    "--no-playlist", "--skip-download", "--list-subs", url
  ]);
  throwIfTransient(result);
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const lower = text.toLowerCase();
  const autoIndex = lower.indexOf("available automatic captions");
  const manualIndex = lower.indexOf("available subtitles");
  const autoBlock = autoIndex < 0 ? "" : text.slice(
    autoIndex,
    manualIndex > autoIndex ? manualIndex : undefined
  );
  const manualBlock = manualIndex < 0 ? "" : text.slice(
    manualIndex,
    autoIndex > manualIndex ? autoIndex : undefined
  );
  const languages = (block) => {
    const found = new Set();
    for (const line of block.split("\n")) {
      const match = line.match(/^([a-z]{2}(?:-[A-Za-z0-9-]+)?)\s{2,}/);
      if (match) found.add(match[1]);
    }
    return [...found];
  };
  const autoLanguages = languages(autoBlock);
  const manualLanguages = languages(manualBlock).filter((lang) => /^en/i.test(lang));
  return {
    creatorManual: manualLanguages.length > 0,
    manualLang: manualLanguages.includes("en") ? "en" : (manualLanguages[0] || ""),
    autoLang: autoLanguages.includes("en-orig")
      ? "en-orig"
      : (autoLanguages.includes("en") ? "en" : ""),
    alternateAuto: autoLanguages.includes("en-en") ? "en-en" : ""
  };
}

async function downloadAudio(url, videoId) {
  if (hasAudio(videoId)) return true;
  const result = await runYtDlpWithRetry([
    "--no-playlist", "--no-overwrites",
    "-f", "ba[ext=webm]/ba",
    "-o", path.join(audioDir, `${videoId}.%(ext)s`),
    url
  ]);
  throwIfTransient(result);
  return result.status === 0 && hasAudio(videoId);
}

async function tryAlternateGroundTruth(entry, autoLang, slots, censoredPath, destination) {
  const template = path.join(fixturesDir, `${entry.id}_gt.%(ext)s`);
  for (const lang of ["en-en", "en"]) {
    if (lang === autoLang) continue;
    const result = await runYtDlpWithRetry([
      "--no-playlist",
      "--write-auto-subs", "--sub-langs", lang,
      "--sub-format", "json3", "--skip-download",
      "-o", template, entry.url
    ]);
    throwIfTransient(result);
    const name = fs.readdirSync(fixturesDir)
      .find((candidate) => candidate.startsWith(`${entry.id}_gt.`) && candidate.endsWith(".json3"));
    if (!name) continue;
    const filePath = path.join(fixturesDir, name);
    if (hasTimedGroundTruth(censoredPath, filePath, true) && countCensored(filePath) < slots) {
      fs.renameSync(filePath, destination);
      cleanupVariants(entry.id, [destination]);
      return `auto-${lang}`;
    }
    removeFile(filePath);
  }
  return "";
}

async function processVideo(entry, args, known, stats) {
  const item = {
    id: entry.id,
    title: entry.title,
    channel: entry.channel,
    creatorId: entry.channelId || "",
    source: entry.source,
    status: "",
    slots: 0,
    pairKind: "",
    pairClass: "",
    censoredKind: "",
    uncensoredKind: ""
  };
  if (known.paired.has(entry.id)) {
    item.status = "skipped-existing-paired";
    stats.skippedExisting += 1;
    return item;
  }

  const needPair = stats.pairedSaved < args.pairTarget;
  const needAudio = stats.audioSaved < args.audioTarget;
  if (!needPair && known.audioOnly.has(entry.id)) {
    item.status = "skipped-existing-audio";
    stats.skippedExisting += 1;
    return item;
  }
  if (!needPair && !needAudio) {
    item.status = "targets-met";
    return item;
  }
  if (args.dryRun) {
    item.status = "dry-run";
    return item;
  }

  const existingAutoPath = args.autoAutoOnly
    ? path.join(fixturesDir, `${entry.id}_auto.en.json3`) : "";
  const preserveAuto = Boolean(existingAutoPath && fs.existsSync(existingAutoPath));
  const captions = preserveAuto ? { autoLang: "" } : await probe(entry.url);
  if (args.manualAutoOnly && !captions.manualLang) {
    item.status = "no-manual";
    stats.noManual += 1;
    return item;
  }
  const autoPath = preserveAuto ? existingAutoPath : (captions.autoLang
    ? await downloadCaption(entry.url, entry.id, "auto", captions.autoLang)
    : "");
  if (!autoPath) {
    item.status = "no-automatic";
    stats.noAutomatic += 1;
    return item;
  }
  const slots = countCensored(autoPath);
  item.slots = slots;
  if (args.syntheticAutoOnly) {
    if (slots || !hasSwears(autoPath)) {
      removeFile(autoPath);
      cleanupVariants(entry.id);
      item.status = slots ? "already-censored-auto" : "no-allowed-words";
      if (!slots) stats.noCensoredSlots += 1;
      return item;
    }
    const manualPath = path.join(fixturesDir, `${entry.id}_manual.en.json3`);
    fs.copyFileSync(autoPath, manualPath);
    item.slots = synthesizeCensoredCaption(manualPath, autoPath);
    if (!item.slots) {
      removeFile(autoPath);
      removeFile(manualPath);
      item.status = "no-allowed-words";
      stats.noCensoredSlots += 1;
      return item;
    }
    if (args.newSlotCap && stats.newSlots + item.slots > args.newSlotCap) {
      removeFile(autoPath);
      removeFile(manualPath);
      item.status = "new-slot-cap";
      return item;
    }
    known.paired.add(entry.id);
    known.autos.add(entry.id);
    known.manuals.add(entry.id);
    item.status = "paired-saved";
    item.pairKind = "synthetic-auto";
    Object.assign(item, classifyPairKind(item.pairKind));
    stats.pairedSaved += 1;
    stats.newSlots += item.slots;
    stats.syntheticPaired += 1;
    cleanupVariants(entry.id, [autoPath, manualPath]);
    return item;
  }
  if (!slots) {
    if (!preserveAuto) removeFile(autoPath);
    cleanupVariants(entry.id, preserveAuto ? [autoPath] : []);
    item.status = "no-censored-slots";
    stats.noCensoredSlots += 1;
    return item;
  }

  if (needPair) {
    if (args.newSlotCap && stats.newSlots + slots > args.newSlotCap) {
      if (!preserveAuto) removeFile(autoPath);
      cleanupVariants(entry.id, preserveAuto ? [autoPath] : []);
      item.status = "new-slot-cap";
      return item;
    }
    const manualPath = path.join(fixturesDir, `${entry.id}_manual.en.json3`);
    let pairKind = "";
    if (!args.autoAutoOnly && captions.manualLang) {
      const downloaded = await downloadCaption(
        entry.url, entry.id, "manual", captions.manualLang
      );
      if (downloaded && hasTimedGroundTruth(autoPath, downloaded) && countCensored(downloaded) < slots) {
        pairKind = captions.creatorManual ? "creator-manual" : "subtitle-en";
      } else {
        removeFile(downloaded);
        removeFile(manualPath);
      }
    }
    if (!pairKind && !args.manualAutoOnly) {
      pairKind = await tryAlternateGroundTruth(
        entry, captions.autoLang, slots, autoPath, manualPath
      );
    }
    if (pairKind && fs.existsSync(autoPath) && fs.existsSync(manualPath)) {
      known.paired.add(entry.id);
      known.autos.add(entry.id);
      known.manuals.add(entry.id);
      item.status = "paired-saved";
      item.pairKind = pairKind;
      Object.assign(item, classifyPairKind(pairKind));
      stats.pairedSaved += 1;
      stats.newSlots += slots;
      if (pairKind === "creator-manual") stats.creatorPaired += 1;
      if (item.pairClass === "manual-auto") stats.manualAutoPaired += 1;
      else if (item.pairClass === "auto-auto") {
        stats.autoAutoPaired += 1;
        stats.autoGtPaired += 1;
      } else if (item.pairClass === "synthetic") stats.syntheticPaired += 1;
      cleanupVariants(entry.id, [autoPath, manualPath]);
      if (needAudio && slots >= args.audioSlotThreshold &&
          await downloadAudio(entry.url, entry.id)) {
        stats.audioSaved += 1;
        stats.pairedAudioSaved += 1;
        item.audio = true;
      }
      return item;
    }
  }

  if (needAudio && slots >= args.audioSlotThreshold) {
    if (known.audioOnly.has(entry.id) || (known.autos.has(entry.id) && hasAudio(entry.id))) {
      item.status = "skipped-existing-audio";
      stats.skippedExisting += 1;
      return item;
    }
    if (await downloadAudio(entry.url, entry.id)) {
      known.audioOnly.add(entry.id);
      known.autos.add(entry.id);
      item.status = "audio-fallback-saved";
      stats.audioSaved += 1;
      stats.audioFallbackSaved += 1;
      cleanupVariants(entry.id, [autoPath]);
      removeFile(path.join(fixturesDir, `${entry.id}_manual.en.json3`));
      return item;
    }
    removeFile(autoPath);
    cleanupVariants(entry.id);
    item.status = "audio-failed";
    stats.failed += 1;
    return item;
  }

  if (!preserveAuto) removeFile(autoPath);
  removeFile(path.join(fixturesDir, `${entry.id}_manual.en.json3`));
  cleanupVariants(entry.id, preserveAuto ? [autoPath] : []);
  item.status = "no-usable-gt";
  stats.noManual += 1;
  return item;
}

async function mapLimit(items, limit, worker) {
  let next = 0;
  async function runWorker() {
    while (next < items.length && !runAborted) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  retryCount = args.retries;
  retryDelayMs = args.retryDelay * 1000;
  requestSleepSeconds = args.requestSleep;
  maxGlobal429 = args.maxGlobal429;
  consecutiveGlobal429 = 0;
  runAborted = false;
  cookiesArgs = args.cookiesFromBrowser
    ? ["--cookies-from-browser", args.cookiesFromBrowser]
    : [];
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.mkdirSync(path.dirname(args.checkedLedger), { recursive: true });
  acquireReportLock(args.report);
  if (path.resolve(args.checkedLedger) !== path.resolve(args.report)) {
    acquireReportLock(args.checkedLedger);
  }

  const rawConfig = JSON.parse(fs.readFileSync(args.config, "utf8"));
  const config = rawConfig.channels ? rawConfig : {
    channels: (rawConfig.candidates || []).map((candidate) => ({
      name: candidate.name,
      channelId: candidate.channelId || "",
      sources: [candidate.url]
    }))
  };
  let previousChannels = new Map();
  if (fs.existsSync(args.report)) {
    try {
      const previous = JSON.parse(fs.readFileSync(args.report, "utf8"));
      previousChannels = new Map((previous.channels || [])
        .filter(Boolean)
        .map((channel) => [channel.name, channel]));
    } catch { /* start fresh after an incomplete report write */ }
  }

  let channels = (config.channels || []).concat(
    (config.searchChannels || []).map((name) => ({
      name,
      sources: [`ytsearch:${name} official channel`]
    }))
  );
  channels = channels.filter((channel, index) =>
    channels.findIndex((candidate) => candidate.name === channel.name) === index
  );
  if (args.channelFilter.size) {
    channels = channels.filter((channel) => args.channelFilter.has(channel.name));
    if (!channels.length) {
      throw new Error(`No channels matched: ${[...args.channelFilter].join(", ")}`);
    }
  }

  const known = existingFixtures();
  const checkedLedger = loadCheckedVideoLedger(args.checkedLedger);
  const hadCheckedLedger = Object.keys(checkedLedger.checks).length > 0;
  let checkedLedgerDirty = false;
  const checkType = checkedVideoType(args);
  if (!hadCheckedLedger && args.checkedLedger === checkedLedgerPath) {
    checkedLedgerDirty = importCheckedVideoReports(
      checkedLedger, path.dirname(args.checkedLedger), args.report
    );
  }
  if (!args.revisit) {
    for (const channel of previousChannels.values()) {
      for (const item of channel.items || []) {
        if (recordCheckedVideo(
          checkedLedger, item.id, item.checkType || checkType, item.status
        )) checkedLedgerDirty = true;
      }
    }
  }
  const untouchedReports = args.channelFilter.size
    ? [...previousChannels.values()].filter((channel) => !args.channelFilter.has(channel.name))
    : [];
  const report = {
    pairProvenanceVersion: PAIR_PROVENANCE_VERSION,
    syntheticAutoOnly: args.syntheticAutoOnly,
    autoAutoOnly: args.autoAutoOnly,
    manualAutoOnly: args.manualAutoOnly,
    pairTarget: args.pairTarget,
    audioTarget: args.audioTarget,
    audioSlotThreshold: args.audioSlotThreshold,
    newSlotCap: args.newSlotCap,
    jobs: args.jobs,
    retries: args.retries,
    retryDelay: args.retryDelay,
    startedAt: new Date().toISOString(),
    channels: []
  };
  const channelReports = channels.map((channel) =>
    args.revisit ? null : previousChannels.get(channel.name) || null);
  const inFlight = new Set();

  console.log(
    `Existing paired=${known.paired.size} audioOnly=${known.audioOnly.size}; ` +
    `channels=${channels.length}; pairTarget=${args.pairTarget} audioTarget=${args.audioTarget}`
  );

  function saveReport() {
    if (checkedLedgerDirty) {
      saveCheckedVideoLedger(checkedLedger, args.checkedLedger);
      checkedLedgerDirty = false;
    }
    report.channels = untouchedReports.concat(channelReports.filter(Boolean));
    writeAtomic(args.report, JSON.stringify(report, null, 2));
  }

  saveReport();
  await mapLimit(channels, args.jobs, async (channel, channelIndex) => {
    const previous = args.revisit ? {} : previousChannels.get(channel.name) || {};
    const previousAudio = previous.audioSaved ?? previous.audioFallbackSaved ?? 0;
    const previousItems = (previous.items || []).map((item) => item.pairClass
      ? item
      : { ...item, ...classifyPairKind(item.pairKind) });
    const previousPairCounts = summarizePairItems(previousItems);
    const previousSlots = previousItems.reduce((total, item) =>
      total + (item.status === "paired-saved" ? Number(item.slots) || 0 : 0), 0);
    if (previous.complete && previous.pairedSaved >= args.pairTarget &&
        previousAudio >= args.audioTarget) {
      previous.items = previousItems;
      previous.manualAutoPaired ??= previousPairCounts.manualAuto;
      previous.autoAutoPaired ??= previousPairCounts.autoAuto;
      previous.syntheticPaired ??= previousPairCounts.synthetic;
      channelReports[channelIndex] = previous;
      saveReport();
      return;
    }
    const stats = {
      name: channel.name,
      sources: channel.sources || [],
      availableEntries: previous.availableEntries || 0,
      checked: previous.checked || 0,
      pairedSaved: previous.pairedSaved || 0,
      newSlots: previous.newSlots ?? previousSlots,
      creatorPaired: previous.creatorPaired || 0,
      autoGtPaired: previous.autoGtPaired || 0,
      manualAutoPaired: previous.manualAutoPaired ?? previousPairCounts.manualAuto,
      autoAutoPaired: previous.autoAutoPaired ?? previousPairCounts.autoAuto,
      syntheticPaired: previous.syntheticPaired ?? previousPairCounts.synthetic,
      audioSaved: previousAudio,
      pairedAudioSaved: previous.pairedAudioSaved || 0,
      audioFallbackSaved: previous.audioFallbackSaved || 0,
      skippedExisting: 0,
      skippedChecked: 0,
      noManual: previous.noManual || 0,
      noAutomatic: previous.noAutomatic || 0,
      noCensoredSlots: previous.noCensoredSlots || 0,
      transientFailures: previous.transientFailures || 0,
      listFailures: previous.listFailures || 0,
      failed: previous.failed || 0,
      items: previousItems,
      complete: false
    };
    channelReports[channelIndex] = stats;
    let consecutiveClean = 0;
    const isClean = (item) => item.status !== "transient-failure" &&
      (args.syntheticAutoOnly ? item.status !== "paired-saved" :
        (!item.slots || item.status === "no-usable-gt"));
    for (let index = stats.items.length - 1; index >= 0; index -= 1) {
      const item = stats.items[index];
      if (item.status === "paired-saved") break;
      if (isClean(item)) consecutiveClean += 1;
    }
    if (consecutiveClean >= args.skipAfterClean) {
      stats.complete = true;
      saveReport();
      return;
    }
    saveReport();
    console.log(`\n=== ${channel.name}${stats.checked ? ` (resume after ${stats.checked})` : ""} ===`);

    const seen = new Set();
    const queue = [];
    let listedSource = false;
    let listingFailed = false;
    for (const source of channel.sources || []) {
      let listed;
      try {
        listed = await listEntries(source, args.listLimit);
      } catch (error) {
        if (error.abortRun || !error.transient) throw error;
        stats.transientFailures += 1;
        console.log(`[${channel.name}] list ${source}: transient failure`);
        continue;
      }
      const { error, entries } = listed;
      if (error && !entries.length) {
        listingFailed = true;
        console.log(`[${channel.name}] list ${source}: fail: ${error.slice(0, 100)}`);
        continue;
      }
      listedSource = true;
      let added = 0;
      for (const entry of entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        queue.push({ ...entry, channelId: entry.channelId || channel.channelId || "", source });
        added += 1;
      }
      console.log(`[${channel.name}] list ${source}: ${entries.length} listed, ${added} new`);
    }

    if (listingFailed && !listedSource) {
      stats.listFailures += 1;
      saveReport();
      return;
    }

    const sampledQueue = distributedSample(queue, args.samplePerChannel);
    stats.availableEntries = Math.max(stats.availableEntries, queue.length);
    const processed = new Set(stats.items
      .filter((item) => item.status !== "transient-failure")
      .map((item) => item.id));
    const pending = sampledQueue.filter((entry) => {
      if (processed.has(entry.id)) return false;
      if (known.paired.has(entry.id)) {
        stats.skippedExisting += 1;
        return false;
      }
      if (checkType === "audio" && known.audioOnly.has(entry.id)) {
        stats.skippedExisting += 1;
        return false;
      }
      if (!args.revisit && hasCheckedVideo(checkedLedger, entry.id, checkType)) {
        stats.skippedChecked += 1;
        return false;
      }
      return true;
    });

    for (const entry of pending) {
      if ((args.newSlotCap && stats.newSlots >= args.newSlotCap * 0.99) ||
          (stats.pairedSaved >= args.pairTarget && stats.audioSaved >= args.audioTarget)) break;
      if (stats.checked >= args.maxCheck) break;
      if (consecutiveClean >= args.skipAfterClean) {
        console.log(
          `[${channel.name}] skipping: ${consecutiveClean} videos in a row had no [__] slots`
        );
        break;
      }
      if (inFlight.has(entry.id)) {
        stats.skippedExisting += 1;
        continue;
      }
      inFlight.add(entry.id);
      stats.checked += 1;
      console.log(`[${channel.name}] [${stats.checked}] ${entry.id} ${String(entry.title).slice(0, 55)}`);
      let item;
      try {
        item = await processVideo(entry, args, known, stats);
      } catch (error) {
        if (error.abortRun) throw error;
        if (!error.transient) throw error;
        stats.transientFailures += 1;
        item = {
          id: entry.id,
          title: entry.title,
          channel: entry.channel,
          creatorId: entry.channelId || "",
          source: entry.source,
          status: "transient-failure",
          slots: 0,
          pairKind: "",
          pairClass: "",
          censoredKind: "",
          uncensoredKind: "",
          checkType
        };
      } finally {
        inFlight.delete(entry.id);
      }
      item.checkType = checkType;
      if (recordCheckedVideo(checkedLedger, item.id, checkType, item.status)) {
        checkedLedgerDirty = true;
      }
      stats.items.push(item);
      saveReport();
      if (item.status === "paired-saved") consecutiveClean = 0;
      else if (isClean(item)) consecutiveClean += 1;
      const extra = [item.slots ? `slots=${item.slots}` : "", item.pairKind]
        .filter(Boolean).join(" ");
      console.log(`[${channel.name}] [${stats.checked}] ${item.status}${extra ? ` ${extra}` : ""}`);
    }

    stats.complete = true;
    saveReport();
    console.log(
      `[${channel.name}] summary: paired=${stats.pairedSaved} ` +
      `(manual-auto=${stats.manualAutoPaired} auto-auto=${stats.autoAutoPaired} ` +
      `synthetic=${stats.syntheticPaired}) ` +
      `audio=${stats.audioSaved} (paired=${stats.pairedAudioSaved} ` +
      `fallback=${stats.audioFallbackSaved}) checked=${stats.checked}`
    );
  });

  if (report.channels.every((channel) => channel.complete)) {
    report.finishedAt = new Date().toISOString();
  }
  report.totals = report.channels.reduce((totals, channel) => {
    const pairCounts = summarizePairItems(channel.items);
    totals.paired += channel.pairedSaved;
    totals.newSlots += channel.newSlots || 0;
    totals.creatorPaired += channel.creatorPaired;
    totals.autoGtPaired += channel.autoGtPaired;
    totals.manualAutoPaired += channel.manualAutoPaired ?? pairCounts.manualAuto;
    totals.autoAutoPaired += channel.autoAutoPaired ?? pairCounts.autoAuto;
    totals.syntheticPaired += channel.syntheticPaired ?? pairCounts.synthetic;
    totals.audio += channel.audioSaved;
    totals.pairedAudio += channel.pairedAudioSaved;
    totals.audioFallback += channel.audioFallbackSaved;
    totals.checked += channel.checked;
    totals.transientFailures += channel.transientFailures;
    ["noAutomatic", "noCensoredSlots", "noManual", "failed", "listFailures", "skippedExisting", "skippedChecked"].forEach((key) => {
      totals[key] = (totals[key] || 0) + (channel[key] || 0);
    });
    return totals;
  }, {
    paired: 0,
    newSlots: 0,
    creatorPaired: 0,
    autoGtPaired: 0,
    manualAutoPaired: 0,
    autoAutoPaired: 0,
    syntheticPaired: 0,
    audio: 0,
    pairedAudio: 0,
    audioFallback: 0,
    checked: 0,
    transientFailures: 0,
    skippedChecked: 0
  });
  saveReport();
  console.log(`\nDone. ${JSON.stringify(report.totals)}`);
  console.log(`Report: ${args.report}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  acquireReportLock,
  classifyPairKind,
  checkedVideoKey,
  checkedVideoType,
  checkedVideoTypeFromReport,
  distributedSample,
  hasSwears,
  hasTimedGroundTruth,
  hasCheckedVideo,
  importCheckedVideoReports,
  loadCheckedVideoLedger,
  parseArgs,
  recordCheckedVideo,
  saveCheckedVideoLedger,
  summarizePairItems,
  synthesizeCensoredCaption,
  writeAtomic
};
