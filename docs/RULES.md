# Rule data

Runtime rule data is static JavaScript under `src/rule-data/`:

- `language.js`: broad `ALLOWED_WORDS`, conservative `RULE_WORDS`, semantic roles, and reusable vocabulary
- `exact.js`: phrase-specific rules grouped by language behavior
- `grammar.js`: productive expressions, role frames, and broad fallbacks
- `priors.js`: compact candidate-scoring parameters
- `../rules-data.js`: public-data assembly only

`ALLOWED_WORDS` is the broad vocabulary accepted from censored captions and local
Whisper. `RULE_WORDS` is its conservative subset permitted as deterministic rule
output. `WORD_ROLES` may be broader than both because it describes grammar rather
than output permission.

Add a supported censored word to `ALLOWED_WORDS`. Add it to `RULE_WORDS` only
with a validated exact rule or grammatical frame. Context-ambiguous words can
therefore remain available to audio inference without enabling context guesses.
Keep `ALLOWED_WORDS` order stable because Whisper uses it for tie-breaking.

Groups have explicit priorities. Compiled rules derive a stable priority from their
group, authored position, and expansion position. Source groups may therefore be
reordered without changing matching behavior.

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
