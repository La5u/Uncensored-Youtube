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
    dispatchSettings();
    window.setTimeout(dispatchSettings, 100);
    window.setTimeout(dispatchSettings, 500);
  }

  function loadSettings() {
    if (!runtime.storage || !runtime.storage.local) {
      dispatchSettingsSoon();
      return;
    }

    runtime.storage.local.get({
      rulesEnabled: true,
      whisperEnabled: true
    }).then(function gotSettings(values) {
      settings.rulesEnabled = values.rulesEnabled !== false;
      settings.whisperEnabled = values.whisperEnabled !== false;
      dispatchSettingsSoon();
    }, dispatchSettingsSoon);

    if (runtime.storage.onChanged) {
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
  }

  injectScriptsSequentially(scripts).then(dispatchSettingsSoon);
  loadSettings();

  window.addEventListener("uncensored-timedtext", function rememberTimedText(event) {
    var body = event && event.detail;
    var timedText = globalThis.UncensoredTimedText;
    var audioInference = globalThis.UncensoredAudioInference;
    var tokens;

    if (typeof body !== "string" || !timedText || !audioInference || !timedText.collectTimedTextTokens) {
      return;
    }

    tokens = timedText.collectTimedTextTokens(body, settings.rulesEnabled);
    if (settings.whisperEnabled && tokens.length && audioInference.rememberTimedTextTokens) {
      audioInference.rememberTimedTextTokens(tokens);
    }
  });

  window.addEventListener("uncensored-sabr-audio", function rememberSabrAudio(event) {
    var audioInference = globalThis.UncensoredAudioInference;
    var detail = event && event.detail;

    if (settings.whisperEnabled && typeof detail === "string" && audioInference && audioInference.setSabrAudioData) {
      audioInference.setSabrAudioData(detail);
    }
  });
})();
