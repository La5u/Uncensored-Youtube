const assert = require("assert");
const fs = require("fs");
const path = require("path");
const timedText = require("../src/timedtext");

const fixture = path.join(__dirname, "fixtures", "british.json");

if (!fs.existsSync(fixture)) {
  console.log("british-json.test.js skipped");
  process.exit(0);
}

const payload = JSON.parse(fs.readFileSync(fixture, "utf8"));
const result = timedText.patchTimedTextJson(payload);

function eventText(index) {
  return (payload.events[index].segs || []).map((seg) => seg.utf8 || "").join("");
}

assert.ok(result.patchCount > 0);
assert.strictEqual(eventText(375), "Jesus fucking Christ oh my [ __ ] god");
assert.strictEqual(eventText(377), "holy");
assert.strictEqual(eventText(379), "shit (or fuck) if something");
assert.strictEqual(eventText(467), "oh bollocks holy [ __ ] [ __ ] it Jesus");
assert.strictEqual(eventText(469), "fucking Christ now the last");

console.log("british-json.test.js passed");
