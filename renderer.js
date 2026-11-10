// The "editor": plays the chosen pieces onto a canvas with a title card, clip badges,
// camera-angle labels, fades, slow-motion replays from other phones and an outro,
// and records the result as one new video that streams straight to Drive.

import { planSeconds } from './highlights.js?v=7';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const FONT = '"Outfit", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const ORANGE = '#ff6a1f', GOLD = '#ffd23f', BLUE = '#4d7cff', RED = '#ff3b5c';

function waitEvent(el, ev, ms) {
  return new Promise((res) => {
    const done = () => { clearTimeout(t); el.removeEventListener(ev, done); res(true); };
    const t = setTimeout(() => { el.removeEventListener(ev, done); res(false); }, ms);
    el.addEventListener(ev, done);
  });
}

// Make the two video players inside the tap so phones allow them to play with sound.
export function makePlayers() {
  return [0, 1].map(() => {
    const v = document.createElement('video');
    v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.setAttribute('playsinline', '');
    v.muted = true;
    try { v.load(); v.play().catch(() => {}); } catch { /* unlock attempt */ }
    return v;
  });
}

async function loadInto(el, url) {
  if (el._url === url) return;
  el._url = url;
  el.src = url;
  if (el.readyState < 1) await waitEvent(el, 'loadedmetadata', 12000);
  if (!isFinite(el.duration)) { // recorder files often don't know their length
    el.currentTime = 1e7;
    await waitEvent(el, 'seeked', 3000);
  }
}

async function seekTo(el, t) {
  if (Math.abs(el.currentTime - t) < 0.03 && el.readyState >= 2) return;
  el.currentTime = t;
  await waitEvent(el, 'seeked', 6000);
}

function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawBall(g, cx, cy, r, rot) {
  g.save(); g.translate(cx, cy); g.rotate(rot);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
  g.save(); g.clip();
  g.fillStyle = GOLD; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r, 0.2, 2.2); g.fill();
  g.fillStyle = BLUE; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r, 2.2, 4.2); g.fill();
  g.restore();
  g.strokeStyle = '#0a0f1f'; g.lineWidth = r * 0.07;
  for (let k = 0; k < 3; k++) { g.rotate((Math.PI * 2) / 3); g.beginPath(); g.arc(r * 0.9, 0, r * 0.95, Math.PI * 0.62, Math.PI * 1.38); g.stroke(); }
  g.beginPath(); g.arc(0, 0, r, 0, 7); g.stroke();
  g.restore();
}

