(function injectUncensoredYouTube() {
  "use strict";

  var runtime = globalThis.browser || globalThis.chrome;
  var scripts = [
    "src/rule-data.js",
    "src/replacement-format.js",
    "src/rules.js",
    "src/timedtext.js",
    "src/page-hook.js"
  ];

  if (!runtime || !runtime.runtime || !runtime.runtime.getURL) {
    return;
  }

  function injectScript(path) {
    var script = document.createElement("script");
    script.src = runtime.runtime.getURL(path);
    script.async = false;
    script.onload = function removeInjectedScript() {
      script.remove();
    };
    (document.documentElement || document.head).appendChild(script);
  }

  scripts.forEach(injectScript);
})();
