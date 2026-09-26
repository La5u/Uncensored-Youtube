# Rule data

Runtime rule data is static JavaScript under `src/rule-data/`:

- `language.js`: broad `ALLOWED_WORDS`, conservative `RULE_WORDS`, semantic roles, and reusable vocabulary
- `exact.js`: phrase-specific rules grouped by language behavior
- `grammar.js`: productive expressions, role frames, and broad fallbacks
- `../rules-data.js`: compact candidate-scoring parameters and public-data assembly

`ALLOWED_WORDS` is the broad vocabulary accepted from censored captions and local
Whisper. `RULE_WORDS` is its conservative subset permitted as deterministic rule
output. `WORD_ROLES` may be broader than both because it describes grammar rather
than output permission.

Add a newly supported censored word to `ALLOWED_WORDS` only after the
manual-auto audit shows it is absent from visible automatic captions and gives
repeated whole-word evidence; a split form such as `chicken [__]` does not
validate `chickenshit`. `NOT_CENSORED_WORDS` is the discovery-only negative
inventory: skip those visible labels when inferring the word hidden by a nearby
blank. Keep `NOT_CENSORED_WORDS` disjoint from `ALLOWED_WORDS`. Add a word to
`RULE_WORDS` only with a validated exact rule or grammatical frame. Context-
ambiguous words can therefore remain available to audio inference without
enabling context guesses. Keep `ALLOWED_WORDS` order stable because Whisper uses
it for tie-breaking.

In hybrid mode a rule provides an immediate provisional fill and remains when
Whisper abstains, but never replaces a word heard by Whisper. (A per-rule
override list was removed on 2026-09-24 while empty; reintroduce it only with
creator-diverse audio labels on Whisper disagreements.)

Groups have explicit priorities. Compiled rules derive a stable priority from their
group, authored position, and expansion position. Source groups may therefore be
reordered without changing matching behavior.

The current-rule audit distinguishes coverage-preserving `remove` from
precision-first `retire`: a below-gate selector may warrant retirement even when
it recovers some correct words. Review creator-diverse manual-auto evidence,
wrong outputs avoided, correct answers lost, and same-population benchmarks;
recommendations never automatically modify runtime. See
[`RULE_ARCHITECTURE_PLAN.md`](RULE_ARCHITECTURE_PLAN.md) for the structural roadmap.

Admission gates (first-choice precision on manual-auto evidence, ≥2 named creators):
one-answer literals 90% at 4–5 matches or 85% at 6+; generalized rules 92% at 10+;
two-, three- and four-plus-candidate rules 92% at 6+, 95% at 10+ and 97% at 20+.
Prefer narrow exact phrases over frames. Synthetic pairs and Filmot snippets may
support or contradict a rule but never justify it alone. Add positive, near-miss,
ambiguity, punctuation and priority tests with every change.

Mining provenance and validation thresholds are not runtime rules. They live in
`corpus/rules/evidence.jsonl`, one reviewable record per line. Add detailed
support and precision measurements there rather than comments or source-based
group names in runtime files.

`tests/rules-data-structure.test.js` hashes the compiled templates, candidates,
frames, both output vocabularies, semantic roles, and priors. A structural edit must preserve this
hash. Change it only after an intentional rule change and corpus benchmark.

Run rule validation with:

```sh
npm test -- --benchmark
```
