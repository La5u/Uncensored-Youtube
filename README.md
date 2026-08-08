# Uncensored

Uncensored restores words hidden as `[__]` in YouTube captions, primarily for
deaf and hard-of-hearing viewers. Audio, captions, and inference stay local.

## Modes

| Context rules | Audio inference | Behavior |
| --- | --- | --- |
| On | On | Rules fill immediately; anchored Whisper can correct them. |
| On | Off | Use deterministic rules; uncertain matches abstain. |
| Off | On | Use only local Whisper results. |
| Off | Off | Leave captions unchanged. |

In the fixed audio benchmark (23 videos, 525 scored slots), the default hybrid
mode scored 92.6% precision and 91.2% coverage; Whisper-only scored 93.4%/89.1%.
On the latest local paired-caption development snapshot, rules-only scored
91.7% precision and 47.8% coverage across 18,251 aligned slots from 977
contributing caption pairs (8,720 of 9,509 slots filled correctly). The separate
any-candidate diagnostic remains a candidate-oracle measurement, not a runtime
score.

On a broader unlabeled 82-video audio stress set, first-pass Whisper emitted
3,047 of 4,788 fills (63.6%), rules-only emitted 2,071 (43.3%), and either
first pass emitted 3,689 (77.0%). These are fill rates, not accuracy measurements.

### Evaluation caveats

This is an English, playlist-selected development corpus. Videos qualify only
when separate automatic and manual English captions exist, the automatic track
contains `[__]`, and the manual track supplies a supported swear. It therefore
does not represent YouTube generally or the natural prevalence of censored
captions.

Rules were tuned and measured on this same corpus, so rules-only results are
in-sample development figures rather than held-out estimates. Metrics are
micro-averaged per caption slot, which gives prolific creators more influence.
Manual caption omissions, paraphrases, and timing differences can still
introduce alignment error.

## Architecture

- `page-hook.js` observes YouTube JSON3 captions and SABR media responses.
- `timedtext.js` parses captions and gives every `[__]` slot a stable identity.
- `rules-compiler.js` validates and expands reusable rule declarations.
- `rules-data.js` contains the deterministic patterns and candidate priors;
  `rules.js` matches them and supplies replacements and Whisper candidates.
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

## Future plans

- Continue validating creator-diverse paired-caption rules on held-out videos.
- Expand conservative Whisper spelling repairs from paired audio evidence.

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

Run tests, both builds, ZIP validation, and Firefox lint:

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
node tools/evaluate-whisper-only.js --mode rules+whisper \
  --transcripts corpus/generated/whisper-only-report.json
```

The evaluator uses only `tools/whisper-audio-fixtures.json` by default. Pass
`--discoverPaired true` to include every caption pair in `test-fixtures/`.
Fixtures are stored in ignored `test-fixtures/`; reports go to `corpus/generated/`.
Pairs whose manual track has no recognized ground-truth word are skipped. Results
below 50% alignment are retained for their valid slots but marked
`reviewRecommended`; inspect them with:

```sh
jq '.fixtures[] | select(.reviewRecommended) | {name, scoredCount, unscoredCount}' \
  corpus/generated/paired-rules-only-report.json
```

Keep strict accuracy separate from the candidate-oracle benchmark, which counts
a slot as correct when its answer appears anywhere in a matched rule's `|`
options:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --skipMissing true --output corpus/generated/paired-rules-only-report.json
node tools/evaluate-whisper-only.js --mode rules-only --rulesScoring any-candidate \
  --discoverPaired true --skipMissing true \
  --output corpus/generated/paired-rules-any-candidate-report.json
```

Reports carry caption, rules-data, and rules-engine fingerprints. Re-running
with `--reuse` skips unchanged fixtures and reuses unaffected slots in fixtures
touched by added, removed, or altered rules:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --skipMissing true --reuse corpus/generated/paired-rules-only-report.json \
  --output corpus/generated/paired-rules-only-report.json
