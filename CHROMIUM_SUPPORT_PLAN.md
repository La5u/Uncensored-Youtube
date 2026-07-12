# Chromium support plan

> Status: implemented with an offscreen worker host.

## Goal

Keep the existing Firefox path intact while making Whisper reliable in Chromium
Manifest V3. Chromium owns its SABR and Whisper workers in one offscreen
extension page because service workers cannot create dedicated workers and
YouTube-origin content scripts cannot load extension worker URLs.

## Design

1. Detect Chromium through `manifest.background.service_worker`, not through
   the `browser` namespace, which Chromium may also expose.
2. Create one offscreen extension page lazily when a YouTube tab first requests
   SABR or Whisper work. It owns both dedicated workers.
3. Keep Firefox's persistent background-worker route unchanged.
4. Correlate worker messages with request IDs, time them out, and recreate the
   tab worker after an error. Existing navigation generations discard stale
   results before caption replacement.

## Verification matrix

- Fresh install: first censored token loads the model and resolves.
- Service-worker suspension while playback continues: offscreen workers remain usable.
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
