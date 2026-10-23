// Data layer. Everything is a "doc": {collection, id, data}. Collections:
//   program    – one doc per training block (coach writes)
//   meta       – macrocycle overview (coach writes)
//   logs       – athlete's actual sets, keyed `${itemId}.${groupIndex}` (athlete writes)
//   sessions   – per-day session info (date, length, RPE) (athlete writes)
//   bodyweight – one doc per date (athlete writes)
// The cache lives in localStorage and writes are queued, so the app works offline in the gym
// and syncs when signal returns.
const CACHE_KEY = 'ta.cache.v1', QUEUE_KEY = 'ta.queue.v1';
const COLLS = ['program', 'meta', 'logs', 'sessions', 'bodyweight'];

function emptyState() { const s = {}; COLLS.forEach(c => s[c] = {}); return s; }

class Store {
  constructor(adapter) {
    this.adapter = adapter;
    this.state = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null') || emptyState();
    this.queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    this.listeners = []; this.online = true; this.user = null; this.role = null;
  }
  on(fn) { this.listeners.push(fn); }
  emit() { this.listeners.forEach(f => f(this)); }
  persist() { localStorage.setItem(CACHE_KEY, JSON.stringify(this.state)); localStorage.setItem(QUEUE_KEY, JSON.stringify(this.queue)); }
  get(c, id) { return this.state[c][id]; }
  all(c) { return this.state[c]; }
  async init() {
    const a = await this.adapter.auth?.();
    if (a) { this.user = a.user; this.role = a.role; }
    await this.refresh();
    this.adapter.subscribe?.(() => this.refresh());
    window.addEventListener('online', () => this.flush());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
  }
  async refresh() {
    await this.flush();
    try {
      const docs = await this.adapter.load();
      const s = emptyState();
      docs.forEach(d => { if (s[d.collection]) s[d.collection][d.id] = d.data; });
      // Never wipe a good local programme if the backend returned nothing useful
      if (!Object.keys(s.program).length && Object.keys(this.state.program || {}).length) {
        s.program = { ...this.state.program };
        if (!Object.keys(s.meta).length) s.meta = { ...this.state.meta };
        this.source = this.source || 'cache';
        this.problems = [...(this.problems || []), 'Backend returned no programme – kept last cached plan.'];
      }
      // re-apply unsynced local writes on top (logs/sessions/bw never lost)
      this.queue.forEach(q => { if (q.data === null) delete s[q.c][q.id]; else s[q.c][q.id] = q.data; });
      this.state = s; this.online = true;
    } catch (e) {
      this.online = false;
      console.warn('offline – using cache', e);
      this.problems = [...(this.problems || []), 'Backend unreachable: ' + (e && e.message || e)];
      // First launch / empty cache: seed programme from bundled snapshot so Train is never blank
      // Also merges newer bundled snapshots: adds new blocks, refreshes the macrocycle; never touches logs or existing blocks.
      {
        const empty = !Object.keys(this.state.program || {}).length;
        try {
          const fb = await fetch('programme-fallback.json', { cache: 'no-cache' });
          if (fb.ok) {
            const docs = await fb.json();
            const fbAt = docs.find(d => d.collection === 'meta' && d.id === 'fallback')?.data?.at || '';
            const haveAt = this.state.meta?.fallback?.at || '';
            const haveNums = new Set(Object.values(this.state.program || {}).map(b => b.number));
            if (empty || fbAt > haveAt) docs.forEach(d => {
              if (!this.state[d.collection]) return;
              if (d.collection === 'program' && !empty && (this.state.program[d.id] || haveNums.has(d.data.number))) return;
              this.state[d.collection][d.id] = d.data;
            });
            if (empty || fbAt > haveAt) this.source = 'fallback';
            this.problems = [...(this.problems || []), 'Showing bundled programme (re-pair from sheet menu to sync live).'];
          }
        } catch (e2) { console.warn('fallback failed', e2); }
      }
    }
    this.persist(); this.emit();
  }
  put(c, id, data) { this.state[c][id] = data; this.enqueue({ c, id, data }); }
  del(c, id) { delete this.state[c][id]; this.enqueue({ c, id, data: null }); }
  enqueue(op) {
    this.queue = this.queue.filter(q => !(q.c === op.c && q.id === op.id)); this.queue.push(op);
    this.persist(); this.emit(); clearTimeout(this._t); this._t = setTimeout(() => this.flush(), 400);
  }
  async flush() {
    if (this.adapter.putMany && this.queue.length) {
      const ops = this.queue.slice();
      try { await this.adapter.putMany(ops); this.queue = this.queue.filter(q => !ops.includes(q)); this.online = true; }
      catch (e) { this.online = false; }
      this.persist(); this.emit(); return;
    }
    while (this.queue.length) {
      const op = this.queue[0];
      try {
        if (op.data === null) await this.adapter.del(op.c, op.id); else await this.adapter.put(op.c, op.id, op.data);
        this.queue.shift(); this.online = true;
      } catch (e) { this.online = false; break; }
    }
    this.persist(); this.emit();
  }
  get pending() { return this.queue.length; }
}

