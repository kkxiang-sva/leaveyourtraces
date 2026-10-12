// API for leaveyourtraces.com. Static files in public/ are served by the
// assets layer; everything under /api/ lands here. All data lives in D1,
// including the (client-compressed) image and audio blobs.

const MAX_IMAGE = 1_500_000;
const MAX_THUMB = 200_000;
const MAX_AUDIO = 1_500_000; // D1 caps a single value at 2 MB
const MAX_TEXT = 1000;
const MAX_NAME = 40;
const MAX_CONTACT = 80;
const MAX_TRACES = 500;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const AUDIO_TYPES = ['audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT,
    text TEXT,
    created INTEGER NOT NULL,
    img BLOB NOT NULL,
    img_type TEXT NOT NULL,
    thumb BLOB NOT NULL,
    audio BLOB,
    audio_type TEXT,
    audio_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    contact TEXT,
    text TEXT NOT NULL,
    created INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS comments_by_trace ON comments (trace_id, created)`,
];

let ready;
function init(db) {
  ready ??= db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const fail = (status, error) => json({ error }, status);

function clean(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const baseType = (type) => (type || '').split(';')[0].trim().toLowerCase();

// D1 hands BLOBs back as plain number arrays.
function toBytes(blob) {
  return blob instanceof ArrayBuffer ? new Uint8Array(blob) : Uint8Array.from(blob);
}

// Safari will not play audio unless the server honours Range requests.
function serveBlob(request, blob, type) {
  const bytes = toBytes(blob);
  const size = bytes.length;
  const headers = {
    'content-type': type,
    'cache-control': 'public, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    let start, end;
    if (range[1] === '') {
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    } else {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    }
    return new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` },
    });
  }
  return new Response(bytes, { headers });
}

async function listTraces(db) {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, t.contact, t.text, t.created, t.audio_ms,
              t.audio IS NOT NULL AS has_audio,
              (SELECT COUNT(*) FROM comments c WHERE c.trace_id = t.id) AS replies
         FROM traces t ORDER BY t.created ASC LIMIT ?`
    )
    .bind(MAX_TRACES)
    .all();
  return json({ traces: results });
}

async function createTrace(request, db) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail(400, 'expected form data');
  }
  const image = form.get('image');
  const thumb = form.get('thumb');
  const audio = form.get('audio');
  const name = clean(form.get('name'), MAX_NAME) || 'anonymous';

  if (!(image instanceof File) || !(thumb instanceof File)) return fail(400, 'an image is required');
  if (!IMAGE_TYPES.includes(baseType(image.type)) || !IMAGE_TYPES.includes(baseType(thumb.type))) {
    return fail(400, 'unsupported image type');
  }
  if (image.size > MAX_IMAGE || thumb.size > MAX_THUMB) return fail(413, 'image is too large');

  const hasAudio = audio instanceof File && audio.size > 0;
  if (hasAudio) {
    if (!AUDIO_TYPES.includes(baseType(audio.type))) return fail(400, 'unsupported audio type');
    if (audio.size > MAX_AUDIO) return fail(413, 'recording is too large');
  }

  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM traces').first();
  if (n >= MAX_TRACES) return fail(507, 'the archive is full');

  const trace = {
    id: crypto.randomUUID(),
    name,
    contact: clean(form.get('contact'), MAX_CONTACT) || null,
    text: clean(form.get('text'), MAX_TEXT) || null,
    created: Date.now(),
    audio_ms: hasAudio ? Math.max(0, Math.min(Number(form.get('audio_ms')) || 0, 600_000)) : null,
    has_audio: hasAudio ? 1 : 0,
    replies: 0,
  };
  await db
    .prepare(
      `INSERT INTO traces (id, name, contact, text, created, img, img_type, thumb, audio, audio_type, audio_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      trace.id,
      trace.name,
      trace.contact,
      trace.text,
      trace.created,
      await image.arrayBuffer(),
      baseType(image.type),
      await thumb.arrayBuffer(),
      hasAudio ? await audio.arrayBuffer() : null,
      hasAudio ? baseType(audio.type) : null,
      trace.audio_ms
    )
    .run();
  return json({ trace }, 201);
}

async function serveMedia(request, db, id, kind) {
  const column = { image: 'img', thumb: 'thumb', audio: 'audio' }[kind];
  const typeColumn = kind === 'audio' ? 'audio_type' : 'img_type';
  const row = await db
    .prepare(`SELECT ${column} AS data, ${typeColumn} AS type FROM traces WHERE id = ?`)
    .bind(id)
    .first();
  if (!row || !row.data) return fail(404, 'not found');
  return serveBlob(request, row.data, kind === 'thumb' ? 'image/jpeg' : row.type);
}

async function listComments(db, traceId) {
  const { results } = await db
    .prepare(
      `SELECT id, parent_id, name, contact, text, created
         FROM comments WHERE trace_id = ? ORDER BY created ASC LIMIT 1000`
    )
    .bind(traceId)
    .all();
  return json({ comments: results });
}

async function createComment(request, db, traceId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'expected json');
  }
  const text = clean(body.text, MAX_TEXT);
  if (!text) return fail(400, 'say something first');

  const trace = await db.prepare('SELECT id FROM traces WHERE id = ?').bind(traceId).first();
  if (!trace) return fail(404, 'trace not found');

  const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;
  if (parentId) {
    const parent = await db
      .prepare('SELECT id FROM comments WHERE id = ? AND trace_id = ?')
      .bind(parentId, traceId)
      .first();
    if (!parent) return fail(400, 'that message is gone');
  }

  const comment = {
    id: crypto.randomUUID(),
    parent_id: parentId,
    name: clean(body.name, MAX_NAME) || 'anonymous',
    contact: clean(body.contact, MAX_CONTACT) || null,
    text,
    created: Date.now(),
  };
  await db
    .prepare(
      `INSERT INTO comments (id, trace_id, parent_id, name, contact, text, created)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(comment.id, traceId, comment.parent_id, comment.name, comment.contact, comment.text, comment.created)
    .run();
  return json({ comment }, 201);
}

async function handleApi(request, env, path) {
  const db = env.DB;
  await init(db);
  const { method } = request;

  if (path === '/api/traces') {
    if (method === 'GET') return listTraces(db);
    if (method === 'POST') return createTrace(request, db);
    return fail(405, 'method not allowed');
  }

  const match = /^\/api\/traces\/([0-9a-f-]{36})\/(image|thumb|audio|comments)$/.exec(path);
  if (!match) return fail(404, 'not found');
  const [, id, kind] = match;

  if (kind === 'comments') {
    if (method === 'GET') return listComments(db, id);
    if (method === 'POST') return createComment(request, db, id);
    return fail(405, 'method not allowed');
  }
  if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method not allowed');
  return serveMedia(request, db, id, kind);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, pathname);
    } catch (err) {
      console.error(err);
      return fail(500, 'something broke on our side');
    }
  },
};
