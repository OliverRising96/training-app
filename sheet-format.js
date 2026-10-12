// Parser for the coach sheet template ("Training Template.xlsx" / its Google Sheets copy).
// Input: { [tabName]: string[][] } – each tab as rows of cell *display text* (row 0 = sheet row 1).
// Output: { blocks, macrocycle, logs, sessions, bodyweight, errors, warnings } in the app's data model.
// Layout contract is documented in tools/make_template.py and on the sheet's Instructions tab.
export const COLS = ['Classification', 'Exercise', 'Sets', 'Reps', 'Intensity', 'Kg range', 'Coach notes',
  'Weight used (kg)', 'Reps achieved', 'RPE', 'e1RM (kg)', 'Athlete notes'];
const SESSION = { 'date': 'date', 'training day': 'day', 'session length (mins)': 'length', 'session rpe': 'rpe' };

const clean = v => { const s = String(v ?? '').replace(/\u00a0/g, ' ').trim(); return s === '' ? null : s; };
const numOrText = v => { const s = clean(v); if (s == null) return null; return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s; };
const ukDate = v => { const s = clean(v); if (!s) return null; let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; m = s.match(/^\d{4}-\d{2}-\d{2}$/); return m ? s : null; };
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const list = v => { const s = clean(v); if (s == null) return []; return s.split(/\s*[,/;]\s*/).map(p => p === '' ? null : numOrText(p.replace(/\s*kg$/i, ''))); };

