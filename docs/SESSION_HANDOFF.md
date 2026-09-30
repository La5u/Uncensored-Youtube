# Session handoff — 2026-10-01

Current state only; history is in git (`git log -p docs/SESSION_HANDOFF.md`) and the
pre-09-24 archive `.tmp-archive/docs-20260924/SESSION_HANDOFF.md`. Preserve `tmp/`,
`corpus/`, `test-fixtures/`, `logs/` and `.tmp-archive/` (all gitignored).

## Restart here

- **1.6.0 is live on all stores and tagged `v1.6.0`.** Post-release maintenance is
  committed on `main` (not pushed, not released): SABR reset clears prior-video init
  data; decode dedup no longer blocks replay after PCM eviction and skips obsolete
  queued audio; Whisper tensors are freed on success/failure (Chromium WASM parity
  with 1.6.0 verified, identical decisions and scores); refresh-lock/snapshot fixes;
  Python tests run in the harness; grouped caption review in `annotate-audio.js`.
  `npm run test:release` passed on 10-01. `dist/` ZIPs are maintenance builds labeled
  1.6.0, not the store ZIPs. Candidate for a 1.6.1 after real-extension checks
  (long session memory, Firefox, multiple tabs).
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

- **Acquisition pilot running** (started 10-01): `tmp/overnight/acquisition/launch.sh
  uncensored-vpn-us-free-137 --launch`, log `logs/acquisition-pilot-20261001.log`.
  Runs manual-auto, synthetic-auto, synthetic-diversity lanes sequentially (≤60 min
  each) inside the worker-only namespace `uncensored-vpn-us-free-137` (provisioned with
  `tmp/isolated-vpn-netns.sh setup-one US-FREE-137`; host route stays on wlan0) plus
  its own discovery watcher (`tmp/overnight/acquisition/discovery*.json`). Worker logs
  `tmp/overnight/acquisition/*-worker.log`. When done, clean up with
  `tmp/isolated-vpn-netns.sh cleanup-one US-FREE-137`.
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
  word is teacher-forced after the caption words since the window start; fill only if
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

## Next steps (in order)

1. **Adjacent-blank fix**: for slot k>1 in one caption event, condition on the
   previous slot's decision (sequential prefix) or score the event jointly. Develop on
   the dense set (now labeled); evaluate once on frozen. Earlier scratch try: +2/−2 on
   16 labels — too small to judge.
2. **1.6.1**: after real-extension checks, bump version, rebuild, submit.
3. **Frozen set status** (was step 4): the frozen set has now been used for error
   analysis; acquire a genuinely untouched, accent-diverse creator split for scoring.
4. **Acquisition pilot**: review worker reports when finished; promote only complete
   reports; keep tiers separate. Web pass 2 leads: `tmp/overnight/acquisition/web-pass2/`.
5. Rules: five selector removals rejected on wider replay (4 wrong introduced); none
   deployed. `son of a [__] → bitch` and `[__] car → fucking` need complete eligible
   evidence. Details `tmp/overnight/rules/pass2/REPORT.md`.
6. Vocabulary leads `fuckheads`, `chickenshit`: not admitted; need repeated
   creator-diverse complete manual-auto evidence.
7. Performance: 4-thread WASM ~6.5 s vs ~12.2 s (one isolated-page sample,
   `tmp/overnight/infra/browser-wasm-parity.mjs`); needs COOP/COEP and real-extension
   validation before any threading change.
8. Known limitation (user accepted): switching to Off/Whisper-only keeps rule words
   already baked into loaded captions until the captions reload.

## Test harness notes (`tools/browser-smoke.js`)

- `--workspace` runs Chromium visibly on Hyprland `special:uncensored-smoke` (runtime
  Lua window rule via `hyprctl eval`); Firefox stays headless (it won't play media on a
  hidden workspace). `--mode` takes the five popup modes; `--rate`, `--seek=FROM:TO`,
  `--until`, memory and lead summaries; per-mode caption-patch check.
- Limits: automated YouTube does not render caption DOM (DOM checks can't work);
  Chromium drops some content-script log lines; headless Firefox playback stalls.
- Never run two smoke runs at once: start-up deletes all `/tmp/uncensored-*-smoke-*`
  profiles. Kill leftovers by PID; `pkill -f <pattern>` also kills the shell running it.
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
