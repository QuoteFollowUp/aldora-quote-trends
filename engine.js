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
    if (h.includes('Customer') && h.includes('Quote #') && h.includes('Amount') && h.includes('Facility')) return 'log';
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
        loc: String(r.LocationID).trim(), ord, date, site, cid: clean(r.CustomerID).toUpperCase(),
        contact: clean(r.OrderContact) || clean(r.GenAddrContactName),
        phone: clean(r.GenAddrPhoneNumber),
        rep: clean(r.Salesperson) || 'Unassigned',
        total: Math.round(num(r.OrderTotal) * 100) / 100, mask,
      });
    }
    return out;
  }
  // Open Quotes export from the Call Log / Quote Follow-Up app: Customer, Job/Project, Quote #, Amount, Date (Jul 2, 2026), Rep, Facility, Contact, Product ("Storefront $2,141,226, VistaView $791,711")
  const PREFIX_LOC = { '11': 'CHS SC', '21': 'CS FL', '23': 'ORL FL', '25': 'LPG KY', '26': 'ATL GA', '27': 'NN VA' };
  const FAC_LOC = { 'CHS SC': 'CHS SC', CHARLESTON: 'CHS SC', 'CS FL': 'CS FL', 'CORAL SPRINGS': 'CS FL', 'ORL FL': 'ORL FL', ORLANDO: 'ORL FL', 'LPG KY': 'LPG KY', LOUISVILLE: 'LPG KY', 'ATL GA': 'ATL GA', ATLANTA: 'ATL GA', 'NN VA': 'NN VA', 'NEWPORT NEWS': 'NN VA' };
  const LOC_PREFIX = Object.fromEntries(Object.entries(PREFIX_LOC).map(([p, l]) => [l, p]));
  const MONTHS3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function logDate(v) {
    if (typeof v === 'number' || v instanceof Date) return cellDate(v);
    const s = String(v || '').trim(), m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m && MONTHS3[m[1].toLowerCase()]) return ymd(+m[3], MONTHS3[m[1].toLowerCase()], +m[2]);
    return cellDate(s);
  }
  // "Freeman, Jordan" -> "Jordan Freeman"
  const firstLast = (n) => { const m = String(n || '').match(/^\s*([^,]+),\s*([^,]+?)\s*$/); return m ? m[2] + ' ' + m[1] : String(n || '').trim(); };
  function parseLog(rows) {
    const out = [], skipped = { noDate: 0, verbal: 0, badNumber: 0 };
    for (const r of rows) {
      const site = String(r.Customer == null ? '' : r.Customer).trim();
      if (!site || site === 'TEST SITE 1') continue;
      const raw = String(r['Quote #'] == null ? '' : r['Quote #']).trim().toUpperCase();
      if (/^V-/.test(raw)) { skipped.verbal++; continue; }
      const facLoc = FAC_LOC[String(r.Facility || '').trim().toUpperCase()] || '';
      // 21-SQ84148, 21 SQ 50800 REV 3, 21SQ-4628, SQ73913, 60677
      const m = raw.replace(/\s*REV\s*\d*\s*$/, '').match(/^(?:(\d\d)\s*-?\s*)?(?:SQ)?\s*-?\s*(\d{3,})\.?$/);
      const loc = (m && m[1] && PREFIX_LOC[m[1]]) || facLoc;
      if (!m || !loc) { skipped.badNumber++; continue; }
      const date = logDate(r.Date);
      if (!date) { skipped.noDate++; continue; }
      const ord = ((m[1] && PREFIX_LOC[m[1]]) ? m[1] : LOC_PREFIX[loc]) + '-SQ' + m[2];
      const prod = String(r.Product || '');
      let mask = 0;
      CATS.forEach((c, i) => { if (new RegExp('\\b' + c + '\\b', 'i').test(prod)) mask |= 1 << i; });
      const contact = clean(r.Contact);
      out.push({
        loc, ord, date, site, cid: '',
        contact: /^(none identified|company.*)$/i.test(contact) ? '' : contact,
        phone: '', rep: firstLast(clean(r.Rep)) || 'Unassigned',
        total: Math.round(num(r.Amount) * 100) / 100, mask,
      });
    }
    out.skipped = skipped;
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
    const q = { l: [], o: [], d: [], s: [], c: [], p: [], r: [], t: [], m: [], k: [] };
    for (const x of ds.quotes) {
      q.l.push(S.id(x.loc)); q.o.push(x.ord); q.d.push(dayNum(x.date)); q.s.push(S.id(x.site)); q.c.push(S.id(x.contact));
      q.p.push(S.id(x.phone)); q.r.push(S.id(x.rep)); q.t.push(x.total); q.m.push(x.mask); q.k.push(S.id(x.cid || ''));
    }
    const x = { l: [], o: [], s: [] };
    for (const c of ds.closed) { x.l.push(S.id(c.loc)); x.o.push(c.ord); x.s.push(S.id(c.status)); }
    return { v: 1, updated: ds.updated, uploads: ds.uploads, assign: ds.assign || [], strings: S.list, q, x };
  }
  function decode(enc) {
    if (!enc || enc.v !== 1) return { quotes: [], closed: [], uploads: [], assign: [], updated: null };
    const S = enc.strings, q = enc.q, x = enc.x;
    const quotes = q.o.map((ord, i) => {
      const dt = new Date(q.d[i] * DAY);
      return { loc: S[q.l[i]], ord, date: ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()), site: S[q.s[i]], contact: S[q.c[i]], phone: S[q.p[i]], rep: S[q.r[i]], total: q.t[i], mask: q.m[i], cid: q.k ? S[q.k[i]] || '' : '' };
    });
    const closed = x.o.map((ord, i) => ({ loc: S[x.l[i]], ord, status: S[x.s[i]] }));
    return { quotes, closed, uploads: enc.uploads || [], assign: enc.assign || [], updated: enc.updated };
  }

  // ---- Merge new files into the saved data. Later open files win for the same quote.
  // Quotes that leave the open report (closed since) keep their last known details.
  function merge(existing, openFiles, closedFiles, note) {
    const map = new Map();
    for (const qq of existing.quotes) map.set(qq.loc + '|' + qq.ord, qq);
    let added = 0, updated = 0;
    const sorted = openFiles.slice().sort((a, b) => (a.maxDate < b.maxDate ? -1 : 1));
    for (const f of sorted) for (const qq of f.rows) {
      const k = qq.loc + '|' + qq.ord, prev = map.get(k);
      if (prev) { updated++; map.set(k, { ...qq, site: prev.site || qq.site, cid: qq.cid || prev.cid, contact: qq.contact || prev.contact, phone: qq.phone || prev.phone, mask: qq.mask || prev.mask, rep: qq.rep && qq.rep !== 'Unassigned' ? qq.rep : prev.rep }); }
      else { added++; map.set(k, qq); }
    }
    const cmap = new Map();
    for (const c of existing.closed) cmap.set(c.loc + '|' + c.ord, c);
    for (const f of closedFiles) for (const c of f.rows) cmap.set(c.loc + '|' + c.ord, c);
    let quotes = [...map.values()];
    const maxDate = quotes.reduce((m, x) => (x.date > m ? x.date : m), '');
    const keepFrom = maxDate ? addMonths(monthKey(maxDate), -25) + '-01' : '';
    quotes = quotes.filter((x) => x.date >= keepFrom);
    const uploads = (existing.uploads || []).concat([{ at: new Date().toISOString(), files: note || [], added, updated, quotes: quotes.length, closed: cmap.size, through: maxDate }]).slice(-60);
    return { ds: { quotes, closed: [...cmap.values()], uploads, assign: existing.assign || [], updated: new Date().toISOString() }, added, updated };
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
    // Leave out leading months the uploads only partly cover (fewer than half the typical month), so they don't read as growth
    let trimmed = '';
    {
      const cnt = new Map(months.map((m) => [m, 0]));
      for (const x of quotes) { const m = monthKey(x.date); if (cnt.has(m)) cnt.set(m, cnt.get(m) + 1); }
      const full = months.slice(0, asOfComplete ? months.length : months.length - 1).map((m) => cnt.get(m)).sort((p, q) => p - q);
      const med = full.length ? full[Math.floor(full.length / 2)] : 0;
      let cut = 0;
      while (cut < months.length - 1 && cnt.get(months[cut]) < 0.5 * med) cut++;
      if (cut > 0) { trimmed = monthLabel(months[0]) + ' ' + months[0].slice(0, 4) + ' to ' + monthLabel(months[cut - 1]) + ' ' + months[cut - 1].slice(0, 4); months.splice(0, cut); }
    }
    const mIndex = new Map(months.map((m, i) => [m, i]));
    const lastFull = asOfComplete ? months.length - 1 : months.length - 2;
    const recent = [lastFull - 2, lastFull - 1, lastFull].filter((i) => i >= 0);
    const prior = recent.map((i) => i - 3).filter((i) => i >= 0);
    const rng = (ix) => ix.length ? monthLabel(months[ix[0]]) + (ix.length > 1 ? '–' + monthLabel(months[ix[ix.length - 1]]) : '') : '';
    const W = {
      months, labels: months.map(monthLabel), asOf, asOfUS: toUS(asOf), partial: !asOfComplete,
      recent, prior, recentLabel: rng(recent), priorLabel: rng(prior),
      lastFull, lastFullLabel: months[lastFull] ? monthLabel(months[lastFull]) : '', prevFullLabel: months[lastFull - 1] ? monthLabel(months[lastFull - 1]) : '',
      firstUS: toUS(months[0] + '-01'), trimmed,
    };
    const qs = [];
    for (const x of quotes) { const mi = mIndex.get(monthKey(x.date)); if (mi != null) qs.push({ ...x, mi, branch: branchName(x.loc), cust: x.site }); }
    for (const x of qs) if (x.rep && x.rep.includes(',')) x.rep = firstLast(x.rep);
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
    // Rep assignments a manager saved (account lists): branch + customer number (or name) -> rep. They override the ERP rep.
    const assignMap = new Map();
    for (const a of ds.assign || []) for (const c of a.customers || []) {
      if (c.id) assignMap.set(a.loc + '|' + String(c.id).toUpperCase(), a.rep);
      if (c.name) assignMap.set(a.loc + '|N:' + String(c.name).trim().toUpperCase(), a.rep);
    }
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
    const RO0 = root.QT_ROSTER, rosterKey = (n) => String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|co|corp|ltd|the|company|incorporated)\b/g, ' ').replace(/\s+/g, ' ').trim();
    let RO = null;
    if (RO0 && RO0.lists) {
      RO = { reps: new Set(Object.keys(RO0.lists)), aliases: RO0.aliases || {}, byCust: new Map() };
      for (const [rep, list] of Object.entries(RO0.lists)) for (const n of list) { const k = rosterKey(n); if (!RO.byCust.has(k)) RO.byCust.set(k, []); if (!RO.byCust.get(k).includes(rep)) RO.byCust.get(k).push(rep); }
    }
    // Quotes per rep per branch, to break ties when two reps list the same customer
    const brCount = new Map(); for (const x of qs) { const r = (RO && RO.aliases[x.rep]) || x.rep, k = r + '|' + x.branch; brCount.set(k, (brCount.get(k) || 0) + 1); }
    for (const c of custs) {
      // A quote with no salesperson never outvotes a named rep
      const named = [...c.reps.entries()].filter((e) => e[0] !== 'Unassigned');
      c.rep = (named.length ? named : [...c.reps.entries()]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      c.loc = c.quotes[0].loc;
      c.cid = (c.quotes.slice().reverse().find((x) => x.cid) || {}).cid || '';
      const ov = assignMap.get(c.loc + '|' + c.cid) || assignMap.get(c.loc + '|N:' + c.customer.toUpperCase());
      if (ov) { c.erpRep = c.rep; c.rep = ov; }
      // Current reps only (Quote Trends display). A customer quoted under a former rep, staff member or Unassigned goes to the rep whose list has it.
      if (!ov && RO) {
        const al = RO.aliases[c.rep]; if (al) c.rep = al;
        if (!RO.reps.has(c.rep)) {
          const cands = RO.byCust.get(rosterKey(c.customer));
          if (cands && cands.length) { c.erpRep = c.rep; c.rep = cands.length === 1 ? cands[0] : cands.slice().sort((a, b) => (brCount.get(b + '|' + c.branch) || 0) - (brCount.get(a + '|' + c.branch) || 0))[0]; c.moved = true; }
          else { c.erpRep = c.rep; c.rep = 'Unassigned'; }
        }
      }
      const pc = CATS.map((cat, i) => [cat, c.quotes.filter((x) => x.mask & (1 << i)).length]).filter((p) => p[1] > 0).sort((a, b) => b[1] - a[1]);
      c.products = pc.map((p) => p[0] + ' (' + p[1] + ')').join(', ') || 'Other';
      c.recentQuotes = c.quotes.slice(-3).reverse().map((x) => ({ date: toUS(x.date), quote: x.ord, total: x.total, products: CATS.filter((cat, i) => x.mask & (1 << i)).join(' + ') || 'Other' }));
    }
    // Same month last year, per customer: quote count and dollars for the 12 months before each month shown
    const lyIdx = new Map(months.map((m, i) => [addMonths(m, -12), i]));
    const lyHave = months.map(() => 0);
    for (const x of quotes) {
      const i = lyIdx.get(monthKey(x.date)); if (i == null) continue;
      const br = branchName(x.loc); lyHave[i]++;
      const c = custMap.get(br + '|' + x.site); if (!c) continue;
      if (!c.ly) c.ly = { n: months.map(() => 0), amt: months.map(() => 0) };
      c.ly.n[i]++; c.ly.amt[i] += +x.total || 0;
    }
    for (const c of custs) { c.amt = months.map(() => 0); c.quotes.forEach((x) => { c.amt[x.mi] += +x.total || 0; }); }
    W.lyHave = lyHave.map((n) => n >= 20);
    // One customer across every branch, by name: this year and last year by month
    const nameKey = (n) => String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(inc|llc|co|corp|ltd|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const byName = new Map(), lyBr = {};
    const zero = () => months.map(() => 0);
    for (const x of quotes) {
      const mk = monthKey(x.date), ti = mIndex.get(mk), li = lyIdx.get(mk);
      if (ti == null && li == null) continue;
      const k = nameKey(x.site) + '|' + branchName(x.loc); let e = byName.get(k);
      if (!e) { e = { n: zero(), amt: zero(), lyN: zero(), lyAmt: zero(), br: {} }; byName.set(k, e); }
      const br = branchName(x.loc), t = +x.total || 0;
      if (li != null) { if (!lyBr[br]) lyBr[br] = zero(); lyBr[br][li]++; }
      if (!e.br[br]) e.br[br] = { ty: 0, ly: 0 };
      if (ti != null) { e.n[ti]++; e.amt[ti] += t; e.br[br].ty++; }
      if (li != null) { e.lyN[li]++; e.lyAmt[li] += t; e.br[br].ly++; }
    }
    // Sum the given branches (all branches when none given)
    W.yoy = (name, branches) => {
      const nk = nameKey(name), out = { n: zero(), amt: zero(), lyN: zero(), lyAmt: zero(), br: {} }; let any = false;
      for (const [k, e] of byName) {
        const cut = k.lastIndexOf('|'), kn = k.slice(0, cut), kb = k.slice(cut + 1);
        if (kn !== nk || (branches && !branches.includes(kb))) continue;
        any = true; out.br[kb] = { ty: e.br[kb].ty, ly: e.br[kb].ly };
        for (const f of ['n', 'amt', 'lyN', 'lyAmt']) e[f].forEach((v, i) => { out[f][i] += v; });
      }
      // Last year counts only where one of these branches had quotes loaded for that month
      const bl = Object.keys(out.br);
      out.have = months.map((_, i) => bl.some((b) => (lyBr[b] || [])[i] >= 20));
      return any ? out : null;
    };
    W.nameKey = nameKey;
    W.lyLabels = months.map((m) => monthLabel(m) + ' ' + addMonths(m, -12).slice(2, 4));
    W.tyLabels = months.map((m) => monthLabel(m) + ' ' + m.slice(2, 4));
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
    function volume({ branch, cat, rep, repKey, reps }) {
      const ci = CATS.indexOf(cat);
      const logged = months.map(() => 0), cs = months.map(() => new Set());
      const single = branch && branch !== 'All branches';
      // Same-branch series for the year trend: only branches live since the first month, so a new branch does not read as growth
      const sameLog = months.map(() => 0);
      for (const x of qs) {
        if (single && x.branch !== branch) continue;
        if (rep && x.rep !== rep) continue;
        if (reps && !reps.has(x.rep)) continue;
        if (repKey && x.repKey !== repKey) continue;
        if (ci >= 0 && !(x.mask & (1 << ci))) continue;
        logged[x.mi]++; cs[x.mi].add(x.branch + '|' + x.cust);
        if (single || !bStart[x.branch]) sameLog[x.mi]++;
      }
      const useClosed = cat === 'All' && !rep && !repKey && !reps;
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
    // Same customer, same rep at more than one facility: one combined row (all-branch views)
    const merged = (() => {
      const nk = W.nameKey, groups = new Map();
      for (const c of custs) { const k = nk(c.customer) + '|' + c.rep; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
      const out = [];
      for (const [k, g] of groups) {
        if (g.length === 1) { out.push(g[0]); continue; }
        g.sort((a, b) => b.quotes.length - a.quotes.length);
        const p = g[0], quotes = g.flatMap((c) => c.quotes).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const m = { ...p, key: 'M|' + k, quotes, members: g, branches: [...new Set(g.map((c) => c.branch))], branchLabel: [...new Set(g.map((c) => c.branch))].join(' + '),
          contact: p.contact || (g.find((c) => c.contact) || {}).contact || '', phone: p.phone || (g.find((c) => c.phone) || {}).phone || '' };
        const pc = CATS.map((cat, i) => [cat, quotes.filter((x) => x.mask & (1 << i)).length]).filter((q) => q[1] > 0).sort((a, b) => b[1] - a[1]);
        m.products = pc.map((q) => q[0] + ' (' + q[1] + ')').join(', ') || 'Other';
        m.recentQuotes = quotes.slice(-3).reverse().map((x) => ({ date: toUS(x.date), quote: x.ord, total: x.total, products: CATS.filter((cat, i) => x.mask & (1 << i)).join(' + ') || 'Other' }));
        m.amt = months.map(() => 0); quotes.forEach((x) => { m.amt[x.mi] += +x.total || 0; });
        // Earliest branch start, so a long-running branch sets the baseline
        m.branch = g.slice().sort((a, b) => (bStart[a.branch] || 0) - (bStart[b.branch] || 0))[0].branch;
        m.stats = { All: stats(m, -1) }; CATS.forEach((cat, i) => { m.stats[cat] = stats(m, i); });
        m.branch = p.branch;
        out.push(m);
      }
      return out;
    })();
    function customers({ branch, cat, rep, repKey, reps }) {
      const out = [];
      const all = !branch || branch === 'All branches';
      for (const c of all ? merged : custs) {
        if (branch && branch !== 'All branches' && c.branch !== branch) continue;
        if (rep && c.rep !== rep) continue;
        if (reps && !reps.has(c.rep)) continue;
        if (repKey && !(c.members ? c.members.some((x) => x.repKey === repKey) : c.repKey === repKey)) continue;
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

  // Account list: find the header row with a customer number and/or name column
  function parseAccountList(aoa) {
    const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
    let h = -1, idCol = -1, nameCol = -1;
    for (let i = 0; i < Math.min(20, aoa.length); i++) {
      const row = aoa[i].map(norm);
      const id = row.findIndex((v) => ['customer number', 'customer id', 'customerid', 'cust #', 'customer no', 'customer #'].includes(v));
      const nm = row.findIndex((v) => ['customer name', 'customer', 'sitename', 'site name', 'name'].includes(v));
      if (id >= 0 || nm >= 0) { h = i; idCol = id; nameCol = nm; break; }
    }
    if (h < 0) return null;
    const out = [];
    for (let i = h + 1; i < aoa.length; i++) {
      const id = idCol >= 0 ? String(aoa[i][idCol] == null ? '' : aoa[i][idCol]).trim() : '';
      const name = nameCol >= 0 ? String(aoa[i][nameCol] == null ? '' : aoa[i][nameCol]).trim() : '';
      if (id || name) out.push({ id, name });
    }
    return out;
  }

  root.QuoteEngine = { BRANCHES, CATS, parseAccountList, detect, parseOpen, parseLog, parseClosed, encode, decode, merge, build, toUS, pct };
})(typeof window !== 'undefined' ? window : globalThis);
