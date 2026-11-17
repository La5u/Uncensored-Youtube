const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync(require.resolve("../src/audio-capture"), "utf8");

function makeHarness(responses, browser = false) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map();
  const messages = [];
  const posted = [];
  const listeners = {};
  const video = { currentTime: 1, paused: false,
    addEventListener(type, listener) { listeners[type] = listener; }, removeEventListener() {} };
  const context = {
    location: { href: "https://www.youtube.com/watch?v=video-a" },
    document: { querySelector(selector) { return selector === "video" ? video : null; }, querySelectorAll() { return []; } },
    addEventListener(type, listener) { listeners[type] = listener; },
    requestAnimationFrame(callback) { callback(); },
    MutationObserver: class MutationObserver {
      disconnect() {}
      observe() {}
    },
    URL,
    Float32Array,
    ArrayBuffer,
    Promise,
    console,
    postMessage(message) { posted.push(message); },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { at: now + (delay || 0), callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    UncensoredRules: {
      CENSORED_TOKEN: "[__]",
      CENSORED_TOKEN_REGEX: /\[__\]/,
      ALLOWED_WORDS: ["fuck", "shit"],
      applyDeterministicRules() { return { replacements: [] }; },
      formatWordCase(word) { return word; }
    }
  };
  context.chrome = { runtime: {
    sendMessage(message, callback) {
      messages.push(message);
      if (message.type === "preload") {
        callback({ ok: true, ready: true, acousticHead: "loaded" });
        return;
      }
      const response = responses.shift();
      if (response) response(callback, context);
    }
  } };
  if (browser) context.browser = { runtime: {
    sendMessage(message) { return new Promise((resolve) => context.chrome.runtime.sendMessage(message, resolve)); }
  } };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "audio-capture.js" });

  async function flush() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }
  function runDue() {
    let ran = false;
    for (;;) {
      const due = Array.from(timers.entries())
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      ran = true;
    }
    return ran;
  }
  async function settle() {
    for (let i = 0; i < 12; i += 1) {
      await flush();
      if (!runDue()) break;
    }
    await flush();
  }
  async function advance(ms) {
    now += ms;
    await settle();
  }
  function addAudio(duration = 3) {
    context.UncensoredAudioInference.mediaAudio.segments.push({
      startTime: 0, endTime: duration,
      buffer: {
        sampleRate: 16000, length: duration * 16000, numberOfChannels: 1, duration,
        getChannelData() { return new Float32Array(duration * 16000); }
      }
    });
  }
  function token(index, eventIndex = index, timeSeconds = 1) {
    return { tokenIndex: index, eventIndex, eventTokenIndex: index, timeSeconds,
      context: "say [__] now", candidates: ["fuck"] };
  }
  function start(tokens, trackId = "track-a", videoId = "video-a", rulesEnabled = false, duration = 3, extra = {}) {
    context.UncensoredAudioInference.setOptions(Object.assign({
      rulesEnabled, whisperEnabled: true, audioEnabled: true, videoId
    }, extra));
    addAudio(duration);
    context.UncensoredAudioInference.rememberTimedTextData(
      { tokens, timeline: [] }, trackId, videoId
    );
  }
  return { context, messages, posted, listeners, advance, start, token, addAudio, video,
    audio: context.UncensoredAudioInference };
}

async function hybridUsesFullWhisperPath() {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{
    word: 'shit', evidence: 'transcript', hybridCrossFamily: true
  }] } })]);
  const deterministic = Object.assign(h.token(0), {
    deterministicWord: 'fuck', deterministicCandidates: ['fuck'],
    deterministicTier: 'fallback', candidates: ['fuck']
  });
  h.start([deterministic], 'track-a', 'video-a', true, 3, { whisperFirst: true });
  await h.advance(0);
  const request = h.messages.find((message) => message.type === 'transcribe');
  assert.ok(request, 'Whisper first must check rule-filled slots');
  assert.ok(request.data.candidates.includes('fuck'));
  assert.ok(request.data.candidates.includes('shit'));
  assert.deepStrictEqual(Array.from(request.data.candidates), ['fuck', 'shit']);
  assert.strictEqual(JSON.parse(h.posted.at(-1).uncensoredWhisperResolution).word, 'shit');
}

