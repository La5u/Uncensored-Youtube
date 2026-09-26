#!/usr/bin/env node
// Sends a desktop notification when each watched acquisition run finishes.
// Usage: node tools/notify-when-done.js <report.json>[,<checked-ledger.json>] ...
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const jobs = process.argv.slice(2).map((arg) => {
  const [report, ledger] = arg.split(",");
  return { report, ledger, done: false };
});
if (!jobs.length) {
  console.error("usage: node tools/notify-when-done.js <report.json>[,<ledger.json>] ...");
  process.exit(1);
}

const POLL_MS = 60000;
const SETTLE_MS = 15000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function running(reportPath) {
  try {
    execSync(`pgrep -f "download-paired-captions\\.js.*${path.basename(reportPath)}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function notify(title, body, urgent) {
  try {
    execSync(`notify-send -a uncensored-corpus -u ${urgent ? "critical" : "normal"} '${title}' '${body.replace(/'/g, "")}'`);
  } catch (error) {
    console.error("notify-send failed:", error.message);
  }
}

function summarize(job) {
  const report = readJson(job.report) || {};
  let stats = null;
  if (job.ledger) {
    const checks = Object.values((readJson(job.ledger) || {}).checks || {});
    let saved = 0;
    const byStatus = {};
    for (const status of checks) {
      byStatus[status] = (byStatus[status] || 0) + 1;
      if (status === "paired-saved") saved += 1;
    }
    stats = { checked: checks.length, saved, byStatus };
  }
  const minutes = report.startedAt ? Math.round((Date.now() - Date.parse(report.startedAt)) / 60000) : null;
  const label = report.target || path.basename(job.report);
  const parts = [];
  if (stats) parts.push(`${stats.checked} videos checked, ${stats.saved} pairs saved`);
  if (minutes !== null) parts.push(`${Math.floor(minutes / 60)}h${minutes % 60}m`.replace(/^0h/, ""));
  return { label, completed: report.queueComplete === true, body: `${label}: ${parts.join(", ")}` };
}

(async () => {
  console.log(`Watching ${jobs.length} acquisition job(s) via notify-send.`);
  while (jobs.some((job) => !job.done)) {
    for (const job of jobs) {
      if (job.done || running(job.report)) continue;
      await sleep(SETTLE_MS);
      const { label, completed, body } = summarize(job);
      job.done = true;
      if (completed) {
        notify("Caption download finished", body);
      } else {
        notify("Caption download STOPPED", `${body} — not queue-complete, check the log`, true);
      }
      console.log(`[${new Date().toISOString()}] ${label}: ${completed ? "completed" : "stopped"} — ${body}`);
    }
    if (jobs.some((job) => !job.done)) await sleep(POLL_MS);
  }
  if (jobs.length > 1) notify("All caption downloads finished", `${jobs.length} jobs watched`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
