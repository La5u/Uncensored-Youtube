(function runUncensoredBackground(root) {
  "use strict";

  var runtime = root.browser || root.chrome;
  var audioItags = Object.freeze({
    "139": true,
    "140": true,
    "141": true,
    "249": true,
    "250": true,
    "251": true,
    "599": true,
    "600": true
  });
  var nextStreamId = 1;

  if (!runtime || !runtime.webRequest || !runtime.webRequest.filterResponseData || !runtime.tabs) {
    return;
  }

  function isGoogleVideoAudioUrl(value) {
    var url;
    var itag;
    var mime;

    try {
      url = new URL(value);
    } catch (error) {
      return false;
    }

    if (!/(^|\.)googlevideo\.com$/.test(url.hostname) || url.pathname.indexOf("/videoplayback") === -1) {
      return false;
    }

    itag = url.searchParams.get("itag") || "";
    mime = url.searchParams.get("mime") || "";
    if (audioItags[itag] || mime.indexOf("audio/") === 0) {
      return true;
    }

    return !itag && !mime;
  }

  function sendToTab(tabId, message) {
    if (tabId < 0) {
      return;
    }

    try {
      runtime.tabs.sendMessage(tabId, Object.assign({
        uncensoredBackgroundAudioStream: true
      }, message));
    } catch (error) {}
  }

  function onBeforeRequest(details) {
    var filter;
    var streamId;

    if (!isGoogleVideoAudioUrl(details.url)) {
      return {};
    }

    streamId = nextStreamId;
    nextStreamId += 1;
    try {
      filter = runtime.webRequest.filterResponseData(details.requestId);
    } catch (error) {
      return {};
    }

    sendToTab(details.tabId, {
      type: "start",
      streamId: streamId,
      url: details.url
    });

    filter.ondata = function onData(event) {
      var data = event.data;

      if (data && data.byteLength) {
        sendToTab(details.tabId, {
          type: "chunk",
          streamId: streamId,
          buffer: data
        });
      }
      filter.write(data);
    };

    filter.onstop = function onStop() {
      sendToTab(details.tabId, {
        type: "end",
        streamId: streamId
      });
      filter.close();
    };

    filter.onerror = function onError(error) {
      sendToTab(details.tabId, {
        type: "error",
        streamId: streamId,
        error: error && (error.message || String(error))
      });
      try {
        filter.disconnect();
      } catch (disconnectError) {}
    };

    return {};
  }

  var isFirefox = false;

  try {
    isFirefox = Boolean(runtime.runtime.getBrowserInfo);
  } catch (e) {}

  runtime.webRequest.onBeforeRequest.addListener(onBeforeRequest, {
    urls: [
      "https://*.googlevideo.com/videoplayback*"
    ]
  }, isFirefox ? ["blocking"] : []);
})(typeof globalThis !== "undefined" ? globalThis : this);
