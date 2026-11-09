// GET /api/data: the saved, merged quote data (gzipped JSON), cut to what the person may see.
//
// Sign-in (header x-team-code):
//   MANAGER_CODE                    -> everything (uploads also use this code)
//   a code in REP_ACCESS_CODES      -> the shared Aldora code list (team-level Netlify variable):
//        rep     only the customers they own (same ownership rule the dashboard uses:
//                the rep on most of the customer's quotes, or a saved account-list assignment)
//        branch  every quote at their branch
//        all     everything (ownership, view-only, Fred)
//   TEAM_CODE                       -> everything, but ONLY while REP_ACCESS_CODES is not set.
//                                      Once the shared list exists, the team code stops working.
// The cut happens here on the server, so a rep's phone never receives other reps' quotes.
import { getStore } from '@netlify/blobs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { whoIs, listIsSet, listIsBad, repsFor, canonRep, normCode } from '../lib/access.mjs';
import '../../engine.js'; // defines globalThis.QuoteEngine, the same engine the dashboard runs

const E = globalThis.QuoteEngine;
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
const viewerHeader = (v) => ({ 'x-viewer': encodeURIComponent(JSON.stringify(v)) });

function signIn(code) {
  const { MANAGER_CODE, TEAM_CODE } = process.env;
  const c = normCode(code);
  if (!c) return null;
  if (MANAGER_CODE && c === normCode(MANAGER_CODE)) return { role: 'all', name: 'Manager', label: 'All branches' };
  if (listIsSet()) {
    const w = whoIs(code);
    if (!w) return null;
    const label = w.role === 'all' ? 'All branches' : w.role === 'rep' ? 'Your customers' : w.role === 'branch' ? w.branch : [...repsFor(w)].join(', ');
    return { ...w, label };
  }
  if (TEAM_CODE && c === normCode(TEAM_CODE)) return { role: 'all', name: 'Team', label: 'All branches' };
  return null;
}

export function cut(ds, who) {
  if (who.role === 'all') return ds;
  let keep;
  if (who.role === 'branch') {
    keep = (loc) => E.BRANCHES[loc] === who.branch;
    const quotes = ds.quotes.filter((x) => keep(x.loc));
    const closed = ds.closed.filter((x) => keep(x.loc));
    const assign = (ds.assign || []).filter((a) => keep(a.loc));
    return { ...ds, quotes, closed, assign };
  }
  // rep or hand-picked reps: customers they own, decided by the dashboard's own engine
  const allow = repsFor(who);
  const B = E.build(ds);
  const keys = new Set();
  if (B) for (const { c } of B.customers({ cat: 'All' })) if (allow.has(canonRep(c.rep))) for (const q of c.quotes) keys.add(q.loc + '|' + q.ord);
  return {
    ...ds,
    quotes: ds.quotes.filter((x) => keys.has(x.loc + '|' + x.ord)),
    closed: ds.closed.filter((x) => keys.has(x.loc + '|' + x.ord)),
    assign: (ds.assign || []).filter((a) => allow.has(canonRep(a.rep))),
  };
}

export default async (req) => {
  const { MANAGER_CODE, TEAM_CODE } = process.env;
  if (!MANAGER_CODE || (!TEAM_CODE && !listIsSet())) return json({ error: 'Set MANAGER_CODE and REP_ACCESS_CODES (or TEAM_CODE) in Netlify environment variables, then redeploy.' }, 500);
  const who = signIn(req.headers.get('x-team-code'));
  if (!who) {
    if (listIsBad()) return json({ error: 'REP_ACCESS_CODES in Netlify is not valid. Re-paste it as one line.' }, 500);
    await new Promise((r) => setTimeout(r, 500));
    return json({ error: 'Unauthorized' }, 401);
  }
  const viewer = { name: who.name, role: who.role, label: who.label };
  const store = getStore({ name: 'quote-trends', consistency: 'strong' });
  const buf = await store.get('dataset.json.gz', { type: 'arrayBuffer' });
  if (!buf) return json({ empty: true }, 200, viewerHeader(viewer));
  const head = { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cache-control': 'no-store', ...viewerHeader(viewer) };
  if (who.role === 'all') return new Response(buf, { headers: head });

  const ds = E.decode(JSON.parse(gunzipSync(Buffer.from(buf)).toString('utf8')));
  const mine = cut(ds, who);
  if (!mine.quotes.length) return json({ empty: true, scoped: true }, 200, viewerHeader(viewer));
  return new Response(gzipSync(Buffer.from(JSON.stringify(E.encode(mine)))), { headers: head });
};

export const config = { path: '/api/data' };
