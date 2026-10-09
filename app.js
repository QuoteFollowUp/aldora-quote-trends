/* Aldora Quote Trends: dashboard. Reads the saved data, then draws every view from QuoteEngine. */
(function () {
  'use strict';
  const E = window.QuoteEngine;
  const CATS = ['All', ...E.CATS];
  const STATUSES = ['All', 'Dropped off', 'Slowing', 'Growing', 'New', 'Steady', 'Occasional', 'Light, inactive'];
  const n0 = d3.format(',');
  const money = d3.format('$,.0f');
  const pct = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + d3.format('.1f')(v) + '%');
  const dirCls = (v) => (v == null ? 'flat' : v >= 10 ? 'up' : v <= -10 ? 'down' : 'flat');
  const stCls = (s) => (s === 'Growing' || s === 'New' ? 'up' : s === 'Dropped off' || s === 'Slowing' ? 'down' : 'flat');
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const CODE_KEY = 'aqt-team-code';
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }, del: (k) => { try { localStorage.removeItem(k); } catch (e) {} } };

  let B = null, meta = null;
  const P = { branch: 'All branches', cat: 'All', rep: '' };
  let status = 'All', search = '', repKey = '', sortK = 'change', sortDir = 1;
  const picked = new Set();
  let shown = [];
  const PAGE = 250; let showAll = false;

  // ---------- access and loading
  async function load() {
    const code = store.get(CODE_KEY);
    if (!code) return showGate('');
    const res = await fetch('/api/data', { headers: { 'x-team-code': code } }).catch(() => null);
    if (!res) return fail('Could not reach the server. Check your connection and reload.');
    if (res.status === 401) { store.del(CODE_KEY); return showGate('That code did not work.'); }
    if (res.status === 404) return fail('The server functions are not running (404). In Netlify, check Deploys for a failed deploy and Logs > Functions for data and upload.');
    if (!res.ok) { const j = await res.json().catch(() => ({})); return fail('The server returned an error (' + res.status + '). ' + (j.error || 'Try again in a minute.')); }
    $('gate-err').textContent = 'Downloading the latest data...';
    const json = await res.json();
    if (json.empty) return fail('No data yet. A manager needs to upload the open and closed quote exports on the upload page.', true);
    meta = json;
    B = E.build(E.decode(json));
    if (!B) return fail('The saved data has no quotes for the Aldora branches.', true);
    $('gate').hidden = true;
    $('takeaway').textContent = 'Building the views...';
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try { initControls(); draw(); } catch (e) { $('takeaway').textContent = 'The dashboard hit an error while drawing: ' + e.message + '. Send this message to Fred.'; console.error(e); }
  }
  function showGate(msg) { $('gate').hidden = false; $('gate-err').textContent = msg; $('gate-code').focus(); }
  function fail(msg, withLink) {
    $('gate').hidden = true;
    $('takeaway').textContent = msg;
    if (withLink) { const a = document.createElement('a'); a.href = 'upload.html'; a.textContent = ' Go to the upload page.'; $('takeaway').appendChild(a); }
  }
  function showError(e) {
    console.error(e);
    $('gate-err').textContent = 'Something went wrong opening the dashboard: ' + (e && e.message ? e.message : e) + '. Send this message to Fred.';
  }
  function start() { $('gate-err').textContent = 'Opening...'; load().catch(showError); }
  $('gate-form').addEventListener('submit', (e) => { e.preventDefault(); store.set(CODE_KEY, $('gate-code').value.trim().toLowerCase()); start(); });
  $('signout').addEventListener('click', () => { store.del(CODE_KEY); location.reload(); });

  // ---------- controls
  function seg(el, items, label, onClick) {
    el.replaceChildren(...items.map((v) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label(v); b.dataset.v = v; b.addEventListener('click', () => onClick(v)); return b; }));
  }
  function initControls() {
    seg($('branch-seg'), ['All branches', ...B.branches], (v) => v, (v) => { P.branch = v; repKey = ''; draw(); });
    seg($('cat-seg'), CATS, (v) => (v === 'All' ? 'All products' : v), (v) => { P.cat = v; draw(); });
    seg($('status-seg'), STATUSES, (v) => v, (v) => { status = v; showAll = false; drawCustomers(); });
    $('top-rep').replaceChildren(new Option('All reps', ''), ...B.repNames.map((n) => new Option(n, n)));
    $('top-rep').addEventListener('change', (e) => { P.rep = e.target.value; P.branch = 'All branches'; repKey = ''; picked.clear(); draw(); });
    $('rep-select').addEventListener('change', (e) => { repKey = e.target.value; drawReps(); drawCustomers(); });
    $('cust-search').addEventListener('input', (e) => { search = e.target.value.toLowerCase(); drawCustomers(); });
    const W = B.W;
    $('window-note').textContent = 'Every quote written ' + W.firstUS + ' to ' + W.asOfUS + ', open and closed. Recent is ' + W.recentLabel + ', prior is ' + W.priorLabel + '. Up or down means a move of 10% or more.' + (W.partial ? ' ' + W.labels[W.labels.length - 1] + ' is month to date.' : '');
    const up = (meta.uploads || []).slice(-1)[0];
    $('data-note').textContent = 'Data through ' + W.asOfUS + (up ? '. Last upload ' + new Date(up.at).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '') + '. ' + n0(B.quoteCount) + ' quotes with customer detail, plus ' + n0(B.closedCount) + ' closed quotes counted by branch only. Louisville data starts in ' + (B.W.labels[B.bStart['Louisville']] || '') + ', Atlanta in ' + (B.W.labels[B.bStart['Atlanta']] || '') + '. Branches that started partway through are left out of the branch comparison in the summary line.';
  }
  const F = () => ({ branch: P.branch, cat: P.cat, rep: P.rep });

  // ---------- table helper: columns [{h, v(row), f(value,row), cls, sort}]
  function table(el, cols, rows, opts = {}) {
    const thead = document.createElement('thead'), tr = document.createElement('tr');
    cols.forEach((c) => {
      const th = document.createElement('th'); th.className = c.txt ? 'txt' : '';
      if (c.check) { th.className = 'sel'; th.appendChild(c.check); }
      else if (opts.sortable && c.key) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = c.h; b.addEventListener('click', () => opts.onSort(c.key));
        if (opts.sortK === c.key) th.setAttribute('aria-sort', opts.sortDir > 0 ? 'ascending' : 'descending');
        th.appendChild(b);
      } else th.textContent = c.h;
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    const tb = document.createElement('tbody');
    const frag = document.createDocumentFragment();
    rows.forEach((r) => {
      const row = document.createElement('tr');
      if (opts.rowClass) row.className = opts.rowClass(r) || '';
      if (opts.onRow) row.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') opts.onRow(r); });
      cols.forEach((c) => {
        const td = document.createElement('td');
        if (c.cell) c.cell(td, r, row);
        else { const v = c.v(r); td.textContent = c.f ? c.f(v, r) : v == null ? '' : v; td.className = (c.txt ? 'txt ' : '') + (c.cls ? c.cls(v, r) || '' : ''); }
        row.appendChild(td);
      });
      frag.appendChild(row);
    });
    tb.appendChild(frag);
    el.replaceChildren(thead, tb);
  }
  const monthCols = (get) => B.W.labels.map((l, i) => ({ h: l + (B.W.partial && i === B.W.labels.length - 1 ? '*' : ''), key: 'm' + i, v: (r) => get(r)[i], f: n0, cls: (v) => (v ? '' : 'zero') }));
  const windowCols = (getV) => [
    { h: B.W.priorLabel, key: 'prior', v: (r) => getV(r).prior, f: n0 },
    { h: B.W.recentLabel, key: 'recent', v: (r) => getV(r).recent, f: n0 },
    { h: 'Change', key: 'chg', v: (r) => getV(r).change, f: pct, cls: dirCls },
  ];

  // ---------- header and tiles
  function drawHeader() {
    const W = B.W, f = F(), v = B.volume(f);
    const sc = B.statusCounts(B.customers(f));
    const what = P.cat === 'All' ? 'quotes' : P.cat.toLowerCase() + ' quotes';
    $('l-recent').textContent = (P.cat === 'All' ? 'Quotes' : P.cat + ' quotes') + ', ' + W.recentLabel;
    $('l-change').textContent = 'vs ' + W.priorLabel;
    $('l-month').textContent = W.lastFullLabel + ' vs ' + W.prevFullLabel;
    $('l-cust').textContent = 'Customers quoting in ' + W.lastFullLabel;
    $('t-recent').textContent = n0(v.recent);
    $('t-change').textContent = pct(v.change); $('t-change').className = 'big ' + dirCls(v.change);
    $('t-month').textContent = pct(v.lastVsPrev); $('t-month').className = 'big ' + dirCls(v.lastVsPrev);
    $('t-cust').textContent = n0(v.custLast);
    $('t-drop').textContent = n0(sc['Dropped off']);
    const who = P.rep ? P.rep + (P.branch !== 'All branches' ? ' at ' + P.branch : '') : P.branch;
    let t;
    if (!v.any) t = who + ' has no ' + what + ' in this period.';
    else if (!P.rep && P.branch === 'All branches') {
      const rows = B.branches.map((b) => ({ b, v: B.volume({ branch: b, cat: P.cat }) })).filter((x) => x.v.prior >= 30 && (B.bStart[x.b] || 0) <= (W.prior[0] ?? 0));
      const grp = (test) => rows.filter((x) => test(x.v.change)).map((x) => x.b + ' ' + pct(x.v.change)).join(', ');
      const dn = grp((c) => c <= -5), up = grp((c) => c >= 5), fl = grp((c) => c > -5 && c < 5);
      t = (P.cat === 'All' ? 'All products' : P.cat) + ', ' + W.recentLabel + ' vs ' + W.priorLabel + '. ' + (dn ? 'Falling: ' + dn + '. ' : '') + (up ? 'Rising: ' + up + '. ' : '') + (fl ? 'Holding: ' + fl + '.' : '');
    } else t = who + ' wrote ' + n0(v.recent) + ' ' + what + ' in ' + W.recentLabel + ', ' + pct(v.change) + ' vs ' + W.priorLabel + '. ' + W.lastFullLabel + ' was ' + pct(v.lastVsPrev) + ' vs ' + W.prevFullLabel + '. ' + n0(sc['Dropped off']) + ' customers dropped off and ' + n0(sc.Slowing) + ' are slowing.';
    $('takeaway').textContent = t;
    const fn = [];
    if (P.cat !== 'All') fn.push('Showing only quotes that include ' + P.cat.toLowerCase() + '. Closed quotes are not counted here because the closed export has no line items.');
    if (P.rep) fn.push('Showing ' + P.rep + "'s customers only, in every branch they quote. Closed quotes carry no rep, so they are not counted.");
    $('filter-note').hidden = !fn.length; $('filter-note').textContent = fn.join(' ');
  }

  // ---------- trend panels and branch table
  function drawTrend() {
    const W = B.W, box = $('multi');
    box.replaceChildren();
    const repBranches = P.rep ? B.branches.filter((b) => B.volume({ branch: b, cat: 'All', rep: P.rep }).any) : B.branches.filter((b) => B.volume({ branch: b, cat: 'All' }).any);
    const single = P.branch !== 'All branches';
    $('legend').hidden = P.cat !== 'All' || !!P.rep;
    $('trend-note').textContent = single ? 'Quotes written per month. Hover a bar for the split and customers quoting.' : 'Quotes written per month. Each panel has its own scale. Click a branch to filter the page.';
    const list = single ? [P.branch] : repBranches;
    const later = [];
    list.forEach((b) => {
      const v = B.volume({ branch: b, cat: P.cat, rep: P.rep });
      if (!v.any && !single) return;
      const p = document.createElement('div'); p.className = 'panel' + (single ? ' wide' : '');
      if (!single) { p.tabIndex = 0; p.setAttribute('role', 'button'); p.setAttribute('aria-label', 'Filter to ' + b); const go = () => { P.branch = b; repKey = ''; draw(); }; p.addEventListener('click', go); p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }); }
      const h = document.createElement('div'); h.className = 'ph';
      const bt = document.createElement('b'); bt.textContent = b;
      const ch = document.createElement('span'); ch.className = 'chip ' + dirCls(v.change); ch.textContent = (single ? W.recentLabel + ' vs ' + W.priorLabel + ' ' : '') + pct(v.change); ch.title = W.recentLabel + ' vs ' + W.priorLabel;
      h.append(bt, ch); p.appendChild(h); box.appendChild(p);
      const total = d3.sum(v.total);
      if (P.cat !== 'All' && total < 20) { const lo = document.createElement('div'); lo.className = 'note'; lo.textContent = 'Only ' + total + ' ' + P.cat.toLowerCase() + ' quote' + (total === 1 ? '' : 's') + ' in this period. Blank months are zero.'; p.appendChild(lo); }
      later.push(() => {
      const Wd = Math.max(220, p.clientWidth || 260), H = single ? 210 : 130, m = { t: 18, r: 4, b: 18, l: 4 };
      const idx = W.months.map((_, i) => i);
      const x = d3.scaleBand(idx, [m.l, Wd - m.r]).padding(0.25);
      const y = d3.scaleLinear([0, d3.max(v.total) || 1], [H - m.b, m.t]);
      const svg = d3.select(p).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${Wd} ${H}`).attr('role', 'img').attr('aria-label', b + ' quotes per month');
      svg.append('line').attr('x1', m.l).attr('x2', Wd - m.r).attr('y1', H - m.b).attr('y2', H - m.b).attr('stroke', 'var(--line)');
      const tip = d3.select(p).append('div').attr('class', 'tip').style('display', 'none');
      const g = svg.selectAll('g.b').data(idx).join('g').attr('class', 'b');
      g.append('rect').attr('class', 'bar').attr('x', (i) => x(i)).attr('width', x.bandwidth()).attr('y', (i) => y(v.total[i])).attr('height', (i) => Math.max(0, y(0) - y(v.total[i]))).attr('rx', 4).attr('fill', 'var(--accent2)');
      g.append('rect').attr('class', 'bar').attr('x', (i) => x(i)).attr('width', x.bandwidth()).attr('y', (i) => y(v.logged[i])).attr('height', (i) => Math.max(0, y(0) - y(v.logged[i]))).attr('rx', 4).attr('fill', 'var(--accent)');
      g.append('rect').attr('x', (i) => x(i)).attr('width', x.bandwidth()).attr('y', m.t).attr('height', H - m.b - m.t).attr('fill', 'transparent')
        .on('mousemove', (ev, i) => {
          tip.style('display', null).html('');
          tip.append('div').attr('class', 'd').text(W.labels[i] + ' ' + W.months[i].slice(0, 4) + (W.partial && i === idx.length - 1 ? ', month to date' : ''));
          tip.append('div').text(n0(v.total[i]) + ' quotes');
          if (v.closed[i]) tip.append('div').attr('class', 'd').text(n0(v.logged[i]) + ' open log · ' + n0(v.closed[i]) + ' closed');
          tip.append('div').attr('class', 'd').text(n0(v.cust[i]) + ' customers quoting');
          const [mx] = d3.pointer(ev, p); const tw = tip.node().offsetWidth;
          tip.style('left', Math.min(Math.max(0, mx - tw / 2), p.clientWidth - tw) + 'px').style('top', '20px');
        })
        .on('mouseleave', () => tip.style('display', 'none'));
      svg.selectAll('text.m').data(idx).join('text').attr('class', 'm').attr('x', (i) => x(i) + x.bandwidth() / 2).attr('y', H - 4).attr('text-anchor', 'middle').attr('fill', 'var(--muted)').attr('font-size', 11).text((i) => W.labels[i]);
      const mx = d3.maxIndex(v.total);
      const lab = idx.filter((i) => single || i === mx || v.total[i] === 0);
      svg.selectAll('text.v').data(lab).join('text').attr('class', 'v').attr('x', (i) => x(i) + x.bandwidth() / 2).attr('y', (i) => y(v.total[i]) - 4).attr('text-anchor', 'middle').attr('fill', (i) => (v.total[i] ? 'var(--fg)' : 'var(--muted)')).attr('font-size', 11).text((i) => n0(v.total[i]));
      });
    });
    later.forEach((f) => f());
    // table
    const rows = (single ? [P.branch] : ['All branches', ...list]).map((b) => {
      const f = { branch: b, cat: P.cat, rep: P.rep };
      return { b, v: B.volume(f), sc: B.statusCounts(B.customers(f)) };
    });
    table($('branch-table'), [
      { h: 'Branch', txt: true, v: (r) => r.b },
      ...monthCols((r) => r.v.total),
      ...windowCols((r) => r.v),
      { h: W.lastFullLabel + ' vs ' + W.prevFullLabel, v: (r) => r.v.lastVsPrev, f: pct, cls: dirCls },
      { h: 'Customers ' + W.lastFullLabel, v: (r) => r.v.custLast, f: n0 },
      { h: 'Dropped off', v: (r) => r.sc['Dropped off'], f: n0, cls: (v) => (v ? 'down' : '') },
      { h: 'New', v: (r) => r.sc.New, f: n0 },
    ], rows, { rowClass: (r) => (single || r.b === 'All branches' ? 'total' : 'click'), onRow: single ? null : (r) => { if (r.b !== 'All branches') { P.branch = r.b; repKey = ''; draw(); } } });
  }

  // ---------- reps
  function drawReps() {
    $('reps-card').hidden = !!P.rep;
    if (P.rep) return;
    const tail = (r) => (r.rep === 'Other branch reps' ? 2 : r.rep === 'Unassigned' ? 1 : 0);
    const rows = B.repGroups(P.branch).map((g) => {
      const f = { repKey: g.key, cat: P.cat };
      const cs = B.customers(f);
      return { ...g, v: B.volume(f), sc: B.statusCounts(cs), cPrior: cs.filter((x) => x.s.prior > 0).length, cRecent: cs.filter((x) => x.s.recent > 0).length };
    }).filter((r) => r.v.any).sort((a, b) => tail(a) - tail(b) || b.v.recent - a.v.recent);
    const W = B.W;
    table($('rep-table'), [
      { h: 'Rep', txt: true, v: (r) => r.rep },
      ...(P.branch === 'All branches' ? [{ h: 'Branch', txt: true, v: (r) => r.branch }] : []),
      ...monthCols((r) => r.v.total),
      ...windowCols((r) => r.v),
      { h: 'Customers ' + W.priorLabel, v: (r) => r.cPrior, f: n0 },
      { h: 'Customers ' + W.recentLabel, v: (r) => r.cRecent, f: n0 },
      { h: 'Dropped off', v: (r) => r.sc['Dropped off'], f: n0, cls: (v) => (v ? 'down' : 'zero') },
      { h: 'Slowing', v: (r) => r.sc.Slowing, f: n0, cls: (v) => (v ? 'down' : 'zero') },
      { h: 'New', v: (r) => r.sc.New, f: n0, cls: (v) => (v ? 'up' : 'zero') },
    ], rows, { rowClass: (r) => 'click' + (repKey === r.key ? ' on' : ''), onRow: (r) => { repKey = repKey === r.key ? '' : r.key; drawReps(); drawCustomers(); const cc = $('customers-card'); if (cc.scrollIntoView) cc.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
    const other = P.branch !== 'All branches' ? rows.find((r) => r.rep === 'Other branch reps') : null;
    $('other-reps').hidden = !other;
    if (other) $('other-reps').textContent = 'Other branch reps here: ' + [...other.reps].sort().join(', ');
  }

  // ---------- customers
  const pkey = (c) => c.key;
  function custRows() {
    let list = B.customers({ ...F(), repKey: repKey || undefined });
    if (status !== 'All') list = list.filter((x) => x.s.status === status);
    if (search) list = list.filter((x) => x.c.customer.toLowerCase().includes(search));
    return list;
  }
  const SORTS = {
    customer: (x) => x.c.customer, branch: (x) => x.c.branch, rep: (x) => x.c.rep, contact: (x) => x.c.contact, phone: (x) => x.c.phone, products: (x) => x.c.products,
    prior: (x) => x.s.prior, recent: (x) => x.s.recent, change: (x) => x.s.change, last: (x) => x.s.lastISO, lastTotal: (x) => x.s.lastTotal, days: (x) => x.s.daysSince, status: (x) => x.s.status,
  };
  function drawCustomers() {
    $('status-seg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === status)));
    $('cust-warn').hidden = !['All branches', 'Charleston', 'Newport News'].includes(P.branch);
    const W = B.W;
    const list = custRows();
    const sk = SORTS[sortK] || ((x) => x.s.m[+sortK.slice(1)]);
    list.sort((a, b) => { const va = sk(a), vb = sk(b); if (va === vb) return 0; if (va == null || va === '') return 1; if (vb == null || vb === '') return -1; return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sortDir; });
    shown = list;
    $('cust-count').textContent = n0(list.length) + ' customers';
    const visible = showAll ? list : list.slice(0, PAGE);
    const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Select all rows shown');
    const inView = list.filter((x) => picked.has(pkey(x.c))).length;
    all.checked = list.length > 0 && inView === list.length; all.indeterminate = inView > 0 && inView < list.length;
    all.addEventListener('change', () => { list.forEach((x) => (all.checked ? picked.add(pkey(x.c)) : picked.delete(pkey(x.c)))); drawCustomers(); });
    table($('cust-table'), [
      { check: all, cell: (td, x, row) => { td.className = 'sel'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = picked.has(pkey(x.c)); cb.setAttribute('aria-label', 'Select ' + x.c.customer); cb.addEventListener('change', () => { cb.checked ? picked.add(pkey(x.c)) : picked.delete(pkey(x.c)); row.classList.toggle('picked', cb.checked); updateSel(); }); td.appendChild(cb); } },
      { h: 'Customer', key: 'customer', txt: true, v: (x) => x.c.customer },
      ...(P.branch === 'All branches' ? [{ h: 'Branch', key: 'branch', txt: true, v: (x) => x.c.branch }] : []),
      { h: 'Rep', key: 'rep', txt: true, v: (x) => x.c.rep },
      { h: 'Contact', key: 'contact', txt: true, v: (x) => x.c.contact },
      { h: 'Phone', key: 'phone', txt: true, v: (x) => x.c.phone },
      { h: 'Products quoted', key: 'products', txt: true, v: (x) => x.c.products, cls: () => 'prods' },
      ...monthCols((x) => x.s.m),
      { h: W.priorLabel, key: 'prior', v: (x) => x.s.prior, f: n0 },
      { h: W.recentLabel, key: 'recent', v: (x) => x.s.recent, f: n0 },
      { h: 'Change', key: 'change', v: (x) => x.s.change, f: (v) => (v > 0 ? '+' : '') + n0(v), cls: (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat') },
      { h: 'Last quote', key: 'last', txt: true, v: (x) => x.s.last },
      { h: 'Last quote $', key: 'lastTotal', v: (x) => x.s.lastTotal, f: money },
      { h: 'Days since', key: 'days', v: (x) => x.s.daysSince, f: n0 },
      { h: 'Status', key: 'status', txt: true, v: (x) => x.s.status, cls: (v) => stCls(v) },
    ], visible, { sortable: true, sortK, sortDir, onSort: (k) => { if (sortK === k) sortDir = -sortDir; else { sortK = k; sortDir = ['customer', 'branch', 'rep', 'contact', 'phone', 'products', 'status', 'last'].includes(k) ? 1 : -1; } drawCustomers(); }, rowClass: (x) => (picked.has(pkey(x.c)) ? 'picked' : '') });
    let more = $('show-more');
    if (!more) { more = document.createElement('button'); more.id = 'show-more'; more.type = 'button'; more.className = 'btn ghost'; more.addEventListener('click', () => { showAll = true; drawCustomers(); }); $('cust-table').parentElement.after(more); }
    more.hidden = showAll || list.length <= PAGE;
    more.textContent = 'Show all ' + n0(list.length) + ' customers (first ' + PAGE + ' shown)';
    updateSel();
  }
  function updateSel() {
    const n = picked.size, inView = shown.filter((x) => picked.has(pkey(x.c))).length;
    $('sel-count').textContent = n ? n0(n) + ' account' + (n === 1 ? '' : 's') + ' selected' + (inView < n ? ' (' + n0(n - inView) + ' hidden by filters)' : '') : 'Nothing ticked: the buttons use all ' + n0(shown.length) + ' rows shown.';
    $('clear-sel').hidden = !n;
  }
  $('clear-sel').addEventListener('click', () => { picked.clear(); drawCustomers(); });
  function drawRepSelect() {
    const sel = $('rep-select');
    sel.hidden = !!P.rep;
    const groups = B.repGroups(P.branch).sort((a, b) => (a.branch + a.rep).localeCompare(b.branch + b.rep));
    sel.replaceChildren(new Option('All reps', ''), ...groups.map((g) => new Option(P.branch === 'All branches' ? g.rep + ' · ' + g.branch : g.rep, g.key)));
    if (repKey && !groups.some((g) => g.key === repKey)) repKey = '';
    sel.value = repKey;
  }

  // ---------- call lists
  function listRows() {
    const all = new Map(B.customers({ cat: 'All' }).map((x) => [pkey(x.c), x]));
    if (!picked.size) return shown.map((x) => all.get(pkey(x.c)) || x);
    const order = new Map(shown.map((x, i) => [pkey(x.c), i]));
    return [...picked].map((k) => all.get(k)).filter(Boolean).sort((a, b) => (order.get(pkey(a.c)) ?? 1e9) - (order.get(pkey(b.c)) ?? 1e9) || a.c.customer.localeCompare(b.c.customer));
  }
  function listTitle(rows) {
    const reps = [...new Set(rows.map((x) => x.c.rep))], brs = [...new Set(rows.map((x) => x.c.branch))];
    return (reps.length === 1 ? reps[0] : 'Selected accounts') + (brs.length === 1 ? ' · ' + brs[0] : '');
  }
  function sheetHtml(rows) {
    const W = B.W, title = listTitle(rows);
    const pr = d3.sum(rows, (x) => x.s.prior), rc = d3.sum(rows, (x) => x.s.recent);
    const body = rows.map((x) => {
      const rq = x.c.recentQuotes.map((q) => '<div class="q"><b>' + esc(q.date) + '</b> ' + esc(money(q.total)) + ' <span>' + esc(q.products) + '</span> <i>' + esc(q.quote) + '</i></div>').join('');
      return '<tr><td><b>' + esc(x.c.customer) + '</b><div class="m">' + esc(x.c.branch) + ' · ' + esc(x.c.rep) + '</div></td>'
        + '<td>' + esc(x.c.contact) + '<div class="m">' + esc(x.c.phone) + '</div></td><td>' + esc(x.c.products) + '</td>'
        + '<td class="n">' + x.s.prior + '</td><td class="n">' + x.s.recent + '</td>'
        + '<td class="' + stCls(x.s.status) + '">' + esc(x.s.status) + '<div class="m">' + x.s.daysSince + ' days</div></td><td>' + rq + '</td><td></td></tr>';
    }).join('');
    const logo = new URL('logo.png', location.href).href;
    return '<!doctype html><html><head><meta charset="utf-8"><title>Call sheet ' + esc(title) + '</title><style>'
      + '@page{size:letter landscape;margin:0.4in}body{font:11px/1.35 Helvetica,Arial,sans-serif;color:#1d2a31;margin:24px}'
      + 'header{display:flex;align-items:center;gap:18px;border-bottom:3px solid #5f9339;padding-bottom:10px;margin-bottom:12px}header img{height:46px}'
      + 'h1{font-size:19px;color:#243947;margin:0}.sub{color:#4a5a63;font-size:11px;margin-top:3px}table{border-collapse:collapse;width:100%}'
      + 'th{background:#243947;color:#fff;text-align:left;font-size:10px;padding:6px 5px;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      + 'td{border-bottom:1px solid #c9d5d8;padding:6px 5px;vertical-align:top}tr:nth-child(even) td{background:#eef4f2;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      + 'thead{display:table-header-group}tr{page-break-inside:avoid}.m{color:#5b6b73;font-size:10px}.n{text-align:right}.q{white-space:nowrap}.q span{color:#115e67}.q i{color:#8a979d;font-style:normal;font-size:9px}'
      + '.down{color:#b3261e;font-weight:bold}.up{color:#3d7a28;font-weight:bold}.bar{margin:0 0 12px}.bar button{font:inherit;font-size:12px;padding:6px 14px;background:#115e67;color:#fff;border:0;border-radius:4px;cursor:pointer}'
      + 'footer{margin-top:10px;color:#5b6b73;font-size:9.5px}@media print{.bar{display:none}body{margin:0}}</style></head><body>'
      + '<div class="bar"><button onclick="window.print()">Print</button></div>'
      + '<header><img alt="Aldora" src="' + logo + '"><div><h1>Call sheet: ' + esc(title) + '</h1><div class="sub">' + rows.length + ' accounts · ' + rc + ' quotes in ' + W.recentLabel + ' vs ' + pr + ' in ' + W.priorLabel + ' · Data through ' + W.asOfUS + ' · Printed ' + new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + '</div></div></header>'
      + '<table><thead><tr><th style="width:19%">Customer</th><th style="width:13%">Contact / phone</th><th style="width:13%">Products quoted</th><th>' + W.priorLabel + '</th><th>' + W.recentLabel + '</th><th style="width:8%">Status</th><th style="width:21%">Last 3 quotes</th><th>Call notes</th></tr></thead><tbody>'
      + body + '</tbody></table><footer>Products quoted shows how many quotes included each product. Last 3 quotes: date, quote total, products, quote number. Dropped off = 3+ quotes, none in the last 60 days. Slowing = recent 3-month pace at least 25% below the 6 months before.</footer></body></html>';
  }
  const fileBase = (rows) => 'Call sheet ' + listTitle(rows).replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const flash = (btn, txt) => { const l = btn.dataset.label || (btn.dataset.label = btn.textContent); btn.textContent = txt; setTimeout(() => { btn.textContent = l; }, 2500); };
  $('print-sheet').addEventListener('click', () => {
    const rows = listRows(); if (!rows.length) return;
    const html = sheetHtml(rows), w = window.open('', '_blank');
    if (!w) { download(fileBase(rows) + '.html', html, 'text/html'); flash($('print-sheet'), 'Pop-up blocked: saved as a file'); return; }
    w.document.open(); w.document.write(html); w.document.close();
    w.onload = () => setTimeout(() => w.print(), 300);
  });
  const csvCell = (v) => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  $('csv-list').addEventListener('click', () => {
    const rows = listRows(); if (!rows.length) return;
    const W = B.W;
    const head = ['Customer', 'Branch', 'Rep', 'Contact', 'Phone', 'Products quoted', ...W.labels, W.priorLabel, W.recentLabel, 'Status', 'Last quote', 'Days since', 'Quote 1 date', 'Quote 1 total', 'Quote 1 products', 'Quote 2 date', 'Quote 2 total', 'Quote 2 products', 'Quote 3 date', 'Quote 3 total', 'Quote 3 products', 'Call notes'];
    const lines = [head].concat(rows.map((x) => { const q = x.c.recentQuotes, qc = []; for (let i = 0; i < 3; i++) qc.push(q[i] ? q[i].date : '', q[i] ? q[i].total : '', q[i] ? q[i].products : ''); return [x.c.customer, x.c.branch, x.c.rep, x.c.contact, x.c.phone, x.c.products, ...x.s.m, x.s.prior, x.s.recent, x.s.status, x.s.last, x.s.daysSince, ...qc, '']; }));
    download(fileBase(rows) + '.csv', '﻿' + lines.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
  });
  $('copy-list').addEventListener('click', () => {
    const rows = listRows(); if (!rows.length) return;
    const W = B.W;
    const text = [['Customer', 'Branch', 'Rep', 'Contact', 'Phone', 'Products quoted', W.priorLabel, W.recentLabel, 'Status', 'Last 3 quotes', 'Call notes'].join('\t')].concat(rows.map((x) => [x.c.customer, x.c.branch, x.c.rep, x.c.contact, x.c.phone, x.c.products, x.s.prior, x.s.recent, x.s.status, x.c.recentQuotes.map((q) => q.date + ' ' + money(q.total) + ' ' + q.products).join('; '), ''].join('\t'))).join('\n');
    const btn = $('copy-list');
    navigator.clipboard.writeText(text).then(() => flash(btn, 'Copied ' + n0(rows.length) + ' rows'), () => flash(btn, 'Copy failed'));
  });

  // ---------- products
  function drawProducts() {
    const rows = E.CATS.map((c) => ({ c, v: B.volume({ branch: P.branch, cat: c, rep: P.rep }) })).filter((r) => r.v.any);
    table($('prod-table'), [
      { h: 'Product', txt: true, v: (r) => r.c },
      ...monthCols((r) => r.v.total),
      ...windowCols((r) => r.v),
    ], rows, { rowClass: (r) => 'click' + (r.c === P.cat ? ' on' : ''), onRow: (r) => { P.cat = r.c === P.cat ? 'All' : r.c; draw(); } });
  }

  // ---------- draw everything
  function draw() {
    showAll = false;
    $('branch-seg').querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.v === P.branch)); b.hidden = !!P.rep && b.dataset.v !== 'All branches' && b.dataset.v !== P.branch && !B.volume({ branch: b.dataset.v, cat: 'All', rep: P.rep }).any; });
    $('cat-seg').querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.v === P.cat)); b.hidden = b.dataset.v !== 'All' && b.dataset.v !== P.cat && !B.volume({ branch: P.branch, cat: b.dataset.v, rep: P.rep }).any; });
    $('top-rep').value = P.rep;
    drawHeader(); drawTrend(); drawRepSelect(); drawReps(); drawCustomers(); drawProducts();
    requestAnimationFrame(() => drawTrend());
  }
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => B && drawTrend(), 200); });
  if (store.get(CODE_KEY)) $('gate-err').textContent = '';
  load().catch(showError);
})();