// Window timings (warm-up already excluded by the worker) pick the automatic mode once 5 are stored.
async function windowSpeedPicksAutoMode(seeded, inferenceMs, expected) {
  const h = makeHarness([(callback) => callback({ decision: { inferenceMs, decisions: [{ word: "fuck", evidence: "transcript" }] } })]);
  let stored = { whisperSpeed: seeded };
  h.context.chrome.storage = { local: {
    get: (defaults) => Promise.resolve(Object.assign({}, defaults, stored)),
    set: (values) => { stored = Object.assign({}, stored, values); return Promise.resolve(); }
  } };
  h.start([h.token(0)]);
  await h.advance(0);
  assert.strictEqual(stored.whisperSpeed.length, seeded.length + 1);
  assert.ok(Math.abs(stored.whisperSpeed.at(-1) - inferenceMs / 1000 / 1.38) < 1e-9, "relative to 0.74 s + 0.64 s per blank");
  assert.strictEqual(stored.autoMode, expected);
}

async function successAfterTransient() {
  const h = makeHarness([
    (callback) => callback({ error: "temporary" }),
    (callback) => callback({ decision: { decisions: [{ word: "fuck", evidence: "transcript" }] } })
  ]);
  h.start([h.token(0)]);
  await h.advance(0);
  await h.advance(250);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 2);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
  assert.strictEqual(JSON.parse(h.posted[0].uncensoredWhisperResolution).word, "fuck");
}

async function exhaustedCap() {
  const h = makeHarness([(callback) => callback({ error: "temporary" }),
    (callback) => callback({ error: "temporary" })]);
  h.start([h.token(0)]);
  await h.advance(0);
  await h.advance(250);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 2);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
}

async function emptyDoesNotRetry() {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{ word: "", transcript: "", evidence: "none" }] } })]);
  h.start([h.token(0)]);
  await h.advance(0);
  await h.advance(1000);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 1);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
  assert.strictEqual(h.posted.length, 0);
}

async function rulesFirstSkipsRuleFills() {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{ word: "shit", evidence: "candidate-score" }] } })]);
  const ruled = Object.assign(h.token(0), { deterministicWord: "fuck", deterministicCandidates: ["fuck"] });
  const ambiguous = Object.assign(h.token(1, 1, 1.2), { deterministicWord: "fuck", deterministicAmbiguous: true });
  h.start([ruled, ambiguous], "track-a", "video-a", true);
  await h.advance(0);
  const requests = h.messages.filter((message) => message.type === "transcribe");
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].data.options.slots.length, 1, "only the ambiguous slot is scored");
}

async function nearbyTokensShareWindow() {
  const h = makeHarness([(callback) => callback({ error: "temporary" }),
    (callback) => callback({ decision: { decisions: [
      { word: "fuck", evidence: "candidate-score" }, { word: "shit", evidence: "candidate-score" }
    ] } })]);
  h.start([Object.assign(h.token(0, 4, 1), { precedingWords: [{ word: "oh", time: 0.5 }], nextWord: "no" }),
    Object.assign(h.token(1, 4, 1.2), { precedingWords: [{ word: "oh", time: 0.5 }, { word: "no", time: 1.1 }] })]);
  await h.advance(0);
  await h.advance(250);
  const requests = h.messages.filter((message) => message.type === "transcribe");
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(JSON.stringify(requests[0].data.options.slots.map((slot) =>
    [slot.tokenIndex, slot.prefix.map((word) => word.word).join(" "), slot.nextWord || ""])),
  JSON.stringify([[0, "oh", "no"], [1, "oh no", ""]]));
  // The acoustic head needs each slot's time from the window start; it is on by default.
  assert.strictEqual(JSON.stringify(requests[0].data.options.slots.map((slot) => slot.time)), "[1,1.2]");
  assert.strictEqual(requests[0].data.options.acousticHead, true);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
  assert.strictEqual(h.posted.length, 2);
}