```

Review rows include four caption events on either side of the target by default;
use `--contextEvents N` to change that without changing the scored slot. Rule
only reruns use a blank-centered trie to identify affected fixtures, then reuse
cached slot results whose rule template and context did not change.

### Unpaired rules vs whisper

Auto-only captions (no manual track) have no ground truth, so precision is
undefined there; only fill rate is measurable. Compare what rules resolve vs
what local Whisper resolves on the same auto-only slots to find candidate new
rules (slots rules miss but Whisper fills) and candidate rule mistakes (slots
where the two disagree):

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverUnpaired true \
  --unpairedMinBlanks 1 --allowUnscored true --skipMissing true \
  --output corpus/generated/unpaired-rules-only-report.json
node tools/evaluate-whisper-only.js --mode whisper-only --discoverUnpaired true \
  --unpairedMinBlanks 1 --allowUnscored true --skipMissing true --limit 25 \
  --checkpointEvery 10 \
  --output corpus/generated/unpaired-whisper-only-report.json
node tools/compare-unpaired-modes.js \
  corpus/generated/unpaired-rules-only-report.json \
  corpus/generated/unpaired-whisper-only-report.json
```

The Whisper run is heavy and checkpoint-resumable. A run with `--limit 25` is
only a sample; complete it with `--limit 0 --transcripts
corpus/generated/unpaired-whisper-only-report.json`. The comparison reports
partial fixtures, rules-only fills where Whisper skipped, Whisper-only fills,
true disagreements, and full review context. Do not interpret disagreement
shares until both reports cover the same slots.

### Rule mining

Generate complete normalized text samples, then mine every source together:

```sh
node corpus/evaluate-corpus.js --input corpus/reddit_comments.zip \
  --output corpus/generated/mining/reddit --field body \
  --limit 1000000 --sampleLimit 0
node corpus/evaluate-corpus.js \
  --input corpus/opensubtitlesen-es.parquet \
  --output corpus/generated/mining/opensubtitles \
  --limit 1000000 --sampleLimit 0
node tools/mine-rule-opportunities.js \
  corpus/generated/paired-rules-only-report.json \
  corpus/generated/mining/opportunities.json \
  --sample reddit=corpus/generated/mining/reddit/reddit-samples.jsonl \
  --sample opensubtitles=corpus/generated/mining/opensubtitles/opensubtitles-samples.jsonl \
  --whisper corpus/generated/mining/unpaired-whisper.json
```

Whisper can supply discovery-only labels for captions without a human pair:

```sh
node tools/evaluate-whisper-only.js --mode whisper-only \
  --discoverUnpaired true --unpairedMinBlanks 0 --allowUnscored true \
  --skipMissing true --limit 3 \
  --transcripts corpus/generated/youtube-whisper-only-all-videos-sample-report.json \
  --output corpus/generated/mining/unpaired-whisper.json
```

The miner considers only `ALLOWED_WORDS`, deduplicates exact rows, scans wildcard
positions throughout each local window, and reports precision and marginal gain
by source. Recommendations require greater than 90% overall and marginal
precision, greater than 90% in every supported source, and no single-video
dominance. It also writes examples,
four-event review context, `topMissedWords`, and `topWrongPlacements`. Use
`--frameWords N` to widen the local window. Add candidates in batches, rerun
every ground-truth evaluator, and keep only rules with at least three realized
matches and greater than 90% realized precision. To reveal narrower rules hidden
by rejected broad rules, repeat mining with one or more
`--exclude previous-opportunities.json` arguments until recommendations reach
zero. Whisper labels are discovery-only and never count toward reported
precision.

For another text dataset, its only adapter contract is JSONL with
`{"original":"uncensored sentence","censored":"same sentence with [__]"}`;
pass it as another `--sample source=path`. Keep the top 300 misses and top 50
wrong placements from each evaluation report as the next review queue.

Resume the paired-caption download with audio disabled:

```sh
nohup node tools/download-paired-captions.js --pair-target 12 --audio-target 0 --jobs 3 >> logs/paired-caption-download.log 2>&1 &
echo $! > logs/paired-caption-download.pid
```

## Build

```sh
./build.sh 1.4.1
```

This creates separate Chromium and Firefox ZIPs in `dist/`. See
[AMO_SOURCE.md](AMO_SOURCE.md) for submission and vendored-runtime notes.
