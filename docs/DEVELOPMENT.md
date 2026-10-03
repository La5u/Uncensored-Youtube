# Development workflows

The README covers product behavior, architecture, limitations, the current
metrics table, and the short build/test commands. This page keeps the
specialized corpus, benchmark, annotation, and rule-discovery procedures out of
that overview. Do not copy current metrics or session status here; use the
README and the linked handoff documents for those.

For provenance semantics and audit fields, see
[`CAPTION_CORPUS_AUDIT.md`](CAPTION_CORPUS_AUDIT.md). For the current evidence
gates and handoff plan, see [`RULES.md`](RULES.md) and
[`SESSION_HANDOFF.md`](SESSION_HANDOFF.md). Auxiliary
text-source licensing and adapters are documented in
[`OPENSUBTITLES_EXPANDED_AUX.md`](OPENSUBTITLES_EXPANDED_AUX.md) and
[`SBCSAE_CORPUS.md`](SBCSAE_CORPUS.md).

## Lightweight runtime checks

```sh
node tests/build-packaging.test.js
node tests/audio-whisper-retry.test.js
node tests/whisper-local.test.js
node tests/whisper-init.test.js
```

These use tiny staging fixtures, fake timers and mocked inference; they do not
copy models, compress release ZIPs, fetch data, or run a real model. They are not
a replacement for `npm run test:release` and browser checks before shipping.

Whisper contract: `transcribeDetailed` resolves a decision with a string `word`
(empty means a valid abstention); model/initialization exceptions reject. Worker
and host failures travel as error responses, never as empty decisions. The page
caller treats missing/malformed responses and messaging timeouts as failures,
retries once after 250 ms, then abstains. Navigation, caption/mode and seek epochs
invalidate outstanding results/backoff; cancellation must not poison the new
queue's failed-token cache. The host timeout bounds waiting, not worker execution:
there is no inference cancellation protocol or real-time latency guarantee.

`build.sh` stages only runtime file formats (`js`, `mjs`, `html`, `css`, `json`,
`png`, `wasm`, `onnx`). Keep scratch code out of `src/` even if it uses one of
those formats; update the filter/test when introducing a new runtime asset type.

## Native Firefox smoke

`npm run test:firefox` runs `node tools/browser-smoke.js --workspace
--firefox-only --initial-only`: one URL, default
`https://www.youtube.com/watch?v=an5iFYcjWUM`, `whisper-first`, and `--until=90`.
Firefox requires `--initial-only`; it does not cover SPA navigation, pause, or
playlists. Use the separate Chromium multi-navigation command in the README.

Recommended strict pure-audio check:

```sh
npm run test:firefox -- --mode=whisper --rate=1 --seek=20:45 --until=90 \
  --expect=fucking 'https://www.youtube.com/watch?v=an5iFYcjWUM'
```

Modes are `off`, `rules`, `rules-first`, `whisper-first`, and `whisper`.
Aliases remain: `both-off` → `off`, `rules-only` → `rules`, `hybrid` →
`whisper-first`, `whisper-only` → `whisper`. `--expect=word[,word...]` is optional
except for `rules` (use `--expect=shit` for the default video). Availability is
not evidence that all modes have been validated.

Requires Linux, Firefox, `web-ext`, `pactl` with a working audio server, `flock`,
network access, and confirmed AC power for heavy inference. Build first with
`./build.sh 1.6.1`: `dist/firefox/src` must match current `src`; the runner pins
actual runtime hashes and refuses stale builds. Firefox is native headless,
not WebDriver. Keep `--workspace` on the hidden `special:uncensored-smoke`
workspace; never fall back to a visible browser on the user's workspace.
A dedicated muted, zero-volume null sink isolates playback without changing
default audio settings. A shared browser-smoke lock prevents overlapping runs;
cleanup targets only owned processes, never broad browser kills.

