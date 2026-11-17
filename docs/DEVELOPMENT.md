# Development workflows

The README covers product behavior, architecture, metrics and the short build/test commands.
This page holds the specialized corpus, benchmark, annotation and rule-discovery procedures.
Do not copy metrics or session status here. Evidence gates live in [`RULES.md`](RULES.md),
session state in [`SESSION_HANDOFF.md`](SESSION_HANDOFF.md), provenance semantics in
[`CAPTION_CORPUS_AUDIT.md`](CAPTION_CORPUS_AUDIT.md), auxiliary text sources in
[`OPENSUBTITLES_EXPANDED_AUX.md`](OPENSUBTITLES_EXPANDED_AUX.md) and
[`SBCSAE_CORPUS.md`](SBCSAE_CORPUS.md).

## Lightweight runtime checks

```sh
node tests/build-packaging.test.js
node tests/audio-whisper-retry.test.js
node tests/whisper-local.test.js
node tests/whisper-init.test.js
```

These use tiny fixtures and mocked inference; they do not replace `npm run test:release` and
browser checks before shipping.

Whisper contract: `transcribeDetailed` resolves a decision with a string `word` (empty is a
valid abstention); model/initialization exceptions reject, and worker/host failures arrive as
errors, never as empty decisions. The page caller retries a failure once after 250 ms, then
abstains. Navigation, caption/mode and seek epochs invalidate outstanding results; cancellation
must not poison the new queue's failed-token cache. The host timeout bounds waiting, not worker
execution: there is no inference cancellation or real-time latency guarantee.

`build.sh` stages only runtime formats (`js`, `mjs`, `html`, `css`, `json`, `png`, `wasm`,
`onnx`, `bin`). Keep scratch code out of `src/`; update the filter and its test for a new asset type.

Whisper cost: the q8 encoder accepts fewer than 3000 mel frames
(`tools/make-truncatable-encoder.py`), so `whisper-local.js` encodes only the real audio plus 2 s
of silence; both sessions load with graph optimisation `basic` (`all` fails to load the q8
decoder). The Automatic mode's budget in `audio-capture.js` (0.74 s per window + 0.64 s per blank)
is the largest scaling of a per-window + per-blank cost, at the current code's measured ratio of
the two, for which a replay of a Whisper-first browser run's queue (`debug` telemetry: token
times, decoded-audio progress) has no late word. Re-derive it when the queue policy or that cost
ratio changes.

## macOS compatibility checks

CI runs `npm run test:release` on Ubuntu and macOS: automated tests, staging both packages,
ZIP integrity and Firefox linting. It does not launch a browser or prove playback or Whisper
inference on macOS. Locally on a Mac (Node.js 22, Python 3, `zip`, `unzip`):

```sh
npm ci
npm run test:release
```

The browser smoke runners are Linux-only. For a manual Mac check, load `dist/chromium` unpacked
or `dist/firefox/manifest.json` via `about:debugging`, then check rules replacement on English
automatic captions with `[__]`, Whisper modes, pause/resume, seeking, navigation and the popup.
Record macOS, browser and architecture versions, mode, video URL and console errors. Safari is
not covered.

## Native Firefox smoke

`npm run test:firefox` runs `node tools/browser-smoke.js --workspace --firefox-only
--initial-only`: one URL (default `https://www.youtube.com/watch?v=an5iFYcjWUM`),
`whisper-first`, `--until=90`. It does not cover SPA navigation, pause or playlists; use the
Chromium multi-navigation command in the README. Strict pure-audio check:

```sh
npm run test:firefox -- --mode=whisper --rate=1 --seek=20:45 --until=90 \
  --expect=fucking 'https://www.youtube.com/watch?v=an5iFYcjWUM'
```

Modes: `off` (the popup switch off), `rules`, `rules-first`, `whisper-first`, `whisper` (aliases `both-off`,
`rules-only`, `hybrid`, `whisper-only`). `--expect=word[,word...]` is required for `rules`
(`--expect=shit` for the default video).