// Switching the head off drops its fills (head-on-uncertain or fused) and rescores those slots without it.
async function acousticHeadSwitch(evidence = "acoustic-head") {
  const fused = evidence === "acoustic-fusion" ? { decoderWord: "fuck" } : {};
  const h = makeHarness([(callback) => callback({ decision: { decisions: [Object.assign({ word: "shit", evidence,
    head: { word: "shit", p: 0.987 } }, fused)] } }),
    (callback) => callback({ decision: { decisions: [{ word: "", evidence: "none" }] } })]);
  const debug = [];
  h.context.localStorage = { getItem: (key) => key === "uncensoredDebug" ? "1" : null };
  h.context.console = { debug: (line) => debug.push(line), warn() {} };
  h.start([h.token(0)]);
  await h.advance(0);
  // Debug log: head status at model start, and the head's top word when it was consulted.
  assert.ok(debug.includes('[uncensored] whisper model started {"acousticHead":"loaded"}'), debug.join("\n"));
  // A fused decision also names the decoder's word.
  assert.ok(debug.includes(`[uncensored] whisper decision {"token":0,"word":"shit","evidence":"${evidence}","head":"shit 0.99"` +
    (fused.decoderWord ? ',"decoder":"fuck"}' : "}")), debug.join("\n"));
  assert.strictEqual(JSON.parse(h.posted[0].uncensoredWhisperResolution).evidence, evidence);
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: true, audioEnabled: true, videoId: "video-a",
    acousticHead: false });
  h.addAudio();
  await h.advance(0);
  const requests = h.messages.filter((message) => message.type === "transcribe");
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[1].data.options.acousticHead, false);
}

// A same-track refresh that rewrites a slot drops the old slot's in-flight result.
async function sameTrackRefreshDropsStaleResult() {
  let reply;
  const h = makeHarness([(callback) => { reply = callback; }]);
  h.start([h.token(0)]);
  await h.advance(0);
  assert.ok(reply, "the original slot is in flight");
  h.audio.rememberTimedTextData({ tokens: [Object.assign(h.token(0), { context: "said [__] later" })], timeline: [] },
    "track-a", "video-a");
  reply({ decision: { decisions: [{ word: "fuck", evidence: "candidate-score" }] } });
  await h.advance(0);
  assert.ok(!h.posted.some((message) => message.uncensoredWhisperResolution &&
    JSON.parse(message.uncensoredWhisperResolution).word === "fuck"), "stale result must not publish");
}

// Audio ends with the video, so a slot in its last 1.5 s must still get a window.
async function endOfVideoSlotScored() {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{ word: "fuck", evidence: "candidate-score" }] } })]);
  h.video.currentTime = 8;
  h.video.duration = 10;
  h.start([h.token(0, 0, 9.5)], "track-a", "video-a", false, 10);
  await h.advance(0);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 1);
  assert.strictEqual(JSON.parse(h.posted[0].uncensoredWhisperResolution).word, "fuck");
}

async function passedSlotsNotScored() {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{ word: "fuck", evidence: "candidate-score" }] } })]);
  h.video.currentTime = 5;
  h.start([Object.assign(h.token(0, 0, 2), { precedingWords: [{ word: "passed", time: 1 }] }),
    Object.assign(h.token(1, 1, 8), { precedingWords: [{ word: "upcoming", time: 7 }] })],
    "track-a", "video-a", false, 20);
  await h.advance(0);
  await h.advance(0);
  const requests = h.messages.filter((message) => message.type === "transcribe");
  assert.strictEqual(requests.length, 1, "slots behind the playhead are not scored");
  assert.deepStrictEqual(requests[0].data.options.slots[0].prefix, [{ word: "upcoming", time: 7 }]);
}

async function staleWorkIsAborted() {
  const h = makeHarness([(callback) => callback({ error: "temporary" })]);
  h.start([h.token(0)]);
  await h.advance(0);
  h.context.location.href = "https://www.youtube.com/watch?v=video-b";
  h.listeners["yt-navigate-finish"]();
  await h.advance(250);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 1);
  h.start([h.token(1)], "track-a", "video-b");
  assert.strictEqual(h.audio.pendingTokenValues().length, 1);
  h.start([h.token(2)], "track-b", "video-b");
  assert.strictEqual(h.audio.pendingTokenValues().length, 1);

  const disabled = makeHarness([(callback) => callback({ error: "temporary" })]);
  disabled.start([disabled.token(0)]);
  await disabled.advance(0);
  disabled.audio.setOptions({ rulesEnabled: false, whisperEnabled: false, audioEnabled: true, videoId: "video-a" });
  await disabled.advance(250);
  assert.strictEqual(disabled.messages.filter((message) => message.type === "transcribe").length, 1);
  assert.strictEqual(disabled.audio.pendingTokenValues().length, 0);
}

