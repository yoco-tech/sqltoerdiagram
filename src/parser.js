// SQL DDL parser — extracts tables, columns and foreign-key relations from
// CREATE TABLE / ALTER TABLE statements. Tolerant of MySQL, Postgres and
// SQL-Server-ish dialects (backticks, "quotes", [brackets], schema.qualified).
//
// It also records SOURCE SPANS (absolute character offsets into the original
// SQL) for table names, column names, column types and FK references. These
// power two-way editing: editing a table on the canvas becomes a precise text
// splice, so the user's comments / formatting / unsupported clauses survive.
//
// Offsets stay valid because comments are blanked to equal-length whitespace
// rather than removed.

// Replace comments with same-length whitespace (newlines preserved), so every
// offset in the returned string maps 1:1 to the original SQL.
function blankComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
    } else if (c === '#') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === "'" || c === '"' || c === '`') {
      out += c; i++;
      while (i < n) { out += sql[i]; const done = sql[i] === c && sql[i - 1] !== '\\'; i++; if (done) break; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

// Split top-level statements on ';'. Returns [{text, start}] (start = offset).
function splitStatements(S) {
  const out = [];
  let depth = 0, start = 0, q = null;
  for (let i = 0; i < S.length; i++) {
    const c = S[i];
    if (q) { if (c === q && S[i - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ';' && depth === 0) { out.push({ text: S.slice(start, i), start }); start = i + 1; }
  }
  if (S.slice(start).trim()) out.push({ text: S.slice(start), start });
  return out;
}

// Split a parenthesised body on top-level commas. Returns [{text, start}].
function splitTopCommas(body, base) {
  const parts = [];
  let depth = 0, start = 0, q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === q && body[i - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push({ text: body.slice(start, i), start: base + start }); start = i + 1; }
  }
  parts.push({ text: body.slice(start), start: base + start });
  return parts;
}

function clean(id) {
  if (!id) return id;
  id = id.trim();
  return id.replace(/^[`"\[]/, '').replace(/[`"\]]$/, '');
}
function bareName(id) {
  const parts = id.split('.');
  return clean(parts[parts.length - 1]);
}

// Tokenise a definition; each token carries absolute start/end offsets.
function tokenize(def, base) {
  const tokens = [];
  let i = 0;
  const n = def.length;
  while (i < n) {
    const c = def[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') {
      let depth = 0, start = i;
      while (i < n) {
        if (def[i] === '(') depth++;
        if (def[i] === ')') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      tokens.push({ text: def.slice(start, i), start: base + start, end: base + i });
    } else if (c === '`' || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      let start = i; i++;
      while (i < n && def[i] !== close) i++;
      i++;
      tokens.push({ text: def.slice(start, i), start: base + start, end: base + i });
    } else if (c === ',') {
      i++;
    } else {
      let start = i;
      while (i < n && !/[\s(,]/.test(def[i])) i++;
      tokens.push({ text: def.slice(start, i), start: base + start, end: base + i });
    }
  }
  return tokens;
}

function parseColumnsFromParen(group) {
  const inner = group.replace(/^\(/, '').replace(/\)$/, '');
  return splitTopCommas(inner, 0).map(p => bareName(p.text));
}

// Identifier spans for each column listed in a "(a, b, c)" clause, given the
// inner text and its absolute base offset. Used to keep PK/FK/UNIQUE clauses
// in sync when a column is renamed.
function colSpans(innerText, innerBase) {
  const out = [];
  for (const seg of splitTopCommas(innerText, innerBase)) {
    const m = seg.text.match(/\S+/);
    if (!m) continue;
    const raw = m[0];
    let s = seg.start + m.index, e = s + raw.length;
    if (/^[`"\[]/.test(raw)) { s += 1; e -= 1; }
    out.push({ name: bareName(raw).toLowerCase(), start: s, end: e });
  }
  return out;
}

const CREATE_RE = /create\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+|transient\s+|volatile\s+)?table\s+(?:if\s+not\s+exists\s+)?/i;

export function parseSchema(sql) {
  const original = sql || '';
  const S = blankComments(original);
  const statements = splitStatements(S);

  const tables = new Map();   // lowerName -> table object
  const relations = [];
  const errors = [];

  const ensureTable = (name, nameSpan) => {
    const key = name.toLowerCase();
    if (!tables.has(key)) {
      tables.set(key, { name, key, columns: [], colIndex: new Map(), colRefs: [], nameSpan, bodySpan: null });
    } else if (nameSpan && !tables.get(key).nameSpan) {
      tables.get(key).nameSpan = nameSpan;
    }
    return tables.get(key);
  };

  for (const st of statements) {
    const stmt = st.text;
    const base = st.start;
    if (!stmt.trim()) continue;

    const cm = stmt.match(CREATE_RE);
    if (cm) {
      const afterStart = cm.index + cm[0].length;
      const after = stmt.slice(afterStart);
      const open = after.indexOf('(');
      if (open < 0) continue;
      // table name token sits between afterStart and the '('
      const nameRegion = after.slice(0, open);
      const rawNameMatch = nameRegion.match(/(\S+)/);
      if (!rawNameMatch) continue;
      const rawName = rawNameMatch[1];
      const nameLocal = afterStart + rawNameMatch.index;
      // span covers the bare table name (last dotted part) for clean rename
      const dotIdx = rawName.lastIndexOf('.');
      const bareStart = nameLocal + (dotIdx >= 0 ? dotIdx + 1 : 0);
      const name = bareName(rawName);
      const nameSpan = [base + bareStart, base + nameLocal + rawName.length];

      // balanced body
      let depth = 0, end = -1;
      for (let i = open; i < after.length; i++) {
        if (after[i] === '(') depth++;
        if (after[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) { errors.push(`Unbalanced parens in table "${name}"`); continue; }
      const bodyLocal = afterStart + open + 1;
      const body = after.slice(open + 1, end);
      const table = ensureTable(name, nameSpan);
      table.bodySpan = [base + bodyLocal, base + afterStart + end];
      parseTableBody(body, base + bodyLocal, table, relations);
      continue;
    }

    // ALTER TABLE [ONLY] x ADD [CONSTRAINT y] FOREIGN KEY (a) REFERENCES z (b)
    // (pg_dump emits "ALTER TABLE ONLY schema.table")
    const am = stmt.match(/alter\s+table\s+(?:only\s+)?([^\s(]+(?:\.[^\s(]+)?)\s+add\s+/is);
    if (am) {
      const t = bareName(am[1]);
      const tail = stmt.slice(am.index + am[0].length);
      const tailBase = base + am.index + am[0].length;
      const rel = parseForeignKey(tail, tailBase, t);
      if (rel) relations.push(rel);
    }
  }

  // resolve relations; mark fk columns
  const tableList = [...tables.values()];
  const resolved = [];
  for (const r of relations) {
    const from = tables.get(r.fromTable.toLowerCase());
    const to = tables.get(r.toTable.toLowerCase());
    if (!from) continue;
    for (const c of r.fromCols) {
      const col = from.colIndex.get(c.toLowerCase());
      if (col) col.fk = true;
    }
    resolved.push({
      fromTable: from.name,
      fromCols: r.fromCols,
      toTable: to ? to.name : r.toTable,
      toCols: r.toCols,
      toMissing: !to,
      refSpan: r.refSpan || null,
    });
  }

  return { tables: tableList, relations: resolved, errors, sql: original };
}

function parseTableBody(body, base, table, relations) {
  const items = splitTopCommas(body, base);
  for (const part of items) {
    const item = part.text;
    if (!item.trim()) continue;
    const tokens = tokenize(item, part.start);
    if (!tokens.length) continue;
    const head = clean(tokens[0].text).toLowerCase();

    if (head === 'primary' && tokens[1] && /key/i.test(tokens[1].text)) {
      markKeyCols(tokens, table, 'pk');
      continue;
    }
    if (head === 'unique') {
      markKeyCols(tokens, table, 'unique');
      continue;
    }
    if (head === 'foreign' && tokens[1] && /key/i.test(tokens[1].text)) {
      const rel = parseForeignKey(item, part.start, table.name);
      if (rel) { relations.push(rel); table.colRefs.push(...rel.localColSpans); }
      continue;
    }
    if (head === 'constraint') {
      if (/foreign\s+key/i.test(item)) {
        const rel = parseForeignKey(item, part.start, table.name);
        if (rel) { relations.push(rel); table.colRefs.push(...rel.localColSpans); }
      } else if (/primary\s+key/i.test(item)) {
        markKeyCols(tokens, table, 'pk');
      }
      continue;
    }
    if (head === 'key' || head === 'index' || head === 'check' ||
        head === 'fulltext' || head === 'spatial') continue;

    // column definition
    const nameTok = tokens[0];
    const colName = bareName(nameTok.text);
    if (!colName) continue;
    // name span = bare identifier (strip wrapping quotes from the token span)
    let ns = nameTok.start, ne = nameTok.end;
    if (/^[`"\[]/.test(nameTok.text)) { ns += 1; ne -= 1; }

    let type = '', typeSpan = null;
    if (tokens[1] && !/^\(/.test(tokens[1].text)) {
      const t1 = tokens[1];
      type = clean(t1.text);
      typeSpan = [t1.start, t1.end];
      if (tokens[2] && tokens[2].text.startsWith('(')) { // e.g. varchar (255)
        type += tokens[2].text;
        typeSpan = [t1.start, tokens[2].end];
      } else if (t1.text.includes('(')) {
        type = t1.text;
      }
    }

    const rest = item.toLowerCase();
    const col = {
      name: colName,
      type: prettyType(type),
      typeRaw: type,
      pk: /\bprimary\s+key\b/.test(rest),
      nn: /\bnot\s+null\b/.test(rest),
      unique: /\bunique\b/.test(rest),
      fk: false,
      nameSpan: [ns, ne],
      typeSpan,
    };
    table.columns.push(col);
    table.colIndex.set(colName.toLowerCase(), col);

    // inline REFERENCES other(col)
    const refm = item.match(/references\s+([^\s(]+(?:\.[^\s(]+)?)\s*(\([^)]*\))?/id);
    if (refm) {
      col.fk = true;
      const toTable = bareName(refm[1]);
      const toCols = refm[2] ? parseColumnsFromParen(refm[2]) : [];
      const gi = refm.indices[1];
      const dotIdx = refm[1].lastIndexOf('.');
      const refStart = part.start + gi[0] + (dotIdx >= 0 ? dotIdx + 1 : 0);
      relations.push({
        fromTable: table.name,
        fromCols: [colName],
        toTable,
        toCols,
        refSpan: [refStart, part.start + gi[1]],
      });
    }
  }
}

// Mark a table-level key clause's columns and record their spans for renames.
function markKeyCols(tokens, table, flag) {
  const grp = tokens.find(t => t.text.startsWith('('));
  if (!grp) return;
  for (const ref of colSpans(grp.text.slice(1, -1), grp.start + 1)) {
    const col = table.colIndex.get(ref.name);
    if (col) col[flag] = true;
    table.colRefs.push(ref);
  }
}

function parseForeignKey(text, base, fromTable) {
  const m = text.match(
    /foreign\s+key\s*\(([^)]*)\)\s*references\s+([^\s(]+(?:\.[^\s(]+)?)\s*(\(([^)]*)\))?/id
  );
  if (!m) return null;
  const fromCols = m[1].split(',').map(s => bareName(s)).filter(Boolean);
  const toTable = bareName(m[2]);
  const toCols = m[4] ? m[4].split(',').map(s => bareName(s)).filter(Boolean) : [];
  const gi = m.indices[2];
  const dotIdx = m[2].lastIndexOf('.');
  const refStart = base + gi[0] + (dotIdx >= 0 ? dotIdx + 1 : 0);
  const localColSpans = colSpans(m[1], base + m.indices[1][0]);
  return { fromTable, fromCols, toTable, toCols, refSpan: [refStart, base + gi[1]], localColSpans };
}

function prettyType(t) {
  if (!t) return '';
  const m = t.match(/^([a-zA-Z_]+)(.*)$/s);
  if (!m) return t.toLowerCase();
  return m[1].toLowerCase() + (m[2] || '').replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// BigQuery parser — extracts CTEs from WITH ... AS (...) blocks.
//
// Each CTE becomes a table node. Columns are derived from the SELECT list
// (aliases preferred; bare expressions get a generated name). Relations are
// inferred from FROM / JOIN references to other CTEs or backtick-quoted BQ
// table refs (`project.dataset.table`).
// ---------------------------------------------------------------------------

// Strip single-line (--) and block (/* */) comments, preserving newlines.
function stripCommentsBQ(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i], c2 = sql[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += '  '; i += 2; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

// Find the matching closing paren for the '(' at position `start`.
function findClose(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
    else if (s[i] === '`') { i++; while (i < s.length && s[i] !== '`') i++; }
    else if (s[i] === "'") { i++; while (i < s.length && s[i] !== "'") i++; }
    else if (s[i] === '"') { i++; while (i < s.length && s[i] !== '"') i++; }
  }
  return -1;
}

// Extract top-level comma-separated segments (depth-aware, quote-aware).
function topSegments(s) {
  const segs = [];
  let depth = 0, start = 0, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(' || c === '[') { depth++; i++; continue; }
    if (c === ')' || c === ']') { depth--; i++; continue; }
    if (c === '`' || c === "'" || c === '"') {
      const q = c; i++;
      while (i < s.length && s[i] !== q) i++;
      i++; continue;
    }
    if (c === ',' && depth === 0) { segs.push(s.slice(start, i).trim()); start = i + 1; }
    i++;
  }
  const last = s.slice(start).trim();
  if (last) segs.push(last);
  return segs;
}

// Bare identifier from a possibly-quoted / backtick token (last dotted part).
function bareId(tok) {
  if (!tok) return '';
  tok = tok.trim().replace(/^`/, '').replace(/`$/, '')
           .replace(/^"/, '').replace(/"$/, '');
  const parts = tok.split('.');
  return parts[parts.length - 1].trim();
}

// Column name from a SELECT expression: alias wins, else last bare word.
function colNameFromExpr(expr) {
  expr = expr.trim();
  // AS alias (possibly quoted)
  const asM = expr.match(/\bas\s+(`[^`]+`|"[^"]+"|[\w$]+)\s*$/i);
  if (asM) return bareId(asM[1]);
  // plain `table`.`col` or table.col — last dotted segment
  const lastTok = expr.match(/(`[^`]+`|[\w$]+)\s*$/);
  if (lastTok) return bareId(lastTok[1]);
  return null;
}

// Extract table/CTE names referenced in a FROM / JOIN clause body.
// Returns an array of bare names (lower-case).
function refsFromBody(body) {
  const names = [];
  // Match FROM / JOIN followed by a backtick ref or plain identifier (no subquery)
  const re = /\b(?:from|join)\s+(`[^`]+`(?:\.[`\w]+)*|[\w$]+(?:\.[\w$]+)*)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    // skip if the match is actually a subquery keyword
    const name = m[1].trim();
    if (/^\(/.test(name) || name.includes('(')) continue;
    names.push(bareId(name).toLowerCase());
  }
  return names;
}

export function parseBigQuerySchema(sql) {
  const original = sql || '';
  const S = stripCommentsBQ(original);
  const errors = [];
  const tables = [];   // ordered CTE list
  const tableIndex = new Map();  // lower name -> table object
  const relations = [];

  // Match the WITH keyword that opens the CTE block. We scan for
  // WITH <name> AS ( iteratively to handle multiple CTEs.
  // Strategy: find "WITH" at statement start, then repeatedly consume
  // cte_name AS ( body ).
  const withM = S.match(/\bwith\b/i);
  if (!withM) {
    return { tables, relations, errors: ['No WITH block found'], sql: original };
  }

  let pos = withM.index + withM[0].length;

  // Consume CTEs: name AS ( body ) [,] ...
  const cteRe = /\s*([`"]?[\w$]+[`"]?)(?:\s*\([^)]*\))?\s+as\s*\(/iy;
  while (pos < S.length) {
    cteRe.lastIndex = pos;
    const nameM = cteRe.exec(S);
    if (!nameM) break;

    const cteName = bareId(nameM[1]);
    const openParen = nameM.index + nameM[0].length - 1;
    const closeIdx = findClose(S, openParen);
    if (closeIdx < 0) { errors.push(`Unbalanced parens in CTE "${cteName}"`); break; }

    const body = S.slice(openParen + 1, closeIdx);

    // -- derive columns from SELECT list --
    const selectM = body.match(/\bselect\b([\s\S]*?)(?:\bfrom\b|$)/i);
    const cols = [];
    if (selectM) {
      const selectList = selectM[1].trim();
      if (selectList === '*') {
        // wildcard — no column info available
      } else {
        let n = 1;
        for (const seg of topSegments(selectList)) {
          if (!seg || seg === '*') continue;
          const name = colNameFromExpr(seg) || `col${n}`;
          cols.push({ name, type: '', pk: false, nn: false, unique: false, fk: false,
                      nameSpan: null, typeSpan: null });
          n++;
        }
      }
    }

    const key = cteName.toLowerCase();
    const tableObj = {
      name: cteName,
      key,
      columns: cols,
      colIndex: new Map(cols.map(c => [c.name.toLowerCase(), c])),
      colRefs: [],
      nameSpan: null,
      bodySpan: null,
    };
    tables.push(tableObj);
    tableIndex.set(key, tableObj);

    // advance past closing paren, skip optional comma
    pos = closeIdx + 1;
    const afterClose = S.slice(pos).match(/^\s*,/);
    if (afterClose) pos += afterClose[0].length;
    else break; // no comma → end of CTE list
  }

  // -- infer relations from FROM / JOIN references inside each CTE --
  // Re-parse: go back over the original stripped SQL for each CTE body.
  // We need body text. Re-extract using the same CTE name order.
  {
    const withMatch = S.match(/\bwith\b/i);
    let scanPos = withMatch ? withMatch.index + withMatch[0].length : 0;
    for (const t of tables) {
      // locate "name AS (" in remaining text
      const re = new RegExp(`\\b${t.name}\\b\\s+as\\s*\\(`, 'i');
      const m = re.exec(S.slice(scanPos));
      if (!m) continue;
      const absOpen = scanPos + m.index + m[0].length - 1;
      const absClose = findClose(S, absOpen);
      if (absClose < 0) continue;
      const body = S.slice(absOpen + 1, absClose);

      for (const refName of refsFromBody(body)) {
        const toTable = tableIndex.get(refName);
        // relation to another CTE
        if (toTable && toTable.key !== t.key) {
          relations.push({
            fromTable: t.name,
            fromCols: [],
            toTable: toTable.name,
            toCols: [],
            toMissing: false,
            refSpan: null,
          });
        }
        // relation to a base table (backtick-quoted BQ ref not matching any CTE)
        // — these appear as `project.dataset.table` in the original SQL
        if (!toTable) {
          // find the full backtick ref for display
          const btRe = new RegExp('`[^`]*\\.' + refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^`]*`', 'i');
          const btM = body.match(btRe);
          const displayName = btM ? bareId(btM[0]) : refName;
          // only add a relation if we haven't already added one for this source
          const key = displayName.toLowerCase();
          if (!tableIndex.has(key)) {
            // create a stub table for the base ref
            const stub = {
              name: displayName,
              key,
              columns: [],
              colIndex: new Map(),
              colRefs: [],
              nameSpan: null,
              bodySpan: null,
            };
            tables.push(stub);
            tableIndex.set(key, stub);
          }
          relations.push({
            fromTable: t.name,
            fromCols: [],
            toTable: displayName,
            toCols: [],
            toMissing: false,
            refSpan: null,
          });
        }
      }
      scanPos = absClose + 1;
    }
  }

  // deduplicate relations (same fromTable + toTable pair)
  const seen = new Set();
  const dedupedRelations = relations.filter(r => {
    const k = r.fromTable.toLowerCase() + '→' + r.toTable.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { tables, relations: dedupedRelations, errors, sql: original };
}
