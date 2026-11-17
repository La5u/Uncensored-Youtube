# Session handoff — 2026-10-21

Current state only. Replace superseded entries instead of appending; history is in git and
`.tmp-archive/docs-{20260924,20261012}/SESSION_HANDOFF.md`. Preserve `tmp/`, `corpus/`,
`test-fixtures/`, `logs/` and `.tmp-archive/` (all gitignored).

## Acquisition (running)

All caption lanes are complete (dev manual/synthetic r3, synthetic-discovery, manual-auto r4;
heldout manual-auto and synthetic-auto). Promote only complete reports. Only dev audio remains:
since 10-21 it refetches the 362 IDs in `tmp/migration-setup/dev-refetch-ids.txt` (files that
do not cover every window) via one netns, `NL-FREE-211`. **Relaunch it with
`AUDIO_REFETCH=tmp/migration-setup/dev-refetch-ids.txt`; without it the runner exits at once
(dev cap of 1,000 reached).** Throughput 10-21: ~1 video/h, so ETA unknown (days).

- **1.6.2 is tagged (`v1.6.2`) and on `main`, not submitted** (release checks in git history of this file, commit `d50c2f0`). Word-class rules, the acoustic fusion head, the faster encoder and automatic mode are merged for 1.6.3.
- **Direct downloads are network-dependent: wifi `Livebox-D760` is VPN only** (captions and audio).
  Dev captions ran direct 10-12/13 (approved on another network), via
  `python3 tmp/acquisition-20261004/manage.py status|direct|stop|vpn` (allowed in
  `.claude/settings.local.json`); log `tmp/acquisition-20261004/direct.log`. Otherwise
  **captions: VPN only**, worker netns, two tunnels max (Proton account cap). Supervisors rotate routes and recreate namespaces on demand:
  dev `tmp/acquisition-20261004/supervisor.json` (17 routes), heldout
  `tmp/heldout-20261004/workspace/tmp/heldout-supervisor.json` (15 routes, disjoint). 15 of
  the 32 routes were added 10-12 and are unproven until a rotation probes them.
- **Audio:** direct only on approved networks (10-11 approval), else via worker netns; two halves in parallel, logs
  `tmp/migration-setup/audio-now-{heldout,dev}.log`. A windowed video counts as present only
  when every section file exists (matched by start; yt-dlp clamps the last section's end at
  the video end). Heldout audio is complete: 329/329 manual-auto, 67/67 synthetic.
- VPN helper `/usr/local/sbin/uncensored-vpn-netns` (root; profile whitelist, append new
  names at the end because index = interface/table); sudo rules
  `/etc/sudoers.d/uncensored-vpn-workers`. NM profiles: autoconnect off, never-default,
  no peer routes. New Proton certificates come from the user's Firefox session via
  `account.protonvpn.com/api/vpn/v1/certificate`; the user runs the root install.
- Restarting a supervisor does not touch running workers. Never `pkill -f` with a pattern
  that matches your own shell; kill exact PIDs.

**No boot service: relaunch after every reboot** (from repo root, each detached with `setsid … < /dev/null &`):

```
python3 tmp/acquisition-20261004/manage.py vpn   # direct only on an approved network (DIRECT_OK_SSID)
(cd tmp/heldout-20261004/workspace && python3 tools/supervise-caption-vpn.py tmp/heldout-supervisor.json >> logs/heldout-supervisor.log 2>&1)
AUDIO_DIRECT=1 AUDIO_PART=heldout python3 tmp/migration-setup/audio-now.py >> tmp/migration-setup/audio-now-heldout.log 2>&1
AUDIO_PART=dev AUDIO_REFETCH=tmp/migration-setup/dev-refetch-ids.txt python3 tmp/migration-setup/audio-now.py   # + AUDIO_DIRECT=1 only on an approved network; else first: sudo -n /usr/local/sbin/uncensored-vpn-netns setup-one NL-FREE-211 >> tmp/migration-setup/audio-now-dev.log 2>&1
npm run corpus:watch >> logs/corpus-watch-resume.log 2>&1
node tools/refresh-caption-discovery.js --watch 300 --report tmp/acquisition-20261004/state/{manual-auto,manual-auto-r4,synthetic-auto,synthetic-discovery}-report.json --output tmp/acquisition-20261004/discovery.json --mining tmp/acquisition-20261004/discovery-leads.json --state tmp/acquisition-20261004/discovery-refresh-state.json >> tmp/acquisition-20261004/discovery-watch.log 2>&1
(cd tmp/heldout-20261004/workspace && node tools/refresh-caption-discovery.js --watch 300 --report corpus/generated/heldout-{manual-auto,synthetic-auto}-report.json --output corpus/generated/heldout-discovery.json --mining corpus/generated/heldout-discovery-leads.json --state corpus/generated/heldout-discovery-state.json >> logs/heldout-discovery-watch.log 2>&1)
```

(Expand the `{…}` lists into one `--report` flag per file.)

## Held-out test set

