(function injectUncensoredYouTube() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var settings = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var INJECT_VERSION = String(Date.now());
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
    window.dispatchEvent(new CustomEvent("uncensored-settings", {
      detail: JSON.stringify(settings)
    }));

    if (globalThis.UncensoredAudioInference && globalThis.UncensoredAudioInference.setOptions) {
      globalThis.UncensoredAudioInference.setOptions(settings);
    }

    if (settings.whisperEnabled && globalThis.UncensoredAudioInference && globalThis.UncensoredAudioInference.startVisibleCaptionResolver) {
      globalThis.UncensoredAudioInference.startVisibleCaptionResolver();
    }
  }

  function dispatchSettingsSoon() {
    window.setTimeout(dispatchSettings, 0);
  }

  function handleSabrSegments(segments) {
    var audioInference = globalThis.UncensoredAudioInference;

    if (settings.whisperEnabled && !document.hidden && audioInference && audioInference.setSabrAudioData) {
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
      }

      dispatchSettingsSoon();
    });
  }

  watchSettings();
  loadSettings().then(function settingsLoaded() {
    return injectScriptsSequentially(scripts);
  }).then(dispatchSettings, dispatchSettings);

  window.addEventListener("uncensored-timedtext", function rememberTimedText(event) {
    var body = event && event.detail;
    var timedText = globalThis.UncensoredTimedText;
    var audioInference = globalThis.UncensoredAudioInference;
    var tokens;

    if (typeof body !== "string" || !audioInference || !timedText.collectTimedTextTokens) {
      return;
    }

    tokens = timedText.collectTimedTextTokens(body, settings.rulesEnabled);
    if (settings.whisperEnabled && tokens.length && audioInference.rememberTimedTextTokens) {
      audioInference.rememberTimedTextTokens(tokens);
    }
  });

  window.addEventListener("message", function relaySabrAudio(event) {
    var message = event && event.data;

    if (event.source !== window || !message || message.uncensoredSabrAudio !== true) {
      return;
    }

    if (!settings.whisperEnabled || (document.hidden && message.type !== "end")) {
      acknowledgeSabrMessage(message);
      return;
    }

    acknowledgeSabrMessage(message);
    relaySabrMessage(message).then(function decodeSegments(response) {
      return handleSabrSegments(response.segments);
    }).catch(function relayFailed() {});
  });
})();
