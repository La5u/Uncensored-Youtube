/* Staged diagnostics only: never modifies runtime sources or caption responses. */
(() => {
  const script = document.currentScript;
  const config = JSON.parse(script.dataset.config);
  let epoch = 0, sought = false, loadedFor, requestedTrack;
  const id = () => document.querySelector('#movie_player')?.getVideoData?.().video_id;
  const send = (data) => window.dispatchEvent(new CustomEvent('firefox-smoke', {
    detail: JSON.stringify({ videoId: id(), epoch, time: document.querySelector('video')?.currentTime, at: Date.now(), ...data })
  }));
  try { localStorage.setItem('uncensoredDebug', '1'); } catch (_) {}
  for (const level of ['debug', 'log', 'warn', 'error']) {
    const original = console[level];
    console[level] = function (...args) {
      original.apply(this, args);
      try {
        const text = args.map(value => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).join(' ');
        if (text.includes('[uncensored]')) send({ type: 'log', text });
      } catch (_) {}
    };
  }
  const mute = () => document.querySelectorAll('video, audio').forEach(media => { media.muted = true; media.volume = 0; });
  new MutationObserver(mute).observe(document.documentElement, { childList: true, subtree: true });
  mute();
  window.addEventListener('uncensored-timedtext', event => {
    try {
      const detail = JSON.parse(event.detail);
      const body = typeof detail.body === 'string' ? JSON.parse(detail.body) : detail.body;
      send({ type: 'captions', videoId: detail.videoId, trackId: detail.trackId,
        blanks: (JSON.stringify(body).match(/\[\s*__\s*\]/g) || []).length,
        slots: (body.events || []).filter(item => /\[\s*__\s*\]/.test(JSON.stringify(item.segs)))
          .map(item => [item.tStartMs / 1000, (item.tStartMs + (item.dDurationMs || 2000)) / 1000,
            (item.segs || []).map(seg => seg.utf8 || '').join('')]) });
    } catch (_) {}
  });
  setInterval(() => {
    mute();
    for (const button of document.querySelectorAll('button')) {
      if (button.getClientRects().length && /^(reject all|tout refuser)$/i.test(button.textContent.trim())) button.click();
    }
    const player = document.querySelector('#movie_player'), video = document.querySelector('video');
    if (!video || !player) return;
    video.muted = true; video.volume = 0; video.playbackRate = config.rate;
    if (!id() || !Number.isFinite(video.duration) || video.duration <= 0) return;
    if (!sought && config.seek && video.currentTime >= config.seek[0]) {
      sought = true; epoch++;
      send({ type: 'seek', time: config.seek[1] });
      video.currentTime = config.seek[1];
    }
    if (loadedFor !== id()) { player.loadModule?.('captions'); loadedFor = id(); requestedTrack = undefined; }
    const rawTracks = player.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const automatic = item => item.languageCode === 'en' &&
      (item.kind === 'asr' || (!item.kind && /^a\./.test(item.vssId || '')));
    const track = rawTracks.find(automatic) || player.getOption?.('captions', 'tracklist')?.find(automatic);
    let selectedTrack = player.getOption?.('captions', 'track') || {};
    if (track?.vssId && selectedTrack.vssId !== track.vssId && requestedTrack !== track.vssId) {
      requestedTrack = track.vssId;
      player.setOption?.('captions', 'track', track);
      selectedTrack = player.getOption?.('captions', 'track') || {};
    }
    const button = document.querySelector('.ytp-subtitles-button');
    const trackVerified = !!track?.vssId && selectedTrack.vssId === track.vssId;
    if (trackVerified && button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
        button.getAttribute('aria-pressed') !== 'true') button.click();
    video.play().catch(() => {});
    const text = [...document.querySelectorAll('.ytp-caption-segment')].filter(node => {
      for (let el = node; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < innerHeight && rect.left < innerWidth;
    }).map(node => node.textContent).join(' ').toLowerCase();
    send({ type: 'sample', webdriver: navigator.webdriver, injected: true,
      time: video.currentTime, duration: video.duration, muted: video.muted, volume: video.volume,
      paused: video.paused, ready: video.readyState, error: video.error?.code || null,
      ad: player.classList.contains('ad-showing'), text,
      ccButton: button ? { pressed: button.getAttribute('aria-pressed'), disabled: button.disabled,
        ariaDisabled: button.getAttribute('aria-disabled') } : null,
      selectedTrack: { vssId: selectedTrack.vssId, languageCode: selectedTrack.languageCode, kind: selectedTrack.kind },
      rawEnglishASR: rawTracks.filter(automatic).map(item => ({ vssId: item.vssId, kind: item.kind })),
      trackVerified, youtubeError: [...document.querySelectorAll('.ytp-error, .ytp-error-content-wrap')]
        .filter(node => node.getClientRects().length).map(node => node.textContent.trim()).join(' ') });
  }, 500);
})();
