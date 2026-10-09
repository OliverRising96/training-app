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
  const o = {}; wb.SheetNames.forEach(n => { o[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '', blankrows: true }); }); return o;
}
