# Session handoff — 2026-10-02

Current state only; history is in git (`git log -p docs/SESSION_HANDOFF.md`) and the
pre-09-24 archive `.tmp-archive/docs-20260924/SESSION_HANDOFF.md`. Preserve `tmp/`,
`corpus/`, `test-fixtures/`, `logs/` and `.tmp-archive/` (all gitignored).

## Restart here

- **1.6.1 is committed (`release: 1.6.1`), not tagged or submitted.** 1.6.0 is live
  on all stores (`v1.6.0`). 10-04 on AC: `npm run test:release` passed on the 1.6.1
  build (web-ext lint 0/0, archive replay unchanged). Native headless Firefox
  whisper-only an5 to 80 s: 17 decisions, 0 late, min lead 19.6 s; both adjacent-blank
  captions showed distinct words ("fucking fuck you", "shit fuck she's here").
  Chromium whisper-first two-tab check (`tmp/release-validation/two-tab-isolation.cjs`,
  logs `161-{baseline,two-tab}.log`): an5 alone vs an5 with 2z8 playing concurrently;
  every window with the same start/tokens gave identical words, the only differences
  came from shifted windows (token 0 skipped as passed in the baseline; token 20
  asshole/assholes in a 2:44 vs 2:47 window); 0 late/errors in both tabs, peak 3.1 GB.
  Remaining: tag `v1.6.1`, submit `dist/*-1.6.1.zip`.
- **Held-out test set acquisition running (started 10-04)** in `tmp/heldout-20261004/`
  (`PLAN.md` = loosened admission rules; replaces the blocked 10-01 untouched lane). Roster
  frozen before any download: 22 creators (`roster.json`, sha256 in `roster.sha256`), all
  absent from 2,472 development channel IDs (`dev-channels.txt`), each with manual+auto
  English tracks on >=1 of 4 recent uploads (`prescreen-*.jsonl`, metadata only). Isolated
  root `workspace/` (git archive of `67d6beb`, hashes `code-hashes.txt`); separate
  manual-auto and synthetic-auto lanes, 50 slots/creator cap, rotating worker-only VPN via
  `workspace/tools/supervise-caption-vpn.py workspace/tmp/heldout-supervisor.json`; logs
  `workspace/logs/heldout-*.log`; isolated corpus watch. Never open per-slot captions or
  errors from this set; score aggregates once per release. 60 candidate handles did not
  resolve (fix and screen as a dated roster addendum if yield is short).
- **10-04 round 1 result (test set):** manual-auto 441 checked / 56 pairs / 408 slots (9 of
  22 creators yield; 13 had no manual subs); synthetic 403 / 15 / 64. **Round 2 running:**
  test caps raised to 150 slots / 150 checks per creator (same frozen roster), plus a
  development lane `tmp/acquisition-20261004/` (40 most productive development creators,
  300-slot cap, ledger seeded with 21,828 checked videos; user lifted "new creators only"
  for development). Separate supervisors with disjoint VPN profile pools, one tunnel each,
  `maxWorkers` 1 (manual-auto first, then synthetic). Promote the development report to
  `corpus/generated/` only when complete.
- **Audio queue:** `tmp/heldout-20261004/after-captions.sh` (log `after-captions.log`) waits for
  all four caption reports, stops their supervisors/watches, promotes the development
  reports as `corpus/generated/caption-growth-dev-round3-*-20261004-report.json`, then fetches
  windowed audio (test set into `workspace/test-fixtures/audio`, then 50 round-robin
  development videos). The workspace's frozen evaluator predates section support: score
  the test set with the current `tools/evaluate-whisper-only.js` (runtime `src/` unchanged).
- `gh`: sessions started before 09-26 inherit a stale `GITHUB_TOKEN`; use
  `env -u GITHUB_TOKEN gh …` there.

## Standing rules

- Acquisition: VPN only inside worker netns (max two tunnels, never host-wide); no
  duplicate writers; don't interrupt workers or delete supervisor flocks; promote only
  complete reports to `corpus/generated/`; new creators only.
- Evidence tiers stay separate (manual-auto, synthetic, auto-auto). Synthetic pairs and
  Filmot snippets never justify a rule alone. Rule gates: `docs/RULES.md`.
