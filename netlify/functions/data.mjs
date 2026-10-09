// GET /api/data: returns the saved, merged quote data (gzipped JSON).
// Requires the team code or the manager code in the x-team-code header.
import { getStore } from '@netlify/blobs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (req) => {
  const { TEAM_CODE, MANAGER_CODE } = process.env;
  if (!TEAM_CODE || !MANAGER_CODE) return json({ error: 'Set TEAM_CODE and MANAGER_CODE in Netlify environment variables, then redeploy.' }, 500);
  const code = req.headers.get('x-team-code');
  if (!code || (code !== TEAM_CODE && code !== MANAGER_CODE)) return json({ error: 'Unauthorized' }, 401);
  const store = getStore({ name: 'quote-trends', consistency: 'strong' });
  const buf = await store.get('dataset.json.gz', { type: 'arrayBuffer' });
  if (!buf) return json({ empty: true });
  return new Response(buf, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cache-control': 'no-store' } });
};

export const config = { path: '/api/data' };
