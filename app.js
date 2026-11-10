import { GoogleDrive, MockDrive, ResumableWriter, FOLDER_MIME, sleep } from './drive.js?v=6';
import { Recorder, pickMime } from './recorder.js?v=6';
import { detectHighlights, buildMultiPlan, alignRecordings } from './highlights.js?v=6';
import { renderReel, makePlayers } from './renderer.js?v=6';
import { analyzeFile, guessMime } from './importer.js?v=6';
import * as R from './rooms.js?v=6';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const FAKECAM = DEMO || params.has('fakecam');
let drive;
let recorder = null;
let busy = false;

// ---------- settings ----------
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('rr_settings') || '{}'); } catch { /* ignore */ }
  return { length: 120, quality: '720', ...s };
})();
const saveSettings = () => { try { localStorage.setItem('rr_settings', JSON.stringify(settings)); } catch { /* ignore */ } };
const myName = () => ((FAKECAM && params.get('as')) || localStorage.getItem('rr_name') || '').trim() || 'Me';

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
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function avatar(name, cls = 'avatar') {
  const a = el('div', cls, (name || '?').trim().charAt(0).toUpperCase());
  const h = hue(name);
  a.style.background = `linear-gradient(135deg, hsl(${h} 85% 60%), hsl(${(h + 40) % 360} 80% 45%))`;
  return a;
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => { if (busy && document.visibilityState === 'visible') keepAwake(true); });
window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`; }
function parseFolder(name) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)\.(\d\d)(?: · (.*?))?(?: \[([A-Z0-9]{4,8})\])?$/.exec(name || '');
  if (!m) return { date: null, label: name, code: null };
  return { date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]), label: m[6] || '', code: m[7] || null };
}
function prettyDate(d) {
  if (!d) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------- bottom sheet ----------
function sheet(build) {
  const bg = $('#sheet-bg'), sh = $('#sheet'), body = $('#sheet-body');
  body.replaceChildren();
  let done;
  const p = new Promise((r) => { done = r; });
  const close = (v) => { bg.hidden = true; sh.hidden = true; bg.onclick = null; done(v); };
  build(body, close);
  bg.hidden = false; sh.hidden = false;
  bg.onclick = () => close(null);
  return p;
}
function confirmSheet(title, text, yes = 'Yes', danger = false) {
  return sheet((b, close) => {
    b.append(el('h3', '', title), el('p', 'muted', text));
    const btns = el('div', 'btns');
    const y = el('button', danger ? 'btn rec big' : 'btn primary big', yes); y.onclick = () => close(true);
    const n = el('button', 'btn ghost big', 'Cancel'); n.onclick = () => close(false);
    btns.append(y, n); b.append(btns);
  });
}

// ---------- boot ----------
async function boot() {
  if ('serviceWorker' in navigator && !FAKECAM && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (DEMO) {
    drive = new MockDrive();
    document.body.classList.add('demo');
  } else {
    drive = new GoogleDrive(window.RR_CONFIG.clientId);
    try { await drive.init(); } catch { toast('Could not reach Google. Are you online?'); }
  }
  window.__rr = {
    drive, detectHighlights, buildMultiPlan, alignRecordings, R, get room() { return roomState; },
    // test hook: run the gallery-upload flow on File objects
    importTest: (files, room) => { const AC = window.AudioContext || window.webkitAudioContext; return importFiles(files, { ac: new AC(), room: room || null }); },
  };
  if (!localStorage.getItem('rr_name') && !DEMO) { show('onboard'); return; }
  afterReady();
}

function afterReady() {
  const code = R.cleanCode(params.get('room'));
  if (code && !DEMO) {
    history.replaceState(null, '', location.pathname + (FAKECAM ? location.search.replace(/[?&]room=[^&]*/, '') : ''));
    if (drive.valid) enterRoom(code, true); else { pendingRoom = code; goHome(); toast(`Connect Google Drive to join room ${code}`, 5000); }
    return;
  }
  goHome();
}
let pendingRoom = null;

$('#ob-go').addEventListener('click', () => {
  const v = $('#ob-name').value.trim();
  if (!v) { $('#ob-name').focus(); toast('Type your name first'); return; }
  localStorage.setItem('rr_name', v.slice(0, 20));
  afterReady();
});
$('#ob-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ob-go').click(); });

// Run fn only when signed in to Google. If not, ask (inside the same tap).
function needDrive(fn) {
  if (drive.valid) return fn();
  drive.signIn('').then(() => { renderHome(); if (pendingRoom) { const c = pendingRoom; pendingRoom = null; enterRoom(c, true); } })
    .catch((e) => toast('Google sign-in did not finish: ' + e.message));
}

// ---------- home ----------
function goHome() {
  show('home');
  const n = myName();
  $('#hello').textContent = `Hey ${n} 👋`;
  const av = avatar(n); $('#me-btn').textContent = av.textContent; $('#me-btn').style.background = av.style.background;
  renderHome();
}

$('#connect').addEventListener('click', () => needDrive(() => {}));
$('#refresh').addEventListener('click', () => renderHome());
$('#me-btn').addEventListener('click', openSettings);
$('#t-settings').addEventListener('click', openSettings);

async function renderHome() {
  const signedIn = drive.valid;
  $('#connect-card').hidden = signedIn;
  const list = $('#list');
  if (!signedIn) {
    list.replaceChildren(Object.assign(el('div', 'empty'), { innerHTML: '<b>Connect Google Drive to start</b>Your games live in your own Drive – nothing fills up your phone.' }));
    return;
  }
  if (pendingRoom) { const c = pendingRoom; pendingRoom = null; enterRoom(c, true); return; }
  list.replaceChildren(el('p', 'muted', 'Loading your games…'));
  try {
    const root = await drive.root();
    const folders = (await drive.listChildren(root))
      .filter((f) => f.mimeType === FOLDER_MIME)
      .sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));
    if (!folders.length) {
      list.replaceChildren(Object.assign(el('div', 'empty'), { innerHTML: '<b>No games yet</b>Tap the big red button to film your first one, or upload videos from your gallery.' }));
      return;
    }
    list.replaceChildren(...folders.map(gameCard));
  } catch (e) {
    if (e.auth) { $('#connect-card').hidden = false; list.replaceChildren(); return; }
    list.replaceChildren(el('p', 'muted', 'Could not load games: ' + e.message));
  }
}

function gameCard(folder) {
  const info = parseFolder(folder.name);
  const c = el('div', 'game');
  const th = el('div', 'thumb');
  const body = el('div', 'game-body');
  const title = el('div', 'game-title', info.label ? info.label.replace(/ highlights$/, '') : 'Game');
  if (info.code) title.append(el('span', 'room-chip', '👥 ROOM'));
  const meta = el('div', 'game-info', prettyDate(info.date));
  const sub = el('div', 'game-info', '…');
  const actions = el('div', 'game-actions');
  body.append(title, meta, sub, actions);
  c.append(th, body);
  drive.listChildren(folder.id).then((files) => {
    const clips = files.filter((f) => /^clip_\d+\./.test(f.name));
    const video = files.find((f) => /^video\./.test(f.name));
    const reel = files.filter((f) => f.name.startsWith('Highlights')).sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''))[0];
    const thumb = files.find((f) => f.name === 'thumb.jpg');
    if (thumb) th.style.backgroundImage = `url("${drive.publicUrl(thumb.id)}")`;
    const mb = (clips.reduce((a, f) => a + Number(f.size || 0), 0) + Number(video ? video.size || 0 : 0)) / 1048576;
    const size = mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
    sub.textContent = clips.length ? `≈ ${fmtTime(clips.length * 10)} filmed · ${size}` : video ? `Uploaded video · ${size}` : reel ? 'Highlights' : 'Nothing saved';
    if (reel) th.append(el('span', 'tag reel', '✓ HIGHLIGHTS'));
    else if (clips.length || video) th.append(el('span', 'tag', clips.length ? 'RAW' : 'UPLOAD'));
    if (reel) {
      const link = drive.viewLink(reel);
      if (link) { const a = el('a', 'btn primary', '▶ Watch'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; actions.append(a); }
    }
    if (info.code && !DEMO) { const b = el('button', 'btn', '👥 Room'); b.onclick = () => enterRoom(info.code, true); actions.append(b); }
    if ((clips.length || video) && !info.label.endsWith('highlights')) {
      const mk = el('button', reel ? 'btn' : 'btn magic', reel ? '↻ Remake' : '✨ Highlights');
      mk.onclick = () => makeHighlights({ folder });
      actions.append(mk);
    }
    const more = el('button', 'btn ghost', '⋯');
    more.onclick = () => manage(folder, clips.concat(video ? [video] : []), reel);
    actions.append(more);
  }).catch(() => { sub.textContent = 'could not load'; });
  return c;
}

async function manage(folder, raw, reel) {
  const choice = await sheet((b, close) => {
    b.append(el('h3', '', 'This game'));
    const btns = el('div', 'btns');
    if (reel && raw.length) {
      const f = el('button', 'btn big', `🧹 Free up space (remove ${raw.length} raw file${raw.length === 1 ? '' : 's'}, keep highlights)`);
      f.onclick = () => close('free'); btns.append(f);
    }
    const d = el('button', 'btn rec big', '🗑 Delete this game'); d.onclick = () => close('delete');
    const x = el('button', 'btn ghost big', 'Cancel'); x.onclick = () => close(null);
    btns.append(d, x); b.append(btns);
  });
  if (choice === 'free') {
    try {
      for (let i = 0; i < raw.length; i += 8) await Promise.all(raw.slice(i, i + 8).map((f) => drive.trash(f.id)));
      toast('Raw footage moved to your Drive trash.');
    } catch (e) { toast('Could not remove: ' + e.message); }
  } else if (choice === 'delete') {
    if (await confirmSheet('Delete this game?', 'It goes to your Google Drive trash (Drive empties it after 30 days).', 'Delete', true)) {
      try { await drive.trash(folder.id); toast('Moved to Drive trash.'); } catch (e) { toast('Could not delete: ' + e.message); }
    }
  }
  renderHome();
}

function openSettings() {
  sheet((b, close) => {
    b.append(el('h3', '', 'Settings'));
    const nameIn = el('input'); nameIn.value = myName(); nameIn.maxLength = 20;
    const nameField = el('label', 'field'); nameField.append(el('span', '', 'Your name (shown to your room)'), nameIn);
    b.append(nameField);
    const mkSeg = (label, key, opts) => {
      const row = el('div', 'row-set'); row.append(el('span', '', label));
      const seg = el('div', 'seg');
      opts.forEach(([v, t]) => {
        const btn = el('button', settings[key] === v ? 'on' : '', t);
        btn.onclick = () => { settings[key] = v; saveSettings(); seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn)); };
        seg.append(btn);
      });
      row.append(seg); b.append(row);
    };
    mkSeg('Highlight length', 'length', [[60, '1 min'], [120, '2 min'], [240, '4 min']]);
    mkSeg('Recording quality', 'quality', [['720', '720p'], ['1080', '1080p']]);
    b.append(el('p', 'muted small', '720p uses ≈1.6 GB of Drive per hour, 1080p ≈2.7 GB (free Drive: 15 GB). Use "⋯ → Free up space" on a game after making highlights.'));
    b.append(el('p', 'muted small', 'Privacy: videos are saved in your own Google Drive and shared by private link, so phones in your room can play them. Anyone with a link can view that video – links are never listed anywhere public.'));
    const btns = el('div', 'btns');
    const save = el('button', 'btn primary big', 'Save'); save.onclick = () => {
      const v = nameIn.value.trim(); if (v) localStorage.setItem('rr_name', v.slice(0, 20));
      close(); goHome();
    };
    btns.append(save);
    if (!DEMO && drive.valid) {
      const out = el('button', 'btn ghost big', 'Disconnect Google on this phone');
      out.onclick = () => { localStorage.removeItem('rr_tok'); location.reload(); };
      btns.append(out);
    }
    b.append(btns);
  });
}

// ---------- rooms ----------
let curRoom = null, roomUnsub = null, roomState = null, heartbeat = null;

$('#t-create').addEventListener('click', () => needDrive(async () => {
  if (DEMO) { toast('Rooms work in the real app (not in the demo).'); return; }
  const name = await sheet((b, close) => {
    b.append(el('h3', '', 'Create a room'), el('p', 'muted', 'Everyone in the room films the same game from their phone. Then anyone can make one highlight video from all angles.'));
    const inp = el('input'); inp.placeholder = 'Room name, e.g. Saturday game'; inp.maxLength = 30;
    const f = el('label', 'field'); f.append(el('span', '', 'Room name'), inp); b.append(f);
    const btns = el('div', 'btns');
    const go = el('button', 'btn primary big', 'Create room'); go.onclick = () => close(inp.value.trim() || 'Game');
    inp.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    btns.append(go); b.append(btns);
    setTimeout(() => inp.focus(), 250);
  });
  if (!name) return;
  try {
    toast('Creating room…', 1500);
    const code = await R.createRoom(name, myName());
    enterRoom(code, false);
  } catch (e) { toast('Could not create room: ' + e.message, 6000); }
}));

$('#t-join').addEventListener('click', () => needDrive(async () => {
  if (DEMO) { toast('Rooms work in the real app (not in the demo).'); return; }
  const code = await sheet((b, close) => {
    b.append(el('h3', '', 'Join a room'), el('p', 'muted', 'Type the code from your friend\'s screen.'));
    const inp = el('input', 'code-in'); inp.placeholder = 'CODE'; inp.maxLength = 8; inp.autocapitalize = 'characters'; inp.autocomplete = 'off';
    inp.oninput = () => { inp.value = R.cleanCode(inp.value); };
    b.append(inp);
    const btns = el('div', 'btns');
    const go = el('button', 'btn primary big', 'Join'); go.onclick = () => close(R.cleanCode(inp.value));
    inp.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
    btns.append(go); b.append(btns);
    setTimeout(() => inp.focus(), 250);
  });
  if (code) enterRoom(code, true);
}));

async function enterRoom(code, join) {
  try {
    show('room');
    $('#room-name').textContent = 'Joining…'; $('#room-code').textContent = code;
    $('#room-qr').hidden = true;
    if (join) await R.joinRoom(code, myName()); else await R.initRooms();
    curRoom = code;
    if (roomUnsub) roomUnsub();
    roomUnsub = R.watchRoom(code, (s) => { roomState = s; renderRoom(); });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => R.setMemberState(code, recorder && recorder.recording ? 'recording' : 'here'), 60000);
  } catch (e) {
    toast(e.message || 'Could not open the room.', 6000);
    goHome();
  }
}

function leaveRoom() {
  if (curRoom) R.setMemberState(curRoom, 'left');
  if (roomUnsub) roomUnsub();
  roomUnsub = null; curRoom = null; roomState = null;
  clearInterval(heartbeat);
  goHome();
}
$('#room-back').addEventListener('click', () => { if (roomUnsub) roomUnsub(); roomUnsub = null; clearInterval(heartbeat); curRoom = null; goHome(); });
$('#room-leave').addEventListener('click', leaveRoom);

const roomLink = () => `${location.origin}${location.pathname}?room=${curRoom}`;
$('#room-invite').addEventListener('click', async () => {
  const text = `Join my volleyball room "${(roomState && roomState.room && roomState.room.name) || ''}" on Rally Reel – code ${curRoom}`;
  if (navigator.share) { try { await navigator.share({ title: 'Rally Reel room', text, url: roomLink() }); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(roomLink()); toast('Invite link copied!'); } catch { toast(roomLink(), 8000); }
});
let qrLib = null;
$('#room-qr-btn').addEventListener('click', async () => {
  const box = $('#room-qr');
  if (!box.hidden) { box.hidden = true; return; }
  try {
    if (!qrLib) {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'; s.onload = res; s.onerror = rej; document.head.append(s); });
      qrLib = window.qrcode;
    }
    const q = qrLib(0, 'M'); q.addData(roomLink()); q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    box.hidden = false;
  } catch { toast('Could not make the QR code.'); }
});

function memberStatus(m) {
  const seen = m.seen && m.seen.toMillis ? m.seen.toMillis() : 0;
  const fresh = R.now() - seen < 3 * 60 * 1000;
  if (m.state === 'recording' && fresh) return ['live', 'Recording'];
  if (m.state === 'left') return ['', 'Left'];
  if (fresh) return ['on', m.ready ? 'Ready ✓' : 'Here'];
  return ['', 'Away'];
}

function renderRoom() {
  if (!roomState) return;
  const { room, members, recordings, reels } = roomState;
  if (!room) { $('#room-name').textContent = 'Room not found'; return; }
  $('#room-name').textContent = room.name || 'Game';
  $('#room-code').textContent = room.code;
  const ms = members.filter((m) => m.state !== 'left').sort((a, b) => (a.who || '').localeCompare(b.who || ''));
  $('#room-count').textContent = ms.length;
  $('#room-members').replaceChildren(...ms.map((m) => {
    const [cls, label] = memberStatus(m);
    const d = el('div', 'member');
    const av = avatar(m.who || '?'); const st = el('i', 'st ' + cls); av.append(st);
    d.append(av, el('b', '', (m.who || '?') + (m.id === R.memberKey() ? ' (you)' : '')), el('span', '', label));
    return d;
  }));
  const recs = [...recordings].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
  $('#room-recs').replaceChildren(...(recs.length ? recs.map((r) => {
    const row = el('div', 'rec-row');
    const txt = el('div');
    txt.append(el('b', '', (r.who || '?') + (r.kind === 'file' ? ' · uploaded video' : '')),
      el('span', '', r.status === 'recording' ? `filming… ${fmtTime(r.duration || 0)} saved` : r.status === 'uploading' ? 'uploading…' : `${fmtTime(r.duration)} of video`));
    row.append(avatar(r.who || '?'), txt);
    if (r.status === 'recording') row.append(el('span', 'badge-live', 'LIVE'));
    return row;
  }) : [el('p', 'muted', 'No footage yet. Tap "Record from my phone" when the game starts.')]));
  const usable = recordings.filter((r) => r.metaId);
  $('#room-make').disabled = !usable.length;
  $('#room-make').textContent = usable.length > 1 ? `✨ Make highlights from ${new Set(usable.map((r) => r.who)).size > 1 ? new Set(usable.map((r) => r.who)).size + ' people' : usable.length + ' videos'}` : '✨ Make highlights';
  const rl = [...reels].sort((a, b) => (b.created && b.created.toMillis ? b.created.toMillis() : 0) - (a.created && a.created.toMillis ? a.created.toMillis() : 0));
  $('#room-reels').replaceChildren(...(rl.length ? rl.map((x) => {
    const row = el('div', 'reel-row');
    const t = el('div'); t.append(el('b', '', `Highlights by ${x.who || '?'}`), el('span', '', `${x.angles || 1} angle${x.angles > 1 ? 's' : ''} · ${x.clips || 0} rallies · ${fmtTime(x.seconds)}`));
    row.append(t);
    if (x.link) { const a = el('a', 'btn primary', '▶ Watch'); a.href = x.link; a.target = '_blank'; a.rel = 'noopener'; row.append(a); }
    return row;
  }) : [el('p', 'muted small', 'Highlights anyone makes show up here for everyone.')]));
  if (recorder && recorder.recording) { updateRoomPill(); checkStopAll(); }
  else if (recorder) checkSync();
}

$('#room-rec').addEventListener('click', () => needDrive(() => openCamera(curRoom)));
$('#room-upload').addEventListener('click', () => needDrive(() => pickVideos(curRoom)));
$('#room-make').addEventListener('click', () => makeHighlights({ room: curRoom }));

// ---------- record ----------
$('#rec-solo').addEventListener('click', () => needDrive(() => openCamera(null)));

let recRoom = null;
function openCamera(roomCode) {
  recRoom = roomCode;
  show('record');
  $('#rec-idle').hidden = false; $('#rec-live').hidden = true; $('#rec-finish').hidden = true;
  $('#reauth').hidden = true;
  $('#rec-hint').textContent = roomCode ? `Room ${roomCode} · sideways, whole court in view` : 'Turn your phone sideways · point at the court';
  $('#solo-bottom').hidden = !!roomCode; $('#room-bottom').hidden = !roomCode; $('#sync-panel').hidden = !roomCode;
  $('#countdown').hidden = true; amReady = false; primed = false; syncStartAt = 0;
  $('#rec-ready').textContent = "I'm ready"; $('#rec-ready').classList.remove('on');
  if (roomCode) checkSync();
  recorder = new Recorder(drive, { onStatus: recStatus, onNeedAuth: (on) => { $('#reauth').hidden = !on; if (on && navigator.vibrate) navigator.vibrate(200); } });
  recorder.openCamera($('#preview'), settings.quality, FAKECAM)
    .then(() => keepAwake(true))
    .catch((e) => { toast('Camera blocked: ' + e.message + '. Allow camera + microphone for this site.', 6000); recorder = null; backFromCamera(); });
}
function backFromCamera() { if (recRoom && curRoom) { show('room'); renderRoom(); } else goHome(); }

$('#rec-back').addEventListener('click', () => {
  if (recRoom && amReady) R.setReady(recRoom, false).catch(() => {});
  amReady = false;
  if (recorder) recorder.closeCamera(); recorder = null; keepAwake(false); backFromCamera();
});

// ----- start together -----
let amReady = false, primed = false, syncStartAt = 0, syncTimer = null;
const present = () => (roomState ? roomState.members.filter((m) => { const c = memberStatus(m)[0]; return c === 'on' || c === 'live'; }) : []);

$('#rec-ready').addEventListener('click', () => {
  if (!recorder || !recorder.stream || !recRoom) return;
  if (!primed) { recorder.prime(); primed = true; } // audio needs this tap
  amReady = !amReady;
  $('#rec-ready').textContent = amReady ? 'Ready ✓ (tap to undo)' : "I'm ready";
  $('#rec-ready').classList.toggle('on', amReady);
  if (navigator.vibrate) navigator.vibrate(30);
  R.setReady(recRoom, amReady).catch(() => toast('Could not reach the room – check internet.'));
  checkSync();
});
$('#rec-solo-start').addEventListener('click', () => {
  if (!recorder || !recorder.stream) return;
  if (!primed) { recorder.prime(); primed = true; }
  startRecording(recRoom ? R.now() : Date.now());
});

// Every phone computes the same start time: last "ready" tap + 4 s (server clock).
function checkSync() {
  if (!recRoom || !recorder || recorder.recording || $('#record').hidden) return;
  const ps = present();
  const ready = ps.filter((m) => m.ready && m.readyAt && m.readyAt.toMillis);
  const waiting = ps.filter((m) => !(m.ready && m.readyAt));
  const box = $('#sync-people');
  box.replaceChildren(...ps.map((m) => el('span', m.ready ? 'ok' : '', (m.ready ? '✓ ' : '') + (m.id === R.memberKey() ? 'You' : m.who || '?'))));
  const someoneLive = ps.some((m) => m.state === 'recording' && m.id !== R.memberKey());
  if (!amReady) {
    syncStartAt = 0; $('#countdown').hidden = true;
    $('#sync-text').textContent = someoneLive ? 'Others are already filming – tap “I\'m ready” to join in' : 'Tap “I\'m ready” – everyone starts together';
    return;
  }
  if (waiting.length) {
    syncStartAt = 0; $('#countdown').hidden = true;
    $('#sync-text').textContent = `${ready.length}/${ps.length} ready · waiting for ${waiting.map((m) => m.who || '?').join(', ')}`;
    return;
  }
  const at = Math.max(...ready.map((m) => m.readyAt.toMillis())) + 4000;
  if (at !== syncStartAt) { syncStartAt = at; runCountdown(); }
}

function runCountdown() {
  clearInterval(syncTimer);
  $('#sync-text').textContent = 'Everyone is ready!';
  const tick = () => {
    if (!syncStartAt || !recorder || recorder.recording) { clearInterval(syncTimer); return; }
    const left = syncStartAt - R.now();
    if (left <= 0) {
      clearInterval(syncTimer);
      $('#countdown').hidden = true;
      if (left > -15000) startRecording(syncStartAt); else syncStartAt = 0;
      return;
    }
    $('#countdown').hidden = false;
    const n = String(Math.ceil(left / 1000));
    if ($('#countdown').textContent !== n) { $('#countdown').textContent = n; if (navigator.vibrate) navigator.vibrate(60); }
  };
  syncTimer = setInterval(tick, 50); tick();
}

function updateRoomPill() {
  const p = $('#rec-room');
  if (!recRoom || !roomState) { p.hidden = true; return; }
  const live = roomState.members.filter((m) => memberStatus(m)[0] === 'live').length;
  p.hidden = false;
  p.textContent = `👥 ${live || 1} filming`;
}

$('#rec-start').addEventListener('click', () => {
  if (!recorder || !recorder.stream) return;
  if (!primed) { recorder.prime(); primed = true; } // must happen right in the tap
  startRecording(Date.now());
});

function startRecording(startMs) {
  if (!recorder || !recorder.stream || recorder.recording) return;
  try { pickMime(); } catch (e) { toast(e.message); return; }
  if (!primed) { recorder.prime(); primed = true; }
  const room = recRoom && roomState && roomState.room ? roomState.room : null;
  const name = stamp() + (room ? ` · ${room.name} [${room.code}]` : '');
  let recIdP = null;
  if (room) {
    recIdP = R.addRecording(room.code, { who: myName(), kind: 'live', startMs, status: 'recording', duration: 0 }).catch(() => null);
    R.setMemberState(room.code, 'recording');
  }
  recorder.start(name, {
    startMs, room, who: myName(),
    onFolder: (id) => { if (recIdP) recIdP.then((rid) => rid && R.updateRecording(room.code, rid, { folderId: id })); },
    onMeta: async (metaId, snap, final) => {
      if (!recIdP) return;
      const rid = await recIdP;
      if (rid) await R.updateRecording(room.code, rid, { metaId, duration: snap.duration, status: final ? 'done' : 'recording' });
    },
  });
  busy = true;
  $('#rec-idle').hidden = true; $('#rec-live').hidden = false;
  updateRoomPill();
  if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  const tick = () => {
    if (!recorder || !recorder.recording) return;
    $('#rec-time').textContent = fmtTime(recorder.elapsed);
    setTimeout(tick, 500);
  };
  tick();
}

// Someone tapped "Stop everyone" → stop this phone too.
function checkStopAll() {
  if (!recRoom || !recorder || !recorder.recording || !roomState) return;
  const startedAt = recorder.meta && recorder.meta.startMs;
  const req = roomState.members.some((m) => m.stopAllAt && m.stopAllAt.toMillis && m.stopAllAt.toMillis() > startedAt + 1000);
  if (req) { toast('Recording stopped for everyone'); stopRecording(); }
}

function recStatus(s) {
  $('#rec-cloud').textContent = s.waiting ? `☁ ${s.uploaded} saved · ${s.waiting} sending` : `☁ ${s.uploaded} saved`;
  $('#rec-cloud').classList.toggle('warn', s.waitingMB > 120);
}

$('#rec-mark').addEventListener('click', () => {
  if (!recorder) return;
  recorder.mark();
  const b = $('#rec-mark');
  b.classList.add('pop'); setTimeout(() => b.classList.remove('pop'), 400);
  if (navigator.vibrate) navigator.vibrate(40);
  toast('★ Marked – this moment goes in your highlights', 1600);
});

$('#reauth').addEventListener('click', () => {
  drive.signIn('').then(() => { $('#reauth').hidden = true; }).catch(() => toast('Sign-in did not finish – tap again.'));
});

let justRecorded = null;
$('#rec-stop').addEventListener('click', async () => {
  if (!recorder || !recorder.recording) return;
  if (!drive.valid) drive.signIn('').catch(() => {});
  if (recRoom) {
    const others = present().filter((m) => m.state === 'recording' && m.id !== R.memberKey()).length;
    if (others) {
      const c = await sheet((b, close) => {
        b.append(el('h3', '', 'Stop recording'), el('p', 'muted', `${others} other phone${others === 1 ? ' is' : 's are'} still filming.`));
        const btns = el('div', 'btns');
        const all = el('button', 'btn rec big', '■ Stop everyone'); all.onclick = () => close('all');
        const me = el('button', 'btn big', 'Just me'); me.onclick = () => close('me');
        const no = el('button', 'btn ghost big', 'Keep filming'); no.onclick = () => close(null);
        btns.append(all, me, no); b.append(btns);
      });
      if (!c) return;
      if (c === 'all') R.requestStopAll(recRoom).catch(() => {});
    }
  }
  stopRecording();
});

async function stopRecording() {
  if (!recorder || !recorder.recording) return;
  $('#rec-live').hidden = true; $('#rec-finish').hidden = false;
  const r = recorder;
  const room = recRoom;
  if (room) { amReady = false; R.setReady(room, false).catch(() => {}); }
  const res = await r.stop((n, mb) => { $('#finish-msg').textContent = `Sending the last ${n} piece${n === 1 ? '' : 's'} to Drive (${mb.toFixed(0)} MB)… keep the app open`; });
  busy = false;
  keepAwake(false);
  recorder = null;
  if (room) R.setMemberState(room, 'here');
  if (room && curRoom === room) {
    show('room'); renderRoom();
    toast(`Saved ${fmtTime(res.meta.duration)} to your Drive. When everyone's done, tap "Make highlights".`, 6000);
    return;
  }
  justRecorded = { id: res.folderId, name: r.folderName };
  show('done');
  $('#done-msg').textContent = `${fmtTime(res.meta.duration)} saved to your Google Drive${r.failed ? ` (${r.failed} pieces failed to upload)` : ''}. Nothing was kept on your phone.`;
}
$('#done-make').addEventListener('click', () => { if (justRecorded) makeHighlights({ folder: justRecorded }); });
$('#done-home').addEventListener('click', goHome);

