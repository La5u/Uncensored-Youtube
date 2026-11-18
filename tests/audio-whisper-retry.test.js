const assert = require("assert");
const fs = require("fs");
const test = require("node:test");
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
  const segments = [];
  const player = {};
  let captionMutation;
  const context = {
    location: { href: "https://www.youtube.com/watch?v=video-a" },
    document: { querySelector(selector) { return selector === "video" ? video : player; }, querySelectorAll() { return segments; } },
    addEventListener(type, listener) { listeners[type] = listener; },
    requestAnimationFrame(callback) { callback(); },
    MutationObserver: class MutationObserver {
      constructor(callback) { this.callback = callback; }
      disconnect() { captionMutation = null; }
      observe() { captionMutation = this.callback; }
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
      if (message.type === "recordSpeed") { callback({ ok: true }); return; }
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
  function renderCaption(textContent) {
    segments.splice(0, segments.length, { textContent });
    if (captionMutation) captionMutation([{ target: { nodeType: 1, closest: () => true } }]);
    return segments[0].textContent;
  }
  return { context, messages, posted, listeners, advance, start, token, addAudio, video, segments,
    renderCaption, audio: context.UncensoredAudioInference };
}

function timedCue(text, startTime, endTime, firstTokenIndex = 0) {
  return { text, startTime, endTime, firstTokenIndex };
}

async function startContentTrack(h, mode, captions, acousticHead = true) {
  const { context, listeners } = h;
  let changeStorage;
  Object.assign(context.UncensoredRules, require("../src/rules"));
  context.UncensoredTimedText = require("../src/timedtext");
  context.window = context;
  context.CustomEvent = class CustomEvent {};
  context.dispatchEvent = () => {};
  context.document.createElement = () => ({ remove() {} });
  context.document.documentElement = { appendChild: (script) => script.onload() };
  context.browser = {
    runtime: { getURL: (path) => path, sendMessage: () => Promise.resolve() },
    storage: {
      local: { get: (defaults) => Promise.resolve({ ...defaults, mode, acousticHead }) },
      onChanged: { addListener: (listener) => { changeStorage = listener; } }
    }
  };
  vm.runInContext(fs.readFileSync(require.resolve("../src/content"), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  if (captions) sendContentTrack(h, captions);
  return (newValue) => changeStorage({ mode: { newValue } }, "local");
}

function sendContentTrack(h, captions, captionRevision) {
  const body = JSON.stringify({ events: captions.map((utf8, index) => ({
    tStartMs: index * 2000, dDurationMs: 2000, segs: [{ utf8 }]
  })) });
  h.listeners["uncensored-timedtext"]({
    detail: JSON.stringify({ body, trackId: "track-a", videoId: "video-a", captionRevision })
  });
}

test("Rules first with Sound check off keeps audio arriving before the first track", async () => {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [
    { word: "shitting", evidence: "candidate-score" }
  ] } })]);
  h.context.AudioContext = class AudioContext {
    decodeAudioData() {
      return Promise.resolve({ sampleRate: 16000, length: 48000, numberOfChannels: 1, duration: 3,
        getChannelData() { return new Float32Array(48000); } });
    }
  };
  await startContentTrack(h, "rules-first", null, false);
  await h.audio.setSabrAudioData({ buffer: new ArrayBuffer(1), startMs: 0, durationMs: 3000 });
  h.listeners["uncensored-timedtext"]({
    detail: JSON.stringify({ body: "", trackId: "track-a", videoId: "video-a" })
  });
  const raw = "are you [__]";
  sendContentTrack(h, [raw]);
  await h.advance(0);
  assert.strictEqual(h.renderCaption(raw), "are you shitting");
  assert.strictEqual(h.messages.find((message) => message.type === "transcribe").data.options.acousticHead, false);
});

