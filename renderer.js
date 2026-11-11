// The "editor": plays the chosen pieces onto a canvas with a title card, clip badges,
// camera-angle labels, fades, slow-motion replays from other phones and an outro,
// and records the result as one new video that streams straight to Drive.

import { planSeconds } from './highlights.js?v=8';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const FONT = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const COND = '"Barlow Condensed", "Arial Narrow", "Roboto Condensed", sans-serif';
const POS_NAMES = { S: 'SETTER', OH: 'OUTSIDE HITTER', OPP: 'OPPOSITE', MB: 'MIDDLE BLOCKER', L: 'LIBERO', DS: 'DEFENSIVE SPECIALIST' };

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
  g.strokeStyle = '#0b0b0b'; g.lineWidth = r * 0.075;
  for (let k = 0; k < 3; k++) { g.rotate((Math.PI * 2) / 3); g.beginPath(); g.arc(r * 0.9, 0, r * 0.95, Math.PI * 0.62, Math.PI * 1.38); g.stroke(); }
  g.restore();
}

export async function renderReel({ plan, canvas, ac, players, getSrc, releaseSrc, sink, mime, dateLabel, onProgress, shouldStop }) {
  const firstPiece = plan.find((s) => s.pieces).pieces[0];
  try { await Promise.race([Promise.all([document.fonts.load('800 60px "Barlow Condensed"'), document.fonts.load('600 20px "Inter"')]), sleep(2500)]); } catch { /* system font */ }
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
    g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, W, H);
    const gl = g.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.7);
    gl.addColorStop(0, 'rgba(255,255,255,.07)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl; g.fillRect(0, 0, W, H);
  }
  function rule(y, t, wMax) { // thin white line that grows from the centre
    const w = wMax * ease(t);
    g.fillStyle = '#fff'; g.fillRect(W / 2 - w / 2, y, w, Math.max(1, 2 * u));
  }
  function spaced(text, size, weight = 700, font = FONT) {
    g.font = `${weight} ${size}px ${font}`;
    if ('letterSpacing' in g) { g.letterSpacing = `${Math.round(size * 0.32)}px`; return text; }
    return text.split('').join(' ');
  }
  function resetSpacing() { if ('letterSpacing' in g) g.letterSpacing = '0px'; }

  function drawTitle(t, scene) {
    bg();
    const a = ease(t / 0.5);
    g.textAlign = 'center';
    g.globalAlpha = a;
    drawBall(g, W / 2, H * 0.24, 34 * u, t * 1.8);
    g.fillStyle = '#9a9a9a';
    g.fillText(spaced((scene.title || 'Volleyball').toUpperCase(), 24 * u, 700), W / 2, H * 0.4); resetSpacing();
    rule(H * 0.43, t / 0.7, W * 0.5);
    const s = 0.86 + 0.14 * ease((t - 0.1) / 0.5);
    g.fillStyle = '#fff'; g.font = `800 ${150 * u * s}px ${COND}`;
    g.fillText('HIGHLIGHTS', W / 2, H * 0.43 + 140 * u);
    rule(H * 0.43 + 168 * u, (t - 0.2) / 0.7, W * 0.5);
    g.fillStyle = '#bdbdbd'; g.font = `600 ${24 * u}px ${FONT}`;
    g.fillText(dateLabel.toUpperCase() + (scene.phones > 1 ? `   ·   ${scene.phones} CAMERA ANGLES` : ''), W / 2, H * 0.43 + 214 * u);
    g.globalAlpha = 1; g.textAlign = 'left';
  }

  function drawMatchup(t, scene) {
    bg();
    const [A, B] = scene.teams;
    const a = ease(t / 0.45);
    g.textAlign = 'center';
    g.fillStyle = '#9a9a9a'; g.globalAlpha = a;
    g.fillText(spaced('TODAY’S MATCH', 22 * u, 700), W / 2, H * 0.2); resetSpacing();
    const fit = (txt, max) => { let size = 92 * u; g.font = `800 ${size}px ${COND}`; while (g.measureText(txt).width > max && size > 30 * u) { size -= 4 * u; g.font = `800 ${size}px ${COND}`; } };
    g.fillStyle = '#fff';
    fit(A.toUpperCase(), W * 0.82);
    g.fillText(A.toUpperCase(), W / 2 - (1 - a) * W * 0.4, H * 0.42);
    const bw = 96 * u, bh = 60 * u;
    g.globalAlpha = ease((t - 0.25) / 0.3);
    g.fillStyle = '#fff'; g.fillRect(W / 2 - bw / 2, H * 0.5 - bh / 2, bw, bh);
    g.fillStyle = '#0b0b0b'; g.font = `800 ${44 * u}px ${COND}`; g.fillText('VS', W / 2, H * 0.5 + 16 * u);
    g.globalAlpha = a; g.fillStyle = '#fff';
    fit(B.toUpperCase(), W * 0.82);
    g.fillText(B.toUpperCase(), W / 2 + (1 - a) * W * 0.4, H * 0.66);
    g.globalAlpha = 1; g.textAlign = 'left';
  }

  function drawLineup(t, scene) {
    bg();
    const team = scene.team;
    const players = team.players;
    const a = ease(t / 0.4);
    const left = W * 0.08, right = W * 0.92;
    g.globalAlpha = a;
    g.fillStyle = '#9a9a9a';
    g.fillText(spaced('STARTING LINEUP', 20 * u, 700), left, H * 0.13); resetSpacing();
    g.fillStyle = '#fff'; g.font = `800 ${74 * u}px ${COND}`;
    g.fillText((team.name || 'TEAM').toUpperCase(), left, H * 0.13 + 70 * u);
    g.fillRect(left, H * 0.13 + 88 * u, (right - left) * ease(t / 0.6), 2 * u);
    const cols = players.length > 7 ? 2 : 1;
    const perCol = Math.ceil(players.length / cols);
    const colW = (right - left) / cols;
    const top = H * 0.13 + 118 * u;
    const rowH = Math.min(62 * u, (H * 0.95 - top) / perCol);
    players.forEach((p, i) => {
      const col = Math.floor(i / perCol), row = i % perCol;
      const ra = ease((t - 0.35 - i * 0.12) / 0.35);
      if (ra <= 0) return;
      const x = left + col * colW + (1 - ra) * 30 * u, y = top + row * rowH;
      g.globalAlpha = ra;
      const box = rowH * 0.78;
      g.fillStyle = '#fff'; g.fillRect(x, y, box, box);
      g.fillStyle = '#0b0b0b'; g.textAlign = 'center'; g.font = `800 ${box * 0.62}px ${COND}`;
      g.fillText(p.num || '–', x + box / 2, y + box * 0.74);
      g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = `700 ${box * 0.6}px ${COND}`;
      const nameX = x + box + 14 * u;
      let name = (p.name || '').toUpperCase();
      const maxName = colW - box - 30 * u - (cols === 1 ? 300 * u : 0);
      while (g.measureText(name).width > maxName && name.length > 4) name = name.slice(0, -2) + '…';
      g.fillText(name, nameX, y + box * 0.72);
      const pos = POS_NAMES[p.pos] || '';
      if (pos) {
        g.fillStyle = '#9a9a9a'; g.font = `600 ${Math.min(20 * u, box * 0.34)}px ${FONT}`;
        if (cols === 1) { g.textAlign = 'right'; g.fillText(pos, right, y + box * 0.66); g.textAlign = 'left'; }
        else g.fillText(pos, nameX, y + box * 0.72 + box * 0.38);
      }
    });
    g.globalAlpha = 1; g.textAlign = 'left';
  }

  function drawOutro(t) {
    bg();
    const a = ease(t / 0.5);
    g.globalAlpha = a; g.textAlign = 'center';
    drawBall(g, W / 2, H * 0.32, 32 * u, t * 1.4);
    g.fillStyle = '#fff'; g.font = `800 ${104 * u}px ${COND}`;
    g.fillText('THAT’S THE GAME', W / 2, H * 0.58);
    rule(H * 0.58 + 22 * u, t / 0.7, W * 0.36);
    g.fillStyle = '#9a9a9a';
    g.fillText(spaced('RALLY REEL', 20 * u, 700), W / 2, H * 0.58 + 64 * u); resetSpacing();
    g.globalAlpha = 1; g.textAlign = 'left';
  }

  function badge(text, x, y) {
    g.font = `700 ${30 * u}px ${COND}`;
    const w = g.measureText(text).width + 40 * u, h = 50 * u;
    g.fillStyle = 'rgba(11,11,11,.72)'; g.fillRect(x, y, w, h);
    g.fillStyle = '#fff'; g.fillRect(x, y, 6 * u, h);
    g.fillText(text, x + 22 * u, y + 36 * u);
    return w;
  }
  function camChip(who, lift = 0) {
    if (!who) return;
    g.font = `600 ${20 * u}px ${FONT}`;
    const text = `CAMERA · ${String(who).toUpperCase()}`;
    const w = g.measureText(text).width + 30 * u, h = 40 * u, x = 28 * u, y = H - h - 28 * u - lift;
    g.fillStyle = 'rgba(11,11,11,.66)'; g.fillRect(x, y, w, h);
    g.fillStyle = '#fff'; g.fillText(text, x + 15 * u, y + 27 * u);
  }
  function bigCaption(text) {
    g.textAlign = 'center'; g.font = `800 ${54 * u}px ${COND}`;
    const w = g.measureText(text).width + 50 * u, h = 72 * u;
    g.fillStyle = 'rgba(11,11,11,.72)'; g.fillRect(W / 2 - w / 2, H - h - 26 * u, w, h);
    g.fillStyle = '#fff'; g.fillText(text, W / 2, H - 26 * u - 20 * u);
    g.textAlign = 'left';
  }

  function draw() {
    const now = performance.now();
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const s = st.scene;
    const ts = (now - st.sceneT0) / 1000;
    if (st.mode === 'title') drawTitle(ts, s);
    else if (st.mode === 'matchup') drawMatchup(ts, s);
    else if (st.mode === 'lineup') drawLineup(ts, s);
    else if (st.mode === 'outro') drawOutro(ts);
    else if (st.mode === 'video' && st.video && st.video.readyState >= 2) {
      drawContain(st.video);
      if (s && s.type === 'clip') { badge(`HIGHLIGHT ${s.n} / ${s.total}${s.marked ? '  ★' : ''}`, 28 * u, 28 * u); camChip(s.who); }
      if (s && s.type === 'angle') { badge('OTHER ANGLE · SLOW MOTION', 28 * u, 28 * u); camChip(s.who); }
      if (s && s.type === 'replay') {
        badge(s.of > 1 ? `REPLAY · ANGLE ${s.n} / ${s.of}` : 'REPLAY · SLOW MOTION', 28 * u, 28 * u);
        bigCaption('PLAY OF THE MATCH');
        camChip(s.who, 96 * u);
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
