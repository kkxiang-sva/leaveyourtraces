// Leave Your Traces — the tree, the memories hanging off it, and the two
// panels (an opened memory with its thread, and the form for leaving one).

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TAU = Math.PI * 2;

const INK = '226, 222, 211';
const ACCENT = '214, 164, 95';
const BG = '#0a0a09';

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
// the tree turns about its trunk; dragging sideways spins it
let rot = 0;
let rotVel = 0;
let rotTarget = null;
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
  const around = y * 0.021 + s.phase + t * s.speed + rot;
  return trunkX(y, t) * Math.cos(rot) + Math.cos(around) * width * (0.45 + s.hue * 0.6);
}

// Everything on the tree lives at (distance from the trunk, height, angle
// around it) and is flattened here for the current rotation.
const DEPTH = 1400;
function project(r, y, az) {
  const a = az + rot;
  const z = r * Math.sin(a); // positive is the far side
  const k = DEPTH / (DEPTH + z);
  return { x: r * Math.cos(a) * k, y, z, k };
}

// Bare twigs that are always there, so the tree has a silhouette before
// anyone has left anything.
const twigs = [];
const tips = [];
function grow(r, y, angle, len, depth, rootY, az) {
  if (depth > 5 || len < 12) {
    tips.push({ r, y, az, rootY, depth, phase: rand() * TAU });
    return;
  }
  const r2 = r + Math.cos(angle) * len;
  const y2 = y + Math.sin(angle) * len;
  const az2 = az + (rand() - 0.5) * 0.9;
  twigs.push({ r1: r, y1: y, az1: az, r2, y2, az2, depth, rootY });
  const forks = rand() < 0.3 ? 3 : 2;
  for (let i = 0; i < forks; i++) {
    grow(r2, y2, angle + (rand() - 0.5) * 1.4, len * (0.6 + rand() * 0.22), depth + 1, rootY, az2);
  }
}
[
  [0.5, -0.5], [0.62, -0.64], [0.74, -0.9], [0.84, -0.94], [0.93, -1.25], [1, -1.39], [1, -1.4],
].forEach(([u, angle], k) => grow(0, -H * u, angle, 95 + rand() * 40, 1, -H * u, k * 2.39996323));

// A golden-angle spiral around the trunk: stable, so a memory stays where
// it was hung while newer ones settle further out.
function place(i, push = 0) {
  const az = i * 2.39996323 + 0.9;
  const r = 230 + 36 * Math.sqrt(i) + push;
  // not the golden ratio again, or height and angle line up into one helix
  const h = ((i + 1) * 0.7548776662) % 1;
  const y = -H * 0.46 - h * (H * 0.7 + 14 * Math.sqrt(i));
  return { r, y, az, wx: r * Math.cos(az), wz: r * Math.sin(az) };
}

