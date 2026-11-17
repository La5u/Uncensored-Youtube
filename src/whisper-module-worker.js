import "./whisper-local.js";
import "./acoustic-head.js";

(function runWhisperModuleWorker(root) {
  "use strict";

  var whisper = root.UncensoredWhisperLocal;
  var inferenceQueue = Promise.resolve();

  var runtimeReady = import("./vendor/transformers.min.js").then(function loaded(transformers) {
    root.transformers = transformers;
  });
  // Acoustic head weights: { model, error }; model null (Whisper alone) if they fail to load.
  var headReady = root.UncensoredAcousticHead.load(new URL("./models/acoustic-head-cnn.bin", import.meta.url).href);

  function post(id, payload) {
    root.postMessage(Object.assign({ id: id }, payload));
  }

  function enqueue(task) {
    function run() {
      return runtimeReady.then(task);
    }
    var result = inferenceQueue.then(run, run);
    inferenceQueue = result.catch(function keepQueueAlive() {});
    return result;
  }

  root.onmessage = function onWorkerMessage(event) {
    var message = event.data || {};

    if (!whisper) {
      post(message.id, { ok: false, error: "Whisper runtime unavailable" });
      return;
    }
    if (message.type === "preload") {
      enqueue(function preload() {
        return whisper.preload().then(function withHead() { return headReady; });
      }).then(function ready(head) {
        // Reported to the page's debug log.
        post(message.id, { ok: true, ready: true, acousticHead: head.model ? "loaded" : "unavailable: " + head.error });
      }, function failed(error) {
        post(message.id, {
          ok: false,
          error: error && (error.message || String(error))
        });
      });
      return;
    }

    if (message.type === "transcribe") {
      enqueue(function transcribe() {
        return headReady.then(function withHead(loaded) {
          var head = loaded.model;
          var options = message.options || {};
          return whisper.transcribeDetailed(
            new Float32Array(message.audio),
            message.candidates,
            message.context,
            Object.assign({}, options, { acousticHead: options.acousticHead === false ? null : head })
          );
        });
      }).then(function resolved(decision) {
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