Requires Linux, Firefox, `web-ext`, `pactl` with a working audio server, `flock` and network.
Build first (`./build.sh <version>`); the runner pins runtime hashes and refuses stale builds.
Firefox runs native headless on the hidden `special:uncensored-smoke` workspace (`--workspace`);
never fall back to a visible browser. A muted, zero-volume null sink isolates playback, a shared
lock prevents overlapping runs, and cleanup targets only owned processes. Checks correlate
visible `[__]` replacement with runtime decisions; `late`/`minLead` are timing diagnostics, not
accuracy. Logs and evidence stay in ignored `tmp/firefox-smoke-*`.

## Paired evaluation

Accuracy fixtures need `yt-dlp` and separate automatic and human English caption tracks:

```sh
node tools/download-whisper-fixtures.js
node tools/evaluate-whisper-only.js
node tools/evaluate-whisper-only.js --mode rules+whisper \
  --transcripts corpus/generated/whisper-only-report.json
```

`--transcripts` reuses cached audio decisions from a complete Whisper report; it and audio-mode
`--reuse` require the same audio window, scorer, audio-processing code and per-fixture SHA-256
audio identity, so replaced or added audio invalidates reuse. Rules-only reuse is caption/rules
based. Audio files must pass timestamp/decode coverage validation.

The extension and the evaluator both run the shipped acoustic head (`--acousticHead`, default
`src/models/acoustic-head-cnn.bin`, part of the transcript fingerprint; `none` turns it off). A
head file with fusion parameters fuses with the decoder on every slot; one without them only
fills the decoder's uncertain slots.

By default the evaluator uses `tools/whisper-audio-fixtures.json`; `--discoverPaired true`
includes every pair in the ignored `test-fixtures/`. Reports go to `corpus/generated/`. Results
below 50% alignment stay in the totals but are marked `reviewRecommended`:

```sh
jq '.fixtures[] | select(.reviewRecommended) | {name, scoredCount, unscoredCount}' \
  corpus/generated/paired-rules-only-report.json
```

Historical `_manual` files may hold manual or alternate automatic ground truth: always pass
`--pairClass` to keep `manual-auto`, `auto-auto`, `synthetic` and `unknown` separate.
Prospective evaluation requires the frozen canonical-ID manifest (aggregates only; see
AGENTS.md):

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --pairClass manual-auto --creatorManifest tools/caption-growth-heldout-test-manual-pilot.json \
  --creatorSplit test --output /tmp/rules-heldout-test.json
```

Keep strict accuracy separate from the candidate-oracle diagnostic (`--rulesScoring
any-candidate`, correct when the answer is any `|` option of a matched rule). `--reuse` keeps
unchanged fixtures and unaffected slots after rule changes:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --skipMissing true --output corpus/generated/paired-rules-only-report.json
node tools/evaluate-whisper-only.js --mode rules-only --rulesScoring any-candidate \
  --discoverPaired true --skipMissing true \
  --output corpus/generated/paired-rules-any-candidate-report.json
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --skipMissing true --reuse corpus/generated/paired-rules-only-report.json \
  --output corpus/generated/paired-rules-only-report.json
```

Review rows include four caption events either side (`--contextEvents N`). Completed reports
can be imported into the metrics table only after mode, completion, arithmetic and fingerprints
validate; imports stay diagnostic unless separately promoted:

```sh
REPORT=corpus/generated/dense-audio-28-rules-whisper.json
node tools/evaluation-metrics.js --import-report "$REPORT" --id dense-audio-hybrid \
  --mode hybrid --expected-report-fingerprint sha256:<sha256-of-report> \
  --expected-rules-fingerprint 3707:39:qoalur --write
```

## Windowed audio

`tools/fetch-heldout-audio.js` (`FETCH_AUDIO_IDS`, `FETCH_AUDIO_DIR`, `HELDOUT_NETNS`) keeps only
merged windows from 35 s before to 30 s after each `[__]` of the censored automatic track,
stream-copied as `<id>.s<start>-<end>.<ext>` with the true start (`-copyts`).
`evaluate-whisper-only.js` and `deepgram-triage.js` seek relative to it and refuse uncovered
windows; `annotate-audio.js` does not read sections. Needs Linux `flock`, GNU `timeout`,
`yt-dlp`, `ffprobe` and `ffmpeg`.

