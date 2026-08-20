(function initPopup() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var storage = runtime.storage.local;
  var defaults = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var metrics = {
    hybrid: { precision: "92.1", coverage: "90.9" },
    rules: { precision: "89.9", coverage: "40.2" },
    whisper: { precision: "94.5", coverage: "91.2" },
    disabled: { precision: "", coverage: "0.0" }
  };

  function element(id) {
    return document.getElementById(id);
  }

  function setControls(values) {
    element("rulesEnabled").checked = values.rulesEnabled !== false;
    element("whisperEnabled").checked = values.whisperEnabled !== false;
    updateMetrics();
  }

  function updateMetrics() {
    var rulesEnabled = element("rulesEnabled").checked;
    var whisperEnabled = element("whisperEnabled").checked;
    var mode = rulesEnabled && whisperEnabled ? "hybrid"
      : rulesEnabled ? "rules" : whisperEnabled ? "whisper" : "disabled";
    var metric = metrics[mode];

    element("metricsLabel").textContent = metric.coverage + "% coverage · " +
      (metric.precision ? metric.precision + "%" : "—") + " precision";
  }

  function saveSetting(event) {
    var data = {};

    data[event.target.id] = event.target.checked;
    storage.set(data);
    updateMetrics();
  }

  element("versionLabel").textContent = "v" + runtime.runtime.getManifest().version;
  setControls(defaults);

  storage.get(defaults).then(setControls, function useDefaults() {
    setControls(defaults);
  });

  element("rulesEnabled").addEventListener("change", saveSetting);
  element("whisperEnabled").addEventListener("change", saveSetting);
})();