function addNode(trace, delay) {
  const i = nodes.size;
  const img = new Image();
  img.decoding = 'async';
  img.src = `/api/traces/${trace.id}/thumb`;
  let spot = place(i);
  const crowded = (p) => [...nodes.values()].some((n) => Math.hypot(n.wx - p.wx, n.y - p.y, n.wz - p.wz) < 112);
  for (let push = 30; crowded(spot) && push < 600; push += 30) spot = place(i, push);
  const node = {
    trace, i, img,
    ...spot,
    tilt: (mulberry(i * 7919 + 13)() - 0.5) * 0.18,
    born: performance.now() + delay,
    fx: 0, fy: 0, z: 0, k: 1, w: THUMB, h: THUMB,
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
    x1 = Math.max(x1, Math.abs(tip.r) + 20);
    y0 = Math.min(y0, tip.y - 20);
  }
  for (const n of nodes.values()) {
    x1 = Math.max(x1, n.r * 1.15 + 60);
    y0 = Math.min(y0, n.y - 70);
    y1 = Math.max(y1, n.y + 80);
  }
  return { x0: -x1, x1, y0, y1 };
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
  // a single horizon, fading out to either side
  const horizon = ctx.createLinearGradient(-900, 0, 900, 0);
  horizon.addColorStop(0, `rgba(${INK}, 0)`);
  horizon.addColorStop(0.5, `rgba(${INK}, 0.4)`);
  horizon.addColorStop(1, `rgba(${INK}, 0)`);
  ctx.strokeStyle = horizon;
  ctx.lineWidth = 0.8;
  line([-900, 0, 900, 0]);

  // rings spreading across the floor from the foot of the trunk
  ctx.save();
  ctx.beginPath();
  ctx.rect(-2000, 0.5, 4000, 600);
  ctx.clip();
  ctx.lineWidth = 0.7;
  for (let k = 0; k < 7; k++) {
    const p = (k + (t * 0.04) % 1) / 7;
    const r = 40 + p * p * 900;
    ctx.strokeStyle = `rgba(${INK}, ${0.22 * (1 - p)})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.2, 0, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTrunk(t) {
  ctx.lineCap = 'round';
  ctx.shadowColor = `rgba(${INK}, 0.6)`;
  ctx.shadowBlur = 8;
  for (const s of strands) {
    const grad = ctx.createLinearGradient(0, 300, 0, -H);
    grad.addColorStop(0, `rgba(${INK}, 0)`);
    grad.addColorStop(0.36, `rgba(${INK}, ${0.3 + s.hue * 0.35})`);
    grad.addColorStop(0.9, `rgba(${INK}, ${0.25 + s.hue * 0.3})`);
    grad.addColorStop(1, `rgba(${INK}, 0)`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 0.6 + s.hue * 1.1;
    ctx.beginPath();
    // the fibres run out along the floor before they climb
    const foot = strandX(s, 0, t);
    ctx.moveTo(foot * 7, 300);
    ctx.lineTo(foot, 0);
    for (let y = -10; y >= -H; y -= 10) ctx.lineTo(strandX(s, y, t), y);
    ctx.stroke();

    // a pulse climbing each fibre
    const p = (t * (0.05 + s.speed * 0.12) + s.phase) % 1;
    const py = -H * p;
    ctx.fillStyle = `rgba(${ACCENT}, ${Math.sin(p * Math.PI)})`;
    ctx.beginPath();
    ctx.arc(strandX(s, py, t), py, 1.5, 0, TAU);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function drawTwigs(t) {
  const sway = (y, depth) => Math.sin(t * 0.6 + y * 0.011) * depth * 2.2;
  const lean = Math.cos(rot);
  for (const g of twigs) {
    const shift = trunkX(g.rootY, t) * lean;
    const a = project(g.r1, g.y1, g.az1);
    const b = project(g.r2, g.y2, g.az2);
    const near = clamp(1 - b.z / 500, 0.45, 1.3);
    ctx.strokeStyle = `rgba(${INK}, ${(0.3 - g.depth * 0.04) * near})`;
    ctx.lineWidth = Math.max(0.4, 1.8 - g.depth * 0.3);
    line([a.x + shift + sway(g.y1, g.depth - 1), a.y, b.x + shift + sway(g.y2, g.depth), b.y]);
  }
  for (const tip of tips) {
    const glow = 0.2 + 0.3 * Math.sin(t * 1.3 + tip.phase);
    if (glow <= 0) continue;
    const p = project(tip.r, tip.y, tip.az);
    ctx.fillStyle = `rgba(${INK}, ${glow})`;
    ctx.beginPath();
    ctx.arc(p.x + trunkX(tip.rootY, t) * lean + sway(tip.y, tip.depth), p.y, 1, 0, TAU);
    ctx.fill();
  }
}

function drawAtmosphere(t, now) {
  const halo = ctx.createRadialGradient(0, -H * 0.85, 0, 0, -H * 0.85, 700);
  halo.addColorStop(0, `rgba(${INK}, 0.055)`);
  halo.addColorStop(1, `rgba(${INK}, 0)`);
  ctx.fillStyle = halo;
  ctx.fillRect(-900, -H * 0.85 - 800, 1800, 1600);

  for (const d of dust) {
    const y = ((d.y - t * d.v) % 1450 + 1450) % 1450 - 1300;
    ctx.fillStyle = `rgba(${INK}, ${0.08 + 0.2 * Math.abs(Math.sin(t * 0.7 + d.phase))})`;
    ctx.fillRect(d.x + Math.sin(t * 0.3 + d.phase) * 14, y, d.size, d.size);
  }

  if (now > nextThought && thoughts.length < 6) {
    spawnThought(now);
    nextThought = now + 2200 + Math.random() * 2600;
  }
  ctx.font = '300 11px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const th = thoughts[i];
    const age = (now - th.born) / th.life;
    if (age >= 1) {
      thoughts.splice(i, 1);
      continue;
    }
    ctx.fillStyle = `rgba(${INK}, ${0.26 * Math.sin(age * Math.PI)})`;
    ctx.fillText(th.text, th.x + Math.sin(age * 5 + th.x) * 12, th.y - age * 90);
  }
}

// Memories hang in monochrome and only take their colour back when touched.
function monochrome(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const l = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
    px[i] = l * 0.98;
    px[i + 1] = l * 0.96;
    px[i + 2] = l * 0.9;
  }
  g.putImageData(data, 0, 0);
  return c;
}

function drawNode(n, t, now) {
  const age = clamp((now - n.born) / 1400, 0, 1);
  if (age <= 0) return;
  const grown = 1 - Math.pow(1 - age, 3);
  const lit = n === hovered || n === opened;
  // memories on the far side of the trunk recede
  const fade = lit ? 1 : clamp(1 - n.z / 520, 0.35, 1);
  ctx.globalAlpha = fade;

  // the branch holding it
  const ay = clamp(n.y + 150, -H * 0.97, -H * 0.3);
  const ax = trunkX(ay, t) * Math.cos(rot);
  const cx = ax + (n.fx - ax) * 0.15;
  const cy = n.fy + (ay - n.fy) * 0.2;
  const tone = lit ? ACCENT : INK;
  const grad = ctx.createLinearGradient(ax, ay, n.fx, n.fy);
  grad.addColorStop(0, `rgba(${tone}, ${lit ? 0.5 : 0.2})`);
  grad.addColorStop(1, `rgba(${tone}, ${lit ? 0.95 : 0.55})`);
  ctx.strokeStyle = grad;
  ctx.lineWidth = lit ? 1.2 : 0.8;
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
    ctx.fillStyle = `rgb(${ACCENT})`;
    ctx.beginPath();
    ctx.arc(tx, ty, 2, 0, TAU);
    ctx.fill();
    if (age < 0.75) {
      ctx.globalAlpha = 1;
      return;
    }
  } else {
    const [px, py] = at((t * 0.11 + n.i * 0.37) % 1);
    ctx.fillStyle = `rgba(${INK}, 0.8)`;
    ctx.beginPath();
    ctx.arc(px, py, 1.1, 0, TAU);
    ctx.fill();
  }

  // the memory itself
  const loaded = n.img.complete && n.img.naturalWidth > 0;
  if (loaded) {
    const k = THUMB / Math.max(n.img.naturalWidth, n.img.naturalHeight);
    n.w = n.img.naturalWidth * k;
    n.h = n.img.naturalHeight * k;
    n.mono ??= monochrome(n.img);
  }
  const { w, h } = n;
  ctx.save();
  ctx.translate(n.fx, n.fy);
  ctx.rotate(n.tilt + Math.sin(t * 0.3 + n.i) * 0.04);
  const pop = clamp((age - 0.75) / 0.25, 0, 1) * (lit ? 1.1 : 1) * n.k;
  ctx.scale(pop, pop);

  ctx.fillStyle = BG;
  ctx.fillRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6);
  if (loaded) {
    ctx.globalAlpha = fade * (lit ? 1 : 0.8);
    ctx.drawImage(lit ? n.img : n.mono, -w / 2, -h / 2, w, h);
    ctx.globalAlpha = fade;
  } else {
    ctx.fillStyle = `rgba(${INK}, 0.06)`;
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }

  ctx.strokeStyle = `rgba(${tone}, ${lit ? 1 : 0.45})`;
  ctx.lineWidth = 0.7;
  ctx.strokeRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6);

  ctx.font = '8px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = `rgba(${tone}, ${lit ? 1 : 0.6})`;
  let label = n.trace.name;
  if (label.length > 16) label = label.slice(0, 15) + '…';
  if (n.trace.has_audio) label += '  ♪';
  if (n.trace.replies) label += '  ' + n.trace.replies;
  ctx.fillText(label.toUpperCase(), -w / 2 - 3, h / 2 + 15);
  ctx.restore();
  ctx.globalAlpha = 1;
}

// far to near, so nearer memories cover the ones behind them
let order = [];
function arrange(t) {
  for (const n of nodes.values()) {
    const p = project(n.r, n.y, n.az);
    n.fx = p.x + Math.sin(t * 0.5 + n.i * 1.7) * 7;
    n.fy = p.y + Math.cos(t * 0.4 + n.i * 1.3) * 9;
    n.z = p.z;
    n.k = p.k;
  }
  const top = (n) => (n === hovered ? 2 : n === opened ? 1 : 0);
  order = [...nodes.values()].sort((a, b) => top(a) - top(b) || b.z - a.z);
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

  if (rotTarget !== null) {
    rot += (rotTarget - rot) * 0.09;
    if (Math.abs(rotTarget - rot) < 0.002) rotTarget = null;
  } else if (!drag && rotVel) {
    rot += rotVel;
    rotVel *= 0.92;
    if (Math.abs(rotVel) < 0.0002) rotVel = 0;
  }
  arrange(t);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * cam.s, 0, 0, dpr * cam.s, dpr * (vw / 2 - cam.x * cam.s), dpr * (vh / 2 - cam.y * cam.s));

  drawAtmosphere(t, now);
  drawGround(t);
  const lit = (n) => n === hovered || n === opened;
  for (const n of order) if (n.z > 0 && !lit(n)) drawNode(n, t, now);
  ctx.globalCompositeOperation = 'lighter';
  drawTwigs(t);
  drawTrunk(t);
  ctx.globalCompositeOperation = 'source-over';
  for (const n of order) if (n.z <= 0 || lit(n)) drawNode(n, t, now);

  requestAnimationFrame(frame);
}

// -------------------------------------------------------------- pointer

function hit(px, py) {
  const p = toWorld(px, py);
  let found = null;
  for (const n of order) {
    if (Math.abs(p.x - n.fx) <= (n.w / 2 + 8) * n.k && Math.abs(p.y - n.fy) <= (n.h / 2 + 12) * n.k) found = n;
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
  rotTarget = null;
  $('hint').classList.add('gone');
}

const TURN = 0.006; // radians per pixel dragged
const pointers = new Map();
let drag = null;
let pinch = null;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY, rot, cy: cam.y, moved: false, lastX: e.clientX, lastT: e.timeStamp };
    rotVel = 0;
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
    // sideways turns the tree, up and down still moves along it
    rot = drag.rot + dx * TURN;
    // carry the spin on after release, at the speed of the last movement
    const frames = Math.max(1, (e.timeStamp - drag.lastT) / 16.7);
    rotVel = reducedMotion ? 0 : clamp(((e.clientX - drag.lastX) * TURN) / frames, -0.04, 0.04);
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    cam.y = drag.cy - dy / cam.s;
  }
});

function release(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  canvas.classList.remove('dragging');
  if (drag && (!drag.moved || e.timeStamp - drag.lastT > 90)) rotVel = 0;
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

// Turn the tree so a memory comes round to the front, in the part of the
// screen the panel leaves free.
function face(node, panel) {
  const angle = -Math.PI / 2 - (panel ? 0.6 : 0.25);
  let turn = (angle - node.az - rot) % TAU;
  if (turn > Math.PI) turn -= TAU;
  if (turn < -Math.PI) turn += TAU;
  rotTarget = rot + turn;
  rotVel = 0;
  const k = DEPTH / (DEPTH + node.r * Math.sin(angle));
  const s = Math.max(cam.s, 0.9);
  camTarget = { x: node.r * Math.cos(angle) * k + panel / 2 / s, y: node.y, s };
}

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

  face(node, vw > 640 ? Math.min(440, vw) : 0);
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
    g.strokeStyle = `rgb(${ACCENT})`;
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
    face(node, 0);
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
