const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(require.resolve("../src/audio-capture"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHarness(decode = () => Promise.resolve({ duration: 10 })) {
  const calls = [];
  const timers = new Map();
  const listeners = {};
  let nextTimer = 0;
  const video = {
    currentTime: 0,
    addEventListener(type, listener) { listeners[type] = listener; },
    removeEventListener(type) { delete listeners[type]; }
  };
  const context = {
    location: { href: "https://www.youtube.com/watch?v=test" },
    document: {
      querySelector(selector) { return selector === "video" ? video : null; },
      querySelectorAll() { return []; }
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime: { sendMessage(message, callback) { callback({ ready: true }); } } },
    AudioContext: class AudioContext {
      decodeAudioData(buffer) {
        calls.push(new Uint8Array(buffer)[0]);
        return decode(calls.length);
      }
      close() { return Promise.resolve(); }
    },
    URL, ArrayBuffer, Float32Array, console,
    UncensoredRules: {
      CENSORED_TOKEN_REGEX: /\[__\]/,
      ALLOWED_WORDS: [],
      applyDeterministicRules() { return { replacements: [] }; },
      formatWordCase(word) { return word; }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "audio-capture.js" });
  const audio = context.UncensoredAudioInference;
  async function flush() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
  async function runQueue() {
    for (let i = 0; i < 20; i += 1) {
      await flush();
      const due = Array.from(timers.entries()).find(([, timer]) => timer.delay === 0);
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
    }
    throw new Error("Mock queue did not settle");
  }
  function send(startMs, id = 1) {
    return audio.setSabrAudioData({
      buffer: new Uint8Array([id]).buffer, startMs, durationMs: 10000
    });
  }
  function track(timeSeconds, trackId = "track-a", extra = {}) {
    audio.rememberTimedTextData({
      tokens: [Object.assign({ tokenIndex: 0, timeSeconds, context: "say [__] now" }, extra)],
      timeline: []
    }, trackId);
  }
  return { audio, context, calls, timers, listeners, video, flush, runQueue, send, track };
}

async function timeoutAndModeRecovery() {
  const h = makeHarness((count) => count === 1 ? new Promise(() => {}) : Promise.resolve({ duration: 10 }));
  const first = h.send(0);
  await h.flush();
  const timeout = Array.from(h.timers.values()).find((timer) => timer.delay === 15000);
  assert.ok(timeout);
  timeout.callback();
  await first;
  await h.send(0);
  assert.strictEqual(h.calls.length, 2, "failed decode must be replayable");
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: false });
  h.track(5);
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: true });
  await h.send(0);
  assert.strictEqual(h.calls.length, 3, "disabling audio releases retained dedup");
  await h.send(100000);
  assert.strictEqual(h.calls.length, 3, "unneeded encoded audio is ignored");
}

async function staleNavigationQueue() {
  const old = deferred();
  const fresh = deferred();
  const h = makeHarness((count) => count === 1 ? old.promise : fresh.promise);
  h.send(0, 1);
  await h.flush();
  h.send(10000, 2);
  h.send(20000, 3);
  const oldQueue = h.send(30000, 4);
  h.context.location.href = "https://www.youtube.com/watch?v=new";
  h.listeners["yt-navigate-finish"]();
  const newQueue = h.send(10000, 5);
  assert.deepStrictEqual(h.calls, [1], "decode remains serial across navigation");
  old.resolve({ duration: 10 });
  await oldQueue;
  await h.flush();
  assert.deepStrictEqual(h.calls, [1, 5], "queued old-video segments must not decode");
  assert.strictEqual(h.audio.mediaAudio.segments.length, 0, "old PCM is discarded");
  const duplicate = h.send(10000, 6);
  fresh.resolve({ duration: 10 });
  await newQueue;
  await duplicate;
  assert.deepStrictEqual(h.calls, [1, 5], "stale skips must not release new-video reservations");
  assert.strictEqual(h.audio.mediaAudio.segments.length, 1);
  assert.strictEqual(h.audio.mediaAudio.videoId, "new");
}

