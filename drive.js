// Google Drive storage ("the cloud") + an in-memory mock used by demo mode.
// Only the drive.file scope is used: the app can see ONLY the files it created.

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'Volleyball Highlights';
const API = 'https://www.googleapis.com/drive/v3';
const UP = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_FIELDS = 'id,name,mimeType,size,createdTime,webViewLink';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AuthError extends Error {
  constructor() { super('Google sign-in needed'); this.auth = true; }
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

export class GoogleDrive {
  constructor(clientId) {
    this.clientId = clientId;
    this.token = null;
    this.expires = 0;
    this.waiters = [];
    this.isMock = false;
  }

  async init() {
    await loadScript('https://accounts.google.com/gsi/client');
    this.tc = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (r) => this._onToken(r),
      error_callback: (e) => this._onToken({ error: (e && e.type) || 'popup_failed' }),
    });
    try {
      const s = JSON.parse(sessionStorage.getItem('rr_tok') || 'null');
      if (s && s.expires > Date.now() + 120000) { this.token = s.token; this.expires = s.expires; }
    } catch { /* ignore */ }
  }

  get valid() { return !!this.token && Date.now() < this.expires - 90000; }

  // MUST be called straight from a tap (opens Google's popup).
  signIn(prompt = '') {
    return new Promise((res, rej) => {
      this.waiters.push({ res, rej });
      this.tc.requestAccessToken({ prompt });
    });
  }

  _onToken(r) {
    const w = this.waiters.splice(0);
    if (!r || r.error) { w.forEach((x) => x.rej(new Error((r && r.error) || 'sign-in failed'))); return; }
    this.token = r.access_token;
    this.expires = Date.now() + (Number(r.expires_in) || 3599) * 1000;
    try { sessionStorage.setItem('rr_tok', JSON.stringify({ token: this.token, expires: this.expires })); } catch { /* ignore */ }
    w.forEach((x) => x.res());
  }

  async _fetch(url, opts = {}) {
    if (!this.valid) throw new AuthError();
    const headers = new Headers(opts.headers || {});
    headers.set('Authorization', 'Bearer ' + this.token);
    const r = await fetch(url, { ...opts, headers });
    if (r.status === 401) { this.token = null; throw new AuthError(); }
    return r;
  }

  async _json(url, opts) {
    const r = await this._fetch(url, opts);
    if (!r.ok) throw new Error(`Drive error ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  async root() {
    if (this._root) return this._root;
    const q = `mimeType='${FOLDER_MIME}' and name='${ROOT_NAME}' and trashed=false`;
    const res = await this._json(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
    this._root = res.files.length ? res.files[0].id : await this.createFolder(ROOT_NAME, null);
    return this._root;
  }

  async createFolder(name, parent) {
    const f = await this._json(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parent ? [parent] : undefined }),
    });
    return f.id;
  }

  // Reserve an upload URL. The URL itself is the permission to upload (valid ~1 week),
  // so uploads keep working even after the 1-hour Google sign-in runs out.
  async createSession(name, parent, mimeType) {
    const r = await this._fetch(`${UP}?uploadType=resumable&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType },
      body: JSON.stringify({ name, parents: [parent], mimeType }),
    });
    if (!r.ok) throw new Error(`Drive error ${r.status}`);
    const loc = r.headers.get('Location');
    if (!loc) throw new Error('Drive gave no upload URL');
    return loc;
  }

  _upHeaders() { return this.valid ? { Authorization: 'Bearer ' + this.token } : {}; }

  async putBlob(uri, blob) {
    const r = await fetch(uri, { method: 'PUT', headers: this._upHeaders(), body: blob });
    if (!r.ok) { const e = new Error(`Upload failed ${r.status}`); e.status = r.status; throw e; }
    return r.json();
  }

  // total: number for the last chunk, '*' while still streaming.
  async putChunk(uri, blob, start, total) {
    const headers = this._upHeaders();
    headers['Content-Range'] = blob.size ? `bytes ${start}-${start + blob.size - 1}/${total}` : `bytes */${total}`;
    const r = await fetch(uri, { method: 'PUT', headers, body: blob });
    if (r.status === 308) return null;
    if (r.ok) return r.json();
    const e = new Error(`Upload failed ${r.status}`); e.status = r.status; throw e;
  }

  async listChildren(folderId) {
    const q = `'${folderId}' in parents and trashed=false`;
    let out = [], token = '';
    do {
      const res = await this._json(`${API}/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(${FILE_FIELDS})${token ? '&pageToken=' + token : ''}`);
      out = out.concat(res.files);
      token = res.nextPageToken || '';
    } while (token);
    return out;
  }

  async download(id) {
    const r = await this._fetch(`${API}/files/${id}?alt=media`);
    if (!r.ok) throw new Error(`Download failed ${r.status}`);
    return r.blob();
  }

  async downloadJson(id) { return JSON.parse(await (await this.download(id)).text()); }

  async uploadJson(name, parent, obj) {
    const b = 'rr' + Math.random().toString(36).slice(2);
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent], mimeType: 'application/json' })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${b}--`;
    return this._json(`${UP}?uploadType=multipart&fields=id`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body,
    });
  }

  async trash(id) {
    await this._json(`${API}/files/${id}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    });
  }

  viewLink(file) { return file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`; }
}

// Streams a growing video (the edited reel) into one Drive file, 8 MB at a time.
export class ResumableWriter {
  constructor(drive, uri) {
    this.d = drive; this.uri = uri; this.buf = []; this.bufSize = 0; this.sent = 0;
    this.chain = Promise.resolve(); this.CH = 8 * 1024 * 1024; this.Q = 256 * 1024;
  }
  push(blob) {
    this.buf.push(blob); this.bufSize += blob.size;
    if (this.bufSize >= this.CH) this._flush(false);
  }
  _flush(final) {
    const all = new Blob(this.buf);
    const len = final ? all.size : Math.floor(all.size / this.Q) * this.Q;
    const part = all.slice(0, len), rest = all.slice(len);
    this.buf = rest.size ? [rest] : []; this.bufSize = rest.size;
    const start = this.sent; this.sent += len;
    const total = final ? this.sent : '*';
    this.chain = this.chain.then(async () => {
      for (let a = 0; ; a++) {
        try { return await this.d.putChunk(this.uri, part, start, total); } catch (e) {
          if (a >= 5) throw e;
          await sleep(1500 * (a + 1));
        }
      }
    });
    return this.chain;
  }
  finish() { return this._flush(true); }
}

// ---------- Demo mode: fake Drive kept in memory ----------
export class MockDrive {
  constructor() { this.files = new Map(); this.sessions = new Map(); this.n = 0; this.isMock = true; }
  async init() {}
  get valid() { return true; }
  signIn() { return Promise.resolve(); }
  _id() { return 'm' + ++this.n; }
  async root() { if (!this._root) this._root = await this.createFolder(ROOT_NAME, null); return this._root; }
  async createFolder(name, parent) {
    const id = this._id();
    this.files.set(id, { id, name, mimeType: FOLDER_MIME, parents: parent ? [parent] : [], createdTime: new Date().toISOString() });
    return id;
  }
  async createSession(name, parent, mime) {
    await sleep(5);
    const uri = 'mock://' + this._id();
    this.sessions.set(uri, { name, parent, mime, parts: [] });
    return uri;
  }
  async putBlob(uri, blob) {
    await sleep(40);
    const s = this.sessions.get(uri); if (!s) throw new Error('no session');
    this.sessions.delete(uri);
    return this._mk(s.name, s.parent, s.mime, blob);
  }
  async putChunk(uri, blob, start, total) {
    const s = this.sessions.get(uri); if (!s) throw new Error('no session');
    s.parts.push(blob);
    if (total === '*') return null;
    this.sessions.delete(uri);
    return this._mk(s.name, s.parent, s.mime, new Blob(s.parts, { type: s.mime }));
  }
  _mk(name, parent, mimeType, blob) {
    const id = this._id();
    this.files.set(id, { id, name, mimeType, parents: [parent], size: String(blob.size), createdTime: new Date().toISOString(), blob });
    return { id, name };
  }
  async listChildren(pid) {
    return [...this.files.values()].filter((f) => f.parents.includes(pid) && !f.trashed).map(({ blob, ...f }) => f);
  }
  async download(id) { return this.files.get(id).blob; }
  async downloadJson(id) { return JSON.parse(await this.files.get(id).blob.text()); }
  async uploadJson(name, parent, obj) { return this._mk(name, parent, 'application/json', new Blob([JSON.stringify(obj)])); }
  async trash(id) { const f = this.files.get(id); if (f) f.trashed = true; }
  viewLink() { return null; }
}