- Deepgram output is triage only — it picks clips for human review; never ground
  truth, never used to score or train models (ToS §2.4.9). Key:
  `~/.config/deepgram/api-key` (600); pass via `DEEPGRAM_API_KEY="$(cat …)"`, never
  write it into repo files or logs.
- The extension stays local-only (no online ASR). Public repo keeps `tools/` and docs;
  corpus, fixtures and audio stay private (gitignored).
- On battery: no builds, full test runs, model inference or corpus mining.

## Live processes (detached; recheck with `ps`, PIDs rotate)

- **Round 2 synthetic completed on 10-02**: workers/watcher stopped; same
  report/ledger, worker-only VPN. Provenance audited, 7 pairs / 31 slots promoted
  to `corpus/generated/caption-growth-synthetic-round2-20261001-report.json`.
  Discovery refreshed: 32,764 rows / 267 creators, 0 promotion proposals.
  Historical 10-01 runs (worker-only namespace `uncensored-vpn-us-free-137`,
  removed afterwards): pilot `tmp/overnight/acquisition/` (manual 2 pairs/6 slots,
  synthetic 2/39, synthetic-diversity 1/2) and round 2 `tmp/acquisition-20261001/`
  (channel feeds; `launch.sh`, `run-after-pilot.sh`). Round 2 manual-auto: 6 creators,
  80 checks, 7 pairs/19 slots (Qxir 5, Rahul Subramanian 2). Round 2 synthetic-auto
  (16 creators) originally hit its 180 min cap at LoadingReadyRun; 10-02 resume
  completed the queue, still Funny Or Die 6 + Medlife Crisis 1. Science/standup
  feeds yielded nothing; transient failures are not negative evidence.
  Promoted complete reports: `corpus/generated/caption-growth-{manual-pilot,
  synthetic-pilot,synthetic-diversity-pilot,manual-round2}-20261001-report.json`;
  `corpus:refresh` → 32,733 rows, 0 promotion proposals.
- Grouped review UI may still be on http://127.0.0.1:8769/ (it writes
  `tmp/deepgram-frozen-grouped-review.json`, which is complete); stop it unless
  intentionally correcting labels.

## How the 1.6.0 engine works

- Popup slider `mode`: off / rules / rules-first (default) / whisper-first / whisper.
  `content.js` maps it to `rulesEnabled/whisperEnabled/whisperFirst`; old two-switch
  settings migrate (both on → rules-first). Rules first skips Whisper for unambiguous
  rule fills; Whisper first scores every slot and audio replaces rule fills.
- Whisper candidate scoring (`src/whisper-local.js`): one 30 s window starting 3 s
  before the next *upcoming* slot covers every pending slot inside it; each allowed
  word is teacher-forced after the caption words since the window start (earlier blanks
  in that window are replaced by Whisper's own decision for them, else dropped; a blank
  directly before another blank gets no next word); fill only if
  log P ≥ −4; choose form by log P(word + next caption word). Step the cached decoder
  one token at a time (multi-token steps have no causal mask and inflate scores).
  Passed slots are skipped and their audio released. Debug log
  `whisper resolved "…" lead Ns` = seconds ready before display.
- Evaluator (`tools/evaluate-whisper-only.js`) uses the same scorer and windowing;
  modes rules-only / whisper-only / rules-first / rules+whisper (= Whisper first).

## Results

| Set | Rules only | Rules first | Whisper first | Whisper only |
| --- | --- | --- | --- | --- |
| Dense dev (24 videos, gate tuned here) | 95.5% / 52.1% | 95.0% / 89.8% | 96.0% / 90.8% | 96.3% / 87.8% |
| Frozen 09-20 (154 videos, not tuned) | 81.1% / 37.3% | 87.3% / 83.1% | 94.5% / 89.9% | 95.0% / 88.3% |

Precision / coverage. Old engine on the frozen set: Whisper only 93.05/77.57, hybrid
86.08/76.70. Popup shows the frozen-set figures ("Up to …"). Reports:
`corpus/generated/dense-audio-v3-*.json` (imported to `docs/evaluation-metrics.json`),
`tmp/frozen-v3-*.json` (diagnostic; the frozen set was inspected before, so not a
certified held-out split). Rule precision on new creators by tier: exact 78.6%, frame
86.0%, productive 86.9%, fallback 61.4% — no tier can skip Whisper cheaply.

