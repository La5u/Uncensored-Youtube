(function installTimedTextHook() {
  "use strict";

  var timedText = globalThis.UncensoredTimedText;
  var originalFetch = globalThis.fetch;
  var originalXHROpen = XMLHttpRequest.prototype.open;
  var originalXHRSend = XMLHttpRequest.prototype.send;

  if (!timedText || !originalFetch || globalThis.__uncensoredYoutubeTimedTextHookInstalled) {
    return;
  }

  globalThis.__uncensoredYoutubeTimedTextHookInstalled = true;

  function isTimedTextUrl(input) {
    var url = "";

    if (typeof input === "string") {
      url = input;
    } else if (input && typeof input.url === "string") {
      url = input.url;
    }

    try {
      url = new URL(url, location.href).href;
    } catch (error) {
      return false;
    }

    return url.indexOf("/api/timedtext") !== -1 && /[?&]fmt=json3(?:&|$)/.test(url);
  }

  globalThis.fetch = function uncensoredFetch(input, init) {
    return originalFetch.apply(this, arguments).then(function maybePatchResponse(response) {
      if (!isTimedTextUrl(input)) {
        return response;
      }

      return response.clone().text().then(function rewriteBody(body) {
        var patchedBody = timedText.patchTimedTextBody(body);
        if (patchedBody === body) {
          return response;
        }

        return new Response(patchedBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }, function keepOriginalResponse() {
        return response;
      });
    });
  };

  XMLHttpRequest.prototype.open = function uncensoredXHROpen(method, url) {
    this.__uncensoredYoutubeTimedTextUrl = isTimedTextUrl(url);
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function uncensoredXHRSend() {
    if (!this.__uncensoredYoutubeTimedTextUrl) {
      return originalXHRSend.apply(this, arguments);
    }

    this.addEventListener("readystatechange", function patchXHRResponse() {
      if (this.readyState !== 4 || typeof this.responseText !== "string") {
        return;
      }

      var patchedBody = timedText.patchTimedTextBody(this.responseText);
      if (patchedBody === this.responseText) {
        return;
      }

      try {
        Object.defineProperty(this, "responseText", {
          configurable: true,
          value: patchedBody
        });

        if (this.responseType === "" || this.responseType === "text") {
          Object.defineProperty(this, "response", {
            configurable: true,
            value: patchedBody
          });
        }
      } catch (error) {
        return;
      }
    });

    return originalXHRSend.apply(this, arguments);
  };
})();
