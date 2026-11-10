# Rally Reel – Volleyball Highlights

**Live app:** https://ovyro.github.io/rally-reel/ – open it on a phone, then use "Add to Home Screen" (iPhone: Share button; Android: ⋮ menu).

## What it does
- **Record**: films in 10-second pieces that go straight to *your own* Google Drive (folder "Volleyball Highlights"), so your phone doesn't fill up.
- **Upload from gallery**: pick videos you already have. They upload to Drive and get checked for rallies while uploading.
- **✨ Highlights**: one tap finds the best rallies (from ball hits, the whistle, cheering and movement) and edits them. You get an intro, clip labels, fades, a slow-mo "play of the match" and an outro. The result is saved to Drive.
- **Rooms**: one person creates a room (6-letter code, invite link, QR code) and friends join.
  - Everyone opens their camera and taps **I'm ready**. When everyone present is ready, all phones count down 3‑2‑1 and start at the same moment.
  - **Stop** can stop everyone at once.
  - **Make highlights** puts every phone's video on one timeline (shared server clock, fine-tuned by matching the sound) and shows each rally from the angle with the most action. Good rallies get a slow-mo replay from another phone, and the best play is replayed from every angle.
- **★ Great play** button while filming: that moment always makes the highlights.

## How it's built (no server of our own)
| Part | Where |
|---|---|
| App (static files) | GitHub Pages – repo `Ovyro/rally-reel` – deploy = `git push` |
| Videos | each user's own Google Drive (`drive.file` scope: the app only sees files it created) |
| Rooms (members, who's filming, file IDs) | Firebase Firestore, project `rally-reel`, free Spark plan, anonymous sign-in |
| Playing room-mates' clips | Drive API key restricted to Drive + this website; game folders are "anyone with the link can view" |
| Google sign-in | OAuth client in Google Cloud project `rally-reel` |

Settings live in `config.js`. Database rules: see `firestore.rules`. Privacy page: `privacy.html`.

## Releasing a change
```bash
./bump-version.sh      # gives every file a new ?v= number so phones never mix old and new code
git commit -am "…" && git push
```

## Testing without a phone
- `?demo` – fake camera + fake Drive, nothing saved (rooms are off in demo).
- `?fakecam&device=a` and `?fakecam&device=b&as=Sara` in two tabs – fake cameras that film the *same* fake match from two angles, with the real Drive and real rooms. Good for testing rooms and multi-angle edits.

## Files
| File | What it does |
|---|---|
| `index.html`, `styles.css`, `app.js` | screens, buttons, flows |
| `recorder.js` | camera, 10-second pieces, uploading |
| `analyzer.js` | listens/watches while filming (hits, whistle, cheering, movement) |
| `importer.js` | gallery upload + fast scan |
| `highlights.js` | picks rallies, lines phones up, chooses angles |
| `renderer.js` | edits the highlight video |
| `rooms.js` | rooms, ready/start-together, stop-everyone |
| `drive.js` | Google Drive |
| `demo.js` | fake camera |

## Tips
- Use a tripod or lean the phone on something, sideways, with the whole court in view. Keep the app open with the screen on.
- You need internet at the gym. If it drops, pieces wait in memory and upload when it's back.
- 720p ≈ 1.6 GB of Drive per hour (free Drive = 15 GB). Use "⋯ → Free up space" on a game after making highlights.
- Making highlights plays the reel in real time: a 2-minute reel takes about 2 minutes.
