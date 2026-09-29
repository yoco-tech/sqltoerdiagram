import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareSchemas, previousSchemaFromProject } from '../src/comparison.js';
import { parseSchema } from '../src/parser.js';
import { encodeShare, decodeShare } from '../src/share.js';
import { columnY, ROW_H } from '../src/renderer.js';
import { relationCardinality } from '../src/cardinality.js';

test('retains deleted tables and columns alongside additions and unchanged columns', () => {
  const model = compareSchemas(
    'CREATE TABLE users (id bigint PRIMARY KEY, legacy text, name text); CREATE TABLE retired (id int);',
    'CREATE TABLE users (id bigint PRIMARY KEY, name text, email text); CREATE TABLE added (id int);',
  );
  assert.deepEqual(model.tables.map(table => [table.name, table.change]), [
    ['users', undefined], ['added', 'added'], ['retired', 'removed'],
  ]);
  assert.deepEqual(model.tables[0].columns.map(column => [column.name, column.change]), [
    ['id', undefined], ['legacy', 'removed'], ['name', undefined], ['email', 'added'],
  ]);
  assert.equal(model.tables[1].columns[0].change, 'added');
  assert.equal(model.tables[2].columns[0].change, 'removed');
  assert.equal(model.editable, false);
});

test('ignores whitespace, SQL comments, keyword case and table/column order', () => {
  const model = compareSchemas(
    'CREATE TABLE a (id BIGINT NOT NULL, value VARCHAR ( 20 )); CREATE TABLE b (id int);',
    '-- reordered\ncreate table b(id int); create table a(value varchar(20), id bigint not null);',
  );
  assert.ok(model.tables.every(table => !table.change && table.columns.every(column => !column.change)));
});

test('shows old and new definitions for type, nullability and key changes', () => {
  for (const [before, after] of [
    ['text', 'varchar(80)'], ['int', 'int NOT NULL'], ['int', 'int PRIMARY KEY'],
    ['text', 'text UNIQUE'], ['timestamp without time zone', 'timestamp with time zone'],
  ]) {
    const model = compareSchemas(`CREATE TABLE users (value ${before});`, `CREATE TABLE users (value ${after});`);
    assert.deepEqual(model.tables[0].columns.map(column => column.change), ['removed', 'added']);
  }
});

test('ignored defaults and comments do not masquerade as constraints', () => {
  const model = compareSchemas('CREATE TABLE users (value text);',
    "CREATE TABLE users (value text DEFAULT 'unique not null primary key'); COMMENT ON COLUMN users.value IS 'Updated';");
  assert.equal(model.tables[0].columns.length, 1);
  assert.equal(model.tables[0].columns[0].change, undefined);
});

test('empty snapshots represent creating or deleting an entire schema', () => {
  const sql = 'CREATE TABLE users (id int);';
  assert.equal(compareSchemas('', sql).tables[0].change, 'added');
  assert.equal(compareSchemas(sql, '').tables[0].change, 'removed');
  assert.deepEqual(compareSchemas('', '').tables, []);
});

test('renames are explicit removals and additions', () => {
  const model = compareSchemas('CREATE TABLE users (name text);', 'CREATE TABLE users (display_name text);');
  assert.deepEqual(model.tables[0].columns.map(column => [column.name, column.change]), [
    ['display_name', 'added'], ['name', 'removed'],
  ]);
});

test('same table names in different schemas remain separate', () => {
  const previous = 'CREATE TABLE public.users (id int); CREATE TABLE audit.users (id int);';
  const model = compareSchemas(previous, previous.replace('public.users (id int)', 'public.users (id bigint)'));
  assert.equal(model.tables.length, 2);
  assert.notEqual(model.tables[0].key, model.tables[1].key);
  assert.deepEqual(model.tables[0].columns.map(column => column.change), ['removed', 'added']);
  assert.equal(model.tables[1].columns[0].change, undefined);
});

test('public qualification and equivalent quoted identifiers match, quoted case remains distinct', () => {
  const model = compareSchemas('CREATE TABLE users (id int);', 'CREATE TABLE "public"."users" ("id" int);');
  assert.equal(model.tables.length, 1);
  assert.equal(model.tables[0].columns.length, 1);
  assert.equal(model.tables[0].columns[0].change, undefined);
  const distinct = compareSchemas('', 'CREATE TABLE "Users" ("ID" int, id int); CREATE TABLE users (id int);');
  assert.equal(distinct.tables.length, 2);
  assert.notEqual(distinct.tables[0].columns[0].key, distinct.tables[0].columns[1].key);
});

