# SBCSAE rule-mining supplement

The local supplement at `corpus/generated/sbcsae-conversation/` is derived from
the TalkBank Santa Barbara Corpus of Spoken American English (SBCSAE), a broad
spoken-conversation corpus. The source is available from
<https://talkbank.org/ca/access/SBCSAE.html> under CC BY-ND 3.0 US; cite DuBois
& Englebretson (2004), DOI [10.21415/T5VG6X](https://doi.org/10.21415/T5VG6X),
and follow TalkBank rules. The generated text stays ignored/local because
adapted or censored redistribution may be restricted by the no-derivatives
license.

To reproduce, download the transcript archive from TalkBank, unpack its
`SBCSAE/` directory under `corpus/santa-barbara/`, then run:

```sh
mkdir -p corpus/santa-barbara
curl -L 'https://talkbank.org/data/ca/SBCSAE?f=zip' -o /tmp/sbcsae-talkbank.zip
unzip -q /tmp/sbcsae-talkbank.zip -d corpus/santa-barbara
node tools/prepare-sbcsae-corpus.js \
  corpus/santa-barbara/SBCSAE \
  corpus/generated/sbcsae-conversation
```

The adapter emits the JSONL contract accepted by `tools/mine-rule-opportunities.js`:

```sh
node tools/mine-rule-opportunities.js \
  corpus/generated/paired-rules-only-report.json \
  corpus/generated/sbcsae-conversation/rule-opportunities.json \
  --sample sbcsae=corpus/generated/sbcsae-conversation/sbcsae-samples.jsonl
```
