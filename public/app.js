// Leave Your Traces — the tree, the memories hanging off it, and the two
// panels (an opened memory with its thread, and the form for leaving one).

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TAU = Math.PI * 2;

const CYAN = '94, 242, 255';
const MAGENTA = '255, 61, 154';
const AMBER = '255, 184, 77';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- state

const traces = []; // oldest first; index decides where a memory hangs
const nodes = new Map(); // trace id -> { trace, i, x, y, tilt, img, born }
let hovered = null;
let opened = null;

const canvas = $('tree');
const ctx = canvas.getContext('2d');
let vw = 0, vh = 0, dpr = 1;

const cam = { x: 0, y: -380, s: 0.6 };
let camTarget = null;
let userMoved = false;

// ------------------------------------------------------------- geometry
// World units, origin at the foot of the trunk, y pointing down.

const H = 620; // trunk height
const THUMB = 86;

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry(1026);

function trunkX(y, t) {
  const u = clamp(-y / H, 0, 1.2);
  return Math.sin(y * 0.007 + t * 0.25) * 16 * u + Math.sin(y * 0.019 - t * 0.17) * 5 * u;
}

const strands = Array.from({ length: 11 }, (_, k) => ({
  off: (k / 10 - 0.5) * 2,
  phase: k * 1.93,
  speed: 0.15 + rand() * 0.3,
  hue: rand(),
}));

function strandX(s, y, t) {
  const u = -y / H;
  const width = 9 + 62 * Math.exp(-u * 7) + 16 * u * u;
  return trunkX(y, t) + (s.off * 0.55 + Math.sin(y * 0.021 + s.phase + t * s.speed) * 0.6) * width;
}

// Bare twigs that are always there, so the tree has a silhouette before
// anyone has left anything.
const twigs = [];
const tips = [];
function grow(x, y, angle, len, depth, rootY) {
  if (depth > 5 || len < 12) {
    tips.push({ x, y, rootY, depth, phase: rand() * TAU });
    return;
  }
  const x2 = x + Math.cos(angle) * len;
  const y2 = y + Math.sin(angle) * len;
  twigs.push({ x1: x, y1: y, x2, y2, depth, rootY });
  const forks = rand() < 0.3 ? 3 : 2;
  for (let i = 0; i < forks; i++) {
    grow(x2, y2, angle + (rand() - 0.5) * 1.4, len * (0.6 + rand() * 0.22), depth + 1, rootY);
  }
}
[
  [0.5, -0.5], [0.62, -2.5], [0.74, -0.9], [0.84, -2.2], [0.93, -1.25], [1, -1.75], [1, -1.4],
].forEach(([u, angle]) => grow(0, -H * u, angle, 95 + rand() * 40, 1, -H * u));

// Phyllotaxis around the crown: stable, so a memory stays where it was hung
// while newer ones spiral outward.
function place(i) {
  const a = i * 2.39996323 + 0.9;
  const r = 120 + 58 * Math.sqrt(i);
  let x = Math.cos(a) * r * 1.25;
  x += Math.sign(x || 1) * 46;
  let dy = Math.sin(a) * r;
  if (dy > 0) dy *= 0.5;
  return { x, y: -H * 0.9 + dy * 0.85 };
}

function addNode(trace, delay) {
  const i = nodes.size;
  const img = new Image();
  img.decoding = 'async';
  img.src = `/api/traces/${trace.id}/thumb`;
  const node = {
    trace, i, img,
    ...place(i),
    tilt: (mulberry(i * 7919 + 13)() - 0.5) * 0.18,
    born: performance.now() + delay,
    fx: 0, fy: 0, w: THUMB, h: THUMB,
  };
  nodes.set(trace.id, node);
  return node;
}

// Dust, and fragments of what people wrote, rising past the trunk.
const dust = Array.from({ length: 90 }, () => ({
  x: (rand() - 0.5) * 1600,
  y: -rand() * 1300 + 150,
  v: 4 + rand() * 10,
  phase: rand() * TAU,
  size: 0.6 + rand() * 1.4,
}));
const DEFAULT_THOUGHTS = ['remember', '记得', 'who was there', 'that summer', 'still here', '后来呢', 'the light', '我在', 'don’t forget'];
const thoughts = [];
let nextThought = 0;

