// Positions tab: an interactive 6-2 rotation board.
// Based on the 6-2 rotations explained in "Volleyball Rotations 6-2" (SD Volleyball Videos):
// two setters, two opposites, two outside hitters, two middle blockers and a libero;
// a 3-person serve receive (both outside hitters + libero); the back-row setter sets.

const ZONES = { 1: 'Right back', 2: 'Right front', 3: 'Middle front', 4: 'Left front', 5: 'Left back', 6: 'Middle back' };
const ROLE = {
  S: { name: 'Setter', short: 'S', text: 'Runs the offence. In a 6-2 only the setter who is in the back row sets, so there are always three attackers in the front row. In serve receive the setter hides behind a front-row player and sprints to the setting spot (right front, near the net) as soon as the serve is hit.' },
  OPP: { name: 'Opposite', short: 'OPP', text: 'Attacks and blocks on the right side in the front row. In a 6-2 the opposite and the setter swap in and out: when a setter rotates to the front row, an opposite comes in for them.' },
  OH: { name: 'Outside Hitter', short: 'OH', text: 'Attacks from the left side and is one of the three passers in serve receive. In the back row the outside hitter usually plays middle back on defence.' },
  MB: { name: 'Middle Blocker', short: 'MB', text: 'Blocks across the whole net and hits quick sets in the middle. When a middle rotates to the back row the libero replaces them.' },
  L: { name: 'Libero', short: 'L', text: 'Back-row defensive specialist in a different shirt. Replaces the back-row middle blocker, passes serves and usually digs from left back. The libero may serve for one player in the rotation.' },
};
const PLAYERS = {
  S1: 'S', S2: 'S', OPP1: 'OPP', OPP2: 'OPP', OH1: 'OH', OH2: 'OH', MB1: 'MB', MB2: 'MB', L: 'L',
};
// Rotation 1 order, read clockwise from zone 1: 1 → 6 → 5 → 4 → 3 → 2
const ORDER = ['S1', 'MB1', 'OH2', 'OPP1', 'MB2', 'OH1'];
const ZORDER = [1, 6, 5, 4, 3, 2];
const BACK = new Set([1, 6, 5]);

// Who is actually on the court in rotation r (1–6), zone → player.
function lineupFor(r, phase) {
  const z = {};
  ZORDER.forEach((zone, i) => { z[zone] = ORDER[(i - (r - 1) + 60) % 6]; });
  // 6-2 substitutions: a setter in the front row is replaced by an opposite; an opposite in the back row by a setter
  for (const zone of [1, 2, 3, 4, 5, 6]) {
    const p = z[zone];
    if (p === 'S1' && !BACK.has(zone)) z[zone] = 'OPP2';
    if (p === 'OPP1' && BACK.has(zone)) z[zone] = 'S2';
  }
  // libero replaces the back-row middle (in rotation 6 the MB1 serves, then the libero comes back in)
  for (const zone of [1, 6, 5]) {
    const p = z[zone];
    if (p === 'MB1' || p === 'MB2') {
      if (!(r === 6 && phase !== 'receive' && p === 'MB1' && zone === 1)) z[zone] = 'L';
    }
  }
  return z;
}

// court coordinates in metres: x 0..9 (left → right, facing the net), y 0..9 (net → end line)
const BASE = {
  front: { L: [1.6, 2.2], M: [4.5, 2.2], R: [7.4, 2.2] },
  back: { L: [1.6, 5.8], M: [4.5, 6.6], R: [7.4, 5.8] },
};
const DEF = {
  front: { L: [1.2, 0.8], M: [4.5, 0.8], R: [7.8, 0.8] },
  back: { L: [1.3, 7.0], M: [4.5, 8.2], R: [7.7, 7.0] },
};
const ZPOS = { 4: [1.5, 2.2], 3: [4.5, 2.2], 2: [7.5, 2.2], 5: [1.5, 6.6], 6: [4.5, 6.6], 1: [7.5, 6.6] };

