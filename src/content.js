(function injectUncensoredYouTube() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var INJECT_VERSION = String(Date.now());
  var audioNeeded = null;
  var hasCensoredSlots = false;
  var activeVideoId = "";
  var scripts = [
    "src/page-hook.js",
    "src/rules.js",
    "src/timedtext.js"
  ];
  if (!runtime || !runtime.runtime || !runtime.runtime.getURL) {
    return;
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
    var detail = Object.assign({}, settings, { audioNeeded: audioNeeded, videoId: activeVideoId });

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
    hasCensoredSlots = false;
    audioNeeded = null;
    dispatchSettingsSoon();
  }

  function updateAudioNeeded() {
    var needed = settings.whisperEnabled && hasCensoredSlots;

    if (audioNeeded === needed) return;
    audioNeeded = needed;
    dispatchSettings();
    if (needed) {
      runtime.runtime.sendMessage({ uncensoredActive: true }).catch(function ignoreHostStateError() {});
    }
  }

  function handleSabrSegments(segments) {
    var audioInference = globalThis.UncensoredAudioInference;

    if (settings.whisperEnabled && audioNeeded === true && audioInference && audioInference.setSabrAudioData) {
      return Promise.all((segments || []).map(audioInference.setSabrAudioData));
    }

    return Promise.resolve();
  }

  function acknowledgeSabrMessage(message) {
    window.postMessage({
      uncensoredSabrAck: true,
      messageId: message.messageId
    }, "*");
  }

  function relaySabrMessage(message) {
    return runtime.runtime.sendMessage({
      uncensoredSabr: true,
      data: message
    }).then(function returnSegments(response) {
      return response || { segments: [] };
    });
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
  }).then(dispatchSettings, dispatchSettings);

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
      syncVideo(detail.videoId || currentVideoId());
    } catch (error) {}

    if (typeof body !== "string" || !audioInference || !timedText.collectTimedTextData) {
      return;
    }

    data = timedText.collectTimedTextData(body, settings.rulesEnabled);
    hasCensoredSlots = hasCensoredSlots || Boolean(data.tokens.length);
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

    if (!settings.whisperEnabled || audioNeeded !== true) {
      acknowledgeSabrMessage(message);
      return;
    }

    acknowledgeSabrMessage(message);
    relaySabrMessage(message).then(function decodeSegments(response) {
      return handleSabrSegments((response.segments || []).map(function tagSegment(segment) {
        return Object.assign({}, segment, { videoId: message.videoId });
      }));
    }).catch(function relayFailed() {});
  });

  window.addEventListener("yt-navigate-finish", function finishNavigation() {
    syncVideo(currentVideoId());
    dispatchSettingsSoon();
  });

  window.addEventListener("pagehide", function releaseExtensionHost() {
    runtime.runtime.sendMessage({ uncensoredIdle: true }).catch(function ignoreIdleError() {});
  });

})();
