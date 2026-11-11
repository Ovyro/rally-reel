// Upload videos from the phone's gallery. While a video uploads to Drive (in 8 MB
// pieces, never copied in memory) it's also scanned at high speed for rallies, the
// same way live recordings are, so "Make Highlights" works on it too.

import { LiveAnalyzer } from './analyzer.js?v=8';
import { sleep } from './drive.js?v=8';

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function waitEvent(el, ev, ms) {
  return new Promise((res) => {
    const done = () => { clearTimeout(t); el.removeEventListener(ev, done); res(true); };
    const t = setTimeout(() => { el.removeEventListener(ev, done); res(false); }, ms);
    el.addEventListener(ev, done);
  });
}

export function guessMime(file) {
  if (file.type && file.type.startsWith('video/')) return file.type;
  const n = file.name.toLowerCase();
  if (n.endsWith('.mov')) return 'video/quicktime';
  if (n.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';
}

// Grab a frame from a video element as a small JPEG (for the game card).
export async function snapshot(video, w = 480) {
  try {
    const c = document.createElement('canvas');
    const r = w / (video.videoWidth || w);
    c.width = w; c.height = Math.round((video.videoHeight || w * 0.5625) * r);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72));
  } catch { return null; }
}

// Scan a video file for rallies. Returns { duration, timeline, thumb }.
export async function analyzeFile(file, ac, onProgress, shouldStop) {
  const v = document.createElement('video');
  v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', '');
  const url = URL.createObjectURL(file);
  v.src = url;
  try {
    await waitEvent(v, 'loadedmetadata', 15000);
    const duration = isFinite(v.duration) ? v.duration : 0;
    // thumbnail from ~10% in
    v.currentTime = Math.min(duration * 0.1, 20);
    await waitEvent(v, 'seeked', 5000);
    const thumb = await snapshot(v);
    v.currentTime = 0;
    await waitEvent(v, 'seeked', 5000);

    const rate = isIOS ? 2 : 4;
    let sourceNode = null;
    try { sourceNode = ac.createMediaElementSource(v); } catch { /* no audio analysis */ }
    const an = new LiveAnalyzer(null, v);
    an.prime(ac);
    v.playbackRate = rate;
    an.start(() => v.currentTime, { rate, sourceNode });
    await v.play().catch(async () => { v.muted = true; await v.play().catch(() => {}); });
    let last = -1, stuck = 0;
    while (!v.ended && !(shouldStop && shouldStop())) {
      await sleep(250);
      onProgress && onProgress(duration ? v.currentTime / duration : 0);
      if (v.currentTime === last) { if (++stuck > 40) break; v.play().catch(() => {}); } else stuck = 0;
      last = v.currentTime;
      if (v.paused && !v.ended) v.play().catch(() => {});
    }
    an.stop();
    v.pause();
    try { sourceNode && sourceNode.disconnect(); } catch { /* ignore */ }
    onProgress && onProgress(1);
    return { duration: duration || v.currentTime, timeline: an.tl, thumb };
  } finally {
    v.removeAttribute('src'); v.load();
    URL.revokeObjectURL(url);
  }
}
