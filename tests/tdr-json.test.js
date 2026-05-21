const assert = require("assert");
const fs = require("fs");
const path = require("path");
const timedText = require("../src/timedtext");

const fixture = path.join(__dirname, "fixtures", "tdr.json");

if (!fs.existsSync(fixture)) {
  console.log("tdr-json.test.js skipped");
  process.exit(0);
}

const payload = JSON.parse(fs.readFileSync(fixture, "utf8"));
const result = timedText.patchTimedTextJson(payload);

function eventText(index) {
  return (payload.events[index].segs || []).map((seg) => seg.utf8 || "").join("");
}

assert.ok(result.patchCount > 0);
assert.strictEqual(eventText(79), "Shut the fuck up right now. I");
assert.strictEqual(eventText(11), "now and shut the fuck up. Shut the fuck");
assert.strictEqual(eventText(13), "up right now or I'll beat the shit out");

console.log("tdr-json.test.js passed");
