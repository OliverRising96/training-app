import { createStore } from './store.js';
import { parseWorkbook, gridsFromXLSX } from './sheet-format.js';

const store = createStore(window.APP_CONFIG);
const $app = document.getElementById('app');
const ui = {
  role: localStorage.getItem('ta.role') || 'athlete',   // prototype only; in production comes from login
  sel: JSON.parse(localStorage.getItem('ta.sel') || 'null'), // {b, w} selected block/week
  open: {},                                               // expanded note editors
};

// ---------- helpers ----------------------------------------------------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.').replace(/kg$/i, '')); return Number.isFinite(n) ? n : null; };
const fmt = n => n == null ? '' : (Math.round(n * 10) / 10).toString();
const round25 = n => Math.round(n / 2.5) * 2.5;
const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD (UK time, not UTC)
const kgTxt = v => { const n = num(v); return n == null ? (v ?? '–') : String(Math.round(n * 100) / 100); };
const niceDate = d => new Date(d + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const uid = () => 'i' + Math.random().toString(36).slice(2, 9);
// Same formula as the sheet: weight × (1 + 0.0333 × (reps + 10 − RPE − 1))
const e1rm = (kg, reps, rpe) => (kg && reps && rpe != null && rpe >= 5 && reps <= 12) ? kg * (1 + 0.0333 * (reps + 10 - rpe - 1)) : null;

function blocks() { return Object.values(store.all('program')).sort((a, b) => a.number - b.number); }
function chrono(b, w, d) { return b.number * 10000 + w.n * 100 + d.n; }
function allDays() { const out = []; blocks().forEach(b => b.weeks.forEach(w => w.days.forEach(d => out.push({ b, w, d, k: chrono(b, w, d) })))); return out; }
function findDay(id) { return allDays().find(x => x.d.id === id); }
const logKey = (item, gi) => `${item.id}.${gi}`;
const getLog = (item, gi) => store.get('logs', logKey(item, gi));
const doneSets = log => (log?.sets || []).filter(s => s && (s.kg != null || s.reps != null));

function presText(g) {
  const parts = [];
  if (g.sets) parts.push(`${g.sets} × ${g.reps ?? '?'}`); else if (g.reps) parts.push(g.reps);
  if (g.intensity != null && g.intensity !== '') parts.push(typeof g.intensity === 'number' ? `${g.intensity} kg` : g.intensity);
  if (g.range && g.range !== '-' && g.range !== g.intensity) parts.push(/kg|cap/i.test(g.range) ? g.range : `${g.range} kg`);
  return parts.join(' · ');
}
function rpeTargets(g) { const m = String(g.intensity ?? '').match(/@\s*\d+(?:\.\d+)?/g); return m ? m.map(x => num(x.replace('@', ''))) : []; }

// Kg hint for back-off sets: "85% of top set", "top set - 10kg"
function backoffHint(item, gi) {
  const g = item.groups[gi], t = String(g.intensity ?? '');
  const top = doneSets(getLog(item, 0)).map(s => num(s.kg)).filter(Boolean);
  if (!top.length || gi === 0) return null;
  const topKg = Math.max(...top);
  let m = t.match(/(\d+)%\s*of top/i); if (m) return round25(topKg * m[1] / 100);
  m = t.match(/top set\s*-\s*(\d+(?:\.\d+)?)/i); if (m) return topKg - Number(m[1]);
  return null;
}

function prevLog(item, gi, beforeK) {
  // most recent earlier log of the same exercise (same set-group position)
  const name = item.exercise.toLowerCase();
  let best = null;
  allDays().forEach(x => {
    if (x.k >= beforeK) return;
    x.d.items.forEach(it => {
      if (it.exercise.toLowerCase() !== name || !it.groups[gi]) return;
      const l = getLog(it, gi); if (!doneSets(l).length) return;
      if (!best || x.k > best.k) best = { k: x.k, log: l, where: `B${x.b.number} W${x.w.n}` };
    });
  });
  return best;
}
const setsText = sets => sets.map(s => `${kgTxt(s.kg)}×${s.reps ?? '–'}${s.rpe != null && s.rpe !== '' ? ' @' + s.rpe : ''}`).join(', ');

function dayStatus(d) {
  let total = 0, done = 0;
  d.items.forEach(it => it.groups.forEach((g, gi) => { total++; if (doneSets(getLog(it, gi)).length) done++; }));
  return { total, done, pct: total ? done / total : 0 };
}

function currentSel() {
  const bs = blocks(); if (!bs.length) return null;
  if (ui.sel && bs.find(b => b.id === ui.sel.b)?.weeks.find(w => w.n === ui.sel.w)) return ui.sel;
  // Prefer the macrocycle week that contains today (e.g. w/c 12 Oct → Block 4 Week 4)
  const mc = store.get('meta', 'macrocycle')?.weeks || [], t = today();
  const cur = mc.find(w => w.block && w.week && t >= w.wc && t < new Date(new Date(w.wc + 'T12:00').getTime() + 7 * 864e5).toISOString().slice(0, 10));
  if (cur) {
    const b = bs.find(x => x.number === cur.block || x.id === `b${cur.block}`);
    if (b?.weeks.find(w => w.n === cur.week)) return { b: b.id, w: cur.week };
  }
  // fallback: latest week with any logging; jump forward if it's complete
  const weeks = []; bs.forEach(b => b.weeks.forEach(w => weeks.push({ b, w })));
  let idx = weeks.length - 1;
  for (let i = weeks.length - 1; i >= 0; i--) if (weeks[i].w.days.some(d => dayStatus(d).done)) { idx = i; break; }
  if (weeks[idx].w.days.every(d => dayStatus(d).pct === 1) && weeks[idx + 1]) idx++;
  return { b: weeks[idx].b.id, w: weeks[idx].w.n };
}
function setSel(sel) { ui.sel = sel; localStorage.setItem('ta.sel', JSON.stringify(sel)); }

// ---------- exercise history / progress -------------------------------------
function exerciseNames() {
  const m = new Map();
  allDays().forEach(x => x.d.items.forEach(it => { if (!m.has(it.exercise)) m.set(it.exercise, it.classification || ''); }));
  return m;
}
function history(name) {
  const rows = [];
  allDays().forEach(x => x.d.items.forEach(it => {
    if (it.exercise !== name) return;
    const sets = []; it.groups.forEach((g, gi) => doneSets(getLog(it, gi)).forEach(s => sets.push({ ...s, gi })));
    if (!sets.length) return;
    let best = null, top = null;
    sets.forEach(s => {
      const kg = num(s.kg), reps = num(s.reps), rpe = num(s.rpe);
      const e = e1rm(kg, reps, rpe); if (e && (!best || e > best)) best = e;
      if (kg != null && (!top || kg > top.kg || (kg === top.kg && (reps || 0) > (top.reps || 0)))) top = { kg, reps, rpe };
    });
    rows.push({ b: x.b, w: x.w, d: x.d, k: x.k, sets, e1rm: best, top, date: store.get('sessions', x.d.id)?.date });
  }));
  // one point per week (best of the week)
  const byWeek = new Map();
  rows.forEach(r => { const key = r.b.number * 100 + r.w.n; const cur = byWeek.get(key); const v = r.e1rm ?? r.top?.kg ?? 0; if (!cur || v > (cur.e1rm ?? cur.top?.kg ?? 0)) byWeek.set(key, r); });
  const pts = [...byWeek.values()].sort((a, b) => a.k - b.k);
  const useE = pts.filter(p => p.e1rm).length >= Math.max(2, pts.length / 2);
  return { rows: rows.sort((a, b) => b.k - a.k), pts: pts.map(p => ({ label: `W${p.w.n}`, block: p.b.number, y: useE ? (p.e1rm ?? null) : p.top?.kg, r: p })).filter(p => p.y), metric: useE ? 'Est. 1RM' : 'Top set' };
}

function lineChart(pts, { h = 190, unit = 'kg' } = {}) {
  if (pts.length < 1) return '<p class="muted">No data yet.</p>';
  const W = 340, H = h, pl = 34, pr = 12, pt = 16, pb = 30;
  const ys = pts.map(p => p.y), min = Math.min(...ys), max = Math.max(...ys), pad = (max - min) * 0.15 || 5;
  const lo = Math.floor((min - pad) / 5) * 5, hi = Math.ceil((max + pad) / 5) * 5;
  const X = i => pl + (pts.length === 1 ? (W - pl - pr) / 2 : i * (W - pl - pr) / (pts.length - 1));
  const Y = v => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
  let g = '';
  for (let t = 0; t <= 3; t++) { const v = lo + (hi - lo) * t / 3; g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${pl - 4}" y="${Y(v) + 4}" class="ax" text-anchor="end">${Math.round(v)}</text>`; }
  // block bands
  let lastB = null, bands = '';
  pts.forEach((p, i) => { if (p.block !== lastB) { const x = X(i) - (i ? (X(i) - X(i - 1)) / 2 : 0); bands += `${i ? `<line x1="${x}" x2="${x}" y1="${pt}" y2="${H - pb}" class="sep"/>` : ''}<text x="${x + 3}" y="${H - 8}" class="bl">Block ${p.block}</text>`; lastB = p.block; } });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const dots = pts.map((p, i) => `<circle cx="${X(i)}" cy="${Y(p.y)}" r="3.5"/>`).join('');
  const l = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" class="chart">${g}${bands}<path d="${path}" class="ln"/>${dots}<text x="${X(pts.length - 1)}" y="${Y(l.y) - 9}" text-anchor="end" class="lv">${fmt(l.y)} ${unit}</text></svg>`;
}
function spark(pts) {
  if (pts.length < 2) return '';
  const W = 80, H = 26, ys = pts.map(p => p.y), lo = Math.min(...ys), hi = Math.max(...ys) || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(i * W / (pts.length - 1)).toFixed(1)},${(H - 3 - (H - 6) * ((p.y - lo) / ((hi - lo) || 1))).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="spark"><path d="${d}"/></svg>`;
}

// ---------- views ----------------------------------------------------------
function header(title, back) {
  const st = !store.online ? ['off', 'Offline – saved on phone'] : store.pending ? ['pend', 'Syncing…'] : ['ok', 'Synced'];
  return `<header class="top">${back ? `<a class="back" href="${back}">‹</a>` : ''}<h1>${esc(title)}</h1><span class="sync ${st[0]}" title="${st[1]}"></span></header>`;
}
function tabs(active) {
  const t = ui.role === 'coach'
    ? [['#/coach', 'Programme', '▦'], ['#/progress', 'Progress', '↗'], ['#/plan', 'Plan', '◷'], ['#/settings', 'More', '⋯']]
    : [['#/train', 'Train', '●'], ['#/progress', 'Progress', '↗'], ['#/body', 'Body', '◐'], ['#/settings', 'More', '⋯']];
  return `<nav class="tabs">${t.map(([h, l, i]) => `<a href="${h}" class="${active === h ? 'on' : ''}"><span>${i}</span>${l}</a>`).join('')}</nav>`;
}

function weekPicker(sel, base) {
  const bs = blocks(), b = bs.find(x => x.id === sel.b);
  const weeks = []; bs.forEach(bb => bb.weeks.forEach(w => weeks.push({ b: bb.id, w: w.n })));
  const i = weeks.findIndex(x => x.b === sel.b && x.w === sel.w);
  const prev = weeks[i - 1], next = weeks[i + 1];
  const w = b.weeks.find(x => x.n === sel.w);
  return `<div class="weekpick">
    <button data-sel='${prev ? JSON.stringify(prev) : ''}' ${prev ? '' : 'disabled'}>‹</button>
    <div><b>${esc(b.name)} · ${esc(w.label || 'Week ' + w.n)}</b>${b.objective ? `<small>${esc(b.objective)}</small>` : ''}</div>
    <button data-sel='${next ? JSON.stringify(next) : ''}' ${next ? '' : 'disabled'}>›</button></div>`;
}

function viewTrain() {
  const sel = currentSel(); if (!sel) return header('Train') + '<p class="pad muted">No programme yet – your coach adds it.</p><p class="pad muted">If this persists: open Training Log sheet → menu <b>Training app → Phone link</b> and open that link once.</p>' + tabs('#/train');
  const b = blocks().find(x => x.id === sel.b), w = b.weeks.find(x => x.n === sel.w);
  const next = upcomingMoment();
  const src = store.source || (store.online ? 'live' : 'cache');
  const banner = (!store.online || src === 'fallback' || src === 'cache')
    ? `<div class="moment" style="background:#3a2a00">Offline / cached plan (${esc(src)}). Logs stay on this phone. Re-pair via sheet menu → Phone link to sync.</div>`
    : '';
  return header('Train') + `<main>
    ${banner}
    ${next ? `<div class="moment">${esc(next.moment)} <span>${next.days === 0 ? 'this week' : `· week of ${esc(niceDate(next.wc))}`}</span></div>` : ''}
    ${weekPicker(sel)}
    ${w.days.map(d => { const s = dayStatus(d), sess = store.get('sessions', d.id);
      return `<a class="card day" href="#/day/${encodeURIComponent(d.id)}">
        <div class="ring" style="--p:${s.pct}">${s.pct === 1 ? '✓' : Math.round(s.pct * 100) + '%'}</div>
        <div class="grow"><b>${esc(d.label)}</b><small>${d.items.slice(0, 4).map(i => esc(i.exercise)).join(' · ')}${d.items.length > 4 ? ` +${d.items.length - 4}` : ''}</small>
        ${sess?.day || sess?.date ? `<small class="muted">${sess.date ? 'Done ' + esc(niceDate(sess.date)) : esc(sess.day || '')}</small>` : ''}</div><span class="chev">›</span></a>`; }).join('')}
  </main>` + tabs('#/train');
}

function upcomingMoment() {
  const mc = store.get('meta', 'macrocycle')?.weeks || [], t = new Date(today());
  for (const w of mc) { if (!w.moment) continue; const d = new Date(w.wc); const days = Math.round((d - t) / 864e5); if (days >= -6) return { moment: w.moment, days: Math.max(0, days), wc: w.wc }; }
  return null;
}

function renderItem(it, k, readonly, gym) {
    const groups = it.groups.map((g, gi) => {
      const log = getLog(it, gi) || { sets: [] }, prev = prevLog(it, gi, k), targets = rpeTargets(g), hint = backoffHint(it, gi);
      const n = Math.max(g.sets || 1, (log.sets || []).length);
      const rows = Array.from({ length: n }, (_, si) => {
        const s = log.sets?.[si] || {}, ps = prev?.log.sets?.[si] || prev?.log.sets?.[prev.log.sets.length - 1] || {};
        const phKg = hint ?? num(ps.kg) ?? '', phReps = num(g.reps) ?? '', phRpe = targets[si] ?? targets[targets.length - 1] ?? '';
        const done = !!s.done || (log.imported && (s.kg != null || s.reps != null));
        const e = e1rm(num(s.kg), num(s.reps), num(s.rpe));
        return `<div class="set ${done ? 'done' : ''}" data-k="${esc(logKey(it, gi))}" data-si="${si}">
          <span class="sn">${si + 1}</span>
          <input inputmode="decimal" data-f="kg" value="${esc(s.kg ?? '')}" placeholder="${esc(phKg)}" ${readonly ? 'disabled' : ''}><i>kg</i>
          <input inputmode="numeric" data-f="reps" value="${esc(s.reps ?? '')}" placeholder="${esc(phReps)}" ${readonly ? 'disabled' : ''}><i>reps</i>
          <input inputmode="decimal" data-f="rpe" value="${esc(s.rpe ?? '')}" placeholder="${esc(phRpe)}" ${readonly ? 'disabled' : ''}><i>RPE</i>
          ${readonly || gym ? '' : `<button class="tick" data-tick aria-label="Done">✓</button>`}
          ${e ? `<em class="e1">e1RM ${fmt(e)}</em>` : ''}</div>`;
      }).join('');
      return `<div class="grp"><div class="pres">${esc(presText(g))}${hint ? ` <span class="hint">≈ ${fmt(hint)} kg</span>` : ''}</div>
        ${prev && !gym ? `<div class="last">Last (${prev.where}): ${esc(setsText(doneSets(prev.log)))}</div>` : ''}
        ${rows}${!readonly ? `<button class="addset" data-addset="${esc(logKey(it, gi))}">+ set</button>` : ''}</div>`;
    }).join('');
    const noteKey = logKey(it, 0), note = store.get('logs', noteKey)?.note || '';
    if (gym) { const nk = logKey(it, 0), nt = store.get('logs', nk)?.note || '';
      return `<section class="gx"><h2>${esc(it.exercise)}</h2>${it.coachNote ? `<div class="cnote">${esc(it.coachNote)}</div>` : ''}${groups}<textarea class="note gx-note" data-note="${esc(nk)}" rows="1" placeholder="Comment">${esc(nt)}</textarea></section>`; }
    return `<section class="card ex"><div class="exh"><b>${esc(it.exercise)}</b><span class="tag">${esc(it.classification || '')}</span></div>
      ${it.coachNote ? `<div class="cnote">Coach: ${esc(it.coachNote)}</div>` : ''}${groups}
      ${readonly ? (note ? `<div class="note-ro">“${esc(note)}”</div>` : '') : `<textarea class="note" data-note="${esc(noteKey)}" rows="1" placeholder="Notes for coach…">${esc(note)}</textarea>`}</section>`;
}

// Gym mode: one exercise per screen; previous/next shown only as faint names. Swipe or tap them to move.
// Index lives in the URL (#/day/<id>/<n>); n === items.length is the "Finish" step (session + notes).
function firstOpen(d) { const i = d.items.findIndex(it => it.groups.some((g, gi) => { const l = getLog(it, gi); return (l?.sets || []).filter(s => s?.done || (l.imported && s && (s.kg != null || s.reps != null))).length < (g.sets || 1); })); return i < 0 ? d.items.length : i; }
function viewGym(x, idxRaw) {
  const { b, w, d, k } = x, n = d.items.length, sess = store.get('sessions', d.id) || {};
  let i = idxRaw == null || idxRaw === '' ? firstOpen(d) : Math.max(0, Math.min(n, +idxRaw || 0));
  const href = j => `#/day/${encodeURIComponent(d.id)}/${j}`;
  const prevName = i > 0 ? d.items[i - 1].exercise : null, nextName = i < n - 1 ? d.items[i + 1].exercise : i === n - 1 ? 'Finish' : null;
  const body = i < n ? renderItem(d.items[i], k, false, true) : `<section class="gx"><h2>Finish</h2>
      <section class="card sess"><b>Session</b>
      <label>Date<input type="date" data-sess="date" value="${esc(sess.date || '')}"></label>
      <label>Length (mins)<input inputmode="numeric" data-sess="length" value="${esc(sess.length ?? '')}"></label>
      <label>Session RPE<input inputmode="decimal" data-sess="rpe" value="${esc(sess.rpe ?? '')}"></label></section>
      ${d.items.map(it => { const nk = logKey(it, 0), note = store.get('logs', nk)?.note || ''; return `<label class="fnote">${esc(it.exercise)}<textarea class="note" data-note="${esc(nk)}" rows="1" placeholder="Note for coach…">${esc(note)}</textarea></label>`; }).join('')}
      <a class="btn wide done-btn" href="#/train">Done</a></section>`;
  return `<div class="gym" data-prev="${i > 0 ? href(i - 1) : ''}" data-next="${i < n ? href(i + 1) : ''}">
    <a class="gx-exit" href="#/train" aria-label="Back to week">‹</a><span class="gx-count">${Math.min(i + 1, n)}/${n}</span>
    ${prevName ? `<a class="ghost-nav prev" href="${href(i - 1)}">${esc(prevName)}</a>` : '<span class="ghost-nav"></span>'}
    <main class="gm">${body}${i < n ? `<div class="gx-btns">${i > 0 ? '<button class="pill" data-go="prev">‹ Previous</button>' : '<span></span>'}<button class="pill primary" data-go="next">${i === n - 1 ? 'Finish' : 'Next'} ›</button></div>` : `<div class="gx-btns"><button class="pill" data-go="prev">‹ Previous</button><span></span></div>`}</main>
    ${nextName ? `<a class="ghost-nav next" href="${href(i + 1)}">${esc(nextName)}</a>` : ''}</div>`;
}

function viewDay(id, idx) {
  const x = findDay(id); if (!x) return header('Not found', '#/train');
  const { b, w, d, k } = x, sess = store.get('sessions', d.id) || {};
  const readonly = ui.role === 'coach';
  if (!readonly) return viewGym(x, idx);
  const items = d.items.map(it => renderItem(it, k, readonly, false)).join('');
  return header(`${d.label}`, readonly ? '#/coach' : '#/train') + `<main>
    <div class="sub">${esc(b.name)} · ${esc(w.label || 'Week ' + w.n)}</div>${items}
    <section class="card sess"><b>Session</b>
      <label>Date<input type="date" data-sess="date" value="${esc(sess.date || '')}" ${readonly ? 'disabled' : ''}></label>
      <label>Length (mins)<input inputmode="numeric" data-sess="length" value="${esc(sess.length ?? '')}" ${readonly ? 'disabled' : ''}></label>
      <label>Session RPE<input inputmode="decimal" data-sess="rpe" value="${esc(sess.rpe ?? '')}" ${readonly ? 'disabled' : ''}></label>
    </section></main>`;
}

function viewProgress(name) {
  if (name) {
    const h = history(name);
    const best = h.pts.reduce((m, p) => p.y > (m?.y ?? 0) ? p : m, null);
    return header(name, '#/progress') + `<main>
      <div class="card"><div class="kpi"><div><small>${h.metric}</small><b>${best ? fmt(best.y) + ' kg' : '–'}</b><small>best · B${best?.block ?? ''} ${best?.label ?? ''}</small></div>
      <div><small>Latest</small><b>${h.pts.length ? fmt(h.pts[h.pts.length - 1].y) + ' kg' : '–'}</b><small>${h.pts.length} weeks logged</small></div></div>
      ${lineChart(h.pts)}</div>
      ${h.rows.map(r => `<div class="card hist"><div><b>B${r.b.number} W${r.w.n} ${esc(r.d.label)}</b>${r.date ? ` <small class="muted">${esc(niceDate(r.date))}</small>` : ''}</div>
        <div>${esc(setsText(r.sets))}</div>${r.e1rm ? `<small class="muted">e1RM ${fmt(r.e1rm)} kg</small>` : ''}</div>`).join('')}
    </main>` + tabs('#/progress');
  }
  const names = [...exerciseNames().entries()];
  const main = ['Comp. Squat', 'Comp. Bench', 'Comp. Deadlift'];
  names.sort((a, b) => (main.indexOf(b[0]) + 1 ? 1 : 0) - (main.indexOf(a[0]) + 1 ? 1 : 0) || (main.indexOf(a[0]) - main.indexOf(b[0])) || a[0].localeCompare(b[0]));
  const list = names.map(([n, c]) => { const h = history(n); const last = h.pts[h.pts.length - 1], first = h.pts[0];
    const delta = last && first && h.pts.length > 1 ? last.y - first.y : null;
    return `<a class="card prog" href="#/progress/${encodeURIComponent(n)}"><div class="grow"><b>${esc(n)}</b><small>${esc(c)}</small></div>
      ${spark(h.pts)}<div class="pv"><b>${last ? fmt(last.y) : '–'}</b>${delta != null ? `<small class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${fmt(delta)}</small>` : ''}</div></a>`; }).join('');
  return header('Progress') + `<main><p class="sub">Best estimated 1RM (or top set) each week, across all blocks.</p>${list}</main>` + tabs('#/progress');
}

function viewBody() {
  const bw = Object.values(store.all('bodyweight')).sort((a, b) => a.date.localeCompare(b.date));
  const pts = bw.map((p, i) => { const win = bw.filter(q => q.date <= p.date && (new Date(p.date) - new Date(q.date)) < 7 * 864e5); return { label: p.date, block: p.date.slice(0, 7), y: win.reduce((s, q) => s + q.kg, 0) / win.length }; });
  const t = store.get('bodyweight', today());
  return header('Bodyweight') + `<main>
    <div class="card row"><input id="bwin" inputmode="decimal" placeholder="Today's weight (kg)" value="${esc(t?.kg ?? '')}"><button class="btn" id="bwsave">Save</button></div>
    <div class="card"><small class="muted">7-day average</small>${lineChart(pts.map(p => ({ ...p, block: new Date(p.label).toLocaleString('en-GB', { month: 'short' }) })), { h: 170 }).replace(/Block /g, '')}</div>
    ${bw.slice(-10).reverse().map(p => `<div class="card hist row"><span>${esc(niceDate(p.date))}</span><span class="grow"></span><b>${fmt(p.kg)} kg</b></div>`).join('')}
  </main>` + tabs('#/body');
}

function viewPlan() {
  const mc = store.get('meta', 'macrocycle')?.weeks || [], t = today();
  return header('Macrocycle', ui.role === 'coach' ? null : '#/settings') + `<main>${mc.map(w => {
    const end = new Date(new Date(w.wc).getTime() + 7 * 864e5).toISOString().slice(0, 10), cur = t >= w.wc && t < end;
    return `<div class="card plan ${cur ? 'cur' : ''}"><span class="d">${new Date(w.wc).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
      <span class="grow">${w.block ? `<b>Block ${w.block}</b> · Wk ${w.week}` : '<span class="muted">Off</span>'}${w.week === 1 || !w.block ? `<small>${esc(w.objective || '')}</small>` : ''}</span>${w.moment ? `<span class="tag hot">${esc(w.moment)}</span>` : ''}</div>`; }).join('')}</main>` + (ui.role === 'coach' ? tabs('#/plan') : tabs(''));
}

// ---- Coach ----
function viewCoach() {
  const sel = currentSel(); const bs = blocks();
  if (!sel) return header('Programme') + `<main><button class="btn" data-newblock>+ New block</button></main>` + tabs('#/coach');
  const b = bs.find(x => x.id === sel.b);
  return header('Programme') + `<main>
    <div class="chips">${bs.map(x => `<button class="chip ${x.id === b.id ? 'on' : ''}" data-sel='${JSON.stringify({ b: x.id, w: x.weeks[0]?.n || 1 })}'>${esc(x.name)}</button>`).join('')}<button class="chip" data-newblock>+ Block</button></div>
    <div class="card sync-sheet"><b>Sync from coach sheet</b><small>Google Sheets: File → Download → Microsoft Excel (.xlsx), then choose it here.</small>
      <label class="btn filebtn">Choose sheet…<input type="file" id="sheetfile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden></label>
      ${ui.syncMsg ? `<div class="syncmsg">${ui.syncMsg}</div>` : ''}</div>
    <div class="card"><label>Block objective<input data-bfield="objective" value="${esc(b.objective || '')}"></label><label>Start (w/c)<input type="date" data-bfield="start" value="${esc(b.start || '')}"></label></div>
    ${b.weeks.map(w => `<div class="card wk"><div class="row"><b>${esc(w.label || 'Week ' + w.n)}</b><span class="grow"></span>
        <button class="sm" data-copyweek="${w.n}">Copy → new week</button></div>
      ${w.days.map(d => { const s = dayStatus(d); return `<a class="drow" href="#/coach/day/${encodeURIComponent(d.id)}"><span>${esc(d.label)}</span><small>${d.items.length} exercises</small><small class="${s.pct === 1 ? 'up' : 'muted'}">${s.done}/${s.total} logged</small><span class="chev">›</span></a>`; }).join('')}
      <button class="sm ghost" data-addday="${w.n}">+ Day</button></div>`).join('')}
  </main>` + tabs('#/coach');
}

function viewCoachDay(id) {
  const x = findDay(id); if (!x) return header('Not found', '#/coach');
  const { b, w, d } = x;
  const names = [...exerciseNames().keys()], classes = [...new Set(allDays().flatMap(y => y.d.items.map(i => i.classification).filter(Boolean)))];
  return header(`Edit ${d.label}`, '#/coach') + `<main><div class="sub">${esc(b.name)} · ${esc(w.label || 'Week ' + w.n)} · <a href="#/day/${encodeURIComponent(d.id)}">view athlete log</a></div>
    <datalist id="exl">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist><datalist id="cll">${classes.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    ${d.items.map((it, ii) => `<section class="card ed" data-item="${ii}">
      <div class="row"><input class="exn" list="exl" data-if="exercise" value="${esc(it.exercise)}" placeholder="Exercise">
        <button class="sm" data-mv="-1">↑</button><button class="sm" data-mv="1">↓</button><button class="sm danger" data-rm>✕</button></div>
      <input list="cll" data-if="classification" value="${esc(it.classification || '')}" placeholder="Classification (e.g. Squat: Primary)">
      <div class="gh"><span>Sets</span><span>Reps</span><span>Intensity</span><span>Kg range</span><span></span></div>
      ${it.groups.map((g, gi) => `<div class="gr" data-g="${gi}">
        <input inputmode="numeric" data-gf="sets" value="${esc(g.sets ?? '')}"><input data-gf="reps" value="${esc(g.reps ?? '')}">
        <input data-gf="intensity" value="${esc(g.intensity ?? '')}" placeholder="@7"><input data-gf="range" value="${esc(g.range ?? '')}" placeholder="140-145">
        <button class="sm ghost" data-rmg>✕</button></div>
        ${doneSets(getLog(it, gi)).length ? `<div class="last">Logged: ${esc(setsText(doneSets(getLog(it, gi))))}</div>` : ''}`).join('')}
      <button class="sm ghost" data-addg>+ row (e.g. back-off)</button>
      <input data-if="coachNote" value="${esc(it.coachNote || '')}" placeholder="Note to athlete (optional)">
      ${getLog(it, 0)?.note ? `<div class="note-ro">Athlete: “${esc(getLog(it, 0).note)}”</div>` : ''}
    </section>`).join('')}
    <button class="btn wide" data-additem>+ Add exercise</button></main>`;
}

function viewSettings() {
  const cfg = window.APP_CONFIG;
  return header('More') + `<main>
    ${ui.locked ? `<div class="card"><b>Signed in</b><p class="muted">${esc(store.user)} · ${esc(ui.role)}</p></div>` : `<div class="card"><b>Viewing as</b><div class="seg"><button data-role="athlete" class="${ui.role === 'athlete' ? 'on' : ''}">Athlete (Oliver)</button><button data-role="coach" class="${ui.role === 'coach' ? 'on' : ''}">Coach</button></div>
      <small class="muted">Prototype switch. Once live, the role comes from each person's login.</small></div>`}
    <a class="card row" href="#/plan"><b class="grow">Macrocycle plan</b><span class="chev">›</span></a>
    <div class="card"><b>Sync</b><p class="muted">Backend: ${esc(cfg.backend)} · ${store.online ? 'online' : 'offline'} · ${store.pending} change(s) waiting</p>${(store.problems||[]).length ? `<p class="muted" style="color:#e0a040;font-size:13px;word-break:break-word">${esc(store.problems.join(' · '))}</p>` : ''}
      <button class="sm" data-refresh>Sync now</button> ${cfg.backend === 'dev' ? '<button class="sm danger" data-reset>Reset demo data</button>' : ''}</div>
    <div class="card"><b>Install on your phone</b><p class="muted">iPhone: open in Safari → Share → “Add to Home Screen”. Android: Chrome menu → “Install app”.</p></div>
  </main>` + tabs('#/settings');
}

// ---------- router & render --------------------------------------------------
function route() {
  const h = decodeURIComponent(location.hash.slice(1) || (ui.role === 'coach' ? '/coach' : '/train'));
  const [, a, b, c] = h.split('/');
  if (a === 'day') return viewDay(b, c);
  if (a === 'progress') return viewProgress(b);
  if (a === 'body') return viewBody();
  if (a === 'plan') return viewPlan();
  if (a === 'settings') return viewSettings();
  if (a === 'coach' && b === 'day') return viewCoachDay(c);
  if (a === 'coach') return viewCoach();
  return viewTrain();
}
function render(force) {
  if (!force && $app.contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) { ui.dirty = true; return; }
  const y = scrollY; $app.innerHTML = route(); if (ui.keepScroll) scrollTo(0, y); else $app.querySelector('.plan.cur')?.scrollIntoView({ block: 'center' }); ui.keepScroll = false; ui.dirty = false;
}
document.addEventListener('focusout', () => setTimeout(() => { if (ui.dirty) { ui.keepScroll = true; render(); } }, 0));
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(true); });
store.on(() => { if (!ui.silent) render(); });

// ---------- mutations --------------------------------------------------------
function updateLog(key, fn) { const l = structuredClone(store.get('logs', key) || { sets: [] }); fn(l); l.updatedAt = new Date().toISOString(); store.put('logs', key, l); }
function touchSession(dayId) { const s = store.get('sessions', dayId) || {}; if (!s.date) store.put('sessions', dayId, { ...s, date: today(), day: new Date().toLocaleDateString('en-GB', { weekday: 'long' }) }); }
function saveBlock(b) { store.put('program', b.id, b); }
function curDayFromHash() { const p = decodeURIComponent(location.hash).split('/'); return p[1] === 'day' ? p[2] : p[3]; }

$app.addEventListener('change', e => {
  // The DOM already shows what was typed, so don't re-render here: re-rendering between a blur and
  // the next tap would swallow that tap (e.g. typing RPE then hitting ✓).
  ui.silent = true; try { onChange(e); } finally { ui.silent = false; }
});
function onChange(e) {
  const t = e.target;
  if (t.id === 'sheetfile' && t.files[0]) { importSheet(t.files[0]); return; }
  const setEl = t.closest('.set');
  if (setEl && t.dataset.f) {
    updateLog(setEl.dataset.k, l => { l.sets[+setEl.dataset.si] = { ...(l.sets[+setEl.dataset.si] || {}), [t.dataset.f]: num(t.value) ?? (t.value || null) }; });
    touchSession(curDayFromHash());
  }
  if (t.dataset.note) updateLog(t.dataset.note, l => { l.note = t.value || null; });
  if (t.dataset.sess) { const id = curDayFromHash(); store.put('sessions', id, { ...(store.get('sessions', id) || {}), [t.dataset.sess]: t.dataset.sess === 'date' ? t.value : (num(t.value) ?? t.value) }); }
  // coach edits
  const itemEl = t.closest('[data-item]');
  if (itemEl) {
    const x = findDay(curDayFromHash()), b = structuredClone(x.b), d = b.weeks.find(w => w.n === x.w.n).days.find(dd => dd.id === x.d.id), it = d.items[+itemEl.dataset.item];
    if (t.dataset.if) it[t.dataset.if] = t.value.trim() || null;
    if (t.dataset.gf) { const g = it.groups[+t.closest('[data-g]').dataset.g]; g[t.dataset.gf] = num(t.value) ?? (t.value.trim() || null); }
    saveBlock(b);
  }
  if (t.dataset.bfield) { const sel = currentSel(); const b = structuredClone(store.get('program', sel.b)); b[t.dataset.bfield] = t.value; saveBlock(b); }
}

// Gym mode: Next/Previous save what's in the boxes. A row counts as done when any box was filled in;
// boxes left empty in that row take the pre-filled (grey) value. Fully empty rows are left unlogged.
function saveGymPage() {
  const by = {};
  document.querySelectorAll('.gm .set').forEach(row => {
    const f = n => row.querySelector(`[data-f=${n}]`), typed = ['kg', 'reps', 'rpe'].some(n => f(n).value.trim() !== '');
    if (!typed) return;
    const v = n => num(f(n).value) ?? (f(n).value.trim() || (num(f(n).placeholder) ?? null));
    (by[row.dataset.k] ||= []).push([+row.dataset.si, { kg: v('kg'), reps: v('reps'), rpe: v('rpe'), done: true }]);
  });
  Object.entries(by).forEach(([k, rows]) => updateLog(k, l => { rows.forEach(([si, s]) => l.sets[si] = s); l.sets = Array.from(l.sets, x => x ?? null); }));
  const nt = document.querySelector('.gm .gx-note');
  if (nt && (store.get('logs', nt.dataset.note)?.note || '') !== nt.value.trim()) updateLog(nt.dataset.note, l => { l.note = nt.value.trim() || null; });
  if (Object.keys(by).length) touchSession(curDayFromHash());
}
$app.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.go) { const g = document.querySelector('.gym'); ui.silent = true; try { saveGymPage(); } finally { ui.silent = false; } const to = t.dataset.go === 'next' ? g.dataset.next : g.dataset.prev; if (to) location.hash = to; return; }
  if (t.dataset.sel !== undefined && t.dataset.sel) { setSel(JSON.parse(t.dataset.sel)); render(true); }
  if (t.hasAttribute('data-tick')) {
    const row = t.closest('.set'), key = row.dataset.k, si = +row.dataset.si;
    const v = f => { const i = row.querySelector(`[data-f=${f}]`); return num(i.value) ?? num(i.placeholder) ?? (i.value || null); };
    const isDone = row.classList.contains('done');
    updateLog(key, l => { l.sets[si] = isDone ? { ...(l.sets[si] || {}), done: false } : { kg: v('kg'), reps: v('reps'), rpe: v('rpe'), done: true }; l.sets = Array.from(l.sets, s => s ?? null); });
    touchSession(curDayFromHash()); ui.keepScroll = true; render(true);
  }
  if (t.dataset.addset) { updateLog(t.dataset.addset, l => { const n = Math.max(l.sets.length, t.closest('.grp').querySelectorAll('.set').length); l.sets[n] = null; l.sets = Array.from(l.sets, s => s ?? null); }); ui.keepScroll = true; render(true); }
  if (t.dataset.role) { ui.role = t.dataset.role; localStorage.setItem('ta.role', ui.role); render(true); }
  if (t.hasAttribute('data-refresh')) store.refresh();
  if (t.hasAttribute('data-reset') && confirm('Reset to the data imported from the sheet?')) fetch('/api/reset', { method: 'POST' }).then(() => { localStorage.removeItem('ta.cache.v1'); localStorage.removeItem('ta.queue.v1'); location.reload(); });
  if (t.id === 'bwsave') { const kg = num(document.getElementById('bwin').value); if (kg) store.put('bodyweight', today(), { date: today(), kg }); }
  // coach
  const sel = currentSel();
  if (t.hasAttribute('data-copyweek')) {
    const b = structuredClone(store.get('program', sel.b)), src = b.weeks.find(w => w.n === +t.dataset.copyweek), n = Math.max(...b.weeks.map(w => w.n)) + 1;
    b.weeks.push({ n, label: `Week ${n}`, days: src.days.map(d => ({ ...structuredClone(d), id: `${b.id}.w${n}.d${d.n}.${uid()}`, items: d.items.map(it => ({ ...structuredClone(it), id: uid() })) })) });
    saveBlock(b); setSel({ b: b.id, w: n }); ui.keepScroll = true; render(true);
  }
  if (t.hasAttribute('data-addday')) {
    const b = structuredClone(store.get('program', sel.b)), w = b.weeks.find(x => x.n === +t.dataset.addday), n = w.days.length + 1;
    w.days.push({ id: `${b.id}.w${w.n}.d${n}.${uid()}`, n, label: `Day ${n}`, items: [] }); saveBlock(b); location.hash = `#/coach/day/${encodeURIComponent(w.days[n - 1].id)}`;
  }
  if (t.hasAttribute('data-newblock')) {
    const bs = blocks(), last = bs[bs.length - 1], n = (last?.number || 0) + 1, id = `b${n}.${uid()}`;
    const tmpl = last?.weeks[last.weeks.length - 1];
    const nb = { id, number: n, name: `Block ${n}`, objective: '', start: '', weeks: [{ n: 1, label: 'Week 1', days: (tmpl?.days || [{ n: 1, label: 'Day 1', items: [] }]).map(d => ({ id: `${id}.w1.d${d.n}`, n: d.n, label: d.label, items: (d.items || []).map(it => ({ ...structuredClone(it), id: uid() })) })) }] };
    saveBlock(nb); setSel({ b: id, w: 1 }); render(true);
  }
  const itemEl = t.closest('[data-item]');
  if (itemEl || t.hasAttribute('data-additem')) {
    const x = findDay(curDayFromHash()), b = structuredClone(x.b), d = b.weeks.find(w => w.n === x.w.n).days.find(dd => dd.id === x.d.id);
    const ii = itemEl ? +itemEl.dataset.item : null;
    if (t.hasAttribute('data-additem')) d.items.push({ id: uid(), classification: '', exercise: '', groups: [{ sets: 3, reps: 8, intensity: '@7', range: '' }], coachNote: null });
    else if (t.hasAttribute('data-rm')) { if (!confirm(`Remove ${d.items[ii].exercise || 'exercise'}?`)) return; d.items.splice(ii, 1); }
    else if (t.dataset.mv) { const j = ii + +t.dataset.mv; if (j < 0 || j >= d.items.length) return; [d.items[ii], d.items[j]] = [d.items[j], d.items[ii]]; }
    else if (t.hasAttribute('data-addg')) { const g = d.items[ii].groups; g.push({ ...(g[g.length - 1] || {}) }); }
    else if (t.hasAttribute('data-rmg')) d.items[ii].groups.splice(+t.closest('[data-g]').dataset.g, 1);
    else return;
    saveBlock(b); ui.keepScroll = true; render(true);
  }
});
$app.addEventListener('input', e => { if (e.target.matches('textarea.note')) { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; } });

// ---------- coach sheet sync ---------------------------------------------------
function loadXLSX() { return window.XLSX ? Promise.resolve(window.XLSX) : new Promise((ok, bad) => { const sc = document.createElement('script'); sc.src = 'vendor/xlsx.full.min.js'; sc.onload = () => ok(window.XLSX); sc.onerror = bad; document.head.appendChild(sc); }); }
export function applySheet(res) {
  // Programme + macrocycle come from the sheet (sheet wins). Results only fill gaps: anything logged in the app wins.
  const nums = new Set(res.blocks.map(b => b.number));
  Object.values(store.all('program')).forEach(b => { if (nums.has(b.number) && !res.blocks.find(x => x.id === b.id)) store.del('program', b.id); });
  res.blocks.forEach(b => store.put('program', b.id, b));
  if (res.macrocycle.length) store.put('meta', 'macrocycle', { weeks: res.macrocycle });
  let added = 0;
  for (const [k, v] of Object.entries(res.logs)) if (!store.get('logs', k)) { store.put('logs', k, v); added++; }
  for (const [k, v] of Object.entries(res.sessions)) if (!store.get('sessions', k)) store.put('sessions', k, v);
  res.bodyweight.forEach(p => { if (!store.get('bodyweight', p.date)) store.put('bodyweight', p.date, p); });
  return added;
}
async function importSheet(file) {
  try {
    const XLSX = await loadXLSX();
    const res = parseWorkbook(gridsFromXLSX(XLSX, XLSX.read(await file.arrayBuffer())));
    const weeks = res.blocks.reduce((n, b) => n + b.weeks.length, 0);
    if (res.errors.length) { ui.syncMsg = `<b class="down">Not synced – please fix the sheet first:</b><br>${res.errors.slice(0, 6).map(esc).join('<br>')}`; ui.keepScroll = true; return render(true); }
    if (!res.blocks.length) { ui.syncMsg = `<b class="down">Nothing imported.</b> ${res.errors.map(esc).join('<br>')}`; return render(true); }
    const added = applySheet(res);
    ui.syncMsg = `<b class="up">Synced ${res.blocks.length} blocks, ${weeks} weeks.</b> ${added} results added from the sheet.` +
      (res.errors.length + res.warnings.length ? `<br><span class="warn">${[...res.errors, ...res.warnings].slice(0, 6).map(esc).join('<br>')}</span>` : '');
  } catch (e) { ui.syncMsg = `<b class="down">Couldn't read that file:</b> ${esc(e.message)}`; }
  ui.keepScroll = true; render(true);
}

document.addEventListener('click', e => { if (e.target.closest('a.ghost-nav')) { ui.silent = true; try { saveGymPage(); } finally { ui.silent = false; } } }, true);
// gym-mode swipe: left = next exercise, right = previous
let tx = null;
document.addEventListener('touchstart', e => { tx = e.target.closest('.gym') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
document.addEventListener('touchend', e => {
  if (!tx) return; const g = document.querySelector('.gym'); const t = e.changedTouches[0], dx = t.clientX - tx.x, dy = t.clientY - tx.y; tx = null;
  if (!g || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const to = dx < 0 ? g.dataset.next : g.dataset.prev; if (to) { ui.silent = true; try { saveGymPage(); } finally { ui.silent = false; } location.hash = to; }
}, { passive: true });

// ---------- boot ----------------------------------------------------------------
render(true);
store.init().then(() => { if (store.role) { ui.role = store.role; ui.locked = true; } render(true); }).catch(e => { $app.innerHTML = header('Sign in') + `<p class="pad">${esc(e.message)}</p><div class="pad"><p>Or paste your phone link here:</p><textarea id="pairIn" rows="4" style="width:100%;font-size:14px"></textarea><p><button id="pairBtn">Pair</button></p></div>`;
  document.getElementById('pairBtn').onclick = () => { const v = decodeURIComponent((document.getElementById('pairIn').value || '').trim()); const m = v.match(/#pair=([^|]+)\|([A-Za-z0-9]+)/); if (!m) { alert('That link doesn\'t look right - copy the whole link.'); return; } localStorage.setItem('ta.pair', JSON.stringify({ url: m[1], key: m[2] })); document.cookie = 'tapair=' + encodeURIComponent(JSON.stringify({ url: m[1], key: m[2] })) + '; max-age=31536000; path=/; SameSite=Strict; Secure'; location.replace(location.pathname + '#/train'); location.reload(); }; });
if ('serviceWorker' in navigator && location.hostname !== '127.0.0.1') navigator.serviceWorker.register('sw.js');
window.__store = store; window.__ui = ui; window.__applySheet = applySheet;