for (const [name, original, revised] of [
  ["following word", { nextWord: "now" }, { nextWord: "later" }],
  ["timed prefix", { precedingWords: [{ word: "say", time: 0.99 }] },
    { precedingWords: [{ word: "say", time: 1.01 }] }],
  ["slot time", { timeSeconds: 4 }, { timeSeconds: 4.02 }]
]) {
  test(`Whisper only rescores a completed abstention after a change to the ${name}`, async () => {
    const h = makeHarness([
      (callback) => callback({ decision: { decisions: [{ word: "", evidence: "none" }] } }),
      (callback) => callback({ decision: { decisions: [{ word: "fuck", evidence: "candidate-score" }] } })
    ]);
    const mode = { rulesEnabled: false, acousticHead: false };
    const raw = h.token(0).context;
    const timeline = [timedCue(raw, 0, 8)];
    h.audio.setOptions(mode);
    h.addAudio(8);
    h.audio.rememberTimedTextData({ tokens: [{ ...h.token(0, 0, 4), ...original }], timeline }, "track-a");
    await h.advance(0);
    assert.strictEqual(h.renderCaption(raw), raw);
    h.audio.setOptions({ ...mode, whisperEnabled: false });
    h.audio.rememberTimedTextData({ tokens: [{ ...h.token(0, 0, 4), ...revised }], timeline }, "track-a");
    h.audio.setOptions(mode);
    h.addAudio(8);
    await h.advance(0);
    assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 2);
    assert.strictEqual(h.renderCaption(raw), "say fuck now");
  });
}

test("A same-track refresh with no blanks retires a slot's in-flight result", async () => {
  let reply;
  const h = makeHarness([(callback) => { reply = callback; }]);
  h.start([h.token(0)]);
  await h.advance(0);
  assert.ok(reply);
  h.audio.rememberTimedTextData({ tokens: [], timeline: [timedCue("say this now", 0, 3)] }, "track-a");
  reply({ decision: { decisions: [{ word: "fuck", evidence: "candidate-score" }] } });
  await h.advance(0);
  assert.strictEqual(h.posted.length, 0);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
});

test("An unchanged in-flight score uses the refreshed rule fallback", async () => {
  let reply;
  const h = makeHarness([(callback) => { reply = callback; }]);
  const token = { ...h.token(0), deterministicWord: "shit", deterministicAmbiguous: true };
  const timeline = [timedCue(token.context, 0, 3)];
  h.audio.setOptions({ whisperFirst: true });
  h.addAudio();
  h.audio.rememberTimedTextData({ tokens: [token], timeline }, "track-a");
  await h.advance(0);
  assert.ok(reply);
  h.audio.rememberTimedTextData({ tokens: [{ ...token, deterministicWord: "fuck" }], timeline }, "track-a");
  reply({ decision: { decisions: [{ word: "shit", evidence: "rule" }] } });
  await h.advance(0);
  assert.strictEqual(h.renderCaption(token.context), "say fuck now");
});

test("A new raw body republishes an unchanged decision under the new caption revision", async () => {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [
    { word: "shitting", evidence: "candidate-score" }
  ] } })]);
  const raw = "are you [__]";
  await startContentTrack(h, "whisper", null, false);
  h.addAudio();
  sendContentTrack(h, [raw, "me", "old"], 1);
  await h.advance(0);
  sendContentTrack(h, [raw, "me", "revised"], 2);
  await h.advance(0);
  assert.deepStrictEqual(h.posted.map(({ uncensoredWhisperResolution }) => {
    const { word, captionRevision } = JSON.parse(uncensoredWhisperResolution);
    return [word, captionRevision];
  }), [["shitting", 1], ["shitting", 2]]);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 1);
});

test("Mode cycling queues Whisper with the freshly analyzed split-cue rule", async () => {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{ word: "", evidence: "none" }] } })]);
  const raw = "are you [__]";
  const changeMode = await startContentTrack(h, "rules-first", [raw, "me"]);
  changeMode("whisper");
  changeMode("rules-first");
  h.addAudio();
  await h.advance(0);
  assert.strictEqual(h.renderCaption(raw), "are you shitting");
  const request = h.messages.find((message) => message.type === "transcribe");
  assert.strictEqual(request.data.options.slots[0].hybridRuleWord, "shitting");
});