export async function renderReel({ plan, canvas, ac, players, getSrc, releaseSrc, sink, mime, dateLabel, onProgress, shouldStop }) {
  const firstPiece = plan.find((s) => s.pieces).pieces[0];
  const vids = players || makePlayers();
  const first = await getSrc(firstPiece.src);
  await loadInto(vids[0], first.url);
  const vw = vids[0].videoWidth || 1280, vh = vids[0].videoHeight || 720;
  const sc = Math.min(1, 1280 / Math.max(vw, vh));
  const W = Math.round((vw * sc) / 2) * 2, H = Math.round((vh * sc) / 2) * 2;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const u = Math.min(W, H) / 720;

  const dest = ac.createMediaStreamDestination();
  const master = ac.createGain(); master.connect(dest);
  // streamed (gallery) videos play their sound through these
  const elGain = vids.map((v) => {
    const gn = ac.createGain(); gn.gain.value = 0; gn.connect(master);
    try { ac.createMediaElementSource(v).connect(gn); v._routed = true; } catch { v._routed = false; }
    return gn;
  });
  const out = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 160000 });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) sink.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  const lastUse = new Map();
  plan.forEach((s, si) => (s.pieces || []).forEach((p, pi) => lastUse.set(p.src, si * 1000 + pi)));

  const st = { mode: 'black', video: null, scene: null, t0: performance.now(), sceneT0: performance.now(), fade: { from: 1, to: 1, t0: 0, dur: 1 } };
  const curFade = () => { const f = st.fade, x = Math.min(1, (performance.now() - f.t0) / f.dur); return f.from + (f.to - f.from) * x; };
  const fadeTo = (to, dur) => { st.fade = { from: curFade(), to, t0: performance.now(), dur: dur * 1000 }; };

  function drawContain(v) {
    const r = Math.min(W / v.videoWidth, H / v.videoHeight) || 1;
    const w = v.videoWidth * r, h = v.videoHeight * r;
    g.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
  }

  function bg() {
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#070b18'); grd.addColorStop(1, '#16204a');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    const gl = g.createRadialGradient(W * 0.85, H * 0.1, 0, W * 0.85, H * 0.1, W * 0.6);
    gl.addColorStop(0, 'rgba(255,106,31,.35)'); gl.addColorStop(1, 'rgba(255,106,31,0)');
    g.fillStyle = gl; g.fillRect(0, 0, W, H);
  }

  function drawTitle(t, scene) {
    bg();
    g.save(); g.globalAlpha = 0.95; g.fillStyle = ORANGE;
    const sx = -W + ease(t / 0.6) * W * 1.25;
    g.beginPath(); g.moveTo(sx, H * 0.66); g.lineTo(sx + W * 1.3, H * 0.5); g.lineTo(sx + W * 1.3, H * 0.57); g.lineTo(sx, H * 0.73); g.fill();
    g.restore();
    const a = ease(t / 0.5);
    drawBall(g, W / 2, H * 0.27 - (1 - a) * 90 * u, 60 * u, t * 2.4);
    g.globalAlpha = a; g.textAlign = 'center';
    g.fillStyle = GOLD; g.font = `800 ${28 * u}px ${FONT}`;
    g.fillText((scene.title || 'VOLLEYBALL').toUpperCase().split('').join(' '), W / 2, H * 0.45);
    g.fillStyle = '#fff';
    const s = 0.8 + 0.2 * ease((t - 0.15) / 0.5);
    g.font = `900 ${118 * u * s}px ${FONT}`;
    g.fillText('HIGHLIGHTS', W / 2, H * 0.45 + 118 * u);
    g.fillStyle = '#c9d2ea'; g.font = `600 ${27 * u}px ${FONT}`;
    g.fillText(dateLabel + (scene.phones > 1 ? `  ·  ${scene.phones} camera angles` : ''), W / 2, H * 0.45 + 172 * u);
    g.globalAlpha = 1; g.textAlign = 'left';
  }

  function drawOutro(t) {
    bg();
    const a = ease(t / 0.5);
    g.globalAlpha = a; g.textAlign = 'center';
    drawBall(g, W / 2, H * 0.34, 46 * u, t * 1.6);
    g.fillStyle = '#fff'; g.font = `900 ${74 * u}px ${FONT}`;
    g.fillText("THAT'S THE GAME", W / 2, H * 0.6);
    g.fillStyle = ORANGE; g.font = `700 ${26 * u}px ${FONT}`;
    g.fillText('made with Rally Reel', W / 2, H * 0.6 + 52 * u);
    g.globalAlpha = 1; g.textAlign = 'left';
  }

  function badge(text, color, x, y) {
    g.font = `800 ${26 * u}px ${FONT}`;
    const w = g.measureText(text).width + 42 * u, h = 52 * u;
    g.fillStyle = 'rgba(7,11,24,.66)'; rr(g, x, y, w, h, 14 * u); g.fill();
    g.fillStyle = color; rr(g, x, y, 8 * u, h, 4 * u); g.fill();
    g.fillStyle = '#fff'; g.fillText(text, x + 22 * u, y + 35 * u);
    return w;
  }
  function camChip(who) {
    if (!who) return;
    g.font = `700 ${24 * u}px ${FONT}`;
    const text = `● ${who}'s camera`;
    const w = g.measureText(text).width + 32 * u, h = 44 * u, x = 28 * u, y = H - h - 28 * u;
    g.fillStyle = 'rgba(7,11,24,.6)'; rr(g, x, y, w, h, h / 2); g.fill();
    g.fillStyle = '#fff'; g.fillText(text, x + 16 * u, y + 30 * u);
  }
  function bigCaption(text, color) {
    g.textAlign = 'center'; g.font = `900 ${46 * u}px ${FONT}`;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillText(text, W / 2 + 3 * u, H - 40 * u + 3 * u);
    g.fillStyle = color; g.fillText(text, W / 2, H - 40 * u);
    g.textAlign = 'left';
  }

  function draw() {
    const now = performance.now();
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const s = st.scene;
    if (st.mode === 'title') drawTitle((now - st.sceneT0) / 1000, s);
    else if (st.mode === 'outro') drawOutro((now - st.sceneT0) / 1000);
    else if (st.mode === 'video' && st.video && st.video.readyState >= 2) {
      drawContain(st.video);
      if (s && s.type === 'clip') { badge(`HIGHLIGHT ${s.n}/${s.total}${s.marked ? '  ★' : ''}`, ORANGE, 28 * u, 28 * u); camChip(s.who); }
      if (s && s.type === 'angle') { badge('OTHER ANGLE · SLOW-MO', BLUE, 28 * u, 28 * u); camChip(s.who); }
      if (s && s.type === 'replay') {
        badge(s.of > 1 ? `REPLAY · ANGLE ${s.n}/${s.of}` : 'REPLAY · 0.5×', RED, 28 * u, 28 * u);
        bigCaption('PLAY OF THE MATCH', GOLD);
        if (s.who) { g.save(); g.translate(0, -70 * u); camChip(s.who); g.restore(); }
      }
    }
    const a = curFade();
    if (a > 0.001) { g.globalAlpha = a; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  }

  let running = true;
  const drawTimer = setInterval(() => { if (running) draw(); }, 1000 / 30);
  const total = planSeconds(plan);
  const tStart = performance.now();
  const prog = setInterval(() => onProgress && onProgress(Math.min(0.99, (performance.now() - tStart) / 1000 / total)), 250);

  async function prepare(el, piece) {
    const src = await getSrc(piece.src);
    await loadInto(el, src.url);
    await seekTo(el, piece.from);
    return src;
  }

  const flat = [];
  plan.forEach((s, si) => (s.pieces || []).forEach((p, pi) => flat.push({ s, si, p, pi })));
  let slot = 0, fi = 0;
  let pending = flat.length ? { el: vids[0], slot: 0, promise: prepare(vids[0], flat[0].p) } : null;

  rec.start(1000);
  try {
    for (let si = 0; si < plan.length; si++) {
      if (shouldStop && shouldStop()) break;
      const scene = plan[si];
      st.scene = scene;
      if (!scene.pieces) {
        st.mode = scene.type; st.sceneT0 = performance.now();
        fadeTo(0, 0.3);
        await sleep(scene.dur * 1000 - 300);
        fadeTo(1, 0.3);
        await sleep(300);
        continue;
      }
      const vol = scene.type === 'clip' ? 1 : 0.7;
      const sceneGain = ac.createGain(); sceneGain.gain.value = 0; sceneGain.connect(master);
      let lastGain = sceneGain;
      for (let pi = 0; pi < scene.pieces.length; pi++, fi++) {
        if (shouldStop && shouldStop()) break;
        const piece = scene.pieces[pi];
        const el = pending.el, mySlot = pending.slot;
        let src;
        try { src = await pending.promise; } catch { src = null; }
        slot = mySlot ^ 1;
        const nxt = flat[fi + 1];
        pending = nxt ? { el: vids[slot], slot, promise: prepare(vids[slot], nxt.p) } : null;
        if (!src) continue;
        el.playbackRate = piece.rate;
        // sound: decoded track for recorded pieces, the video's own sound for gallery videos
        const useEl = src.stream && el._routed;
        el.muted = !useEl;
        await el.play().catch(async () => { el.muted = true; await el.play().catch(() => {}); });
        st.video = el; st.mode = 'video';
        const gainNode = useEl ? elGain[mySlot] : sceneGain;
        lastGain = gainNode;
        const t = ac.currentTime;
        if (pi === 0) {
          fadeTo(0, 0.3);
          gainNode.gain.cancelScheduledValues(t); gainNode.gain.setValueAtTime(0, t); gainNode.gain.linearRampToValueAtTime(vol, t + 0.3);
        } else { gainNode.gain.cancelScheduledValues(t); gainNode.gain.setValueAtTime(vol, t); }
        let bufSrc = null;
        if (!useEl && src.audio) {
          bufSrc = ac.createBufferSource(); bufSrc.buffer = src.audio;
          bufSrc.playbackRate.value = piece.rate; bufSrc.connect(sceneGain);
          bufSrc.start(0, Math.min(src.audio.duration - 0.01, Math.max(0, el.currentTime)));
        }
        const limit = performance.now() + ((piece.to - piece.from) / piece.rate + 5) * 1000;
        while (el.currentTime < piece.to - 0.02 && !el.ended && !el.paused && performance.now() < limit) await sleep(12);
        if (pi === scene.pieces.length - 1) {
          el.pause();
          fadeTo(1, 0.3);
          const t2 = ac.currentTime;
          lastGain.gain.cancelScheduledValues(t2); lastGain.gain.setValueAtTime(lastGain.gain.value, t2); lastGain.gain.linearRampToValueAtTime(0, t2 + 0.3);
          await sleep(320);
          if (bufSrc) try { bufSrc.stop(); } catch { /* ended */ }
        } else {
          if (bufSrc) try { bufSrc.stop(); } catch { /* ended */ }
          if (useEl) elGain[mySlot].gain.setValueAtTime(0, ac.currentTime);
          el.pause();
        }
        if (lastUse.get(piece.src) === si * 1000 + pi) releaseSrc(piece.src);
      }
      elGain.forEach((gn) => gn.gain.setValueAtTime(0, ac.currentTime));
      sceneGain.disconnect();
    }
  } finally {
    clearInterval(prog);
    await sleep(200);
    running = false;
    clearInterval(drawTimer);
    rec.stop();
    await stopped;
    vids.forEach((v) => { v.removeAttribute('src'); v.load(); });
    onProgress && onProgress(1);
  }
  return { width: W, height: H };
}
