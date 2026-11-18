(function injectUncensoredYouTube() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var sabrDecoder = globalThis.UncensoredSabrParser && globalThis.UncensoredSabrParser.createStreamDecoder();
  // Popup modes (off: the popup switch): [rulesEnabled, whisperEnabled, whisperFirst].
  var MODE_SETTINGS = {
    off: [false, false, false],
    rules: [true, false, false],
    "rules-first": [true, true, false],
    "whisper-first": [true, true, true],
    whisper: [false, true, false]
  };
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true,
    whisperFirst: false,
    acousticHead: true
  };
  // Automatic: the mode measured on this device (audio-capture.js), applied only at video start
  // so words never switch mid-video.
  var storedMode = { mode: null };
  var autoMode = "rules-first";
  var INJECT_VERSION = String(Date.now());
  var audioEnabled = null;
  var hasCensoredSlots = null;
  var rawTrack = null;
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

  function dispatchSettings(data) {
    var detail = Object.assign({}, settings, {
      audioEnabled: audioEnabled,
      videoId: activeVideoId
    });

    window.dispatchEvent(new CustomEvent("uncensored-settings", {
      detail: JSON.stringify(detail)
    }));

    if (globalThis.UncensoredAudioInference && globalThis.UncensoredAudioInference.setOptions) {
      globalThis.UncensoredAudioInference.setOptions(detail, data, data && rawTrack.trackId);
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
    rawTrack = null;
    applyMode(storedMode);
    audioEnabled = null;
    hasCensoredSlots = null;
    if (sabrDecoder) sabrDecoder.reset();
    updateAudioNeeded();
  }

  function updateAudioNeeded(data, forceSettings) {
    var enabled = settings.whisperEnabled && Boolean(activeVideoId) && hasCensoredSlots !== false;

    if (audioEnabled === enabled) {
      if (forceSettings) dispatchSettings(data);
      else if (data) globalThis.UncensoredAudioInference.rememberTimedTextData(data, rawTrack.trackId, activeVideoId);
      return;
    }
    audioEnabled = enabled;
    // End messages are dropped while disabled, so open streams would hold parser slots.
    if (!enabled && sabrDecoder) sabrDecoder.reset();
    if (!enabled && hasCensoredSlots !== null) {
      debugLog("audio decoding stopped", { reason: "no censored captions" });
    }
    dispatchSettings(data);
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
      enabled: true,
      mode: null,
      rulesEnabled: true,
      whisperEnabled: true,
      acousticHead: true,
      autoMode: autoMode
    }).then(function loaded(values) {
      storedMode = values;
      autoMode = values.autoMode;
      applyMode(values);
      settings.acousticHead = values.acousticHead !== false;
    }, function keepDefaults() {});
  }

  // The on/off switch is `enabled`. Older settings stored mode "off" or (before 1.6) two
  // switches; both switches off means disabled, both on (or nothing stored) means Automatic.
  function applyMode(values) {
    var chosen = MODE_SETTINGS[values.mode] || values.mode === "auto";
    var mode = values.enabled === false || values.mode === "off" ||
        !chosen && values.rulesEnabled === false && values.whisperEnabled === false ? "off"
      : chosen ? values.mode
        : values.rulesEnabled === false ? "whisper" : values.whisperEnabled === false ? "rules" : "auto";

    if (mode === "auto") mode = MODE_SETTINGS[autoMode] ? autoMode : "rules-first";

    settings.rulesEnabled = MODE_SETTINGS[mode][0];
    settings.whisperEnabled = MODE_SETTINGS[mode][1];
    settings.whisperFirst = MODE_SETTINGS[mode][2];
  }

  function watchSettings() {
    if (!runtime.storage || !runtime.storage.onChanged) {
      return;
    }

    runtime.storage.onChanged.addListener(function onSettingsChanged(changes, areaName) {
      if (areaName !== "local") {
        return;
      }

      if (changes.autoMode) autoMode = changes.autoMode.newValue;
      if (!changes.enabled && !changes.mode && !changes.acousticHead) {
        return;
      }

      if (changes.enabled || changes.mode) {
        if (changes.enabled) storedMode.enabled = changes.enabled.newValue;
        if (changes.mode) storedMode.mode = changes.mode.newValue;
        applyMode(storedMode);
      }
      if (changes.acousticHead) settings.acousticHead = changes.acousticHead.newValue !== false;
      updateAudioNeeded(analyzeTrack(), true);
    });
  }

  watchSettings();
  loadSettings().then(function settingsLoaded() {
    return scripts.reduce(function chain(previous, path) {
      return previous.then(function injectNext() {
        return injectScript(path);
      });
    }, Promise.resolve());
  }).then(function scriptsInjected() {
    // Navigation may have changed the audio decision before the page hook existed, so
    // updateAudioNeeded() can return early; always hand the hook the current settings.
    updateAudioNeeded(analyzeTrack(), true);
  }, function scriptsFailed() { dispatchSettings(); });

  function analyzeTrack() {
    var timedText = globalThis.UncensoredTimedText;
    var audioInference = globalThis.UncensoredAudioInference;

    if (!rawTrack || rawTrack.rulesEnabled === settings.rulesEnabled ||
        !settings.rulesEnabled && !settings.whisperEnabled ||
        !audioInference || !timedText || !timedText.collectTimedTextData) return;

    var data = timedText.collectTimedTextData(rawTrack.body, settings.rulesEnabled);
    rawTrack.rulesEnabled = settings.rulesEnabled;
    if (!data.parsed) return;
    data.captionRevision = rawTrack.captionRevision;
    debugLog("captions analyzed", { trackId: rawTrack.trackId, count: data.tokens.length });
    hasCensoredSlots = data.tokens.length > 0;
    return data;
  }

  window.addEventListener("uncensored-timedtext", function rememberTimedText(event) {
    var detail = event && event.detail;
    var track = { body: detail, trackId: "" };

    try {
      detail = JSON.parse(detail);
      if (detail.videoId && detail.videoId !== currentVideoId()) return;
      syncVideo(detail.videoId || currentVideoId());
      track = { body: detail.body, trackId: detail.trackId || "", captionRevision: detail.captionRevision };
    } catch (error) {}

    if (typeof track.body !== "string") return;
    rawTrack = track;
    var data = analyzeTrack();
    if (data) updateAudioNeeded(data);
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
