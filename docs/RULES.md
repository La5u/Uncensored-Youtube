# Rule data

Runtime rule data is static JavaScript under `src/rule-data/`:

- `language.js`: `ALLOWED_WORDS`, `RULE_WORDS`, semantic roles and shared vocabulary
- `exact.js`: phrase-specific rules
- `grammar.js`: productive expressions, role frames and broad fallbacks
- `../rules-data.js`: candidate-scoring parameters and public-data assembly

`ALLOWED_WORDS` is every word accepted from censored captions and Whisper; keep its order stable
(Whisper uses it for tie-breaks). Add a word only when real censored automatic tracks never show
it visible and manual-auto evidence repeatedly shows it whole (`chicken [__]` does not validate
`chickenshit`). `RULE_WORDS` is the subset rules may output; add a word only with a validated rule.
`NOT_CENSORED_WORDS` lists visible words to skip when inferring a hidden word; keep it disjoint
from `ALLOWED_WORDS`.

In Whisper modes a rule fill is provisional: it stays when Whisper abstains but never replaces a
word Whisper heard. Reintroduce rule overrides only with creator-diverse audio labels.

Groups have explicit priorities; compiled priority comes from group, authored position and
expansion, so source groups can be reordered without changing behavior.

## Admission gates

First-choice precision with at least 2 named creators: one-answer literals 90% at 4–5 matches
or 85% at 6+; generalized rules 92% at 10+; two-, three- and four-plus-candidate rules 92% at 6+,
95% at 10+ and 97% at 20+.

Measure manual-auto and synthetic evidence separately. A rule may pass on either tier, but must
not fall below its gate on the other tier wherever that tier has enough matches to apply it.
Filmot snippets never justify a rule alone. Prefer narrow phrases over frames, and prefer retiring
a below-gate rule over keeping its coverage. Add positive, near-miss, ambiguity, punctuation and
priority tests with every change.

Evidence records live in `corpus/rules/evidence.jsonl`, not in runtime files.
`tests/rules-data-structure.test.js` hashes the compiled rule data; change the hash only after an
intentional rule change and `npm test -- --benchmark`.