Checks correlate visible `[__]` replacement with runtime decisions (including
post-seek audio decisions), rather than accepting a word elsewhere on the page.
Summaries include `late` and `minLead` timing diagnostics; these are not
slot-level accuracy scores. Ignored `tmp/firefox-smoke-*` artifacts retain logs,
telemetry, runtime hashes, audio isolation, and summary evidence. Automatic
owner-scoped cleanup removes temporary profiles/extensions and the owned sink
and processes while keeping logs; do not use global cleanup commands.

## Paired evaluation

Accuracy fixtures require `yt-dlp` and separate automatic and human English
caption tracks:

```sh
node tools/download-whisper-fixtures.js
node tools/evaluate-whisper-only.js
node tools/evaluate-whisper-only.js --mode rules+whisper \
  --transcripts corpus/generated/whisper-only-report.json
```

`--transcripts` reuses the cached audio decisions (`audioWord`/`audioScore`) of a
complete Whisper report with the same audio window and scorer fingerprint.

The evaluator uses only `tools/whisper-audio-fixtures.json` by default. Pass
`--discoverPaired true` to include every caption pair in `test-fixtures/`.
Fixtures are stored in ignored `test-fixtures/`; reports go to
`corpus/generated/`. Pairs whose manual track has no recognized ground-truth
word are skipped. Results below 50% alignment remain in the valid-slot totals
but are marked `reviewRecommended`; inspect them with:

```sh
jq '.fixtures[] | select(.reviewRecommended) | {name, scoredCount, unscoredCount}' \
  corpus/generated/paired-rules-only-report.json
```

Historical `_manual` filenames may contain manual or alternate automatic
ground truth. Always use `--pairClass` to keep `manual-auto`, `auto-auto`,
`synthetic`, and `unknown` evidence separate. Once test pairs exist,
prospective evaluation requires the frozen canonical-ID manifest:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --pairClass manual-auto --creatorManifest tools/caption-growth-heldout-test-manual-pilot.json \
  --creatorSplit test --output /tmp/rules-heldout-test.json
```

Keep strict accuracy separate from the candidate-oracle diagnostic, which counts
a slot as correct when its answer appears anywhere in a matched rule's `|`
options:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --skipMissing true --output corpus/generated/paired-rules-only-report.json
node tools/evaluate-whisper-only.js --mode rules-only --rulesScoring any-candidate \
  --discoverPaired true --skipMissing true \
  --output corpus/generated/paired-rules-any-candidate-report.json
```

Reports carry caption, rules-data, rules-engine, and decision/Whisper
fingerprints. With `--reuse`, unchanged fixtures and unaffected slots in
fixtures touched by rule changes are reused:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --skipMissing true --reuse corpus/generated/paired-rules-only-report.json \
  --output corpus/generated/paired-rules-only-report.json
```

Review rows include four caption events on either side of the target by default;
use `--contextEvents N` to change that without changing the scored slot. Rules-
only reruns use a blank-centered trie to identify affected fixtures, then reuse
cached slot results whose rule template and context did not change.

Completed benchmark reports can be imported only after their mode, completion,
summary arithmetic, and supplied report/rules fingerprints validate. Use the
report SHA-256 as the expected fingerprint; imports replace the matching row
and remain diagnostic unless separately promoted:

```sh
REPORT=corpus/generated/dense-audio-28-rules-whisper.json
node tools/evaluation-metrics.js --import-report "$REPORT" --id dense-audio-hybrid \
  --mode hybrid --expected-report-fingerprint sha256:<sha256-of-report> \
  --expected-rules-fingerprint 3707:39:qoalur --write
```

## Labeling short audio fragments

Use the local annotation page to resolve rules/Whisper disagreements, review
known Whisper misses, or create human gold labels. Download dense fixture audio
if needed (`2` is the worker count and `firefox` is the cookie browser):

```sh
node tools/download-dense-audio.js 2 firefox
# Replace old downloads that selected the wrong alternate-language track:
node tools/download-dense-audio.js 2 firefox --redownload
```

The downloader accepts only English or language-unspecified original audio,
never an explicitly non-English fallback. Generate matching reports, for
example:

```sh
node tools/evaluate-whisper-only.js --mode rules-only \
  --manifest tools/dense-paired-audio-fixtures.json --skipMissing true \
  --output tmp/annotation-rules.json