test("Switching to Rules only fills a visible split cue from the full track", async () => {
  const h = makeHarness([]);
  const raw = "might be [__]";
  const changeMode = await startContentTrack(h, "whisper", [raw, "with"]);
  assert.strictEqual(h.renderCaption(raw), raw);
  changeMode("rules");
  assert.strictEqual(h.segments[0].textContent, "might be fucking");
});

test("Rules first uses an unambiguous rule after cycling through Rules only", async () => {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [
    { word: "shit", evidence: "candidate-score", head: { word: "shit", p: 0.98 } }
  ] } })]);
  const raw = "what the [__]";
  const changeMode = await startContentTrack(h, "whisper-first", [raw]);
  h.addAudio();
  h.listeners.seeked();
  await h.advance(0);
  assert.strictEqual(h.renderCaption(raw), "what the shit");
  changeMode("rules");
  assert.strictEqual(h.renderCaption(raw), "what the fuck");
  changeMode("rules-first");
  assert.strictEqual(h.renderCaption(raw), "what the fuck");
  changeMode("whisper-first");
  assert.strictEqual(h.renderCaption(raw), "what the shit");
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 1);
});

test("1. Rules only preserves a scored multi-candidate fill", () => {
  const timedText = require("../src/timedtext");
  const raw = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: "are you [__] me" }] }
  ] });
  const patched = JSON.parse(timedText.patchTimedTextBodyWithOverrides(raw, [], true, true));
  const data = timedText.collectTimedTextData(raw, true);
  assert.strictEqual(data.tokens[0].deterministicAmbiguous, true);
  const segment = { textContent: patched.events[0].segs[0].utf8 };
  assert.strictEqual(segment.textContent, "are you shitting me");
  const h = makeHarness([]);
  h.segments.push(segment);
  h.audio.setOptions({ rulesEnabled: true, whisperEnabled: false });
  h.audio.rememberTimedTextData(data, "track-a", "video-a");
  assert.strictEqual(segment.textContent, "are you shitting me");
});

test("2. Repeated cues leave an ambiguous visible blank alone", async () => {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [
    { word: "shit", evidence: "candidate-score" }
  ] } })]);
  const raw = "what the [__]";
  const segment = { textContent: raw };
  h.segments.push(segment);
  h.audio.setOptions({ whisperFirst: true });
  h.addAudio();
  h.audio.rememberTimedTextData({
    tokens: [h.token(0), h.token(1, 1, 8)].map((token) =>
      ({ ...token, context: raw, deterministicWord: "fuck" })),
    timeline: [timedCue(raw, 1, 2, 0), timedCue(raw, 8, 9, 1)]
  }, "track-a", "video-a");
  await h.advance(0);
  assert.strictEqual(JSON.parse(h.posted.at(-1).uncensoredWhisperResolution).word, "shit");
  assert.strictEqual(segment.textContent, raw);
});

test("3. Whisper posts a decision for a slot with a suffix", async () => {
  for (const suffix of ["'s", "’S", "ing"]) {
    const h = makeHarness([(callback) => callback({ decision: { decisions: [
      { word: "shit", evidence: "candidate-score" }
    ] } })]);
    const raw = `For [__]${suffix} sake`;
    const segment = { textContent: `For fuck${suffix} sake` };
    h.segments.push(segment);
    h.audio.setOptions({ whisperFirst: true });
    h.addAudio();
    h.audio.rememberTimedTextData({
      tokens: [{ ...h.token(0), context: raw, deterministicWord: "fuck" }],
      timeline: [timedCue(raw, 0, 3)]
    }, "track-a", "video-a");
    await h.advance(0);
    assert.strictEqual(JSON.parse(h.posted.at(-1).uncensoredWhisperResolution).word, "shit");
    assert.strictEqual(segment.textContent, `For fuck${suffix} sake`);
  }
});

