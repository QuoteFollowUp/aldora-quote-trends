// GET  /api/upload: checks the manager code.
// POST /api/upload: saves a new merged data file (gzipped JSON built by the upload page).
// Keeps the previous version as dataset-prev.json.gz so one bad upload can be rolled back.
import { getStore } from '@netlify/blobs';
import { gunzipSync } from 'node:zlib';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (req) => {
  const { MANAGER_CODE } = process.env;
  if (!MANAGER_CODE) return json({ error: 'Set MANAGER_CODE in Netlify environment variables, then redeploy.' }, 500);
  if (req.headers.get('x-manager-code') !== MANAGER_CODE) return json({ error: 'Unauthorized' }, 401);
  if (req.method === 'GET') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const buf = Buffer.from(await req.arrayBuffer());
  let data;
  try { data = JSON.parse(gunzipSync(buf).toString('utf8')); } catch (e) { return json({ error: 'The upload could not be read.' }, 400); }
  if (data.v !== 1 || !data.q || !Array.isArray(data.q.o) || !data.q.o.length) return json({ error: 'The upload has no quotes in it.' }, 400);

  const store = getStore({ name: 'quote-trends', consistency: 'strong' });
  const prev = await store.get('dataset.json.gz', { type: 'arrayBuffer' });
  if (prev) await store.set('dataset-prev.json.gz', prev);
  await store.set('dataset.json.gz', buf);
  return json({ ok: true, quotes: data.q.o.length, closed: data.x ? data.x.o.length : 0 });
};

export const config = { path: '/api/upload' };
