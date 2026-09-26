# SBCSAE rule-mining supplement

The local supplement at `corpus/generated/sbcsae-conversation/` is derived from
the TalkBank Santa Barbara Corpus of Spoken American English (SBCSAE), a broad
spoken-conversation corpus. The source is available from
<https://talkbank.org/ca/access/SBCSAE.html> under CC BY-ND 3.0 US; cite DuBois
& Englebretson (2004), DOI [10.21415/T5VG6X](https://doi.org/10.21415/T5VG6X),
and follow TalkBank rules. The generated text stays ignored/local because
adapted or censored redistribution may be restricted by the no-derivatives
license.

To reproduce the source download, unpack the transcript archive from TalkBank
into `corpus/santa-barbara/`:

```sh
mkdir -p corpus/santa-barbara
curl -L 'https://talkbank.org/data/ca/SBCSAE?f=zip' -o /tmp/sbcsae-talkbank.zip
unzip -q /tmp/sbcsae-talkbank.zip -d corpus/santa-barbara
```

The SBCSAE adapter and the miner that consumed its JSONL were removed as unused
pipeline code; recover them from git history to rebuild the local slice.
