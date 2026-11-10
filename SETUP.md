# Rally Reel – Volleyball Highlights

Record games on your phone. The video goes straight to **your Google Drive** in 10‑second pieces, so it doesn't fill up your phone.
Then tap **✨ Make Highlights** and the app edits the best rallies into one video (intro, clip labels, slow‑mo "play of the match" replay, outro), which is saved to Drive as well.

**How it finds highlights:** while you film, it listens for ball hits, the referee's whistle and cheering, and watches how much the players move. A point usually goes: rally → whistle/cheer, so it finds those moments, goes back to where the rally started, and keeps the longest and loudest rallies.
Tap **★ Great play** while filming to make sure a moment gets in.

Try it without setting anything up: open the app with `?demo` at the end of the address (fake camera, nothing saved).

---

## One‑time setup (about 10 minutes, free)

The app is a website you add to your home screen, so it needs:
1. a web address (free hosting), and
2. permission to save into your Google Drive (a free Google "Client ID").

### 1. Put the app online (free)
Easiest: **Netlify Drop**
1. Go to https://app.netlify.com/drop and sign up (free).
2. Drag this whole folder (`06 Volleyball Highlights App`) onto the page.
3. You get an address like `https://something-random.netlify.app`. Copy it.

(GitHub Pages or Cloudflare Pages also work. It has to be **https**.)

### 2. Get a Google Client ID
1. Go to https://console.cloud.google.com/ and create a project (any name, e.g. "Rally Reel").
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - User type **External**, app name "Rally Reel", your email for support and contact.
   - Under **Audience / Test users** add **your own Gmail address**.
   - You do not need to publish it. "Testing" is fine for you.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorized JavaScript origins:** your address from step 1, e.g. `https://something-random.netlify.app` (no slash at the end)
   - Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).

### 3. On your phone
1. Open your address from step 1 in **Safari (iPhone)** or **Chrome (Android)**.
2. Paste the Client ID, then tap **Save**.
3. Add it to your home screen:
   - iPhone: Share button → **Add to Home Screen**
   - Android: ⋮ menu → **Add to Home screen / Install app**
4. Open it from the home screen, tap **Connect Google Drive**, and pick your account. Google will warn "app isn't verified". That's your own app, so tap **Continue**.

Done. Your videos show up in Google Drive in a folder called **Volleyball Highlights**.

---

## Tips
- Use a tripod or lean the phone on something, sideways, with the whole court in view.
- **Keep the app open with the screen on while recording** (it keeps the screen awake itself). If you leave the app, the phone stops the camera.
- You need internet at the gym (Wi‑Fi or data). If the connection drops, pieces wait in memory and upload when it's back. The top bar shows "N sending".
- Data use: 720p ≈ 1.6 GB per hour (1080p ≈ 2.7 GB). Free Drive is 15 GB. After making highlights, use **⋯ → Free up space** to throw away the raw clips and keep the highlight video.
- Making highlights plays the reel in real time: a 2‑minute reel takes about 2 minutes. Keep the screen on.
- Highlight length (1 / 2 / 4 min) and quality are in **Settings** on the home screen.
- Google sign‑in lasts 1 hour, but the app reserves upload slots in advance, so recordings up to about 2 hours keep saving without you touching the phone. If it ever needs you, a yellow banner appears.

## Files
| File | What it does |
|---|---|
| `index.html`, `styles.css`, `app.js` | screens and buttons |
| `recorder.js` | camera, 10‑second pieces, uploading |
| `analyzer.js` | listens and watches during recording (hits, whistle, cheering, movement) |
| `highlights.js` | picks the best rallies |
| `renderer.js` | edits the highlight video |
| `drive.js` | Google Drive saving |
| `demo.js` | fake match for `?demo` |
| `config.js` | optional: put your Client ID here instead of pasting it on the phone |
