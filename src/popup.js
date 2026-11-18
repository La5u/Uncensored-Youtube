(function initPopup() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var storage = runtime.storage.local;
  // Measured on 154 English videos from creators the rules were not tuned on (frozen 2026-09-20
  // set, with 345 human audio labels; approximate percentages).
  var MODES = [
    { id: "rules", title: "Rules only", precision: "Up to 81%", coverage: "Up to 37%", cpu: "Minimal",
      description: "Fill words from caption context instantly. Uncertain slots stay hidden." },
    { id: "rules-first", title: "Rules first", precision: "Up to 89%", coverage: "Up to 87%", cpu: "Moderate",
      description: "Rules fill what they can; local Whisper listens only to the rest." },
    { id: "auto", title: "Automatic",
      description: "Whisper first on devices fast enough for it, Rules first otherwise." },
    { id: "whisper-first", title: "Whisper first", precision: "Up to 97%", coverage: "Up to 95%", cpu: "High",
      description: "Rules fill instantly, then Whisper checks every slot and corrects them." },
    { id: "whisper", title: "Whisper only", precision: "Up to 97%", coverage: "Up to 95%", cpu: "High",
      decoderOnly: { precision: "Up to 97%", coverage: "Up to 90%" },
      description: "Only local Whisper audio recognition; no context rules." }
  ];
  var DEFAULT_MODE = "auto";

  function element(id) {
    return document.getElementById(id);
  }

  function find(id) {
    return MODES.find(function matches(mode) { return mode.id === id; });
  }

  // Older settings stored mode "off" or (before 1.6) two switches: both off means the switch is
  // off with the slider at Automatic, both on (or nothing stored) means Automatic.
  function storedMode(values) {
    if (find(values.mode)) return values.mode;
    if (values.mode === "off" || values.rulesEnabled === values.whisperEnabled) return DEFAULT_MODE;
    return values.rulesEnabled === false ? "whisper" : "rules";
  }

  function storedEnabled(values) {
    return values.enabled !== false && values.mode !== "off" &&
      Boolean(find(values.mode) || values.rulesEnabled !== false || values.whisperEnabled !== false);
  }

  function showEnabled(enabled) {
    element("enabled").checked = enabled;
    element("modeControls").disabled = !enabled;
  }

  // Automatic uses the next-video recommendation from background.js.
  var current = { autoMode: "rules-first", measured: false };

  function show(index) {
    var mode = MODES[index];
    var used = mode.id === "auto" ? find(current.autoMode) || find("rules-first") : mode;
    var metrics = used.id !== "rules" && !element("acousticHead").checked ? used.decoderOnly : used;

    element("mode").value = String(index);
    element("mode").setAttribute("aria-valuetext", mode.title);
    element("modeTitle").textContent = mode.title;
    element("modeDescription").textContent = mode.description;
    element("modeCurrent").hidden = mode.id !== "auto";
    element("modeCurrent").textContent = "Next video: " + used.title + (current.measured ? "" : " (measuring)");
    element("modePrecision").textContent = metrics ? metrics.precision : "Not measured";
    element("modeCoverage").textContent = metrics ? metrics.coverage : "Not measured";
    element("modeCpu").textContent = used.cpu;
    // The sound check only runs where Whisper does.
    element("acousticHead").disabled = used.id === "rules";
  }

  function showMode(id) {
    show(MODES.indexOf(find(id)));
  }

  element("versionLabel").textContent = "v" + runtime.runtime.getManifest().version;
  showMode(DEFAULT_MODE);
  storage.get({ enabled: true, mode: null, rulesEnabled: true, whisperEnabled: true, acousticHead: true,
    autoMode: "rules-first", whisperSpeed: [] }).then(function loaded(values) {
    current = { autoMode: values.autoMode, measured: values.whisperSpeed.length >= 5 };
    element("acousticHead").checked = values.acousticHead !== false;
    showMode(storedMode(values));
    showEnabled(storedEnabled(values));
  }, function useDefault() {
    showMode(DEFAULT_MODE);
  });
  // Saving the slider too replaces a legacy stored "off".
  element("enabled").addEventListener("change", function saveEnabled() {
    showEnabled(element("enabled").checked);
    storage.set({ enabled: element("enabled").checked, mode: MODES[Number(element("mode").value)].id });
  });
  element("mode").addEventListener("input", function preview() {
    show(Number(element("mode").value));
  });
  element("mode").addEventListener("change", function save() {
    storage.set({ mode: MODES[Number(element("mode").value)].id });
  });
  element("acousticHead").addEventListener("change", function saveHead() {
    show(Number(element("mode").value));
    storage.set({ acousticHead: element("acousticHead").checked });
  });
})();