async function queuedNeedChanges() {
  for (const change of ["track", "seek", "mode"]) {
    const first = deferred();
    const h = makeHarness(() => first.promise);
    h.audio.setOptions({ rulesEnabled: false });
    h.track(12, "track-a", { deterministicWord: "fuck" });
    h.send(0);
    await h.flush();
    const queued = h.send(10000);
    if (change === "track") h.track(100, "track-b");
    if (change === "seek") {
      h.video.currentTime = 100;
      h.listeners.seeking();
    }
    if (change === "mode") h.audio.setOptions({ rulesEnabled: true });
    first.resolve({ duration: 10 });
    await queued;
    assert.strictEqual(h.calls.length, 1, `${change}: queued audio must recheck current need`);
    assert.strictEqual(h.audio.mediaAudio.segments.length, 0, `${change}: unneeded PCM is evicted`);
    h.video.currentTime = 0;
    h.track(12, "track-c");
    await h.send(10000);
    assert.strictEqual(h.calls.length, 2, `${change}: skipped reservation must be replayable`);
  }
}

async function contextTimeNeedChanges() {
  for (const change of ["navigation", "track"]) {
    const h = makeHarness();
    h.track(5);
    const AudioContext = h.context.AudioContext;
    h.context.AudioContext = class extends AudioContext {
      constructor() {
        super();
        if (change === "track") h.track(100, "track-b");
        else {
          h.context.location.href = "https://www.youtube.com/watch?v=new";
          h.listeners["yt-navigate-finish"]();
        }
      }
    };
    await h.send(0);
    assert.strictEqual(h.calls.length, 0, `${change}: recheck immediately before decodeAudioData`);
  }
}

async function retainedAndInflightDedup() {
  const decode = deferred();
  const h = makeHarness(() => decode.promise);
  const first = h.send(0);
  await h.flush();
  h.track(5);
  h.listeners.seeking();
  h.audio.setOptions({ whisperEnabled: false });
  h.audio.setOptions({ whisperEnabled: true });
  const duplicate = h.send(0);
  decode.resolve({ duration: 10 });
  await first;
  await duplicate;
  await h.send(0);
  assert.strictEqual(h.calls.length, 1, "in-flight and retained duplicates decode only once");
  h.track(5);
  h.listeners.seeking();
  await h.send(0);
  assert.strictEqual(h.calls.length, 1, "seek must not discard retained dedup ownership");
}

async function evictionReplay() {
  for (const change of ["track", "mode"]) {
    const h = makeHarness();
    await h.send(0);
    assert.strictEqual(h.audio.mediaAudio.segments.length, 1);
    if (change === "track") h.track(100);
    else h.audio.rememberTimedTextData({ tokens: [
      { tokenIndex: 0, timeSeconds: 5, context: "say [__] now", deterministicWord: "fuck" },
      { tokenIndex: 1, timeSeconds: 100, context: "later [__] now" }
    ], timeline: [] }, "track-a");
    await h.runQueue();
    assert.strictEqual(h.audio.mediaAudio.segments.length, 0, `${change}: old PCM must be evicted`);
    if (change === "track") h.track(5, "track-b");
    else h.audio.setOptions({ whisperFirst: true });
    assert.strictEqual(h.audio.pendingTokenValues().length, change === "track" ? 1 : 2);
    await h.send(0);
    assert.strictEqual(h.calls.length, 2, `${change}: newly eligible audio must decode again`);
    assert.strictEqual(h.audio.mediaAudio.segments.length, 1);
    await h.send(0);
    assert.strictEqual(h.calls.length, 2, `${change}: replayed PCM remains deduplicated`);
  }
}

(async function main() {
  await timeoutAndModeRecovery();
  await staleNavigationQueue();
  await queuedNeedChanges();
  await contextTimeNeedChanges();
  await retainedAndInflightDedup();
  await evictionReplay();
  console.log("audio-decode.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
