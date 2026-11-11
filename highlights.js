// Picks the best rallies – from one phone or from every phone in a room.
// A volleyball point usually looks like: lots of movement + ball contacts (the rally),
// then a whistle and/or a burst of cheering when the point ends. We find those
// "point ended" moments, walk back to where the rally started, score each rally
// (louder reaction + longer rally + more touches = better) and keep the best ones.
// With several phones, the moments are matched up on one shared timeline, each rally
// is shown from the angle with the most action, then replayed from a second angle.

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

function loudEnvelope(tl) {
  const sec = 1 / tl.dt;
  const loud = tl.loud.map((v) => Math.max(-90, v));
  const base = rollingBase(loud, Math.round(40 * sec), Math.round(5 * sec));
  return smooth(loud.map((v, i) => v - base[i]), 1 * sec);
}

// Every possible highlight in one recording (times in that recording's own seconds).
export function candidates(meta) {
  const dur = meta.duration || 0;
  const tl = meta.timeline;
  const marks = meta.marks || [];
  let cands = [];

  if (tl && tl.loud && tl.loud.length > 8) {
    const dt = tl.dt, n = tl.loud.length, sec = 1 / dt;
    const loudEx = loudEnvelope(tl);
    const whistle = smooth(tl.whistle, 0.75 * sec);
    const excite = Array.from(loudEx, (v, i) => Math.max(0, v) / 6 + whistle[i] * 1.6);
    const zm = robustZ(smooth(tl.motion, 1.5 * sec));
    const zh = robustZ(smooth(tl.hits, 2 * sec));
    const activity = smooth(zm.map((v, i) => v + zh[i]), 1.5 * sec);
    const actThr = percentile(activity, 0.45);
    const thr = Math.max(0.9, percentile(excite, 0.9));

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
        cands.push({ start: best * dt, end: (best + W) * dt, ev: (best + W) * dt - 2, marked: false, score: bestV / W, weak: true });
      }
    }
  } else {
    for (const m of marks) cands.push({ start: m - 12, end: m + 2, ev: m, marked: true, score: 100 });
    if (!cands.length && dur > 5) {
      const k = Math.max(1, Math.min(8, Math.floor(dur / 60)));
      for (let i = 0; i < k; i++) {
        const mid = (dur * (i + 0.5)) / k;
        cands.push({ start: mid - 6, end: mid + 6, ev: mid, marked: false, score: 1, weak: true });
      }
    }
  }
  return cands
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(dur || c.end, c.end) }))
    .filter((c) => c.end - c.start >= 3);
}

// Kept for single-recording use (and the demo checks).
export function detectHighlights(meta, targetSec = 120) {
  const cands = candidates(meta).sort((a, b) => b.score - a.score);
  const picked = [];
  let total = 0;
  const budget = Math.max(20, targetSec - 14);
  for (const c of cands) {
    if (total >= budget) break;
    if (picked.some((p) => c.start < p.end + 0.5 && c.end > p.start - 0.5)) continue;
    picked.push(c); total += c.end - c.start;
  }
  picked.sort((a, b) => a.start - b.start);
  let best = -1, bs = -1e9;
  picked.forEach((c, i) => { if (c.score > bs) { bs = c.score; best = i; } });
  return { clips: picked, best };
}

// ---------- lining phones up in time ----------
// Every phone hears the same whistles and cheers, so the loudness curves match.
// We slide one curve against the other to find the exact time difference.
function zArr(a) {
  let m = 0; for (const v of a) m += v; m /= a.length || 1;
  let s = 0; for (const v of a) s += (v - m) ** 2; s = Math.sqrt(s / (a.length || 1)) || 1;
  return Float32Array.from(a, (v) => (v - m) / s);
}
function down(a, k) { const out = new Float32Array(Math.floor(a.length / k)); for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += a[i * k + j]; out[i] = s / k; } return out; }
function corrAt(A, B, lag, minN) {
  // B[j] lines up with A[j + lag]
  let s = 0, n = 0;
  const j0 = Math.max(0, -lag), j1 = Math.min(B.length, A.length - lag);
  for (let j = j0; j < j1; j++) { s += A[j + lag] * B[j]; n++; }
  return n >= minN ? s / n : -1;
}

