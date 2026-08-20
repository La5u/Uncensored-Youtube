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

On the current local development corpus, strict rules-only evaluation scores
89.60% precision and 44.81% coverage on 26,429 aligned manual-auto slots. The
separate synthetic tier scores 89.94%/40.16% on 149,135 slots; the two auto-auto
fixtures score 100%/80% on 10 aligned slots. The validation split has only nine synthetic
slots (100% precision, 11.1% coverage), and no paired test fixtures were found,
so there is not yet a defensible held-out test estimate. The any-candidate
diagnostic remains a candidate-oracle measurement, not a runtime score.

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
- `rule-data/` separates language sets, exact rules, and grammar;
  `rules-data.js` assembles them with compact candidate priors, and `rules.js`
  supplies replacements and Whisper candidates.
- `sabr-parser.js` extracts audio already downloaded for playback.
- `audio-capture.js` decodes only token-adjacent audio, queues inference, and
  reapplies results when YouTube redraws its rolling caption rows.
- `background.js`, `offscreen.js`, and `whisper-module-worker.js` keep Whisper
  off the page thread. Chromium uses an offscreen document; Firefox uses its
  background page.

Caption, audio, and DOM state are scoped by video, track, and navigation
generation. Decoding and the model stop when captions contain no censored slots.
Decoded segments are discarded when no pending token needs them.

The local quantized `whisper-tiny.en` model runs through vendored
Transformers.js and ONNX Runtime Web. No remote code is loaded.

### Word vocabularies

`ALLOWED_WORDS` is the broad set of supported censored words accepted from local
Whisper. `RULE_WORDS` is its conservative subset that deterministic context
rules may emit. A word can therefore be recognized from audio without becoming
a context-only guess. `WORD_ROLES` is a broader authoring catalog and does not
by itself permit runtime output.

Add newly supported censored words to `ALLOWED_WORDS` only after the
manual-auto audit confirms repeated whole-word evidence absent from visible
automatic captions. A split form such as `chicken [__]` does not validate
`chickenshit`. `NOT_CENSORED_WORDS` records swear labels that YouTube leaves visible in
those tracks and is disjoint from `ALLOWED_WORDS`; the vocabulary-discovery
audit skips them so a nearby visible swear cannot become a false new label. Promote one to `RULE_WORDS` only when an
exact rule or grammatical frame can identify it at the required precision. List
order is stable because Whisper uses it to break ties.

## Future plans
- Continue replacing broad wildcard rules with validated concrete alternatives.
- Continue validating creator-diverse paired-caption rules on held-out videos.
- Expand conservative Whisper spelling repairs from paired audio evidence.
- Re-run the caption audit after vocabulary changes; keep visible automatic
  labels in `NOT_CENSORED_WORDS` and regenerate synthetic fixtures deliberately.
- Follow [`docs/NEXT_RULE_IMPROVEMENT_PLAN.md`](docs/NEXT_RULE_IMPROVEMENT_PLAN.md)
  for the frozen baseline, evidence gates, and next-session workflow.

## Limitations

- Local inference can finish after a caption scrolls away on slow hardware.
- Ambiguous visible rows are left unchanged rather than guessed.
- Seeking to discarded audio requires YouTube to fetch that media again.
- Only English is currently supported.

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
`--via=search|direct|home`, `--auto-next=N`, `--until=SECONDS`, `--pause=SECONDS`,
and `--verbose`. Chromium smoke checks can select
`--mode=rules-only|whisper-only|hybrid|both-off`; `--expect=word[,word...]`
checks those words in the currently visible caption text. This is a live DOM
smoke diagnostic, not a slot-level accuracy test.

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

Historical `_manual` filenames may contain manual or alternate automatic
ground truth. See `docs/CAPTION_CORPUS_AUDIT.md` and use `--pairClass` to keep
manual-auto, auto-auto, synthetic, and unknown evidence separate.

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