// ---- Adapters -------------------------------------------------------------
const devAdapter = {
  name: 'Local server',
  async load() { const r = await fetch('/api/docs'); if (!r.ok) throw new Error(r.status); return r.json(); },
  async put(c, id, data) { const r = await fetch(`/api/docs/${c}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) }); if (!r.ok) throw new Error(r.status); },
  async del(c, id) { const r = await fetch(`/api/docs/${c}/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (!r.ok) throw new Error(r.status); },
};

const localAdapter = {
  name: 'This device only',
  async load() {
    let docs = JSON.parse(localStorage.getItem('ta.localdb') || 'null');
    if (!docs) { const r = await fetch('seed-docs.json'); docs = r.ok ? await r.json() : []; localStorage.setItem('ta.localdb', JSON.stringify(docs)); }
    return docs;
  },
  async put(c, id, data) { const d = await this.load(); const i = d.findIndex(x => x.collection === c && x.id === id); const doc = { collection: c, id, data }; i >= 0 ? d[i] = doc : d.push(doc); localStorage.setItem('ta.localdb', JSON.stringify(d)); },
  async del(c, id) { const d = (await this.load()).filter(x => !(x.collection === c && x.id === id)); localStorage.setItem('ta.localdb', JSON.stringify(d)); },
};

// Supabase: one table `docs` + `members` (see backend/supabase/schema.sql). Login by email magic link.
function supabaseAdapter(cfg) {
  let sb;
  return {
    name: 'Supabase',
    async auth() {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      sb = createClient(cfg.url, cfg.anonKey);
      let { data: { session } } = await sb.auth.getSession();
      if (!session) {
        const email = prompt('Sign in – enter your email and we\'ll send you a login link');
        if (email) { await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } }); alert('Check your email for the login link.'); }
        throw new Error('not signed in');
      }
      const { data: m } = await sb.from('members').select('role').eq('email', session.user.email).maybeSingle();
      return { user: session.user.email, role: m?.role || null };
    },
    async load() { const { data, error } = await sb.from('docs').select('collection,id,data'); if (error) throw error; return data; },
    async put(c, id, data) { const { error } = await sb.from('docs').upsert({ collection: c, id, data }); if (error) throw error; },
    async del(c, id) { const { error } = await sb.from('docs').delete().match({ collection: c, id }); if (error) throw error; },
    subscribe(cb) { sb.channel('docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, () => { clearTimeout(this._d); this._d = setTimeout(cb, 500); }).subscribe(); },
  };
}

