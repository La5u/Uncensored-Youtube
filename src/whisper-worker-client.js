(function buildWhisperWorkerClient() {
  "use strict";
  var root = typeof globalThis !== "undefined" ? globalThis : this;

  var runtime = root.browser || root.chrome;
  var nextId = 1;
  var hostFrame = null;
  var hostReadyPromise = null;
  var preloadPromise = null;
  var warmupPromise = null;
  var loggedHostStatuses = Object.create(null);

  function debugEnabled() {
    try {
      return root.localStorage && root.localStorage.getItem("uncensoredDebug") === "1";
    } catch (error) {
      return false;
    }
  }

  function debugLog() {
    if (!debugEnabled() || !root.console || !root.console.debug) {
      return;
    }

    root.console.debug.apply(root.console, ["[uncensored]"].concat(Array.prototype.slice.call(arguments)));
  }

  function hostUrl() {
    if (runtime && runtime.runtime && runtime.runtime.getURL) {
      return runtime.runtime.getURL("src/whisper-host.html");
    }

    return "src/whisper-host.html";
  }

  function ensureHostFrame() {
    if (hostReadyPromise) {
      return hostReadyPromise;
    }

    hostReadyPromise = new Promise(function waitForHost(resolve, reject) {
      var timeout;

      if (!root.document || !root.document.documentElement) {
        reject(new Error("Whisper host frame unavailable"));
        return;
      }

      debugLog("creating whisper host frame");
      hostFrame = root.document.createElement("iframe");
      hostFrame.src = hostUrl();
      hostFrame.style.cssText = "position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;";
      hostFrame.setAttribute("aria-hidden", "true");

      function cleanup() {
        root.clearTimeout(timeout);
        root.removeEventListener("message", onHostReady);
      }

      function onHostReady(event) {
        var message = event.data || {};

        if (event.source !== hostFrame.contentWindow || !message.uncensoredWhisperHost || message.type !== "ready") {
          return;
        }

        cleanup();
        debugLog("whisper host frame ready");
        resolve(hostFrame);
      }

      timeout = root.setTimeout(function hostTimeout() {
        cleanup();
        hostReadyPromise = null;
        reject(new Error("Whisper host frame timed out"));
      }, 10000);

      root.addEventListener("message", onHostReady);
      root.document.documentElement.appendChild(hostFrame);
    });

    return hostReadyPromise;
  }

  function hostRequest(message, transfer) {
    return ensureHostFrame().then(function sendToHost(frame) {
      return new Promise(function waitForHostResponse(resolve, reject) {
        var id = nextId;
        var timeout;

        nextId += 1;
        timeout = root.setTimeout(function hostRequestTimeout() {
          root.removeEventListener("message", onHostMessage);
          reject(new Error("Whisper host timed out"));
        }, message && message.type === "preload" ? 30000 : 60000);

        function cleanup() {
          root.clearTimeout(timeout);
          root.removeEventListener("message", onHostMessage);
        }

        function onHostMessage(event) {
          var response = event.data || {};

          if (event.source === frame.contentWindow && response.uncensoredWhisperHost && response.type === "status") {
            if (!loggedHostStatuses[response.message || ""]) {
              loggedHostStatuses[response.message || ""] = true;
              debugLog("whisper host", response.message || "");
            }
            return;
          }

          if (event.source !== frame.contentWindow || !response.uncensoredWhisperHost || response.id !== id) {
            return;
          }

          cleanup();
          if (response.ok) {
            resolve(response.decision || response);
          } else {
            reject(new Error(response.error || "Whisper host failed"));
          }
        }

        root.addEventListener("message", onHostMessage);
        frame.contentWindow.postMessage(Object.assign({
          id: id,
          uncensoredWhisperHostRequest: true
        }, message), "*");
      });
    });
  }

  function emptyDecision(options) {
    return {
      word: "",
      score: 0,
      runnerUpScore: 0,
      transcript: "",
      forced: Boolean(options && options.force)
    };
  }

  function preload() {
    if (!preloadPromise) {
      preloadPromise = hostRequest({ type: "preload" }).then(function preloaded() {
        debugLog("whisper host ready");
        return true;
      }, function failed(error) {
        debugLog("whisper host preload failed", error && (error.message || String(error)));
        return false;
      });
    }

    return preloadPromise;
  }

  function warmup() {
    if (!warmupPromise) {
      warmupPromise = hostRequest({ type: "warmup" }).then(function warmed() {
        return true;
      }, function failed(error) {
        debugLog("whisper host warmup failed", error && (error.message || String(error)));
        return false;
      });
    }

    return warmupPromise;
  }

  function transcribeDetailed(audio, candidates, context, options) {
    if (!audio || !audio.length || !candidates || !candidates.length) {
      return Promise.resolve(emptyDecision(options));
    }

    var copy = audio.slice();

    return hostRequest({
      type: "transcribe",
      audio: copy.buffer,
      candidates: candidates,
      context: context,
      options: options
    }).catch(function hostFailed(hostError) {
      debugLog("whisper host transcription failed", hostError && (hostError.message || String(hostError)));
      return emptyDecision(options);
    });
  }

  function transcribe(audio, candidates, context) {
    return transcribeDetailed(audio, candidates, context).then(function wordOnly(decision) {
      return decision.word;
    });
  }

  var exports = Object.freeze({
    warmup: warmup,
    preload: preload,
    transcribe: transcribe,
    transcribeDetailed: transcribeDetailed
  });

  root.UncensoredWhisperLocal = exports;
  if (typeof module === "object" && module.exports) {
    module.exports = exports;
  }
})();
