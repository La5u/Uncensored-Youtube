(function runUncensoredBackground(root) {
  "use strict";

  var runtime = root.browser || root.chrome;
  if (!runtime || !runtime.runtime) {
    return;
  }

  var manifestBackground = runtime.runtime.getManifest().background || {};
  var useOffscreen = Boolean(manifestBackground.service_worker);
  var offscreen = root.chrome && root.chrome.offscreen || runtime.offscreen;
  var offscreenReady = null;
  var offscreenClosing = null;
  var activeTabs = new Set();

  function senderTabId(sender) {
    return sender && sender.tab && sender.tab.id;
  }

  function ensureOffscreen() {
    if (offscreenClosing) {
      return offscreenClosing.then(ensureOffscreen);
    }
    if (offscreenReady) return offscreenReady;

    var url = runtime.runtime.getURL("src/offscreen.html");
    offscreenReady = runtime.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url]
    }).then(function createIfMissing(contexts) {
      if (contexts.length) return;
      return offscreen.createDocument({
        url: "src/offscreen.html",
        reasons: ["WORKERS"],
        justification: "Run local Whisper inference"
      });
    }).catch(function resetOffscreen(error) {
      offscreenReady = null;
      throw error;
    });
    return offscreenReady;
  }

  function postOffscreen(kind, data) {
    return ensureOffscreen().then(function ready() {
      return runtime.runtime.sendMessage({
        uncensoredOffscreen: true,
        kind: kind,
        data: data
      }).catch(function resetAfterDeliveryFailure(error) {
        offscreenReady = null;
        throw error;
      });
    });
  }

  // ── Whisper worker relay ──

  var whisperWorker = null;
  var whisperNextId = 1;
  var whisperPending = new Map();

  function closeIdleHost() {
    if (activeTabs.size || offscreenClosing) return;
    if (!useOffscreen) {
      if (whisperWorker || whisperPending.size) resetWhisperWorker("Extension host stopped");
      return;
    }

    offscreenReady = null;
    offscreenClosing = runtime.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [runtime.runtime.getURL("src/offscreen.html")]
    }).then(function closeExisting(contexts) {
      if (!contexts.length) return;
      return runtime.runtime.sendMessage({
        uncensoredOffscreen: true,
        kind: "shutdown"
      }).catch(function ignoreShutdownError() {}).then(function closeDocument() {
        return offscreen.closeDocument();
      });
    }).catch(function ignoreCloseError() {}).finally(function closed() {
      offscreenClosing = null;
    });
  }

  function resetWhisperWorker(message) {
    var error = new Error(message || "Worker error");
    var worker = whisperWorker;

    whisperWorker = null;
    if (worker) {
      worker.terminate();
    }
    whisperPending.forEach(function rejectPending(reject) {
      reject(error);
    });
    whisperPending.clear();
  }

  function startWhisperWorker() {
    if (whisperWorker) return Promise.resolve(whisperWorker);
    try {
      whisperWorker = new Worker(runtime.runtime.getURL("src/whisper-module-worker.js"), { type: "module" });
    } catch (error) {
      return Promise.reject(error);
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
      if (whisperWorker === worker) resetWhisperWorker("Worker error");
    };
    return Promise.resolve(worker);
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

  if (runtime.runtime.onMessage) {
    runtime.runtime.onMessage.addListener(function onWhisperMessage(message, sender, sendResponse) {
      if (!message) return;

      if (message.uncensoredIdle) {
        var idleTabId = senderTabId(sender);
        activeTabs.delete(idleTabId);
        closeIdleHost();
        sendResponse({ ok: true });
        return;
      }

      if (message.uncensoredActive) {
        var activeTabId = senderTabId(sender);
        if (typeof activeTabId === "number") activeTabs.add(activeTabId);
        sendResponse({ ok: true });
        return;
      }

      if (!message.uncensoredWhisper) return;
      var whisperTabId = senderTabId(sender);
      if (typeof whisperTabId === "number") activeTabs.add(whisperTabId);

      if (useOffscreen) {
        postOffscreen("whisper", {
          type: message.type,
          data: message.data
        }).then(sendResponse, function failed(error) {
          sendResponse({ error: error && (error.message || String(error)) });
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

  var tabs = root.chrome && root.chrome.tabs || runtime.tabs;
  if (tabs && tabs.onRemoved) {
    tabs.onRemoved.addListener(function tabRemoved(tabId) {
      activeTabs.delete(tabId);
      closeIdleHost();
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
