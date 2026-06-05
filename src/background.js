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
      whisperWorker.onmessage = function onWorkerMessage(event) {
        var message = event.data || {};
        var pending = whisperPending.get(message.id);
        if (pending) {
          whisperPending.delete(message.id);
          clearTimeout(pending.timeout);
          pending(message.ok ? (message.decision || message) : new Error(message.error || "Worker failed"));
        }
      };
      whisperWorker.onerror = function onWorkerError() {
        whisperWorker = null;
        whisperReady = null;
        whisperPending.forEach(function rejectPending(reject) { reject(new Error("Worker error")); });
        whisperPending.clear();
      };
      resolve(whisperWorker);
    });
    return whisperReady;
  }

  function postToWorker(type, data, transfer, timeoutMs) {
    var id = whisperNextId;
    whisperNextId += 1;
    return startWhisperWorker().then(function workerReady(worker) {
      return new Promise(function waitForResponse(resolve, reject) {
        var timeout = setTimeout(function workerTimedOut() {
          whisperPending.delete(id);
          reject(new Error("Worker timed out"));
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

  if (runtime.runtime && runtime.runtime.onMessage) {
    runtime.runtime.onMessage.addListener(function onWhisperMessage(message, sender, sendResponse) {
      if (!message || !message.uncensoredWhisper) return;

      if (message.type === "warmup") {
        startWhisperWorker().then(function ready() {
          sendResponse({ ok: true });
        }, function failed() {
          sendResponse({ ok: false });
        });
        return true;
      }

      if (message.type === "preload" || message.type === "transcribe") {
        postToWorker(message.type, message.data, message.data && message.data.audio ? [message.data.audio] : null,
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