function spawnThought(now) {
  const pool = traces.map((t) => t.text).filter(Boolean);
  const source = pool.length ? pool[Math.floor(Math.random() * pool.length)] : DEFAULT_THOUGHTS[Math.floor(Math.random() * DEFAULT_THOUGHTS.length)];
  const words = source.replace(/\s+/g, ' ').trim();
  const start = words.length > 26 ? Math.floor(Math.random() * (words.length - 26)) : 0;
  thoughts.push({
    text: words.slice(start, start + 26),
    x: (Math.random() - 0.5) * 700,
    y: -100 - Math.random() * 700,
    born: now,
    life: 9000 + Math.random() * 5000,
  });
}

// --------------------------------------------------------------- render

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  vw = window.innerWidth;
  vh = window.innerHeight;
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  if (!userMoved) fit(false);
}

function bounds() {
  let x0 = -260, x1 = 260, y0 = -H, y1 = 70;
  for (const tip of tips) {
    x0 = Math.min(x0, tip.x - 20);
    x1 = Math.max(x1, tip.x + 20);
    y0 = Math.min(y0, tip.y - 20);
  }
  for (const n of nodes.values()) {
    x0 = Math.min(x0, n.x - 70);
    x1 = Math.max(x1, n.x + 70);
    y0 = Math.min(y0, n.y - 70);
    y1 = Math.max(y1, n.y + 80);
  }
  return { x0, x1, y0, y1 };
}

function fit(animate) {
  const b = bounds();
  const s = clamp(Math.min(vw / (b.x1 - b.x0), (vh - 90) / (b.y1 - b.y0)), 0.28, 1.1);
  const target = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 - 20 / s, s };
  if (animate) camTarget = target;
  else Object.assign(cam, target);
}

const toWorld = (px, py) => ({ x: (px - vw / 2) / cam.s + cam.x, y: (py - vh / 2) / cam.s + cam.y });

function line(points) {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.stroke();
}

function drawGround(t) {
  // a low striped sun behind the trunk
  const sun = ctx.createLinearGradient(0, -170, 0, 0);
  sun.addColorStop(0, `rgba(${AMBER}, 0.2)`);
  sun.addColorStop(1, `rgba(${MAGENTA}, 0.26)`);
  ctx.fillStyle = sun;
  for (let k = 0; k < 9; k++) {
    const top = -170 + k * 19;
    const bottom = Math.min(0, top + 19 - k * 1.6);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-180, top, 360, bottom - top);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(0, 0, 170, Math.PI, TAU);
    ctx.fill();
    ctx.restore();
  }

  // perspective floor
  const fade = ctx.createLinearGradient(0, 0, 0, 380);
  fade.addColorStop(0, `rgba(${MAGENTA}, 0.5)`);
  fade.addColorStop(1, `rgba(${MAGENTA}, 0)`);
  ctx.strokeStyle = fade;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let j = -16; j <= 16; j++) {
    ctx.moveTo(j * 26, 0);
    ctx.lineTo(j * 240, 380);
  }
  const drift = (t * 0.12) % 1;
  for (let k = 0; k < 11; k++) {
    const y = 5 * Math.pow(1.5, k + drift);
    if (y > 380) break;
    ctx.moveTo(-3800, y);
    ctx.lineTo(3800, y);
  }
  ctx.stroke();

  ctx.strokeStyle = `rgba(${MAGENTA}, 0.9)`;
  ctx.shadowColor = `rgb(${MAGENTA})`;
  ctx.shadowBlur = 14;
  line([-3800, 0, 3800, 0]);
  ctx.shadowBlur = 0;
}