// recs: [{offset (s, from shared clock), approx (bool), meta}] → adjusts rec.offset in place
export function alignRecordings(recs) {
  const usable = recs.filter((r) => r.meta.timeline && r.meta.timeline.loud && r.meta.timeline.loud.length > 240);
  if (usable.length < 2) return;
  const anchor = [...usable].sort((a, b) => (!!a.approx - !!b.approx) || (b.meta.duration - a.meta.duration))[0];
  const dt = anchor.meta.timeline.dt;
  const A = zArr(loudEnvelope(anchor.meta.timeline));
  const A1 = zArr(down(A, 4));
  for (const r of usable) {
    if (r === anchor) continue;
    const B = zArr(loudEnvelope(r.meta.timeline));
    const B1 = zArr(down(B, 4));
    const L0 = Math.round((r.offset - anchor.offset) / dt); // expected lag in 0.25 s bins
    const R = r.approx ? Math.round(900 / dt) : Math.round(4 / dt);
    // coarse (1 s steps) then fine (0.25 s steps)
    let best = L0, bestC = -1;
    const scores = [];
    for (let L = Math.round((L0 - R) / 4); L <= Math.round((L0 + R) / 4); L++) {
      const c = corrAt(A1, B1, L, 30);
      scores.push(c);
      if (c > bestC) { bestC = c; best = L * 4; }
    }
    let fine = best, fineC = -1;
    for (let L = best - 6; L <= best + 6; L++) { const c = corrAt(A, B, L, 120); if (c > fineC) { fineC = c; fine = L; } }
    const med = percentile(scores.filter((x) => x > -1), 0.5);
    if (fineC > 0.25 && fineC - med > 0.15) { r.offset = anchor.offset + fine * dt; r.synced = true; }
  }
}

// ---------- building the edit ----------
function piecesForRec(rec, start, end, rate) {
  const s = start - rec.offset, e = end - rec.offset;
  const out = [];
  if (rec.segs) {
    for (const g of rec.segs) {
      if (g.effEnd <= s || g.t0 >= e) continue;
      const from = Math.max(s, g.t0) - g.t0, to = Math.min(e, g.effEnd) - g.t0;
      if (to - from > 0.05) out.push({ src: `${rec.key}:${g.i}`, from, to, rate });
    }
  } else {
    const from = Math.max(0, s), to = Math.min(rec.meta.duration, e);
    if (to - from > 0.05) out.push({ src: `${rec.key}:file`, from, to, rate });
  }
  return out;
}

const coverage = (rec, a, b) => Math.max(0, Math.min(b, rec.offset + rec.meta.duration) - Math.max(a, rec.offset)) / Math.max(0.01, b - a);

function motionScore(rec, a, b) {
  const tl = rec.meta.timeline;
  if (!tl || !tl.motion || !tl.motion.length) return 0;
  if (!rec._mz) rec._mz = robustZ(tl.motion);
  const i0 = Math.max(0, Math.floor((a - rec.offset) / tl.dt)), i1 = Math.min(rec._mz.length, Math.ceil((b - rec.offset) / tl.dt));
  let s = 0, n = 0; for (let i = i0; i < i1; i++) { s += rec._mz[i]; n++; }
  return n ? s / n : 0;
}

