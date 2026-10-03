# Uncensored

Uncensored restores words hidden as `[__]` in YouTube captions, primarily for
deaf and hard-of-hearing viewers. Audio, captions, and inference stay local.

## Modes

The popup slider has five stops (default: **Rules first**):

| Mode | Behavior | CPU load |
| --- | --- | --- |
| Off | Leave captions unchanged. | None |
| Rules only | Fill from caption context; uncertain slots abstain. | Minimal |
| Rules first | Rules fill what they can; Whisper scores only unfilled or ambiguous slots. | Moderate |
| Whisper first | Rules fill instantly; Whisper checks every slot and replaces the fill. | High |
| Whisper only | Local Whisper only. | High |

Settings from versions with two switches map to the matching mode (both on → Rules first).
The evaluator's `rules+whisper` mode is "Whisper first".

<!-- evaluation-metrics:start -->
### Current evaluation metrics

The canonical snapshot is [`docs/evaluation-metrics.json`](docs/evaluation-metrics.json), as of 2026-10-02.

| Tier | Status | Scored slots | Precision | Coverage |
| --- | --- | ---: | ---: | ---: |
| Manual-auto | development | 26,429 | 89.60% | 44.81% |
| Synthetic | development | 149,135 | 89.94% | 40.16% |
| Auto-auto | development | 10 | 100.00% | 80.00% |
| Historical validation (unverified) | diagnostic | 9 | 100.00% | 11.11% |
| Held-out test | held-out-test | — | — | — |
| Any-candidate oracle | diagnostic | — | 90.81% | 49.83% |
| Synthetic Filmot gap sample, rules-only | diagnostic (stale/superseded) | 110 | 85.37% | 31.82% |
| Manual Filmot wave, rules-only | diagnostic (stale/superseded) | 275 | 69.72% | 27.64% |
| Dense audio set, rules only | diagnostic | 2,493 | 95.18% | 49.10% |
| Dense audio set, Whisper | diagnostic | 2,449 | 96.94% | 80.16% |
| Dense audio set, Whisper first | diagnostic | 2,449 | 96.55% | 86.85% |
| Dense audio set, rules first (default) | diagnostic | 2,449 | 95.41% | 84.89% |

Development rows are in-sample.
No held-out test score is available.
Rows marked stale/superseded are historical diagnostics, not current-code benchmark results. Current evaluator fingerprints: rules 3795:39:11g0z2u, aux 8hsabx, engine hof9ii.
<!-- evaluation-metrics:end -->

The later [frozen audio comparison](docs/FROZEN_AUDIO_EXPERIMENT.md) is documented
separately as a historical diagnostic: its reports lack the creator-manifest
provenance required for canonical held-out metrics.

### Evaluation caveats

This is an English, playlist-selected development corpus. Videos qualify only
when separate automatic and manual English captions exist, the automatic track
contains `[__]`, and the manual track supplies a supported swear. It therefore
does not represent YouTube generally or the natural prevalence of censored
captions.

Rules were tuned and measured on this same corpus, so rules-only results are
in-sample development figures rather than held-out estimates. Metrics are
micro-averaged per caption slot, which gives prolific creators more influence.
Evaluator reports also include `summary.creatorMacro` and
`summary.creatorMacroByPairClass`, which weight each identified creator equally.
The archived replay's roughly 223k slots include both labeled and unlabeled
slots; accuracy is computed from labeled slots only, with unlabeled slots
reported separately. Manual caption omissions, paraphrases, and timing
differences can still introduce alignment error.

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
generation. In hybrid mode, deterministic rules provide immediate provisional
fills while full-vocabulary Whisper checks every slot. A Whisper result replaces
the fill; if Whisper abstains, the provisional rule remains for coverage.
Rules-only mode continues to
apply the full deterministic rule set. Decoding and
the model stop when captions contain no censored slots.
Decoded segments are discarded when no pending token needs them.
Transport/inference failures get at most one retry after 250 ms; valid empty
Whisper decisions remain abstentions. Superseded navigation, track, seek, or
mode requests do not retry or apply stale results. A host timeout does not cancel
inference already running in the worker.