function drawTrunk(t) {
  ctx.lineCap = 'round';
  ctx.shadowBlur = 12;
  for (const s of strands) {
    const grad = ctx.createLinearGradient(0, 380, 0, -H);
    grad.addColorStop(0, `rgba(${AMBER}, 0)`);
    grad.addColorStop(0.38, `rgba(${AMBER}, 0.75)`);
    grad.addColorStop(0.7, `rgba(${MAGENTA}, 0.7)`);
    grad.addColorStop(0.93, `rgba(${CYAN}, 0.75)`);
    grad.addColorStop(1, `rgba(${CYAN}, 0)`);
    ctx.strokeStyle = grad;
    ctx.shadowColor = s.hue > 0.5 ? `rgb(${MAGENTA})` : `rgb(${CYAN})`;
    ctx.lineWidth = 1 + s.hue * 1.6;
    ctx.beginPath();
    // the fibres run out along the floor before they climb
    const foot = strandX(s, 0, t);
    ctx.moveTo(foot * 7, 380);
    ctx.lineTo(foot, 0);
    for (let y = -10; y >= -H; y -= 10) ctx.lineTo(strandX(s, y, t), y);
    ctx.stroke();

    // a pulse climbing each fibre
    const p = (t * (0.05 + s.speed * 0.12) + s.phase) % 1;
    const py = -H * p;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * Math.sin(p * Math.PI)})`;
    ctx.beginPath();
    ctx.arc(strandX(s, py, t), py, 1.8, 0, TAU);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function drawTwigs(t) {
  const sway = (y, depth) => Math.sin(t * 0.6 + y * 0.011) * depth * 2.2;
  for (const g of twigs) {
    const shift = trunkX(g.rootY, t);
    ctx.strokeStyle = `rgba(${g.depth > 3 ? CYAN : '170, 120, 255'}, ${0.42 - g.depth * 0.055})`;
    ctx.lineWidth = Math.max(0.5, 2.6 - g.depth * 0.45);
    line([
      g.x1 + shift + sway(g.y1, g.depth - 1), g.y1,
      g.x2 + shift + sway(g.y2, g.depth), g.y2,
    ]);
  }
  for (const tip of tips) {
    const glow = 0.35 + 0.35 * Math.sin(t * 1.3 + tip.phase);
    ctx.fillStyle = `rgba(${AMBER}, ${glow})`;
    ctx.beginPath();
    ctx.arc(tip.x + trunkX(tip.rootY, t) + sway(tip.y, tip.depth), tip.y, 1.5, 0, TAU);
    ctx.fill();
  }
}

function drawAtmosphere(t, now) {
  const halo = ctx.createRadialGradient(0, -H * 0.9, 0, 0, -H * 0.9, 760);
  halo.addColorStop(0, 'rgba(120, 50, 190, 0.22)');
  halo.addColorStop(0.5, 'rgba(60, 30, 120, 0.08)');
  halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = halo;
  ctx.fillRect(-900, -H * 0.9 - 800, 1800, 1600);

  for (const d of dust) {
    const y = ((d.y - t * d.v) % 1450 + 1450) % 1450 - 1300;
    ctx.fillStyle = `rgba(${CYAN}, ${0.18 + 0.3 * Math.abs(Math.sin(t * 0.7 + d.phase))})`;
    ctx.fillRect(d.x + Math.sin(t * 0.3 + d.phase) * 14, y, d.size, d.size);
  }

  if (now > nextThought && thoughts.length < 7) {
    spawnThought(now);
    nextThought = now + 1800 + Math.random() * 2200;
  }
  ctx.font = '20px VT323, monospace';
  ctx.textAlign = 'center';
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const th = thoughts[i];
    const age = (now - th.born) / th.life;
    if (age >= 1) {
      thoughts.splice(i, 1);
      continue;
    }
    ctx.fillStyle = `rgba(${CYAN}, ${0.3 * Math.sin(age * Math.PI)})`;
    ctx.fillText(th.text, th.x + Math.sin(age * 5 + th.x) * 12, th.y - age * 90);
  }
}

function drawNode(n, t, now) {
  const age = clamp((now - n.born) / 1400, 0, 1);
  if (age <= 0) return;
  const grown = 1 - Math.pow(1 - age, 3);
  const lit = n === hovered || n === opened;

  // where it floats right now
  n.fx = n.x + Math.sin(t * 0.5 + n.i * 1.7) * 7;
  n.fy = n.y + Math.cos(t * 0.4 + n.i * 1.3) * 9;

  // the branch holding it
  const ay = clamp(n.y + 150, -H * 0.97, -H * 0.3);
  const ax = trunkX(ay, t);
  const cx = ax + (n.fx - ax) * 0.15;
  const cy = n.fy + (ay - n.fy) * 0.2;
  const grad = ctx.createLinearGradient(ax, ay, n.fx, n.fy);
  grad.addColorStop(0, `rgba(${MAGENTA}, ${lit ? 0.95 : 0.55})`);
  grad.addColorStop(1, `rgba(${CYAN}, ${lit ? 0.95 : 0.5})`);
  ctx.strokeStyle = grad;
  ctx.lineWidth = lit ? 2 : 1.2;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  const at = (p) => {
    const q = 1 - p;
    return [q * q * ax + 2 * q * p * cx + p * p * n.fx, q * q * ay + 2 * q * p * cy + p * p * n.fy];
  };
  for (let k = 1; k <= 24; k++) ctx.lineTo(...at((k / 24) * grown));
  ctx.stroke();

  if (age < 1) {
    const [tx, ty] = at(grown);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(tx, ty, 2.5, 0, TAU);
    ctx.fill();
    if (age < 0.75) return;
  } else {
    const [px, py] = at((t * 0.11 + n.i * 0.37) % 1);
    ctx.fillStyle = `rgba(255, 255, 255, 0.8)`;
    ctx.beginPath();
    ctx.arc(px, py, 1.5, 0, TAU);
    ctx.fill();
  }

  // the memory itself
  const loaded = n.img.complete && n.img.naturalWidth > 0;
  if (loaded) {
    const k = THUMB / Math.max(n.img.naturalWidth, n.img.naturalHeight);
    n.w = n.img.naturalWidth * k;
    n.h = n.img.naturalHeight * k;
  }
  const { w, h } = n;
  ctx.save();
  ctx.translate(n.fx, n.fy);
  ctx.rotate(n.tilt + Math.sin(t * 0.3 + n.i) * 0.04);
  const pop = clamp((age - 0.75) / 0.25, 0, 1) * (lit ? 1.12 : 1);
  ctx.scale(pop, pop);

  ctx.shadowColor = lit ? `rgb(${MAGENTA})` : `rgb(${CYAN})`;
  ctx.shadowBlur = lit ? 26 : 12;
  ctx.fillStyle = '#07060b';
  ctx.fillRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6);
  ctx.shadowBlur = 0;

  if (loaded) {
    ctx.globalAlpha = lit ? 1 : 0.84;
    ctx.drawImage(n.img, -w / 2, -h / 2, w, h);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = `rgba(${CYAN}, 0.08)`;
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  // faint scanlines so photos sit in the same world as everything else
  ctx.fillStyle = 'rgba(7, 6, 11, 0.22)';
  for (let y = -h / 2; y < h / 2; y += 3) ctx.fillRect(-w / 2, y, w, 1);

  ctx.strokeStyle = `rgba(${lit ? MAGENTA : CYAN}, ${lit ? 1 : 0.7})`;
  ctx.lineWidth = 1;
  ctx.strokeRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6);

  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = `rgba(${lit ? AMBER : CYAN}, 0.9)`;
  let label = '@' + n.trace.name;
  if (label.length > 16) label = label.slice(0, 15) + '…';
  if (n.trace.has_audio) label += ' ♪';
  if (n.trace.replies) label += ' ·' + n.trace.replies;
  ctx.fillText(label, -w / 2 - 3, h / 2 + 15);
  ctx.restore();
}

let clock = 0;
let last = performance.now();
function frame(now) {
  const dt = Math.min(now - last, 100);
  last = now;
  clock += (dt / 1000) * (reducedMotion ? 0.12 : 1);
  const t = clock;

  if (camTarget) {
    cam.x += (camTarget.x - cam.x) * 0.09;
    cam.y += (camTarget.y - cam.y) * 0.09;
    cam.s += (camTarget.s - cam.s) * 0.09;
    if (Math.abs(camTarget.x - cam.x) + Math.abs(camTarget.y - cam.y) < 0.5 && Math.abs(camTarget.s - cam.s) < 0.002) camTarget = null;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#07060b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * cam.s, 0, 0, dpr * cam.s, dpr * (vw / 2 - cam.x * cam.s), dpr * (vh / 2 - cam.y * cam.s));

  drawAtmosphere(t, now);
  drawGround(t);
  ctx.globalCompositeOperation = 'lighter';
  drawTwigs(t);
  drawTrunk(t);
  ctx.globalCompositeOperation = 'source-over';
  for (const n of nodes.values()) if (n !== hovered && n !== opened) drawNode(n, t, now);
  if (opened) drawNode(opened, t, now);
  if (hovered && hovered !== opened) drawNode(hovered, t, now);

  requestAnimationFrame(frame);
}

// -------------------------------------------------------------- pointer

function hit(px, py) {
  const p = toWorld(px, py);
  let found = null;
  for (const n of nodes.values()) {
    if (Math.abs(p.x - n.fx) <= n.w / 2 + 8 && Math.abs(p.y - n.fy) <= n.h / 2 + 12) found = n;
  }
  return found;
}

function zoomAt(px, py, s) {
  const before = toWorld(px, py);
  cam.s = clamp(s, 0.2, 4);
  cam.x = before.x - (px - vw / 2) / cam.s;
  cam.y = before.y - (py - vh / 2) / cam.s;
}

function touched() {
  userMoved = true;
  camTarget = null;
  $('hint').classList.add('gone');
}

const pointers = new Map();
let drag = null;
let pinch = null;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), s: cam.s };
    drag = null;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) {
    hovered = hit(e.clientX, e.clientY);
    canvas.classList.toggle('pointing', !!hovered);
    return;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    touched();
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist));
  } else if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    touched();
    canvas.classList.add('dragging');
    cam.x = drag.cx - dx / cam.s;
    cam.y = drag.cy - dy / cam.s;
  }
});

function release(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  canvas.classList.remove('dragging');
  if (drag && !drag.moved && e.type === 'pointerup') {
    const n = hit(e.clientX, e.clientY);
    if (n) openTrace(n);
    else if (opened) closeDetail();
  }
  drag = null;
  if (pointers.size < 2) pinch = null;
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', () => { hovered = null; });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  touched();
  zoomAt(e.clientX, e.clientY, cam.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
}, { passive: false });

// ------------------------------------------------------------------ api

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const stamp = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const remembered = (key) => {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
};
const remember = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
};

function refreshCount() {
  $('count').textContent = String(traces.length).padStart(3, '0');
  $('empty').hidden = traces.length > 0;
}

async function load() {
  try {
    const data = await api('/api/traces');
    data.traces.forEach((trace, i) => {
      traces.push(trace);
      addNode(trace, 300 + i * 70);
    });
  } catch (err) {
    $('empty').textContent = 'the archive is unreachable right now.';
  }
  refreshCount();
  fit(false);
  const linked = /^#t=([0-9a-f-]{36})$/.exec(location.hash);
  if (linked && nodes.has(linked[1])) openTrace(nodes.get(linked[1]));
}

// --------------------------------------------------------- opened memory

const audio = new Audio();
audio.preload = 'none';
let replyTo = null;

function duration() {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return opened && opened.trace.audio_ms ? opened.trace.audio_ms / 1000 : 0;
}

function syncPlayer() {
  const total = duration();
  $('d-fill').style.width = total ? `${clamp(audio.currentTime / total, 0, 1) * 100}%` : '0';
  $('d-clock').textContent = audio.currentTime > 0 ? mmss(audio.currentTime) : mmss(total);
  $('d-play').textContent = audio.paused ? '▶' : '❚❚';
}
['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata'].forEach((type) => audio.addEventListener(type, syncPlayer));
audio.addEventListener('ended', () => { audio.currentTime = 0; });

$('d-play').addEventListener('click', () => {
  if (audio.paused) audio.play().catch(() => { $('d-clock').textContent = 'cannot play'; });
  else audio.pause();
});
$('d-bar').addEventListener('click', (e) => {
  if (!Number.isFinite(audio.duration)) return;
  const box = $('d-bar').getBoundingClientRect();
  audio.currentTime = clamp((e.clientX - box.left) / box.width, 0, 1) * audio.duration;
});

function openTrace(node) {
  const { trace } = node;
  opened = node;
  audio.pause();
  $('d-image').src = `/api/traces/${trace.id}/image`;
  $('d-image').alt = trace.text ? trace.text.slice(0, 120) : `A memory left by ${trace.name}`;
  $('d-name').textContent = trace.name;
  $('d-contact').textContent = trace.contact || '';
  $('d-time').textContent = stamp(trace.created);
  $('d-text').textContent = trace.text || '';
  $('d-player').hidden = !trace.has_audio;
  if (trace.has_audio) {
    audio.src = `/api/traces/${trace.id}/audio`;
    syncPlayer();
  } else {
    audio.removeAttribute('src');
  }
  setReply(null);
  $('c-status').textContent = '';
  $('d-comments').replaceChildren();
  $('d-replies').textContent = '';
  $('detail').hidden = false;
  $('detail').querySelector('.panel-scroll').scrollTop = 0;
  history.replaceState(null, '', `#t=${trace.id}`);

  // bring it into the part of the screen the panel leaves free
  const panel = vw > 640 ? Math.min(440, vw) : 0;
  const s = Math.max(cam.s, 0.9);
  camTarget = { x: node.x + panel / 2 / s, y: node.y, s };
  loadComments(trace.id);
}