Browser (09-25/26): Chromium audio modes — 0 late words, 24–70 s lead, ~2.1–2.5 GB for
the whole browser, flat over 40 min. User's Firefox: shared windows and seek recovery
fine (29 s lead after seeking). Caption-patch check per mode (Chromium, 26 slots):
off 0 filled, rules 9, rules-first 10, whisper-first 9, whisper 0 — as designed.

## Human labels (applied 10-01)

- Frozen grouped review `tmp/deepgram-frozen-grouped-review.json` is complete: 345
  swear, 1 skip (includes the original 249 of `tmp/deepgram-frozen-review.json`).
  Do not ask the user to relabel.
- Human swear labels are now `expectedByToken` overrides: dense in
  `tools/dense-paired-audio-fixtures.json` (746 slots / 24 fixtures, from
  `tmp/audio-golden.json`, `tmp/deepgram-audio-review.json`,
  `tmp/deepgram-disagreement-review.json`; audio identity checked; one conflict,
  `-aROK4boN5c:12` fucking vs fuck, left out); frozen in
  `tmp/heldout/heldout-manifest-labeled.json` (345 slots / 56 fixtures; original
  frozen manifest untouched). Script and base-vs-labeled reports (cached transcripts
  from a HEAD worktree, since the transcript fingerprint hashes `whisper-local.js`):
  `tmp/label-overrides-20261001/`. No-swear/wrong-fragment labels can't be expressed
  as overrides and were not applied.
- Effect (precision/coverage, base → labeled): frozen whisper-only 95.0/88.3 →
  96.1/89.3, rules+whisper 94.5/89.9 → 95.6/91.0, rules-first 87.3/83.1 → 88.3/84.1,
  rules-only 81.0/37.3 → 81.5/37.5; dense changes ≤0.3 pt. Frozen labels were
  selected from caption/Deepgram disagreements, so gains partly favour Whisper.
  Popup figures and `docs/evaluation-metrics.json` are NOT updated.
- Error analysis (frozen grouped, Whisper first choice 217 correct / 95 wrong / 33
  abstain): multi-blank caption events drive errors. Non-first slots are wrong 49/105
  vs first slots 13/92; 42/62 multi-slot errors predict a sibling slot's true word
  (adjacent blanks share the same text prefix). 39/95 errors are same-family
  inflections (fuck↔fucking/fucker, motherfucker↔motherfucking).

## 10-02 improvement pass (uncommitted)

- Preserved pre-existing review UI/tooling and Whisper-test edits. Compiler
  `.map(regexLiteral)` callback fixed; wildcard regex/trie cannot consume another
  blank. Focused regressions pass; structural hash intentionally updated after
  replay. Global terminal-rule reorder **rejected**: 20 archive regressions vs
  2 improvements. Authored priority preserved; `which is [__]` shadowing remains
  unresolved pending full-context evidence. `tmp/release-validation/REVIEW.md`
  records the rejected variant, not final runtime behavior.
- Final dense v5 reports reuse verified v4 mode-specific cached audio decisions,
  with no inference; all four metrics unchanged. Metrics provenance/README
  regenerated, stale hybrid test count corrected. `npm run test:release` passed:
  unit/Python tests, both ZIPs, Firefox lint (0 errors/warnings), 223,478-slot
  archive replay (unchanged 89.36% precision / 39.02% correct coverage).
- Browser tests **always** stay on `special:uncensored-smoke`; Firefox headless,
  never a normal-workspace fallback. Five Chromium modes/direct navigation passed
  (0 late audio words/errors). Runner 61883 resumed only remaining checks:
  WebDriver Firefox stalled; two-tab playback/identity isolation passed (not
  caption/cache isolation). 44-minute Chromium seek/memory run **passed**: whole
  browser 2,673→2,590 MB (peak 2,814), 0 late words/errors, post-seek lead ≥34.1s.
  Logs: `tmp/release-validation/browser-resume-{status.txt,long.log}`.
  Firefox subsequently **passed** using genuine non-WebDriver temporary-extension
  instrumentation (`tmp/firefox-genuine/run.sh`): stock Firefox/156 UA, webdriver
  false, actual runtime source hashes unchanged, Whisper-first, 20→45 seek,
  playback to 230.6s; 22 audio-resolved words, 0 late (min lead 1.4s, median 47.9s).
  Visible restored caption observed at 56.4s. Video muted/volume 0, isolated muted
  null sink, user's Firefox untouched. `telemetry.jsonl` records evidence.
  Failures involved delayed cookie consent and the WebDriver setup (even without
  extension); do not infer Firefox itself cannot play. Diagnostic fixture syntax
  and host-permission mistakes corrected. No UA/automation getter override in
  successful test. Empty Chromium DOM still is not visible-fill proof; explicit
  multi-blank and two-tab caption/cache isolation checks remain pending.
  No version bump/tag/submission. Caption-patch log now correctly attributes fills
  to rules **or cached audio**, explaining Whisper-only's two restored slots.
