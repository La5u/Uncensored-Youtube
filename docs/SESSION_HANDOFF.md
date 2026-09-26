# Session handoff — 2026-09-24

Current state only. The full pre-trim history (959 lines, 2026-08 → 09-24) is in
`.tmp-archive/docs-20260924/SESSION_HANDOFF.md`; older committed versions are in git.
Preserve the dirty worktree, `tmp/`, `corpus/`, `test-fixtures/` and `.tmp-archive/`.

## Standing rules

- Keep acquisition lanes isolated (VPN per worker netns, max two tunnels, never
  host-wide). Don't start duplicate writers, delete supervisor flocks, or
  interrupt workers to change modes. Promote only complete reports to
  `corpus/generated/`. Only acquire genuinely new creators.
- Manual-auto, synthetic and auto-auto evidence stay separate. Synthetic pairs and
  Filmot snippets never justify a rule or `ALLOWED_WORDS` entry alone. Rule gates:
  `docs/RULES.md`.
- No held-out claim exists: there is no frozen, untouched creator split. The
  09-20 frozen comparison (`docs/FROZEN_AUDIO_EXPERIMENT.md`) is diagnostic.
- Deepgram/API output is never ground truth, never a rule-promotion basis, and
  must not be used to train or benchmark models (Deepgram ToS §2.4.9). Use it
  only to choose which clips a human reviews. The user saved the current key at
  `~/.config/deepgram/api-key` (mode 600, outside the repo); pass it via
  `DEEPGRAM_API_KEY="$(cat ~/.config/deepgram/api-key)"` and never copy it into
  repo files or logs. Keys pasted in earlier chats should be revoked.
- Shipped extension stays local-only (no online ASR fallback) by decision on 09-24.
- On battery: no builds, full test runs, model inference or corpus mining.
  Hyprland has workspaces 1–9 only; avoid broad `browser-smoke.js --cleanup`
  while Firefox work is active.

## Live processes (recheck with `ps`; PIDs rotate)

- `tools/supervise-caption-vpn.py tmp/vpn-caption-check/supervisor-config.json`
  with one manual-auto and one synthetic-auto `download-paired-captions.js`
  worker in separate netns. Chain afterwards: recycle synthetic sweep → 300-video
  audio fetch → fresh reports → annotation queue (launchers under
  `tmp/channel-research/`).
- `npm run corpus:watch` (discovery only; stop on battery, resume when charging).
- Rule review UI :8767 (`tools/review-rules.js`); audio review UI :8765 in
  `--mode deepgram-review` (restart with identical args to keep labels; command in
  `docs/DEVELOPMENT.md`).
- Disagreement review UI :8766 (same command with `--deepgram-triage
  tmp/deepgram-disagreements.json --output tmp/deepgram-disagreement-review.json
  --port 8766`): 193 slots where caption/Deepgram/Whisper disagree, highest-value
  first. The machine rebooted 09-24 ~17:45; everything above was restarted.

## Where things stand

- Hybrid contract: rules fill immediately; full-vocabulary Whisper runs on every
  slot and replaces untrusted fills; if Whisper abstains the rule fill stays.
  (The unused per-rule trust list was removed 09-24.)
- Product stance (user, 09-24): ~80%+ precision with high coverage beats <50%
  coverage at 90%+. Wrong forms of the same word are near-harmless; slurs need
  ~95%+. Rules-only coverage is near its ceiling (any-candidate oracle 49.8% vs
  44.8%), so coverage gains must come from Whisper.
- Frozen diagnostic (6,304 slots): Whisper-only 93.05% P / 77.6% C; hybrid
  86.08% / 76.7%; rule fills kept on Whisper abstention were 274/393 (69.7%).
