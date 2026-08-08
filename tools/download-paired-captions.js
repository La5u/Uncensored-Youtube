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
const CENSORED_RE = /\[\s*__\s*\]/gu;
const SWEAR_RE = /\b(?:fuck(?:ing|ed|er|ers)?|shit(?:ty|s)?|bitch(?:es)?|asshole|pussy|slut|whore|cunt|cock|piss|dick|bullshit|motherfuck(?:er|ing)?)\b/is;
const { ALLOWED_WORDS } = require("../src/rules-data");
const ALLOWED_WORDS_RE = new RegExp(
  `(^|[^A-Za-z0-9])(?:${ALLOWED_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['\\u2019]")).join("|")})(?=$|[^A-Za-z0-9])`,
  "giu"
);

function parseArgs(argv) {
  const args = {
    channels: "",
    "dry-run": "false",
    "max-check": "50",
    "pair-target": "12",
    "audio-target": "3",
    "audio-slot-threshold": "10",
    "skip-after-clean": "12",
    "list-limit": "80",
    jobs: "2",
    retries: "2",
    "retry-delay": "15",
    config: channelsPath,
    report: reportPath,
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
  args.maxCheck = Number(args["max-check"]);
  args.pairTarget = Number(args["pair-target"]);
  args.audioTarget = Number(args["audio-target"]);
  args.audioSlotThreshold = Number(args["audio-slot-threshold"]);
  args.skipAfterClean = Number(args["skip-after-clean"]);
  args.listLimit = Number(args["list-limit"]);
  args.jobs = Number(args.jobs);
  args.retries = Number(args.retries);
  args.retryDelay = Number(args["retry-delay"]);
  args.cookiesFromBrowser = String(args["cookies-from-browser"]).trim();
  const positive = [args.maxCheck, args.listLimit, args.jobs, args.retryDelay];
  const nonnegative = [args.pairTarget, args.audioTarget, args.audioSlotThreshold, args.skipAfterClean, args.retries];
  if (!positive.every((n) => Number.isInteger(n) && n > 0) ||
      !nonnegative.every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error("Limits/jobs must be positive; targets and thresholds may be zero.");
  }
  args.channelFilter = new Set(String(args.channels).split(",").map((s) => s.trim()).filter(Boolean));
  return args;
}

let retryCount = 2;
let retryDelayMs = 15000;
let blockedUntil = 0;
let cookiesArgs = [];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function transientFailure(result) {
  return result.status !== 0 &&
    /(?:HTTP Error 429|Too Many Requests|confirm you.re not a bot|temporar(?:y|ily)|timed? out|connection reset)/i
      .test(`${result.stdout}\n${result.stderr}`);
}

async function waitForBackoff() {
  while (Date.now() < blockedUntil) await sleep(blockedUntil - Date.now());
}

function runYtDlp(ytArgs) {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", ["--sleep-requests", "1", ...cookiesArgs, ...ytArgs], {
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
    if (!transientFailure(result)) return result;
    if (attempt < retryCount) {
      const delay = retryDelayMs * (2 ** attempt);
      blockedUntil = Math.max(blockedUntil, Date.now() + delay);
      console.warn(`[yt-dlp] transient failure; retrying after ${delay / 1000}s`);
    }
  }
  result.transient = true;
  blockedUntil = Math.max(blockedUntil, Date.now() + retryDelayMs * 8);
  console.warn(`[yt-dlp] rate limited; pausing new requests for ${retryDelayMs * 8 / 1000}s`);
  return result;
}

function throwIfTransient(result) {
  if (!result.transient) return;
  const error = new Error("yt-dlp transient failure");
  error.transient = true;
  throw error;
}

