import { GoogleDrive, MockDrive, ResumableWriter, FOLDER_MIME, sleep } from './drive.js';
import { Recorder, pickMime } from './recorder.js';
import { detectHighlights, buildPlan } from './highlights.js';
import { renderReel } from './renderer.js';

const $ = (s) => document.querySelector(s);
const DEMO = new URLSearchParams(location.search).has('demo');
let drive;
let recorder = null;
let busy = false; // recording or editing → warn before leaving

// ---------- settings ----------
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('rr_settings') || '{}'); } catch { /* ignore */ }
  return { length: 120, quality: '720', ...s };
})();
function saveSettings() { try { localStorage.setItem('rr_settings', JSON.stringify(settings)); } catch { /* ignore */ } }

// ---------- helpers ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
  window.scrollTo(0, 0);
}
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => { if (busy && document.visibilityState === 'visible') keepAwake(true); });
window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

function sessionName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}
function prettyDate(name) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)\.(\d\d)/.exec(name);
  if (!m) return name;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------- boot ----------
async function boot() {
  if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  $('#origin').textContent = location.origin;
  if (DEMO) {
    drive = new MockDrive();
    window.__rr = { drive, detectHighlights }; // demo-only debugging handle
    document.body.classList.add('demo');
    goHome();
    return;
  }
  const cid = (localStorage.getItem('rr_client_id') || (window.RR_CONFIG && window.RR_CONFIG.clientId) || '').trim();
  if (!cid) { show('setup'); return; }
  drive = new GoogleDrive(cid);
  try { await drive.init(); } catch (e) { toast('Could not reach Google. Are you online?'); }
  goHome();
}

$('#setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#client-id').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like a Client ID (it ends in .apps.googleusercontent.com)'); return; }
  localStorage.setItem('rr_client_id', v);
  location.reload();
});
$('#reset-client').addEventListener('click', () => {
  if (confirm('Forget the Google Client ID on this phone?')) { localStorage.removeItem('rr_client_id'); location.reload(); }
});

// ---------- home ----------
function goHome() {
  show('home');
  renderSettings();
  renderHome();
}

function renderSettings() {
  document.querySelectorAll('[data-len]').forEach((b) => {
    b.classList.toggle('on', +b.dataset.len === settings.length);
    b.onclick = () => { settings.length = +b.dataset.len; saveSettings(); renderSettings(); };
  });
  document.querySelectorAll('[data-q]').forEach((b) => {
    b.classList.toggle('on', b.dataset.q === settings.quality);
    b.onclick = () => { settings.quality = b.dataset.q; saveSettings(); renderSettings(); };
  });
}

$('#connect').addEventListener('click', () => {
  drive.signIn('').then(renderHome).catch((e) => toast('Google sign-in did not finish: ' + e.message));
});

async function renderHome() {
  const signedIn = drive.valid;
  $('#connect-card').hidden = signedIn;
  $('#record-btn').disabled = !signedIn;
  const list = $('#list');
  if (!signedIn) { list.replaceChildren(); return; }
  list.replaceChildren(el('p', 'muted', 'Loading your recordings…'));
  try {
    const root = await drive.root();
    const folders = (await drive.listChildren(root))
      .filter((f) => f.mimeType === FOLDER_MIME)
      .sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));
    if (!folders.length) { list.replaceChildren(el('p', 'muted', 'No recordings yet. Tap the red button to film your first game.')); return; }
    list.replaceChildren(...folders.map(card));
  } catch (e) {
    if (e.auth) { $('#connect-card').hidden = false; list.replaceChildren(); return; }
    list.replaceChildren(el('p', 'muted', 'Could not load recordings: ' + e.message));
  }
}

function card(folder) {
  const c = el('div', 'card');
  const top = el('div', 'card-top');
  top.append(el('div', 'card-title', prettyDate(folder.name)));
  const info = el('div', 'card-info muted', '…');
  top.append(info);
  c.append(top);
  const actions = el('div', 'card-actions');
  c.append(actions);
  drive.listChildren(folder.id).then((files) => {
    const clips = files.filter((f) => /^clip_\d+\./.test(f.name));
    const reel = files.filter((f) => f.name.startsWith('Highlights')).sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''))[0];
    const mb = clips.reduce((a, f) => a + Number(f.size || 0), 0) / 1048576;
    info.textContent = clips.length
      ? `≈ ${fmtTime(clips.length * 10)} filmed · ${mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'}`
      : reel ? 'raw clips removed' : 'no video saved';
    if (reel) {
      const link = drive.viewLink(reel);
      if (link) { const a = el('a', 'btn', '▶ Watch highlights'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; actions.append(a); }
    }
    if (clips.length) {
      const mk = el('button', reel ? 'btn ghost' : 'btn primary', reel ? '↻ Remake' : '✨ Make Highlights');
      mk.onclick = () => makeHighlights(folder);
      actions.append(mk);
    }
    const more = el('button', 'btn ghost small', '⋯');
    more.onclick = () => manage(folder, clips, reel);
    actions.append(more);
  }).catch(() => { info.textContent = 'could not load'; });
  return c;
}