// Serve-receive spots by "shape" (rotations 1&4, 2&5, 3&6 share a shape). Legal overlaps respected.
const RECEIVE = {
  a: { 1: [8.3, 7.6], 2: [7.4, 5.9], 3: [4.5, 1.2], 4: [1.0, 1.2], 5: [1.6, 6.4], 6: [4.5, 6.6] }, // setter right back hides behind right front
  b: { 1: [7.5, 6.5], 2: [8.0, 1.0], 3: [5.4, 1.0], 4: [1.6, 5.6], 5: [4.0, 6.5], 6: [6.1, 2.4] }, // setter middle back hides behind middle front
  c: { 1: [7.5, 6.5], 2: [8.0, 1.0], 3: [2.2, 5.6], 4: [0.8, 1.0], 5: [1.3, 2.3], 6: [4.6, 6.5] }, // setter left back hides behind left front
};
const SHAPE = { 1: 'a', 4: 'a', 2: 'b', 5: 'b', 3: 'c', 6: 'c' };

function sideOf(role) { return role === 'OH' ? 'L' : role === 'MB' ? 'M' : role === 'OPP' ? 'R' : role === 'S' ? 'R' : role === 'L' ? 'L' : 'M'; }

function positionsFor(r, phase) {
  const z = lineupFor(r, phase);
  const out = {};
  for (const [zone, p] of Object.entries(z)) {
    const zn = +zone, role = PLAYERS[p];
    if (phase === 'rotation') out[p] = { xy: ZPOS[zn], zone: zn };
    else if (phase === 'receive') out[p] = { xy: RECEIVE[SHAPE[r]][zn], zone: zn };
    else {
      const row = BACK.has(zn) ? 'back' : 'front';
      let side = sideOf(role);
      if (row === 'back' && role === 'OH') side = 'M';         // back-row outside hitter plays middle back
      if (row === 'back' && role === 'MB') side = 'L';         // a back-row middle (no libero) plays left back
      const set = phase === 'base' ? BASE : DEF;
      out[p] = { xy: set[row][side], zone: zn };
    }
  }
  return out;
}

const PHASES = [
  ['rotation', 'Rotation', 'Where everyone must stand when the ball is served (rotation order). The server is the player in zone 1.'],
  ['receive', 'Serve receive', '3-person serve receive: both outside hitters and the libero pass. The setter hides legally behind a front-row player and releases to the setting spot when the serve is hit.'],
  ['base', 'Base', 'After the serve everyone switches to their specialist spot: outside hitter left, middle in the middle, opposite right. In the back row: libero left back, outside hitter middle back, setter right back. Coaches set base positions differently — this is a common one.'],
  ['defense', 'Defense', 'When the other team attacks: front row at the net to block, back row deep to dig. Libero left back, outside hitter middle back, setter right back.'],
];

const st = { r: 1, phase: 'receive', sel: null, follow: '', names: false, playing: false };
let root = null, timer = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function namesFromLineup() {
  try {
    const l = JSON.parse(localStorage.getItem('rr_lineup') || 'null');
    const team = l && l.teams && l.teams.find((t) => t.players && t.players.length);
    if (!team) return {};
    const byPos = {};
    for (const p of team.players) (byPos[p.pos] = byPos[p.pos] || []).push(p.name.split(' ')[0]);
    const map = {};
    ['S', 'OPP', 'OH', 'MB'].forEach((pos) => [1, 2].forEach((n) => { const nm = byPos[pos] && byPos[pos][n - 1]; if (nm) map[pos === 'OPP' ? `OPP${n}` : `${pos}${n}`] = nm; }));
    if (byPos.L && byPos.L[0]) map.L = byPos.L[0];
    return map;
  } catch { return {}; }
}