node tools/evaluate-whisper-only.js --mode whisper-only \
  --manifest tools/dense-paired-audio-fixtures.json --skipMissing true \
  --checkpointEvery 25 --output tmp/annotation-whisper.json
```

Open a queue (the rule-review UI uses 8767, so audio review stays on 8765):

```sh
node tools/annotate-audio.js --mode disagreements \
  --rules-report tmp/annotation-rules.json \
  --whisper-report tmp/annotation-whisper.json \
  --audio-dir test-fixtures/audio \
  --output tmp/audio-disagreements.json --port 8765
# Or: --mode whisper-misses, --mode review, or --mode golden, with a distinct output.
# Optional: add a diagnostic-only Deepgram transcript overlay to matching slots:
#   --deepgram-triage tmp/deepgram-triage.json
```

For a small high-yield queue containing every Rules/Whisper conflict plus up to
25 deterministic both-empty examples (and no agreements), use the prior
false-fill labels to omit unusable rows and non-English fixtures:

```sh
node tools/annotate-audio.js --mode triage \
  --false-fill-report tmp/false-fill-p0.json --output tmp/triage.json
```

Set `--limit N` to cap the queue (disagreements are prioritized, then the
remaining capacity is balanced between one-sided predictions) and
`--both-empty-limit N` to change the both-empty reservation. `--limit 0` keeps
all non-agreements subject to the both-empty cap. Triage selection uses only
runtime Rules and Whisper predictions; held-out expected/correct fields are not
used.

The page runs only on `127.0.0.1` and saves resumable labels to
`tmp/audio-annotations.json`. Standard modes group multi-blank original caption
events by default: all blanks stay visible, playback covers the group, and you
can enter words in order (spaces or commas) or use per-slot word/status fields.
**Save all caption slots** validates and saves the whole group atomically, retaining
individual fixture/token IDs. Other report slots in the same event are included
and marked `expandedSelection`; this expanded queue remains a selected diagnostic.
Existing human labels are read-only in batches and are never replaced by ASR.
`--prior-labels FILE` seeds a new output from reviewed labels with matching slot/audio
identity. Use `--group-captions false` to resume old per-slot queues or explicitly
correct prior labels. Missing, incomplete, or timestamp-mismatched raw caption
mapping falls back to single-slot review; literal ellipses are never guessed to
be censor markers. False-fill sessions remain per-slot.
Model guesses are
hidden until explicitly revealed. Choose a word from `ALLOWED_WORDS`, choose
**No swear in audio** when no swear is audible, **Wrong audio fragment** when
the audio and caption do not match, or **Not English**. In the normal review modes, Rules and Whisper words appear as one-click
choices when available, including every rules candidate. Common-word buttons
and autocomplete use current annotation frequency; Tab
completes a non-empty partial word. Press **R** to label with the Rules model's
recommendation, **U** (or **Unsure / skip**) when undecided, and Space to toggle
1×/2× without seeking. An available Whisper transcript appears below the audio
controls. Saving or navigating starts the next fragment automatically. **Not
English audio** labels every remaining fragment from that fixture. Labels record
`widePlayed` when **Wide replay** was used, and an optional rule recommendation
can be marked **Precise / word-for-word**, **General pattern**, or **Manual rule**
with typed rule text; it is saved as structured `ruleRecommendation` data.

`golden` includes every available slot rather than selecting by model errors;
use a separate output file for a frozen test queue. Existing evaluator ground
truth selects only `whisper-misses` and is never copied into the annotation
queue. See `node tools/annotate-audio.js --help` for paths, window size, queue
limit, and port options. `--deepgram-triage FILE` optionally overlays completed
Deepgram transcripts onto matching fixture/token slots in an otherwise ordinary
queue. It does not select queue items or supply labels; the transcript is shown
only as unverified ASR alongside human audio review. The importer requires the
report's diagnostic-only marker and Deepgram provider, and checks slot timestamps.
For a historical whisper-only report, `--mode golden` or `--mode deepgram-review`
also permits the exact report SHA-256 recorded in this Deepgram snapshot; this
is for human annotation only, **not** a current-code benchmark or an untouched
held-out test. `deepgram-review` restricts the queue to completed Deepgram
slots, preserves the triage selection order, hides ASR transcripts until
opened after listening, and plays from one second before the target by default.
Use **Replay full context** if timing is off or the word is unclear:

```sh
node tools/annotate-audio.js --mode deepgram-review \
  --whisper-report corpus/generated/dense-audio-v2-whisper-triage-current.json \
  --deepgram-triage tmp/deepgram-triage.json \
  --output tmp/deepgram-audio-review.json --before 5 --after 5 --port 8765
