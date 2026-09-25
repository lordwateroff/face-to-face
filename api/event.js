// One event = one Redis key holding { key, state }. Upstash REST via fetch, no SDK.
// GET without the organizer key returns numbers only (no names) and is CDN-cached for guest phones.
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 90; // events expire after 90 days

async function redis(...cmd) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}` },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });

function parse(req) {
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!/^[a-z0-9]{6,32}$/.test(id)) return { err: json({ error: 'bad id' }, 400) };
  if (!DB_URL || !DB_TOKEN) return { err: json({ error: 'database is not configured' }, 503) };
  return { id, key: req.headers.get('x-key') || '' };
}

export async function GET(req) {
  const { id, key, err } = parse(req);
  if (err) return err;
  const raw = await redis('GET', `ev:${id}`);
  if (!raw) return json({ error: 'not found' }, 404);
  const saved = JSON.parse(raw);
  if (key && key === saved.key) return json(saved.state, 200, { 'Cache-Control': 'no-store' });
  const state = { ...saved.state, participants: saved.state.participants.map(({ id, num, active }) => ({ id, num, active })) };
  return json(state, 200, { 'Cache-Control': 'public, s-maxage=3, stale-while-revalidate=10' });
}

export async function PUT(req) {
  const { id, key, err } = parse(req);
  if (err) return err;
  if (key.length < 20) return json({ error: 'missing key' }, 401);
  const body = await req.text();
  if (body.length > 1_000_000) return json({ error: 'too large' }, 413);
  let state;
  try { state = JSON.parse(body); } catch { return json({ error: 'bad json' }, 400); }
  if (!Array.isArray(state?.participants) || !Array.isArray(state?.rounds)) return json({ error: 'bad state' }, 400);
  // ponytail: read-then-write, not atomic; fine for one organizer per event
  const raw = await redis('GET', `ev:${id}`);
  if (raw && JSON.parse(raw).key !== key) return json({ error: 'forbidden' }, 403);
  await redis('SET', `ev:${id}`, JSON.stringify({ key, state }), 'EX', TTL);
  return json({ ok: true });
}
