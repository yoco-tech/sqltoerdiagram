import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSchemas } from '../src/comparison.js';
import { exportSVG } from '../src/svg-export.js';
import { THEMES, measureTable } from '../src/renderer.js';

test('SVG preserves table, column and relationship changes in both themes', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 8 }) }) }),
  };
  try {
    const model = compareSchemas(
      'CREATE TABLE removed (id int PRIMARY KEY); CREATE TABLE orders (id int, parent_id int REFERENCES removed(id));',
      'CREATE TABLE added (id int PRIMARY KEY); CREATE TABLE orders (id bigint, parent_id int REFERENCES added(id));',
    );
    for (const [index, table] of model.tables.entries()) {
      Object.assign(table, measureTable(table), { x: index * 400, y: 100 });
    }
    for (const themeName of ['light', 'dark']) {
      const theme = THEMES[themeName];
      const svg = exportSVG(model, themeName);
      assert.ok(svg.includes(`fill="${theme.addedBg}"`));
      assert.ok(svg.includes(`fill="${theme.removedBg}"`));
      assert.ok(svg.includes(`stroke="${theme.removed}" stroke-width="1.5" stroke-dasharray="6 5"`));
      assert.ok(svg.includes(`stroke="${theme.added}" stroke-width="1.5"`));
      assert.ok(svg.includes('>+ added</text>'));
      assert.ok(svg.includes('>− removed</text>'));
      assert.ok(svg.includes('>− id</text>'));
      assert.ok(svg.includes('>+ id</text>'));
    }
  } finally {
    globalThis.document = previousDocument;
  }
});
