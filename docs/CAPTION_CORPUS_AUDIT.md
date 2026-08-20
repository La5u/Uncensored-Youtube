# Caption corpus audit

`tools/audit-caption-corpus.js` audits saved fixtures only; it never calls
`yt-dlp`. It joins `_auto.en.json3` and `_manual.en.json3` by the first 11
characters of the video ID and applies the downloader report's `pairKind`:

- `auto-auto`: censored automatic track plus an uncensored automatic track;
- `manual-auto`: censored automatic track plus manual ground truth;
- `synthetic`: locally generated censored data, kept separate from primary corpus counts;
- `unknown` / `conflict`: missing or contradictory historical metadata.

The `_manual` filename is historical and is not enough to identify the
source. Unknown pairs must remain visible until provenance is recovered.
New downloader reports store `pairClass`, `censoredKind`, and `uncensoredKind`
and require time-local ground-truth evidence before accepting an auto-auto pair.
New items also retain YouTube's canonical channel ID as `creatorId`; use it for
future cap accounting and split membership instead of mutable display names.
Legacy backfills also retain YouTube's authoritative `creatorHandle` when a
canonical channel ID cannot be recovered; unresolved creators stay explicit.

Run an audit against the local corpus with:

```sh
node tools/audit-caption-corpus.js --pair-class auto-auto,manual-auto \
  --output /tmp/caption-audit.json
```

Paired evaluation can select one class without moving or renaming fixtures:

```sh
node tools/evaluate-whisper-only.js --mode rules-only --discoverPaired true \
  --pairClass auto-auto --skipMissing true --output /tmp/auto-auto-rules.json
```

Reports also include per-class metrics in `summary.pairClasses` and stable
per-rule counts in `summary.ruleMetrics`. The latter is keyed by `ruleId`, not
template text, so duplicate templates in different priority groups remain
separate and weak rules can be audited by corpus tier.
Evaluator precision and coverage use the runtime vocabulary denominator;
unsupported ground-truth words are intentionally reported by this audit rather
than silently folded into those headline metrics. Read both artifacts together.

For rule-data maintenance, inspect `unsupportedWordCounts` separately for
`auto-auto` (uncensored automatic captions) and `manual-auto` (manual ground
truth). It contains known profanity labels aligned to `[__]` slots but absent
from `ALLOWED_WORDS`; ordinary words elsewhere in a caption do not count.
Treat these as review candidates because loose manual-caption timing can still
align a nearby word to the wrong slot. `unsupportedCreators` shows whether a
candidate repeats across independent creators rather than one channel's style.
`absentAllowedWords` is the inverse inventory: allowed words not observed in
that class. `visibleWordCounts` records recognized swear labels that remain
visible in the automatic track. `censoredWordCandidates` is populated only for
the manual-auto inventory, after visible labels and disjoint
`NOT_CENSORED_WORDS` are excluded; use the top-level `vocabularyCandidates` (or that manual-auto field)
for vocabulary additions, not `wordCounts` alone. Auto-auto and synthetic
counts remain diagnostics and cannot promote vocabulary. `visibleWordCandidates`
shows labels that loose timing could otherwise attribute to a nearby blank. For
same-timeline pairs, `unknownSlotTexts` also exposes the raw uncensored text of
any slot outside the audit vocabulary. A word seen in either source is evidence
for recognition vocabulary, not automatically for a deterministic replacement
rule; rules still require contextual precision evidence.

Keep this separation as the corpus grows: `ALLOWED_WORDS` is recognition
vocabulary, `RULE_WORDS` is the conservative emission vocabulary, and
`WORD_ROLES` describes why a word is recognized. Provenance belongs in a
sidecar index keyed by video ID, not in fixture filenames or rule definitions.

## Current audit and scaling decisions

The pre-growth August 2026 corpus contained 1,004 manual-auto pairs, 2 auto-auto
pairs, and 1,308 synthetic pairs, with no unresolved or conflicting pairs.
`tools/caption-pair-provenance.json` preserves 856 explicit classifications:
852 manual-auto, `dHyhnY8dH8s` as auto-auto, and three synthetic pairs. The
third synthetic entry recovers a pair whose downloader was interrupted between
the atomic fixture write and report flush. Its normalized creator groups give
855 IDs authoritative YouTube handles and 612 canonical channel IDs;
`cIrZX2tQAFI` remains unresolved because YouTube requires sign-in. The two
auto-auto pairs contain 16 censored slots, of which 11 align to ground truth.
Synthetic pairs remain a separate evidence tier despite their exact generated
alignment.

The two auto-auto fixtures were found independently. `dHyhnY8dH8s` came from
the SsethTzeentach smoke acquisition; its stored uncensored side is
byte-identical to the surviving `en-en` automatic track. `HRfouC0vPPM` came
from the Ariel Helwani expansion report as `pairKind: auto-en`. A source-focused
follow-up enumerated all 106 current Sseth and 200 current Ariel feed entries
and found no new strict pair. Three entries remained transiently unavailable;
the other 303 were existing fixtures or received a definitive no-pair result.

