# Expanded OpenSubtitles rule-mining pass

`corpus/generated/opensubtitles-expanded-aux/` is a fresh, larger mining pass
over the existing local OPUS OpenSubtitles English source. It uses the
sentence adapter already in `corpus/evaluate-corpus.js`, with `minWords=1` and
`maxChars=500` to retain short exclamations and longer dialogue context that
the earlier capped passes filtered. The source checksum used here is:

```text
ac3913423581c9da440145c4b93a4ed20772148c57d561e25c994a142147dff0
```

Source/provenance: [OPUS OpenSubtitles](https://opus.nlpl.eu/datasets/OpenSubtitles),
English source side of the local `opensubtitlesen-es.parquet`. OPUS asks users
to link OpenSubtitles.org and notes that it does not own the underlying text;
keep this derived corpus ignored/local and honor source takedown or copyright
requests. This is analysis data, not an asset to ship in the extension.

Reproduce the expanded pass with:

```sh
node corpus/evaluate-corpus.js \
  --input corpus/opensubtitlesen-es.parquet \
  --output corpus/generated/opensubtitles-expanded-aux \
  --limit 1000000 --sampleLimit 0 --minWords 1 --maxChars 500
```

The resulting JSONL can be mined alongside paired captions and the SBCSAE
slice:

```sh
node tools/mine-rule-opportunities.js \
  corpus/generated/paired-rules-only-report.json \
  corpus/generated/rule-opportunities-with-auxiliary-text.json \
  --sample opensubtitles-aux=corpus/generated/opensubtitles-expanded-aux/opensubtitles-samples.jsonl \
  --sample sbcsae=corpus/generated/sbcsae-conversation/sbcsae-samples.jsonl
```

Observed output: 2,659,610 parquet rows scanned, 48,058 profanity-bearing
sentences, and 50,562 censored tokens. The ten most frequent labels are
`fuck`, `fucking`, `shit`, `bitch`, `fucked`, `bullshit`, `asshole`,
`motherfucker`, `fuck's`, and `fucker`.
