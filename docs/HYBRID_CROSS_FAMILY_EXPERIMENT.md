# Hybrid cross-family Whisper experiment

> Historical experiment, superseded by the explicit hybrid-trust policy in
> `RULES.md`. These results do not authorize ordinary rules to influence hybrid.


Status: experimental; not a canonical metric claim.

The hybrid-only policy keeps the existing `transcript-anchor` override. It adds
one narrowly scoped case: direct `transcript` evidence may beat a deterministic
rule only when both outputs belong to different explicit normalized families.
Same-family decisions still keep the rule, and `transcript-tail` is not newly
accepted.

The family table is intentionally compact and explicit, rather than a
`startsWith` heuristic:

- **fuck**: `fuck`, `fucks`, `fuck's`, `fucking`, `fucked`, `fucker`,
  `fuckers`, `fuckery`, `motherfuck`, `motherfucker`, `motherfuckers`,
  `motherfucking`, `clusterfuck`, `fuckable`, `fuckup`, `fucko`, `fuckwit`.
- **shit**: `shit`, `shithole`, `shitting`, `shithead`, `shitheads`, `shitter`,
  `bullshit`, `dipshit`, `dipshits`, `dogshit`, `shitballs`, `shitshow`,
  `chickenshit`.

Compound choices are kept with their root family consistently (for example,
`clusterfuck`/`fuckery` and `bullshit`/`dipshit`). Words outside these explicit
sets do not qualify for the new override.

## Benchmark

Compared old versus experimental arbitration with the evaluator's scoring API
on `corpus/generated/dense-audio-v2-whisper-triage-current.json`, aligned by
fixture/token to `corpus/generated/dense-audio-v2-rules-only-current.json`:
23 contributing fixtures, 1,925 evaluated slots, and 1,801 scored slots. The
four rules-report fixtures without a contributing current Whisper result were
not silently treated as Whisper evidence.

| hybrid arbitration | attempted | correct | precision | coverage |
| --- | ---: | ---: | ---: | ---: |
| old | 1,615 | 1,536 | 95.1084% | 85.2860% |
| experimental | 1,615 | 1,539 | 95.2941% | 85.4525% |

The experiment produced three gains and no losses. The accepted rows were:

- `Mf9hF-B3aN8:101`: rule `shit` → Whisper `fuck` (expected `fuck`)
- `rMEIgwyv2Wc:105`: rule `shit` → Whisper `fuck` (expected `fuck`)
- `-aROK4boN5c:106`: rule `fucking` → Whisper `bullshit` (expected `bullshit`)

The 150-item human triage set contained exactly these three eligible
non-anchor cross-family rows; all three human labels agreed with Whisper, and
none agreed with the stored rule. No material full-corpus degradation was
observed, so the runtime experiment remains enabled. Canonical metrics and
`docs/evaluation-metrics.json` were not changed.
