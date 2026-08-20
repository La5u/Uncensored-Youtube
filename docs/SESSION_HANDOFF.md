# Session handoff — 2026-08-20

## August 20 underrepresented captions, strict rules, and lean follow-up

- Thirty exact unseen-video checks targeted new and low-count creators. Fifteen
  ChilledChaos synthetic-auto pairs added 162 slots; six other low-yield lanes
  were stopped rather than expanded. The post-boundary manifest now has 203
  unique pairs / 40,150 slots across 35 reports, with no duplicates, conflicts,
  missing paths, or locks. The full saved synthetic tier is 1,958 pairs.
- Three creator-diverse fill rules (`[fucking] love it`, `[fucking] neck`, and
  `your [fucking] hands`) plus three narrow correction overrides (`and [shit]
  but *`, `piece of [fucking] shit`, and `to [shit] all$`) passed synthetic and
  manual-auto transfer checks. Broad grammar, generic n-gram, and compressed
  trie proposals were rejected after creator-held-out precision collapsed.
- On the same 1,943 synthetic fixtures, the new batch moves strict rules from
  59,781/66,477 correct/attempted (89.927% precision, 40.129% coverage) to
  59,838/66,519 (89.956%, 40.167%). Including the 15 harder new pairs gives
  59,895/66,597 on 149,135 scored slots (89.936%, 40.162%). Manual-auto moves
  from 11,824/13,206 to 11,843/13,218 on 26,429 slots (89.598% precision,
  44.811% coverage). Auto-auto remains 8/8 attempted/correct on 10 slots.
- The deterministic target did not reach 50%. The prior candidate oracle was
  only 49.831%, and the second-pass generalized candidates were 53–70% precise
  on creator-held-out validation. Promoting them would trade accuracy for an
  inflated in-sample coverage number; candidate-aware audio remains the sound
  route to the remaining gap.
- Lean proposals 40–60 removed redundant guards, repeated normalization and
  single-use wrappers. A nullable prevalidation fallback was restored when its
  reachable caller was confirmed, and inlining the pattern finalizer was
  rejected because it is a useful validation boundary. No second matcher or
  runtime dependency was added.
- Final fingerprints are rules `3707:39:qoalur`, engine `gzlhma`, and auxiliary
  data `1vqdx59`; the intentional structure digest is `d8a1daef...`. Focused
  tests and `npm test` pass, including both builds, ZIP integrity, and Firefox
  validation with zero errors, notices, or warnings.

## August 17 coordinated caption, rule, and simplification pass

- Forty-one bounded synthetic-auto checks covered 13 new or underrepresented
  creators. One Theo Von video paired for three slots; zero-yield lanes were
  stopped instead of expanded. The post-boundary manifest now contains 188
  unique pairs / 39,988 slots, while the saved-fixture audit contains 1,943
  synthetic pairs and no provenance conflicts or leftover locks.
- On the unchanged 1,942-pair synthetic baseline, strict rules-only moved from
  59,698/66,430 correct/attempted (89.866% precision, 40.074% coverage) to
  59,781/66,477 (89.927%, 40.130%). Including Theo's three currently missed
  slots gives 40.129% coverage on 148,973 scored slots. Manual-auto improved
  from 11,812/13,200 (89.485%, 44.693%) to 11,824/13,206 (89.535%, 44.739%) on
  26,429 scored slots. These are in-sample development results.
- Added three fill-only fallback contexts (`the [fucking] face`, `can't do
  [shit]`, `the [fuck] is this`) plus high-confidence `did I [fuck] up` and
  `get the [fuck] out/off/on/in` splits. Broad candidates such as `the [fuck]
  is` were rejected because marginal manual precision failed. A pruning trial
  reached 90.55% synthetic precision but only 39.26% coverage, so it was
  rejected; weak legacy rules were retained or moved behind specific rules.