The local quantized `whisper-tiny.en` model runs through vendored
Transformers.js and ONNX Runtime Web. No remote code is loaded. Whisper does not
transcribe freely. It encodes one 30 s window starting 3 s before the next
upcoming slot and scores every slot inside it: each allowed word is scored as the
continuation of the caption words spoken since the window start. It fills only
when the best word's log probability is at least -4, and uses the next caption
word to choose among forms such as `fuck`/`fucking`. Upcoming slots are scored
first so words are usually ready before their captions appear.

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
- Measure in-browser Whisper scoring latency and recalibrate its gate on new
  creator-diverse audio labels.
- Re-run the caption audit after vocabulary changes; keep visible automatic
  labels in `NOT_CENSORED_WORDS` and regenerate synthetic fixtures deliberately.
- Follow [`docs/SESSION_HANDOFF.md`](docs/SESSION_HANDOFF.md) for current state and
  next steps; rule evidence gates are in [`docs/RULES.md`](docs/RULES.md).

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

Run tests, both builds, ZIP validation, and the archived corpus regression.
When its ignored local source reports are present, this replays at least 200,000
unique slots; the current inventory is 223,478:

```sh
npm test
```

Before release, also require metric provenance and run pinned Firefox lint:

```sh
npm run test:release
```

A clean checkout skips only the archived replay until those local reports are
restored; its unit test still runs from temporary miniature reports.

The release check validates the canonical metrics snapshot and generated README
table. After an intentional handoff update, regenerate that table with:

```sh
node tools/evaluation-metrics.js --write-readme
```

Optional checks:

```sh
npm test -- --benchmark
npm test -- --browsers --chromium-only --workspace URL [URL...]
npm test -- --all --chromium-only --workspace URL [URL...]
```

The native, headless Firefox smoke checks one URL only (no SPA, pause, or
playlist coverage). It defaults to the an5 video, `whisper-first`, and 90 s:

```sh
npm run test:firefox
# Recommended strict pure-audio check:
npm run test:firefox -- --mode=whisper --rate=1 --seek=20:45 --until=90 \
  --expect=fucking 'https://www.youtube.com/watch?v=an5iFYcjWUM'
```

Expected words are optional except in `rules` mode. See
[Firefox smoke details](docs/DEVELOPMENT.md#native-firefox-smoke) for dependencies,
isolation, evidence, and artifacts. This is a runtime diagnostic, not accuracy
validation of every mode.

Chromium separately covers multiple SPA redirects (requires network and Chromium;
keep `--workspace` or use safe headless execution):

```sh
node tools/browser-smoke.js --chromium-only --workspace --headless --via=search --mode=hybrid \
  'https://www.youtube.com/watch?v=kTeQSzHGWyw' \
  'https://www.youtube.com/watch?v=an5iFYcjWUM' \
  'https://www.youtube.com/watch?v=jNQXAC9IVRw'
```

Both runners accept `off`, `rules`, `rules-first`, `whisper-first`, and `whisper`;
legacy aliases `both-off`, `rules-only`, `hybrid`, and `whisper-only` remain.
Chromium also accepts `--via=search|direct|home`, `--auto-next=N`,
`--until=SECONDS`, `--pause=SECONDS`, and `--verbose`. The navigation-expression
unit test runs without launching browsers.

Specialized corpus acquisition, benchmark evaluation, audio annotation, and
rule-mining workflows live in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Provenance details remain in
[`docs/CAPTION_CORPUS_AUDIT.md`](docs/CAPTION_CORPUS_AUDIT.md); the auxiliary
text-source notes are in
[`docs/OPENSUBTITLES_EXPANDED_AUX.md`](docs/OPENSUBTITLES_EXPANDED_AUX.md) and
[`docs/SBCSAE_CORPUS.md`](docs/SBCSAE_CORPUS.md).

## Build

```sh
./build.sh 1.6.1
```

This creates separate Chromium and Firefox ZIPs in `dist/`. See
[AMO_SOURCE.md](AMO_SOURCE.md) for submission and vendored-runtime notes.
