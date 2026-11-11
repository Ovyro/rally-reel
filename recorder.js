// Records the camera in 10-second pieces and sends each piece to Google Drive
// the moment it's finished. Pieces live only in memory until uploaded, then are
// dropped – nothing is written to the phone's storage.

import { LiveAnalyzer } from './analyzer.js?v=11';
import { createDemoStream } from './demo.js?v=11';
import { sleep } from './drive.js?v=11';

export const SEG_SEC = 10;
const POOL_CLIPS = 400; // upload slots reserved ahead (~66 min) so long matches survive sign-in expiry
const POOL_META = 40;

const clipName = (i, ext) => `clip_${String(i).padStart(5, '0')}.${ext}`;
const metaName = (v) => `meta_${String(v).padStart(4, '0')}.json`;

export function pickMime() {
  const list = [
    'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const m = list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!m) throw new Error('This browser cannot record video. Use Chrome (Android) or Safari (iPhone).');
  return m;
}

export class Recorder {
  constructor(drive, ui) {
    this.drive = drive;
    this.ui = ui; // { onStatus(s), onNeedAuth(bool) }
    this.pool = new Map();
    this.queue = [];
    this.active = 0;
    this.uploaded = 0;
    this.failed = 0;
    this.queuedBytes = 0;
    this.recording = false;
    this.stops = [];
  }

  openCamera(video, quality, demo) {
    this.video = video;
    this.vbr = quality === '1080' ? 6e6 : 3.5e6;
    if (demo) {
      this.demo = createDemoStream(); // synchronous: keeps the tap's audio permission
      this.stream = this.demo.stream;
      video.srcObject = this.stream; video.muted = true;
      return video.play().catch(() => {});
    }
    const [w, h] = quality === '1080' ? [1920, 1080] : [1280, 720];
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }).then((s) => {
      this.stream = s;
      video.srcObject = s; video.muted = true;
      return video.play().catch(() => {});
    });
  }

  closeCamera() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.demo) this.demo.stop();
    this.stream = null;
  }

  // Call straight from the record tap.
  prime() {
    this.analyzer = new LiveAnalyzer(this.stream, this.video);
    this.analyzer.prime();
  }

  // opts: { startMs (shared clock), room: {code, ...}, who, onFolder(id) }
  start(folderName, opts = {}) {
    this.mime = pickMime();
    this.baseMime = this.mime.split(';')[0];
    this.ext = this.baseMime.includes('mp4') ? 'mp4' : 'webm';
    this.folderName = folderName;
    this.opts = opts;
    this.folderP = (async () => {
      for (let a = 0; ; a++) {
        try {
          if (!this.drive.valid) { this.ui.onNeedAuth(true); await sleep(3000); continue; }
          const id = await this.drive.createFolder(folderName, await this.drive.root());
          // link-share the folder so room-mates' phones can play these clips
          this.drive.makePublic(id).catch(() => {});
          return id;
        } catch (e) { await sleep(Math.min(20000, 1000 * 2 ** a)); }
      }
    })();
    this.folderP.then((id) => {
      this.folderId = id;
      opts.onFolder && opts.onFolder(id);
      // small preview picture for the game card
      setTimeout(async () => {
        try {
          const { snapshot } = await import('./importer.js?v=11');
          const b = await snapshot(this.video);
          if (b) await this.drive.uploadThumb(b, id);
        } catch { /* no thumbnail */ }
      }, 1500);
    });
    this.meta = {
      v: 2, app: 'rally-reel', kind: 'live', name: folderName, created: new Date().toISOString(),
      startMs: opts.startMs || Date.now(), who: opts.who || '', room: opts.room ? opts.room.code : null,
      mime: this.baseMime, ext: this.ext, segSec: SEG_SEC, segments: [], marks: [],
    };
    this.t0 = performance.now();
    this.clock = () => (performance.now() - this.t0) / 1000;
    this.analyzer.start(this.clock);
    this.recording = true;
    this.segIndex = 0;
    this.poolNextClip = 0;
    this.poolNextMeta = 1;
    this.metaVersion = 0;
    this._startSegment();
    this.rotTimer = setInterval(() => this._rotate(), SEG_SEC * 1000);
    this.metaTimer = setInterval(() => this._backupMeta(), 60000);
    this._poolLoop();
    this._status();
  }

  get elapsed() { return this.recording ? this.clock() : this.meta ? this.meta.duration || 0 : 0; }

  mark() {
    if (!this.recording) return;
    this.meta.marks.push(Math.round(this.clock() * 100) / 100);
  }

  _startSegment() {
    const i = this.segIndex;
    const mr = new MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: this.vbr, audioBitsPerSecond: 128000 });
    const seg = { i, t0: this.clock(), t1: null };
    const chunks = [];
    let done;
    const stopped = new Promise((res) => { done = res; });
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      seg.t1 = this.clock();
      this._enqueue(seg, new Blob(chunks, { type: this.baseMime }));
      done();
    };
    mr.onerror = () => { this.overlapOK = false; };
    mr.onstart = () => { seg.t0 = this.clock(); };
    mr.start(1000); // throws if this phone can't run another recorder right now
    this.segIndex++;
    this.stops.push(stopped);
    this.cur = mr;
  }

  // Start the next piece a moment BEFORE stopping the old one so no frame is lost.
  // Phones that can't run two recorders at once fall back to stop-then-start.
  _rotate() {
    const old = this.cur;
    if (this.overlapOK !== false && old && old.state !== 'inactive') {
      try {
        this._startSegment();
        setTimeout(() => { if (old.state !== 'inactive') old.stop(); }, 300);
        return;
      } catch { this.overlapOK = false; }
    }
    const next = () => {
      if (!this.recording) return;
      try { this._startSegment(); } catch { setTimeout(next, 500); }
    };
    if (!old || old.state === 'inactive') { next(); return; }
    old.addEventListener('stop', () => setTimeout(next, 0), { once: true });
    old.stop();
  }

  _enqueue(seg, blob) {
    const r = (x) => Math.round(x * 1000) / 1000;
    const entry = { i: seg.i, t0: r(seg.t0), t1: r(seg.t1) };
    this.meta.segments.push(entry);
    if (!blob.size) return;
    this.queue.push({ seg, blob, entry });
    this.queuedBytes += blob.size;
    this._status();
    this._pump();
  }

  _pump() {
    while (this.active < 2 && this.queue.length) {
      const item = this.queue.shift();
      this.active++;
      this._upload(item).finally(() => { this.active--; this._status(); this._pump(); });
    }
  }

  async _sessionFor(name, mime) {
    let uri = this.pool.get(name);
    if (uri) return uri;
    if (!this.drive.valid) return null;
    const folder = await this.folderP;
    return this.drive.createSession(name, folder, mime);
  }

  async _upload({ seg, blob, entry }) {
    const name = clipName(seg.i, this.ext);
    for (let a = 0; ; a++) {
      try {
        const uri = await this._sessionFor(name, this.baseMime);
        if (!uri) { this.ui.onNeedAuth(true); await sleep(3000); a = 0; continue; }
        const f = await this.drive.putBlob(uri, blob);
        if (f && f.id) entry.id = f.id;
        this.pool.delete(name);
        this.uploaded++;
        this.queuedBytes -= blob.size;
        this.ui.onNeedAuth(false);
        return;
      } catch (e) {
        if (e.status === 404 || e.status === 410) this.pool.delete(name); // expired slot → get a new one
        if (a > 60) { this.failed++; this.queuedBytes -= blob.size; return; }
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(a, 5)));
      }
    }
  }

  async _poolLoop() {
    const folder = await this.folderP;
    while (this.recording) {
      try {
        if (!this.drive.valid) { await sleep(3000); continue; }
        if (this.poolNextClip - this.segIndex < POOL_CLIPS) {
          const i = Math.max(this.poolNextClip, this.segIndex);
          this.poolNextClip = i + 1;
          const name = clipName(i, this.ext);
          if (!this.pool.has(name)) this.pool.set(name, await this.drive.createSession(name, folder, this.baseMime));
        } else if (this.poolNextMeta - this.metaVersion < POOL_META) {
          const v = this.poolNextMeta++;
          this.pool.set(metaName(v), await this.drive.createSession(metaName(v), folder, 'application/json'));
        } else { await sleep(5000); continue; }
        await sleep(250);
      } catch { await sleep(5000); }
    }
  }

  snapshot() {
    return {
      ...this.meta,
      segments: [...this.meta.segments].sort((a, b) => a.i - b.i),
      duration: Math.round(this.elapsed * 100) / 100,
      timeline: this.analyzer ? this.analyzer.tl : null,
    };
  }

  async _backupMeta() {
    try {
      const v = ++this.metaVersion;
      const uri = await this._sessionFor(metaName(v), 'application/json');
      if (!uri) return;
      const f = await this.drive.putBlob(uri, new Blob([JSON.stringify(this.snapshot())], { type: 'application/json' }));
      this.pool.delete(metaName(v));
      if (f && f.id && this.opts.onMeta) this.opts.onMeta(f.id, this.snapshot(), false);
    } catch { /* next backup will try again */ }
  }

  _status() {
    this.ui.onStatus({
      uploaded: this.uploaded, waiting: this.queue.length + this.active,
      waitingMB: Math.max(0, this.queuedBytes) / 1048576, failed: this.failed,
    });
  }

  async stop(onProgress) {
    this.meta.duration = this.clock();
    this.recording = false;
    clearInterval(this.rotTimer); clearInterval(this.metaTimer);
    if (this.cur && this.cur.state !== 'inactive') this.cur.stop();
    await Promise.all(this.stops);
    this.analyzer.stop();
    this.closeCamera();
    while (this.queue.length || this.active) {
      onProgress && onProgress(this.queue.length + this.active, this.queuedBytes / 1048576);
      await sleep(400);
    }
    const snap = this.snapshot();
    snap.duration = Math.round(this.meta.duration * 100) / 100;
    snap.complete = true;
    const folder = await this.folderP;
    let metaId = null;
    for (let a = 0; a < 20; a++) {
      try {
        if (!this.drive.valid) { this.ui.onNeedAuth(true); await sleep(3000); continue; }
        metaId = (await this.drive.uploadJson('meta.json', folder, snap)).id;
        break;
      } catch { await sleep(2000); }
    }
    if (metaId && this.opts.onMeta) await this.opts.onMeta(metaId, snap, true);
    this.ui.onNeedAuth(false);
    return { folderId: folder, meta: snap };
  }
}
