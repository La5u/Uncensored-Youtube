(function runUncensoredBackground(root) {
  "use strict";

  var runtime = root.browser || root.chrome;
  if (!runtime || !runtime.runtime) {
    return;
  }

  // ── Whisper worker relay ──

  var whisperWorker = null;
  var whisperReady = null;
  var whisperNextId = 1;
  var whisperPending = new Map();
  var sabrWorker = null;
  var sabrNextId = 1;
  var sabrPending = new Map();

  function resetWhisperWorker(message) {
    var error = new Error(message || "Worker error");
    var worker = whisperWorker;

    whisperWorker = null;
    whisperReady = null;
    if (worker) {
      worker.terminate();
    }
    whisperPending.forEach(function rejectPending(reject) {
      reject(error);
    });
    whisperPending.clear();
  }

  function startWhisperWorker() {
    if (whisperReady) return whisperReady;
    whisperReady = new Promise(function createWorker(resolve, reject) {
      var url = runtime.runtime.getURL("src/whisper-module-worker.js");
      try {
        whisperWorker = new Worker(url, { type: "module" });
      } catch (error) {
        whisperReady = null;
        reject(error);
        return;
      }
      var worker = whisperWorker;
      worker.onmessage = function onWorkerMessage(event) {
        var message = event.data || {};
        var pending = whisperPending.get(message.id);
        if (pending) {
          whisperPending.delete(message.id);
          pending(message.ok ? (message.decision || message) : new Error(message.error || "Worker failed"));
        }
      };
      worker.onerror = function onWorkerError() {
        if (whisperWorker === worker) {
          resetWhisperWorker("Worker error");
        }
      };
      resolve(worker);
    });
    return whisperReady;
  }

  function postToWorker(type, data, transfer, timeoutMs) {
    var id = whisperNextId;
    whisperNextId += 1;
    return startWhisperWorker().then(function workerReady(worker) {
      return new Promise(function waitForResponse(resolve, reject) {
        var timeout = setTimeout(function workerTimedOut() {
          resetWhisperWorker("Worker timed out");
        }, timeoutMs || 60000);
        whisperPending.set(id, function handleResponse(value) {
          clearTimeout(timeout);
          if (value instanceof Error) {
            reject(value);
          } else {
            resolve(value);
          }
        });
        worker.postMessage(Object.assign({ id: id, type: type }, data), transfer || []);
      });
    });
  }

  function startSabrWorker() {
    if (!sabrWorker) {
      sabrWorker = new Worker(runtime.runtime.getURL("src/sabr-worker.js"));
      sabrWorker.onmessage = function onSabrMessage(event) {
        var message = event.data || {};
        var pending = sabrPending.get(message.id);

        if (pending) {
          pending(message);
        }
      };
      sabrWorker.onerror = function onSabrError() {
        sabrWorker = null;
        sabrPending.forEach(function failPending(pending) {
          pending({ segments: [] });
        });
      };
    }

    return sabrWorker;
  }

  function postToSabr(message, sender) {
    var id = sabrNextId;
    var streamId = [
      sender && sender.tab ? sender.tab.id : 0,
      sender && typeof sender.frameId === "number" ? sender.frameId : 0,
      message.streamId
    ].join(":");

    sabrNextId += 1;
    return new Promise(function waitForSabr(resolve) {
      var timeout = setTimeout(function sabrTimedOut() {
        sabrPending.delete(id);
        resolve({ segments: [] });
      }, 60000);

      sabrPending.set(id, function resolveSabr(response) {
        clearTimeout(timeout);
        sabrPending.delete(id);
        resolve(response);
      });
      startSabrWorker().postMessage(Object.assign({}, message, {
        id: id,
        streamId: streamId
      }), message.buffer ? [message.buffer] : []);
    });
  }

  if (runtime.runtime && runtime.runtime.onMessage) {
    runtime.runtime.onMessage.addListener(function onWhisperMessage(message, sender, sendResponse) {
      if (!message) return;

      if (message.uncensoredSabr && message.data) {
        postToSabr(message.data, sender).then(function parsed(result) {
          sendResponse(result);
        });
        return true;
      }

      if (!message.uncensoredWhisper) return;

      if (message.type === "warmup") {
        startWhisperWorker().then(function ready() {
          sendResponse({ ok: true });
        }, function failed() {
          sendResponse({ ok: false });
        });
        return true;
      }

      if (message.type === "preload" || message.type === "transcribe") {
        var transfer = message.type === "transcribe" && message.data && message.data.audio
          ? [message.data.audio] : null;
        postToWorker(message.type, message.data, transfer,
          message.type === "preload" ? 30000 : 60000
        ).then(function resolved(result) {
          sendResponse(result);
        }, function failed(error) {
          sendResponse({ error: error && (error.message || String(error)) });
        });
        return true;
      }
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