- Word forms: eight disagreement-enriched development slots with cached scores
  favor existing next-word rank (6/8 exact) over candidate-only (1/8) and approximate
  token normalization (4/8). **No scorer change** justified; not a benchmark.
  `tmp/word-form-experiment/report.md`. New diagnostic CLI/test prepares 15
  contested labels: `tmp/label-audit/relisten-diagnostic.json`; human re-listening
  remains required. Never automatically relabel from votes.
- Untouched benchmark isolated in `tmp/untouched-benchmark-20261001/workspace`.
  Metadata-only exclusions: 1,835 channel IDs, 100 handles, 311 unresolved records;
  eight unadmitted candidates, accents unknown. Six canonical IDs resolved;
  official ownership links verified for Olga/Sindhu/Urzila, but Urzila overlaps
  historical Funny Or Die speaker metadata and is held/excluded. See
  `ADMISSION-UPDATE.md`: candidate-specific overlap audit, not a blanket demand
  to resolve all unrelated historical identities. `SETUP.md`/`PLAN.md` document
  speaker/audio-accent gates and empty separate manual-auto/synthetic configs.
  No new held-out captions/labels acquired or inspected; no test-score claim.
  Code snapshot is preparatory, not an admitted final manifest.
  `identity-accent-review/QUEUE.md` has seven human-review URLs; Fern/Olga 45-second
  clips validated, remaining downloads hit authentication. All research video IDs
  must be excluded from final sampling; accents/speaker confirmations still pending.
- Acquisition complete/audited/promoted; no vocabulary or evidence-derived rules
  admitted. New faithful validation: 2,928 eligible rows / 41 creators / 50 fixtures
  (`tmp/improvement-validation/compact-summary.json`). Queued `son of a [__]`
  (8 bitch / 1 fuck) and `[__] car` (3 fucking / 1 fuck) have counterexamples;
  these phrase counts alone do not establish selector precision or retirement.
  No promotion without complete selector/wider validation; synthetic stays separate.

## Next steps (in order; see current pass above)

1. **Adjacent-blank fix landed (10-01, unreleased)**: sequential prefix in
   `scoreSlots`. Frozen labeled set, before → after precision/coverage: whisper-only
   96.1/89.3 → 97.3/90.8, rules+whisper 95.6/91.0 → 96.8/92.2, rules-first 88.2/83.9 →
   89.3/85.1; later slots of multi-blank events 81.3 → 96.3% precision; single slots
   flat. Dense (used to choose the variant) +0.6–0.8 pt precision. Frozen gains are
   optimistic (its labels came from the analysis that motivated the fix). Details
   `tmp/adjacent-blanks/REPORT.md`. Remaining error class: same-family forms
   (fuck/fucking/fucker, motherfucker/motherfucking).
2. **1.6.1**: all release checks passed (see Restart here); tag and submit.
3. **Label audit** (`tmp/label-audit/REPORT.md`): 15/1,092 human labels contested,
   mostly inflection slips (motherfucking vs motherfucker, plurals); ~6 likely mishears to re-listen.
   Detectable label noise ~1–2%, so popup figures are ±1–2 pt.
4. **Frozen set status**: the frozen set has now been used for error
   analysis; acquire a genuinely untouched, accent-diverse creator split for scoring.
5. **Acquisition**: resume/complete round 2 synthetic; manual-auto yield is best from
   Qxir-like creators (story/commentary with manual subs); drop science feeds.