async function listEntries(source, limit) {
  const expanded = source.startsWith("ytsearch:")
    ? `ytsearch${limit}:${source.slice("ytsearch:".length)}`
    : source;
  const result = await runYtDlpWithRetry([
    "--flat-playlist",
    "--playlist-end", String(limit),
    "--print", "%(id)s\t%(title)s\t%(channel)s\t%(webpage_url)s",
    "--ignore-errors",
    expanded
  ]);
  if (result.status !== 0 && !result.stdout) {
    return { error: (result.stderr || "list failed").trim(), entries: [] };
  }
  const entries = String(result.stdout || "").split("\n").map((line) => {
    const [id, title, channel, url] = line.trim().split("\t");
    if (!id || id === "NA" || id.length < 6) return null;
    return {
      id,
      title: title || id,
      channel: channel || "",
      url: url && url !== "NA" ? url : `https://www.youtube.com/watch?v=${id}`
    };
  }).filter(Boolean);
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

const hasSwears = (filePath) => SWEAR_RE.test(readCaptionText(filePath));

function hasAudio(videoId) {
  return fs.existsSync(audioDir) &&
    fs.readdirSync(audioDir).some((name) => name.startsWith(`${videoId}.`));
}

function removeFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore cleanup failures */ }
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

async function synthesizeCensoredFrom(uncensoredPath, destination) {
  if (!uncensoredPath || !fs.existsSync(uncensoredPath)) return "";
  const json = JSON.parse(fs.readFileSync(uncensoredPath, "utf8"));
  let slots = 0;
  for (const event of json.events || []) {
    if (!Array.isArray(event.segs)) continue;
    for (const seg of event.segs) {
      if (typeof seg.utf8 !== "string") continue;
      seg.utf8 = seg.utf8.replace(ALLOWED_WORDS_RE, (match, before) => {
        slots += 1;
        return `${before}[__]`;
      });
    }
  }
  if (!slots) return "";
  fs.writeFileSync(destination, JSON.stringify(json));
  return destination;
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

async function tryAlternateGroundTruth(entry, autoLang, slots, destination) {
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
    if (hasSwears(filePath) && countCensored(filePath) < slots) {
      fs.renameSync(filePath, destination);
      cleanupVariants(entry.id, [destination]);
      return `auto-${lang}`;
    }
    removeFile(filePath);
  }
  return "";
}

async function processSynthetic(entry, captions, args, known, stats, item, reason) {
  const manualPath = path.join(fixturesDir, `${entry.id}_manual.en.json3`);
  const autoPath = path.join(fixturesDir, `${entry.id}_auto.en.json3`);
  let uncensored = "";
  if (captions.manualLang) uncensored = await downloadCaption(entry.url, entry.id, "manual", captions.manualLang);
  if (!uncensored && captions.alternateAuto) {
    uncensored = await downloadCaption(entry.url, entry.id, "auto", captions.alternateAuto);
    if (uncensored) {
      fs.renameSync(uncensored, manualPath);
      uncensored = manualPath;
    }
  }
  if (!uncensored || !hasSwears(uncensored)) {
    removeFile(uncensored);
    removeFile(manualPath);
    cleanupVariants(entry.id);
    item.status = reason;
    stats.noAutomatic += 1;
    return item;
  }
  if (!await synthesizeCensoredFrom(uncensored, autoPath)) {
    removeFile(uncensored);
    removeFile(manualPath);
    removeFile(autoPath);
    cleanupVariants(entry.id);
    item.status = reason;
    stats.noAutomatic += 1;
    return item;
  }
  if (manualPath !== uncensored) fs.renameSync(uncensored, manualPath);
  known.paired.add(entry.id);
  known.autos.add(entry.id);
  known.manuals.add(entry.id);
  item.status = "paired-saved";
  item.pairKind = "synthetic";
  item.slots = countCensored(autoPath);
  stats.pairedSaved += 1;
  stats.autoGtPaired += 1;
  cleanupVariants(entry.id, [autoPath, manualPath]);
  return item;
}