```

Use a separate output path as usual; existing annotation files and triage
artifacts are not modified by importing it. Prior human labels from the
annotation history are reused rather than overwritten.

### Contested-label diagnostic

```sh
node tools/label-audit-queue.js tmp/label-audit/label-audit.json > tmp/label-audit/relisten-diagnostic.json
```

This preserves human labels and produces timed re-listening suggestions, not
annotation input or ground truth. Resolve disagreements by listening before
changing labels; ASR votes and word-family matches are diagnostic only.

### P0 false-fill session

This is the small, audio-first P0 session for every available runtime fill in
the current dense artifact. It uses bounded round-robin coverage across
predicted word/tier, fixture, and rule ID, including when `--limit 0` selects
all playable fills, and reports candidate/selected coverage in the resumable
queue. `--limit 0` means all playable fills. It
never uses `expected`, `correct`, or other held-out fields to select or expose
a queue; the browser receives only the runtime prediction and caption context.
The report must have current rules, auxiliary-rules, and engine fingerprints;
do not point this session at a held-out or stale report.

Run this exact command, then open `http://127.0.0.1:8765/` in a browser:

```sh
node tools/annotate-audio.js --mode false-fills \
  --rules-report corpus/generated/dense-audio-v2-rules-only-current.json \
  --audio-dir test-fixtures/audio --output tmp/false-fill-p0.json \
  --limit 0 --port 8765
```