test("4. Whisper first keeps a cached word heard in Whisper only", async () => {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [
    { word: "shit", evidence: "candidate-score", head: { word: "shit", p: 0.98 } }
  ] } })]);
  const raw = "what the [__]";
  const segment = { textContent: raw };
  h.segments.push(segment);
  h.audio.setOptions({ rulesEnabled: false });
  h.addAudio();
  const cue = { tokens: [{ ...h.token(0), context: raw }], timeline: [timedCue(raw, 0, 3)] };
  h.audio.rememberTimedTextData(cue, "track-a", "video-a");
  await h.advance(0);
  assert.strictEqual(segment.textContent, "what the shit");
  h.audio.setOptions({ whisperFirst: true });
  cue.tokens[0].deterministicWord = "fuck";
  h.audio.rememberTimedTextData(cue, "track-a", "video-a");
  assert.strictEqual(segment.textContent, "what the shit");

  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: false });
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: true });
  h.audio.rememberTimedTextData({ tokens: [{ ...h.token(0), context: raw }], timeline: cue.timeline },
    "track-a", "video-a");
  assert.strictEqual(h.renderCaption(raw), "what the shit");
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 1);
});

test("5. Off leaves an already filled on-screen cue as displayed", () => {
  const h = makeHarness([]);
  const segment = { textContent: "say fuck now" };
  h.segments.push(segment);
  h.audio.setOptions({ rulesEnabled: true, whisperEnabled: false });
  h.audio.rememberTimedTextData({
    tokens: [{ ...h.token(0), deterministicWord: "fuck" }],
    timeline: [timedCue("say [__] now", 0, 3)]
  }, "track-a", "video-a");
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: false });
  assert.strictEqual(segment.textContent, "say fuck now");
  assert.strictEqual(h.renderCaption("say [__] now"), "say [__] now");
});

test("6. Enabling Sound check requeues a decoder-only abstention", async () => {
  const h = makeHarness([
    (callback) => callback({ decision: { decisions: [{ word: "", evidence: "none" }] } }),
    (callback) => callback({ decision: { decisions: [
      { word: "shit", evidence: "acoustic-head", decoderWord: "", head: { word: "shit", p: 0.98 } }
    ] } })
  ]);
  h.start([h.token(0)], "track-a", "video-a", false, 3, { acousticHead: false });
  await h.advance(0);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
  h.audio.setOptions({ rulesEnabled: false, acousticHead: true });
  h.listeners.seeking();
  h.addAudio();
  await h.advance(0);
  assert.deepStrictEqual(h.messages.filter((message) => message.type === "transcribe")
    .map((message) => message.data.options.acousticHead), [false, true]);
  assert.strictEqual(JSON.parse(h.posted.at(-1).uncensoredWhisperResolution).word, "shit");
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
});

test("#5. A Sound check retry that abstains clears the earlier decoder fill", async () => {
  const h = makeHarness([
    (callback) => callback({ decision: { decisions: [
      { word: "shit", evidence: "candidate-score" },
      { word: "fuck", evidence: "candidate-score" }
    ] } }),
    (callback) => callback({ decision: { decisions: [
      { word: "", evidence: "none", head: { word: "fuck", p: 0.4 } }
    ] } })
  ]);
  const tokens = [h.token(0), h.token(1, 1, 1.2)];
  tokens[0].context = "oh [__] well";
  const timeline = tokens.map((token) => timedCue(token.context, 0, 3, token.tokenIndex));
  h.audio.setOptions({ rulesEnabled: false, acousticHead: false });
  h.addAudio();
  h.audio.rememberTimedTextData({ tokens, timeline }, "track-a", "video-a");
  await h.advance(0);
  assert.strictEqual(h.renderCaption(tokens[1].context), "say fuck now");

  h.video.currentTime = 2.1;
  h.audio.setOptions({ rulesEnabled: false, acousticHead: true });
  h.listeners.seeking();
  h.addAudio();
  await h.advance(0);
  const requests = h.messages.filter((message) => message.type === "transcribe");
  assert.deepStrictEqual(Array.from(requests[0].data.options.slots, (slot) => slot.tokenIndex), [0, 1]);
  assert.deepStrictEqual(Array.from(requests[1].data.options.slots, (slot) => slot.tokenIndex), [1]);
  assert.strictEqual(h.renderCaption(tokens[1].context), tokens[1].context);
  const latest = JSON.parse(h.posted.at(-1).uncensoredWhisperResolution);
  assert.strictEqual(latest.tokenIndex, 1);
  assert.strictEqual(latest.word, "");
});