test('pg_dump ALTER TABLE primary keys match equivalent inline definitions', () => {
  const model = compareSchemas(
    'CREATE TABLE public.users (id bigint NOT NULL); ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);',
    'CREATE TABLE public.users (id bigint PRIMARY KEY);',
  );
  assert.equal(model.tables[0].columns.length, 1);
  assert.equal(model.tables[0].columns[0].pk, true);
  assert.equal(model.tables[0].columns[0].change, undefined);
});

test('named UNIQUE constraints are compared', () => {
  const model = compareSchemas('CREATE TABLE users (email text);',
    'CREATE TABLE users (email text, CONSTRAINT email_key UNIQUE (email));');
  assert.deepEqual(model.tables[0].columns.map(column => column.change), ['removed', 'added']);
});

test('constraint ordering does not affect the comparison', () => {
  const baseline = 'CREATE TABLE users (id int PRIMARY KEY, email text UNIQUE);';
  for (const sql of [
    'CREATE TABLE users (PRIMARY KEY (id), UNIQUE (email), id int, email text);',
    'ALTER TABLE users ADD PRIMARY KEY (id); ALTER TABLE users ADD UNIQUE (email); CREATE TABLE users (id int, email text);',
  ]) {
    const model = compareSchemas(baseline, sql);
    assert.ok(model.tables[0].columns.every(column => !column.change));
  }
});

test('foreign keys retain both endpoints and use schema-qualified identities', () => {
  const common = 'CREATE TABLE public.users (id int); CREATE TABLE audit.users (id int); CREATE TABLE events (user_id int);';
  const model = compareSchemas(
    common + 'ALTER TABLE events ADD FOREIGN KEY (user_id) REFERENCES public.users(id);',
    common + 'ALTER TABLE events ADD FOREIGN KEY (user_id) REFERENCES audit.users(id);',
  );
  assert.deepEqual(model.relations.map(relation => [relation.toKey, relation.change]), [
    [model.tables[1].key, 'added'], [model.tables[0].key, 'removed'],
  ]);
});

test('composite foreign keys compare every column and ignore constraint names', () => {
  const common = 'CREATE TABLE parents (a int, b int); CREATE TABLE children (a int, b int);';
  const previous = common + 'ALTER TABLE children ADD CONSTRAINT old FOREIGN KEY (a,b) REFERENCES parents(a,b);';
  const renamed = compareSchemas(previous, previous.replace('CONSTRAINT old', 'CONSTRAINT renamed'));
  assert.equal(renamed.relations[0].change, undefined);
  const changed = compareSchemas(previous, previous.replace('REFERENCES parents(a,b)', 'REFERENCES parents(b,a)'));
  assert.deepEqual(changed.relations.map(relation => relation.change), ['added', 'removed']);
});

test('enum value changes preserve both versions for inspection', () => {
  const previous = "CREATE TYPE public.state AS ENUM ('open'); CREATE TABLE users (state public.state);";
  const model = compareSchemas(previous, previous.replace("('open')", "('open', 'closed')"));
  assert.deepEqual(model.tables[0].columns.map(column => column.enumValues), [['open'], ['open', 'closed']]);
});

test('quoted schema-qualified enum types retain their identities and value changes', () => {
  for (const type of ['"public"."state"', '"Audit"."State"', '"Audit.Events"."State"']) {
    const previous = `CREATE TYPE ${type} AS ENUM ('open'); CREATE TABLE tasks (state ${type});`;
    const model = compareSchemas(previous, previous.replace("('open')", "('open', 'closed')"));
    assert.deepEqual(model.tables[0].columns.map(column => [column.type, column.change, column.enumValues]), [
      [type, 'removed', ['open']],
      [type, 'added', ['open', 'closed']],
    ]);
  }
});

test('whitespace around quoted type qualification does not produce changes', () => {
  const previous = 'CREATE TYPE "public"."state" AS ENUM (\'open\'); CREATE TABLE tasks (state "public"."state");';
  const model = compareSchemas(previous, previous.replace('state "public"."state"', 'state "public" . "state"'));
  assert.deepEqual(model.tables[0].columns.map(column => [column.change, column.enumValues]), [
    [undefined, ['open']],
  ]);
});

test('unchanged foreign keys use the current column constraints in comparisons', () => {
  const optional = 'CREATE TABLE parents (id int PRIMARY KEY); CREATE TABLE children (parent_id int REFERENCES parents(id));';
  const mandatory = optional.replace('parent_id int REFERENCES', 'parent_id int NOT NULL UNIQUE REFERENCES');
  for (const [previous, current, expected] of [
    [optional, mandatory, { from: 'one', to: 'one', label: 'one-to-one' }],
    [mandatory, optional, { from: 'many', to: 'zero-or-one', label: 'one-to-many' }],
  ]) {
    const model = compareSchemas(previous, current);
    const tables = new Map(model.tables.map(table => [table.key, table]));
    assert.equal(model.relations[0].change, undefined);
    assert.deepEqual(relationCardinality(model.relations[0], tables), expected);
  }
});

