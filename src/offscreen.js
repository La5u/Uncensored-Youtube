(function runOffscreenHost(root) {
  "use strict";

  var runtime = root.browser || root.chrome;
  var workers = Object.create(null);
  var pending = new Map();
  var nextId = 1;

  function failWorker(kind, error) {
    var worker = workers[kind];
    delete workers[kind];
    if (worker) worker.terminate();
    pending.forEach(function fail(request, id) {
      if (request.kind !== kind) return;
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(new Error(error || kind + " worker failed"));
    });
  }

  function getWorker(kind) {
    if (workers[kind]) return workers[kind];

    var file = kind === "whisper" ? "src/whisper-module-worker.js" : "src/sabr-worker.js";
    var worker = new Worker(runtime.runtime.getURL(file), kind === "whisper" ? { type: "module" } : undefined);
    worker.onmessage = function workerMessage(event) {
      var message = event.data || {};
      var request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.ok === false) {
        request.reject(new Error(message.error || kind + " worker failed"));
      } else {
        request.resolve(message.decision || message);
      }
    };
    worker.onerror = function workerError(event) {
      failWorker(kind, event && event.message);
    };
    workers[kind] = worker;
    return worker;
  }

  function request(kind, message, transfer, timeoutMs) {
    var id = nextId;
    nextId += 1;
    return new Promise(function waitForWorker(resolve, reject) {
      var timer = setTimeout(function timedOut() {
        failWorker(kind, kind + " worker timed out");
      }, timeoutMs);
      pending.set(id, { kind: kind, resolve: resolve, reject: reject, timer: timer });
      try {
        getWorker(kind).postMessage(Object.assign({ id: id }, message), transfer || []);
      } catch (error) {
        failWorker(kind, error && (error.message || String(error)));
      }
    });
  }

  runtime.runtime.onMessage.addListener(function offscreenMessage(message, sender, sendResponse) {
    if (!message || !message.uncensoredOffscreen) return;

    var data = message.data || {};
    var task;
    if (message.kind === "whisper") {
      task = request("whisper", Object.assign({ type: data.type }, data.data || {}),
        data.type === "transcribe" && data.data && data.data.audio ? [data.data.audio] : [],
        data.type === "preload" ? 30000 : 60000);
    } else if (message.kind === "sabr") {
      task = request("sabr", data, data.buffer ? [data.buffer] : [], 60000);
    } else {
      return;
    }

    task.then(sendResponse, function failed(error) {
      sendResponse({ error: error && (error.message || String(error)), segments: [] });
    });
    return true;
  });
})(globalThis);
