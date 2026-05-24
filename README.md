## Uncensored
YouTube's censorship of captions is ableist as it discriminates against deaf and hard-of-hearing viewers.\
This extension restores verbatim subtitles by intercepting YouTube's `/api/timedtext?fmt=json3` caption responses.

### How it works
The extension uses a two-stage, fully local approach:

1. **Deterministic rules** — When surrounding text makes the censored word unambiguous (e.g. "what the [__]" → "fuck"), it is replaced immediately with no audio needed.

2. **Local audio inference** — When a rule lists multiple candidates (e.g. "oh [shit|fuck]"), the extension captures the video's audio around the censored timestamp and runs a tiny local Whisper model (`whisper-tiny.en`, quantized ONNX) to decide which candidate matches the spoken audio.

No network calls, background workers, or page-wide DOM observers are used. The extension also normalizes YouTube's non-breaking-space token form, such as `[ __ ]`, to `[__]` before matching.

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
node tests/json-fixtures.test.js
```

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
./build.sh 0.1.0
```

This creates separate zip files for Chromium and Firefox.