function courtSVG() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 116');
  svg.setAttribute('class', 'court');
  const add = (tag, attrs, parent = svg) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); parent.appendChild(n); return n; };
  add('rect', { x: 5, y: 12, width: 90, height: 90, fill: '#ffffff', stroke: '#0e0e0e', 'stroke-width': 0.8 });
  add('line', { x1: 5, y1: 42, x2: 95, y2: 42, stroke: '#0e0e0e', 'stroke-width': 0.4, 'stroke-dasharray': '1.6 1.2' });
  add('rect', { x: 2, y: 9.6, width: 96, height: 2.4, fill: '#0e0e0e' }); // net
  const t = add('text', { x: 50, y: 6.6, 'text-anchor': 'middle', 'font-size': 3.2, 'font-weight': 700, fill: '#6e6c67', 'letter-spacing': 0.8 }); t.textContent = 'NET';
  const t2 = add('text', { x: 96, y: 41, 'text-anchor': 'end', 'font-size': 2.4, fill: '#9a978f' }); t2.textContent = '3 m line';
  // zone numbers
  for (const [zn, [x, y]] of Object.entries(ZPOS)) {
    const n = add('text', { x: 5 + x * 10, y: 12 + y * 10 + (y < 4 ? 14 : 16), 'text-anchor': 'middle', 'font-size': 3, fill: '#d8d5cd', 'font-weight': 700 });
    n.textContent = zn;
  }
  const serverG = add('g', { class: 'server' });
  const players = {};
  for (const p of Object.keys(PLAYERS)) {
    const g = add('g', { class: 'p', 'data-p': p });
    add('circle', { r: 5.6, cx: 0, cy: 0, 'stroke-width': 0.8 }, g);
    const label = add('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 3.1, 'font-weight': 800, y: 0.1 }, g);
    const nm = add('text', { 'text-anchor': 'middle', 'font-size': 2.6, 'font-weight': 600, y: 9.2, fill: '#0e0e0e' }, g);
    players[p] = { g, label, nm };
  }
  return { svg, players, serverG, add };
}

