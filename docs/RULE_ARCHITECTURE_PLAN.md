# Rule architecture: precision before expansion

Status: recommendations, not an approved engine rewrite. Detailed investigation:
`tmp/rule-campaign/structural-rule-audit-20260905.md` (predates the latest pruning).

## Implemented first step

The current-rule auditor now distinguishes coverage-preserving `remove` from
precision-first `retire`. Retirement requires creator-diverse manual-auto
support, failure of the evaluator's deterministic quality gate, avoided wrong
outputs, and improved aggregate precision. Reports expose correct answers lost
and wrong outputs avoided. Recommendations do not automatically change runtime.
Creator keys normalize names, reject placeholders, and prefer canonical IDs.
Name fallback is not proof of verified creator identity.

Caption evidence now uses `exclude-explicitly-incomplete-v1`: an explicit false
queue-completion marker on a report or channel makes that report diagnostic-only.
All observations remain indexed for deduplication and conflict diagnostics. A
pair needs same-class support from a complete or explicitly marked legacy report
to supply vocabulary candidates, faithful training rows or rule recommendations.
Missing completion metadata is `legacy`, not verified completion. Conflicting
pair classes still abstain; a complete duplicate does not erase those conflicts.

Older faithful datasets must be rebuilt before mining promotion proposals.
Refresh invalidates pre-policy caches and blocks incomplete acquisitions from
triggering mining, even after slot growth. Previous proposal files are preserved,
but blocked refresh state clears their cache fingerprints and marks
`miningEligible: false`; preserved files are not current recommendations.
Archived benchmarks still replay diagnostic rows and disclose
`incompleteProvenanceSlots`. This gate does not verify fixture hashes, creator
identity, prospective acquisition targets or held-out independence.

## Recommended sequence

1. **One evidence gate and decision trace.** Reuse the evaluator's quality gate
   (now done in the auditor). Next expose matched, winning and blocked selectors
   through one runtime/audit trace. This makes overlapping rules reviewable and
   avoids separate tools approximating engine behavior.
2. **Separate output from candidate hints.** Represent fill, candidate-only and
   abstention explicitly. Investigate which abstentions intentionally block an
   unsafe fallback versus accidentally suppress a safe narrower rule. Do not
   simply remove all occupied-range guards. Compare changed rows and priorities
   before enabling a new arbitration policy.
3. **Freeze fixture provenance.** Consume a manifest with canonical creator ID,
   track kinds, pair class, fixture hashes and completed acquisition-report hash.
   Default filename discovery currently relies on operational promotion rules;
   archived `contextFaithful` metadata is trusted rather than independently
   verified. Keep legacy sources explicit rather than silently certifying them.
4. **Replace expansion machinery only if it simplifies the above.** A compact
   rule representation with stable IDs, matcher alternatives, candidates, mode,
   priority and evidence reference could replace thousands of expanded regex
   entries. First compile both forms and compare text, spans, winners and traces
   on the same contexts. Remove the old path only after equivalence, or separately
   documented and tested intentional behavior changes. Avoid adding an NLP
   dependency or another large collection of grammatical word lists.

## Acceptance

- Keep runtime evidence metadata out of shipped rule data where possible.
- Report wrong outputs avoided and correct coverage lost; zero correct loss is
  not an absolute veto on retiring an unreliable rule.
- Preserve creator/support/precision gates in the execution plan; evaluate
  first-choice outputs, not candidate membership alone.
- Evaluate old and new engines on identical populations, separately from corpus
  growth. Keep faithful, dense, archived and synthetic diagnostics separate.
- Add ambiguity, multi-slot, boundary and precedence regressions. Pass strict
  provenance/metrics checks and the full test/release suite.
- No held-out claim without an untouched, frozen creator split. No ordinary-word
  outputs or visible-caption rewriting without a separate audio-backed study.
