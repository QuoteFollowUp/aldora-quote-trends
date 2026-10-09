/* Aldora Quote Trends: data engine.
   Parses the weekly Open Quotes and Closed Quotes exports, merges them with
   earlier uploads, and computes every branch, rep, product and customer view.
   No DOM access, so the same file runs in the browser and in tests. */
(function (root) {
  'use strict';

  const BRANCHES = { 'ATL GA': 'Atlanta', 'CHS SC': 'Charleston', 'CS FL': 'Coral Springs', 'LPG KY': 'Louisville', 'NN VA': 'Newport News', 'ORL FL': 'Orlando' };
  const CATS = ['Storefront', 'Insulated', 'Monolithic', 'Laminated', 'VistaView', 'TGD'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const QUOTE_RE = /^\d\d-SQ\d+$/;
  const DAY = 86400000;

  const branchName = (loc) => BRANCHES[loc] || loc;
  const clean = (x) => { if (x == null) return ''; const s = String(x).trim(); return !s || s.startsWith('{') || s.startsWith('[') ? '' : s; };
  const GENERIC = new Set(['OFFICE', 'EMAIL', 'GENERAL', 'ACCOUNTS PAYABLE', 'AP', 'SALES', 'MAIN', 'N/A', 'NA', 'NONE', 'CUSTOMER', 'COMPANY', 'PURCHASING', 'ESTIMATING', 'SHOP', 'FRONT DESK']);
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const toUS = (s) => s ? s.slice(5, 7) + '/' + s.slice(8, 10) + '/' + s.slice(0, 4) : '';
  const monthKey = (s) => s.slice(0, 7);
  const monthLabel = (mk) => MON[+mk.slice(5, 7) - 1];
  const addMonths = (mk, n) => { let y = +mk.slice(0, 4), m = +mk.slice(5, 7) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + pad(m + 1); };
  const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
  const pct = (a, b) => (a > 0 ? Math.round((b / a - 1) * 1000) / 10 : null);
  const d3sum = (a) => a.reduce((s, v) => s + v, 0);

  // ---- Excel cell to YYYY-MM-DD (serial numbers, Date objects or text)
  function cellDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') {
      if (v < 20000 || v > 80000) return '';
      const d = new Date(Math.round((v - 25569) * DAY));
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    if (v instanceof Date) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
    return '';
  }
  const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[$,]/g, '')); return isFinite(n) ? n : 0; };

  // ---- Identify and parse one sheet given as an array of row objects (header names as keys)
  function detect(rows) {
    const h = rows.length ? Object.keys(rows[0]) : [];
    if (h.includes('OrderNumber') && h.includes('Insulated') && h.includes('OrderTotal')) return 'open';
    if (h.includes('OrderNumber') && h.includes('ClosedDate')) return 'closed';
    return null;
  }
  function parseOpen(rows) {
    const out = [];
    for (const r of rows) {
      const ord = String(r.OrderNumber == null ? '' : r.OrderNumber).trim();
      const site = String(r.SiteName == null ? '' : r.SiteName).trim();
      if (!QUOTE_RE.test(ord) || !site || site === 'TEST SITE 1') continue;
      const date = cellDate(r.Date);
      if (!date) continue;
      let mask = 0;
      CATS.forEach((c, i) => { if (num(r[c]) > 0) mask |= 1 << i; });
      out.push({
        loc: String(r.LocationID).trim(), ord, date, site,
        contact: clean(r.OrderContact) || clean(r.GenAddrContactName),
        phone: clean(r.GenAddrPhoneNumber),
        rep: clean(r.Salesperson) || 'Unassigned',
        total: Math.round(num(r.OrderTotal) * 100) / 100, mask,
      });
    }
    return out;
  }
  function parseClosed(rows) {
    const out = [];
    for (const r of rows) {
      const ord = String(r.OrderNumber == null ? '' : r.OrderNumber).trim();
      if (!QUOTE_RE.test(ord)) continue;
      out.push({ loc: String(r.LocationID).trim(), ord, status: clean(r['Order/Quote Close Status']) || clean(r.ClosedReason) });
    }
    return out;
  }

  // ---- Compact storage format (keeps the saved file small)
  function dict() { const list = [], idx = new Map(); return { list, id: (s) => { s = s || ''; if (!idx.has(s)) { idx.set(s, list.length); list.push(s); } return idx.get(s); } }; }
  function encode(ds) {
    const S = dict();
    const q = { l: [], o: [], d: [], s: [], c: [], p: [], r: [], t: [], m: [] };
    for (const x of ds.quotes) {
      q.l.push(S.id(x.loc)); q.o.push(x.ord); q.d.push(dayNum(x.date)); q.s.push(S.id(x.site)); q.c.push(S.id(x.contact));
      q.p.push(S.id(x.phone)); q.r.push(S.id(x.rep)); q.t.push(x.total); q.m.push(x.mask);
    }
    const x = { l: [], o: [], s: [] };
    for (const c of ds.closed) { x.l.push(S.id(c.loc)); x.o.push(c.ord); x.s.push(S.id(c.status)); }
    return { v: 1, updated: ds.updated, uploads: ds.uploads, strings: S.list, q, x };
  }
  function decode(enc) {
    if (!enc || enc.v !== 1) return { quotes: [], closed: [], uploads: [], updated: null };
    const S = enc.strings, q = enc.q, x = enc.x;
    const quotes = q.o.map((ord, i) => {
      const dt = new Date(q.d[i] * DAY);
      return { loc: S[q.l[i]], ord, date: ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()), site: S[q.s[i]], contact: S[q.c[i]], phone: S[q.p[i]], rep: S[q.r[i]], total: q.t[i], mask: q.m[i] };
    });
    const closed = x.o.map((ord, i) => ({ loc: S[x.l[i]], ord, status: S[x.s[i]] }));
    return { quotes, closed, uploads: enc.uploads || [], updated: enc.updated };
  }

  // ---- Merge new files into the saved data. Later open files win for the same quote.
  // Quotes that leave the open report (closed since) keep their last known details.
  function merge(existing, openFiles, closedFiles, note) {
    const map = new Map();
    for (const qq of existing.quotes) map.set(qq.loc + '|' + qq.ord, qq);
    let added = 0, updated = 0;
    const sorted = openFiles.slice().sort((a, b) => (a.maxDate < b.maxDate ? -1 : 1));
    for (const f of sorted) for (const qq of f.rows) { const k = qq.loc + '|' + qq.ord; if (map.has(k)) updated++; else added++; map.set(k, qq); }
    const cmap = new Map();
    for (const c of existing.closed) cmap.set(c.loc + '|' + c.ord, c);
    for (const f of closedFiles) for (const c of f.rows) cmap.set(c.loc + '|' + c.ord, c);
    let quotes = [...map.values()];
    const maxDate = quotes.reduce((m, x) => (x.date > m ? x.date : m), '');
    const keepFrom = maxDate ? addMonths(monthKey(maxDate), -17) + '-01' : '';
    quotes = quotes.filter((x) => x.date >= keepFrom);
    const uploads = (existing.uploads || []).concat([{ at: new Date().toISOString(), files: note || [], added, updated, quotes: quotes.length, closed: cmap.size, through: maxDate }]).slice(-60);
    return { ds: { quotes, closed: [...cmap.values()], uploads, updated: new Date().toISOString() }, added, updated };
  }

  // ---- Everything the dashboard shows, computed once per load
  function build(ds) {
    const quotes = ds.quotes.filter((x) => BRANCHES[x.loc]);
    if (!quotes.length) return null;
    const asOf = quotes.reduce((m, x) => (x.date > m ? x.date : m), '');
    const asOfMonth = monthKey(asOf);
    const lastDay = new Date(Date.UTC(+asOf.slice(0, 4), +asOf.slice(5, 7), 0)).getUTCDate();
    const asOfComplete = +asOf.slice(8, 10) >= lastDay - 1;
    const firstMonth = quotes.reduce((m, x) => (monthKey(x.date) < m ? monthKey(x.date) : m), asOfMonth);
    const months = [];
    for (let mk = asOfMonth, i = 0; i < 13 && mk >= firstMonth; i++, mk = addMonths(mk, -1)) months.unshift(mk);
    const mIndex = new Map(months.map((m, i) => [m, i]));
    const lastFull = asOfComplete ? months.length - 1 : months.length - 2;
    const recent = [lastFull - 2, lastFull - 1, lastFull].filter((i) => i >= 0);
    const prior = recent.map((i) => i - 3).filter((i) => i >= 0);
    const rng = (ix) => ix.length ? monthLabel(months[ix[0]]) + (ix.length > 1 ? '–' + monthLabel(months[ix[ix.length - 1]]) : '') : '';
    const W = {
      months, labels: months.map(monthLabel), asOf, asOfUS: toUS(asOf), partial: !asOfComplete,
      recent, prior, recentLabel: rng(recent), priorLabel: rng(prior),
      lastFull, lastFullLabel: months[lastFull] ? monthLabel(months[lastFull]) : '', prevFullLabel: months[lastFull - 1] ? monthLabel(months[lastFull - 1]) : '',
      firstUS: toUS(months[0] + '-01'),
    };
    const qs = [];
    for (const x of quotes) { const mi = mIndex.get(monthKey(x.date)); if (mi != null) qs.push({ ...x, mi, branch: branchName(x.loc), cust: x.site }); }
    const cutoff = dayNum(asOf) - 60;

    // Branch start month: first month with 20+ quotes
    const bStart = {};
    for (const b of Object.values(BRANCHES)) {
      const cnt = months.map(() => 0); qs.forEach((x) => { if (x.branch === b) cnt[x.mi]++; });
      const i = cnt.findIndex((n) => n >= 20); bStart[b] = i < 0 ? months.length : i;
    }

    // Customers: dominant rep, latest contact and phone, last three quotes, product mix
    // Contact names used on many different customers are Aldora staff (who entered the quote), not the customer's contact
    const nameUse = new Map();
    for (const x of qs) if (x.contact) { const k = x.contact.toUpperCase(); if (!nameUse.has(k)) nameUse.set(k, new Set()); nameUse.get(k).add(x.branch + '|' + x.cust); }
    const goodContact = (n) => { const k = n.toUpperCase(); return !GENERIC.has(k) && !k.includes('COMPANY') && (nameUse.get(k) || new Set()).size <= 25; };
    const custMap = new Map();
    const sortedQ = qs.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const x of sortedQ) {
      const k = x.branch + '|' + x.cust;
      let c = custMap.get(k);
      if (!c) { c = { key: k, branch: x.branch, customer: x.cust, reps: new Map(), contact: '', phone: '', quotes: [] }; custMap.set(k, c); }
      c.reps.set(x.rep, (c.reps.get(x.rep) || 0) + 1);
      if (x.contact && goodContact(x.contact)) c.contact = x.contact;
      if (x.phone) c.phone = x.phone;
      c.quotes.push(x);
    }
    const custs = [...custMap.values()];
    for (const c of custs) {
      c.rep = [...c.reps.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      const pc = CATS.map((cat, i) => [cat, c.quotes.filter((x) => x.mask & (1 << i)).length]).filter((p) => p[1] > 0).sort((a, b) => b[1] - a[1]);
      c.products = pc.map((p) => p[0] + ' (' + p[1] + ')').join(', ') || 'Other';
      c.recentQuotes = c.quotes.slice(-3).reverse().map((x) => ({ date: toUS(x.date), quote: x.ord, total: x.total, products: CATS.filter((cat, i) => x.mask & (1 << i)).join(' + ') || 'Other' }));
    }
    // Rep groups per branch: home branch, or 5%+ of the branch's quotes
    const repBranch = new Map(), branchTot = new Map();
    for (const c of custs) { const n = c.quotes.length; const k = c.rep + '|' + c.branch; repBranch.set(k, (repBranch.get(k) || 0) + n); branchTot.set(c.branch, (branchTot.get(c.branch) || 0) + n); }
    const home = new Map();
    for (const [k, n] of repBranch) { const [rep, b] = k.split('|'); if (rep === 'Unassigned') continue; if (!home.has(rep) || n > home.get(rep)[1]) home.set(rep, [b, n]); }
    const groupOf = (rep, b) => rep === 'Unassigned' || (home.get(rep) || [])[0] === b || (repBranch.get(rep + '|' + b) || 0) / (branchTot.get(b) || 1) >= 0.05 ? rep : 'Other branch reps';
    for (const c of custs) { c.repGroup = groupOf(c.rep, c.branch); c.repKey = c.branch + '|' + c.repGroup; }
    const custRep = new Map(custs.map((c) => [c.key, c]));
    for (const x of qs) { const c = custRep.get(x.branch + '|' + x.cust); x.rep = c.rep; x.repKey = c.repKey; }

    // Customer stats per product ('All' plus each category)
    function stats(c, catIdx) {
      const list = catIdx < 0 ? c.quotes : c.quotes.filter((x) => x.mask & (1 << catIdx));
      if (!list.length) return null;
      const m = months.map(() => 0); list.forEach((x) => m[x.mi]++);
      const sum = (ix) => ix.reduce((s, i) => s + m[i], 0);
      const rec = sum(recent), pri = sum(prior);
      const start = bStart[c.branch] || 0;
      const base = [];
      for (let i = (recent[0] || 0) - 6; i < (recent[0] || 0); i++) if (i >= 0 && i >= start) base.push(i);
      const baseN = sum(base), baseAvg = base.length ? baseN / base.length : 0, recAvg = recent.length ? rec / recent.length : 0;
      const first = list[0].date, last = list[list.length - 1].date;
      let st;
      if (recent.length && first >= months[recent[0]] + '-01' && dayNum(first) >= dayNum(months[Math.min(start, months.length - 1)] + '-01') + 45) st = 'New';
      else if (dayNum(last) < cutoff) st = list.length >= 3 ? 'Dropped off' : 'Light, inactive';
      else if (baseN >= 3 && recAvg <= 0.75 * baseAvg) st = 'Slowing';
      else if (baseN >= 3 && recAvg >= 1.25 * baseAvg) st = 'Growing';
      else if (list.length < 4) st = 'Occasional';
      else st = 'Steady';
      return { m, recent: rec, prior: pri, change: rec - pri, last: toUS(last), lastISO: last, daysSince: Math.round(dayNum(asOf) - dayNum(last)), status: st, lastTotal: list[list.length - 1].total };
    }
    for (const c of custs) { c.stats = { All: stats(c, -1) }; CATS.forEach((cat, i) => { c.stats[cat] = stats(c, i); }); }

    // Closed quotes missing from the open log: count them in the month written, using each branch's quote number ranges
    const have = new Set(quotes.map((x) => x.loc + '|' + x.ord));
    const ordNum = (o) => +o.slice(o.indexOf('SQ') + 2);
    const bounds = {};
    for (const loc of Object.keys(BRANCHES)) {
      const per = months.map(() => []);
      qs.forEach((x) => { if (x.loc === loc) per[x.mi].push(ordNum(x.ord)); });
      const qtl = per.map((a) => { if (a.length < 5) return null; a.sort((p, q) => p - q); return [a[Math.floor(a.length * 0.01)], a[Math.min(a.length - 1, Math.floor(a.length * 0.99))]]; });
      const b = [];
      qtl.forEach((r, i) => { if (!r) return; b.push({ i, lo: r[0], hi: r[1] }); });
      bounds[loc] = b;
    }
    const closedM = {};
    for (const c of ds.closed) {
      if (!BRANCHES[c.loc] || have.has(c.loc + '|' + c.ord)) continue;
      const b = bounds[c.loc]; if (!b || !b.length) continue;
      const n = ordNum(c.ord);
      if (n < b[0].lo - 200 || n > b[b.length - 1].hi + 200) continue;
      let mi = b[b.length - 1].i;
      for (let j = 0; j < b.length; j++) { const upper = j < b.length - 1 ? (b[j].hi + b[j + 1].lo) / 2 : Infinity; if (n < upper) { mi = b[j].i; break; } }
      const br = branchName(c.loc);
      (closedM[br] = closedM[br] || months.map(() => 0))[mi]++;
    }
    const closedCount = Object.values(closedM).reduce((s, a) => s + a.reduce((p, q) => p + q, 0), 0);

    // Volume for any filter: months, closed months, customers quoting, quarter-style windows
    function volume({ branch, cat, rep, repKey }) {
      const ci = CATS.indexOf(cat);
      const logged = months.map(() => 0), cs = months.map(() => new Set());
      const single = branch && branch !== 'All branches';
      // Same-branch series for the year trend: only branches live since the first month, so a new branch does not read as growth
      const sameLog = months.map(() => 0);
      for (const x of qs) {
        if (single && x.branch !== branch) continue;
        if (rep && x.rep !== rep) continue;
        if (repKey && x.repKey !== repKey) continue;
        if (ci >= 0 && !(x.mask & (1 << ci))) continue;
        logged[x.mi]++; cs[x.mi].add(x.branch + '|' + x.cust);
        if (single || !bStart[x.branch]) sameLog[x.mi]++;
      }
      const useClosed = cat === 'All' && !rep && !repKey;
      const closed = months.map((_, i) => (useClosed ? (single ? (closedM[branch] || [])[i] || 0 : Object.values(closedM).reduce((s, a) => s + a[i], 0)) : 0));
      const sameClosed = months.map((_, i) => (useClosed ? (single ? closed[i] : Object.entries(closedM).reduce((s, [b, a]) => s + (bStart[b] ? 0 : a[i]), 0)) : 0));
      const total = logged.map((n, i) => n + closed[i]);
      const sum = (ix) => ix.reduce((s, i) => s + total[i], 0);
      const r = { logged, closed, total, cust: cs.map((s) => s.size), recent: sum(recent), prior: sum(prior) };
      r.change = pct(r.prior, r.recent);
      r.lastVsPrev = lastFull > 0 ? pct(total[lastFull - 1], total[lastFull]) : null;
      r.lastMonth = lastFull >= 0 ? total[lastFull] : 0;
      r.yoy = lastFull >= 12 ? pct(total[lastFull - 12], total[lastFull]) : null;
      // Year trend: straight line fitted through the full months since the branch started; % change from start to end of the line
      const start = single ? bStart[branch] || 0 : 0;
      const ys = [];
      for (let i = Math.max(start, lastFull - 11); i <= lastFull; i++) ys.push(sameLog[i] + sameClosed[i]);
      r.trend = null; r.trendFrom = '';
      if (ys.length >= 4 && d3sum(ys) >= 12) {
        const n = ys.length, mx = (n - 1) / 2, my = d3sum(ys) / n;
        let num = 0, den = 0; ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) * (i - mx); });
        const slope = num / den, a = my - slope * mx, b0 = a, b1 = a + slope * (n - 1);
        r.trend = b0 > 0 ? Math.max(-100, Math.round((Math.max(0, b1) / b0 - 1) * 1000) / 10) : null;
        r.trendFrom = monthLabel(months[lastFull - n + 1]);
      }
      r.custLast = lastFull >= 0 ? r.cust[lastFull] : 0;
      r.any = total.some((n) => n > 0);
      return r;
    }
    function customers({ branch, cat, rep, repKey }) {
      const out = [];
      for (const c of custs) {
        if (branch && branch !== 'All branches' && c.branch !== branch) continue;
        if (rep && c.rep !== rep) continue;
        if (repKey && c.repKey !== repKey) continue;
        const s = c.stats[cat || 'All']; if (!s) continue;
        out.push({ c, s });
      }
      return out;
    }
    const statusCounts = (list) => { const o = { 'Dropped off': 0, Slowing: 0, New: 0, Growing: 0 }; list.forEach((x) => { if (o[x.s.status] != null) o[x.s.status]++; }); return o; };
    const repNames = [...new Set(custs.map((c) => c.rep))].filter((r) => r !== 'Unassigned' && qs.filter((x) => x.rep === r).length >= 20).sort();
    const repGroups = (branch) => {
      const keys = new Map();
      for (const c of custs) if (!branch || branch === 'All branches' || c.branch === branch) { if (!keys.has(c.repKey)) keys.set(c.repKey, { key: c.repKey, branch: c.branch, rep: c.repGroup, reps: new Set() }); keys.get(c.repKey).reps.add(c.rep); }
      return [...keys.values()];
    };
    const homeOf = (rep) => (home.get(rep) || [])[0] || null;
    return { W, volume, customers, statusCounts, repNames, repGroups, homeOf, branches: Object.values(BRANCHES), bStart, closedCount, quoteCount: qs.length };
  }

  root.QuoteEngine = { BRANCHES, CATS, detect, parseOpen, parseClosed, encode, decode, merge, build, toUS, pct };
})(typeof window !== 'undefined' ? window : globalThis);
