# Session handoff — 2026-09-26

Current state only; history is in git (`git log -p docs/SESSION_HANDOFF.md`) and the
pre-09-24 archive `.tmp-archive/docs-20260924/SESSION_HANDOFF.md`. Preserve `tmp/`,
`corpus/`, `test-fixtures/`, `logs/` and `.tmp-archive/` (all gitignored).

## Restart here

- **1.6.0 is committed and pushed** (`main` = `5e8bb6e` + this doc; CI green). Not
  tagged. Store ZIPs: `dist/uncensored-youtube-{chromium,firefox}-1.6.0.zip`; store
  images (1280×800) and raw popup captures: `dist/store/`. User is submitting to the
  stores; tag with `git tag v1.6.0 && git push origin v1.6.0` once live.
- `origin/main` had an unpulled 1.5.3 commit (09-10); it was merged (tree unchanged,
  1.5.3 was an earlier snapshot of this work). Pull before working elsewhere.
- `gh`: a stale `GITHUB_TOKEN` in `~/.free-coding-models.env` overrode the saved login;
  line 11 is now commented out. Sessions started before 09-26 still inherit it — use
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

- `tools/supervise-caption-vpn.py tmp/vpn-caption-check/supervisor-config.json` with a
  manual-auto and a synthetic-auto downloader; waiting launchers
  `tmp/channel-research/launch-recycle-when-ready.sh` → `audio-tier/launch-audio-tier-when-ready.sh`
  (300 censored-auto videos' audio).
- `npm run corpus:watch` (stop on battery).
- UIs: rule review :8767; audio review :8765 (`tmp/deepgram-audio-review.json`);
  dense disagreement review :8766 (`tmp/deepgram-disagreement-review.json`, labelled).

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

## Next steps (in order)

1. **Store release**: submit the 1.6.0 ZIPs + `dist/store/` images; tag `v1.6.0`.
   The overview image shows "fuck" in an illustrative caption — swap for a real
   screenshot or a milder example if a reviewer objects.
2. **Label the frozen-set Deepgram queue (269 useful items)**: queue
   `tmp/deepgram-frozen-disagreements.json` (1,234 items, ordered by tier; only the first
   269 — caption conflicts with Deepgram, 151 of them with Whisper agreeing — are worth
   labelling). Start a UI on a free port, e.g.
   `node tools/annotate-audio.js --mode deepgram-review --whisper-report tmp/frozen-v3-whisper.json --deepgram-triage tmp/deepgram-frozen-disagreements.json --output tmp/deepgram-frozen-review.json --before 5 --after 5 --port 8768`.
   Label what was actually said; mark misaligned fragments as wrong-audio, not guesses.
3. **Apply human labels as corrections**: the dense 8766 labels found manual captions
   wrong on 13/89 contested slots; add them (and step 2's) as `expectedByToken`
   overrides in the fixture manifests, then re-run the dense/frozen reports.
4. **Rules generalise poorly** (81% on new creators). Before narrowing rules with the
   frozen set, decide whether it stays an evaluation set; ideally acquire a genuinely
   untouched, frozen creator split (accent-diverse) first and keep it for scoring only.
5. **Performance**: multi-threaded WASM via cross-origin isolation (COOP/COEP) —
   measure encoder speed and memory in both browsers. Slurs have only 8 labelled slots;
   revisit the gate for them once step 2/3 adds labels.
6. Known limitation (user accepted): switching to Off/Whisper-only keeps rule words
   already baked into loaded captions until the captions reload.
7. Acquisition continues automatically; after the audio tier lands, regenerate reports
   on identical slots and consider it for the untouched split in step 4.

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
  `tmp/deepgram-disagreement-review.json`.
- Prototype/experiment scripts (ignored): `tmp/candidate-scoring*.js`,
  `tmp/shared-window-experiment.js`, `tmp/current-whisper-negatives.js`,
  `tmp/frozen-eval-chain.sh`.
- Acquisition configs moved to `corpus/acquisition-configs/`; VPN helpers
  `tmp/isolated-vpn-netns.sh`, `tmp/proton-profile-research/` (never print credentials).