async function manage(folder, clips, reel) {
  if (reel && clips.length && confirm(`Free up Drive space?\n\nThis moves the ${clips.length} raw clips of this game to the Drive trash and keeps the highlight video.`)) {
    try {
      for (let i = 0; i < clips.length; i += 8) await Promise.all(clips.slice(i, i + 8).map((f) => drive.trash(f.id)));
      toast('Raw clips moved to Drive trash (Drive empties it after 30 days).');
    } catch (e) { toast('Could not remove: ' + e.message); }
    renderHome();
    return;
  }
  if (confirm('Delete this whole recording (and its highlights)?\n\nIt goes to your Google Drive trash.')) {
    try { await drive.trash(folder.id); toast('Moved to Drive trash.'); } catch (e) { toast('Could not delete: ' + e.message); }
    renderHome();
  }
}

// ---------- record ----------
$('#record-btn').addEventListener('click', () => {
  show('record');
  $('#rec-idle').hidden = false; $('#rec-live').hidden = true; $('#rec-finish').hidden = true;
  $('#reauth').hidden = true;
  recorder = new Recorder(drive, { onStatus: recStatus, onNeedAuth: (on) => { $('#reauth').hidden = !on; if (on && navigator.vibrate) navigator.vibrate(200); } });
  recorder.openCamera($('#preview'), settings.quality, DEMO)
    .then(() => keepAwake(true))
    .catch((e) => { toast('Camera blocked: ' + e.message + '. Allow camera + microphone for this site.'); recorder = null; goHome(); });
});

$('#rec-back').addEventListener('click', () => { if (recorder) recorder.closeCamera(); recorder = null; keepAwake(false); goHome(); });

$('#rec-start').addEventListener('click', () => {
  if (!recorder || !recorder.stream) return;
  try { pickMime(); } catch (e) { toast(e.message); return; }
  recorder.prime(); // must happen right in the tap
  recorder.start(sessionName());
  busy = true;
  $('#rec-idle').hidden = true; $('#rec-live').hidden = false;
  const tick = () => {
    if (!recorder || !recorder.recording) return;
    $('#rec-time').textContent = fmtTime(recorder.elapsed);
    setTimeout(tick, 500);
  };
  tick();
});

function recStatus(s) {
  $('#rec-cloud').textContent = s.waiting
    ? `☁ ${s.uploaded} saved · ${s.waiting} sending (${s.waitingMB.toFixed(0)} MB)`
    : `☁ ${s.uploaded} saved to Drive`;
  $('#rec-cloud').classList.toggle('warn', s.waitingMB > 120);
}

$('#rec-mark').addEventListener('click', () => {
  if (!recorder) return;
  recorder.mark();
  const b = $('#rec-mark');
  b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 400);
  if (navigator.vibrate) navigator.vibrate(40);
  toast('★ Marked – this moment will be in your highlights', 1600);
});

$('#reauth').addEventListener('click', () => {
  drive.signIn('').then(() => { $('#reauth').hidden = true; }).catch(() => toast('Sign-in did not finish – tap again.'));
});

$('#rec-stop').addEventListener('click', async () => {
  if (!recorder || !recorder.recording) return;
  if (!drive.valid) drive.signIn('').catch(() => {}); // refresh sign-in inside the tap, needed to save the summary
  $('#rec-live').hidden = true; $('#rec-finish').hidden = false;
  const r = recorder;
  const res = await r.stop((n, mb) => { $('#finish-msg').textContent = `Sending the last ${n} piece${n === 1 ? '' : 's'} to Drive (${mb.toFixed(0)} MB)… keep the app open`; });
  busy = false;
  keepAwake(false);
  recorder = null;
  justRecorded = { id: res.folderId, name: r.folderName };
  show('done');
  $('#done-msg').textContent = `${fmtTime(res.meta.duration)} saved to your Google Drive${r.failed ? ` (${r.failed} pieces failed to upload)` : ''}. Nothing was kept on your phone.`;
});

let justRecorded = null;
$('#done-make').addEventListener('click', () => { if (justRecorded) makeHighlights(justRecorded); });
$('#done-home').addEventListener('click', goHome);