function render() {
  if (!root) return;
  root.replaceChildren();
  const head = el('div', 'pos-head');
  const hl = el('div'); hl.append(el('p', 'kicker', 'Positions'), el('h1', '', '6-2 Rotations'));
  head.append(hl);
  root.append(head, el('p', 'muted small', 'Two setters, two opposites, two outside hitters, two middle blockers and a libero. Tap a player to see what they do.'));

  const controls = el('div', 'pos-controls');
  const rot = el('div', 'rot-nums');
  for (let r = 1; r <= 6; r++) {
    const b = el('button', r === st.r ? 'on' : '', String(r)); b.setAttribute('aria-label', `Rotation ${r}`);
    b.onclick = () => { stopPlay(); st.r = r; update(); };
    rot.append(b);
  }
  const phases = el('div', 'chips');
  for (const [key, label] of PHASES) {
    const b = el('button', key === st.phase ? 'on' : '', label);
    b.onclick = () => { stopPlay(); st.phase = key; update(); };
    phases.append(b);
  }
  controls.append(el('h2', '', 'Rotation'), rot, el('h2', '', 'Moment'), phases);
  root.append(controls);

  const wrap = el('div', 'court-wrap');
  const court = courtSVG();
  wrap.append(court.svg);
  const legend = el('div', 'court-legend');
  legend.innerHTML = '<span><b>S</b> Setter</span><span><b>OPP</b> Opposite</span><span><b>OH</b> Outside</span><span><b>MB</b> Middle</span><span><b>L</b> Libero (white)</span>';
  wrap.append(legend);
  root.append(wrap);

  const play = el('div', 'pos-play');
  const pb = el('button', 'btn primary', st.playing ? 'Pause' : 'Play the rally');
  pb.onclick = () => (st.playing ? stopPlay() : startPlay());
  const nb = el('button', 'btn', 'Next rotation ›');
  nb.onclick = () => { stopPlay(); st.r = st.r % 6 + 1; update(); };
  play.append(pb, nb);
  root.append(play);

  const follow = el('div', 'row-set');
  const fl = el('span', 'small muted', 'Follow a player');
  const sel = el('select'); sel.style.maxWidth = '200px';
  sel.append(Object.assign(el('option', '', 'Nobody'), { value: '' }));
  for (const p of Object.keys(PLAYERS)) sel.append(Object.assign(el('option', '', `${p} — ${ROLE[PLAYERS[p]].name}`), { value: p }));
  sel.value = st.follow;
  sel.onchange = () => { st.follow = sel.value; st.sel = sel.value || st.sel; update(); };
  follow.append(fl, sel);
  const nmBtn = el('button', 'btn small', st.names ? 'Show roles' : 'Show my team’s names');
  nmBtn.onclick = () => { st.names = !st.names; render(); };
  root.append(follow, nmBtn);

  const note = el('div', 'pos-note');
  root.append(note);

  const rolesH = el('div', 'section-h'); rolesH.append(el('h2', '', 'The roles'));
  const roles = el('div', 'roles');
  for (const [k, r] of Object.entries(ROLE)) {
    const card = el('div', 'role' + (st.sel && PLAYERS[st.sel] === k ? ' on' : ''));
    const top = el('div', 'role-top');
    const badge = el('div', 'role-badge', r.short);
    badge.style.background = k === 'L' ? '#fff' : '#0e0e0e'; badge.style.color = k === 'L' ? '#0e0e0e' : '#fff'; badge.style.border = '1.5px solid #0e0e0e';
    top.append(badge, el('b', '', r.name));
    card.append(top, el('p', '', r.text));
    roles.append(card);
  }
  const rules = el('div', 'pos-note');
  rules.append(el('h4', '', 'Overlap rule'), el('p', '', 'At the moment of the serve each player must be in the right order: every front-row player closer to the net than the back-row player behind them, and left-to-right order kept in each row. After the serve is hit everyone can move to their spot.'));
  const subs = el('div', 'pos-note');
  subs.append(el('h4', '', 'Substitutions in a 6-2'), el('p', '', 'Rotations 1–3: Setter 1 sets from the back row while Opposite 1 hits in the front row. At rotation 4, Setter 2 comes in for Opposite 1 and Opposite 2 comes in for Setter 1. Back at rotation 1 they swap again (Setter 1 for Opposite 2, Opposite 1 for Setter 2).'));
  const src = el('p', 'src');
  src.innerHTML = 'Based on <a href="https://youtu.be/Prfbkz73d3Q" target="_blank" rel="noopener">“Volleyball Rotations 6-2”</a> by SD Volleyball Videos. Base and defence spots vary by coach.';
  root.append(rolesH, roles, rules, subs, src);

  root._court = court; root._note = note; root._play = pb;
  update(true);
}

