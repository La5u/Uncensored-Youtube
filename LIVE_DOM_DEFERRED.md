# Live-caption architecture and remaining work

This document records the invariants behind the current Whisper live-caption
path. It is not a list of deterministic-rule changes.

## Implemented safeguards

- A navigation generation scopes pending tokens, audio, failures, and results.
- Previous JSON3 caption events are joined into continuous context, including
  leading slots whose useful context is still visible on the previous row.
- The observer is restricted to YouTube's caption container and suppresses
  callbacks caused by the extension's own writes.
- Resolutions cross the isolated/page-world boundary as JSON custom events and
  are retained by token index for later timed-text responses.
- Single-slot visible matching uses adjacent context rather than a broad text
  search.
- Nearby slots in one event share a complete stitched audio window and consume
  recognized swear words in order.
- Visible groups use JSON event structure and prefix-only alignment. One prior
  top row is retained so a promoted row keeps its preceding anchor.
- SABR decoding and Whisper inference are serialized. Missing audio waits rather
  than silently dropping a request.
- Worker errors and inference timeouts reject outstanding work and terminate the
  worker so a later request can start cleanly.

## Remaining edge cases

1. **Seek recovery.** Starting midway or seeking can bypass the remembered
   preceding row. A future timestamp-indexed JSON event timeline should recover
   the active event, with visible ordinary text verifying identity.

2. **End-of-buffer tokens.** A token cannot run until its complete audio context
   exists. Near the end of playback, YouTube may not provide the trailing range;
   the queue then reports pending work with `nextTokenIndex: null`.

3. **Inference latency.** Requests are processed chronologically and one at a
   time. This avoids concurrent model stalls but can make visible replacement
   late on slower machines.

4. **Ambiguous Whisper output.** Ordered assignment avoids reliance on context
   word alignment, but it still requires Whisper to recognize the correct number
   and order of profanities.

5. **YouTube DOM changes.** The timed-text token identity is authoritative; DOM
   patching is a best-effort immediate display path and depends on the current
   caption-row structure.

## Future changes

Prefer fixes that preserve token identity from JSON3 through inference and
rendering. Do not use global occurrence order across both rolling rows: the same
text can exist in the outgoing top row and incoming bottom row simultaneously.
Keep incomplete group writes atomic, keep inference off the page's main thread,
and add a targeted regression fixture before relaxing any matching rule.
