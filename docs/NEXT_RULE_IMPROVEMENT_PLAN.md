# Next rule-improvement session

This is the handoff plan for a Luna session improving censored-word coverage,
Whisper repairs, and deterministic rules. Preserve unrelated working-tree
changes and keep runtime code small.

Suggested opening message for the new chat:

> Read `docs/NEXT_RULE_IMPROVEMENT_PLAN.md` and the linked handoff/audit docs,
> then execute the plan autonomously. Improve supported censored words,
> candidate-aware Whisper homophone repairs, and deterministic rules; delete or
> narrow weak rules. Preserve provenance tiers and unrelated changes, measure
> every change against the frozen baseline, and finish with tests plus a
> before/after handoff. Do not make held-out claims without real held-out pairs.

## Current continuation (2026-08-14)

The vocabulary audit now exposes `visibleWordCounts`, filters
`censoredWordCandidates` through `NOT_CENSORED_WORDS`, and rejects nearby/split
compound labels. The manual-auto evidence is asymmetric: `dickshit` and
`dickgirl` each have one occurrence from one creator; `chickenshit` has three
occurrences across three creators, including two explicit `chicken [__]` splits.
`fuckface` is rejected. Low-support additions, including the three named
compounds and `chinaman`, `shemale`, `shitshow`, `shitballs`, `cunty`, `spick`,
`genderfuck`, `trannies`, `faggots`, `shat`, `sissy`, and `dogshit`, are deferred
until repeated whole-word manual-auto evidence exists. Recognition-only
additions are recorded in `src/rule-data/language.js`. A creator-diverse batch of
15 exact rules passed realized gates; two candidates were rejected for creator
support or post-overlap support. Current strict rules-only results are 89.41% /
43.38% on 26,485 manual-auto slots and 90.82% / 41.26% on 108,846 synthetic
slots. Auto-auto is 100% / 72.73% on 11 scored slots. These remain in-sample
figures; no held-out test pairs exist.

## Frozen starting point

- Manual-auto: 1,476 pairs / 31,401 slots; strict rules-only 89.35% precision
  and 42.79% coverage on 26,362 scored slots.
- Synthetic: 1,754 pairs / 108,866 slots; 90.70% / 40.51% on 108,855 scored
  slots. This is exact same-timeline but generated evidence, not real censoring.
- Auto-auto: 2 pairs / 16 slots; 100% / 80% on only 10 scored slots.
- Unknown/conflicting provenance: zero. One classified legacy video's creator,
  `cIrZX2tQAFI`, remains unresolved.
- Twenty-seven weak deterministic emitters were removed. Do not restore them
  without new creator-diverse evidence that passes the current gates.
- Validation contains only nine synthetic slots and test contains no pairs.
  All headline results are in-sample development results, not held-out claims.
- Existing guarded Whisper repairs include `cook → cock`, `shift → shit`, and
  `shedding → shitting`, with ordinary-language negative tests.

Read `docs/SESSION_HANDOFF.md`, `docs/CAPTION_CORPUS_AUDIT.md`, `docs/RULES.md`,
and the README before editing. Inspect `git status` and `git diff` first.

## Files and responsibilities

- `src/rule-data/language.js`: `ALLOWED_WORDS`, conservative `RULE_WORDS`,
  semantic roles, and authoring vocabularies.
- `src/rule-data/exact.js`: narrow phrase-specific rules.
- `src/rule-data/grammar.js`: productive frames and generalized rules.
- `src/rules-data.js`: compact candidate-choice priors and public-data assembly.
- `src/rules-compiler.js` and `src/rules.js`: compilation/runtime machinery;
  avoid adding one-off data or special cases here.
- `src/whisper-local.js`: transcript anchoring and guarded ASR repairs.
- `corpus/rules/evidence.jsonl`: measured rule/corpus evidence, not runtime data.
- `tools/evaluate-whisper-only.js`: strict, candidate-oracle, per-rule, and
  per-creator evaluation.
- `tools/mine-rule-opportunities.js`: evidence-backed context-rule discovery.

## 1. Rebuild the baseline

Do not rely only on handoff numbers. Rebuild audit and per-tier reports before
the first edit:

```sh
node tools/audit-caption-corpus.js \
  --pair-class manual-auto,auto-auto,synthetic \
  --output /tmp/caption-audit-before.json
node tools/evaluate-whisper-only.js --mode rules-only --pairClass manual-auto \
  --discoverPaired true --skipMissing true --output /tmp/rules-manual-before.json
node tools/evaluate-whisper-only.js --mode rules-only --pairClass synthetic \
  --discoverPaired true --skipMissing true --output /tmp/rules-synthetic-before.json
node tools/evaluate-whisper-only.js --mode rules-only --pairClass auto-auto \
  --discoverPaired true --skipMissing true --output /tmp/rules-auto-before.json
npm test
```

Record scored slots, precision, coverage, top confusions, per-creator results,
and `summary.ruleMetrics`. Keep strict scoring separate from the
`--rulesScoring any-candidate` diagnostic.

## 2. Build review queues

Review these sources in order:

1. Failed or marginal `summary.ruleMetrics`, especially high-support rules.
2. `topWrongPlacements` and `topMissedWords` from paired evaluation/mining.
3. Manual-auto `unsupportedWordCounts` with `unsupportedCreators` from the
   corpus audit.
4. Paired-audio Whisper confusions and wrong-slot classifications.
5. Synthetic/text mining only as discovery support, never sole precision
   evidence.

Useful audit query:

```sh
jq '.groups["manual-auto"] | {
  unsupportedWordCounts, unsupportedCreators, absentAllowedWords
}' /tmp/caption-audit-before.json
```

