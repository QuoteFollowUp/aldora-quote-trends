/* Upload page: parse the Excel exports in the browser, merge with saved data, publish. */
(function () {
  'use strict';
  const E = window.QuoteEngine;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const KEY = 'aqt-manager-code';
  const ss = { get: () => { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } }, set: (v) => { try { sessionStorage.setItem(KEY, v); } catch (e) {} } };
  $('code').value = ss.get();

  const parsed = []; // {name, type, rows, maxDate}
  let merged = null;

  async function checkCode() {
    const code = $('code').value.trim();
    if (!code) { $('code-msg').textContent = 'Enter the manager code.'; return false; }
    const r = await fetch('/api/upload', { headers: { 'x-manager-code': code } }).catch(() => null);
    if (r && r.ok) { ss.set(code); $('code-msg').textContent = 'Code accepted.'; $('code-msg').className = 'count ok'; return true; }
    $('code-msg').textContent = r && r.status === 401 ? 'That code did not work.' : 'Could not reach the server.'; $('code-msg').className = 'count bad'; return false;
  }
  $('check').addEventListener('click', checkCode);

  function listFiles() {
    $('file-list').replaceChildren(...parsed.map((f) => {
      const li = document.createElement('li');
      li.textContent = f.error ? f.name + ': ' + f.error : f.name + ': ' + (f.type === 'open' ? 'Open Quotes, ' + fmt(f.rows.length) + ' quotes through ' + E.toUS(f.maxDate) : 'Closed Quotes, ' + fmt(f.rows.length) + ' closed quotes');
      li.className = f.error ? 'bad' : 'ok';
      return li;
    }));
  }
  async function readFile(file) {
    const entry = { name: file.name };
    parsed.push(entry); entry.error = 'reading...'; listFiles();
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', dense: true });
      const ws = wb.Sheets.Data || wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
      const type = E.detect(rows);
      if (!type) throw new Error('not an Open Quotes or Closed Quotes export (columns not recognized)');
      entry.type = type;
      entry.rows = type === 'open' ? E.parseOpen(rows) : E.parseClosed(rows);
      entry.maxDate = type === 'open' ? entry.rows.reduce((m, x) => (x.date > m ? x.date : m), '') : '';
      delete entry.error;
    } catch (e) { entry.error = e.message || 'could not read this file'; }
    listFiles();
  }
  async function addFiles(files) {
    for (const f of files) await readFile(f);
    await prepare();
  }
  $('files').addEventListener('change', (e) => addFiles([...e.target.files]));
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
  $('replace').addEventListener('change', prepare);

  async function prepare() {
    merged = null; $('publish').disabled = true;
    const open = parsed.filter((f) => f.type === 'open'), closed = parsed.filter((f) => f.type === 'closed');
    if (!open.length) { $('summary').textContent = 'Add at least one Open Quotes export.'; return; }
    if (!(await checkCode())) { $('summary').textContent = 'Enter a valid manager code first.'; return; }
    $('summary').textContent = 'Merging with saved data...';
    let existing = { quotes: [], closed: [], uploads: [] };
    if (!$('replace').checked) {
      const r = await fetch('/api/data', { headers: { 'x-team-code': ss.get() } });
      if (!r.ok) { $('summary').textContent = 'Could not load saved data (' + r.status + ').'; return; }
      const j = await r.json();
      if (!j.empty) existing = E.decode(j);
    }
    const res = E.merge(existing, open, closed, parsed.filter((f) => f.type).map((f) => f.name));
    merged = res.ds;
    const B = E.build(merged);
    const W = B ? B.W : null;
    const lines = [
      fmt(res.added) + ' new quotes added, ' + fmt(res.updated) + ' updated.',
      'Saved data will hold ' + fmt(merged.quotes.length) + ' quotes and ' + fmt(merged.closed.length) + ' closed quote records.',
      W ? 'Dashboard window: ' + W.firstUS + ' to ' + W.asOfUS + '. Recent ' + W.recentLabel + ' vs prior ' + W.priorLabel + '.' : '',
      closed.length ? '' : 'No Closed Quotes file added. Closed counts will use the last one saved.',
    ].filter(Boolean);
    $('summary').textContent = lines.join(' ');
    $('publish').disabled = false;
  }

  $('publish').addEventListener('click', async () => {
    if (!merged) return;
    $('publish').disabled = true; $('pub-msg').textContent = 'Saving...'; $('pub-msg').className = 'count';
    try {
      const json = JSON.stringify(E.encode(merged));
      const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      const r = await fetch('/api/upload', { method: 'POST', headers: { 'x-manager-code': ss.get(), 'content-type': 'application/octet-stream' }, body: gz });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'server returned ' + r.status);
      $('pub-msg').textContent = 'Published. ' + fmt(j.quotes) + ' quotes saved. The dashboard shows the new numbers now.';
      $('pub-msg').className = 'count ok';
    } catch (e) {
      $('pub-msg').textContent = 'Not saved: ' + e.message; $('pub-msg').className = 'count bad'; $('publish').disabled = false;
    }
  });
})();