`tools/audio-coverage.js` checks decodable, continuous media timestamps, not filenames. A
truncated final window, whole-file completion and end clamping need `<id>.source.json` duration
metadata from yt-dlp. Per-video kernel locks and a queue-ledger lock prevent overlapping
writers; let active acquisitions finish before deploying a new downloader. Invalid outputs are
replaced only under the video lock; raw captions are untouched.

Transient failures get three attempts (30/60 s backoff); the run exits nonzero when incomplete
and records unresolved IDs in `<FETCH_AUDIO_IDS>.audio-retries.json` (`FETCH_AUDIO_LEDGER`).
Rerunning the queue revalidates media and retries transient items. Private/removed/members-only
sources stay permanent until you review them. Logs give a throughput ETA when measured; it stays
unknown while failures remain.

## Labeling short audio fragments

Download dense fixture audio if needed (`2` workers, `firefox` cookies; English or
unspecified original audio only), then generate matching reports:

```sh
node tools/download-dense-audio.js 2 firefox
# Replace downloads that selected the wrong alternate-language track:
node tools/download-dense-audio.js 2 firefox --redownload
node tools/evaluate-whisper-only.js --mode rules-only \
  --manifest tools/dense-paired-audio-fixtures.json --skipMissing true \
  --output tmp/annotation-rules.json
node tools/evaluate-whisper-only.js --mode whisper-only \
  --manifest tools/dense-paired-audio-fixtures.json --skipMissing true \
  --checkpointEvery 25 --output tmp/annotation-whisper.json
```

Open a queue on `127.0.0.1:8765` (rule review uses 8767). Use a distinct `--output` per queue;
labels save atomically and resume on rerun. See `node tools/annotate-audio.js --help` for all
options.

```sh
node tools/annotate-audio.js --mode disagreements \
  --rules-report tmp/annotation-rules.json \
  --whisper-report tmp/annotation-whisper.json \
  --audio-dir test-fixtures/audio \
  --output tmp/audio-disagreements.json --port 8765
# Or --mode whisper-misses | review | golden | triage | deepgram-review | false-fills.
```

- `triage`: every Rules/Whisper conflict plus up to 25 both-empty examples, omitting rows the
  prior false-fill labels mark unusable (`--false-fill-report tmp/false-fill-p0.json`).
  `--limit N` caps the queue (`0` keeps all non-agreements); `--both-empty-limit N` changes the
  reservation. Selection uses only runtime predictions.
- `golden`: every available slot; use a separate output for a frozen test queue.
- `--deepgram-triage FILE` overlays completed Deepgram transcripts as unverified ASR; it never
  selects items or supplies labels. `deepgram-review` restricts the queue to those slots and
  hides ASR until after listening. A historical report matched by SHA-256 is for annotation
  only, not a benchmark or held-out test:

  ```sh
  node tools/annotate-audio.js --mode deepgram-review \
    --whisper-report corpus/generated/dense-audio-v2-whisper-triage-current.json \
    --deepgram-triage tmp/deepgram-triage.json \
    --output tmp/deepgram-audio-review.json --before 5 --after 5 --port 8765
  ```

- `false-fills` (P0 session): every playable runtime fill of the current dense artifact, with
  round-robin coverage across word/tier, fixture and rule. It never uses `expected`, `correct`
  or held-out fields, and needs a report with current rules/engine fingerprints. Labels are
  review-only and never add ordinary words to runtime rules:

  ```sh
  node tools/annotate-audio.js --mode false-fills \
    --rules-report corpus/generated/dense-audio-v2-rules-only-current.json \
    --audio-dir test-fixtures/audio --output tmp/false-fill-p0.json \
    --limit 0 --port 8765
  ```

Existing human labels are never replaced by ASR; `--prior-labels FILE` seeds a new output from
matching reviewed labels. Multi-blank caption events are grouped by default
(`--group-captions false` for per-slot queues); missing or mismatched raw caption mapping falls
back to single-slot review. Model guesses stay hidden until revealed.