The output is atomic and resumable; rerun the same command after interruption.
Resume checks the complete item/status set and audio file identity/content.
The short target caption is shown first; four-event surrounding captions are
expandable context, and surrounding text is not expected in the 4s clip.
Predictions are informational text only in this mode: they cannot populate or
copy into the spoken-word field. For each slot choose **Genuine profanity**,
**Ordinary word**, **Silence / no word**, **Non-English**,
**Wrong audio fragment (W)**, or **Unusable / uncertain**. The latter
controls record the exact **Actually spoken word** when audible, confidence
(`high`, `medium`, `low`, or `unknown`), and timing offset in seconds. New and
pending items default to high confidence. **Rules correct (R)** records a
genuine-profanity label using the current Rules prediction as the spoken word.
These are review labels only; they do not add ordinary words or held-out
labels to runtime rules. In false-fill mode, **W** marks an alignment mismatch;
**/** focuses and selects the Actually spoken word field, and **Escape** leaves
that field without submitting. Older saved files with slot-correspondence metadata
are migrated, but that metadata is no longer collected. Stop the foreground process with `Ctrl-C` when
finished.

## Unpaired comparisons

Auto-only captions have no ground truth, so precision is undefined; only fill
rate is measurable. Compare rules and local Whisper on the same slots to find
candidate rules and disagreements:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverUnpaired true \
  --unpairedMinBlanks 1 --allowUnscored true --skipMissing true \
  --output corpus/generated/unpaired-rules-only-report.json
node tools/evaluate-whisper-only.js --mode whisper-only --discoverUnpaired true \
  --unpairedMinBlanks 1 --allowUnscored true --skipMissing true --limit 25 \
  --checkpointEvery 10 \
  --output corpus/generated/unpaired-whisper-only-report.json
```

`tools/compare-unpaired-modes.js` was removed as unused pipeline code; compare
the two reports directly to find disagreements.

The Whisper run is heavy and checkpoint-resumable. A `--limit 25` run is only a
sample; complete it with `--limit 0 --transcripts
corpus/generated/unpaired-whisper-only-report.json`. Do not interpret
disagreement shares until both reports cover the same slots.

## Rule mining

Generate complete normalized samples, then mine every source together:

```sh
node corpus/evaluate-corpus.js --input corpus/reddit_comments.zip \
  --output corpus/generated/mining/reddit --field body \
  --limit 1000000 --sampleLimit 0
node corpus/evaluate-corpus.js \
  --input corpus/opensubtitlesen-es.parquet \
  --output corpus/generated/mining/opensubtitles \
  --limit 1000000 --sampleLimit 0
```

`tools/mine-rule-opportunities.js` was removed as unused pipeline code; recover
it from git history to mine these samples again.

Whisper may provide discovery-only labels for captions without a human pair:

```sh
node tools/evaluate-whisper-only.js --mode whisper-only \
  --discoverUnpaired true --unpairedMinBlanks 0 --allowUnscored true \
  --skipMissing true --limit 3 \
  --transcripts corpus/generated/youtube-whisper-only-all-videos-sample-report.json \
  --output corpus/generated/mining/unpaired-whisper.json
```

Mining requirements: more than 90% overall and marginal precision, more than 90%
in every supported source, and no single-video dominance. After realization,
keep only rules with at least three matches and more than 90% realized
precision. Apply the remaining quality gates in [`RULES.md`](RULES.md); a
recommendation outside `RULE_WORDS` must be promoted before deterministic rules
can emit it. Rerun ground-truth evaluation after each batch. Whisper labels are
discovery-only and never count toward reported precision.

For another text dataset, use JSONL with
`{"original":"uncensored sentence","censored":"same sentence with [__]"}`.
Keep the top 300 misses and top 50 wrong placements from each evaluation report
as the next review queue.

## Creator-grouped rules-only analysis

Build a faithful five-fold real manual-auto dataset, audit current rules on
original contexts, and mine shallow token-window proposals:

```sh
node tools/build-real-manual-auto-dataset.js --mode faithful \
  --output .tmp-real-manual-auto-faithful.json --folds 5
node tools/audit-current-rules.js --output /tmp/current-rule-audit.json
node tools/mine-context-leaves.js --dataset .tmp-real-manual-auto-faithful.json \
  --output .tmp-context-leaf-proposals.json
```

Archived dataset mode is discovery-only because saved evaluator review contexts
may contain transformed neighboring slots. Creator-fold promotion proposals
require a dataset marked `mode: faithful`, `validation: faithful-only`, and
`discoveryOnly: false`; archived datasets and direct report mode still emit
discovery diagnostics.

## Caption corpus acquisition

Put creator channels or playlists in a config shaped like
`tools/paired-caption-channels.json`. Prefer profanity-rich conversational
creators, include canonical `channelId` values when known, and give each run a
descriptive report. Run one downloader at a time: reports and the global
checked-video ledger are locked, and the ledger deduplicates video IDs per
acquisition mode. `--pair-target`, `--max-check`, and `--new-slot-cap` apply per
configured creator.

```json
{
  "channels": [{
    "name": "Creator name",
    "channelId": "UC...",
    "sources": ["https://www.youtube.com/@handle/videos"]
  }]
}
```

For CSV-derived acquisition, run both explicit caption lanes by default:
retain real `manual-auto` pairs where available, and separately collect
uncensored automatic captions for synthetic rule-discovery pairs. A
manual-only run is an exception for a bounded manual evidence pilot, not the
default CSV preference.

Real `manual-auto` pairs need a censored automatic English track and a separate
human English track with usable time-local ground truth:

```sh
node tools/download-paired-captions.js \
  --config tools/paired-caption-channels.json \
  --report corpus/generated/manual-auto-next-report.json \
  --manual-auto-only true --audio-target 0 \
  --pair-target 12 --new-slot-cap 5000 \
  --list-limit 200 --sample-per-channel 30 \
  --max-check 30 --skip-after-clean 12 --jobs 3
```

Uncensored-auto-derived synthetic pairs require one uncensored automatic
English track containing an `ALLOWED_WORDS` entry. The downloader saves the
original as exact ground truth and creates a same-timeline censored copy
locally. These are `synthetic`, not real `auto-auto`, and stay in a separate
evaluation tier:

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
It must remain a separate acquisition pass/report from `manual-auto`; its
locally generated censored side does not become manual ground truth. After a
vocabulary change, rescan selected creators with
`--channels Name[,Name] --revisit`; otherwise the global ledger skips previous
clean negatives. Reusing the same config and report resumes unfinished work; a
new report starts an acquisition lane but still respects the global ledger.

For a small query-driven manual-auto pilot, use
`tools/caption-growth-manual-context-queries.json`; `captionOnly` keeps audio
off:

```sh
node tools/download-paired-captions.js \
  --config tools/caption-growth-manual-context-queries.json \
  --report corpus/generated/manual-context-query-report.json \
  --manual-auto-only true --audio-target 0 --pair-target 1 \
  --new-slot-cap 2000 --list-limit 12 --sample-per-channel 12 --max-check 12 \
  --skip-after-clean 6 --jobs 1 --retries 4 --retry-delay 30 --request-sleep 2
```

This lane uses named search/direct-hit queues rather than broad feeds or audio.
Its report and checked-video ledger are atomic and locked, so interruptions can
resume safely. After at least 50 acquired slots,
`tools/post-acquisition-refresh.js` atomically rebuilds the faithful dataset,
current-rule audit, and creator-fold proposal report without reprocessing
unchanged inputs.

Prospective creator research is split by caption source:

- `tools/caption-prospects-uncensored-auto.json` contains prospective creators
  with sampled literal, non-masked swear forms in English automatic/ASR captions.
- `tools/caption-prospects-manual.json` contains a strict list where the sampled
  swear appears in an observed English manual subtitle track, plus a marked
  lower-confidence track-availability section.

These are acquisition leads, not channel-wide guarantees. Each entry records an
evidence video, observed forms, caption source, and provenance; existing
paired/provenance creators and metadata-only or masked-only leads are excluded.
For `auto-auto`, require two distinct automatic English tracks with an exact
same-timeline replacement; attempt it explicitly with `--auto-auto-only true`
and never merge it with synthetic pairs.

After every acquisition, stop or freeze writers and audit provenance before
evaluating:

```sh
node tools/audit-caption-corpus.js \
  --pair-class manual-auto,auto-auto,synthetic \
  --output corpus/generated/caption-corpus-audit.json
```

### Interactive rule review

Run `npm run rules:review` and open `http://127.0.0.1:8767`.
The default view is one rule, at most three short examples, and **Looks right**,
**Wrong**, **Needs work**, or **Skip**. Judgments advance to the next unreviewed
rule; Skip is session-only. **Previous rule** starts with saved judgments in review
order and also tracks rules visited or skipped in the current page, regardless of
filters. You can save a corrected judgment; going back alone does not change it.
Reloading restores saved judgments, but not session-only skips. Keyboard: A=looks right, R=wrong, N=too broad,
G=too narrow, S=skip, E=edit, Ctrl/Cmd+Enter=save note/edit. Letter shortcuts do
not fire while typing, dialogs are open, or keys repeat. Patterns with two or
more wildcards are hidden by default; enable them explicitly in Filters.
Filters and detailed evidence/editing tools are collapsed by default. Counterexamples take priority in the small example sample.
You need not manually audit the entire corpus: reviews guide subsequent automated
validation rather than certifying a rule's accuracy.
The local UI loads the actual discovery candidates, with filters for target,
caption tier and review status. Inspect positives, counterexamples and unknowns,
including source timestamps, provenance and current-rule predictions. The
Evidence tier selector lets you check the candidate tier, the other tier, or both.
Miner support/precision and raw matching-example counts are shown separately.

You can accept for validation, reject, request generalization or narrowing,
edit a suggested pattern, add notes, or create a custom rule. Preview uses literal
case-insensitive tokens, one `[word]` target (or a single `[__]`), and `*` for
one surrounding token, up to eight tokens on either side. It is a diagnostic
context matcher, not runtime rule execution or held-out validation.

Reviews append to `corpus/rules/rule-reviews.jsonl`; they survive restarts and
are marked stale when their source evidence changes. Existing views remain
readable during acquisition refreshes, but saving requires a current revision.
**Accept does not deploy a rule or edit runtime files.** Suggestions and accepted
reviews still require the benchmark/evidence gates above. `--port`, `--dataset`,
`--leads`, and `--output` allow isolated review sessions. Keep this server local.

### Automatic discovery refresh

The disposable discovery refresh retains only `paired-saved` pairs from the
usual acquisition reports plus saved reports in
`tmp/channel-research/agent-downloads/` and its `state/` directory (and a
root `state/` directory when present). `--report FILE` may be repeated to add
explicit sources. Reports and fixture files are snapshotted around reads;
stable saved pairs from active runs are included as incomplete discovery evidence.
If a previously indexed source becomes unreadable, publication is deferred rather
than replacing the last valid outputs. Originals remain untouched: this is not canonical promotion or
validation.

```sh
npm run corpus:refresh
# Keep polling for newly saved pairs (one refresh at a time):
npm run corpus:watch
# Focus on a word without dropping competing labels from the analysis:
node tools/mine-context-leaves.js --dataset corpus/generated/caption-discovery.json \
  --word fucked --window 4,4 --output tmp/fucked-discovery-leads.json
```

The default outputs are `corpus/generated/caption-discovery.json` and
`corpus/generated/caption-discovery-leads.json`, with the small fingerprint
state file `corpus/generated/caption-discovery-refresh-state.json` beside them.
The watcher polls every five minutes; restart it after changing tooling or rules.
Discovery features ignore speaker arrows (`>>`), bracketed non-speech cues
(such as `[music]` or `[laughing]`), music notes and formatting tags. Original
review contexts, censor markers, target offsets and punctuation are preserved;
annotation text must not become a lexical rule condition. The review UI uses
the same feature extraction as the miner.
Automatic mining uses a 4,4-token window, sparse one/two-feature patterns, and
all target-centered contiguous phrases of up to eight surrounding tokens
(`--phrase-words 8`; independent of sparse `--max-depth`). It emits **all**
passing candidates (`--limit 0`), including a legitimate empty result, rather
than a fixed top-100 queue. Overall and marginal precision, marginal support,
and named target-supporting creator gates are enforced before precision-first
ranking. Competing/unknown labels remain in the denominators. Each tier includes
aggregate rejection counts and a bounded sample of rejected-pattern evidence;
passing candidates are never capped by that sampling. Counterexample row IDs
refer back to the discovery dataset rather than duplicating raw captions.
Passing patterns are also checked against the other caption tier: sufficient
contradictory support rejects them, while absent support is explicitly marked
unsupported. Manual-auto and synthetic counts remain separate, never pooled as
independent human evidence. These are in-sample screens, not held-out validation.

For reviewed exclusions, pass `--exclude tmp/rejected-patterns.json` to the miner;
the file is an array of exact candidate IDs (or `{ "keys": [...] }`). Excluding
a broad pattern does not exclude its narrower refinements or remove any evidence.
A previously failing pattern is reconsidered when new data arrives; automatic
threshold failures are not permanent blacklists. Use `--word` to focus output
without dropping competing words from the search population.
Contexts use the union of the target sentence and four words before/after the
target, capped at 120 words; when
punctuation is uncertain the bounded word-window fallback is marked. The
compact index keeps manual-auto and synthetic labels in separate tiers and
retains unknown/conflict labels as discovery evidence rather than ground truth.
This is research discovery, not validation; do not use its leads as runtime
rules without the existing evidence gates. The default retention policy is
paired-saved acquisition evidence only, with no raw-caption rewriting and no
canonical replacement.

Check per-channel statuses before treating a run as exhausted. DNS failures,
empty listings, rate limits, and other transient failures are not negative
evidence. Keep `manual-auto`, `auto-auto`, and `synthetic` metrics separate,
cap prolific creators with `--new-slot-cap`, and use `--sample-per-channel` to
spread checks across a creator's catalog.