test('added and removed foreign keys use their respective column constraints', () => {
  const previous = 'CREATE TABLE parents (id int PRIMARY KEY, other_id int UNIQUE); CREATE TABLE children (parent_id int REFERENCES parents(id));';
  const current = previous.replace('parent_id int REFERENCES parents(id)', 'parent_id int NOT NULL UNIQUE REFERENCES parents(other_id)');
  const model = compareSchemas(previous, current);
  const tables = new Map(model.tables.map(table => [table.key, table]));
  assert.deepEqual(model.relations.map(relation => [relation.change, relationCardinality(relation, tables)]), [
    ['added', { from: 'one', to: 'one', label: 'one-to-one' }],
    ['removed', { from: 'many', to: 'zero-or-one', label: 'one-to-many' }],
  ]);
});

test('comparison cardinality distinguishes quoted column case', () => {
  const sql = 'CREATE TABLE parents (id int PRIMARY KEY); CREATE TABLE children (parent_id int, "Parent_ID" int NOT NULL UNIQUE REFERENCES parents(id));';
  const model = compareSchemas(sql, sql);
  const tables = new Map(model.tables.map(table => [table.key, table]));
  assert.deepEqual(relationCardinality(model.relations[0], tables), {
    from: 'one', to: 'one', label: 'one-to-one',
  });
});

test('cardinality supports models without column keys or change metadata', () => {
  const tables = new Map([['children', { columns: [{ name: 'parent_id', nn: true, unique: true }] }]]);
  const relation = { fromTable: 'children', fromCols: ['PARENT_ID'] };
  assert.deepEqual(relationCardinality(relation, tables), {
    from: 'one', to: 'one', label: 'one-to-one',
  });
});

test('parse errors identify the affected snapshot', () => {
  const model = compareSchemas('CREATE TABLE broken (id int;', 'CREATE TABLE users (id int);');
  assert.match(model.errors[0], /^Previous schema:/);
});

test('comparison endpoints attach to the correct version of a changed column', () => {
  const model = compareSchemas('CREATE TABLE users (id int);', 'CREATE TABLE users (id bigint);');
  const table = model.tables[0];
  assert.equal(columnY(table, 'id', 'added', 'id') - columnY(table, 'id', 'removed', 'id'), ROW_H);
  assert.equal(columnY(table, 'id', undefined, 'id'), columnY(table, 'id', 'added', 'id'));
});

test('legacy parser keeps the table keys used by existing saved layouts', () => {
  const model = parseSchema('CREATE TABLE public.users (id int);');
  assert.equal(model.tables[0].key, 'users');
});

test('comparison payload validation accepts empty baselines and rejects missing or invalid snapshots', () => {
  assert.equal(previousSchemaFromProject({ sql: '' }), null);
  assert.equal(previousSchemaFromProject({ sql: '', previousSql: '' }), '');
  for (const project of [null, {}, { sql: 42 }, { mode: 'diff', sql: '' }, { sql: '', previousSql: null }]) {
    assert.throws(() => previousSchemaFromProject(project));
  }
});

test('share encoding round-trips both schemas and layout', async () => {
  const project = { version: 2, mode: 'diff', previousSql: '', sql: 'CREATE TABLE café (id int);', positions: { café: { x: 1, y: 2 } } };
  assert.deepEqual(await decodeShare(await encodeShare(project)), project);
});

test('CI helper generates a decodable comparison link with the requested viewer URL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'schema-comparison-'));
  try {
    const previousPath = join(directory, 'previous schema.sql');
    const currentPath = join(directory, 'current schema.sql');
    writeFileSync(previousPath, '');
    writeFileSync(currentPath, 'CREATE TABLE café (id int);');
    const output = execFileSync(process.execPath, ['scripts/create-comparison-link.mjs', previousPath, currentPath, 'https://example.com/viewer/?embed=1'], { encoding: 'utf8' }).trim();
    const url = new URL(output);
    assert.equal(url.origin + url.pathname + url.search, 'https://example.com/viewer/?embed=1');
    const project = await decodeShare(url.hash.slice(3));
    assert.equal(project.previousSql, '');
    assert.equal(project.sql, readFileSync(currentPath, 'utf8'));
    assert.equal(project.mode, 'diff');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
