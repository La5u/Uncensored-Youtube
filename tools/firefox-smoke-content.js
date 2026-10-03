/* Generated config is prepended in the staged extension. */
(() => {
  const send = data => browser.runtime.sendMessage({ firefoxSmoke: { token: SMOKE.token, ...data } }).catch(() => {});
  let state = { videoId: SMOKE.videoId, epoch: 0, time: 0 };
  try { localStorage.setItem('uncensoredDebug', '1'); } catch (_) {}
  for (const level of ['debug', 'log', 'warn', 'error']) {
    const original = console[level];
    console[level] = function (...args) {
      original.apply(this, args);
      try {
        const text = args.map(value => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).join(' ');
        if (text.includes('[uncensored]')) send({ ...state, type: 'log', at: Date.now(), text });
      } catch (_) {}
    };
  }
  window.addEventListener('firefox-smoke', event => {
    try {
      const eventData = JSON.parse(event.detail);
      if (eventData.type === 'sample' || eventData.type === 'seek') state = eventData;
      send(eventData);
    } catch (_) {}
  });
  browser.storage.local.get('mode').then(values => send({ type: 'mode', mode: values.mode }));
  const inject = () => {
    if (!document.documentElement) return setTimeout(inject, 0);
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('firefox-smoke-page.js');
    script.dataset.config = JSON.stringify(SMOKE);
    document.documentElement.appendChild(script);
  };
  inject();
})();
