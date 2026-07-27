# AMO source notes

This repository is the extension source. `build.sh` copies checked-in files
without bundling and creates:

- `dist/uncensored-youtube-firefox-1.3.2.zip`
- `dist/uncensored-youtube-chromium-1.3.2.zip`

Build and validate with:

```sh
npm test
```

Local Whisper requires checked-in third-party and model artifacts:

- `src/vendor/transformers.min.js`
- `src/vendor/ort-wasm-simd-threaded.asyncify.{mjs,wasm}`
- `src/models/whisper-tiny.en/**`

No remote code is loaded. `whisper-module-worker.js` imports the local
Transformers.js bundle, and `whisper-local.js` restricts model loading to the
extension.

The vendored JavaScript contains two review-oriented patches:

- Emscripten `new Function(...)` method helpers use generic dispatchers.
- The dynamic ONNX loader is disabled because the local ONNX Runtime path is
  always used.
