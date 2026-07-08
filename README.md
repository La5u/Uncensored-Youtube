## Uncensored
YouTube's censorship of captions is ableist as it discriminates against deaf and hard-of-hearing viewers.\
This extension restores verbatim subtitles by intercepting YouTube's `/api/timedtext?fmt=json3` caption responses.

### How it works
The extension uses a two-stage, fully local approach:

1. **Deterministic rules** — When surrounding text makes the censored word unambiguous (e.g. "what the [__]" → "fuck"), it is replaced immediately with no audio needed.

2. **Local audio inference** — When a rule lists multiple candidates (e.g. "oh [shit|fuck]"), the extension parses YouTube audio segments that are already being requested by the player and runs a tiny local Whisper model (`whisper-tiny.en`, quantized ONNX) to decide which candidate matches the spoken audio.

Inference is local and does not send audio to a remote service. The extension uses a background script as an audio-stream fallback and reads YouTube `googlevideo.com` audio responses already associated with playback. It also normalizes YouTube's non-breaking-space token form, such as `[ __ ]`, to `[__]` before matching.

### Adding rules
Edit `RULE_PATTERNS` in `src/rules.js`:
```
"give a [fuck|shit]"
"oh [shit|fuck]"
```

Rules list candidates in likelihood order. If context makes the first candidate unambiguous, it is applied directly. Otherwise the audio stage resolves between the candidates.

### Tests
```
node tests/rules.test.js
node tests/timedtext.test.js
node tests/whisper-local.test.js
node tests/sabr-parser.test.js
node tests/extension-wiring.test.js
```

### Whisper-only audio evaluation
Rules can be disabled and Whisper evaluated directly against paired censored/uncensored dumps:
```
node tools/download-whisper-audio.js
npm install --prefix /tmp/uncensored-transformers @huggingface/transformers
node tools/evaluate-whisper-only.js
```

Audio downloads go to `tests/fixtures/audio/`, and reports go to `corpus/generated/`; both are intentionally ignored by git. `yt-dlp` is used to inspect and download YouTube audio during playback testing.

### Tools
To review a caption dump or compare against an uncensored reference:
```
node tools/example-report.js british.json
node tools/compare-captions.js mov_censored.json mov.json
node tools/subtitle-report.js example.json
```

### Evaluating rule coverage
```
node corpus/evaluate-swear-corpus.js --input reddit_comments.zip --output corpus/generated/reddit --field body
PYTHONPATH=/tmp/uncensored-pyarrow node corpus/evaluate-opensubtitles-parquet.js --input opensubtitlesen-es.parquet --output corpus/generated/opensubtitles
```

### Build
```
./build.sh 1.1.0
```

This creates separate zip files for Chromium and Firefox.

### Performance roadmap

- [x] Capture playback audio only while Whisper is enabled.
- [x] Transfer binary audio buffers instead of Base64 JSON.
- [x] Parse SABR media outside YouTube's main thread.
- [x] Serialize audio decoding and Whisper inference.
- [x] Release decoded segments after their covered tokens are processed.
- [x] Keep only the latest complete WebM init segment for each itag.
- [ ] Replace permanent caption polling with event-driven updates.
- [ ] Terminate and recreate Whisper workers after a timeout.
- [ ] Add navigation generation IDs to reject stale asynchronous results.
- [ ] Prevent duplicate page-hook installation.
- [x] Stop periodically reinstalling network hooks.

Lookahead follows the audio range YouTube naturally preloads, including the
player's buffered white-bar range. Completed word resolutions are retained;
decoded PCM is not.
