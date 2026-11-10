// Picks the best rallies from the recording timeline.
// A volleyball point usually looks like: lots of movement + ball contacts (the rally),
// then a whistle and/or a burst of cheering when the point ends. We find those
// "point ended" moments, walk back to where the rally started, score each rally
// (louder reaction + longer rally + more touches = better) and keep the best ones.

function percentile(a, p) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

function smooth(a, w) {
  w = Math.max(1, Math.round(w));
  const pre = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
  const h = w >> 1, out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - h), hi = Math.min(a.length, i + h + 1);
    out[i] = (pre[hi] - pre[lo]) / (hi - lo);
  }
  return out;
}

function robustZ(a) {
  const med = percentile(a, 0.5);
  const mad = percentile(Array.from(a, (v) => Math.abs(v - med)), 0.5) * 1.4826 + 1e-6;
  return Array.from(a, (v) => (v - med) / mad);
}

// slow-moving "normal loudness" so a loud gym or a quiet park both work
function rollingBase(a, win, step) {
  const n = a.length, centers = [], vals = [];
  for (let c = 0; c < n; c += step) {
    const lo = Math.max(0, c - (win >> 1)), hi = Math.min(n, c + (win >> 1));
    centers.push(c); vals.push(percentile(a.slice(lo, hi), 0.4));
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.min(centers.length - 1, Math.floor(i / step));
    const k2 = Math.min(centers.length - 1, k + 1);
    const u = k2 === k ? 0 : (i - centers[k]) / (centers[k2] - centers[k]);
    out[i] = vals[k] + (vals[k2] - vals[k]) * u;
  }
  return out;
}

export function detectHighlights(meta, targetSec = 120) {
  const dur = meta.duration || 0;
  const tl = meta.timeline;
  const marks = meta.marks || [];
  const clamp = (c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(dur, c.end) });
  let cands = [];

  if (tl && tl.loud && tl.loud.length > 8) {
    const dt = tl.dt, n = tl.loud.length, sec = 1 / dt;
    const loud = tl.loud.map((v) => Math.max(-90, v));
    const base = rollingBase(loud, Math.round(40 * sec), Math.round(5 * sec));
    const loudEx = smooth(loud.map((v, i) => v - base[i]), 1 * sec);
    const whistle = smooth(tl.whistle, 0.75 * sec);
    const excite = Array.from(loudEx, (v, i) => Math.max(0, v) / 6 + whistle[i] * 1.6);
    const zm = robustZ(smooth(tl.motion, 1.5 * sec));
    const zh = robustZ(smooth(tl.hits, 2 * sec));
    const activity = smooth(zm.map((v, i) => v + zh[i]), 1.5 * sec);
    const actThr = percentile(activity, 0.45);
    const thr = Math.max(0.9, percentile(excite, 0.9));

    // local peaks of excitement = "point just ended"
    const events = [];
    const R = Math.round(4 * sec);
    for (let i = 0; i < n; i++) {
      if (excite[i] < thr) continue;
      let isMax = true;
      for (let j = Math.max(0, i - R); j < Math.min(n, i + R + 1); j++) if (excite[j] > excite[i]) { isMax = false; break; }
      if (isMax && (!events.length || i * dt - events[events.length - 1].t > 6)) events.push({ t: i * dt, peak: excite[i] });
    }
    for (const m of marks) events.push({ t: m, peak: 5, marked: true });

    for (const ev of events) {
      // walk back through the rally while there's action
      let j = Math.max(0, Math.round((ev.t - 2) * sec));
      while (j > 0) {
        const back = ev.t - j * dt;
        if (back >= 15) break;
        if (back >= 6 && activity[j] < actThr) break;
        j--;
      }
      const start = j * dt - 1;
      const end = ev.t + (ev.marked ? 2 : 2.5);
      let hits = 0;
      for (let k = Math.max(0, Math.round(start * sec)); k < Math.min(n, Math.round(ev.t * sec)); k++) hits += tl.hits[k];
      const rally = ev.t - start;
      cands.push({ start, end, ev: ev.t, marked: !!ev.marked, score: ev.peak + 0.06 * rally + 0.12 * hits + (ev.marked ? 100 : 0) });
    }

    // quiet practice / no crowd? fall back to the busiest moments
    if (cands.filter((c) => !c.marked).length < 3) {
      const W = Math.round(12 * sec);
      const used = new Uint8Array(n);
      for (let tries = 0; tries < 12; tries++) {
        let best = -1, bestV = -1e9;
        for (let i = 0; i + W <= n; i += Math.round(sec)) {
          if (used[i] || used[i + W - 1]) continue;
          let s = 0; for (let k = i; k < i + W; k++) s += activity[k];
          if (s > bestV) { bestV = s; best = i; }
        }
        if (best < 0) break;
        for (let k = best; k < best + W; k++) used[k] = 1;
        cands.push({ start: best * dt, end: (best + W) * dt, ev: (best + W) * dt - 2, marked: false, score: bestV / W });
      }
    }
  } else {
    // no analysis saved: use the ⭐ marks, else spread clips evenly
    for (const m of marks) cands.push({ start: m - 12, end: m + 2, ev: m, marked: true, score: 100 });
    if (!cands.length && dur > 5) {
      const k = Math.max(1, Math.min(8, Math.floor(dur / 60)));
      for (let i = 0; i < k; i++) {
        const mid = (dur * (i + 0.5)) / k;
        cands.push({ start: mid - 6, end: mid + 6, ev: mid, marked: false, score: 1 });
      }
    }
  }

  cands = cands.map(clamp).filter((c) => c.end - c.start >= 3);
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  let total = 0;
  const budget = Math.max(20, targetSec - 14); // leave room for the intro, replay and outro
  for (const c of cands) {
    if (total >= budget) break;
    if (picked.some((p) => c.start < p.end + 0.5 && c.end > p.start - 0.5)) continue;
    picked.push(c);
    total += c.end - c.start;
  }
  picked.sort((a, b) => a.start - b.start);
  let best = -1, bestScore = -1e9;
  picked.forEach((c, i) => { if (c.score > bestScore) { bestScore = c.score; best = i; } });
  return { clips: picked, best };
}

// Turn clips into "pieces" of the 10-second files they live in.
export function piecesFor(start, end, segs, rate = 1) {
  const out = [];
  for (const s of segs) {
    if (s.effEnd <= start || s.t0 >= end) continue;
    const from = Math.max(start, s.t0) - s.t0;
    const to = Math.min(end, s.effEnd) - s.t0;
    if (to - from > 0.05) out.push({ seg: s.i, from, to, rate });
  }
  return out;
}

export function buildPlan(clips, best, segs) {
  const plan = [{ type: 'title', dur: 2.6 }];
  clips.forEach((c, k) => plan.push({ type: 'clip', n: k + 1, total: clips.length, marked: c.marked, pieces: piecesFor(c.start, c.end, segs, 1) }));
  if (clips.length >= 2 && best >= 0) {
    const b = clips[best];
    const rs = Math.max(b.start, b.ev - 4.5), re = Math.max(rs + 1.5, b.ev - 0.3);
    plan.push({ type: 'replay', pieces: piecesFor(rs, re, segs, 0.5) });
  }
  plan.push({ type: 'outro', dur: 2.2 });
  return plan.filter((s) => !s.pieces || s.pieces.length);
}

export function planSeconds(plan) {
  let t = 0;
  for (const s of plan) {
    if (s.dur) t += s.dur;
    if (s.pieces) { for (const p of s.pieces) t += (p.to - p.from) / p.rate; t += 0.35; }
  }
  return t;
}
