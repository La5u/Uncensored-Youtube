(function runWhisperHost(root) {
  "use strict";

  var runtime = root.browser || root.chrome;
  var worker = null;
  var pending = new Map();

  function workerUrl() {
    return runtime && runtime.runtime && runtime.runtime.getURL
      ? runtime.runtime.getURL("src/whisper-module-worker.js")
      : "whisper-module-worker.js";
  }

  function postToParent(payload) {
    root.parent.postMessage(Object.assign({
      uncensoredWhisperHost: true
    }, payload), "*");
  }

  function postStatus(message) {
    postToParent({
      type: "status",
      ok: true,
      message: message
    });
  }

  function rejectAll(message) {
    pending.forEach(function rejectPending(id) {
      postToParent({
        id: id,
        ok: false,
        error: message
      });
    });
    pending.clear();
  }

  function ensureWorker() {
    if (worker) {
      return worker;
    }

    worker = new Worker(workerUrl(), {
      type: "module"
    });
    postStatus("worker created");
    worker.onmessage = function onWorkerMessage(event) {
      var message = event.data || {};

      pending.delete(message.id);
      postToParent(message);
    };
    worker.onerror = function onWorkerError(error) {
      var message = error && error.message ? error.message : "Whisper host worker error";

      postStatus(message);
      rejectAll(message);
      try {
        worker.terminate();
      } catch (terminateError) {}
      worker = null;
    };

    return worker;
  }

  root.addEventListener("message", function onParentMessage(event) {
    var message = event.data || {};

    if (!message.uncensoredWhisperHostRequest || !message.id) {
      return;
    }

    pending.set(message.id, message.id);
    try {
      postStatus("request " + message.type);
      ensureWorker().postMessage({
        id: message.id,
        type: message.type,
        audio: message.audio,
        candidates: message.candidates,
        context: message.context,
        options: message.options
      }, message.audio ? [message.audio] : []);
    } catch (error) {
      pending.delete(message.id);
      postToParent({
        id: message.id,
        ok: false,
        error: error && (error.message || String(error))
      });
    }
  });

  postToParent({
    type: "ready",
    ok: true
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