test("#8. A skipped head attempt retries once after reactivation", async () => {
  const skipped = (callback) => callback({ decision: { decisions: [{ word: "", evidence: "none" }] } });
  const h = makeHarness([skipped, skipped]);
  h.start([h.token(0)]);
  await h.advance(0);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);

  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: false });
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: true });
  h.listeners.seeking();
  h.addAudio();
  await h.advance(0);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 2);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);

  h.audio.rememberTimedTextData({ tokens: [h.token(0)], timeline: [] }, "track-a", "video-a");
  h.addAudio();
  await h.advance(0);
  assert.strictEqual(h.messages.filter((message) => message.type === "transcribe").length, 2);
});

test("#8. Scoring on a restarted worker requeues earlier skipped slots", async () => {
  const h = makeHarness([
    (callback) => callback({ decision: { workerId: "first", decisions: [{ word: "", evidence: "none" }] } }),
    (callback) => callback({ decision: { workerId: "second", decisions: [
      { word: "fuck", evidence: "candidate-score", head: { word: "fuck", p: 0.98 } }
    ] } }),
    (callback) => callback({ decision: { workerId: "second", decisions: [
      { word: "shit", evidence: "acoustic-head", head: { word: "shit", p: 0.98 } }
    ] } })
  ]);
  const first = h.token(0);
  h.start([first]);
  await h.advance(0);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);

  const second = h.token(1, 1, 8);
  h.addAudio(10);
  h.audio.rememberTimedTextData({ tokens: [first, second], timeline: [] }, "track-a", "video-a");
  await h.advance(0);
  assert.deepStrictEqual(h.messages.filter((message) => message.type === "transcribe")
    .map((message) => Array.from(message.data.options.slots, (slot) => slot.tokenIndex)), [[0], [1], [0]]);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
});

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

async function replacesOnlyTheVisibleBlank() {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{
    word: "shit", evidence: "candidate-score", hybridCrossFamily: true
  }] } })]);
  const segment = { textContent: "fuck, say fuck now" };
  h.segments.push(segment);
  h.audio.setOptions({ whisperFirst: true });
  h.addAudio();
  h.audio.rememberTimedTextData({
    tokens: [Object.assign(h.token(0), { deterministicWord: "fuck" })],
    timeline: [{ text: "fuck, say [__] now", startTime: 0, endTime: 3, firstTokenIndex: 0 }]
  }, "track-a", "video-a");
  assert.strictEqual(segment.textContent, "fuck, say fuck now");
  await h.advance(0);
  assert.strictEqual(segment.textContent, "fuck, say fuck now");
  assert.strictEqual(h.renderCaption("fuck, say [__] now"), "fuck, say shit now");
}

async function ruleFallbackStaysRuleEvidence() {
  for (const source of ["context", "deterministic"]) {
    const h = makeHarness([(callback) => callback({ decision: { decisions: [{
      word: "fuck", source, evidence: "rule"
    }] } })]);
    const token = h.token(0);
    if (source === "deterministic") Object.assign(token, { deterministicWord: "fuck", deterministicAmbiguous: true });
    else h.context.UncensoredRules.applyDeterministicRules = () => ({ replacements: [{ word: "fuck" }] });
    const segment = { textContent: token.context };
    h.segments.push(segment);
    h.audio.setOptions({ whisperFirst: true });
    h.addAudio();
    h.audio.rememberTimedTextData({ tokens: [token],
      timeline: [{ text: token.context, startTime: 0, endTime: 3, firstTokenIndex: 0 }]
    }, "track-a", "video-a");
    await h.advance(0);
    assert.strictEqual(segment.textContent, "say fuck now");
    assert.strictEqual(JSON.parse(h.posted.at(-1).uncensoredWhisperResolution).source, source);
    h.audio.setOptions({ rulesEnabled: false, whisperEnabled: true });
    assert.strictEqual(h.renderCaption(token.context), token.context);
    assert.strictEqual(h.audio.pendingTokenValues().length, 0, "the decoder already abstained");
  }
}