- The current any-candidate oracle reaches only 49.831% coverage at 90.808%
  candidate precision. Reaching 50% deterministically is therefore not a safe
  near-term claim; candidate-aware audio selection is the credible next step.
- A single fallback intensifier frame replaces 1,231 expanded templates without
  changing replacements across 115,002 checked rows. Current deterministic
  templates fell from 4,933 to 3,704, fallback templates from 1,366 to 140, and
  serialized rule data from 578,789 to 446,249 bytes.
- Thirty-nine lean proposals were reviewed individually. Accepted cleanup folds
  priors into `rules-data.js`, compiles deterministic rules once, removes stale
  wrappers/logs/exports and unreachable private guards, and keeps public input
  coercions plus the clearer navigation/worker boundaries. One allegedly dead
  export was restored after live tool consumers were found.
- `npm test`, both extension builds, ZIP integrity checks, focused rule/timed-
  text/Whisper tests, corpus audit, structure hashing, and `git diff --check`
  pass. The intentional rule-data digest is now `42a8e616...`.

## August 16 continuation: Wubby and Vinesauce expansion

- The exact post-boundary manifest now contains 187 unique synthetic pairs /
  39,985 slots from 260 persisted checks. All referenced fixtures, configs, and
  reports exist; fixture-role marker counts and report slot counts validate.
- Wubby Stream Archive contributed 155/185 pairs / 39,295 slots. Vinesauce added
  14/14 / 328. The Tim Dillon Show added one 2-slot pair and was stopped as a
  low-yield lane. New essay creators Inescape and Disgruntled Townsperson added
  2/2 / 47.
- Legacy synthetic fixture suffixes are misleading: `*_auto.en.json3` is the
  locally censored fixture, while `*_manual.en.json3` is uncensored automatic
  ground truth. Manifest field names now describe actual content.
- Six canonical creators are genuinely new post-boundary: Wubby Stream Archive,
  The Fat Electrician, Syndicate, The Tim Dillon Show, Inescape, and Disgruntled
  Townsperson. Neebs, jacksepticeye, and vinesauce were previously represented.
- A fresh saved-fixture audit reports manual-auto 1,476 pairs / 31,401 slots,
  auto-auto 2 / 16, and synthetic 1,942 / 148,998, with zero unknown or
  provenance conflict. The synthetic increase exactly matches the 187-pair
  post-boundary manifest after accounting for the already analyzed 147-slot
  excluded fixture.
- Synthetic evidence remains discovery-only. No deterministic rule was promoted
  and the intentionally stale structure hash was not changed.

## August 15 continuation: recovered high-yield acquisition

- The post-boundary manifest now records 24 unique synthetic pairs / 2,896
  slots from 67 total committed checks. All fixture, report, and config paths
  exist; there are no duplicate manifest IDs.
- Wubby Stream Archive is the new motherlode: 9/9 globally unseen videos paired
  for 2,583 slots. The globally unseen Neebs Gaming tail added 12/12 pairs / 302
  slots. The Fat Electrician added 1/5 / 8, while Syndicate and jacksepticeye
  added one small pair each (3 slots combined).
- Scouting must recognize YouTube's spaced censor marker with
  `/\[\s*__\s*\]/`; literal `[__]` checks produced false positives and should
  not be reused. Continue with exact globally unseen IDs from the checked-video
  ledger, small pilots, and immediate expansion only after demonstrated yield.
- The earlier ~80k-slot acquisition came from broad expansion of proven
  channels. Between 20:40:54Z and 22:30:16Z on August 9, deep reports acquired
  1,000 unique pairs / 71,344 slots; including the earlier priority report gives
  1,140 / 89,944 with no duplicate IDs.
- New synthetic evidence now permits rule discovery, but remains discovery-only.
  Do not make deterministic behavior changes without creator-diverse
  manual-auto confirmation. The intentionally stale structure hash remains
  untouched.

## August 15 continuation: fresh pilots and behavior-preserving cleanup