`tmp/heldout-20261004/`: frozen roster of 77 creators (`roster.json` + `roster-addendum-1.json`,
sha256 files), isolated `workspace/` root, separate manual-auto/synthetic-auto lanes. Never
open its captions or errors; score aggregates once per release with the current
`tools/evaluate-whisper-only.js`.

## Rules work (uncommitted tooling; runtime unchanged)

- Committed word-class rules (`880c303`) score only ~80% synthetic / ~65% manual-auto on
  unseen creators; wider windows (`tmp/rules-20261010-wider-context/`) were not adopted.
- Miner now has canonical creator identities, SHA-256 creator folds, separate
  first-choice/marginal gates and exports `validateCompiledCandidate` (training-only
  vocabulary, real compiled matches). **`--write` stays disabled** until that is wired into
  CLI candidate-pool selection, with integration regressions and an independent review.
- Diagnostics (not certification): 72 → 8 → 4 stable selectors, all `fucking`
  (`tmp/word-class-train-vocabulary-pool-current/README.md`). Retiring the six effective
  passers would lose 4,174 correct synthetic fills to remove 464 wrong ones: not done.
- Word-form hints: 0 gain on 1,801 dense dev slots (`tmp/word-form-generalization-current/`).
- Metrics: `tests/evaluation-metrics.test.js` passes in a disposable checkout;
  `cIrZX2tQAFI` audio is unavailable (private), audio modes skip its slots.

- Pool wiring done 10-21 (`poolGate`, regression in `tests/mine-word-class-rules.test.js`,
  Sol review: no defects): 36 candidates checked, 12 pass compiled train-only folds, greedy
  keeps 7 (6 `fucking`, 1 `fuck`), 587/620 correct new dev fills, retrospective only
  (`tmp/word-class-pool-validated-20261021/`; 21 min, 1.7 GB RSS). `--write` still disabled
  until integration tests on `main` and the prospective gate.

**Next:**
1. Prospective development validation per `tmp/word-class-prospective-dev-v2/PLAN.md`
   (frozen `frozen-model.json`, refrozen 10-30 after `1d6c0c5` changed `src/rules.js`; the
   v1 freeze in `-current/` aborted on that drift): first build the creator/speaker exclusion union and freeze 12
   novel creators (fewer → stay blocked). New downloads need fresh user approval, after the
   current queues finish, in a new isolated root with separate tier reports.
2. Score that frozen bundle once against the predeclared gates; synthetic primary,
   manual-auto separate; report losses as well as gains.

## Release

1.6.0 is live on all stores. 1.6.1 is committed (`release: 1.6.1`) and passed
`npm run test:release`; still to do: tag `v1.6.1`, submit `dist/*-1.6.1.zip`. The worktree
has other uncommitted tooling/doc edits; review scoped diffs before committing.

## Engine (1.6.x)

- Popup `mode`: off / rules / rules-first (default) / whisper-first / whisper. Rules first
  skips Whisper for unambiguous rule fills; Whisper first scores every slot.
- Whisper (`src/whisper-local.js`): one 30 s window from 3 s before the next upcoming slot;
  each allowed word is teacher-forced after the caption words (earlier blanks use Whisper's
  own decision); fill if log P ≥ −4; form chosen by log P(word + next caption word). Step the
  cached decoder one token at a time (multi-token steps have no causal mask).
- Evaluator `tools/evaluate-whisper-only.js` uses the same scorer and windowing.

Precision / coverage (popup shows the frozen row):

| Set | Rules only | Rules first | Whisper first | Whisper only |
| --- | --- | --- | --- | --- |
| Dense dev (24 videos, tuned here) | 95.5 / 52.1 | 95.0 / 89.8 | 96.0 / 90.8 | 96.3 / 87.8 |
| Frozen 09-20 (154 videos) | 81.1 / 37.3 | 87.3 / 83.1 | 94.5 / 89.9 | 95.0 / 88.3 |

The frozen set has been used for error analysis, so it is not a certified held-out split.
Remaining error classes: same-family forms (fuck/fucking/fucker) and multi-blank events.
Known limitation (user accepted): switching to Off/Whisper-only keeps already-baked rule
words until captions reload.

## Labels and data

- Human labels are complete; do not ask the user to relabel. Applied as `expectedByToken`
  overrides: dense `tools/dense-paired-audio-fixtures.json`, frozen
  `tmp/heldout/heldout-manifest-labeled.json`. Sources: `tmp/audio-golden.json`,
  `tmp/deepgram-*-review.json`.
- Deepgram output is triage only, never ground truth or training data. Key
  `~/.config/deepgram/api-key`; never write it into files or logs.
- Uncensored auto captions are mostly a channel property; channel feeds beat Filmot lists
  (39% vs 12% synthetic pairs; commit `238ee89`).

## Testing

- Browser tests: `npm run test:firefox` (native headless, `special:uncensored-smoke`, muted);
  commands in `docs/DEVELOPMENT.md`. Playback test videos: `an5iFYcjWUM` (short),
  `2z8vHPOW2tk` (115 min); dense/frozen videos have manual subs, avoid them.
- Chromium automation DOM stays empty; its zero-line reports don't prove visible fills.
- `gh` in old sessions: `env -u GITHUB_TOKEN gh …`.
