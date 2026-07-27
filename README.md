# Uncensored

Uncensored restores words hidden as `[__]` in YouTube captions, primarily for
deaf and hard-of-hearing viewers. Audio, captions, and inference stay local.

## Modes

| Context rules | Audio inference | Behavior |
| --- | --- | --- |
| On | On | Rules resolve clear cases; Whisper handles the rest. |
| On | Off | Use the first deterministic candidate. |
| Off | On | Use only local Whisper results. |
| Off | Off | Leave captions unchanged. |

In the fixed audio benchmark, the default hybrid mode scored 91.1% precision
and 85.8% coverage; Whisper-only scored 90.3%/85.4%. On the complete paired
caption corpus, rules-only scored 87.3% precision and 37.6% coverage across
39,002 scorable slots.

### Evaluation caveats

The larger rules-development corpus is heavily concentrated by creator:

| Source | Paired videos | Scorable slots |
| --- | ---: | ---: |
| Jacksepticeye | 872 (66.9%) | 29,259 (75.0%) |
| Stephanie Sterling / The Jimquisition | 277 (21.2%) | 6,576 (16.9%) |
| Other 12 channels | 155 (11.9%) | 3,167 (8.1%) |

This is an English, playlist-selected development corpus, weighted toward gaming
and video-game commentary. Videos qualify only when separate automatic and
manual English captions exist, the automatic track contains `[__]`, and the
manual track supplies a supported swear. It therefore does not represent
YouTube generally or the natural prevalence of censored captions.

Rules were tuned and measured on this same corpus, so rules-only results are
in-sample development figures rather than held-out estimates. Metrics are
micro-averaged per caption slot, which gives prolific creators more influence.
Of 46,046 detected slots, 39,002 (84.7%) could be aligned to an allowed
ground-truth word and scored. Manual caption omissions, paraphrases, and timing
differences can still introduce alignment error.

## Architecture

- `page-hook.js` observes YouTube JSON3 captions and SABR media responses.
- `timedtext.js` parses captions and gives every `[__]` slot a stable identity.
- `rules.js` supplies deterministic replacements and Whisper candidates.
- `sabr-parser.js` extracts audio already downloaded for playback.
- `audio-capture.js` decodes only token-adjacent audio, queues inference, and
  reapplies results when YouTube redraws its rolling caption rows.
- `background.js`, `offscreen.js`, and `whisper-module-worker.js` keep Whisper
  off the page thread. Chromium uses an offscreen document; Firefox uses its
  background page.

Caption, audio, cache, and DOM state are scoped by video, track, and navigation
generation. Decoding and the model stop when captions contain no censored slots.
Decoded segments are discarded when no pending token needs them.

The local quantized `whisper-tiny.en` model runs through vendored
Transformers.js and ONNX Runtime Web. No remote code is loaded.

## Limitations

- Local inference can finish after a caption scrolls away on slow hardware.
- Ambiguous visible rows are left unchanged rather than guessed.
- A final slot may lack enough trailing audio to complete its inference window.
- Seeking to discarded audio requires YouTube to fetch that media again.
- Live replacement depends on YouTube's caption markup.
- Chromium 148+ and Firefox 140+ are required.

Enable debug logs in the YouTube tab, reload, and show Verbose messages:

```js
localStorage.setItem("uncensoredDebug", "1")
```

## Development

Whisper-only work should not change deterministic patterns unless rule behavior
is explicitly in scope.

Run tests, both builds, ZIP validation, Firefox lint, and dependency audit:

```sh
npm test
```

Optional checks:

```sh
npm test -- --benchmark
npm test -- --browsers URL [URL...]
npm test -- --all
```

Browser arguments include `--chromium-only`, `--firefox-only`, `--headless`,
`--direct`, `--until=SECONDS`, `--pause=SECONDS`, and `--verbose`.

Accuracy fixtures require `yt-dlp` and separate automatic and human English
caption tracks:

```sh
node tools/download-whisper-fixtures.js
node tools/evaluate-whisper-only.js
node tools/evaluate-whisper-only.js --mode rules-only
node tools/evaluate-whisper-only.js --mode rules+whisper \
  --transcripts corpus/generated/whisper-only-report.json
```

Fixtures are stored in ignored `test-fixtures/`; reports go to
`corpus/generated/`.

## Build

```sh
./build.sh 1.3.2
```

This creates separate Chromium and Firefox ZIPs in `dist/`. See
[AMO_SOURCE.md](AMO_SOURCE.md) for submission and vendored-runtime notes.
