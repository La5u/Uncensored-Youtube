"use strict";
// Helpers shared by several tools. Keep one copy here instead of per-tool variants.
const fs = require("fs");
const path = require("path");

// Readers never see a partial file: write a unique temporary file, then rename it.
function writeAtomic(file, contents) {
  const destination = path.resolve(file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, destination);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never written */ }
  }
}

// A JSON object from `snapshot` or `file`; missing, malformed and non-object JSON yield `fallback`.
function readJson(file, fallback = null, snapshot) {
  try {
    const value = JSON.parse(snapshot === undefined ? fs.readFileSync(file, "utf8") : snapshot);
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}

// Creator identity for folds and creator gates: a canonical channel ID wins over aliases;
// otherwise a normalized name. Placeholders such as unknown, N/A or anonymous yield null.
function creatorKey(row) {
  const id = typeof row.creatorId === "string" ? row.creatorId.trim() : "";
  if (/^UC[A-Za-z0-9_-]{22}$/.test(id)) return "id:" + id;
  const name = typeof row.creator === "string" ? row.creator.normalize("NFKC").trim()
    .toLowerCase().replace(/\s+/g, " ") : "";
  const placeholder = name.replace(/[^\p{L}\p{N}]/gu, "");
  if (!placeholder || /^(unknown|unknowncreator|unknownchannel|na|none|null|undefined|anonymous|anon|unidentified|notavailable|notapplicable)$/.test(placeholder)) return null;
  return "name:" + name;
}

module.exports = { writeAtomic, readJson, creatorKey };