async function reportsWindowTimingToBackground() {
  const h = makeHarness([(callback) => callback({ decision: { inferenceMs: 690, decisions: [{ word: "fuck" }] } })]);
  h.start([h.token(0)]);
  await h.advance(0);
  const timing = h.messages.find((message) => message.type === "recordSpeed");
  assert.ok(timing, "the shared host receives the measurement");
  assert.strictEqual(timing.data.seconds, 0.69);
  assert.strictEqual(timing.data.slots, 1);
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

// Changing Sound check uses the decoder decision already computed in the same window.
async function acousticHeadSwitch(evidence = "acoustic-head") {
  const decoderWord = evidence === "acoustic-fusion" ? "fuck" : "";
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{ word: "shit", evidence,
    decoderWord, head: { word: "shit", p: 0.987 } }] } })]);
  const debug = [];
  h.context.localStorage = { getItem: (key) => key === "uncensoredDebug" ? "1" : null };
  h.context.console = { debug: (line) => debug.push(line), warn() {} };
  const segment = { textContent: "say [__] now" };
  h.segments.push(segment);
  h.start([h.token(0)]);
  h.audio.rememberTimedTextData({ tokens: [h.token(0)],
    timeline: [{ text: "say [__] now", startTime: 0, endTime: 3, firstTokenIndex: 0 }] }, "track-a", "video-a");
  await h.advance(0);
  // Debug log: head status at model start, and the head's top word when it was consulted.
  assert.ok(debug.includes('[uncensored] whisper model started {"acousticHead":"loaded"}'), debug.join("\n"));
  // A fused decision also names the decoder's word.
  assert.ok(debug.includes(`[uncensored] whisper decision {"token":0,"word":"shit","evidence":"${evidence}","head":"shit 0.99"` +
    `,"decoder":"${decoderWord}"}`), debug.join("\n"));
  assert.strictEqual(JSON.parse(h.posted[0].uncensoredWhisperResolution).evidence, evidence);
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: true, audioEnabled: true, videoId: "video-a",
    acousticHead: false });
  assert.strictEqual(h.audio.mediaAudio.segments.length, 0);
  await h.advance(0);
  const requests = h.messages.filter((message) => message.type === "transcribe");
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(h.audio.pendingTokenValues().length, 0);
  assert.strictEqual(h.renderCaption("say [__] now"), `say ${decoderWord || "[__]"} now`);
  if (decoderWord) assert.strictEqual(JSON.parse(h.posted.at(-1).uncensoredWhisperResolution).word, decoderWord);
  h.audio.setOptions({ rulesEnabled: false, whisperEnabled: true, acousticHead: true });
  assert.strictEqual(h.renderCaption("say [__] now"), "say shit now");
}

async function disabledHeadStillAllowsRuleFallback() {
  const h = makeHarness([(callback) => callback({ decision: { decisions: [{
    word: "shit", decoderWord: "", evidence: "acoustic-head", hybridCrossFamily: true
  }] } })]);
  const token = Object.assign(h.token(0), { deterministicWord: "fuck", deterministicAmbiguous: true });
  const segment = { textContent: token.context };
  h.segments.push(segment);
  h.audio.setOptions({ whisperFirst: true });
  h.addAudio();
  h.audio.rememberTimedTextData({ tokens: [token],
    timeline: [{ text: token.context, startTime: 0, endTime: 3, firstTokenIndex: 0 }]
  }, "track-a", "video-a");
  await h.advance(0);
  assert.strictEqual(segment.textContent, "say shit now");
  h.audio.setOptions({ whisperFirst: true, acousticHead: false });
  assert.strictEqual(h.renderCaption(token.context), "say fuck now");
  assert.strictEqual(JSON.parse(h.posted.at(-1).uncensoredWhisperResolution).source, "deterministic");
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
  await replacesOnlyTheVisibleBlank();
  await ruleFallbackStaysRuleEvidence();
  await reportsWindowTimingToBackground();
  await successAfterTransient();
  await exhaustedCap();
  await emptyDoesNotRetry();
  await nearbyTokensShareWindow();
  await rulesFirstSkipsRuleFills();
  await acousticHeadSwitch();
  await acousticHeadSwitch("acoustic-fusion");
  await disabledHeadStillAllowsRuleFallback();
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