function closeDetail() {
  opened = null;
  audio.pause();
  $('detail').hidden = true;
  history.replaceState(null, '', location.pathname);
}

async function loadComments(id) {
  try {
    const { comments } = await api(`/api/traces/${id}/comments`);
    if (opened && opened.trace.id === id) renderComments(comments);
  } catch (err) {
    $('c-status').textContent = err.message;
  }
}

function renderComments(comments) {
  const children = new Map();
  for (const c of comments) {
    const key = c.parent_id || '';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(c);
  }
  const build = (parentId, depth, into) => {
    for (const c of children.get(parentId) || []) {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = c.name;
      const contact = document.createElement('span');
      contact.className = 'contact';
      contact.textContent = c.contact || '';
      const time = document.createElement('time');
      time.textContent = stamp(c.created);
      meta.append(who, contact, time);
      const text = document.createElement('p');
      text.textContent = c.text;
      const reply = document.createElement('button');
      reply.type = 'button';
      reply.className = 'reply';
      reply.textContent = '↩ reply';
      reply.addEventListener('click', () => setReply(c));
      li.append(meta, text, reply);
      into.append(li);
      if (children.has(c.id)) {
        // stop indenting after a few levels so long exchanges stay readable
        const nest = depth < 3 ? document.createElement('ul') : into;
        if (nest !== into) li.append(nest);
        build(c.id, depth + 1, nest);
      }
    }
  };
  const list = $('d-comments');
  list.replaceChildren();
  build('', 0, list);
  if (!comments.length) {
    const none = document.createElement('li');
    none.className = 'none';
    none.textContent = 'no echoes yet. does this remind you of something?';
    list.append(none);
  }
  $('d-replies').textContent = comments.length ? `(${comments.length})` : '';
  if (opened) opened.trace.replies = comments.length;
}

