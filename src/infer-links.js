// Heuristic auto-linking by column name.
//
// Extracted from Diagram.inferLinks so the same logic can run headless (the
// CLI) as well as in the browser. Pure function: takes a parsed model and
// returns *new* relations in model shape — { fromTable, fromCols, toTable,
// toCols } — that aren't already present in model.relations.
//
// `existing` is an optional extra list of already-known links (e.g. links a
// user has drawn manually in the browser) to dedupe against; each entry may be
// in relation shape or in { from:{table,col}, to:{table,col} } shape.
export function inferLinks(model, existing = []) {
  const tables = model.tables || [];
  const pkByCol = new Map();     // lowercased PK col name -> [tableKey]
  const tableByName = new Map(); // name forms -> key
  for (const t of tables) {
    for (const c of t.columns) if (c.pk) {
      const k = c.name.toLowerCase();
      if (!pkByCol.has(k)) pkByCol.set(k, []);
      pkByCol.get(k).push(t.key);
    }
    tableByName.set(t.key, t.key);
    tableByName.set(t.key.replace(/(es|s)$/, ''), t.key);
  }

  const seen = new Set();
  const ek = (a, c, b, d) => `${a}.${(c || '').toLowerCase()}->${b}.${(d || '').toLowerCase()}`;
  for (const r of model.relations || []) {
    seen.add(ek(r.fromTable.toLowerCase(), r.fromCols[0] || '', r.toTable.toLowerCase(), r.toCols[0] || ''));
  }
  for (const l of existing) {
    if (l.from) seen.add(ek(l.from.table, l.from.col, l.to.table, l.to.col));
    else seen.add(ek(l.fromTable.toLowerCase(), l.fromCols[0] || '', l.toTable.toLowerCase(), l.toCols[0] || ''));
  }

  const added = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.pk) continue;
      const cl = c.name.toLowerCase();
      let tk = null, tc = null;
      // 1) column name matches exactly one other table's PK column
      if (pkByCol.has(cl)) {
        const owners = pkByCol.get(cl).filter(k => k !== t.key);
        if (owners.length === 1) { tk = owners[0]; tc = c.name; }
      }
      // 2) <foo>_id / <foo>id / <foo>_uuid -> table foo / foos, on matching column or PK
      if (!tk) {
        const m = cl.match(/^(.+?)_?(id|uuid)$/);
        if (m && m[1]) {
          const cand = tableByName.get(m[1]) || tableByName.get(m[1] + 's') || tableByName.get(m[1] + 'es');
          if (cand && cand !== t.key) {
            const cols = (tables.find(x => x.key === cand)?.columns || []);
            const col = cols.find(x => x.name.toLowerCase() === m[2]) || cols.find(x => x.pk);
            if (col) { tk = cand; tc = col.name; }
          }
        }
      }
      if (tk && !seen.has(ek(t.key, c.name, tk, tc)) && !seen.has(ek(tk, tc, t.key, c.name))) {
        seen.add(ek(t.key, c.name, tk, tc));
        added.push({ fromTable: t.key, fromCols: [c.name], toTable: tk, toCols: [tc] });
      }
    }
  }
  return added;
}
