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

If the preceding meaningful word is all caps, the restored swear is displayed
in all caps as well. One-letter words such as `A` and `I` are ignored.

With rules enabled and Whisper disabled, the first candidate is used. With both
enabled, an unambiguous rule can resolve immediately and Whisper handles the
remaining cases. With rules disabled, only Whisper resolutions may replace a
slot. If Whisper emits an ambiguous masked f-word such as `f*`, the ordered
f-word candidates from these rules select its grammatical form; other rule
results remain disabled.

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
unresolved token window overlaps them. The model stays warm across same-tab
YouTube navigation, including an intermediate search page; closing the tab or
leaving YouTube releases the worker host. A capped `sessionStorage` cache reuses
words after a same-tab reload only when video, track, token time, and context
still match; another video or closing the tab discards it.

Multiple slots in one caption event are inferred as a group. Separate requests
do not reuse audio already consumed by the immediately preceding resolved slot.
Incomplete groups apply nothing positionally and retry the unresolved slots
individually.

Each slot uses its nearest preceding ordinary JSON3 word to locate its result in
the Whisper transcript. If that anchor is absent or ambiguous, ordinal placement
is used instead; no visible-caption history is required.

### Rolling live captions

YouTube continually rebuilds its two visible caption rows. The content script
therefore keeps resolved tokens independently of the current DOM:

1. The top and bottom rows are treated as one rolling caption window.
2. A compact JSON timeline supplies event times, text, and stable token indices;
   Whisper supplies only swear words.
3. The playhead selects nearby events, then ordinary visible words must identify
   one unique alignment before any slot is changed.
4. Resolutions are scoped by video and caption track, so repeated text and track
   changes cannot reuse another slot's result.
5. A caption-scoped mutation observer reapplies retained results after YouTube
   scrolls or redraws rows. Extension-authored mutations are ignored.

Navigation generations prevent late results from an old video being applied to
a new one. Inference and SABR decoding are serialized, timed-out workers are
discarded, and decoded audio is released after its covered tokens are processed.

Navigation handling follows the same invariants for a fresh load, recommendation
click, search-page detour, browser back/forward, or reload: media observed during
navigation waits for a committed video ID; known old-video media is rejected;
caption, audio, cache, and DOM resolutions all carry video and track identity;
and a newer navigation generation invalidates unfinished older work.

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
- `whisper decision`: selected word, evidence type, and local transcript.
- `whisper resolved`: all tokens resolved by that request.
- `whisper queue state`: pending work and the next runnable token.

`next: null` while work remains normally means the next token does not
yet have a complete buffered audio window. It does not mean the worker is busy.

## Known limitations

- Inference is intentionally single-filed and prioritizes buffered tokens nearest
  the playhead. On slow hardware, a live caption may still scroll away before its
  result is ready; timed-text patching preserves it when YouTube redraws it.
- A visible window with no ordinary words, or with multiple identical nearby
  alignments, is left unchanged rather than guessed.
- The final token near the end of a video can wait if YouTube never supplies
  enough trailing audio to complete the configured context window.
- A suspended background tab may produce no audio logs because YouTube itself
  is not fetching playback data; capture resumes when playback requests resume.
- Live DOM matching depends on YouTube's caption markup and may need adjustment
  if that markup changes.
- Seeking backward does not recreate audio that was discarded after earlier
  tokens were processed. Revisiting an unresolved slot may therefore require a
  fresh playback segment before Whisper can retry it.
- Chromium 148 or newer is required for structured-clone extension messaging.
  Chromium hosts local workers in one offscreen extension document; Firefox
  retains its persistent background page.

More implementation detail is in [LIVE_DOM_DEFERRED.md](LIVE_DOM_DEFERRED.md).

### Seek recovery

Seeking invalidates scheduled visible-caption work and reprioritizes Whisper
around the new playhead without moving the video. Whisper groups and resolves
one timed-text row at a time.

The same timeline can reset only the affected token windows after a seek and
request fresh audio for them, without retaining decoded audio for the whole
video.

### TODO

- Independently fetch audio beginning at the earliest visible subtitle row
  after a seek, without moving playback. This requires a separate stateful SABR
  request; merely retaining decoded audio cannot recover bytes YouTube did not
  send.
