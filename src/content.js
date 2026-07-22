(function injectUncensoredYouTube() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var sabrDecoder = globalThis.UncensoredSabrParser && globalThis.UncensoredSabrParser.createStreamDecoder();
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var INJECT_VERSION = String(Date.now());
  var captureAudioEnabled = null;
  var decodeAudioEnabled = false;
  var captionDecisionKnown = false;
  var videoHasCensoredSlots = false;
  var activeVideoId = currentVideoId();
  var scripts = [
    "src/page-hook.js",
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

  function injectScriptsSequentially(paths) {
    return paths.reduce(function chain(previous, path) {
      return previous.then(function injectNext() {
        return injectScript(path);
      });
    }, Promise.resolve());
  }

  function dispatchSettings() {
    var detail = Object.assign({}, settings, {
      audioNeeded: decodeAudioEnabled,
      captureAudio: captureAudioEnabled,
      videoId: activeVideoId
    });

    window.dispatchEvent(new CustomEvent("uncensored-settings", {
      detail: JSON.stringify(detail)
    }));

    if (globalThis.UncensoredAudioInference && globalThis.UncensoredAudioInference.setOptions) {
      globalThis.UncensoredAudioInference.setOptions(detail);
    }

    if (settings.whisperEnabled && globalThis.UncensoredAudioInference && globalThis.UncensoredAudioInference.startVisibleCaptionResolver) {
      globalThis.UncensoredAudioInference.startVisibleCaptionResolver();
    }
  }

  function dispatchSettingsSoon() {
    window.setTimeout(dispatchSettings, 0);
  }

  function currentVideoId() {
    try {
      var url = new URL(window.location.href);
      var pathMatch = url.pathname.match(/\/(live|shorts)\/([^/]+)/);
      return url.searchParams.get("v") || pathMatch && pathMatch[2] || "";
    } catch (error) {
      return "";
    }
  }

  function syncVideo(videoId) {
    videoId = videoId || currentVideoId();
    if (videoId === activeVideoId) return;
    activeVideoId = videoId;
    captureAudioEnabled = null;
    captionDecisionKnown = false;
    videoHasCensoredSlots = false;
    if (sabrDecoder) sabrDecoder.reset();
    updateAudioNeeded();
  }

  function updateAudioNeeded() {
    var needed = settings.whisperEnabled && Boolean(activeVideoId);
    var shouldDecode = needed && (!captionDecisionKnown || videoHasCensoredSlots);
    var decodeChanged = decodeAudioEnabled !== shouldDecode;

    if (decodeChanged) {
      decodeAudioEnabled = shouldDecode;
      if (!shouldDecode && captionDecisionKnown) {
        debugLog("audio decoding stopped", { reason: "no censored captions" });
      }
    }
    if (captureAudioEnabled === needed) {
      if (decodeChanged) dispatchSettings();
      return;
    }
    captureAudioEnabled = needed;
    dispatchSettings();
    if (needed || !settings.whisperEnabled) setExtensionHostActive(needed);
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

  function isEnglishTrack(trackId) {
    var params = new URLSearchParams(trackId || "");
    var language = params.get("tlang") || params.get("lang") || "";
    return language.split("-")[0] === "en";
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

      dispatchSettingsSoon();
    });
  }

  watchSettings();
  loadSettings().then(function settingsLoaded() {
    return injectScriptsSequentially(scripts);
  }).then(updateAudioNeeded, dispatchSettings);

  window.addEventListener("uncensored-timedtext", function rememberTimedText(event) {
    var detail = event && event.detail;
    var body = detail;
    var trackId = "";
    var savedResolutions = [];
    var timedText = globalThis.UncensoredTimedText;
    var audioInference = globalThis.UncensoredAudioInference;
    var data;

    try {
      detail = JSON.parse(detail);
      body = detail.body;
      trackId = detail.trackId || "";
      savedResolutions = detail.savedResolutions || [];
      if (detail.videoId && detail.videoId !== currentVideoId()) return;
      syncVideo(detail.videoId || currentVideoId());
    } catch (error) {}

    if (typeof body !== "string" || !audioInference || !timedText.collectTimedTextData) {
      return;
    }

    data = timedText.collectTimedTextData(body, settings.rulesEnabled);
    if (data.tokens.length) {
      captionDecisionKnown = true;
      videoHasCensoredSlots = true;
    } else if (isEnglishTrack(trackId)) {
      captionDecisionKnown = true;
    }
    updateAudioNeeded();
    if (audioInference.rememberTimedTextData) {
      audioInference.rememberTimedTextData(data, trackId, savedResolutions, activeVideoId);
    }
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

    if (!settings.whisperEnabled || captureAudioEnabled !== true) {
      acknowledgeSabrMessage(message);
      return;
    }

    acknowledgeSabrMessage(message);
    try {
      var segments = decodeSabrMessage(message);
      var audioInference = globalThis.UncensoredAudioInference;
      if (decodeAudioEnabled && audioInference && audioInference.setSabrAudioData) {
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
