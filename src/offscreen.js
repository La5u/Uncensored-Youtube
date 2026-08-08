(function runOffscreenHost(root) {
  "use strict";

  var runtime = root.browser || root.chrome;
  var worker = null;
  var pending = new Map();
  var nextId = 1;

  function stopWorker(error) {
    if (worker) worker.terminate();
    worker = null;
    pending.forEach(function fail(request) {
      clearTimeout(request.timer);
      request.reject(new Error(error || "Whisper worker failed"));
    });
    pending.clear();
  }

  function getWorker() {
    var created;

    if (worker) return worker;

    worker = new Worker(runtime.runtime.getURL("src/whisper-module-worker.js"), { type: "module" });
    created = worker;
    created.onmessage = function workerMessage(event) {
      var message = event.data || {};
      var request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.ok === false) {
        request.reject(new Error(message.error || "Whisper worker failed"));
      } else {
        request.resolve(message.decision || message);
      }
    };
    created.onerror = function workerError(event) {
      if (worker === created) stopWorker(event && event.message);
    };
    return created;
  }

  function request(message, transfer, timeoutMs) {
    var id = nextId;
    nextId += 1;
    return new Promise(function waitForWorker(resolve, reject) {
      var timer = setTimeout(function timedOut() {
        stopWorker("Whisper worker timed out");
      }, timeoutMs);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        getWorker().postMessage(Object.assign({ id: id }, message), transfer || []);
      } catch (error) {
        stopWorker(error && (error.message || String(error)));
      }
    });
  }

  runtime.runtime.onMessage.addListener(function offscreenMessage(message, sender, sendResponse) {
    if (!message || !message.uncensoredOffscreen) return;

    if (message.kind === "shutdown") {
      stopWorker("Extension host stopped");
      sendResponse({ ok: true });
      return;
    }
    if (message.kind !== "whisper") return;

    var data = message.data || {};
    request(Object.assign({ type: data.type }, data.data || {}),
      data.type === "transcribe" && data.data && data.data.audio ? [data.data.audio] : [],
      data.type === "preload" ? 30000 : 60000
    ).then(sendResponse, function failed(error) {
      sendResponse({ error: error && (error.message || String(error)) });
    });
    return true;
  });
})(globalThis);