- Add optional WebGPU inference with capability detection and automatic WASM
  fallback. The current local Whisper path is WASM-only.
- Avoid cloning playback audio while caption metadata is still unknown.
- Authenticate page-to-extension messages and validate message shapes and buffer
  sizes before background processing.

## Development

Add or reorder deterministic patterns in `RULE_PATTERNS` in `src/rules.js`.
Whisper-only work should not change those rules unless rule behavior is the
explicit subject of the change.

### Repeatable testing

Run the complete local regression, package, lint, ZIP-integrity, and production
dependency checks:

```sh
npm test
```

Run the paired-caption accuracy benchmark and fail if the popup percentages or
sample size no longer match the generated reports:

```sh
npm test -- --benchmark
```

Run isolated, muted Chromium and Firefox smoke tests. The script starts with the
first URL, exercises the same-document watch → search → watch lifecycle while
loading the second video, verifies that the page hook survives, and closes both
browsers when finished:

```sh
npm test -- --browsers \
  'https://www.youtube.com/watch?v=kTeQSzHGWyw&t=9s' \
  'https://www.youtube.com/watch?v=an5iFYcjWUM'
```

Add `--verbose` to print extension logs. A `t=` value on the first URL makes
Chromium load the video from the beginning and then exercise an actual seek to
that timestamp. If the first URL contains a playlist, the runner uses YouTube's
playlist Next control. Pass each expected next video as another URL to test
consecutive transitions.
Use `--chromium-only` or `--firefox-only` to rerun one browser.
Use `--until=SECONDS` to require continuous decoding through that point.

Use `npm test -- --all` for every check. Browser smoke testing requires
Chromium, Firefox, `web-ext`, and a graphical session for off-screen Chromium.
Each run chooses isolated local debugging ports. Firefox runs headlessly;
Chromium is placed off-screen because headless Chromium does not reliably fetch
YouTube media. Installed uBlock Origin Lite is loaded automatically when found.
The temporary profiles are isolated from normal browser profiles.

When Codex runs these commands, approving the project-scoped `npm test` command
prefix once allows later runs without approving every browser subprocess. No
approval is needed when running the command directly in a terminal.

### Accuracy benchmark

The popup figures come from 1,448 scorable `[__]` slots in 54 videos that
publish separate English automatic and human-written caption tracks. Precision
is correct replacements divided by attempted replacements; coverage is correct
replacements divided by all scorable slots.

| Mode | Precision | Coverage |
| --- | ---: | ---: |
| Rules + Whisper | 91.1% | 85.8% |
| Rules only | 80.3% | 34.0% |
| Whisper only | 90.3% | 85.4% |

The combined mode sent 25.8% fewer slots to Whisper than Whisper-only mode.
These are benchmark results, not a guarantee for every channel or accent.

Download audio plus paired auto/manual captions, then evaluate Whisper directly:

```sh
node tools/download-whisper-fixtures.js
npm install
node tools/evaluate-whisper-only.js
node tools/evaluate-whisper-only.js --mode rules-only
node tools/evaluate-whisper-only.js --mode rules+whisper \
  --transcripts corpus/generated/whisper-only-report.json \
  --output corpus/generated/rules-whisper-report.json
```

Pass video IDs to the downloader to fetch a subset, or `--names ID,ID` to the
evaluator to run one. Fixtures go to `test-fixtures/` and reports to
`corpus/generated/`; both are ignored by git. The evaluator fails before loading
Whisper if any requested audio or caption file is missing. Human-caption errors
can be corrected with a small `expectedByToken` entry in the fixture manifest.
`--transcripts` reuses a prior Whisper report when comparing combined mode.
Before adding a video, verify `yt-dlp --list-subs URL` shows both an automatic
English track and a separate English track under `subtitles`. Auto-only videos
are valid browser smoke cases but must not be included in accuracy percentages.

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
./build.sh 1.3.0
```

This creates separate Firefox and Chromium zip files in `dist/`. Firefox keeps
Whisper in its persistent background page; Chromium keeps it in an offscreen
extension page while YouTube requests are active. See [AMO_SOURCE.md](AMO_SOURCE.md)
for source and vendored-runtime notes.