// ---------- upload from gallery ----------
let importCtx = null, importStop = false;
$('#t-upload').addEventListener('click', () => needDrive(() => pickVideos(null)));
function pickVideos(roomCode) {
  const AC = window.AudioContext || window.webkitAudioContext;
  importCtx = { ac: new AC(), room: roomCode };
  if (importCtx.ac.resume) importCtx.ac.resume();
  $('#file-pick').value = '';
  $('#file-pick').click();
}
$('#file-pick').addEventListener('change', () => {
  const files = [...$('#file-pick').files];
  if (files.length && importCtx) importFiles(files, importCtx);
});
$('#imp-stop').addEventListener('click', async () => { if (await confirmSheet('Stop uploading?', 'Videos that are not finished will not be saved.', 'Stop', true)) importStop = true; });
$('#imp-done').addEventListener('click', () => { if (importCtx && importCtx.room && curRoom) { show('room'); renderRoom(); } else goHome(); });

async function importFiles(files, ctx) {
  busy = true; importStop = false;
  keepAwake(true);
  show('import');
  $('#imp-done').hidden = true; $('#imp-stop').hidden = false;
  $('#imp-sub').textContent = 'Keep this screen open – videos go to your Google Drive and get checked for rallies.';
  const rows = files.map((f) => {
    const box = el('div', 'imp');
    const up = el('div', 'bar'); const upIn = el('div'); up.append(upIn);
    const an = el('div', 'bar green'); const anIn = el('div'); an.append(anIn);
    const r1 = el('div', 'row'); r1.append(el('span', '', 'Upload'), up);
    const r2 = el('div', 'row'); r2.append(el('span', '', 'Rallies'), an);
    const st = el('div', 'st muted', 'Waiting…');
    box.append(el('b', '', f.name), r1, r2, st);
    return { box, upIn, anIn, st };
  });
  $('#imp-list').replaceChildren(...rows.map((r) => r.box));
  const room = ctx.room && roomState && roomState.room ? roomState.room : null;
  let ok = 0;
  for (let i = 0; i < files.length && !importStop; i++) {
    const f = files[i], row = rows[i];
    try {
      row.st.textContent = 'Uploading and checking…';
      const when = new Date(f.lastModified || Date.now());
      const folderId = await drive.createFolder(stamp(when) + ' · ' + (room ? `${room.name} [${room.code}]` : 'Upload'), await drive.root());
      drive.makePublic(folderId).catch(() => {});
      const mime = guessMime(f);
      const ext = (f.name.split('.').pop() || 'mp4').toLowerCase().slice(0, 5);
      let recId = null;
      if (room) recId = await R.addRecording(room.code, { who: myName(), kind: 'file', status: 'uploading', startMs: f.lastModified || Date.now(), approx: true, duration: 0, folderId }).catch(() => null);
      const [upRes, anRes] = await Promise.all([
        drive.uploadFile(f, `video.${ext}`, folderId, mime, (p) => { row.upIn.style.width = (p * 100).toFixed(1) + '%'; }, () => importStop),
        analyzeFile(f, ctx.ac, (p) => { row.anIn.style.width = (p * 100).toFixed(1) + '%'; }, () => importStop),
      ]);
      if (importStop) throw new Error('Stopped.');
      if (anRes.thumb) await drive.uploadThumb(anRes.thumb, folderId).catch(() => {});
      const startMs = (f.lastModified || Date.now()) - anRes.duration * 1000;
      const meta = { v: 2, app: 'rally-reel', kind: 'file', name: f.name, who: myName(), fileId: upRes.id, mime, duration: anRes.duration,
        timeline: anRes.timeline, marks: [], startMs, approx: true, room: room ? room.code : null, created: new Date().toISOString() };
      const m = await drive.uploadJson('meta.json', folderId, meta);
      if (room && recId) await R.updateRecording(room.code, recId, { metaId: m.id, duration: anRes.duration, startMs, status: 'done' });
      row.st.textContent = `✓ Saved · ${fmtTime(anRes.duration)}`;
      row.st.classList.remove('muted');
      ok++;
    } catch (e) {
      row.st.textContent = '✕ ' + (e.message || 'failed');
    }
  }
  busy = false;
  keepAwake(false);
  $('#imp-sub').textContent = `${ok} of ${files.length} video${files.length === 1 ? '' : 's'} saved to your Drive. You can delete them from your phone's gallery now if you need space.`;
  $('#imp-done').hidden = false; $('#imp-stop').hidden = true;
}

