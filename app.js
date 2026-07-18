// Nonprofit Check — client app (compact data format)
// MD5-sharded detail data. Three modes: name search, state browse, EIN lookup.
// Index format: [ein, name, city, state, status]
// Detail format: [name, city, state, status, deductible, revoked, rev_date, filed, tax_year, website, officer, dba, zip]
// State format: [ein, name, city, status, deductible, revoked, filed, tax_year]
(function () {
  'use strict';

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  const DATA_BASE = 'data';
  const DETAIL_SHARDS = 256;

  let meta = null;
  let searchCache = {};
  let detailCache = {};
  let stateCache = {};
  let lastResults = [];
  let currentEin = null;

  // ── MD5 (matches Python hashlib.md5) ──
  function md5hex(str) {
    function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
    function add32(a, b) { return ((a + b) & 0xFFFFFFFF) >>> 0; }
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    const padded = new Uint8Array(((len + 8) >>> 6 << 6) + 64);
    padded.set(bytes);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (len * 8) % 0x100000000, true);
    view.setUint32(padded.length - 4, Math.floor(len * 8 / 0x100000000), true);
    const S = [7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21];
    const K = Array.from({length: 64}, (_,i) => Math.floor(Math.abs(Math.sin(i+1)) * 0x100000000));
    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    for (let i = 0; i < padded.length; i += 64) {
      const M = new Uint32Array(padded.buffer.slice(i, i + 64));
      let A = a, B = b, C = c, D = d;
      for (let j = 0; j < 64; j++) {
        let f, g;
        if (j < 16) { f = (B & C) | (~B & D); g = j; }
        else if (j < 32) { f = (D & B) | (~D & C); g = (5*j + 1) % 16; }
        else if (j < 48) { f = B ^ C ^ D; g = (3*j + 5) % 16; }
        else { f = C ^ (B | ~D); g = (7*j) % 16; }
        f = add32(f, add32(add32(A, K[j]), M[g]));
        A = D; D = C; C = B;
        B = add32(B, rotl(f, S[(j >>> 2) * 4 + j % 4]));
      }
      a = add32(a, A); b = add32(b, B); c = add32(c, C); d = add32(d, D);
    }
    const h = x => x.toString(16).padStart(8, '0');
    return h(a) + h(b) + h(c) + h(d);
  }

  function md5Shard(key) {
    return parseInt(md5hex(key).substring(0, 8), 16) % DETAIL_SHARDS;
  }

  // ── Init ──
  async function init() {
    try {
      const resp = await fetch(`${DATA_BASE}/meta.json`);
      meta = await resp.json();
      $('#data-date').textContent = meta.last_updated ? `(data: ${meta.last_updated})` : '';
      renderIntro();
      buildStateGrid();
    } catch (e) {
      console.error('Failed to load meta:', e);
    }
    setupEvents();
  }

  function renderIntro() {
    if (!meta) return;
    const s = meta.statuses;
    const good = s.good ? (s.good/1e6).toFixed(1) + 'M' : '—';
    const revoked = s.revoked ? (s.revoked/1e6).toFixed(1) + 'M' : '—';
    $('#name-search').insertAdjacentHTML('afterbegin', `
      <div class="intro-stats">
        <div class="stat"><span class="stat-value">${(meta.total_orgs/1e6).toFixed(1)}M</span><span class="stat-label">Organizations</span></div>
        <div class="stat"><span class="stat-value">${good}</span><span class="stat-label">Good Standing</span></div>
        <div class="stat"><span class="stat-value">${revoked}</span><span class="stat-label">Revoked</span></div>
        <div class="stat"><span class="stat-value">${meta.states_count}</span><span class="stat-label">States/Territories</span></div>
      </div>
      <p class="panel-desc">Search any U.S. nonprofit to check its IRS standing: tax-deductible status, filing compliance, and revocation history. Data from IRS <strong>Publication 78</strong>, <strong>Auto-Revocation List</strong>, and <strong>Form 990-N</strong> filings.</p>
    `);
  }

  function setupEvents() {
    $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    $('#search-input').addEventListener('input', debounce(doSearch, 250));
    $('#ein-btn').addEventListener('click', doEinLookup);
    $('#ein-input').addEventListener('keyup', e => { if (e.key === 'Enter') doEinLookup(); });
    $('.back-btn').addEventListener('click', hideDetail);
  }

  function switchTab(tab) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $$('.search-panel').forEach(p => p.classList.remove('active'));
    $(`#${tab}-search`).classList.add('active');
    hideDetail();
  }

  // ── Index entry helpers ──
  // Index: [ein, name, city, state, status]
  function idxEin(o) { return o[0]; }
  function idxName(o) { return o[1]; }
  function idxCity(o) { return o[2]; }
  function idxState(o) { return o[3]; }
  function idxStatus(o) { return o[4]; }

  // ── Search ──
  async function doSearch() {
    const q = $('#search-input').value.trim();
    $('#detail-view').classList.remove('active');
    if (!q || q.length < 2) {
      $('#search-results').innerHTML = '';
      return;
    }
    $('#search-results').innerHTML = '<div class="loading">Searching...</div>';

    const firstChar = q[0].toUpperCase();
    const letter = /[A-Z]/.test(firstChar) ? firstChar : '#';

    try {
      if (!searchCache[letter]) {
        const resp = await fetch(`${DATA_BASE}/index/index-${letter}.json`);
        searchCache[letter] = await resp.json();
      }
      const data = searchCache[letter];
      const ql = q.toLowerCase();
      const matches = data.filter(o => idxName(o).toLowerCase().includes(ql));

      if (matches.length === 0) {
        $('#search-results').innerHTML = '<div class="no-results"><p>No organizations found matching "' + escHtml(q) + '"</p><p class="hint">Try a shorter name or different spelling.</p></div>';
        return;
      }

      lastResults = matches.slice(0, 200);
      let html = `<div class="result-count">${matches.length} result${matches.length !== 1 ? 's' : ''}${matches.length > 200 ? ' (showing 200)' : ''}</div>`;
      for (const o of lastResults) {
        html += resultCard(o);
      }
      $('#search-results').innerHTML = html;
    } catch (e) {
      $('#search-results').innerHTML = '<div class="no-results">Error loading search data. Try again.</div>';
    }
  }

  function resultCard(o) {
    const badge = statusBadge(idxStatus(o));
    return `<div class="result-card" data-ein="${idxEin(o)}" onclick="window.__showDetail('${idxEin(o)}')">
      <div class="result-name">${escHtml(idxName(o))}</div>
      <div class="result-loc">${escHtml(idxCity(o))}${idxCity(o) && idxState(o) ? ', ' : ''}${escHtml(idxState(o))}</div>
      <div class="result-meta"><span>EIN: ${fmtEin(idxEin(o))}</span>${badge}</div>
    </div>`;
  }

  // ── Detail ──
  // Detail: [name, city, state, status, deductible, revoked, rev_date, filed, tax_year, website, officer, dba, zip]
  function detName(o) { return o[0]; }
  function detCity(o) { return o[1]; }
  function detState(o) { return o[2]; }
  function detStatus(o) { return o[3]; }
  function detDed(o) { return o[4]; }
  function detRev(o) { return o[5]; }
  function detRevDate(o) { return o[6]; }
  function detFiled(o) { return o[7]; }
  function detTaxYr(o) { return o[8]; }
  function detWeb(o) { return o[9]; }
  function detOff(o) { return o[10]; }
  function detDba(o) { return o[11]; }
  function detZip(o) { return o[12]; }

  async function showDetail(ein) {
    currentEin = ein;
    $('#search-results').innerHTML = '';
    $('#state-results').innerHTML = '';
    $('#ein-result').innerHTML = '';

    const detailView = $('#detail-view');
    detailView.classList.add('active');
    $('#detail-content').innerHTML = '<div class="loading">Loading...</div>';
    $$('.search-panel').forEach(p => p.classList.remove('active'));

    try {
      const shard = md5Shard(ein);
      const sk = `d${shard}`;
      if (!detailCache[sk]) {
        const resp = await fetch(`${DATA_BASE}/detail/detail-${String(shard).padStart(3, '0')}.json`);
        detailCache[sk] = await resp.json();
      }
      const o = detailCache[sk][ein];
      if (!o) {
        $('#detail-content').innerHTML = '<div class="no-results">Organization not found.</div>';
        return;
      }
      renderDetail(ein, o);
    } catch (e) {
      $('#detail-content').innerHTML = '<div class="no-results">Error loading details.</div>';
    }
  }

  function renderDetail(ein, o) {
    const st = detStatus(o);
    let statusHtml = '';
    if (st === 'good') {
      statusHtml = `<div class="status-box good"><strong>✅ In Good Standing</strong>Eligible for tax-deductible contributions. Most recent Form 990-N filed for tax year ${detTaxYr(o) || 'N/A'}.</div>`;
    } else if (st === 'revoked') {
      statusHtml = `<div class="status-box revoked"><strong>⚠️ Tax-Exempt Status Revoked</strong>The IRS automatically revoked this organization's exemption. ${detRevDate(o) ? 'Revocation date: ' + detRevDate(o) : ''}<br>Contributions to this organization are <strong>NOT</strong> tax-deductible.</div>`;
    } else if (st === 'filing') {
      statusHtml = `<div class="status-box filing"><strong>📋 Filed 990-N — Not in Pub78</strong>Has filed a recent Form 990-N (${detTaxYr(o) || 'N/A'}) but is not listed in IRS Publication 78. Contributions may not be tax-deductible.</div>`;
    } else if (st === 'deductible') {
      statusHtml = `<div class="status-box deductible"><strong>📋 Tax-Deductible — No Electronic Filing</strong>Listed in IRS Publication 78 as eligible for tax-deductible contributions, but no recent Form 990-N on file. Normal for very small organizations and religious congregations.</div>`;
    } else {
      statusHtml = `<div class="status-box unknown"><strong>⚪ Status Unclear</strong>This organization was found in IRS records but its current standing could not be fully determined from available data.</div>`;
    }

    let html = statusHtml;
    html += `<div class="detail-header">
      <h2>${escHtml(detName(o))}</h2>
      <div class="org-loc">${escHtml(detCity(o) || 'N/A')}, ${escHtml(detState(o) || 'N/A')} ${escHtml(detZip(o) || '')}</div>
      <div class="org-ein">EIN: ${fmtEin(ein)}</div>
    </div>`;
    html += `<div class="detail-grid">
      <div class="dg-item"><div class="dg-label">Tax-Deductible</div><div class="dg-value">${detDed(o) ? 'Yes ✅' : 'No ❌'}</div></div>
      <div class="dg-item"><div class="dg-label">Filed 990-N</div><div class="dg-value">${detFiled(o) ? 'Yes — Tax Year ' + detTaxYr(o) : 'No recent filing'}</div></div>
      <div class="dg-item"><div class="dg-label">Revoked</div><div class="dg-value">${detRev(o) ? 'Yes — ' + (detRevDate(o) || 'Date unknown') : 'No'}</div></div>
      ${detOff(o) ? `<div class="dg-item"><div class="dg-label">Principal Officer</div><div class="dg-value">${escHtml(detOff(o))}</div></div>` : ''}
      ${detWeb(o) ? `<div class="dg-item"><div class="dg-label">Website</div><div class="dg-value"><a href="${escHtml(detWeb(o))}" target="_blank" rel="noopener">${escHtml(detWeb(o).substring(0,60))}${detWeb(o).length > 60 ? '...' : ''}</a></div></div>` : ''}
      ${detDba(o) ? `<div class="dg-item"><div class="dg-label">DBA Name</div><div class="dg-value">${escHtml(detDba(o))}</div></div>` : ''}
    </div>`;
    $('#detail-content').innerHTML = html;
  }

  function hideDetail() {
    $('#detail-view').classList.remove('active');
    currentEin = null;
    const activeTab = $('.tab.active');
    if (activeTab) {
      $(`#${activeTab.dataset.tab}-search`).classList.add('active');
    }
  }

  // ── State Browse ──
  // State format: [ein, name, city, status, deductible, revoked, filed, tax_year]
  function stEin(o) { return o[0]; }
  function stName(o) { return o[1]; }
  function stCity(o) { return o[2]; }
  function stStatus(o) { return o[3]; }

  function buildStateGrid() {
    const grid = $('#state-grid');
    const states = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI'.split(' ');
    grid.innerHTML = states.map(s => `<button class="state-btn" data-state="${s}">${s}<span class="st-count"></span></button>`).join('');
    grid.addEventListener('click', e => {
      const btn = e.target.closest('.state-btn');
      if (btn) loadState(btn.dataset.state);
    });
  }

  async function loadState(st) {
    $('#state-results').innerHTML = '<div class="loading">Loading...</div>';
    try {
      if (!stateCache[st]) {
        const resp = await fetch(`${DATA_BASE}/state/state-${st}.json`);
        if (!resp.ok) throw new Error('not found');
        stateCache[st] = await resp.json();
      }
      const data = stateCache[st];
      let html = `<div class="result-count">${st}: ${data.length.toLocaleString()} organizations</div>`;
      const show = data.slice(0, 150);
      for (const o of show) {
        html += `<div class="result-card" data-ein="${stEin(o)}" onclick="window.__showDetail('${stEin(o)}')">
          <div class="result-name">${escHtml(stName(o))}</div>
          <div class="result-loc">${escHtml(stCity(o))}</div>
          <div class="result-meta">${statusBadge(stStatus(o))}</div>
        </div>`;
      }
      if (data.length > 150) {
        html += `<div class="no-results"><p>Showing 150 of ${data.length.toLocaleString()} organizations. Use name search for more.</p></div>`;
      }
      $('#state-results').innerHTML = html;
    } catch (e) {
      $('#state-results').innerHTML = '<div class="no-results">No data available for this state.</div>';
    }
  }

  // ── EIN Lookup ──
  async function doEinLookup() {
    const input = $('#ein-input').value.trim();
    if (!input) return;
    const ein = input.replace(/[^0-9]/g, '');
    if (ein.length < 9) {
      $('#ein-result').innerHTML = '<div class="no-results">Enter a 9-digit EIN (XX-XXXXXXX).</div>';
      return;
    }
    $('#ein-result').innerHTML = '<div class="loading">Looking up...</div>';
    try {
      const shard = md5Shard(ein);
      const resp = await fetch(`${DATA_BASE}/detail/detail-${String(shard).padStart(3, '0')}.json`);
      const bucket = await resp.json();
      const o = bucket[ein];
      if (!o) {
        $('#ein-result').innerHTML = '<div class="no-results"><p>EIN not found in IRS databases.</p><p class="hint">This may be a newer organization or one that has not filed recently.</p></div>';
        return;
      }
      switchTab('name');
      await showDetail(ein);
      $('#search-input').value = detName(o);
      $('#ein-result').innerHTML = '';
    } catch (e) {
      $('#ein-result').innerHTML = '<div class="no-results">Error looking up EIN.</div>';
    }
  }

  // ── Helpers ──
  function statusBadge(st) {
    const labels = {good: 'Good Standing', revoked: 'Revoked', filing: 'Filed 990-N', deductible: 'Tax-Deductible', unknown: 'Unknown'};
    return `<span class="badge badge-${st}">${labels[st] || st}</span>`;
  }

  function fmtEin(ein) {
    return ein.length === 9 ? ein.substring(0, 2) + '-' + ein.substring(2) : ein;
  }

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function debounce(fn, ms) {
    let timer;
    return function(...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), ms); };
  }

  window.__showDetail = showDetail;
  init();
})();