- Two fresh synthetic-auto pilots committed eight checks and found zero pairs
  or slots. The first stopped three channels after two misses each (six checks);
  the ledger is check-type scoped, and two sampled IDs had older checks under a
  different type. The second therefore prefiltered exact Sam Tripoli video IDs
  across the whole ledger and stopped after two already-censored automatic
  tracks. No fixtures, failures, conflicts, duplicates, or locks remain.
- `corpus/generated/post-boundary-caption-manifest.json` now observes both
  reports. It still contains no post-boundary pair, so no rule discovery or
  deterministic behavior change was attempted. The observed continuation total
  is 30 committed checks across all five reports.
- Rule-data cleanup removed unused grammar imports and stale, unconsumed
  language subsets. Compiled templates and the actual structure digest remain
  unchanged at `73af0d...`; the stale expected `c9dbb3...` hash was not updated.
  Timed-text expectations were aligned with the already validated
  `holy [shit] *` rule: continuing context resolves to `shit`, while standalone
  `holy [__]` remains ambiguous and Whisper-only mode emits no deterministic
  candidates.
- The fresh saved-fixture audit sees 1,476 manual-auto pairs, two auto-auto
  pairs, 1,755 synthetic pairs, and zero unknown/conflict. The extra synthetic
  pair versus the boundary snapshot is the explicitly excluded, already
  analyzed `39HLVjC5qWg`; it is not post-boundary evidence.
- The auto-auto 11-to-10 scored-slot discrepancy is explained: the old report
  scored `dog [__] advice` as `dogshit`, while the current deferred vocabulary
  excludes `dogshit`, leaving that slot unscored. The remaining ten slots are
  unchanged at 100% precision / 80% coverage.
- Focused downloader, audit, alignment, compiler, rules, timed-text, and Whisper
  tests pass. `npm test` reaches only the intentionally stale structure-hash
  failure; `git diff --check`, syntax checks, and JSON validation pass.

## August 15 post-boundary acquisition and rule review

- The discovery boundary excludes the already analyzed 472 manual-auto pairs,
  458 post-baseline synthetic pairs, and `39HLVjC5qWg`. The exact continuing
  manifest is `corpus/generated/post-boundary-caption-manifest.json`.
- Three fresh synthetic-auto pilots committed 22 unique ledger checks and found
  zero new pairs or slots: 18 checks in `pilot2`, three persisted checks in the
  interrupted `final-pilot`, and one Kill Tony check. There were no failures,
  duplicate IDs, provenance conflicts, remaining locks, or overwritten reports.
  `final-pilot` has four started channel counters but only three committed
  item/ledger records; keep it marked interrupted and do not infer a fourth
  completed check.
- No post-boundary manual-auto or synthetic caption pair exists. The stable
  manual-auto partitions are therefore empty, and grammar/prior discovery had
  no eligible synthetic input. No vocabulary, deterministic rule, prior,
  Whisper, test-expectation, or structure-hash change was made in this session.
- Accepted new candidates: none. Rejected/deferred new candidates: none because
  no eligible evidence was acquired. Previously accepted `holy [shit] *`
  remains 117/126 (92.857%) across nine creators; previously rejected phrasal,
  `I [__] up`, `take a [__]`, and low-marginal `yeah no [shit]` decisions remain
  unchanged.
- The complete frozen metrics remain 89.41% precision / 43.38% coverage on
  26,485 manual-auto scored slots and 90.82% / 41.26% on 108,846 synthetic
  scored slots. With no new fixtures or runtime changes, session before/after
  values are identical. A fresh auto-auto run reproducibly reports 100% / 80%
  on 10 scored slots; this differs from the previous 100% / 72.73% on 11-slot
  handoff figure and should be reconciled before using auto-auto longitudinally.
  Auto-auto remains too small to drive decisions. No figure is held out.