async function trackAndSeekCancelBackoff() {
  for (const change of ['track', 'seek', 'audio']) {
    const h = makeHarness([(callback) => callback({ error: "temporary" })]);
    h.start([h.token(0)]);
    await h.advance(0);
    h.audio.mediaAudio.segments = [];
    if (change === 'track') h.audio.rememberTimedTextData({ tokens: [], timeline: [] }, 'track-b', 'video-a');
    if (change === 'seek') h.listeners.seeking();
    if (change === 'audio') h.audio.setOptions({ rulesEnabled: false, audioEnabled: false });
    await h.advance(250);
    assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 1, change);
    assert.strictEqual(h.posted.length, 0, change);
  }
}

async function lateSuccessDoesNotApply() {
  let respond;
  const h = makeHarness([(callback) => { respond = callback; }]);
  h.start([h.token(0)]);
  await h.advance(0);
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: false });
  respond({ decision: { decisions: [{ word: "fuck", evidence: "transcript" }] } });
  await h.advance(0);
  assert.strictEqual(h.posted.length, 0);
}

async function cancellationDoesNotPoisonRequeuedSlot() {
  const h = makeHarness([(callback) => callback({ error: 'temporary' }),
    (callback) => callback({ decision: { decisions: [{ word: 'fuck' }] } })]);
  h.start([h.token(0)]);
  await h.advance(0);
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: false });
  h.start([h.token(0)]);
  await h.advance(250);
  assert.strictEqual(h.messages.filter((message) => message.type === 'transcribe').length, 2);
  assert.strictEqual(h.posted.length, 1);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
}

async function hostTimeout() {
  const h = makeHarness([(callback) => {}]);
  h.start([h.token(0)]);
  await h.advance(0);
  await h.advance(60000);
  await h.advance(250);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 2);
  await h.advance(60000);
  await h.advance(1000);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 2);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
}

async function hostFailuresAreRetryable() {
  for (const browser of [false, true]) {
    const failed = makeHarness([() => { throw new Error('delivery failed'); },
      (callback) => callback({ decision: { decisions: [{ word: 'fuck' }] } })], browser);
    failed.start([failed.token(0)]);
    await failed.advance(0);
    await failed.advance(250);
    assert.strictEqual(failed.messages.filter((message) => message.type === 'transcribe').length, 2);
    assert.strictEqual(failed.posted.length, 1);
  }
  const h = makeHarness([
    (callback, context) => { context.chrome.runtime.lastError = new Error("transport"); callback(); delete context.chrome.runtime.lastError; },
    (callback) => callback({ decision: { decisions: [{ word: "fuck", evidence: "transcript" }] } })
  ]);
  h.start([h.token(0)]);
  await h.advance(0);
  await h.advance(250);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 2);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);

  const absent = makeHarness([(callback) => callback(undefined),
    (callback) => callback({ decision: { decisions: [{ word: "fuck", evidence: "transcript" }] } })]);
  absent.start([absent.token(0)]);
  await absent.advance(0);
  await absent.advance(250);
  assert.strictEqual(absent.messages.filter((message) => message.type === "transcribe").length, 2);
  assert.strictEqual(absent.audio.pendingTokenValues().length, 0);
}

(async function main() {
  await hybridUsesFullWhisperPath();
  await windowSpeedPicksAutoMode([0.5, 0.5, 0.5], 690, "rules-first"); // not yet measured
  await windowSpeedPicksAutoMode([0.5, 0.5, 2, 2], 690, "whisper-first");
  await windowSpeedPicksAutoMode([0.5, 2, 2, 2], 690, "rules-first");
  await successAfterTransient();
  await exhaustedCap();
  await emptyDoesNotRetry();
  await nearbyTokensShareWindow();
  await rulesFirstSkipsRuleFills();
  await acousticHeadSwitch();
  await acousticHeadSwitch("acoustic-fusion");
  await passedSlotsNotScored();
  await endOfVideoSlotScored();
  await sameTrackRefreshDropsStaleResult();
  await staleWorkIsAborted();
  await trackAndSeekCancelBackoff();
  await lateSuccessDoesNotApply();
  await cancellationDoesNotPoisonRequeuedSlot();
  await hostTimeout();
  await hostFailuresAreRetryable();
  console.log("audio-whisper-retry.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