The initial manual-auto audit added `bitchy`, `clit`, `cuntskeleton`, `retard`,
`retarded`, `sissy`, `slutty`, and `tranny` to recognition only; it did not add
deterministic rules. After provenance recovery, the full manual-auto audit
aligns 18,750 of 20,748 slots. Its remaining unsupported vocabulary must be
reviewed for loose-timing false matches before promotion.

The runtime rule layout should remain small and static: language/recognition,
exact rules, productive grammar, and priors are separate concerns already.
Corpus size should scale in ignored fixtures and versioned sidecar reports,
not by embedding provenance or mining evidence into runtime rule files. Use
`--pairClass` for per-tier benchmarks, exclude `unknown` from claims, and only
promote reviewed vocabulary to `ALLOWED_WORDS` or precision-validated behavior
to `RULE_WORDS`.

The final August 12 growth snapshot reached 1,265 manual-auto pairs / 28,803
slots, 2 auto-auto pairs / 16 slots, and 1,587 synthetic pairs / 103,689 slots,
with zero unknown or conflicting pairs. It
also promoted `sluts`, `fuckable`, `clusterfuck`, `dipshits`, and `shat` to
recognition vocabulary after manual-caption evidence, and removed forced
guesses whose expanded-corpus precision no longer supported one answer.
The final manual-auto inventory observes every allowed word except `dickwad`;
unsupported ordinary or inconsistently censored terms remain review evidence,
not automatic additions to Whisper's candidate vocabulary.

The frozen August 14 corpus contains 1,476 manual-auto pairs / 31,401 slots,
2 auto-auto pairs / 16 slots, and 1,754 synthetic pairs / 108,866 slots.
Unknown and conflicting provenance are both zero. The audit aligned 26,983
manual-auto slots, 11 auto-auto slots, and every synthetic slot. The final
103-channel manual probe contributed 34 pairs / 280 slots; a separate probe of
five held-out test creators checked 28 videos but found no manual English
tracks, so test-split paired evaluation remains unavailable.

The 472-pair manual growth pass involved 30 creator channels. Six were already
represented in the identified 1,004-pair baseline, so 24 are new against known
metadata: 108 identified baseline creators became 132 identified frozen-corpus
creators. Because one baseline video's creator remains unknown, the absolute
defensible new-creator range is 23–24. Synthetic growth
used 23 source labels, approximately eight new relative to the source roster;
keep that figure qualified until old synthetic creator IDs are normalized.

After removing 27 creator-diverse rules that failed the quality gate, strict
rules-only evaluation reached 89.35% precision / 42.79% coverage on 26,362
aligned manual-auto slots and 90.70% / 40.51% on 108,855 synthetic slots.
Auto-auto remained 100% / 80% on its 10 scored slots. Validation currently has
only nine synthetic slots (100% / 11.11%); do not present it as a broad
held-out result, and do not report a test score until test creators yield pairs.
A fresh 30-fixture paired-audio rules run scored 93.77% / 43.66% on 4,031
aligned slots. A deliberately small three-fixture Whisper check covered 56
slots and found no `recognized-wrong-slot` placements; it is diagnostic, not a
benchmark.

## Rule quality gates

`summary.ruleMetrics[].qualityGate` applies support-aware promotion standards.
Literal one-answer rules need 90% precision with 4–5 matches, or 85% with at
least 6. Generalized rules (`*`, `…`, or vocabulary frames) need 92% with at
least 10. Two-answer candidate rules need 92% candidate precision with at
least 6 matches; three-answer rules need 95% with at least 10; four or more
need 97% with at least 20. Every rule also needs evidence from at least two
named creators. Multi-answer precision means the correct word is present in
the candidate set. `deterministicPassed` separately requires the chosen first
answer to meet 90%, 95%, or 97% for two, three, or four-plus candidates.
These gates identify promotion candidates and must be confirmed on
a creator-held-out split before runtime rules change.

## 2026-08-14 continuation

The negative vocabulary pass found 97 manual-auto labels: 51 remained viable
after visible-track and nearby-label filtering, while 46 were excluded. The
The runtime vocabulary retains 19 additions with repeated manual-auto support;
low-support labels are deferred. The compound evidence is limited:
`dickshit` has one manual-auto occurrence from one creator, `dickgirl` has one
from one creator, and `chickenshit` has three from three creators, including two
explicit `chicken [__]` splits and one whole-word blank. Synthetic repeats are
not counted as vocabulary evidence. These compounds, plus `chinaman`,
`shemale`, `shitshow`, `shitballs`, `cunty`, `spick`, `genderfuck`, `trannies`,
`faggots`, `shat`, `sissy`, and `dogshit`, are deferred until stronger evidence
exists. Fifteen exact/context rules then passed the realized gates. The resulting strict rules-only metrics are 89.41%/43.38% on 26,485
manual-auto slots, 90.82%/41.26% on 108,846 synthetic slots, and 100%/72.73%
on 11 auto-auto slots. These are still development metrics.
