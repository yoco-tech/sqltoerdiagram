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
  // Strip a *matched* wrapping delimiter pair only: `id`, "id", [id].
  // Stripping the sides independently would mangle e.g. the type TEXT[]
  // (no leading '[') into TEXT[ by dropping the trailing ']'.
  const close = { '`': '`', '"': '"', '[': ']' }[id[0]];
  if (id.length >= 2 && close && id[id.length - 1] === close) return id.slice(1, -1);
  return id;
}
function bareName(id) {
  const parts = identifierParts(id);
  return clean(parts[parts.length - 1]);
}
// Qualifier directly before the bare name ("db.sales.orders" -> "sales").
function schemaName(id) {
  const parts = identifierParts(id);
  return parts.length > 1 ? clean(parts[parts.length - 2]) : null;
}

function identifierParts(identifier) {
  return (identifier.match(/"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^.]+/g) || []).map(part => part.trim());
}

function identifierKey(identifier) {
  const value = identifier.trim();
  if (value.startsWith('"')) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return clean(value).toLowerCase();
}

function qualifiedTableKey(identifier) {
  const parts = identifierParts(identifier);
  return JSON.stringify([parts.length > 1 ? identifierKey(parts.at(-2)) : 'public', identifierKey(parts.at(-1))]);
}

function columnType(tokens) {
  const end = tokens.findIndex((token, index) => index > 0 && /^(?:not|null|default|primary|unique|references|check|constraint|collate|generated)$/i.test(token.text));
  const typeTokens = tokens.slice(1, end < 0 ? undefined : end);
  return typeTokens.map(token => token.text).join(' ')
    .replace(/"(?:[^"]|"")*"|[^"]+/g, part => part.startsWith('"') ? part : part.toLowerCase().replace(/\s*([().,])\s*/g, '$1'));
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
    out.push({ name: bareName(raw).toLowerCase(), key: identifierKey(raw), start: s, end: e });
  }
  return out;
}

const CREATE_RE = /create\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+|transient\s+|volatile\s+)?table\s+(?:if\s+not\s+exists\s+)?/i;