- Deepgram review (`tmp/deepgram-human-comparison.json`, selected hard positives,
  not a deployment score): local Whisper 39/79 correct of 242 human-labelled
  swears; Deepgram 203/209. Of 167 Deepgram-only wins, local Whisper abstained on
  136 — its transcripts usually **omit the word** at the clip onset (e.g. "move
  anything." for "fucking move anything") or loop ("that one. that one. …").
  Causes: ±1.5 s window (`AUDIO_CONTEXT_SECONDS`), no text prompt, free greedy
  decoding of whisper-tiny.en q8.
- Human negatives barely exist (2–3 `no-swear-in-audio` labels in all files).

## Next steps

1. **Deepgram negative gate (ready, needs key).** Ignored script
   `tmp/deepgram-negatives.js` selected 276 silver negatives (23 creators, 50 phonetic lures) where manual and
   auto captions agree no swear/`[__]` within ±5 s, saved to
   `tmp/deepgram-negatives.json`. Started 09-24 (log `logs/deepgram-negatives.log`); rerun
   `node tmp/deepgram-negatives.js run` with the key env to resume or re-print scores
   (resumable; prints insertion rates within ±1.25 s and anywhere in the clip).
   Hand-check every insertion in the 8765 UI before concluding anything.
   **Result (09-24, 276/276, silver negatives, not human labels):** Deepgram
   emitted an allowed swear in 15 clips. 14 are real swears at the clip edge that
   the guard missed (11 auto `[__]` just outside ±5 s; 3 present in the manual
   caption, whose JSON3 lacks word times). 1 is uncertain: `jdOTrvWOTM8` @147.5 s,
   "what the fuck i have to call" (conf 0.99), absent from both captions, so
   likely a caption omission. Probably 0–1 false insertions in 276 (95% upper
   bound ≈1.1%); 0 near-target insertions on the 50 phonetic lures (mostly
   "come"/"cool", so a weak lure test). Deepgram passes as a triage teacher, not
   as truth. Side finding: auto captions sometimes drop a swear entirely (no `[__]`).
2. **Candidate scoring for local Whisper — implemented 09-24 (runtime + evaluator).**
   `src/whisper-local.js` `scoreCandidates` replaced free transcription and all
   transcript repair/anchor/alignment code (657→~290 lines). `timedtext.js` gives
   tokens `prefix`/`nextWord`; `audio-capture.js` uses a 3 s/1.5 s window and scores
   one slot per request (grouped multi-slot path removed). Evaluator defaults
   `--before 3 --after 1.5`; `--retryAfter` removed; `--transcripts` now reuses
   cached `audioWord`/`audioScore`. Runtime scorer = prototype on 80/80 dense
   slots; token prefix/next = prototype on 1,801/1,801. Single-thread CPU latency
   median 2.0 s vs 1.8 s for old free transcription (p90 2.6 vs 2.1 s); real
   browser WASM latency still unmeasured. Prototype scripts (ignored):
   `tmp/candidate-scoring*.js`, `tmp/current-whisper-negatives.js`.
   Method: one encoder pass; decoder prefix =
   `<|startoftranscript|><|notimestamps|>` + ≤8 auto-caption words before the slot
   inside the window; score each `ALLOWED_WORDS` word (lower/capitalised, log-sum)
   as a continuation. **Gate:** fill only if the best candidate's log P ≥ −4.
   **Choice:** among gated words, the best by log P(word + next caption word).
   Variants whose first token is < gate−2 are pruned. The exported cached decoder
   has no causal mask across several new tokens: step one token at a time with the
   KV cache (batched multi-token steps silently inflate scores).
   Results (development data, gate chosen on it; not held-out):
   - Dense set, 1,801 manual-caption-labelled slots / 23 creators
     (`tmp/candidate-scoring-dense.json`): current Whisper 95.1% P / 77.1% C;
     scoring 96.3% P / 87.2% C (creator-macro 97.1% / 90.0%). Paired: +255
     scoring-only, −74 current-only (mostly abstentions). Wrong fills are
     almost all same-family forms.
   - 242 human-labelled hard positives: 188 correct / 198 attempts (94.9%,
     family 100%) vs current 39 / 79. Silver negatives: 1/261 false fills
     ("bit"→bitch) vs current Whisper 7/261 (repair heuristics: shoot/sheet→shit,
     DUCK→fuck).
   - Node CPU time ~0.8–1.0 s median per slot with pruning; browser WASM
     latency unmeasured.
   **09-25: shared 30 s windows + playhead-first queue.** Whisper's encoder always
   encodes 30 s (~0.8 s of ~2 s per slot on one thread; truncated input is rejected
   by the export), so `audio-capture.js` now takes the next *upcoming* slot (passed
   slots last), opens a window at its time−3 s and scores every pending slot whose
   window fits within 30 s in one request (`options.slots`; worker returns
   `{decisions}`); prefix = caption words since the window start (tokens carry timed
   `precedingWords`). Media segments are kept for the 30 s before pending slots.
   Debug log `whisper resolved "…" lead Ns` = seconds the word was ready before
   display (goal: always positive). Dense set (1,801 slots, one thread): 1.24 s/slot
   vs ~1.96 s, 1.76 slots/window; evaluator (same windowing) Whisper 96.41%/87.90%,
   hybrid 96.13%/90.95% (imported to `docs/evaluation-metrics.json`).
   Firefox check 09-25 (an5iFYcjWUM): every word ready before display (first slot
   1.4 s, then 27–76 s lead); up to 5 slots per window.
   **09-25 efficiency (code + unit tests only, on battery; dense re-eval pending):**
   log-mel computed for real audio only and silence filled with its normalised
   constant (identical to ≤1.2e-7; 102 vs 464 ms for a 4.5 s window); encoder fetches
   only `last_hidden_state` (skips ~216 MB of attention maps); candidate batch 4
   (each row copies the cross-attention cache); slots >1 s behind the playhead are
   not scored and their audio is not decoded/kept (seeking back re-enables them);
   audio decode/retention both use the 30 s-before-slot rule.
   **Power trade-off (decision pending):** 1.5.2 skipped Whisper for any unambiguous
   rule fill (Whisper on 46% of dense slots: 94.84%/89.73%); current hybrid scores
   every slot (96.13%/90.95%, ~2x compute). Where both answer (911 slots) audio is
   right 98.4% vs rules 95.9%. Audit-precision skip lists lose accuracy before they
   save much (≥95% rules: 95.77%/90.62% at 85% of slots). Proposed: popup
   "Save power" toggle = rules-first. Firefox has no battery API.
   **09-25 popup modes (decided):** 5-stop slider Off / Rules only / Rules first
   (default) / Whisper first / Whisper only, stored as `mode`; legacy two-switch
   settings map to it. `content.js` derives `rulesEnabled/whisperEnabled/whisperFirst`;
   `audio-capture.js` skips Whisper for unambiguous rule fills unless `whisperFirst`.
   Fixed: cached rule fills blocked Whisper re-queueing after a mode switch. Evaluator
   gained `--mode rules-first`. Popup estimates are rounded dense-set numbers.
   **1.6.0 prepared 09-25 (not committed/tagged):** version bumped in manifests,
   build.sh, tools/test.js, AMO_SOURCE.md, README. Popup figures read "Up to" (best
   case on the development set the rules were tuned on). Dense set, same 24 fixtures,
   all current fingerprints (`corpus/generated/dense-audio-v3-*.json`, imported):
   rules only 95.53%/52.14% (1,845 slots), rules first 94.95%/89.84%, Whisper first
   96.01%/90.84%, Whisper only 96.29%/87.78% (1,801 slots). Efficiency edits changed
   2/1,925 audio decisions (batch 16→4; q8 dynamic quantization is batch-sensitive).
   `npm test` and `npm run test:release` pass (Firefox lint 0/0).
   Next: user checks the popup visually; multi-threaded WASM;
   slurs only have 8 labelled slots.
   User's 8766 labels (`tmp/deepgram-disagreement-review.json`, 161 swear): manual
   captions wrong on 13/89 contested slots — candidates for `expectedByToken`
   corrections. `EJSGR3voqU4.m4a` was corrupt and has been re-downloaded (decodes
   cleanly); `tools/download-dense-audio.js` now uses `[language^=?en]` (the old
   `[!language]` filter is rejected by yt-dlp 2026.08) and `--ignore-config`.
3. **Hybrid abstention floor.** Keep a rule fill after Whisper abstains only for
   rules measured ≥ ~80% on abstention cases (≥ 95% for slurs); needs fresh
   current-fingerprint hybrid reports on identical slots.
4. Done 09-24: hybrid-trust plumbing removed (rules-data/rules/timedtext/
   audio-capture/whisper-local/evaluator/tests/docs); full `npm test` passes; README
   fingerprints regenerated (aux `8hsabx`, engine `1ejn65d`).
5. Keep acquiring new creators; after audio exists, regenerate rules-only,
   Whisper-only and hybrid reports on identical slots.

## Key artifacts

- Evaluator outputs: `corpus/generated/current-rule-audit.json`,
  `dense-audio-v2-rules-only-current.json`, `dense-audio-v2-whisper-triage-current.json`,
  `docs/evaluation-metrics.json` (update only via `tools/evaluation-metrics.js`).
- Frozen reports: `tmp/heldout/post-freeze-*.json` (hashes in
  `docs/FROZEN_AUDIO_EXPERIMENT.md`).
- Deepgram: `tmp/deepgram-triage.json`, `tmp/deepgram-audio-review.json`
  (437 items; 242 swear / 2 no-swear / 3 skipped / 190 pending — the user does
  not want to label all pending), `tmp/deepgram-human-comparison.json`
  (`tools/analyze-deepgram-audio-review.js`).
- Human audio labels: `tmp/audio-golden.json` (500 items, 454 swear).
- Dense Deepgram pass (09-24, all 1,925 slots with audio, triage only):
  `tmp/deepgram-dense-all.json` via `tmp/deepgram-dense-all.js`. Caption+Deepgram
  agree on 1,615 of 1,794 caption-labelled slots; Whisper was silent on 234 of those.
- Historical acquisition configs moved from `tools/` to
  `corpus/acquisition-configs/` (ignored; paths in
  `corpus/generated/post-boundary-caption-manifest.json` still say `tools/`).
- VPN: `tmp/isolated-vpn-netns.sh`, `tmp/proton-profile-research/` (never print
  credentials).
