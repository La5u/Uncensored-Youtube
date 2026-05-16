## Uncensored
YouTube's censorship of captions is albeist as it discriminates against the deaf.\
This extension aims to restore verbatim subtitles.

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
