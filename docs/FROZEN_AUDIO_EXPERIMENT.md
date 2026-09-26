# Frozen audio comparison — 2026-09-20

Status: historical offline diagnostic; **not a certified held-out score or a
measurement of the current runtime**. This is the reference summary for the
experiment called “held-out” in the session handoff. No new inference was run
while documenting it on 2026-09-21.

## Recorded results

| Mode | Fixtures | Scored slots | Attempts | Correct | Precision | Correct coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Rules-only | 160 | 6,688 | 3,076 | 2,492 | 81.01% | 37.26% |
| Hybrid | 154 | 6,304 | 5,617 | 4,835 | 86.08% | 76.70% |
| Whisper-only | 154 | 6,304 | 5,255 | 4,890 | 93.05% | 77.57% |

Counts come directly from each saved report's `summary`. Coverage is correct /
scored slots, not fill rate. The manifest names 161 fixtures. Audio runs skipped
seven fixtures (six missing audio plus the shared caption exclusion); rules-only
skipped one. The rules-only and audio rows therefore have different populations.
Do not interpret their aggregate differences as a paired causal comparison.
Hybrid and Whisper-only have matching aggregate population counts. A 2026-09-21
join by fixture and token identity covered all 6,304 scored slots: both correct
4,489, hybrid-only correct 346, Whisper-only correct 401, and both wrong 1,068.
Whisper-only has a net 55 additional correct slots, but hybrid still uniquely
fixes 346; this is not evidence that one mode pointwise dominates the other.

## Provenance limits and interpretation

- All reports say `complete:true`, but have empty `creatorManifest`, fingerprint,
  freeze time and method fields, `creatorSplit:"all"`, and `prospective:false`.
  Their summaries classify pairs/creators as unknown. The filename-only manifest
  does not certify fixture hashes, completed acquisition, or creator independence.
- The handoff describes post-rule-freeze acquisition from new creators. That
  history is not a substitute for the provenance required by
  `tools/evaluation-metrics.js`; no canonical held-out row was imported.
- Saved rules fingerprint: `3796:39:16s8a44`; auxiliary: `8hsabx`; engine: `gzlhma`;
  decision: `138c188`. Transcript-generation fingerprint is `1ppkeoi` for
  rules-only and `w5mi6l` for both audio modes. These predate the `[__] excuse`
  retirement and current runtime retry changes.
- Whisper-only was rerun without the hybrid transcript cache because that cache
  contained empty windows rejected by the evaluator. Do not imply identical
  cached transcripts across the audio runs.
- Results were inspected and informed subsequent review. This population cannot
  become an untouched test set for later changes by relabeling it.
- Offline precision favors Whisper-only here; caption-visible latency, energy,
  and real-browser recovery were not measured. Defaults remain unchanged.

## Local artifacts (preserve unchanged)

Paths are under `tmp/heldout/`, ignored/local, not bundled with a clean checkout.
SHA-256 values were checked on 2026-09-21; hashes identify saved bytes, not verified
provenance. Retain reports and source fixtures for any future eligibility audit.

| File | SHA-256 |
| --- | --- |
| `heldout-manifest.json` | `951f40ca1bcfe74aea54058d84c960eba1dfed9963e2c511416b90beef8f53e7` |
| `post-freeze-rules-only.json` | `6b10cbbe1463d9d41aa0d9782ead7052a1d44a9f457492617d528d120877888a` |
| `post-freeze-rules-whisper.json` | `3dcc25148587a86d17b2e46a3af5b60a3b0eb0d686643791bb2d050395e1f3f4` |
| `post-freeze-whisper-only.json` | `45a9afb9171edb8a9ed8aca5dcbc4ec35c8e3931669f9904562acd31bf38cb67` |

Next, off battery: audit the provenance and paired populations, then measure
caption-visible success and latency in browsers. Do not rerun or overwrite these
frozen reports to make their metadata look current.