Regenerate mining evidence when its input fingerprints are stale:

```sh
node tools/mine-rule-opportunities.js \
  corpus/generated/paired-rules-only-report.json \
  corpus/generated/rule-opportunities.json \
  --sample reddit=corpus/generated/mining/reddit/reddit-samples.jsonl \
  --sample opensubtitles=corpus/generated/mining/opensubtitles/opensubtitles-samples.jsonl \
  --whisper corpus/generated/mining/unpaired-whisper.json
```

Repeat mining with `--exclude previous-opportunities.json` to expose narrower
patterns hidden by rejected broad ones. Review source, video, creator support,
context, expected word, marginal precision, and single-video dominance.

## 3. Add censored words safely

`ALLOWED_WORDS` is the recognition vocabulary. Add a word only after reviewing
aligned manual/auto ground truth and confirming it is genuinely substituted by
`[__]`, not merely nearby ordinary caption text. Prefer evidence from multiple
creators and inspect loose-timing alignments manually. Preserve list order
because Whisper uses it for tie-breaking.

Do not automatically add every item in `unsupportedWordCounts`. A word may be
ordinary, inconsistently censored, a timing mismatch, or intentionally excluded
from product vocabulary. Add or update its `WORD_ROLES` entry when appropriate.

`RULE_WORDS` is narrower. Promote a word only when a validated exact rule or
grammar frame can emit it at the required precision. Recognition-only words may
remain audio candidates indefinitely.

Every vocabulary edit must update focused tests and intentionally update the
structure hash in `tests/rules-data-structure.test.js` only after benchmarks
support the change.

## 4. Improve deterministic rules

Prefer narrow exact phrases, then constrained grammatical frames. Avoid broad
wildcards, creator-specific phrases, and rules supported by one prolific video.
Patterns must compile through `rules-compiler.js`, contain one target slot, and
emit only `RULE_WORDS`.

Current quality gates are mandatory:

- Literal one-answer rule: at least 90% with 4–5 matches, or 85% with 6+.
- Generalized `*`, `…`, or role frame: at least 92% with 10+ matches.
- Two candidates: at least 92% candidate precision with 6+ matches.
- Three candidates: at least 95% with 10+ matches.
- Four or more candidates: at least 97% with 20+ matches.
- Every rule requires at least two named creators.
- Deterministic first-choice precision must separately reach 90%, 95%, or 97%
  for two, three, or four-plus candidates.

When candidate evidence passes but the deterministic first choice does not,
keep the candidate set for Whisper instead of forcing a context-only answer.
Add positive tests plus ordinary-language near misses, priority/tie cases, and
multi-slot cases. Tests must never declare an unchanged `[__]` as the expected
successful result.

Work in small batches. Re-evaluate after each batch and delete or narrow any
rule that reduces precision, shows creator dominance, produces wrong-slot
placements, or fails its gate. Coverage alone is not a reason to keep a rule.
Record accepted or removed behavior and measurements in
`corpus/rules/evidence.jsonl`.

## 5. Add homophones and Whisper repairs

Start from paired-audio transcripts where Whisper repeatedly emits the same
near-sounding ordinary token for a known censored word. A repair must be
candidate-aware and slot/context anchored; never globally translate an ordinary
word into profanity.

For each repair add tests covering:

- the supported positive transcript and caption context;
- the same ordinary word in a normal sentence, which must not convert;
- target absent from the candidate set;
- ambiguous and multi-slot contexts;
- punctuation and casing variants when relevant;
- no token being reused for multiple censored slots.

Unpaired Whisper output can suggest a repair but cannot validate it. A small
fresh audio run is diagnostic only. Do not change deterministic rules during a
Whisper-only batch unless both scopes are explicitly being evaluated.

## 6. Re-evaluate every change

Use the before reports for safe incremental reuse:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --pairClass manual-auto \
  --discoverPaired true --skipMissing true \
  --reuse /tmp/rules-manual-before.json --output /tmp/rules-manual-after.json
node tools/evaluate-whisper-only.js --mode rules-only --pairClass synthetic \
  --discoverPaired true --skipMissing true \
  --reuse /tmp/rules-synthetic-before.json --output /tmp/rules-synthetic-after.json
node tools/evaluate-whisper-only.js --mode rules-only --pairClass auto-auto \
  --discoverPaired true --skipMissing true \
  --reuse /tmp/rules-auto-before.json --output /tmp/rules-auto-after.json
```

Keep manual-auto aggregate precision at least at its baseline and aim to move it
above 90%; report any coverage tradeoff. Report synthetic and auto-auto
separately. Auto-auto has only 10 scored slots and must not drive decisions.

If a creator manifest is available, split by canonical creator ID using
`--creatorManifest` and `--creatorSplit`. Never split a creator across train,
validation, and test. The current test split is empty, so do not claim held-out
generalization.

## 7. Completion checks and handoff

```sh
npm test
node --check src/whisper-local.js
node --check src/rule-data/language.js
node --check src/rule-data/exact.js
node --check src/rule-data/grammar.js
git diff --check
```

Rebuild the corpus audit and confirm pair counts plus zero unknown/conflict are
unchanged. The final handoff must list:

- words added to or removed from `ALLOWED_WORDS`, `RULE_WORDS`, and roles;
- deterministic rules added, narrowed, or deleted;
- Whisper repairs added, with positive and negative evidence;
- before/after precision, coverage, scored slots, and creator support per tier;
- rejected candidates and why they lacked evidence;
- all tests and checks run;
- the continuing lack of a defensible held-out test score.

Stop when remaining ideas lack creator-diverse ground truth. Do not trade
precision for speculative coverage or reintroduce removed behavior merely
because synthetic/text data makes it look frequent.