export function parseWorkbook(sheets) {
  const out = { blocks: [], macrocycle: [], logs: {}, sessions: {}, bodyweight: [], errors: [], warnings: [], cells: {}, sessCells: {} };
  // cells: logKey -> {tab,row,c0,exRow,exercise} (0-based) so results can be written back into the green columns
  const cell = (g, r, c) => clean(g[r]?.[c]);

  // ---- Macrocycle: header row then one row per week ----
  const mc = sheets['Macrocycle'];
  if (mc) {
    const h = (mc[0] || []).map(x => (clean(x) || '').toLowerCase());
    const ix = n => h.indexOf(n);
    if (ix('week commencing') < 0) out.errors.push('Macrocycle: first row must be the header (Week commencing, Block, Week, Key moment, Objective).');
    else for (let r = 1; r < mc.length; r++) {
      const wc = ukDate(mc[r][ix('week commencing')]); if (!wc) { if (clean(mc[r][0])) out.warnings.push(`Macrocycle row ${r + 1}: date should look like 14/09/2026`); continue; }
      const bl = numOrText(mc[r][ix('block')]), wk = numOrText(mc[r][ix('week')]);
      out.macrocycle.push({ wc, block: typeof bl === 'number' ? bl : null, week: typeof wk === 'number' ? wk : null, moment: cell(mc, r, ix('key moment')), objective: cell(mc, r, ix('objective')) });
    }
  }

  // ---- Block tabs ----
  for (const [name, g] of Object.entries(sheets)) {
    const m = name.trim().match(/^block\s*(\d+)$/i); if (!m) continue;
    const n = +m[1], bid = `b${n}`;
    const block = { id: bid, number: n, name: `Block ${n}`, objective: cell(g, 1, 1), start: ukDate(g[2]?.[1]), weeks: [] };
    // week groups: any "WEEK n" label in the first 6 rows
    const weekCols = [];
    for (let r = 0; r < 6; r++) (g[r] || []).forEach((v, c) => { const w = (clean(v) || '').match(/^week\s*(\d+)/i); if (w && !weekCols.find(x => x.c === c)) weekCols.push({ c, n: +w[1], r }); });
    if (!weekCols.length) { out.errors.push(`${name}: no "WEEK n" labels found in rows 1–6.`); continue; }
    for (const wc of weekCols.sort((a, b) => a.c - b.c)) {
      const c0 = wc.c, week = { n: wc.n, label: `Week ${wc.n}`, days: [] };
      for (let r = wc.r + 1; r < g.length; r++) {
        const dm = (cell(g, r, c0) || '').match(/^day\s*(\d+)/i); if (!dm) continue;
        const dn = +dm[1], did = `${bid}.w${wc.n}.d${dn}`, where = `${name} · Week ${wc.n} · Day ${dn}`;
        const hdr = COLS.map((_, j) => (cell(g, r + 1, c0 + j) || '').toLowerCase());
        const bad = COLS.findIndex((h, j) => hdr[j] !== h.toLowerCase());
        if (bad >= 0) { out.errors.push(`${where}: header "${COLS[bad]}" expected in row ${r + 2} – columns may have been moved or renamed.`); continue; }
        const day = { id: did, n: dn, label: `Day ${dn}`, items: [] }; const seen = {}; let cur = null, sess = {}, sessRows = {}, curRow = null;
        for (let rr = r + 2; rr < g.length; rr++) {
          const first = (cell(g, rr, c0) || '').toLowerCase();
          if (/^day\s*\d+/.test(first) || /^week\s*\d+/.test(first)) break;
          if (first in SESSION) { sessRows[SESSION[first]] = rr; const v = cell(g, rr, c0 + 1); if (v != null) sess[SESSION[first]] = first === 'date' ? (ukDate(v) || v) : numOrText(v); if (first === 'session rpe') break; continue; }
          const v = COLS.map((_, j) => cell(g, rr, c0 + j));
          const [cls, ex, sets, reps, inten, range, cnote, used, ach, rpe, , anote] = v;
          if (v.every((x, j) => x == null || j === 10)) continue;
          if (ex) {
            const base = slug(ex) || 'exercise'; seen[base] = (seen[base] || 0) + 1;
            cur = { id: `${did}.${base}${seen[base] > 1 ? '-' + seen[base] : ''}`, classification: cls || (day.items.at(-1)?.classification ?? null), exercise: ex, groups: [], coachNote: cnote };
            day.items.push(cur); curRow = rr;
          } else if (!cur) { out.warnings.push(`${where}, row ${rr + 1}: values without an exercise name – ignored.`); continue; }
          else if (cnote) cur.coachNote = [cur.coachNote, cnote].filter(Boolean).join(' · ');
          if (sets != null && !/^\d+$/.test(sets)) out.warnings.push(`${where}, row ${rr + 1}: Sets should be a whole number (got "${sets}").`);
          const gi = cur.groups.length;
          out.cells[`${cur.id}.${gi}`] = { tab: name, row: rr, c0, exRow: curRow, exercise: cur.exercise };
          cur.groups.push({ sets: /^\d+$/.test(sets || '') ? +sets : null, reps: numOrText(reps), intensity: numOrText(inten), range: numOrText(range) });
          if (used || ach || rpe || anote) {
            const W = list(used), R = list(ach), P = list(rpe), cnt = Math.max(+sets || 1, W.length, R.length);
            const pick = (a, i) => a.length === 1 ? a[0] : a[i] ?? null, setsOut = [];
            for (let i = 0; i < cnt; i++) {
              let kg = pick(W, i); if (kg == null && W.length > 1 && i >= W.length) kg = W[W.length - 1];
              const s = { kg, reps: pick(R, i), rpe: pick(P, i) };
              if (s.kg != null || s.reps != null || s.rpe != null) setsOut.push(s);
            }
            out.logs[`${cur.id}.${gi}`] = { sets: setsOut, raw: { kg: used, reps: ach, rpe }, note: anote, imported: true };
          }
        }
        if (Object.keys(sess).length) out.sessions[did] = sess;
        if (Object.keys(sessRows).length) out.sessCells[did] = { tab: name, c0, rows: sessRows };
        if (day.items.length) week.days.push(day);
      }
      if (week.days.length) block.weeks.push(week);
    }
    block.weeks.sort((a, b) => a.n - b.n);
    out.blocks.push(block);
  }
  out.blocks.sort((a, b) => a.number - b.number);
  if (!out.blocks.length) out.errors.push('No tabs named "Block 1", "Block 2", … were found.');

  // ---- Bodyweight ----
  const bw = sheets['Bodyweight'];
  if (bw) for (let r = 1; r < bw.length; r++) { const d = ukDate(bw[r][0]), kg = numOrText(bw[r][1]); if (d && typeof kg === 'number') out.bodyweight.push({ date: d, kg }); }
  return out;
}

// SheetJS workbook → { tab: string[][] } using each cell's displayed text.
export function gridsFromXLSX(XLSX, wb) {
  const o = {}; wb.SheetNames.forEach(n => { const ws = wb.Sheets[n], g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
    // anchor at A1 like Apps Script getDataRange(), even when the used range starts later
    const st = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s : { r: 0, c: 0 };
    o[n] = [...Array(st.r).fill(0).map(() => []), ...g.map(r => [...Array(st.c).fill(''), ...r])]; }); return o;
}

