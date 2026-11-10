// Listens + watches while recording and writes a tiny "timeline" (4 values per 1/4 second):
//   loud    – loudness in dB (crowd / team cheering after a point)
//   hits    – sharp sound onsets (ball contacts)
//   whistle – referee whistle strength 0..1
//   motion  – how much the picture is moving
// Only these numbers are kept – no extra video is stored anywhere.

const DT = 0.25;

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

export class LiveAnalyzer {
  constructor(stream, video) {
    this.stream = stream;
    this.video = video;
    this.tl = { dt: DT, loud: [], hits: [], whistle: [], motion: [] };
  }

  // Call straight from a tap (phones only allow audio to start from a tap).
  prime() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.resume) this.ctx.resume();
  }

  start(clock) {
    this.clock = clock;
    const ctx = this.ctx;
    if (this.stream.getAudioTracks().length) {
      const src = ctx.createMediaStreamSource(this.stream);
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;
      src.connect(an);
      const mute = ctx.createGain(); mute.gain.value = 0; // keeps Safari processing, makes no sound
      an.connect(mute); mute.connect(ctx.destination);
      this.an = an;
      this.timeBuf = new Float32Array(an.fftSize);
      this.freq = new Float32Array(an.frequencyBinCount);
      this.prevMag = new Float32Array(an.frequencyBinCount);
      const hz = ctx.sampleRate / an.fftSize;
      this.fluxLo = Math.round(1000 / hz); this.fluxHi = Math.round(8000 / hz);
      this.wLo = Math.round(2000 / hz); this.wHi = Math.round(4500 / hz);
    }
    this.fluxHist = [];
    this.lastHit = -1;
    this.whistleRun = 0;
    this.bin = { loud: -100, hits: 0, whistle: 0 };
    this.mc = document.createElement('canvas');
    this.mc.width = 64; this.mc.height = 36;
    this.mctx = this.mc.getContext('2d', { willReadFrequently: true });
    this.prevFrame = null;
    this.lastMotion = 0;
    this.fast = setInterval(() => this._audioTick(), 40);
    this.slow = setInterval(() => this._binTick(), DT * 1000);
  }

  _audioTick() {
    const an = this.an;
    if (!an) return;
    an.getFloatTimeDomainData(this.timeBuf);
    let sq = 0;
    for (let i = 0; i < this.timeBuf.length; i++) sq += this.timeBuf[i] * this.timeBuf[i];
    const db = 20 * Math.log10(Math.sqrt(sq / this.timeBuf.length) + 1e-9);
    if (db > this.bin.loud) this.bin.loud = db;

    an.getFloatFrequencyData(this.freq);
    // spectral flux → ball contacts
    let flux = 0;
    for (let k = this.fluxLo; k < this.fluxHi; k++) {
      const m = Math.pow(10, this.freq[k] / 20);
      const d = m - this.prevMag[k];
      if (d > 0) flux += d;
      this.prevMag[k] = m;
    }
    const h = this.fluxHist;
    h.push(flux); if (h.length > 50) h.shift();
    const now = this.clock();
    if (h.length > 10 && flux > median(h) * 3.5 && db > -55 && now - this.lastHit > 0.12) {
      this.bin.hits++;
      this.lastHit = now;
    }
    // whistle → strong narrow tone between 2 and 4.5 kHz held for a moment
    let peak = -200, sum = 0, n = 0;
    for (let k = this.wLo; k < this.wHi; k++) { const v = this.freq[k]; if (v > peak) peak = v; sum += v; n++; }
    const prom = peak - sum / Math.max(1, n);
    if (peak > -60 && prom > 26) this.whistleRun++; else this.whistleRun = 0;
    if (this.whistleRun >= 3) this.bin.whistle = Math.max(this.bin.whistle, Math.min(1, 0.35 + (prom - 26) / 20));
  }

  _motion() {
    const v = this.video;
    if (!v || v.readyState < 2) return this.lastMotion;
    try {
      this.mctx.drawImage(v, 0, 0, 64, 36);
      const d = this.mctx.getImageData(0, 0, 64, 36).data;
      const g = new Uint8Array(64 * 36);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
      let diff = 0;
      if (this.prevFrame) for (let j = 0; j < g.length; j++) diff += Math.abs(g[j] - this.prevFrame[j]);
      this.prevFrame = g;
      this.lastMotion = diff / g.length;
    } catch { /* frame not ready */ }
    return this.lastMotion;
  }

  _binTick() {
    const t = this.tl;
    const idx = Math.floor(this.clock() / DT);
    const motion = Math.round(this._motion() * 10) / 10;
    const loud = Math.round(Math.max(-100, this.bin.loud));
    const whistle = Math.round(this.bin.whistle * 100) / 100;
    // keep the timeline aligned to real time even if the phone hiccups
    while (t.loud.length <= idx) {
      t.loud.push(loud); t.hits.push(t.loud.length - 1 === idx ? this.bin.hits : 0);
      t.whistle.push(whistle); t.motion.push(motion);
    }
    this.bin = { loud: -100, hits: 0, whistle: 0 };
  }

  stop() {
    clearInterval(this.fast); clearInterval(this.slow);
    try { this.ctx && this.ctx.close(); } catch { /* ignore */ }
  }
}
