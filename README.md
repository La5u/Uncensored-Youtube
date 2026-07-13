# Uncensored

Uncensored restores words hidden as `[__]` in YouTube captions. YouTube's
caption censorship is particularly harmful to deaf and hard-of-hearing viewers,
who otherwise receive less information than hearing viewers.

The extension intercepts YouTube JSON3 timed-text responses and can combine
deterministic text rules with a small, fully local Whisper model. No audio,
captions, or inference requests are sent to a remote service.

## How it works

### Caption interception

`src/page-hook.js` installs in the YouTube page world and intercepts caption
`fetch`/XHR responses. `src/timedtext.js` parses each JSON3 caption event,
normalizes variants such as `[ __ ]` to `[__]`, and assigns every censored slot
a stable token index. Resolved words are also applied to later timed-text
responses so a YouTube caption redraw does not restore `[__]`.

### Deterministic rules

`src/rules.js` uses surrounding caption text to produce one or more candidates.
Candidates are written in likelihood order:

```js
"give a [fuck|shit]"
"oh [shit|fuck]"
```

With rules enabled and Whisper disabled, the first candidate is used. With both
enabled, an unambiguous rule can resolve immediately and Whisper handles the
remaining cases. With rules disabled, only Whisper resolutions may replace a
slot.

### Local Whisper inference

`src/audio-capture.js` receives the YouTube SABR audio segments already fetched
for playback. It decodes and stitches enough PCM around each slot, then sends
one inference request at a time to the quantized local `whisper-tiny.en` model.
The shared before/after audio margin is controlled by
`AUDIO_CONTEXT_SECONDS`. It is currently 1.5 seconds.

Audio capture waits for caption metadata. If the video contains any `[__]`
slots, Whisper and audio decoding start together. Videos without censored slots
never start the audio pipeline. On a censored video, capture remains available
until YouTube navigates away, but decoded segments are released as soon as no
unresolved token window overlaps them. Closing or leaving the tab releases the
extension worker host.

Multiple slots in one caption event are inferred as a group. A group may include
the nearest resolved profanity immediately before it as an immutable audio
anchor. The known anchor locates the target words in Whisper's transcript but
is never rewritten. Incomplete groups apply nothing positionally and retry the
unresolved slots individually.

### Rolling live captions

YouTube continually rebuilds its two visible caption rows. The content script
therefore keeps resolved tokens independently of the current DOM:

1. The top and bottom rows are treated as one rolling caption window.
2. JSON event text supplies slot identity; Whisper supplies only swear words.
3. Visible slots are aligned from words and already mapped slots before them.
   Future subtitle words are not required, so replacement remains causal.
4. The previous top row is retained as one extra logical row. When the bottom
   row moves up, its first slot still has the same preceding anchor.
5. A caption-scoped mutation observer reapplies retained results after YouTube
   scrolls or redraws rows. Extension-authored mutations are ignored.

Navigation generations prevent late results from an old video being applied to
a new one. Inference and SABR decoding are serialized, timed-out workers are
discarded, and decoded audio is released after its covered tokens are processed.

## Settings behavior

| Context Rules | Audio Inference | Result |
| --- | --- | --- |
| On | Off | Use the first deterministic candidate. |
| On | On | Apply unambiguous rules; use audio for uncertain slots. |
| Off | On | Replace only from Whisper audio results. |
| Off | Off | Leave captions unchanged. |

Settings are loaded before the page hooks are activated, which prevents rules
from briefly replacing words during Whisper-only startup.

## Debugging Whisper

Console messages prefixed with `[uncensored]` describe the pipeline:

Enable them in the YouTube tab with
`localStorage.setItem("uncensoredDebug", "1")`, reload, and enable the Verbose
log level in Chromium DevTools.

- `whisper model starting` / `started`: local model initialization.
- `audio decoded`: a playback segment became available; its timestamp is shown
  as `minutes:seconds`.
- `whisper slice`: a single-slot PCM window is ready.
- `whisper group`, `group slice`, `group decision`: grouped-slot processing.
- `whisper decision`: selected word, score, and local transcript.
- `whisper resolved`: all tokens resolved by that request.
- `whisper queue state`: pending work and the next runnable token.

`next: null` while work remains normally means the next token does not
yet have a complete buffered audio window. It does not mean the worker is busy.

## Known limitations

- Inference is chronological and intentionally single-filed. On slow hardware,
  a live caption may scroll away before its result is ready; timed-text patching
  still preserves the result when YouTube redraws it.
- A slot with no visible preceding anchor cannot be placed safely until its
  logical preceding row is known.
- The final token near the end of a video can wait if YouTube never supplies
  enough trailing audio to complete the configured context window.
- Live DOM matching depends on YouTube's caption markup and may need adjustment
  if that markup changes.
- Seeking or starting midway can leave the first visible censored slot without
  the preceding caption row needed to identify it safely. The extension leaves
  that slot unchanged instead of applying a result to an uncertain position.
- Seeking backward does not recreate audio that was discarded after earlier
  tokens were processed. Revisiting an unresolved slot may therefore require a
  fresh playback segment before Whisper can retry it.
- Chromium 148 or newer is required for structured-clone extension messaging.
  Chromium hosts local workers in one offscreen extension document; Firefox
  retains its persistent background page.

More implementation detail is in [LIVE_DOM_DEFERRED.md](LIVE_DOM_DEFERRED.md).

### Planned seek recovery

The remembered-row path is designed for continuous playback. Seeking or
starting midway can bypass the prior row, leaving the first visible slot without
DOM history. Future recovery should retain a compact JSON caption timeline with
event start/end times, normalized event templates, stable token indices, and
resolved words.

After a seek, `video.currentTime` should select the small set of active JSON
events. Exact visible ordinary text should then verify the event before its
known token-indexed words are applied. This keeps time as a candidate selector,
not permission for a nearby result to replace an arbitrary slot, and avoids
restoring the removed fixed-duration fallback.

The same timeline can reset only the affected token windows after a seek and
request fresh audio for them, without retaining decoded audio for the whole
video.

### TODO

- Add optional WebGPU inference with capability detection and automatic WASM
  fallback. The current local Whisper path is WASM-only.

## Development

Add or reorder deterministic patterns in `RULE_PATTERNS` in `src/rules.js`.
Whisper-only work should not change those rules unless rule behavior is the
explicit subject of the change.

Run the test suite:

```sh
for test in tests/*.test.js; do node "$test" || exit; done
```

Evaluate Whisper directly against paired censored/uncensored dumps:

```sh
node tools/download-whisper-audio.js
npm install --prefix /tmp/uncensored-transformers @huggingface/transformers
node tools/evaluate-whisper-only.js
```

Audio downloads go to `tests/fixtures/audio/` and reports to
`corpus/generated/`; both are ignored by git.

Useful caption and corpus tools:

```sh
node tools/example-report.js british.json
node tools/compare-captions.js mov_censored.json mov.json
node tools/subtitle-report.js example.json
node corpus/evaluate-swear-corpus.js --input reddit_comments.zip --output corpus/generated/reddit --field body
PYTHONPATH=/tmp/uncensored-pyarrow node corpus/evaluate-opensubtitles-parquet.js --input opensubtitlesen-es.parquet --output corpus/generated/opensubtitles
```

## Build

```sh
./build.sh 1.2.0
```

This creates separate Firefox and Chromium zip files in `dist/`. Firefox keeps
Whisper in its persistent background page; Chromium keeps it in an offscreen
extension page while YouTube requests are active. See [AMO_SOURCE.md](AMO_SOURCE.md)
for source and vendored-runtime notes.