export function parseSchema(sql, { qualifiedNames = false } = {}) {
  const original = sql || '';
  const S = blankComments(original);
  const statements = splitStatements(S);

  const tables = new Map();   // lowerName -> table object
  const relations = [];
  const errors = [];
  const comments = [];        // {kind: 'table'|'column', target, text|null}
  const enums = new Map();    // lowerBareTypeName -> [values]
  const keyConstraints = [];

  const tableKey = rawName => qualifiedNames ? qualifiedTableKey(rawName) : bareName(rawName).toLowerCase();
  const ensureTable = (name, nameSpan, schema = null, rawName = name) => {
    const key = tableKey(rawName);
    if (!tables.has(key)) {
      tables.set(key, { name, key, schema, rawName, columns: [], colIndex: new Map(), colRefs: [], nullabilityKnown: true, nameSpan, bodySpan: null });
    } else {
      const existing = tables.get(key);
      if (nameSpan && !existing.nameSpan) {
        existing.nameSpan = nameSpan;
      }
      if (schema && !existing.schema) {
        existing.schema = schema;
      }
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
      const rawNameMatch = nameRegion.match(/\S/);
      if (!rawNameMatch) continue;
      const rawName = nameRegion.trim();
      const nameLocal = afterStart + rawNameMatch.index;
      // span covers the bare table name (last dotted part) for clean rename
      const dotIdx = rawName.lastIndexOf('.');
      const bareStart = nameLocal + (dotIdx >= 0 ? dotIdx + 1 : 0);
      const name = bareName(rawName);
      const schema = schemaName(rawName);
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
      const table = ensureTable(name, nameSpan, schema, rawName);
      table.bodySpan = [base + bodyLocal, base + afterStart + end];
      table.stmtSpan = [base + cm.index, base + stmt.length];   // CREATE … (sans ';')
      parseTableBody(body, base + bodyLocal, table, relations, qualifiedNames);
      continue;
    }

    // ALTER TABLE [ONLY] x ADD [CONSTRAINT y] FOREIGN KEY (a) REFERENCES z (b)
    // (pg_dump emits "ALTER TABLE ONLY schema.table")
    const am = stmt.match(/alter\s+table\s+(?:only\s+)?([^\s(]+(?:\.[^\s(]+)?)\s+add\s+/is);
    if (am) {
      const t = am[1];
      const tail = stmt.slice(am.index + am[0].length);
      const tailBase = base + am.index + am[0].length;
      const rel = parseForeignKey(tail, tailBase, t);
      if (rel) relations.push(rel);
      if (/\bprimary\s+key\b/i.test(tail)) {
        keyConstraints.push({ key: tableKey(t), tokens: tokenize(tail, tailBase), flag: 'pk' });
      } else if (/\bunique\b/i.test(tail)) {
        keyConstraints.push({ key: tableKey(t), tokens: tokenize(tail, tailBase), flag: 'unique' });
      }
      continue;
    }

    // CREATE TYPE x AS ENUM ('a', 'b', ...) (PostgreSQL). Collected so enum
    // columns can show their possible values; applied after the loop so the
    // CREATE TYPE / CREATE TABLE order doesn't matter.
    const em = stmt.match(/create\s+type\s+(\S+)\s+as\s+enum\s*\(/i);
    if (em) {
      const bodyStart = em.index + em[0].length;
      const close = stmt.lastIndexOf(')');
      const body = stmt.slice(bodyStart, close > bodyStart ? close : undefined);
      const values = [...body.matchAll(/'((?:[^']|'')*)'/g)].map(v => v[1].replace(/''/g, "'"));
      if (values.length) { enums.set(tableKey(em[1]), values); }
      continue;
    }

    // COMMENT ON TABLE x IS '...' / COMMENT ON COLUMN x.y IS '...' (PostgreSQL).
    // Collected and applied after the loop so ordering vs CREATE TABLE doesn't
    // matter and comments on unknown tables don't create phantom tables.
    const com = stmt.match(/comment\s+on\s+(table|column)\s+(\S+)\s+is\s+/i);
    if (com) {
      const text = parseStringLiteral(stmt.slice(com.index + com[0].length));
      if (text !== undefined) comments.push({ kind: com[1].toLowerCase(), target: com[2], text });
    }
  }

  for (const constraint of keyConstraints) {
    const table = tables.get(constraint.key);
    if (table) {
      markKeyCols(constraint.tokens, table, constraint.flag, qualifiedNames);
    }
  }

  // attach COMMENT ON text to tables / columns (later statements win; IS NULL clears)
  for (const c of comments) {
    const parts = c.target.split('.').map(clean);
    if (c.kind === 'table') {
      const table = tables.get(tableKey(c.target));
      if (table) table.comment = c.text || null;
    } else if (parts.length >= 2) {
      const identifiers = identifierParts(c.target);
      const table = tables.get(tableKey(identifiers.slice(0, -1).join('.')));
      const column = table?.colIndex.get(qualifiedNames ? identifierKey(identifiers.at(-1)) : parts.at(-1).toLowerCase());
      if (column) column.comment = c.text || null;
    }
  }

  // attach enum values to columns whose type matches a CREATE TYPE ... AS ENUM
  if (enums.size) {
    for (const table of tables.values()) {
      for (const column of table.columns) {
        const rawType = (column.typeRaw || '').replace(/\(.*$/s, '').trim().replace(/\[\s*\]?$/, '');
        const values = rawType ? enums.get(tableKey(rawType)) : null;
        if (values) { column.enumValues = values; }
      }
    }
  }

  // resolve relations; mark fk columns
  const tableList = [...tables.values()];
  const resolved = [];
  for (const r of relations) {
    const from = tables.get(tableKey(r.fromTable));
    const to = tables.get(tableKey(r.toTable));
    if (!from) continue;
    for (let index = 0; index < r.fromCols.length; index++) {
      const col = from.colIndex.get(qualifiedNames ? r.fromColumnKeys[index] : r.fromCols[index].toLowerCase());
      if (col) col.fk = true;
    }
    resolved.push({
      fromTable: from.name,
      fromCols: r.fromCols,
      toTable: to ? to.name : r.toTable,
      toCols: r.toCols,
      toMissing: !to,
      refSpan: r.refSpan || null,
      fromKey: from.key,
      toKey: to?.key || tableKey(r.toTable),
      fromColumnKeys: r.fromColumnKeys,
      toColumnKeys: r.toColumnKeys,
    });
  }

  return { tables: tableList, relations: resolved, errors, sql: original, enums };
}

function parseTableBody(body, base, table, relations, qualifiedNames) {
  const items = splitTopCommas(body, base);
  const keyConstraints = [];
  for (const part of items) {
    const item = part.text;
    if (!item.trim()) continue;
    const tokens = tokenize(item, part.start);
    if (!tokens.length) continue;
    const head = clean(tokens[0].text).toLowerCase();

    if (head === 'primary' && tokens[1] && /key/i.test(tokens[1].text)) {
      keyConstraints.push({ tokens, flag: 'pk' });
      continue;
    }
    if (head === 'unique') {
      keyConstraints.push({ tokens, flag: 'unique' });
      continue;
    }
    if (head === 'foreign' && tokens[1] && /key/i.test(tokens[1].text)) {
      const rel = parseForeignKey(item, part.start, table.rawName);
      if (rel) { relations.push(rel); table.colRefs.push(...rel.localColSpans); }
      continue;
    }
    if (head === 'constraint') {
      if (/foreign\s+key/i.test(item)) {
        const rel = parseForeignKey(item, part.start, table.rawName);
        if (rel) { relations.push(rel); table.colRefs.push(...rel.localColSpans); }
      } else if (/primary\s+key/i.test(item)) {
        keyConstraints.push({ tokens, flag: 'pk' });
      } else if (/unique/i.test(item)) {
        keyConstraints.push({ tokens, flag: 'unique' });
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

    const rest = item.slice(nameTok.end - part.start).replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, '').toLowerCase();
    const typeSignature = columnType(tokens);
    const col = {
      name: colName,
      key: identifierKey(nameTok.text),
      typeSignature,
      type: qualifiedNames ? typeSignature : prettyType(type),
      typeRaw: qualifiedNames ? typeSignature : type,
      pk: /\bprimary\s+key\b/.test(rest),
      nn: /\bnot\s+null\b/.test(rest),
      unique: /\bunique\b/.test(rest),
      fk: false,
      nameSpan: [ns, ne],
      typeSpan,
      defSpan: [part.start, part.start + item.length],   // full "name type …" segment
    };
    table.columns.push(col);
    table.colIndex.set(qualifiedNames ? col.key : colName.toLowerCase(), col);

    // inline REFERENCES other(col)
    const refm = item.match(/references\s+([^\s(]+(?:\.[^\s(]+)?)\s*(\([^)]*\))?/id);
    if (refm) {
      col.fk = true;
      const toTable = refm[1];
      const toCols = refm[2] ? parseColumnsFromParen(refm[2]) : [];
      const gi = refm.indices[1];
      const dotIdx = refm[1].lastIndexOf('.');
      const refStart = part.start + gi[0] + (dotIdx >= 0 ? dotIdx + 1 : 0);
      relations.push({
        fromTable: table.rawName,
        fromCols: [colName],
        fromColumnKeys: [col.key],
        toTable,
        toCols,
        toColumnKeys: refm[2] ? splitTopCommas(refm[2].slice(1, -1), 0).map(part => identifierKey(part.text)) : [],
        refSpan: [refStart, part.start + gi[1]],
      });
    }
  }
  for (const constraint of keyConstraints) {
    markKeyCols(constraint.tokens, table, constraint.flag, qualifiedNames);
  }
}

// Mark a table-level key clause's columns and record their spans for renames.
function markKeyCols(tokens, table, flag, qualifiedNames) {
  const grp = tokens.find(t => t.text.startsWith('('));
  if (!grp) return;
  for (const ref of colSpans(grp.text.slice(1, -1), grp.start + 1)) {
    const col = table.colIndex.get(qualifiedNames ? ref.key : ref.name);
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
  const toTable = m[2];
  const toCols = m[4] ? m[4].split(',').map(s => bareName(s)).filter(Boolean) : [];
  const gi = m.indices[2];
  const dotIdx = m[2].lastIndexOf('.');
  const refStart = base + gi[0] + (dotIdx >= 0 ? dotIdx + 1 : 0);
  const localColSpans = colSpans(m[1], base + m.indices[1][0]);
  const fromColumnKeys = splitTopCommas(m[1], 0).map(part => identifierKey(part.text));
  const toColumnKeys = m[4] ? splitTopCommas(m[4], 0).map(part => identifierKey(part.text)) : [];
  return { fromTable, fromCols, toTable, toCols, fromColumnKeys, toColumnKeys, refSpan: [refStart, base + gi[1]], localColSpans };
}

// The value after IS in a COMMENT ON statement: NULL, or a (possibly
// E-prefixed) single-quoted literal with '' escapes. Returns the text,
// null for NULL, or undefined if unrecognised (e.g. dollar-quoted).
function parseStringLiteral(text) {
  text = text.trim();
  if (/^null$/i.test(text)) return null;
  const m = text.match(/^e?'((?:[^']|'')*)'$/i);
  if (!m) return undefined;
  return m[1].replace(/''/g, "'");
}

function prettyType(t) {
  if (!t) return '';
  // display the bare type name (public.account_category -> account_category);
  // typeRaw/typeSpan keep the qualified form so canvas edits splice correctly
  const paren = t.indexOf('(');
  const head = paren >= 0 ? t.slice(0, paren) : t;
  const dot = head.lastIndexOf('.');
  if (dot >= 0) { t = clean(t.slice(dot + 1)); }
  const m = t.match(/^([a-zA-Z_]+)(.*)$/s);
  if (!m) return t.toLowerCase();
  return m[1].toLowerCase() + (m[2] || '').replace(/\s+/g, '');
}