- Focused rule/compiler/Whisper/alignment/audit tests passed. The full suite
  passes except for the pre-existing stale rules-data structure hash (actual
  prefix `73af0d`, expected prefix `c9dbb3`); it was intentionally not updated.
  Runtime review found 4,930 unique deterministic templates, no duplicate
  templates, correct multi-slot occupancy, and correct `holy` rule priority.
  `git diff --check` and relevant `node --check` commands pass.
- Existing dirty-tree exact rules including `might be [fucked]`, `where'd that
  [fucker] go`, generic `[fucked] up`, `plants looked like [assholes]`, `[cock]
  push-ups`, and `Mario [pussy] attack` have tests but no matching records in
  `corpus/rules/evidence.jsonl`; do not treat them as newly gate-approved.

## Goal

Grow the caption corpus without creator bias, keep provenance tiers separate
(`manual-auto`, `auto-auto`, `synthetic`, `unknown`, `conflict`), then freeze the
corpus and use creator-held-out evaluation to remove weak rules and add only
well-supported rules. Do not add tests whose expected output preserves `[__]`;
the product goal is to fill every slot.

## August 14 completion update

- All caption writers are stopped and unlocked. The targeted 103-channel pass
  is complete after correcting 12 stale or wrong URLs: 617 videos checked, 34
  manual-auto pairs, 280 slots, and no transient failures.
- The five previously unchecked test creators were probed separately: 28
  videos, zero manual English tracks, and therefore zero test pairs.
- `corpus/generated/checked-video-ledger.json` now provides locked global
  negative deduplication by video ID and check type.
- Frozen audit: manual-auto 1,476 pairs / 31,401 slots; auto-auto 2 / 16;
  synthetic 1,754 / 108,866; unknown 0; conflict 0.
- Twenty-seven creator-diverse deterministic emitters failing the quality gate
  were removed. Final strict rules-only precision/coverage is 89.35%/42.79%
  for manual-auto and 90.70%/40.51% for synthetic. Auto-auto is 100%/80% on
  only 10 scored slots. Validation has only nine synthetic slots; test has none.
- The full `npm test` suite and `git diff --check` pass after rule pruning.
- Legacy creator normalization recovered authoritative YouTube handles for 852
  of the 853 previously unattributed pairs. Across the complete 856-ID sidecar,
  855 now have handles and 612 also have canonical channel IDs; the
  sign-in-restricted `cIrZX2tQAFI` remains explicitly unresolved.
- The 472 new manual-auto pairs span 30 creators: six were already represented
  in the identified baseline and 24 are new against that baseline. The baseline
  has 108 identified manual creators and the frozen corpus has 132, plus the one
  unresolved video; therefore the fully defensible absolute new-creator range
  is 23–24.
  Synthetic growth used 23 creator labels, about eight new relative to the
  source roster; that count is not canonical because old synthetic reports lack
  channel IDs. Test creators still have no paired fixtures.

## Acquisition snapshot

- Pre-growth baseline: manual-auto 1,004 pairs / 20,748 slots; synthetic 1,308
  pairs / 94,685 slots; auto-auto 2 pairs / 16 slots.
- August 12 frozen snapshot: manual-auto 1,265 / 28,803; synthetic 1,587 /
  103,689; auto-auto 2 / 16; unknown 0; conflict 0.
- New broad synthetic reports added 167 pairs / 5,177 slots, but are stopped.
- Broad Luna manual reports checked 928 videos and found zero pairs; do not
  resume them. Their creator selection was poorly targeted.
- Strict auto-auto discovery checked 755 videos across six channels and found no
  new valid pair. Existing valid auto-auto remains two.
- The two pairs came from separate source passes: `dHyhnY8dH8s` from the
  SsethTzeentach smoke pass (its uncensored fixture matches the surviving
  `en-en` automatic track), and `HRfouC0vPPM` from the Ariel Helwani expansion
  pass (`pairKind: auto-en`). A follow-up enumerated all 106 current Sseth and
  200 current Ariel feed entries and found no additional valid pair; three
  entries remain inconclusive after repeated YouTube rate limits.
