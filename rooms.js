// Game rooms: several phones film the same game. A tiny free database (Firebase
// Firestore) keeps the room's member list, who is recording, and where each
// person's clips are in their own Google Drive. Videos never go through Firebase.

const FB = 'https://www.gstatic.com/firebasejs/11.0.1/';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

let fs, db, auth, uid, offset = 0, ready = null;

export function deviceId() {
  const p = new URLSearchParams(location.search).get('device');
  if (p) return p.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  let d = localStorage.getItem('rr_device');
  if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem('rr_device', d); }
  return d;
}

export function initRooms() {
  if (ready) return ready;
  ready = (async () => {
    const cfg = window.RR_CONFIG && window.RR_CONFIG.firebase;
    if (!cfg) throw new Error('Rooms are not set up.');
    const [{ initializeApp }, A, F] = await Promise.all([
      import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js'),
    ]);
    fs = F;
    const app = initializeApp(cfg);
    auth = A.getAuth(app);
    db = F.getFirestore(app);
    const user = auth.currentUser || (await new Promise((res) => {
      const off = A.onAuthStateChanged(auth, (u) => { off(); res(u); });
    })) || (await A.signInAnonymously(auth)).user;
    uid = user.uid;
    await syncClock();
    return true;
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// Server-corrected time so every phone in a room agrees on "now".
async function syncClock() {
  try {
    const ref = fs.doc(db, 'clock', uid);
    const t0 = Date.now();
    await fs.setDoc(ref, { t: fs.serverTimestamp() });
    const t1 = Date.now();
    const snap = await fs.getDoc(ref);
    const server = snap.data().t.toMillis();
    offset = server - (t0 + t1) / 2;
  } catch { offset = 0; }
}

export const now = () => Date.now() + offset;
export const myUid = () => uid;
export const memberKey = () => `${uid}_${deviceId()}`;

function newCode() {
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(6));
  for (const x of r) s += CODE_CHARS[x % CODE_CHARS.length];
  return s;
}

export function cleanCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export async function createRoom(name, who) {
  await initRooms();
  for (let a = 0; a < 5; a++) {
    const code = newCode();
    const ref = fs.doc(db, 'rooms', code);
    const ex = await fs.getDoc(ref).catch(() => null);
    if (ex && ex.exists()) continue;
    await fs.setDoc(ref, { name: name || 'Game', hostUid: uid, hostName: who, created: fs.serverTimestamp() });
    await joinRoom(code, who);
    return code;
  }
  throw new Error('Could not make a room code, try again.');
}

export async function getRoom(code) {
  await initRooms();
  const snap = await fs.getDoc(fs.doc(db, 'rooms', code));
  return snap.exists() ? { code, ...snap.data() } : null;
}

export async function joinRoom(code, who) {
  await initRooms();
  const room = await getRoom(code);
  if (!room) throw new Error(`No room with code ${code}.`);
  await fs.setDoc(fs.doc(db, 'rooms', code, 'members', memberKey()),
    { uid, who, device: deviceId(), joined: fs.serverTimestamp(), seen: fs.serverTimestamp(), state: 'here' }, { merge: true });
  return room;
}

export async function setMemberState(code, state, extra = {}) {
  if (!code || !db) return;
  try {
    await fs.setDoc(fs.doc(db, 'rooms', code, 'members', memberKey()),
      { uid, state, seen: fs.serverTimestamp(), ...extra }, { merge: true });
  } catch { /* offline – fine */ }
}

// "I'm ready" – when everyone present is ready, all phones start together.
export async function setReady(code, on) {
  if (!code || !db) return;
  await fs.setDoc(fs.doc(db, 'rooms', code, 'members', memberKey()),
    { uid, ready: !!on, readyAt: on ? fs.serverTimestamp() : null, state: 'here', seen: fs.serverTimestamp() }, { merge: true });
}

// Team lineups (names + positions) shared with the whole room.
export async function setLineup(code, lineup) {
  if (!code || !db) return;
  await fs.setDoc(fs.doc(db, 'rooms', code, 'members', memberKey()), { uid, lineup, lineupAt: fs.serverTimestamp() }, { merge: true });
}

// Ask every phone in the room to stop recording.
export async function requestStopAll(code) {
  if (!code || !db) return;
  await fs.setDoc(fs.doc(db, 'rooms', code, 'members', memberKey()), { uid, stopAllAt: fs.serverTimestamp() }, { merge: true });
}

// Live updates of members / recordings / reels. Returns an unsubscribe function.
export function watchRoom(code, cb) {
  const offs = [];
  const state = { members: [], recordings: [], reels: [], room: null };
  const emit = () => cb({ ...state });
  // 'estimate': a time this phone just wrote shows up right away (not as "unknown")
  const EST = { serverTimestamps: 'estimate' };
  offs.push(fs.onSnapshot(fs.doc(db, 'rooms', code), (s) => { state.room = s.exists() ? { code, ...s.data(EST) } : null; emit(); }));
  for (const col of ['members', 'recordings', 'reels']) {
    offs.push(fs.onSnapshot(fs.collection(db, 'rooms', code, col), (qs) => {
      state[col] = qs.docs.map((d) => ({ id: d.id, ...d.data(EST) }));
      emit();
    }, () => {}));
  }
  return () => offs.forEach((f) => f());
}

export async function addRecording(code, data) {
  const ref = fs.doc(fs.collection(db, 'rooms', code, 'recordings'));
  await fs.setDoc(ref, { uid, device: deviceId(), created: fs.serverTimestamp(), updatedAt: fs.serverTimestamp(), ...data });
  return ref.id;
}

export async function updateRecording(code, id, data) {
  try { await fs.updateDoc(fs.doc(db, 'rooms', code, 'recordings', id), { ...data, updatedAt: fs.serverTimestamp() }); } catch { /* retry next time */ }
}

export async function addReel(code, data) {
  const ref = fs.doc(fs.collection(db, 'rooms', code, 'reels'));
  await fs.setDoc(ref, { uid, created: fs.serverTimestamp(), ...data });
  return ref.id;
}

export async function removeRecording(code, id) {
  await fs.deleteDoc(fs.doc(db, 'rooms', code, 'recordings', id));
}
