(function initPopup() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var defaults = {
    rulesEnabled: true,
    whisperEnabled: true
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
  }

  function saveSetting(event) {
    var data = {};

    data[event.target.id] = event.target.checked;
    storage().set(data);
  }

  if (!storage()) {
    setControls(defaults);
    return;
  }

  storage().get(defaults).then(setControls, function useDefaults() {
    setControls(defaults);
  });

  element("rulesEnabled").addEventListener("change", saveSetting);
  element("whisperEnabled").addEventListener("change", saveSetting);
})();