function update(first) {
  if (!root || !root._court) { render(); return; }
  // refresh control highlights
  root.querySelectorAll('.rot-nums button').forEach((b, i) => b.classList.toggle('on', i + 1 === st.r));
  root.querySelectorAll('.chips button').forEach((b, i) => b.classList.toggle('on', PHASES[i][0] === st.phase));
  root.querySelectorAll('.role').forEach((c, i) => c.classList.toggle('on', !!st.sel && PLAYERS[st.sel] === Object.keys(ROLE)[i]));
  root._play.textContent = st.playing ? 'Pause' : 'Play the rally';
  const { players, serverG, add } = root._court;
  const pos = positionsFor(st.r, st.phase);
  const names = st.names ? namesFromLineup() : {};
  serverG.replaceChildren();
  for (const [p, h] of Object.entries(players)) {
    const at = pos[p];
    const role = PLAYERS[p];
    const lib = role === 'L';
    const circle = h.g.querySelector('circle');
    if (!at) { h.g.style.opacity = '0'; h.g.style.pointerEvents = 'none'; continue; }
    let [x, y] = at.xy;
    // server stands behind the end line in rotation/serve views
    const serving = (st.phase === 'rotation') && at.zone === 1;
    if (serving) { x = 7.8; y = 9.9; }
    h.g.style.opacity = '1'; h.g.style.pointerEvents = 'auto';
    h.g.style.transform = `translate(${5 + x * 10}px, ${12 + y * 10}px)`;
    const hi = st.sel === p || st.follow === p;
    const dim = (st.follow && st.follow !== p);
    circle.setAttribute('fill', lib ? '#ffffff' : '#0e0e0e');
    circle.setAttribute('stroke', '#0e0e0e');
    circle.setAttribute('r', hi ? 6.6 : 5.6);
    circle.setAttribute('stroke-width', hi ? 1.6 : 0.8);
    h.g.style.opacity = dim ? '0.28' : '1';
    h.label.setAttribute('fill', lib ? '#0e0e0e' : '#ffffff');
    h.label.textContent = p;
    h.nm.textContent = names[p] || (serving ? 'SERVING' : '');
    h.g.onclick = () => { st.sel = st.sel === p ? null : p; update(); };
  }
  if (st.phase === 'receive') {
    // arrow: the setter releases to the setting spot
    const sp = Object.keys(pos).find((p) => PLAYERS[p] === 'S');
    if (sp) {
      const [sx, sy] = pos[sp].xy;
      add('line', { x1: 5 + sx * 10, y1: 12 + sy * 10, x2: 5 + 6.2 * 10, y2: 12 + 1.2 * 10, stroke: '#0e0e0e', 'stroke-width': 0.6, 'stroke-dasharray': '1.4 1', 'marker-end': '' }, serverG);
      const tgt = add('circle', { cx: 5 + 6.2 * 10, cy: 12 + 1.2 * 10, r: 1.4, fill: 'none', stroke: '#0e0e0e', 'stroke-width': 0.6 }, serverG);
      tgt.setAttribute('opacity', '0.8');
    }
  }
  // note text
  const z = lineupFor(st.r, st.phase);
  const phaseInfo = PHASES.find((p) => p[0] === st.phase);
  const setter = Object.values(z).find((p) => PLAYERS[p] === 'S');
  const libFor = st.r === 3 || st.r === 6 ? '' : '';
  const note = root._note;
  note.replaceChildren();
  note.append(el('h4', '', `Rotation ${st.r} · ${phaseInfo[1]}`), el('p', '', phaseInfo[2]));
  note.append(el('p', 'small muted', `Setting this rotation: ${setter}. Server: ${z[1] === 'L' ? 'the libero (serving for the middle)' : z[1]}.${libFor}`));
  if (st.sel && pos[st.sel]) {
    const r = ROLE[PLAYERS[st.sel]];
    note.append(el('p', '', `${st.sel} (${r.name}) — rotation spot: zone ${pos[st.sel].zone}, ${ZONES[pos[st.sel].zone].toLowerCase()}.`));
  } else if (st.sel) {
    note.append(el('p', '', `${st.sel} is on the bench this rotation (substituted).`));
  }
  if (first) { /* nothing */ }
}

// "Play the rally": serve receive → base → defence → next rotation
const SEQ = ['rotation', 'receive', 'base', 'defense'];
function startPlay() {
  st.playing = true;
  let i = SEQ.indexOf(st.phase);
  const step = () => {
    i++;
    if (i >= SEQ.length) { i = 0; st.r = st.r % 6 + 1; }
    st.phase = SEQ[i];
    update();
  };
  update();
  timer = setInterval(step, 1800);
}
function stopPlay() { st.playing = false; clearInterval(timer); timer = null; if (root && root._play) root._play.textContent = 'Play the rally'; }

export function mount(node) {
  root = node;
  render();
}
