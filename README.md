## Uncensored
YouTube's censorship of captions is albeist as it discriminates against the deaf.\
This extension aims to restore verbatim subtitles.

### MVP
The current MVP is a lightweight, fully local browser extension that only applies deterministic caption fixes.
It intercepts YouTube's `/api/timedtext?fmt=json3` caption response in the page context and replaces `[__]` only when surrounding text matches a known rule.

No audio capture, ML inference, network calls, background worker, or page-wide DOM observer are used.
The extension also normalizes YouTube's non-breaking-space token form, such as `[ __ ]`, to `[__]` before matching.
Rules can list candidates in likelihood order; the first candidate is inserted inline and later candidates are shown as `(or ...)`.

To add rules, edit `DETERMINISTIC_RULES` in `src/rule-data.js`:
```
rule("give a [__]", "fuck", "shit")
rule("oh [__]", "shit", "fuck")
```

Repeated patterns are generated from lists. For example, `FUCKING_SUFFIXES` in `src/rule-data.js` expands entries like `[__] stupid`, `[__] awful`, and `[__] amazing` to `fucking ...`.

To test the rules:
```
node tests/rules.test.js
node tests/timedtext.test.js
node tests/example-json.test.js
```

To review a caption dump without turning every case into a test:
```
node tests/example-report.js british.json
node tests/compare-captions.js gordoncreative.json gordoncreative_uncensored.json
```

To create separate zip files for Chromium and Firefox:
```
./build.sh 0.1.0
```

Proposed algorithm (FULLY LOCAL):
1. YouTube page loads
2. Read subtitles/transcript
3. if [__] detected ->
4. Extract nearby context 
5. One candidate solution (no audio required):\
e.g. "[__] you" is always "fuck you" since screw you is not censored in YT
6. Extract nearby audio
7. Few candidate solution:\
e.g. "what the [__]" can only be fuck or shit since "hell" isn't censored
8. Run tiny local inference such as tiny whisper.
Top 1000 censored words account for >90% of cases.\
YouTube likely has only up to 10k words total.\
If there are known candidates from context, it will be more accurate.
9. Patch subtitle DOM
### Other Ideas:
Show percentage points for each swear word based on context, e.g. likely: fuck, (5% shit in small text)

### Proposed Architecture:
```
src/
  content/
    captions.ts
    patcher.ts
    youtube.ts

  audio/
    capture.ts
    slicing.ts

  ml/
    whisper.ts
    inference.ts
    candidates.ts

  workers/
    transcriber.worker.ts

  shared/
    types.ts
```
To create two seperate zip files for chromium and firefox extension, run:\
./build.sh (version)