- Dense Whisper audio acquisition is complete: 28 files / 4,211 censored slots,
  about 20 creators, split across >5% and >2% density bands.

## Important implemented changes

- `tools/audit-caption-corpus.js` and `tools/caption-pair-provenance.json` audit
  provenance and keep unknown/conflict separate.
- Auto-auto acceptance requires an exact same-timeline, one-to-one slot
  replacement with known ground truth. Manual captions retain the looser timing
  path used for vocabulary discovery.
- Creator splits prefer canonical `creatorId`.
- Download reports are atomic; locks fail closed; DNS and empty listing failures
  are not recorded as clean negative evidence.
- `--manual-auto-only` is now actually enforced. It previously parsed but had no
  effect.
- `--sample-per-channel` performs an evenly distributed catalog sample.
- The current cutoff is six sampled videos for the 103-channel discovery pass;
  prior broad queues used 12 consecutive misses.
- Whisper has guarded normalizations including `cook → cock`, `shift → shit`,
  and `shedding → shitting`, with ordinary-language negative tests.
- Alignment no longer lets one lexical token get stolen by multiple slots.
- Tests reject new direct output expectations containing an unfilled `[__]`.
- Rule metrics now include candidate precision, creator support, and a quality
  gate. Literal one-answer rules require 90% at support 4–5 or 85% at 6+;
  generalized rules require 92% at 10+; two-answer rules require 92% at 6+;
  three-answer rules require 95% at 10+; four-plus require 97% at 20+. All need
  at least two named creators, with separate deterministic-choice thresholds.

Focused downloader tests, `node --check`, and `git diff --check` passed at
handoff. The full suite passed before the latest small downloader changes; run
it again after acquisition freezes.

## Follow-up session update — vocabulary and validated context batch

- The manual-auto audit now reports visible swear labels separately and derives
  `censoredWordCandidates` only after applying `NOT_CENSORED_WORDS`.
- Recognition-only additions include `fuckup`, `nigger`, `faggots`, `dogshit`,
  `blowjob`, `fucko`, `midget`, `fags`, `faggot`, and `fuckwit`.
  `chinaman`, `trannies`, `genderfuck`, `shemale`, `shitshow`, `shitballs`,
  `cunty`, `spick`, `faggots`, `shat`, `sissy`, and `dogshit` were deferred for
  weak support. `fuckface` was rejected as nearby/split evidence. `dickshit`,
  `chickenshit`, and `dickgirl` were also deferred: the authoritative evidence
  has only one manual-auto occurrence for the first and third, while the three
  `chickenshit` occurrences include two explicit `chicken [__]` splits.
  Synthetic repeats do not count.
- Fifteen exact/context rules passed realized precision and creator gates; two
  candidates were rejected after overlap/creator-support checks. Manual-auto
  strict rules-only moved from 89.24%/42.62% to 89.41%/43.38% (26,485 scored
  slots). Synthetic is 90.82%/41.26% (108,846 scored slots); auto-auto is
  100%/72.73% (11 scored slots). No held-out test estimate is available.

## Remaining work

1. Recover creator metadata for the remaining sign-in-restricted legacy video,
   `cIrZX2tQAFI`, only if an authenticated authoritative source is available.
2. Acquire real paired fixtures from held-out test creators before making any
   held-out performance claim or adding new deterministic rules.
3. Treat the three-fixture fresh Whisper comparison as diagnostic only; a full
   dense-audio run requires hours of local inference and should be scheduled
   separately if needed.

Useful final commands are documented in `docs/CAPTION_CORPUS_AUDIT.md`. Keep
manual-auto, auto-auto, and synthetic results separate in every reported claim.
The next rule/Whisper session should follow
`docs/NEXT_RULE_IMPROVEMENT_PLAN.md`; it contains the frozen baseline, review
queues, promotion/deletion gates, commands, and final handoff checklist.
