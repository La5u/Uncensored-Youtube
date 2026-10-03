const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "../tools/browser-smoke.js"), "utf8");
const helper = source.slice(source.indexOf("function playbackExpression("),
  source.indexOf("function fetchTransparencyExpression("));
const expression = vm.runInNewContext(`${helper}\nplaybackExpression()`, { rate: 1 });
let buttons = [];
const video = { play() { return Promise.resolve(); } };
const context = {
  localStorage: { setItem() {} }, location: { href: "test" },
  document: {
    querySelector(selector) { return selector === "video" ? video : null; },
    querySelectorAll() { return buttons; }
  }
};
function button(text, visible = true) {
  return { textContent: text, clicks: 0, getClientRects() { return visible ? [{}] : []; },
    click() {
      assert.strictEqual(video.muted, true);
      assert.strictEqual(video.volume, 0);
      this.clicks++;
    } };
}
// Repeated evaluations handle consent arriving after the initial player evaluation.
vm.runInNewContext(expression, context);
buttons = [button("Accept all"), button("Reject all cookies"), button("Reject all", false),
  button(" Reject all ")];
vm.runInNewContext(expression, context);
assert.deepStrictEqual(buttons.map(node => node.clicks), [0, 0, 0, 1]);
buttons = [button("Tout accepter"), button("TOUT REFUSER")];
vm.runInNewContext(expression, context);
assert.deepStrictEqual(buttons.map(node => node.clicks), [0, 1]);
context.document.querySelector = () => null;
buttons = [];
vm.runInNewContext(expression, context);
console.log("Browser smoke consent mocks passed.");
