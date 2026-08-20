(function injectUncensoredYouTube() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var sabrDecoder = globalThis.UncensoredSabrParser && globalThis.UncensoredSabrParser.createStreamDecoder();
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var INJECT_VERSION = String(Date.now());
  var audioEnabled = null;
  var hasCensoredSlots = null;
  var activeVideoId = currentVideoId();
  var scripts = [
    "src/page-hook.js",
    "src/rules-compiler.js",
    "src/rule-data/language.js",
    "src/rule-data/exact.js",
    "src/rule-data/grammar.js",
    "src/rules-data.js",
    "src/rules.js",
    "src/timedtext.js"
  ];
  if (!runtime || !runtime.runtime || !runtime.runtime.getURL) {
    return;
  }

  function debugLog(message, detail) {
    try {
      if (window.localStorage.getItem("uncensoredDebug") === "1") {
        console.debug("[uncensored] " + message + (detail ? " " + JSON.stringify(detail) : ""));
      }
    } catch (error) {}
  }

  function injectScript(path) {
    return new Promise(function inject(resolve) {
      var script = document.createElement("script");

      script.src = runtime.runtime.getURL(path) + "?v=" + encodeURIComponent(INJECT_VERSION);
      script.async = false;
      script.onload = function removeInjectedScript() {
        script.remove();
        resolve();
      };
      script.onerror = resolve;
      (document.documentElement || document.head).appendChild(script);
    });
  }

  function dispatchSettings() {
    var detail = Object.assign({}, settings, {
      audioEnabled: audioEnabled,
      videoId: activeVideoId
    });

    window.dispatchEvent(new CustomEvent("uncensored-settings", {
      detail: JSON.stringify(detail)
    }));

    if (globalThis.UncensoredAudioInference && globalThis.UncensoredAudioInference.setOptions) {
      globalThis.UncensoredAudioInference.setOptions(detail);
    }
  }

  function currentVideoId() {
    try {
      var url = new URL(window.location.href);
      var pathMatch = url.pathname.match(/^\/(?:live|shorts)\/([^/]+)/);
      if (url.pathname === "/watch") {
        var videoId = url.searchParams.get("v");
        if (videoId) return videoId;
      }
      return pathMatch ? pathMatch[1] : "";
    } catch (error) {
      return "";
    }
  }

  function syncVideo(videoId) {
    videoId = videoId || currentVideoId();
    if (videoId === activeVideoId) return;
    activeVideoId = videoId;
    audioEnabled = null;
    hasCensoredSlots = null;
    if (sabrDecoder) sabrDecoder.reset();
    updateAudioNeeded();
  }

  function updateAudioNeeded() {
    var enabled = settings.whisperEnabled && Boolean(activeVideoId) && hasCensoredSlots !== false;

    if (audioEnabled === enabled) return;
    audioEnabled = enabled;
    if (!enabled && hasCensoredSlots !== null) {
      debugLog("audio decoding stopped", { reason: "no censored captions" });
    }
    dispatchSettings();
    setExtensionHostActive(enabled);
  }

  function setExtensionHostActive(active) {
    runtime.runtime.sendMessage(active
      ? { uncensoredActive: true }
      : { uncensoredIdle: true }
    ).catch(function ignoreHostStateError() {});
  }

  function acknowledgeSabrMessage(message) {
    window.postMessage({
      uncensoredSabrAck: true,
      messageId: message.messageId
    }, "*");
  }

  function localArrayBuffer(buffer) {
    if (Object.prototype.toString.call(buffer) !== "[object ArrayBuffer]") return null;
    return globalThis.structuredClone(buffer);
  }

  function decodeSabrMessage(message) {
    if (!sabrDecoder) return [];
    if (message.buffer) {
      message = Object.assign({}, message, { buffer: localArrayBuffer(message.buffer) });
      if (!message.buffer) return [];
    }
    return sabrDecoder.push(message);
  }

  function loadSettings() {
    if (!runtime.storage || !runtime.storage.local) {
      return Promise.resolve();
    }

    return runtime.storage.local.get({
      rulesEnabled: true,
      whisperEnabled: true
    }).then(function gotSettings(values) {
      settings.rulesEnabled = values.rulesEnabled !== false;
      settings.whisperEnabled = values.whisperEnabled !== false;
    }, function keepDefaults() {});
  }

  function watchSettings() {
    if (!runtime.storage || !runtime.storage.onChanged) {
      return;
    }

    runtime.storage.onChanged.addListener(function onSettingsChanged(changes, areaName) {
      if (areaName !== "local") {
        return;
      }

      if (changes.rulesEnabled) {
        settings.rulesEnabled = changes.rulesEnabled.newValue !== false;
      }

      if (changes.whisperEnabled) {
        settings.whisperEnabled = changes.whisperEnabled.newValue !== false;
        updateAudioNeeded();
      }

      window.setTimeout(dispatchSettings, 0);
    });
  }

  watchSettings();
  loadSettings().then(function settingsLoaded() {
    return scripts.reduce(function chain(previous, path) {
      return previous.then(function injectNext() {
        return injectScript(path);
      });
    }, Promise.resolve());
  }).then(updateAudioNeeded, dispatchSettings);

  window.addEventListener("uncensored-timedtext", function rememberTimedText(event) {
    var detail = event && event.detail;
    var body = detail;
    var trackId = "";
    var timedText = globalThis.UncensoredTimedText;
    var audioInference = globalThis.UncensoredAudioInference;
    var data;

    try {
      detail = JSON.parse(detail);
      body = detail.body;
      trackId = detail.trackId || "";
      if (detail.videoId && detail.videoId !== currentVideoId()) return;
      syncVideo(detail.videoId || currentVideoId());
    } catch (error) {}

    if (typeof body !== "string" || !audioInference || !timedText.collectTimedTextData) {
      return;
    }

    data = timedText.collectTimedTextData(body, settings.rulesEnabled);
    debugLog("captions analyzed", { trackId: trackId, count: data.tokens.length });
    if (data.tokens.length) hasCensoredSlots = true;
    else if (data.parsed) hasCensoredSlots = false;
    updateAudioNeeded();
    if (audioInference.rememberTimedTextData) {
      audioInference.rememberTimedTextData(data, trackId, activeVideoId);
    }
  });

  window.addEventListener("uncensored-no-captions", function stopNoCaptionAudio(event) {
    var detail;

    try {
      detail = JSON.parse(event && event.detail);
    } catch (error) {
      return;
    }
    if (!detail || detail.videoId !== currentVideoId()) return;
    syncVideo(detail.videoId);
    hasCensoredSlots = false;
    updateAudioNeeded();
  });

  window.addEventListener("message", function relaySabrAudio(event) {
    var message = event && event.data;

    if (event.source !== window || !message || message.uncensoredSabrAudio !== true) {
      return;
    }

    if (message.videoId !== currentVideoId()) {
      acknowledgeSabrMessage(message);
      return;
    }

    if (!settings.whisperEnabled || audioEnabled !== true) {
      acknowledgeSabrMessage(message);
      return;
    }

    acknowledgeSabrMessage(message);
    try {
      var segments = decodeSabrMessage(message);
      var audioInference = globalThis.UncensoredAudioInference;
      if (audioInference && audioInference.setSabrAudioData) {
        Promise.all(segments.map(function decodeSegment(segment) {
          return audioInference.setSabrAudioData(
            Object.assign({}, segment, { videoId: message.videoId })
          );
        })).catch(function decodeFailed() {});
      }
    } catch (error) {
      debugLog("audio stream parse failed", { error: error && (error.message || String(error)) });
    }
  });

  window.addEventListener("yt-navigate-finish", function finishNavigation() {
    syncVideo(currentVideoId());
  });

  window.addEventListener("pagehide", function releaseExtensionHost() {
    setExtensionHostActive(false);
  });

})();
