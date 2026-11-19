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
import { whoIs, listIsSet, listIsBad, repsFor, canonRep, normCode, codeMap } from './lib/access.mjs';
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

// ---- Account lists from the Sales Hub (Nov 15 2026) ----
// The hub decides what is on each rep's account list (/api/account-flags). A customer Fred confirmed is not
// a rep's leaves that rep (goes to Unassigned); an approved new account goes to the rep who added it.
// Applied as extra rep assignments after the manager's saved ones, so every view agrees. Cached 5 minutes.
const HUB_URL = () => process.env.HUB_URL || 'https://aldora-sales-hub.netlify.app';
const acctKey = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\bisland glass\s*,?\s*ltd\b/g, " island glass limited ").replace(/\briverside glass\s*(?:&|and)?\s*mirror\s*,?\s*llc\b/g, " riverside glass and mirror georgia ").replace(/\bj\s*(?:&|and)?\s*l glass\s*,?\s*llc\b/g, " j and l glass christian ").replace(/\b(inc|llc|co|corp|corporation|company|ltd|the)\b/g, ' ').replace(/\s+/g, '');
// (no spaces, so "DANNYS GLASS INC" from the ERP matches "Danny's Glass, Inc." from a rep list)
const repKey = (r) => String(r || '').toLowerCase().replace(/[^a-z]/g, '').replace(/(.)\1/g, '$1');
let HUB = { at: 0, changes: null };
async function hubChanges() {
  if (HUB.changes && Date.now() - HUB.at < 300000) return HUB.changes;
  const own = Object.entries(codeMap()).find(([, v]) => /^@(all|view)\b/i.test(String(v)));
  if (!own) return null;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(HUB_URL() + '/api/account-flags?lists=1', { signal: ac.signal, headers: { 'x-hub-code': own[0] } });
    if (!r.ok) return HUB.changes;
    const d = await r.json();
    HUB = { at: Date.now(), changes: d.changes || {} };
    return HUB.changes;
  } catch { return HUB.changes; } finally { clearTimeout(t); }
}
export function applyHub(ds, changes) {
  if (!changes || !Object.keys(changes).length) return ds;
  const B = E.build(ds);
  if (!B) return ds;
  const rem = new Map(), add = new Map(); // account key -> [rep keys] / rep name
  for (const [rep, ch] of Object.entries(changes)) {
    for (const n of ch.remove || []) { const k = acctKey(n); if (!rem.has(k)) rem.set(k, new Set()); rem.get(k).add(repKey(rep)); }
    for (const n of ch.add || []) add.set(acctKey(n), canonRep(rep) || rep);
  }
  const extra = new Map(); // loc|rep -> names
  const put = (loc, rep, name) => { const k = loc + '|' + rep; if (!extra.has(k)) extra.set(k, { loc, rep, customers: [] }); extra.get(k).customers.push({ name }); };
  for (const { c } of B.customers({ cat: 'All' })) {
    const k = acctKey(c.customer);
    if (add.has(k) && canonRep(c.rep) !== add.get(k)) put(c.loc, add.get(k), c.customer);
    else if (rem.has(k) && rem.get(k).has(repKey(c.rep))) put(c.loc, 'Unassigned', c.customer);
  }
  if (!extra.size) return ds;
  return { ...ds, assign: [...(ds.assign || []), ...extra.values()] };
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
  const changes = await hubChanges();
  const hasChanges = changes && Object.keys(changes).some((r) => (changes[r].add || []).length || (changes[r].remove || []).length);
  if (who.role === 'all' && !hasChanges) return new Response(buf, { headers: head });

  const ds = applyHub(E.decode(JSON.parse(gunzipSync(Buffer.from(buf)).toString('utf8'))), changes);
  if (who.role === 'all') return new Response(gzipSync(Buffer.from(JSON.stringify(E.encode(ds)))), { headers: head });
  const mine = cut(ds, who);
  if (!mine.quotes.length) return json({ empty: true, scoped: true }, 200, viewerHeader(viewer));
  return new Response(gzipSync(Buffer.from(JSON.stringify(E.encode(mine)))), { headers: head });
};

export const config = { path: '/api/data' };
