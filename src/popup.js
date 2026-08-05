(function initPopup() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var defaults = {
    rulesEnabled: true,
    whisperEnabled: true
  };
  var metrics = {
    hybrid: { name: "Hybrid", precision: "93.9", coverage: "90.5" },
    rules: { name: "Rules only", precision: "90.6", coverage: "41.2" },
    whisper: { name: "Audio inference only", precision: "93.5", coverage: "88.2" },
    disabled: { name: "Disabled", precision: "", coverage: "0.0" }
  };

  function storage() {
    return runtime && runtime.storage && runtime.storage.local;
  }

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

    element("coverageLabel").textContent = metric.coverage + "% correct coverage";
    element("benchmarkTooltip").textContent = metric.name + ": " +
      (metric.precision ? metric.precision + "% precision, " : "precision not applicable, ") +
      metric.coverage + "% coverage.";
  }

  function saveSetting(event) {
    var data = {};

    data[event.target.id] = event.target.checked;
    storage().set(data);
    updateMetrics();
  }

  element("versionLabel").textContent = "v" + runtime.runtime.getManifest().version;
  setControls(defaults);

  if (!storage()) {
    return;
  }

  storage().get(defaults).then(setControls, function useDefaults() {
    setControls(defaults);
  });

  element("rulesEnabled").addEventListener("change", saveSetting);
  element("whisperEnabled").addEventListener("change", saveSetting);
})();
