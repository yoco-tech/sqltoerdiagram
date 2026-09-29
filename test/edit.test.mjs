// Round-trip tests for the visual-editor edit ops: apply an op, re-parse the
// resulting SQL, and assert the model changed as expected (and stayed valid).
// Run: node test/edit.test.mjs
import { parseSchema } from '../src/parser.js';
import {
  deleteColumn, toggleConstraint, addTable, deleteTable, addRelation,
} from '../src/edit.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };
const parse = (sql) => parseSchema(sql);
const tbl = (m, k) => m.tables.find(t => t.key === k);
const colNames = (m, k) => tbl(m, k).columns.map(c => c.name);

const BASE = `CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(120),
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id)
);`;

// --- deleteColumn (middle / last / first) ---
{
  const m = parse(BASE);
  const r = deleteColumn(BASE, m, 'users', 'full_name');
  const m2 = parse(r.sql);
  ok(!colNames(m2, 'users').includes('full_name'), 'deleteColumn(middle): full_name removed');
  ok(colNames(m2, 'users').join(',') === 'id,email,created_at', 'deleteColumn(middle): others intact & ordered');
  ok(m2.errors.length === 0, 'deleteColumn(middle): no parse errors');
}
{
  const m = parse(BASE);
  const r = deleteColumn(BASE, m, 'users', 'created_at');   // last column
  const m2 = parse(r.sql);
  ok(!colNames(m2, 'users').includes('created_at'), 'deleteColumn(last): removed');
  ok(colNames(m2, 'users').length === 3, 'deleteColumn(last): count 3');
  ok(m2.errors.length === 0, 'deleteColumn(last): no parse errors');
}
{
  const m = parse(BASE);
  const r = deleteColumn(BASE, m, 'users', 'id');           // first column
  const m2 = parse(r.sql);
  ok(colNames(m2, 'users').join(',') === 'email,full_name,created_at', 'deleteColumn(first): removed, rest intact');
}

// --- toggleConstraint ---
{
  const m = parse(BASE);
  const r = toggleConstraint(BASE, m, 'users', 'full_name', 'nn', true);
  const m2 = parse(r.sql);
  ok(tbl(m2, 'users').columns.find(c => c.name === 'full_name').nn === true, 'toggle nn ON: full_name now NOT NULL');
}
{
  const m = parse(BASE);
  const r = toggleConstraint(BASE, m, 'users', 'created_at', 'nn', false);
  const m2 = parse(r.sql);
  ok(tbl(m2, 'users').columns.find(c => c.name === 'created_at').nn === false, 'toggle nn OFF: created_at now nullable');
}
{
  const m = parse(BASE);
  const r = toggleConstraint(BASE, m, 'users', 'full_name', 'unique', true);
  const m2 = parse(r.sql);
  ok(tbl(m2, 'users').columns.find(c => c.name === 'full_name').unique === true, 'toggle unique ON');
}
{
  const m = parse(BASE);
  // id PK is inline here → removable
  const r = toggleConstraint(BASE, m, 'users', 'id', 'pk', false);
  ok(r && parse(r.sql).tables.find(t => t.key === 'users').columns.find(c => c.name === 'id').pk === false, 'toggle pk OFF (inline)');
  // adding a 2nd PK must be refused
  const r2 = toggleConstraint(BASE, m, 'users', 'email', 'pk', true);
  ok(r2 === null, 'toggle pk ON refused when a PK already exists');
}

// --- addTable ---
{
  const r = addTable(BASE, 'products', 'BIGINT');
  const m2 = parse(r.sql);
  ok(r.tableKey === 'products' && tbl(m2, 'products'), 'addTable: products created');
  ok(tbl(m2, 'products').columns[0].pk === true, 'addTable: has PK id');
  ok(m2.tables.length === 3, 'addTable: 3 tables total');
}

// --- deleteTable ---
{
  const m = parse(BASE);
  const r = deleteTable(BASE, m, 'orders');
  const m2 = parse(r.sql);
  ok(!tbl(m2, 'orders'), 'deleteTable: orders gone');
  ok(tbl(m2, 'users') && m2.tables.length === 1, 'deleteTable: users survives');
  ok(m2.errors.length === 0, 'deleteTable: no parse errors');
}

// --- addRelation ---
{
  const src = `CREATE TABLE users ( id BIGINT PRIMARY KEY );
CREATE TABLE orders ( id BIGINT PRIMARY KEY, user_id BIGINT );`;
  const m = parse(src);
  const r = addRelation(src, m, { table: 'orders', col: 'user_id' }, { table: 'users', col: 'id' });
  const m2 = parse(r.sql);
  const rel = m2.relations.find(x => x.fromTable.toLowerCase() === 'orders' && x.toTable.toLowerCase() === 'users');
  ok(!!rel, 'addRelation: FK orders.user_id -> users.id created');
  ok(tbl(m2, 'orders').columns.find(c => c.name === 'user_id').fk === true, 'addRelation: user_id marked as FK');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