// ---------- loading recordings for the editor ----------
async function listFolderAny(folderId) {
  const key = window.RR_CONFIG && window.RR_CONFIG.driveApiKey;
  if (!drive.isMock && key) {
    try {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=1000&fields=files(id,name,size)&key=${key}`);
      if (r.ok) return (await r.json()).files;
    } catch { /* fall back */ }
  }
  return drive.listChildren(folderId);
}

function recFromMeta(key, who, meta, files) {
  const rec = { key, who, offset: 0, meta };
  if (meta.kind === 'file' || (files && files.some((f) => /^video\./.test(f.name)))) {
    rec.fileId = meta.fileId || files.find((f) => /^video\./.test(f.name)).id;
    rec.segs = null;
    return rec;
  }
  const segSec = meta.segSec || 10;
  const known = new Map((meta.segments || []).map((s) => [s.i, s]));
  let clipFiles = files ? files.filter((f) => /^clip_\d+\./.test(f.name)).map((f) => ({ i: parseInt(f.name.slice(5), 10), id: f.id }))
    : (meta.segments || []).filter((s) => s.id).map((s) => ({ i: s.i, id: s.id }));
  clipFiles.sort((a, b) => a.i - b.i);
  const segs = clipFiles.map((c) => { const s = known.get(c.i) || { t0: c.i * segSec, t1: (c.i + 1) * segSec }; return { i: c.i, id: c.id, t0: s.t0, t1: s.t1 }; });
  segs.forEach((s, k) => { const n = segs[k + 1]; s.effEnd = n && n.i === s.i + 1 ? Math.max(s.t0 + 0.1, Math.min(s.t1, n.t0)) : s.t1; });
  if (segs.length) meta.duration = Math.max(meta.duration || 0, segs[segs.length - 1].t1);
  rec.segs = segs;
  return rec;
}

async function loadFolderRec(folderId, who) {
  const files = await listFolderAny(folderId);
  const metaFile = files.find((f) => f.name === 'meta.json') ||
    files.filter((f) => /^meta_\d+\.json$/.test(f.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
  const meta = metaFile ? await drive.fetchJson(metaFile.id) : { segSec: 10, segments: [], marks: [] };
  if (!meta.duration && meta.kind !== 'file') meta.duration = 0;
  return recFromMeta('a', who || meta.who || myName(), meta, files);
}

// ---------- make highlights ----------
let editStop = false;
async function makeHighlights(target) {
  // everything that needs "a tap" happens first, before any waiting
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  if (ac.resume) ac.resume();
  const players = makePlayers();
  const authP = drive.valid ? Promise.resolve() : drive.signIn('');
  busy = true; editStop = false;
  keepAwake(true);
  show('edit');
  $('#edit-result').hidden = true; $('#edit-working').hidden = false;
  $('#edit-bar').style.width = '0%';
  const say = (m) => { $('#edit-msg').textContent = m; };
  let reelUrl = null;
  const cache = new Map();
  const roomCode = target.room || null;
  try {
    await authP;
    say('Collecting footage…');
    let recs = [], title = '', outFolder = null, outName = '';
    if (roomCode) {
      const room = roomState && roomState.room;
      title = room ? room.name : 'Volleyball';
      const docs = roomState.recordings.filter((r) => r.metaId);
      if (!docs.length) throw new Error('No finished footage in this room yet.');
      const T0 = Math.min(...docs.map((r) => r.startMs || 0));
      let k = 0;
      for (const d of docs) {
        say(`Collecting footage… (${++k}/${docs.length})`);
        try {
          const meta = await drive.fetchJson(d.metaId);
          let files = null;
          if (meta.kind !== 'file' && (!meta.segments || meta.segments.some((s) => !s.id)) && d.folderId) files = await listFolderAny(d.folderId);
          const rec = recFromMeta('r' + k, d.who || '?', meta, files);
          rec.offset = ((meta.startMs || d.startMs || T0) - T0) / 1000;
          rec.approx = !!(d.approx || meta.approx);
          if (rec.segs ? rec.segs.length : rec.fileId) recs.push(rec);
        } catch { /* skip footage we can't read */ }
      }
      if (!recs.length) throw new Error('Could not open the room\'s footage.');
      if (recs.length > 1) { say('Lining up the cameras…'); await sleep(30); alignRecordings(recs); }
      const minOff = Math.min(...recs.map((r) => r.offset));
      recs.forEach((r) => { r.offset -= minOff; });
      outName = `Highlights ${title} ${stamp()}`;
    } else {
      const folder = target.folder;
      const info = parseFolder(folder.name);
      title = info.label && info.label !== 'Upload' ? info.label : 'Volleyball';
      recs = [await loadFolderRec(folder.id)];
      outFolder = folder.id;
      outName = `Highlights ${folder.name.replace(/\s*\[[A-Z0-9]+\]$/, '')}`;
      if (!(recs[0].segs ? recs[0].segs.length : recs[0].fileId)) throw new Error('No video found in this game.');
    }

    say('Finding the best rallies…');
    const { plan, clips } = buildMultiPlan(recs, settings.length, title);
    if (!clips.length) throw new Error('Could not find any rallies.');
    const recMap = new Map(recs.map((r) => [r.key, r]));

    const getSrc = (key) => {
      if (!cache.has(key)) {
        cache.set(key, (async () => {
          const [rk, part] = key.split(':');
          const rec = recMap.get(rk);
          if (part === 'file') {
            const url = drive.publicUrl(rec.fileId);
            if (!drive.isMock) {
              const probe = await fetch(url, { headers: { Range: 'bytes=0-1' } }).catch(() => null);
              if (!probe || !probe.ok) { const b = await drive.download(rec.fileId); return { url: URL.createObjectURL(b), stream: true, own: true }; }
            }
            return { url, stream: true };
          }
          const seg = rec.segs.find((s) => String(s.i) === part);
          let blob;
          for (let a = 0; ; a++) {
            try { blob = await drive.fetchBlob(seg.id); break; } catch (e) { if (a >= 3) throw e; await sleep(1500); }
          }
          const url = URL.createObjectURL(blob);
          let audio = null;
          try { audio = await ac.decodeAudioData(await blob.arrayBuffer()); } catch { /* no sound */ }
          return { url, audio, own: true };
        })());
      }
      return cache.get(key);
    };
    const releaseSrc = (key) => {
      const p = cache.get(key);
      cache.delete(key);
      if (p) p.then((s) => { if (s.own) URL.revokeObjectURL(s.url); }).catch(() => {});
    };

    const mime = pickMime();
    const base = mime.split(';')[0];
    const ext = base.includes('mp4') ? 'mp4' : 'webm';
    if (!outFolder) {
      outFolder = await drive.createFolder(`${stamp()} · ${title} highlights [${roomCode}]`, await drive.root());
      drive.makePublic(outFolder).catch(() => {});
    }
    const uri = await drive.createSession(`${outName}.${ext}`, outFolder, base);
    const writer = new ResumableWriter(drive, uri);
    const mem = [];
    const sink = { push: (b) => { mem.push(b); writer.push(b); } };

    const angles = new Set(plan.filter((s) => s.pieces).flatMap((s) => s.pieces.map((p) => p.src.split(':')[0]))).size;
    say(`Editing ${clips.length} highlight${clips.length === 1 ? '' : 's'}${angles > 1 ? ` from ${angles} cameras` : ''}… keep this screen open`);
    await renderReel({
      plan, canvas: $('#edit-canvas'), ac, players, getSrc, releaseSrc, sink, mime,
      dateLabel: new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
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
    const link = file && drive.viewLink(file);
    const msg = (dur) => `${clips.length} rallies${angles > 1 ? ` · ${angles} camera angles` : ''} · ${fmtTime(dur)} · saved to your Drive`;
    $('#result-msg').textContent = msg(0);
    v.onloadedmetadata = () => { if (isFinite(v.duration)) $('#result-msg').textContent = msg(v.duration); };
    $('#open-drive').hidden = !link;
    if (link) $('#open-drive').href = link;
    if (roomCode && file && file.id) {
      await R.addReel(roomCode, { who: myName(), fileId: file.id, link, clips: clips.length, angles, seconds: Math.round(blob.size ? (v.duration || 0) : 0) || 0 }).catch(() => {});
    }
    $('#share').onclick = async () => {
      const f = new File([blob], `Volleyball highlights.${ext}`, { type: base });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f], title: 'Volleyball highlights' }); } catch { /* cancelled */ }
      } else if (link) window.open(link, '_blank');
      else toast('Sharing is not supported in this browser.');
    };
  } catch (e) {
    toast(e.auth ? 'Please connect Google Drive first.' : e.message || String(e), 6000);
    if (roomCode && curRoom) { show('room'); renderRoom(); } else goHome();
  } finally {
    busy = false;
    keepAwake(false);
    cache.forEach((p) => p.then((s) => { if (s.own) URL.revokeObjectURL(s.url); }).catch(() => {}));
    setTimeout(() => { try { ac.close(); } catch { /* ignore */ } }, 500);
    $('#edit-done').onclick = () => {
      const v = $('#edit-video'); v.pause(); v.removeAttribute('src'); v.load();
      if (reelUrl) URL.revokeObjectURL(reelUrl);
      if (roomCode && curRoom) { show('room'); renderRoom(); } else goHome();
    };
  }
}
$('#edit-cancel').addEventListener('click', async () => { if (await confirmSheet('Stop editing?', 'Nothing will be saved.', 'Stop', true)) editStop = true; });

boot();
