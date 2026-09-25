// Local server: static files + /api/event backed by an in-memory Redis stand-in. `npm run dev`
import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3917;

// ponytail: data lives in memory and is gone on restart; the organizer's browser re-uploads its copy on next open
const db = new Map();
process.env.KV_REST_API_URL = 'mem://';
process.env.KV_REST_API_TOKEN = 'local';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (url !== 'mem://') return realFetch(url, opts);
  const [cmd, k, v] = JSON.parse(opts.body);
  if (cmd === 'SET') db.set(k, v);
  return Response.json({ result: cmd === 'GET' ? db.get(k) ?? null : 'OK' });
};
const api = await import('./api/event.js');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/api/event' && api[req.method]) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await api[req.method](new Request(url, {
      method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
    }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
    return;
  }
  try {
    const file = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Face to Face: http://localhost:${PORT}`);
  for (const i of Object.values(os.networkInterfaces()).flat())
    if (i.family === 'IPv4' && !i.internal) console.log(`В той же Wi-Fi сети: http://${i.address}:${PORT}`);
});