Contested labels: `node tools/label-audit-queue.js tmp/label-audit/label-audit.json >
tmp/label-audit/relisten-diagnostic.json` produces re-listening suggestions, not ground truth.
Resolve disagreements by listening; ASR votes are diagnostic only.

## Unpaired comparisons

Auto-only captions have no ground truth, so only fill rate is measurable. Compare rules and
Whisper on the same slots:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverUnpaired true \
  --unpairedMinBlanks 1 --allowUnscored true --skipMissing true \
  --output corpus/generated/unpaired-rules-only-report.json
node tools/evaluate-whisper-only.js --mode whisper-only --discoverUnpaired true \
  --unpairedMinBlanks 1 --allowUnscored true --skipMissing true --limit 25 \
  --checkpointEvery 10 \
  --output corpus/generated/unpaired-whisper-only-report.json
```

`--limit 25` is a sample; complete it with `--limit 0 --transcripts
corpus/generated/unpaired-whisper-only-report.json`. Compare disagreement shares only once both
reports cover the same slots.

## Rule mining

Generate normalized text-corpus samples, then mine every source together:

```sh
node corpus/evaluate-corpus.js --input corpus/reddit_comments.zip \
  --output corpus/generated/mining/reddit --field body \
  --limit 1000000 --sampleLimit 0
node corpus/evaluate-corpus.js \
  --input corpus/opensubtitlesen-es.parquet \
  --output corpus/generated/mining/opensubtitles \
  --limit 1000000 --sampleLimit 0
```

Whisper may provide discovery-only labels for unpaired captions; they never count toward
precision:

```sh
node tools/evaluate-whisper-only.js --mode whisper-only \
  --discoverUnpaired true --unpairedMinBlanks 0 --allowUnscored true \
  --skipMissing true --limit 3 \
  --transcripts corpus/generated/youtube-whisper-only-all-videos-sample-report.json \
  --output corpus/generated/mining/unpaired-whisper.json
```

Admission follows the gates in [`RULES.md`](RULES.md); a word outside `RULE_WORDS` must be
promoted before rules can emit it. Rerun ground-truth evaluation after each batch. Another text
dataset can be supplied as JSONL
`{"original":"uncensored sentence","censored":"same sentence with [__]"}`.

## Creator-grouped rules-only analysis

```sh
node tools/build-real-manual-auto-dataset.js --mode faithful \
  --output .tmp-real-manual-auto-faithful.json --folds 5
node tools/audit-current-rules.js --output /tmp/current-rule-audit.json
node tools/mine-context-leaves.js --dataset .tmp-real-manual-auto-faithful.json \
  --output .tmp-context-leaf-proposals.json
```

Archived datasets are discovery-only (saved review contexts may contain transformed neighboring
slots). Creator-fold promotion proposals require `mode: faithful`, `validation: faithful-only`
and `discoveryOnly: false`.

## Caption corpus acquisition

Put creator channels or playlists in a config shaped like `tools/paired-caption-channels.json`
(include canonical `channelId` when known). Run one downloader at a time: reports and
the global checked-video ledger are locked, and the ledger deduplicates per acquisition mode.
`--pair-target`, `--max-check` and `--new-slot-cap` apply per creator.

```json
{ "channels": [{ "name": "Creator name", "channelId": "UC...",
  "sources": ["https://www.youtube.com/@handle/videos"] }] }
```

Run manual-auto and synthetic-auto as separate lanes with separate reports. Real `manual-auto`
pairs need a censored automatic English track and a separate human English track:

```sh
node tools/download-paired-captions.js \
  --config tools/paired-caption-channels.json \
  --report corpus/generated/manual-auto-next-report.json \
  --manual-auto-only true --audio-target 0 \
  --pair-target 12 --new-slot-cap 5000 \
  --list-limit 200 --sample-per-channel 30 \
  --max-check 30 --skip-after-clean 12 --jobs 3
