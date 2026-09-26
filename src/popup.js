(function initPopup() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var storage = runtime.storage.local;
  // Best case: dense English development set the rules were tuned on (docs/evaluation-metrics.json).
  var MODES = [
    { id: "off", title: "Off", precision: "—", coverage: "0%", cpu: "None",
      description: "Captions are left unchanged." },
    { id: "rules", title: "Rules only", precision: "Up to 96%", coverage: "Up to 52%", cpu: "Minimal",
      description: "Fill words from caption context instantly. Uncertain slots stay hidden." },
    { id: "rules-first", title: "Rules first", precision: "Up to 95%", coverage: "Up to 90%", cpu: "Moderate",
      description: "Rules fill what they can; local Whisper listens only to the rest." },
    { id: "whisper-first", title: "Whisper first", precision: "Up to 96%", coverage: "Up to 91%", cpu: "High",
      description: "Rules fill instantly, then Whisper checks every slot and corrects them." },
    { id: "whisper", title: "Whisper only", precision: "Up to 96%", coverage: "Up to 88%", cpu: "High",
      description: "Only local Whisper audio recognition; no context rules." }
  ];
  var DEFAULT_MODE = "rules-first";

  function element(id) {
    return document.getElementById(id);
  }

  // Settings before 1.6 stored two switches.
  function storedMode(values) {
    if (MODES.some(function known(mode) { return mode.id === values.mode; })) return values.mode;
    if (values.rulesEnabled === false) return values.whisperEnabled === false ? "off" : "whisper";
    return values.whisperEnabled === false ? "rules" : DEFAULT_MODE;
  }

  function show(index) {
    var mode = MODES[index];

    element("mode").value = String(index);
    element("mode").setAttribute("aria-valuetext", mode.title);
    element("modeTitle").textContent = mode.title;
    element("modeDescription").textContent = mode.description;
    element("modePrecision").textContent = mode.precision;
    element("modeCoverage").textContent = mode.coverage;
    element("modeCpu").textContent = mode.cpu;
  }

  function showMode(id) {
    show(MODES.findIndex(function matches(mode) { return mode.id === id; }));
  }

  element("versionLabel").textContent = "v" + runtime.runtime.getManifest().version;
  showMode(DEFAULT_MODE);
  storage.get({ mode: null, rulesEnabled: true, whisperEnabled: true }).then(function loaded(values) {
    showMode(storedMode(values));
  }, function useDefault() {
    showMode(DEFAULT_MODE);
  });
  element("mode").addEventListener("input", function preview() {
    show(Number(element("mode").value));
  });
  element("mode").addEventListener("change", function save() {
    storage.set({ mode: MODES[Number(element("mode").value)].id });
  });
})();