// ---------------------------------------------------------------------------
// Parser for the coach's ORIGINAL "OR Macrocycle" layout, read as display text (Apps Script
// getDisplayValues), so '10-12' / '120,125' / '2:29' arrive exactly as shown. Same output shape
// and the same item ids as parseWorkbook, so logs carry over between the two formats.
// cells[logKey] = { book:'original', tab, row, kgCol, repsCol, rpeCol, noteCol, exRow, exCol, exercise }
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function anyDate(v) {
  const s = clean(v); if (!s) return null;
  let m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,4})[-\s/](\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return ukDate(s);
}
export function isOriginalFormat(sheets) { return (sheets['Macrocycle'] || []).some(r => r.some(c => /MACROCYCLE OVERVIEW/i.test(String(c)))); }

export function parseOriginal(sheets, year = 2026) {
  const out = { blocks: [], macrocycle: [], logs: {}, sessions: {}, bodyweight: [], errors: [], warnings: [], cells: {}, sessCells: {}, format: 'original' };
  const cell = (g, r, c) => clean(g[r]?.[c]);

  // ---- Macrocycle (horizontal: rows labelled w/c, Key Moments, Training Block, Objective, Training Week) ----
  const mg = sheets['Macrocycle'];
  if (mg) {
    const rowOf = lab => mg.findIndex(r => (clean(r[1]) || '').toLowerCase() === lab);
    const rWc = rowOf('w/c'), rKm = rowOf('key moments'), rTb = rowOf('training block'), rOb = rowOf('objective'), rTw = rowOf('training week');
    if (rWc < 0) out.errors.push('Macrocycle: no "w/c" row found.');
    else {
      let curB = null, curO = null;
      for (let c = 2; c < mg[rWc].length; c++) {
        const wc = cell(mg, rWc, c); if (!wc) continue;
        const [d, mo] = wc.split('.'); if (!mo) continue;
        const tb = rTb >= 0 ? cell(mg, rTb, c) : null, ob = rOb >= 0 ? cell(mg, rOb, c) : null, tw = rTw >= 0 ? cell(mg, rTw, c) : null;
        if (tb != null) curB = tb; if (ob != null) curO = ob;
        const wk = /^\d+$/.test(tw || '') ? +tw : null, bl = wk && /^\d+$/.test(curB || '') ? +curB : null;
        out.macrocycle.push({ wc: `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`, moment: rKm >= 0 ? cell(mg, rKm, c) : null, block: bl, week: wk, objective: bl || curB === 'N/A' ? curO : null });
      }
    }
  }
  const starts = {}; out.macrocycle.forEach(w => { if (w.block && !starts[w.block]) starts[w.block] = w; });

  // ---- Block tabs ----
  for (const [name, g] of Object.entries(sheets)) {
    const bm = name.trim().match(/^block\s*(\d+)$/i); if (!bm) continue;
    const n = +bm[1], bid = `b${n}`;
    const block = { id: bid, number: n, name: `Block ${n}`, objective: starts[n]?.objective ?? null, start: starts[n]?.wc ?? null, weeks: [] };
    const weekLabels = [];
    for (let r = 0; r < Math.min(10, g.length); r++) (g[r] || []).forEach((v, c) => { const w = (clean(v) || '').match(/^week\s*(\d+)/i); if (w) weekLabels.push({ c, n: +w[1] }); });
    const weeks = {};
    for (let hr = 0; hr < Math.min(g.length, 130); hr++) for (let sc = 0; sc < (g[hr] || []).length; sc++) {
      if (cell(g, hr, sc) !== 'Sets' || cell(g, hr, sc + 1) !== 'Reps' || cell(g, hr, sc - 1) === 'Notes') continue;
      const own = (cell(g, hr, sc - 2) || '') === 'Classification';
      const clsC = own ? sc - 2 : 1, exC = own ? sc - 1 : 2;
      const wl = weekLabels.filter(w => w.c <= sc).sort((a, b) => b.c - a.c)[0]; if (!wl) continue;
      let dn = null;
      for (let r = hr - 1; r >= 0; r--) { const m = (cell(g, r, clsC) || '').match(/^day\s*(\d+)/i); if (m) { dn = +m[1]; break; } }
      if (dn == null) continue;
      const did = `${bid}.w${wl.n}.d${dn}`, wk = weeks[wl.n] ||= { n: wl.n, label: `Week ${wl.n}`, days: {} };
      const day = { id: did, n: dn, label: `Day ${dn}`, items: [] }, seen = {}, sess = {}, sessRows = {}, sessLabels = {};
      let cur = null, curRow = null;
      for (let r = hr + 1; r < Math.min(g.length, hr + 16); r++) {
        const cv = cell(g, r, clsC) || '';
        if (/^day\s*\d+/i.test(cv) || /^other/i.test(cv) || cv === 'Classification') break;
        const lab = (cell(g, r, sc + 7) || '').toLowerCase();
        if (['training day', 'session length', 'session rpe'].includes(lab)) {
          const key = { 'training day': 'day', 'session length': 'length', 'session rpe': 'rpe' }[lab];
          if (!(key in sessRows)) { sessRows[key] = r; sessLabels[key] = cell(g, r, sc + 7); const v = cell(g, r, sc + 8); if (v != null) sess[key] = numOrText(v); }
          continue;
        }
        const ex = cell(g, r, exC), cl = cell(g, r, clsC), sets = cell(g, r, sc);
        const v = Array.from({ length: 9 }, (_, k) => cell(g, r, sc + k));
        if (ex == null && sets == null && !v.slice(1).some(x => x != null)) continue;
        if (ex != null) {
          const base = slug(ex) || 'exercise'; seen[base] = (seen[base] || 0) + 1;
          cur = { id: `${did}.${base}${seen[base] > 1 ? '-' + seen[base] : ''}`, classification: cl || (day.items.at(-1)?.classification ?? null), exercise: ex.replace(/\s+/g, ' '), groups: [], coachNote: null };
          day.items.push(cur); curRow = r;
        }
        if (!cur) continue;
        if (sets != null && !/^\d+(\.0+)?$/.test(sets)) { cur.coachNote = sets; continue; }
        const [, reps, inten, rng, used, ach, rpe, , note] = v, gi = cur.groups.length;
        cur.groups.push({ sets: sets != null ? parseInt(sets, 10) : null, reps: numOrText(reps), intensity: numOrText(inten), range: numOrText(rng) });
        out.cells[`${cur.id}.${gi}`] = { book: 'original', tab: name, row: r, kgCol: sc + 4, repsCol: sc + 5, rpeCol: sc + 6, noteCol: sc + 8, exRow: curRow, exCol: exC, exercise: cur.exercise, hasData: !!(used || ach || rpe) };
        if (used || ach || rpe || note) {
          const W = list(used), R = list(ach), P = list(rpe), cnt = Math.max(parseInt(sets, 10) || 1, W.length > 1 ? W.length : 0, R.length > 1 ? R.length : 0);
          const pick = (a, i) => a.length === 1 ? a[0] : a[i] ?? null, so = [];
          for (let i = 0; i < cnt; i++) {
            let kg = pick(W, i); if (kg == null && W.length > 1 && i >= W.length) kg = W[W.length - 1];
            const s = { kg, reps: pick(R, i), rpe: pick(P, i) }; if (s.kg != null || s.reps != null || s.rpe != null) so.push(s);
          }
          out.logs[`${cur.id}.${gi}`] = { sets: so, raw: { kg: used, reps: ach, rpe }, note, imported: true };
        }
      }
      day.items.forEach((it, i) => { if (!it.classification && i) it.classification = day.items[i - 1].classification; });
      if (Object.keys(sess).length) out.sessions[did] = sess;
      if (Object.keys(sessRows).length) out.sessCells[did] = { book: 'original', tab: name, labelCol: sc + 7, valueCol: sc + 8, rows: sessRows, labels: sessLabels };
      if (day.items.length) wk.days[dn] = day;
    }
    block.weeks = Object.values(weeks).sort((a, b) => a.n - b.n).map(w => ({ ...w, days: Object.values(w.days).sort((a, b) => a.n - b.n) })).filter(w => w.days.length);
    out.blocks.push(block);
  }
  out.blocks.sort((a, b) => a.number - b.number);
  if (!out.blocks.length) out.errors.push('No "Block N" tabs found in the original sheet.');
  const bw = sheets['Bodyweight Tracker'] || sheets['Bodyweight'];
  if (bw) bw.forEach(r => { const d = anyDate(r[1]), kg = numOrText(r[2]); if (d && typeof kg === 'number') out.bodyweight.push({ date: d, kg }); });
  return out;
}
