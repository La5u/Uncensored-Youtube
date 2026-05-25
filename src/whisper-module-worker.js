import "./whisper-local.js";

(function runWhisperModuleWorker(root) {
  "use strict";

  var whisper = root.UncensoredWhisperLocal;

  function post(id, payload) {
    root.postMessage(Object.assign({ id: id }, payload));
  }

  root.onmessage = function onWorkerMessage(event) {
    var message = event.data || {};

    if (!whisper) {
      post(message.id, {
        ok: false,
        error: "Whisper runtime unavailable"
      });
      return;
    }

    if (message.type === "warmup") {
      post(message.id, { ok: true, ready: true });
      return;
    }

    if (message.type === "preload") {
      whisper.preload().then(function ready() {
        post(message.id, { ok: true, ready: true });
      }, function failed(error) {
        post(message.id, {
          ok: false,
          error: error && (error.message || String(error))
        });
      });
      return;
    }

    if (message.type === "transcribe") {
      whisper.transcribeDetailed(
        new Float32Array(message.audio),
        message.candidates,
        message.context,
        message.options
      ).then(function resolved(decision) {
        post(message.id, {
          ok: true,
          decision: decision
        });
      }, function failed(error) {
        post(message.id, {
          ok: false,
          error: error && (error.message || String(error))
        });
      });
    }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
