# Chromium support plan

> Status: on hold while Whisper live-caption correctness is stabilized.

## Goal

Keep the existing Firefox path intact, while making Whisper reliable in Chromium
Manifest V3. Chromium's background is a service worker: it can be stopped when
idle and is the wrong owner for the long-lived Whisper worker and model state.

## Current blocker

`src/background.js` creates `src/whisper-module-worker.js` with
`new Worker(url, { type: "module" })`. That worker is the only Whisper host in
Chromium, but failures are converted into an empty response by `audio-capture`.
The visible result is that Whisper sometimes never starts, without a useful
error. The Firefox manifest instead has a persistent background script.

Do not use `Boolean(globalThis.browser)` as a browser test. Chromium now also
exposes a `browser` namespace in recent releases, so that test will become
incorrect. Select a platform capability explicitly instead.

## Design

1. Add `src/offscreen.html` and a minimal `src/offscreen.js`.
   The offscreen page owns one `whisper-module-worker.js` module worker, its
   request queue, timeouts, and worker recreation.

2. Add the Chromium `offscreen` permission and include the two new files in the
   build. Create the document with the `WORKERS` reason and a narrowly accurate
   justification. Create it lazily on `preload` or the first `transcribe`, not
   on every YouTube page load.

3. Keep `background.js` as a thin message broker only. It must serialize
   `ensureOffscreenDocument()` behind one promise, wait for an explicit
   `ready` message, then forward a request with a request ID. Do not retain
   Whisper state in the service worker.

4. In the offscreen page, enforce a single inference queue. Give every request
   a timeout and, on timeout/error, reject that one request, terminate the
   worker, and recreate it for the next request. Never leave an unresolved
   promise in the queue.

5. Correlate every request and response with `{ navigationId, requestId }`.
   Increment `navigationId` from the content script on YouTube navigation and
   discard an old result before it reaches `applyResolvedWord`.

6. Make Chromium and Firefox adapters explicit:
   - Firefox may retain the current background-worker route after verification.
   - Chromium uses the offscreen route.
   - The SABR parser can remain in the content-script worker in Chromium; it
     already avoids the background relay there.

## Verification matrix

- Fresh install: first censored token loads the model and resolves.
- Service-worker suspension while playback continues: the offscreen host still
  returns a result, or is recreated cleanly.
- Seek, replay, and `yt-navigate-finish`: no pre-navigation response patches a
  new video.
- Disable Whisper during model load: queue is cancelled and the worker exits.
- Enable it again: exactly one offscreen document and one Whisper worker exist.
- Test Chrome/Chromium with DevTools closed and open; log request IDs, timeout,
  worker creation, and worker termination during this work.

## References

- [Chrome offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen/)
- [Chrome extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/)
- [Chrome browser namespace transition](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace/)
