// The "editor": plays the chosen pieces onto a canvas with a title card, clip badges,
// fades, a slow-motion "play of the match" replay and an outro, and records the
// result as one new video that streams straight to Drive.

import { planSeconds } from './highlights.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

function waitEvent(el, ev, ms) {
  return new Promise((res) => {
    const done = () => { clearTimeout(t); el.removeEventListener(ev, done); res(true); };
    const t = setTimeout(() => { el.removeEventListener(ev, done); res(false); }, ms);
    el.addEventListener(ev, done);
  });
}

function mkVideo() {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  return v;
}

async function loadInto(el, url) {
  if (el._url === url) return;
  el._url = url;
  el.src = url;
  if (el.readyState < 1) await waitEvent(el, 'loadedmetadata', 8000);
  // recorder files often don't know their length – jump to the end once to fix that
  if (!isFinite(el.duration)) {
    el.currentTime = 1e7;
    await waitEvent(el, 'seeked', 3000);
  }
}

async function seekTo(el, t) {
  if (Math.abs(el.currentTime - t) < 0.03 && el.readyState >= 2) return;
  el.currentTime = t;
  await waitEvent(el, 'seeked', 4000);
}

function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawBall(g, cx, cy, r, rot) {
  g.save(); g.translate(cx, cy); g.rotate(rot);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
  g.strokeStyle = '#1d2a4a'; g.lineWidth = r * 0.07;
  for (let k = 0; k < 3; k++) {
    g.rotate((Math.PI * 2) / 3);
    g.beginPath(); g.arc(r * 0.9, 0, r * 0.95, Math.PI * 0.62, Math.PI * 1.38); g.stroke();
  }
  g.fillStyle = 'rgba(255,170,40,.35)'; g.beginPath(); g.arc(0, 0, r, -0.4, 1.2); g.lineTo(0, 0); g.fill();
  g.restore();
  g.strokeStyle = '#1d2a4a'; g.lineWidth = r * 0.06; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export async function renderReel({ plan, canvas, ac, getSeg, releaseSeg, sink, mime, dateLabel, onProgress, shouldStop }) {
  const firstPiece = plan.find((s) => s.pieces).pieces[0];
  const vids = [mkVideo(), mkVideo()];
  const first = await getSeg(firstPiece.seg);
  await loadInto(vids[0], first.url);
  const vw = vids[0].videoWidth || 1280, vh = vids[0].videoHeight || 720;
  const sc = Math.min(1, 1280 / Math.max(vw, vh));
  const W = Math.round((vw * sc) / 2) * 2, H = Math.round((vh * sc) / 2) * 2;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const u = Math.min(W, H) / 720;

  const dest = ac.createMediaStreamDestination();
  const master = ac.createGain(); master.connect(dest);
  const out = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 160000 });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) sink.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });

  // which piece uses a file for the last time (so memory is freed right away)
  const lastUse = new Map();
  plan.forEach((s, si) => (s.pieces || []).forEach((p, pi) => lastUse.set(p.seg, si * 1000 + pi)));

  const st = { mode: 'black', video: null, scene: null, t0: performance.now(), fade: { from: 1, to: 1, t0: 0, dur: 1 } };
  const fadeTo = (to, dur) => { st.fade = { from: curFade(), to, t0: performance.now(), dur: dur * 1000 }; };
  const curFade = () => {
    const f = st.fade, x = Math.min(1, (performance.now() - f.t0) / f.dur);
    return f.from + (f.to - f.from) * x;
  };

  function drawContain(v) {
    const r = Math.min(W / v.videoWidth, H / v.videoHeight) || 1;
    const w = v.videoWidth * r, h = v.videoHeight * r;
    g.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
  }

  function drawTitle(t) {
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#0b1020'); grd.addColorStop(1, '#1f2c55');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.save(); g.globalAlpha = 0.9; g.fillStyle = '#ff7a1a';
    const sx = -W + ease(t / 0.6) * W * 1.2;
    g.beginPath(); g.moveTo(sx, H * 0.62); g.lineTo(sx + W * 1.3, H * 0.48); g.lineTo(sx + W * 1.3, H * 0.56); g.lineTo(sx, H * 0.7); g.fill();
    g.restore();
    const a = ease(t / 0.5);
    drawBall(g, W / 2, H * 0.3 - (1 - a) * 80 * u, 62 * u, t * 2.2);
    g.globalAlpha = a; g.textAlign = 'center'; g.fillStyle = '#ffd23f';
    g.font = `700 ${30 * u}px ${FONT}`;
    g.fillText('V O L L E Y B A L L', W / 2, H * 0.47);
    g.fillStyle = '#fff';
    const s = 0.8 + 0.2 * ease((t - 0.15) / 0.5);
    g.font = `900 ${110 * u * s}px ${FONT}`;
    g.fillText('HIGHLIGHTS', W / 2, H * 0.47 + 112 * u);
    g.fillStyle = '#c9d2ea'; g.font = `600 ${28 * u}px ${FONT}`;
    g.fillText(dateLabel, W / 2, H * 0.47 + 165 * u);
    g.globalAlpha = 1; g.textAlign = 'left';
  }

  function drawOutro(t) {
    g.fillStyle = '#0b1020'; g.fillRect(0, 0, W, H);
    const a = ease(t / 0.5);
    g.globalAlpha = a; g.textAlign = 'center';
    drawBall(g, W / 2, H * 0.36, 46 * u, t * 1.5);
    g.fillStyle = '#fff'; g.font = `900 ${70 * u}px ${FONT}`;
    g.fillText("THAT'S THE GAME", W / 2, H * 0.6);
    g.fillStyle = '#ff7a1a'; g.font = `700 ${26 * u}px ${FONT}`;
    g.fillText('made with Rally Reel', W / 2, H * 0.6 + 52 * u);
    g.globalAlpha = 1; g.textAlign = 'left';
  }

  function drawBadge(text, color) {
    g.font = `800 ${26 * u}px ${FONT}`;
    const w = g.measureText(text).width + 40 * u, h = 50 * u, x = 28 * u, y = 28 * u;
    g.fillStyle = 'rgba(8,12,24,.62)'; rr(g, x, y, w, h, 12 * u); g.fill();
    g.fillStyle = color; rr(g, x, y, 8 * u, h, 4 * u); g.fill();
    g.fillStyle = '#fff'; g.fillText(text, x + 22 * u, y + 34 * u);
  }

  function draw() {
    const now = performance.now();
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const sc2 = st.scene;
    if (st.mode === 'title') drawTitle((now - st.t0) / 1000);
    else if (st.mode === 'outro') drawOutro((now - st.t0) / 1000);
    else if (st.mode === 'video' && st.video && st.video.readyState >= 2) {
      drawContain(st.video);
      if (sc2 && sc2.type === 'clip') drawBadge(`HIGHLIGHT ${sc2.n}/${sc2.total}${sc2.marked ? '  ★' : ''}`, '#ff7a1a');
      if (sc2 && sc2.type === 'replay') {
        drawBadge('REPLAY · 0.5×', '#ff3b4e');
        g.textAlign = 'center'; g.font = `900 ${44 * u}px ${FONT}`;
        g.fillStyle = 'rgba(0,0,0,.55)'; g.fillText('PLAY OF THE MATCH', W / 2 + 3 * u, H - 38 * u + 3 * u);
        g.fillStyle = '#ffd23f'; g.fillText('PLAY OF THE MATCH', W / 2, H - 38 * u);
        g.textAlign = 'left';
      }
    }
    const a = curFade();
    if (a > 0.001) { g.globalAlpha = a; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  }

  let running = true;
  // a timer (not requestAnimationFrame) keeps drawing even if the browser gets lazy
  const drawTimer = setInterval(() => { if (running) draw(); }, 1000 / 30);

  const total = planSeconds(plan);
  const tStart = performance.now();
  const prog = setInterval(() => onProgress && onProgress(Math.min(0.99, (performance.now() - tStart) / 1000 / total)), 250);

  // prepare a piece on an idle video element (loads + seeks while the other one plays)
  async function prepare(el, piece) {
    const seg = await getSeg(piece.seg);
    await loadInto(el, seg.url);
    await seekTo(el, piece.from);
    return seg;
  }

  const flat = [];
  plan.forEach((s, si) => (s.pieces || []).forEach((p, pi) => flat.push({ s, si, p, pi })));
  let slot = 0, fi = 0;
  let pending = flat.length ? { el: vids[0], promise: prepare(vids[0], flat[0].p) } : null;

  rec.start(1000);
  try {
    for (let si = 0; si < plan.length; si++) {
      if (shouldStop && shouldStop()) break;
      const scene = plan[si];
      st.scene = scene;
      if (!scene.pieces) {
        st.mode = scene.type; st.t0 = performance.now();
        fadeTo(0, 0.3);
        await sleep(scene.dur * 1000 - 300);
        fadeTo(1, 0.3);
        await sleep(300);
        continue;
      }
      const sceneGain = ac.createGain(); sceneGain.gain.value = 0; sceneGain.connect(master);
      for (let pi = 0; pi < scene.pieces.length; pi++, fi++) {
        const piece = scene.pieces[pi];
        const el = pending.el;
        let seg;
        try { seg = await pending.promise; } catch { seg = null; }
        // start getting the next piece ready on the other element
        slot ^= 1;
        const nxt = flat[fi + 1];
        pending = nxt ? { el: vids[slot], promise: prepare(vids[slot], nxt.p) } : null;
        if (!seg) continue;
        el.playbackRate = piece.rate;
        await el.play().catch(() => {});
        st.video = el; st.mode = 'video';
        if (pi === 0) {
          fadeTo(0, 0.3);
          sceneGain.gain.setValueAtTime(0, ac.currentTime);
          sceneGain.gain.linearRampToValueAtTime(scene.type === 'replay' ? 0.7 : 1, ac.currentTime + 0.3);
        }
        let src = null;
        if (seg.audio) {
          src = ac.createBufferSource(); src.buffer = seg.audio;
          src.playbackRate.value = piece.rate; src.connect(sceneGain);
          src.start(0, Math.min(seg.audio.duration - 0.01, Math.max(0, el.currentTime)));
        }
        const limit = performance.now() + ((piece.to - piece.from) / piece.rate + 4) * 1000;
        while (el.currentTime < piece.to - 0.02 && !el.ended && !el.paused && performance.now() < limit) await sleep(12);
        if (pi === scene.pieces.length - 1) {
          // fade out on the last frame of the clip
          el.pause();
          fadeTo(1, 0.3);
          sceneGain.gain.setValueAtTime(sceneGain.gain.value, ac.currentTime);
          sceneGain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.3);
          await sleep(320);
          if (src) try { src.stop(); } catch { /* ended */ }
        } else {
          if (src) try { src.stop(); } catch { /* ended */ }
          el.pause();
        }
        const key = si * 1000 + pi;
        if (lastUse.get(piece.seg) === key) releaseSeg(piece.seg);
      }
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
