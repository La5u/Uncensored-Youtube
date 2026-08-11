const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { hasSwears, parseArgs } = require("../tools/download-paired-captions");

assert.strictEqual(parseArgs(["--revisit"]).revisit, true);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensored-pair-"));
const caption = path.join(directory, "caption.json3");
fs.writeFileSync(caption, JSON.stringify({
  events: [{ segs: [{ utf8: "well, fucking hell" }] }]
}));
assert.strictEqual(hasSwears(caption), true);
fs.rmSync(directory, { recursive: true, force: true });
console.log("download-paired-captions.test.js passed");