The miner considers supported labels from `ALLOWED_WORDS`, deduplicates exact
rows, scans wildcard positions throughout each local window, and reports
precision and marginal gain by source. A recommendation outside `RULE_WORDS`
must be explicitly promoted before deterministic rules can emit it.
Recommendations require greater than 90% overall and marginal
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

The local auxiliary adapters and their source/licensing notes are documented in
[`docs/OPENSUBTITLES_EXPANDED_AUX.md`](docs/OPENSUBTITLES_EXPANDED_AUX.md) and
[`docs/SBCSAE_CORPUS.md`](docs/SBCSAE_CORPUS.md).

### Growing the caption corpus

Put creator channels or playlists in a config shaped like
`tools/paired-caption-channels.json`. Prefer profanity-rich conversational
creators, include canonical `channelId` values when known, and give every run a
descriptive report. Run one downloader at a time: the report and global
checked-video ledger are locked, and the ledger deduplicates video IDs
separately for each acquisition mode. `--pair-target`, `--max-check`, and
`--new-slot-cap` apply per configured creator.

```json
{
  "channels": [{
    "name": "Creator name",
    "channelId": "UC...",
    "sources": ["https://www.youtube.com/@handle/videos"]
  }]
}
```

Real `manual-auto` pairs need both a censored automatic English track and a
separate human English track with usable time-local ground truth. They are the
primary rule evidence but are relatively rare:

```sh
node tools/download-paired-captions.js \
  --config tools/paired-caption-channels.json \
  --report corpus/generated/manual-auto-next-report.json \
  --manual-auto-only true --audio-target 0 \
  --pair-target 12 --new-slot-cap 5000 \
  --list-limit 200 --sample-per-channel 30 \
  --max-check 30 --skip-after-clean 12 --jobs 3
```

Uncensored-auto-derived synthetic pairs are the scalable path. They require
only one uncensored automatic English track containing an `ALLOWED_WORDS`
entry. The downloader saves the original as exact ground truth and creates a
same-timeline censored copy locally. These are `synthetic`, not real
`auto-auto`, and must remain a separate evaluation tier:

```sh
node tools/download-paired-captions.js \
  --config tools/paired-caption-channels.json \
  --report corpus/generated/synthetic-auto-next-report.json \
  --synthetic-auto-only true --audio-target 0 \
  --pair-target 50 --new-slot-cap 5000 \
  --list-limit 200 --sample-per-channel 100 \
  --max-check 100 --skip-after-clean 40 --jobs 3
```

This mode rejects already-censored tracks and tracks with no supported word.
Adding a ground-truth-supported word to `ALLOWED_WORDS` therefore also expands
future synthetic discovery. After such a vocabulary change, intentionally
rescan selected creators with `--channels Name[,Name] --revisit`; otherwise the
global ledger correctly skips previous clean negatives. Without `--revisit`,
using the same config and report safely resumes unfinished work. A new report
starts a new acquisition lane but still respects the global ledger.

True `auto-auto` discovery needs two distinct automatic English tracks with an
exact same-timeline replacement. It is much rarer—755 earlier checks plus a
106-video Sseth and 200-video Ariel feed enumeration found no additional pair
among 303 definitive outcomes; three videos remained transiently unavailable.
It can be attempted explicitly with `--auto-auto-only true`. Never merge its
results with synthetic pairs.

After every acquisition, freeze writers and audit provenance before evaluating:

```sh
node tools/audit-caption-corpus.js \
  --pair-class manual-auto,auto-auto,synthetic \
  --output corpus/generated/caption-corpus-audit.json
```

Check the report's per-channel statuses before treating a run as exhausted.
DNS failures, empty listings, rate limits, and other transient failures are not
negative evidence. Keep `manual-auto`, `auto-auto`, and `synthetic` metrics
separate, cap prolific creators with `--new-slot-cap`, and use
`--sample-per-channel` to spread checks across a creator's catalog.

## Build

```sh
./build.sh 1.5.2
```

This creates separate Chromium and Firefox ZIPs in `dist/`. See
[AMO_SOURCE.md](AMO_SOURCE.md) for submission and vendored-runtime notes.