// ---------- make highlights ----------
let editStop = false;
async function makeHighlights(folder) {
  // everything that needs "a tap" happens first, before any waiting
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  if (ac.resume) ac.resume();
  const authP = drive.valid ? Promise.resolve() : drive.signIn('');
  busy = true; editStop = false;
  keepAwake(true);
  show('edit');
  $('#edit-result').hidden = true; $('#edit-working').hidden = false;
  $('#edit-bar').style.width = '0%';
  const say = (m) => { $('#edit-msg').textContent = m; };
  let reelUrl = null;
  const cache = new Map();
  try {
    await authP;
    say('Reading your recording…');
    const files = await drive.listChildren(folder.id);
    const clipFiles = files.filter((f) => /^clip_\d+\./.test(f.name))
      .map((f) => ({ i: parseInt(f.name.slice(5), 10), id: f.id })).sort((a, b) => a.i - b.i);
    if (!clipFiles.length) throw new Error('No video found in this recording.');
    const metaFile = files.find((f) => f.name === 'meta.json') ||
      files.filter((f) => /^meta_\d+\.json$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
    const meta = metaFile ? await drive.downloadJson(metaFile.id) : { segSec: 10, segments: [], marks: [] };
    const segSec = meta.segSec || 10;
    const known = new Map((meta.segments || []).map((s) => [s.i, s]));
    const segs = clipFiles.map((c) => {
      const s = known.get(c.i) || { t0: c.i * segSec, t1: (c.i + 1) * segSec };
      return { i: c.i, id: c.id, t0: s.t0, t1: s.t1 };
    });
    segs.forEach((s, k) => {
      const n = segs[k + 1];
      s.effEnd = n && n.i === s.i + 1 ? Math.max(s.t0 + 0.1, Math.min(s.t1, n.t0)) : s.t1;
    });
    meta.duration = Math.max(meta.duration || 0, segs[segs.length - 1].t1);

    say('Finding the best rallies…');
    const { clips, best } = detectHighlights(meta, settings.length);
    if (!clips.length) throw new Error('Could not find any rallies in this recording.');
    const plan = buildPlan(clips, best, segs);
    const byI = new Map(segs.map((s) => [s.i, s]));

    const getSeg = (i) => {
      if (!cache.has(i)) {
        cache.set(i, (async () => {
          let blob;
          for (let a = 0; ; a++) {
            try { blob = await drive.download(byI.get(i).id); break; } catch (e) { if (a >= 3) throw e; await sleep(1500); }
          }
          const url = URL.createObjectURL(blob);
          let audio = null;
          try { audio = await ac.decodeAudioData(await blob.arrayBuffer()); } catch { /* no sound in this piece */ }
          return { url, audio };
        })());
        // fetch the next couple of pieces in the background
      }
      return cache.get(i);
    };
    const releaseSeg = (i) => {
      const p = cache.get(i);
      cache.delete(i);
      if (p) p.then((s) => URL.revokeObjectURL(s.url)).catch(() => {});
    };

    const mime = pickMime();
    const base = mime.split(';')[0];
    const ext = base.includes('mp4') ? 'mp4' : 'webm';
    const uri = await drive.createSession(`Highlights ${folder.name}.${ext}`, folder.id, base);
    const writer = new ResumableWriter(drive, uri);
    const mem = [];
    const sink = { push: (b) => { mem.push(b); writer.push(b); } };

    say(`Editing ${clips.length} highlight${clips.length === 1 ? '' : 's'}… keep this screen open`);
    await renderReel({
      plan, canvas: $('#edit-canvas'), ac, getSeg, releaseSeg, sink, mime,
      dateLabel: prettyDate(folder.name),
      onProgress: (p) => { $('#edit-bar').style.width = (p * 100).toFixed(1) + '%'; },
      shouldStop: () => editStop,
    });
    if (editStop) throw new Error('Stopped.');
    say('Saving to Google Drive…');
    const file = await writer.finish();
    const blob = new Blob(mem, { type: base });
    reelUrl = URL.createObjectURL(blob);
    const v = $('#edit-video');
    v.src = reelUrl;
    $('#edit-working').hidden = true; $('#edit-result').hidden = false;
    $('#result-msg').textContent = `${clips.length} highlights · ${fmtTime(blob.size ? v.duration || 0 : 0)}`;
    v.onloadedmetadata = () => { if (isFinite(v.duration)) $('#result-msg').textContent = `${clips.length} highlights · ${fmtTime(v.duration)} · saved to Drive`; };
    const link = file && drive.viewLink(file);
    $('#open-drive').hidden = !link;
    if (link) $('#open-drive').href = link;
    $('#share').onclick = async () => {
      const f = new File([blob], `Volleyball highlights ${folder.name}.${ext}`, { type: base });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f], title: 'Volleyball highlights' }); } catch { /* cancelled */ }
      } else if (link) window.open(link, '_blank');
      else toast('Sharing is not supported in this browser.');
    };
  } catch (e) {
    toast(e.auth ? 'Please connect Google Drive first.' : e.message || String(e), 6000);
    goHome();
  } finally {
    busy = false;
    keepAwake(false);
    cache.forEach((p) => p.then((s) => URL.revokeObjectURL(s.url)).catch(() => {}));
    setTimeout(() => { try { ac.close(); } catch { /* ignore */ } }, 500);
    $('#edit-done').onclick = () => {
      const v = $('#edit-video'); v.pause(); v.removeAttribute('src'); v.load();
      if (reelUrl) URL.revokeObjectURL(reelUrl);
      goHome();
    };
  }
}
$('#edit-cancel').addEventListener('click', () => { if (confirm('Stop editing?')) editStop = true; });

boot();