// recs: [{key, who, offset, meta, segs?}] ; returns { plan, clips }
export function buildMultiPlan(recs, targetSec = 120, title = '') {
  const multi = recs.length > 1;
  // 1. every candidate from every phone, on the shared timeline
  const all = [];
  // phones without a sound/motion summary (died very early) only provide angles – unless no phone has one
  const voters = recs.some((x) => !x.noDetect) ? recs.filter((x) => !x.noDetect) : recs;
  for (const r of voters) for (const c of candidates(r.meta)) {
    all.push({ ...c, start: c.start + r.offset, end: c.end + r.offset, ev: c.ev + r.offset, rec: r });
  }
  all.sort((a, b) => a.ev - b.ev);
  // 2. the same moment seen by several phones → one highlight
  const clusters = [];
  for (const c of all) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(c.ev - last.ev) < 3.5) {
      last.items.push(c);
      last.start = Math.min(last.start, c.start); last.end = Math.max(last.end, c.end);
      if (c.score > last.top) { last.top = c.score; last.ev = c.ev; }
      last.marked = last.marked || c.marked; last.weak = last.weak && c.weak;
    } else clusters.push({ items: [c], start: c.start, end: c.end, ev: c.ev, top: c.score, marked: c.marked, weak: c.weak });
  }
  for (const k of clusters) {
    const phones = new Set(k.items.map((x) => x.rec.key)).size;
    k.score = k.top + 0.4 * (phones - 1);
    k.start = Math.max(k.start, k.ev - 18); k.end = Math.min(k.end, k.ev + 4);
    k.angles = recs.filter((r) => coverage(r, k.ev - 4.5, k.ev - 0.3) > 0.95);
  }
  // 3. keep the best that fit the length you picked
  const budget = Math.max(20, targetSec - 16);
  const picked = [];
  let total = 0;
  for (const k of [...clusters].sort((a, b) => b.score - a.score)) {
    if (total >= budget) break;
    if (k.end - k.start < 3) continue;
    if (picked.some((p) => k.start < p.end + 0.5 && k.end > p.start - 0.5)) continue;
    picked.push(k);
    total += k.end - k.start + (multi && k.angles.length > 1 ? 7 : 0);
  }
  picked.sort((a, b) => a.start - b.start);
  let best = -1, bs = -1e9;
  picked.forEach((c, i) => { if (c.score > bs) { bs = c.score; best = i; } });

  // 4. choose camera angles and make the plan
  const plan = [{ type: 'title', dur: 2.8, title, phones: recs.length }];
  let prevKey = null;
  picked.forEach((k, idx) => {
    const options = recs.map((r) => ({ r, cov: coverage(r, k.start, k.end) })).filter((o) => o.cov > 0.05);
    if (!options.length) return;
    for (const o of options) {
      o.score = o.cov * 2 + motionScore(o.r, k.start, k.end) * 0.6 + (k.items.some((x) => x.rec === o.r) ? 0.4 : 0) - (o.r.key === prevKey ? 0.35 : 0);
    }
    options.sort((a, b) => b.score - a.score);
    const main = options[0].r;
    prevKey = main.key;
    const pieces = piecesForRec(main, k.start, k.end, 1);
    if (!pieces.length) return;
    plan.push({ type: 'clip', n: idx + 1, total: picked.length, marked: k.marked, who: multi ? main.who : '', pieces });
    // replay from a second phone
    if (multi && idx !== best) {
      const other = k.angles.filter((r) => r !== main).sort((a, b) => motionScore(b, k.ev - 4.5, k.ev) - motionScore(a, k.ev - 4.5, k.ev))[0];
      if (other && k.score >= percentileScore(picked, 0.35)) {
        const p2 = piecesForRec(other, k.ev - 4.2, k.ev - 0.4, 0.6);
        if (p2.length) plan.push({ type: 'angle', who: other.who, pieces: p2 });
      }
    }
  });
  // 5. play of the match from every angle
  if (best >= 0 && (picked.length >= 2 || multi)) {
    const k = picked[best];
    const angles = (k.angles.length ? k.angles : recs.filter((r) => coverage(r, k.ev - 4.5, k.ev) > 0.5)).slice(0, 3);
    angles.forEach((r, i) => {
      const p = piecesForRec(r, k.ev - 4.5, k.ev - 0.3, 0.5);
      if (p.length) plan.push({ type: 'replay', who: multi ? r.who : '', n: i + 1, of: angles.length, pieces: p });
    });
  }
  plan.push({ type: 'outro', dur: 2.4 });
  return { plan: plan.filter((s) => !s.pieces || s.pieces.length), clips: picked };
}

function percentileScore(picked, p) { return percentile(picked.map((k) => k.score), p); }

export function planSeconds(plan) {
  let t = 0;
  for (const s of plan) {
    if (s.dur) t += s.dur;
    if (s.pieces) { for (const p of s.pieces) t += (p.to - p.from) / p.rate; t += 0.35; }
  }
  return t;
}
