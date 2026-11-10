// Demo mode (open the app with ?demo): a fake "camera" showing a cartoon volleyball
// match with real sounds – ball hits, whistles and cheering – so the whole
// record → upload → auto-edit flow can be tried without a phone or Google account.

export function createDemoStream() {
  const W = 1280, H = 720;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  if (ac.resume) ac.resume();
  const dest = ac.createMediaStreamDestination();

  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  const amb = ac.createBufferSource(); amb.buffer = noise; amb.loop = true;
  const ambF = ac.createBiquadFilter(); ambF.type = 'lowpass'; ambF.frequency.value = 700;
  const ambG = ac.createGain(); ambG.gain.value = 0.02;
  amb.connect(ambF).connect(ambG).connect(dest); amb.start();

  function hit(t) {
    const s = ac.createBufferSource(); s.buffer = noise;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 0.8;
    const gn = ac.createGain();
    gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(1.0, t + 0.004);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    s.connect(f).connect(gn).connect(dest); s.start(t, Math.random(), 0.12);
  }
  function whistle(t) {
    const o = ac.createOscillator(); o.frequency.value = 3300;
    const lfo = ac.createOscillator(); lfo.frequency.value = 28;
    const lg = ac.createGain(); lg.gain.value = 60; lfo.connect(lg).connect(o.frequency);
    const gn = ac.createGain();
    gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(0.25, t + 0.03);
    gn.gain.setValueAtTime(0.25, t + 0.65); gn.gain.linearRampToValueAtTime(0.0001, t + 0.72);
    o.connect(gn).connect(dest); o.start(t); lfo.start(t); o.stop(t + 0.8); lfo.stop(t + 0.8);
  }
  function cheer(t, amp) {
    const s = ac.createBufferSource(); s.buffer = noise; s.loop = true;
    const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 0.4;
    const gn = ac.createGain();
    gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(0.7 * amp, t + 0.35);
    gn.gain.setValueAtTime(0.7 * amp, t + 1.6); gn.gain.linearRampToValueAtTime(0.0001, t + 2.8);
    s.connect(f).connect(gn).connect(dest); s.start(t); s.stop(t + 3);
  }

  // match script: rally → whistle → cheer → rest, forever
  let phase = null;
  const hitsVis = []; // [time, side]
  let nextT = ac.currentTime + 1.5;
  function plan() {
    const now = ac.currentTime;
    while (nextT < now + 2) {
      const len = 4 + Math.random() * 10;
      const start = nextT;
      let t = start, side = 0;
      while (t < start + len) { hit(t); hitsVis.push([t, side]); side ^= 1; t += 0.8 + Math.random() * 0.6; }
      const end = t;
      whistle(end + 0.2);
      cheer(end + 0.5, Math.min(1, 0.35 + len / 14 + Math.random() * 0.2));
      phase = { start, end };
      const wall = (x) => Date.now() + (x - ac.currentTime) * 1000;
      (window.__demoRallies || (window.__demoRallies = [])).push({ start: wall(start), end: wall(end) });
      nextT = end + 4 + Math.random() * 3;
      (phases || (phases = [])).push(phase);
    }
  }
  let phases = [];
  const planTimer = setInterval(plan, 200); plan();

  const players = [];
  for (let s = 0; s < 2; s++) for (let k = 0; k < 4; k++) players.push({ s, k, x: 0, y: 0, ph: Math.random() * 6 });

  function draw() {
    const t = ac.currentTime;
    const live = phases.some((p) => t >= p.start - 0.2 && t <= p.end + 0.3);
    g.fillStyle = '#26354f'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#d9824a'; g.fillRect(140, 330, 1000, 320);
    g.strokeStyle = '#fff'; g.lineWidth = 5; g.strokeRect(140, 330, 1000, 320);
    g.fillStyle = '#ddd'; g.fillRect(636, 230, 8, 420);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(560, 240, 160, 26);
    for (const p of players) {
      const speed = live ? 3 : 0.4, amp = live ? 40 : 6;
      p.x = (p.s ? 760 : 200) + (p.k % 2) * 220 + Math.sin(t * speed + p.ph) * amp;
      p.y = 420 + Math.floor(p.k / 2) * 120 + Math.cos(t * speed * 0.8 + p.ph) * amp * 0.6;
      g.fillStyle = p.s ? '#2f80ed' : '#eb5757';
      g.beginPath(); g.arc(p.x + 20, p.y - 60, 18, 0, 7); g.fill();
      g.fillRect(p.x, p.y - 40, 40, 70);
    }
    // ball flies between the last and next hit
    let a = null, b = null;
    for (let i = 0; i < hitsVis.length; i++) { if (hitsVis[i][0] <= t) a = hitsVis[i]; else { b = hitsVis[i]; break; } }
    if (a && b && b[0] - a[0] < 2) {
      const u = (t - a[0]) / (b[0] - a[0]);
      const x0 = a[1] ? 900 : 380, x1 = b[1] ? 900 : 380;
      const x = x0 + (x1 - x0) * u, y = 380 - Math.sin(u * Math.PI) * 260;
      g.fillStyle = '#ffe14d'; g.beginPath(); g.arc(x, y, 16, 0, 7); g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 0, W, 44);
    g.fillStyle = '#fff'; g.font = '600 22px system-ui, sans-serif';
    g.fillText('DEMO CAMERA · fake match', 16, 30);
    while (hitsVis.length > 60) hitsVis.shift();
    while (phases.length > 10) phases.shift();
  }
  const drawTimer = setInterval(draw, 33); draw();

  const stream = new MediaStream([...c.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  return {
    stream,
    stop() { clearInterval(drawTimer); clearInterval(planTimer); stream.getTracks().forEach((t) => t.stop()); ac.close(); },
  };
}