async function processVideo(entry, args, known, stats) {
  const item = {
    id: entry.id,
    title: entry.title,
    channel: entry.channel,
    source: entry.source,
    status: "",
    slots: 0,
    pairKind: ""
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

  const captions = await probe(entry.url);
  const autoPath = captions.autoLang
    ? await downloadCaption(entry.url, entry.id, "auto", captions.autoLang)
    : "";
  if (!autoPath) {
    if (!needPair || !captions.manualLang && !captions.alternateAuto) {
      item.status = "no-automatic";
      stats.noAutomatic += 1;
      return item;
    }
    return processSynthetic(entry, captions, args, known, stats, item, "no-automatic");
  }
  const slots = countCensored(autoPath);
  item.slots = slots;
  if (!slots) {
    removeFile(autoPath);
    cleanupVariants(entry.id);
    item.status = "no-censored-slots";
    stats.noCensoredSlots += 1;
    return item;
  }

  if (needPair) {
    const manualPath = path.join(fixturesDir, `${entry.id}_manual.en.json3`);
    let pairKind = "";
    if (captions.manualLang) {
      const downloaded = await downloadCaption(
        entry.url, entry.id, "manual", captions.manualLang
      );
      if (downloaded && hasSwears(downloaded) && countCensored(downloaded) < slots) {
        pairKind = captions.creatorManual ? "creator-manual" : "subtitle-en";
      } else {
        removeFile(downloaded);
        removeFile(manualPath);
      }
    }
    if (!pairKind) {
      pairKind = await tryAlternateGroundTruth(
        entry, captions.autoLang, slots, manualPath
      );
    }
    if (pairKind && fs.existsSync(autoPath) && fs.existsSync(manualPath)) {
      known.paired.add(entry.id);
      known.autos.add(entry.id);
      known.manuals.add(entry.id);
      item.status = "paired-saved";
      item.pairKind = pairKind;
      stats.pairedSaved += 1;
      if (pairKind === "creator-manual") stats.creatorPaired += 1;
      else stats.autoGtPaired += 1;
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

  removeFile(autoPath);
  removeFile(path.join(fixturesDir, `${entry.id}_manual.en.json3`));
  cleanupVariants(entry.id);
  item.status = "no-usable-gt";
  stats.noManual += 1;
  return item;
}

async function mapLimit(items, limit, worker) {
  let next = 0;
  async function runWorker() {
    while (next < items.length) {
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
  cookiesArgs = args.cookiesFromBrowser
    ? ["--cookies-from-browser", args.cookiesFromBrowser]
    : [];
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(path.dirname(args.report), { recursive: true });

  const config = JSON.parse(fs.readFileSync(args.config, "utf8"));
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
  const report = {
    pairTarget: args.pairTarget,
    audioTarget: args.audioTarget,
    audioSlotThreshold: args.audioSlotThreshold,
    jobs: args.jobs,
    retries: args.retries,
    retryDelay: args.retryDelay,
    startedAt: new Date().toISOString(),
    channels: []
  };
  const channelReports = channels.map((channel) => previousChannels.get(channel.name) || null);
  const inFlight = new Set();

  console.log(
    `Existing paired=${known.paired.size} audioOnly=${known.audioOnly.size}; ` +
    `channels=${channels.length}; pairTarget=${args.pairTarget} audioTarget=${args.audioTarget}`
  );

  function saveReport() {
    report.channels = channelReports.filter(Boolean);
    fs.writeFileSync(args.report, JSON.stringify(report, null, 2));
  }

  saveReport();
  await mapLimit(channels, args.jobs, async (channel, channelIndex) => {
    const previous = previousChannels.get(channel.name) || {};
    const stats = {
      name: channel.name,
      sources: channel.sources || [],
      availableEntries: previous.availableEntries || 0,
      checked: previous.checked || 0,
      pairedSaved: previous.pairedSaved || 0,
      creatorPaired: previous.creatorPaired || 0,
      autoGtPaired: previous.autoGtPaired || 0,
      audioSaved: previous.audioSaved ?? previous.audioFallbackSaved ?? 0,
      pairedAudioSaved: previous.pairedAudioSaved || 0,
      audioFallbackSaved: previous.audioFallbackSaved || 0,
      skippedExisting: previous.skippedExisting || 0,
      noManual: previous.noManual || 0,
      noAutomatic: previous.noAutomatic || 0,
      noCensoredSlots: previous.noCensoredSlots || 0,
      transientFailures: previous.transientFailures || 0,
      failed: previous.failed || 0,
      items: previous.items || [],
      complete: false
    };
    channelReports[channelIndex] = stats;
    saveReport();
    console.log(`\n=== ${channel.name}${stats.checked ? ` (resume after ${stats.checked})` : ""} ===`);

    const seen = new Set();
    const queue = [];
    for (const source of channel.sources || []) {
      const { error, entries } = await listEntries(source, args.listLimit);
      if (error && !entries.length) {
        console.log(`[${channel.name}] list ${source}: fail: ${error.slice(0, 100)}`);
        continue;
      }
      let added = 0;
      for (const entry of entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        queue.push({ ...entry, source });
        added += 1;
      }
      console.log(`[${channel.name}] list ${source}: ${entries.length} listed, ${added} new`);
    }

    stats.availableEntries = Math.max(stats.availableEntries, queue.length);
    const processed = new Set(stats.items
      .filter((item) => item.status !== "transient-failure")
      .map((item) => item.id));
    const pending = queue.filter((entry) => {
      if (processed.has(entry.id)) return false;
      if (!known.paired.has(entry.id)) return true;
      stats.skippedExisting += 1;
      return false;
    });

    let consecutiveClean = 0;

    for (const entry of pending) {
      if (stats.pairedSaved >= args.pairTarget && stats.audioSaved >= args.audioTarget) break;
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
        if (!error.transient) throw error;
        stats.transientFailures += 1;
        item = {
          id: entry.id,
          title: entry.title,
          channel: entry.channel,
          source: entry.source,
          status: "transient-failure",
          slots: 0,
          pairKind: ""
        };
      } finally {
        inFlight.delete(entry.id);
      }
      stats.items.push(item);
      saveReport();
      if (item.status === "paired-saved") consecutiveClean = 0;
      else if (item.status !== "transient-failure" &&
        (!item.slots || item.status === "no-usable-gt")) consecutiveClean += 1;
      const extra = [item.slots ? `slots=${item.slots}` : "", item.pairKind]
        .filter(Boolean).join(" ");
      console.log(`[${channel.name}] [${stats.checked}] ${item.status}${extra ? ` ${extra}` : ""}`);
    }

    stats.complete = true;
    saveReport();
    console.log(
      `[${channel.name}] summary: paired=${stats.pairedSaved} ` +
      `(creator=${stats.creatorPaired} autoGT=${stats.autoGtPaired}) ` +
      `audio=${stats.audioSaved} (paired=${stats.pairedAudioSaved} ` +
      `fallback=${stats.audioFallbackSaved}) checked=${stats.checked}`
    );
  });

  report.finishedAt = new Date().toISOString();
  report.totals = report.channels.reduce((totals, channel) => {
    totals.paired += channel.pairedSaved;
    totals.creatorPaired += channel.creatorPaired;
    totals.autoGtPaired += channel.autoGtPaired;
    totals.audio += channel.audioSaved;
    totals.pairedAudio += channel.pairedAudioSaved;
    totals.audioFallback += channel.audioFallbackSaved;
    totals.checked += channel.checked;
    totals.transientFailures += channel.transientFailures;
    return totals;
  }, {
    paired: 0,
    creatorPaired: 0,
    autoGtPaired: 0,
    audio: 0,
    pairedAudio: 0,
    audioFallback: 0,
    checked: 0,
    transientFailures: 0
  });
  saveReport();
  console.log(`\nDone. ${JSON.stringify(report.totals)}`);
  console.log(`Report: ${args.report}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
