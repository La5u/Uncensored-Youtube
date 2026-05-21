const assert = require("assert");
const fs = require("fs");
const path = require("path");
const timedText = require("../src/timedtext");

const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "example.json"), "utf8"));
const result = timedText.patchTimedTextJson(payload);
const patchedText = payload.events
  .map((event) => (event.segs || []).map((seg) => seg.utf8 || "").join(""))
  .join("\n");

assert.strictEqual(result.patchCount, 72);

assert.ok(patchedText.includes("add attachments. Holy shit. (or fuck)"));
assert.ok(patchedText.includes("Whoa. What the fuck is this thing?"));
assert.ok(patchedText.includes("EAT SHIT AND DIE, PIG."));
assert.ok(patchedText.includes("GET OFF ME, SON OF A BITCH. Here"));
assert.ok(patchedText.includes("THAT'S FUCKED"));
assert.ok(patchedText.includes("AH, I PRESSED SPACE. WHAT THE FUCK"));
assert.ok(patchedText.includes("want. This game fucking rules."));
assert.ok(patchedText.includes("gamified but really fucking cool."));
assert.ok(patchedText.includes("Um, well, get fucked then."));
assert.ok(patchedText.includes("Stressful as fuck"));
assert.ok(patchedText.includes("Jesus fucking Christ"));

assert.ok(!patchedText.includes("Holy Shit"));
assert.ok(!patchedText.includes("Holy shit. (or fuck)\nThere's"));
assert.ok(!patchedText.includes("What the Fuck"));
assert.ok(!patchedText.includes("EAT shit"));
assert.ok(!patchedText.includes("SON OF A bitch"));
assert.ok(!patchedText.includes("THAT'S fucked"));
assert.strictEqual((patchedText.match(/fuck yeah/g) || []).length, 0);
assert.strictEqual((patchedText.match(/Fuck yeah/g) || []).length, 8);

console.log("example-json.test.js passed");