```

Synthetic pairs need one uncensored automatic English track with an `ALLOWED_WORDS` entry; the
downloader keeps it as exact ground truth and censors a same-timeline copy locally. They are
`synthetic`, never real `auto-auto` or manual ground truth:

```sh
node tools/download-paired-captions.js \
  --config tools/paired-caption-channels.json \
  --report corpus/generated/synthetic-auto-next-report.json \
  --synthetic-auto-only true --audio-target 0 \
  --pair-target 50 --new-slot-cap 5000 \
  --list-limit 200 --sample-per-channel 100 \
  --max-check 100 --skip-after-clean 40 --jobs 3
```

After a vocabulary change, rescan creators with `--channels Name[,Name] --revisit`; otherwise
the ledger skips earlier clean negatives. Reusing a config and report resumes unfinished work.
`auto-auto` (two distinct automatic tracks with an exact same-timeline replacement) runs only
explicitly with `--auto-auto-only true`.

A query-driven manual-auto pilot uses named search queues and no audio:

```sh
node tools/download-paired-captions.js \
  --config tools/caption-growth-manual-context-queries.json \
  --report corpus/generated/manual-context-query-report.json \
  --manual-auto-only true --audio-target 0 --pair-target 1 \
  --new-slot-cap 2000 --list-limit 12 --sample-per-channel 12 --max-check 12 \
  --skip-after-clean 6 --jobs 1 --retries 4 --retry-delay 30 --request-sleep 2
```

After at least 50 acquired slots, `tools/post-acquisition-refresh.js` rebuilds the faithful
dataset, current-rule audit and creator-fold proposals, skipping unchanged inputs.

Prospect lists are leads, not guarantees: `tools/caption-prospects-uncensored-auto.json`
(literal swears sampled in automatic captions) and `tools/caption-prospects-manual.json`
(swears in observed manual subtitles, plus a lower-confidence section).

Check per-channel statuses before treating a run as exhausted: DNS failures, empty listings and
rate limits are not negative evidence. After every acquisition, freeze writers and audit
provenance before evaluating:

```sh
node tools/audit-caption-corpus.js \
  --pair-class manual-auto,auto-auto,synthetic \
  --output corpus/generated/caption-corpus-audit.json
```

### Interactive rule review

Run `npm run rules:review` and open `http://127.0.0.1:8767` (local only). It shows the actual
discovery candidates with filters for target, tier and review status, and short positive,
counter and unknown examples with provenance and current-rule predictions. Reviews append to
`corpus/rules/rule-reviews.jsonl` and go stale when their evidence changes. **Accepting does not
deploy a rule or edit runtime files**: candidates still need the `RULES.md` gates. Preview is a
diagnostic context matcher, not runtime execution. `--port`, `--dataset`, `--leads` and
`--output` allow isolated sessions.

### Automatic discovery refresh

```sh
npm run corpus:refresh
# Poll for newly saved pairs (run during acquisition; restart after tooling or rule changes):
npm run corpus:watch
# Focus on a word without dropping competing labels:
node tools/mine-context-leaves.js --dataset corpus/generated/caption-discovery.json \
  --word fucked --window 4,4 --output tmp/fucked-discovery-leads.json
```

The refresh indexes `paired-saved` pairs from the acquisition reports, saved reports under
`tmp/channel-research/agent-downloads/` (and `state/` directories) and any `--report FILE`.
Sources are snapshotted around reads; an unreadable previously indexed source defers publication
instead of replacing valid outputs. Outputs: `corpus/generated/caption-discovery.json`,
`caption-discovery-leads.json` and `caption-discovery-refresh-state.json`. Raw captions are
never rewritten or promoted.

Discovery features ignore speaker arrows, bracketed non-speech cues, music notes and formatting
tags; annotation text never becomes a rule condition. Mining uses a 4,4-token window, sparse
one/two-feature patterns and contiguous phrases up to eight tokens, and emits all passing
candidates (`--limit 0`). Precision, marginal support and creator gates apply before ranking,
with competing/unknown labels kept in denominators. Tiers stay separate; contradictory synthetic
support rejects a manual-auto lead, while manual-auto contradictions of a synthetic lead are only
recorded. `--exclude tmp/rejected-patterns.json` (array of candidate IDs or `{ "keys": [...] }`)
skips reviewed patterns without removing evidence. Leads are in-sample discovery, not
validation: they never become runtime rules without the evidence gates.
