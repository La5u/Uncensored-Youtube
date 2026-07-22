# AMO source code notes

This repository is the source for the submitted extension. The extension is built
without a bundler by copying the checked-in files into `dist/` and zipping them.

## Build

Use:

```sh
./build.sh 1.3.1
```

This creates:

- `dist/uncensored-youtube-firefox-1.3.1.zip`
- `dist/uncensored-youtube-chromium-1.3.1.zip`

## Generated or minified files

The submitted extension includes vendored third-party runtime/model artifacts for
local Whisper inference:

- `src/vendor/transformers.min.js` - Transformers.js browser bundle.
- `src/vendor/ort-wasm-simd-threaded.asyncify.mjs` - ONNX Runtime Web WASM glue.
- `src/vendor/ort-wasm-simd-threaded.asyncify.wasm` - ONNX Runtime Web WASM runtime.
- `src/models/whisper-tiny.en/**` - local quantized Whisper model/tokenizer files,
  including ONNX weights under `src/models/whisper-tiny.en/onnx/`.

No remote code is loaded by the extension. `src/whisper-module-worker.js`
statically imports the vendored Transformers.js bundle, and
`src/whisper-local.js` sets Transformers.js to use local model files only.

## Local vendor patches

Two small local changes are applied to vendored runtime code to satisfy extension
review linting while preserving local WASM inference:

- Emscripten-generated `new Function(...)` method-call helpers in
  `src/vendor/transformers.min.js` and
  `src/vendor/ort-wasm-simd-threaded.asyncify.mjs` are replaced with generic
  dispatcher functions.
- The dynamic ONNX module loader helper in `src/vendor/transformers.min.js` is
  disabled because this extension uses the bundled local ONNX Runtime Web path.

## Validation

Before submission, run:

```sh
./build.sh 1.3.1
web-ext lint --source-dir dist/firefox
for test in tests/*.test.js; do node "$test" || exit; done
```