function setReply(comment) {
  replyTo = comment;
  $('replying').hidden = !comment;
  if (comment) {
    $('replying-name').textContent = '@' + comment.name;
    $('c-text').focus();
  }
}
$('replying-cancel').addEventListener('click', () => setReply(null));

$('comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!opened) return;
  const id = opened.trace.id;
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;
  $('c-status').textContent = 'sending…';
  try {
    await api(`/api/traces/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: $('c-text').value,
        name: $('c-name').value,
        contact: $('c-contact').value,
        parent_id: replyTo ? replyTo.id : null,
      }),
    });
    remember('name', $('c-name').value.trim());
    remember('contact', $('c-contact').value.trim());
    $('c-text').value = '';
    $('c-status').textContent = '';
    setReply(null);
    await loadComments(id);
  } catch (err) {
    $('c-status').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

// ------------------------------------------------------- leaving a trace

const draft = { image: null, thumb: null, audio: null, audioMs: 0 };

function openCompose() {
  $('f-name').value = $('f-name').value || remembered('name');
  $('f-contact').value = $('f-contact').value || remembered('contact');
  $('f-status').textContent = '';
  $('compose').hidden = false;
}

function closeCompose() {
  stopRecording();
  $('compose').hidden = true;
}

$('open-compose').addEventListener('click', openCompose);
$('compose').addEventListener('pointerdown', (e) => { if (e.target === $('compose')) closeCompose(); });
document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => (button.closest('#compose') ? closeCompose() : closeDetail()));
});
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('compose').hidden) closeCompose();
  else if (opened) closeDetail();
});

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function shrink(source, max, quality) {
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const k = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', quality));
}

$('f-image').addEventListener('change', async () => {
  const file = $('f-image').files[0];
  if (!file) return;
  $('f-status').textContent = 'reading image…';
  try {
    const source = await decode(file);
    let image = await shrink(source, 1400, 0.82);
    if (image.size > 1_400_000) image = await shrink(source, 1100, 0.6);
    draft.image = image;
    draft.thumb = await shrink(source, 256, 0.72);
    $('f-preview').src = URL.createObjectURL(image);
    $('f-preview').hidden = false;
    $('f-prompt').hidden = true;
    $('f-status').textContent = '';
  } catch {
    draft.image = draft.thumb = null;
    $('f-status').textContent = 'that file could not be read as an image.';
  }
});

// voice
const MAX_SECONDS = 60;
let recorder = null;
let recStarted = 0;
let recTimer = 0;
let meterCtx = null;

function drawMeter(analyser) {
  const m = $('rec-meter');
  const g = m.getContext('2d');
  const data = new Uint8Array(analyser.fftSize);
  const tick = () => {
    if (!recorder) {
      g.clearRect(0, 0, m.width, m.height);
      return;
    }
    analyser.getByteTimeDomainData(data);
    g.clearRect(0, 0, m.width, m.height);
    g.strokeStyle = `rgb(${MAGENTA})`;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * m.width;
      const y = (data[i] / 255) * m.height;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.stroke();
    requestAnimationFrame(tick);
  };
  tick();
}

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    $('f-status').textContent = 'this browser cannot record audio.';
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    $('f-status').textContent = 'microphone access was refused.';
    return;
  }
  // mp4 plays everywhere; webm is the fallback where mp4 cannot be recorded
  const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const chunks = [];
  const rec = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 64000 });
  rec.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
  rec.addEventListener('stop', () => {
    stream.getTracks().forEach((track) => track.stop());
    if (meterCtx) meterCtx.close();
    meterCtx = null;
    draft.audioMs = Math.round(performance.now() - recStarted);
    draft.audio = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
    $('rec-audio').src = URL.createObjectURL(draft.audio);
    $('rec-done').hidden = false;
  });

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (AudioCtx) {
    meterCtx = new AudioCtx();
    const analyser = meterCtx.createAnalyser();
    analyser.fftSize = 256;
    meterCtx.createMediaStreamSource(stream).connect(analyser);
    recorder = rec;
    drawMeter(analyser);
  }
  recorder = rec;
  rec.start();
  recStarted = performance.now();
  $('rec').textContent = '■ stop';
  $('rec').classList.add('live');
  $('rec-done').hidden = true;
  $('f-status').textContent = '';
  recTimer = setInterval(() => {
    const seconds = (performance.now() - recStarted) / 1000;
    $('rec-clock').textContent = mmss(seconds);
    if (seconds >= MAX_SECONDS) stopRecording();
  }, 200);
}

function stopRecording() {
  if (!recorder) return;
  clearInterval(recTimer);
  const rec = recorder;
  recorder = null;
  if (rec.state !== 'inactive') rec.stop();
  $('rec').textContent = '● record again';
  $('rec').classList.remove('live');
}

$('rec').addEventListener('click', () => (recorder ? stopRecording() : startRecording()));
$('rec-clear').addEventListener('click', () => {
  draft.audio = null;
  draft.audioMs = 0;
  $('rec-audio').removeAttribute('src');
  $('rec-done').hidden = true;
  $('rec-clock').textContent = '0:00';
  $('rec').textContent = '● record';
});

function resetCompose() {
  draft.image = draft.thumb = draft.audio = null;
  draft.audioMs = 0;
  $('f-image').value = '';
  $('f-preview').hidden = true;
  $('f-prompt').hidden = false;
  $('f-text').value = '';
  $('rec-audio').removeAttribute('src');
  $('rec-done').hidden = true;
  $('rec-clock').textContent = '0:00';
  $('rec').textContent = '● record';
}

$('compose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (recorder) {
    $('f-status').textContent = 'stop the recording first.';
    return;
  }
  if (!draft.image) {
    $('f-status').textContent = 'add an image first.';
    return;
  }
  const body = new FormData();
  body.set('image', draft.image, 'image.jpg');
  body.set('thumb', draft.thumb, 'thumb.jpg');
  if (draft.audio) {
    body.set('audio', draft.audio, 'voice');
    body.set('audio_ms', String(draft.audioMs));
  }
  body.set('text', $('f-text').value);
  body.set('name', $('f-name').value);
  body.set('contact', $('f-contact').value);

  $('f-submit').disabled = true;
  $('f-status').textContent = 'grafting…';
  try {
    const { trace } = await api('/api/traces', { method: 'POST', body });
    remember('name', $('f-name').value.trim());
    remember('contact', $('f-contact').value.trim());
    traces.push(trace);
    const node = addNode(trace, 500);
    refreshCount();
    resetCompose();
    closeCompose();
    userMoved = true;
    camTarget = { x: node.x, y: node.y + 60, s: Math.max(cam.s, 0.8) };
  } catch (err) {
    $('f-status').textContent = err.message;
  } finally {
    $('f-submit').disabled = false;
  }
});

// ----------------------------------------------------------------- boot

$('c-name').value = remembered('name');
$('c-contact').value = remembered('contact');
addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
load();