// Google Sheet as the backend, via the Apps Script web app in backend/apps-script/Code.gs.
// Programme + macrocycle are read from the coach's sheet; results are written into its green columns.
function sheetsAdapter(cfg) {
  const pair = JSON.parse(localStorage.getItem('ta.pair') || (document.cookie.match(/(?:^|; )tapair=([^;]+)/) || [])[1] && decodeURIComponent(document.cookie.match(/(?:^|; )tapair=([^;]+)/)[1]) || 'null') || {};
  if (true) { pair.url = 'https://script.google.com/macros/s/AKfycbzHF7ze9P9zhhIXC3D0-fzom130CCpbBYXf4iHosuyZosGxv6pS647t_lDpSiYL_n1M/exec'; pair.key = 'd49a11ea0ed241849cb052b625b80c3d'; }
  if (pair.url) { localStorage.setItem('ta.pair', JSON.stringify(pair)); document.cookie = 'tapair=' + encodeURIComponent(JSON.stringify(pair)) + '; max-age=31536000; path=/; SameSite=Strict; Secure'; try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {} }
  const url = pair.url || cfg.url, key = pair.key || cfg.key;
  let map = { cells: {}, sessCells: {} };
  const join = a => { const v = a.filter(x => x != null && x !== ''); if (!v.length) return ''; return v.every(x => String(x) === String(v[0])) ? String(v[0]) : v.join(','); };
  const uk = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (d ?? ''); };
  function cellsFor(op) {
    if (!op.data) return [];
    if (map.format === 'original') {
      if (op.c === 'logs') {
        const loc = map.cells[op.id]; if (!loc) return [];
        const sets = (op.data.sets || []).filter(Boolean), check = { row: loc.exRow, col: loc.exCol, value: loc.exercise }, b = { book: 'original', tab: loc.tab, row: loc.row, check };
        const out = [['kg', loc.kgCol], ['reps', loc.repsCol], ['rpe', loc.rpeCol]].map(([f, col]) => ({ ...b, col, value: join(sets.map(x => x[f])) }));
        if (op.data.note) out.push({ ...b, col: loc.noteCol, value: op.data.note });
        return out;
      }
      if (op.c === 'sessions') {
        const loc = map.sessCells[op.id]; if (!loc) return [];
        return Object.entries(loc.rows).map(([k, row]) => ({ book: 'original', kind: 'session', tab: loc.tab, row, col: loc.valueCol, value: op.data[k] ?? '', check: { row, col: loc.labelCol, value: loc.labels[k] } }));
      }
      return [];
    }
    if (op.c === 'logs') {
      const loc = map.cells[op.id]; if (!loc) return [];
      const sets = (op.data.sets || []).filter(Boolean), check = { row: loc.exRow, col: loc.c0 + 1, value: loc.exercise };
      const out = [['kg', 7], ['reps', 8], ['rpe', 9]].map(([f, o]) => ({ tab: loc.tab, row: loc.row, col: loc.c0 + o, value: join(sets.map(x => x[f])), check }));
      if (/\.0$/.test(op.id)) out.push({ tab: loc.tab, row: loc.exRow, col: loc.c0 + 11, value: op.data.note || '', check });
      return out;
    }
    if (op.c === 'sessions') {
      const loc = map.sessCells[op.id]; if (!loc) return [];
      return Object.entries(loc.rows).map(([k, row]) => ({ kind: 'session', tab: loc.tab, row, col: loc.c0 + 1, value: k === 'date' ? uk(op.data.date) : (op.data[k] ?? '') }));
    }
    return [];
  }
  return {
    name: 'Google Sheet', readOnly: ['program', 'meta'],
    async auth() { if (!url || !key) throw new Error('Not paired yet – open the phone link from the sheet (menu Training app → Phone link).'); return { user: 'Oliver', role: 'athlete' }; },
    async load() {
      let r; for (let i = 0; i < 3; i++) { try { r = await fetch(`${url}?action=load&key=${encodeURIComponent(key)}&t=${Date.now()}`, { cache: 'no-store', redirect: 'follow' }); break; } catch (e) { if (i === 2) throw new Error('Network: ' + (e && e.message || e)); await new Promise(z => setTimeout(z, 1500)); } }
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const text = await r.text();
      if (!r.ok) throw new Error(`Backend HTTP ${r.status} […${String(url).slice(-14)}]`);
      if (!ct.includes('json') && text.trim()[0] !== '{') throw new Error('Backend returned non-JSON (deployment missing or wrong URL)');
      let j; try { j = JSON.parse(text); } catch (e) { throw new Error('Backend JSON parse failed'); }
      if (!j.ok) throw new Error(j.error || 'bad key');
      const { parseWorkbook, parseOriginal } = await import('./sheet-format.js');
      // The coach's original sheet is the source of truth when the script can reach it; else the bound copy.
      // Soft-parse: ignore empty/new Block tabs; prefer original even if it only has warnings.
      let res = (j.original && Object.keys(j.original).length) ? parseOriginal(j.original) : null;
      let useOrig = !!(res && res.blocks.length);
      if (!useOrig) {
        res = parseWorkbook(j.grids || {});
        useOrig = false;
      }
      if (!res.blocks.length) {
        // Last resort: bundled snapshot so the athlete can still train
        const fb = await fetch('programme-fallback.json', { cache: 'no-cache' });
        if (fb.ok) {
          const docs = await fb.json();
          this.source = 'fallback';
          this.problems = ['Sheet parse empty – using bundled programme. Re-pair from Training app → Phone link if sync is needed.', ...(res.errors || []), ...(res.warnings || [])];
          map = { cells: {}, sessCells: {}, format: 'fallback' };
          const out = docs.slice();
          (j.docs || []).forEach(d => out.push(d));
          return out;
        }
        throw new Error('No programme in sheet response');
      }
      map = { cells: res.cells, sessCells: res.sessCells, format: useOrig ? 'original' : 'template' };
      this.source = useOrig ? 'original' : 'copy';
      this.problems = [...(res.errors || []), ...(res.warnings || []), ...(j.originalError ? ['Original sheet unavailable: ' + j.originalError] : [])];
      j.docs.forEach(d => { if (d.collection === 'bodyweight' && d.data?.date) d.id = d.data.date; });   // old ids could be date-mangled
      const docs = [];
      res.blocks.forEach(b => docs.push({ collection: 'program', id: b.id, data: b }));
      if (res.macrocycle.length) docs.push({ collection: 'meta', id: 'macrocycle', data: { weeks: res.macrocycle } });
      const seen = new Set();
      j.docs.forEach(d => { docs.push(d); seen.add(d.collection + '|' + d.id); });            // app data wins
      Object.entries(res.logs).forEach(([id, data]) => { if (!seen.has('logs|' + id)) docs.push({ collection: 'logs', id, data }); });
      Object.entries(res.sessions).forEach(([id, data]) => { if (!seen.has('sessions|' + id)) docs.push({ collection: 'sessions', id, data }); });
      res.bodyweight.forEach(b => { if (!seen.has('bodyweight|' + b.date)) docs.push({ collection: 'bodyweight', id: b.date, data: b }); });
      if (useOrig) {
        // Self-healing carry-over: anything saved in the app that the original sheet doesn't show yet is mirrored
        // into it (guarded server-side; blanks never clear cells). Runs in the background on every open.
        const bw = new Set(res.bodyweight.map(b => b.date)), sessHas = id => Object.keys(res.sessions[id] || {}).length;
        const ops = j.docs.filter(d => d.data && (
          (d.collection === 'logs' && map.cells[d.id] && !map.cells[d.id].hasData && (d.data.sets || []).some(Boolean)) ||
          (d.collection === 'sessions' && map.sessCells[d.id] && !sessHas(d.id)) ||
          (d.collection === 'bodyweight' && d.data.kg != null && !bw.has(d.data.date)))).map(d => ({ c: d.collection, id: d.id, data: d.data }));
        if (ops.length) this.putMany(ops).then(() => console.info('mirrored', ops.length, 'saved entries into the original sheet')).catch(e => console.warn('mirror later:', e.message));
      }
      return docs;
    },
    async putMany(ops) {
      const body = { key, ops: ops.filter(o => !this.readOnly.includes(o.c)).map(o => ({ c: o.c, id: o.id, data: o.data, cells: cellsFor(o), ...(map.format === 'original' ? { book: 'original' } : {}) })) };
      if (!body.ops.length) return;
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
      const j = await r.json(); if (!j.ok) throw new Error(j.error); if (j.warnings?.length) console.warn(j.warnings);
    },
    async put(c, id, data) { return this.putMany([{ c, id, data }]); },
    async del(c, id) { return this.putMany([{ c, id, data: null }]); },
  };
}

export function createStore(cfg) {
  // one-time pairing link from the sheet: https://site/#pair=<execUrl>|<key>
  const m = decodeURIComponent(location.hash).match(/^#pair=([^|]+)\|(.+)$/);
  if (m) { localStorage.setItem('ta.pair', JSON.stringify({ url: m[1], key: m[2] })); document.cookie = 'tapair=' + encodeURIComponent(JSON.stringify({ url: m[1], key: m[2] })) + '; max-age=31536000; path=/; SameSite=Strict; Secure'; history.replaceState(null, '', location.pathname + '#/train'); }
  const a = cfg.backend === 'sheets' ? sheetsAdapter(cfg.sheets || {}) : cfg.backend === 'supabase' ? supabaseAdapter(cfg.supabase) : cfg.backend === 'local' ? localAdapter : devAdapter;
  return new Store(a);
}