6. Rules: battery-safe sanity audit in `tmp/rule-sanity/REPORT.md` (all 523 review
   candidates, 3,809 runtime selectors). Queue: 189 multi-wildcard patterns, 438
   synthetic leads; no deployed literal has multiple wildcards. Small-input check
   confirmed `[__] and [__] so → shit so` (wildcard consumes another blank and
   replacement deletes visible text). Also broad `which is [fucking]` shadows
   terminal `which is [bullshit]$`; static compiler audit found `.map(regexLiteral)`
   passing index as punctuation policy. No runtime edits; focused regressions/fixes
   needed before release. Five selector removals rejected on wider replay (4 wrong introduced); none
   deployed. `son of a [__] → bitch` and `[__] car → fucking` need complete eligible
   evidence. Details `tmp/overnight/rules/pass2/REPORT.md`.
7. Vocabulary leads `fuckheads`, `chickenshit`: not admitted; need repeated
   creator-diverse complete manual-auto evidence.
8. Performance: 4-thread WASM ~6.5 s vs ~12.2 s (one isolated-page sample,
   `tmp/overnight/infra/browser-wasm-parity.mjs`); needs COOP/COEP and real-extension
   validation before any threading change.
9. Known limitation (user accepted): switching to Off/Whisper-only keeps rule words
   already baked into loaded captions until the captions reload.

## Test harness notes (`tools/browser-smoke.js`)

- `--workspace` confines visible Chromium to `special:uncensored-smoke`; visible
  launches without it are refused (headless is allowed). Firefox now uses native
  headless temporary-extension telemetry, not BiDi/WebDriver. Use `npm run test:firefox`;
  single URL / `--initial-only` only. Detailed commands: `docs/DEVELOPMENT.md`.
- Strict native Firefox validates actual progress/seek, mode/model readiness, raw
  caption blanks structurally replaced in visible DOM, and post-seek audio decisions.
  Off/rules/Whisper-first/Whisper-only live checks passed. Pure Whisper run resolved
  14 words with 3 late (min lead −5.5s), honestly reported as timing diagnostics.
  Final stricter Whisper-first check: 14 resolved, 3 late (min lead −3.7s);
  automatic-English identity, viewport-visible raw-slot structural match, sustained
  progress, post-seek decision, source hashes and silence gates passed. Timing
  and functionality are separate; no zero-lateness claim. New assertion/cleanup
  tests pass (41), full release tests pass. Latest report:
  `tmp/firefox-smoke-verified/summary.json`. Earlier runs:
  `tmp/firefox-smoke-{integration-2,rules,whisper-final}/summary.json`,
  `tmp/firefox-smoke-off-final-1790980071/summary.json`.
- Shared persistent flock prevents overlapping runs. Cleanup only owns its process
  groups, profiles and unique muted null sink; no broad pkill or global profile deletion.
  Artifacts retain logs, raw telemetry, runtime hashes, silence state and failure snapshots.
  Stale builds and reused artifact directories are refused. Chromium DOM remains empty
  in automation; its zero-line reports do not prove visible restoration.
- Pick auto-caption-only videos for playback tests (dense/frozen videos have manual
  subtitles, which YouTube may show instead). Good: `an5iFYcjWUM` (short),
  `2z8vHPOW2tk` (115 min).

## Key artifacts

- Deepgram: dense pass `tmp/deepgram-dense-all.json`; frozen pass
  `tmp/deepgram-frozen-all.json`; negatives `tmp/deepgram-negatives.json` (0–1 false
  insertions / 276); human comparisons `tmp/deepgram-human-comparison.json`. Script
  `tmp/deepgram-dense-all.js` (env `REPORT`, `ALL`, `QUEUE`, `ANY_PAIR`).
- Human labels: `tmp/audio-golden.json`, `tmp/deepgram-audio-review.json`,
  `tmp/deepgram-disagreement-review.json`, `tmp/deepgram-frozen-grouped-review.json`.
  Grouped review UI command: see `docs/DEVELOPMENT.md` (`--group-captions`).
- Prototype/experiment scripts (ignored): `tmp/candidate-scoring*.js`,
  `tmp/shared-window-experiment.js`, `tmp/current-whisper-negatives.js`,
  `tmp/frozen-eval-chain.sh`.
- Acquisition configs moved to `corpus/acquisition-configs/`; VPN helpers
  `tmp/isolated-vpn-netns.sh`, `tmp/proton-profile-research/` (never print credentials).
