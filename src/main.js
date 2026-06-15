import './style.css';
import { parseSchema } from './parser.js';
import { layout } from './layout.js';
import { Diagram } from './diagram.js';
import { exportSVG } from './svg-export.js';
import { applyEdit, addColumn } from './edit.js';
import { DIALECTS, DEFAULT_DIALECT } from './dialects.js';
import { highlightSQL } from './highlight.js';
import { encodeShare, decodeShare } from './share.js';
import { sanitizeAnnotations } from './annotations.js';
import { EXAMPLE_SQL } from './examples.js';

const $ = (id) => document.getElementById(id);
const sqlEl = $('sql');
const canvas = $('canvas');
const statusEl = $('status');
const emptyEl = $('empty');
const zoomLabel = $('zoom-reset');

const hlEl = $('hl');

const diagram = new Diagram(canvas);
diagram.onZoom = (s) => { zoomLabel.textContent = Math.round(s * 100) + '%'; };
window.__dbdiga = diagram;   // debug handle

// ---- syntax highlight layer (painted behind the transparent textarea) ----
let hlQueued = false;
function syncHighlight() {
  // coalesce to one repaint per frame so fast typing never blocks
  if (hlQueued) return;
  hlQueued = true;
  requestAnimationFrame(() => {
    hlQueued = false;
    hlEl.innerHTML = highlightSQL(sqlEl.value);
    hlEl.parentElement.scrollTop = sqlEl.scrollTop;
    hlEl.parentElement.scrollLeft = sqlEl.scrollLeft;
  });
}
sqlEl.addEventListener('scroll', () => {
  hlEl.parentElement.scrollTop = sqlEl.scrollTop;
  hlEl.parentElement.scrollLeft = sqlEl.scrollLeft;
});

// ---- layout persistence (table positions + camera) ----
const LAYOUT_KEY = 'dbdiga-layout';

function collectLayout() {
  const positions = {};
  for (const t of diagram.model.tables) {
    if (Number.isFinite(t.x)) positions[t.key] = { x: Math.round(t.x), y: Math.round(t.y) };
  }
  return {
    positions,
    camera: { x: Math.round(diagram.cam.x), y: Math.round(diagram.cam.y), scale: +diagram.cam.scale.toFixed(4) },
    annotations: diagram.annotations.map(a => ({ ...a })),
    hidden: [...diagram.hidden],
  };
}
function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(collectLayout())); } catch { /* quota */ }
}
let saveTimer = null;
function saveLayoutDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLayout, 400);
}
function loadSavedLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
// apply saved positions onto a freshly-parsed model; returns true if any matched
function applyLayoutData(model, data) {
  if (!data || !data.positions) return false;
  let placed = 0;
  for (const t of model.tables) {
    const p = data.positions[t.key];
    if (p && Number.isFinite(p.x)) { t.x = p.x; t.y = p.y; placed++; }
  }
  return placed > 0;
}
// position any tables that have no coordinates yet, beside the existing ones
function placeNewTables(model) {
  const missing = model.tables.filter(t => !Number.isFinite(t.x));
  if (!missing.length) return;
  const placed = model.tables.filter(t => Number.isFinite(t.x));
  if (!placed.length) { layout(model, layoutOpts, diagram.hidden); return; }
  let x1 = -Infinity, y0 = Infinity;
  for (const t of placed) { x1 = Math.max(x1, t.x + t.w); y0 = Math.min(y0, t.y); }
  let x = x1 + 80, y = Number.isFinite(y0) ? y0 : 40;
  for (const t of missing) { t.x = x; t.y = y; y += t.h + 40; }
}

diagram.onLayoutChange = saveLayoutDebounced;

// theme: restore preference
const savedTheme = localStorage.getItem('dbdiga-theme') || 'dark';
diagram.setTheme(savedTheme);

diagram.start();

// ---- hide tables: right-click context menu + "N hidden" restore chip ----
const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu';
ctxMenu.hidden = true;
canvas.parentElement.appendChild(ctxMenu);
const hideCtx = () => { ctxMenu.hidden = true; };

const hiddenChip = document.createElement('button');
hiddenChip.className = 'hidden-chip';
hiddenChip.hidden = true;
hiddenChip.title = 'Show all hidden tables';
hiddenChip.addEventListener('click', () => diagram.showAllHidden());
canvas.parentElement.appendChild(hiddenChip);
function syncHiddenChip() {
  const n = diagram.hiddenCount();
  hiddenChip.hidden = n === 0;
  hiddenChip.textContent = n ? `${n} hidden · Show all` : '';
}
diagram.onHiddenChange = () => { syncHiddenChip(); saveLayoutDebounced(); };

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const t = diagram.tableAt(sx, sy);
  const items = [];
  if (t) {
    const multi = diagram.selected.has(t) && diagram.selected.size > 1;
    items.push({ label: multi ? `Hide ${diagram.selected.size} tables` : 'Hide table', act: () => diagram.hideTable(t) });
  }
  if (diagram.hiddenCount() > 0) items.push({ label: `Show all hidden (${diagram.hiddenCount()})`, act: () => diagram.showAllHidden() });
  if (!items.length) { hideCtx(); return; }
  ctxMenu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ctx-item';
    b.textContent = it.label;
    b.addEventListener('click', () => { it.act(); hideCtx(); });
    ctxMenu.appendChild(b);
  }
  ctxMenu.style.left = sx + 'px';
  ctxMenu.style.top = sy + 'px';
  ctxMenu.hidden = false;
});
window.addEventListener('mousedown', (e) => { if (!ctxMenu.contains(e.target)) hideCtx(); });
window.addEventListener('blur', hideCtx);

let lastModel = null;
let firstRender = true;

// layout options (persisted)
const layoutOpts = {
  dir: localStorage.getItem('dbdiga-dir') || 'LR',
  spacing: localStorage.getItem('dbdiga-spacing') || 'comfortable',
};

function rebuild({ arrange = false, restore = null } = {}) {
  const sql = sqlEl.value;
  localStorage.setItem('dbdiga-sql', sql);
  syncHighlight();

  let result;
  try {
    result = parseSchema(sql);
  } catch (err) {
    statusEl.textContent = 'Parse error';
    statusEl.className = 'status err';
    console.error(err);
    return;
  }

  updateStatus(result, sql);

  const prevKeys = lastModel ? lastModel.tables.map(t => t.key).sort().join('|') : '';
  const newKeys = result.tables.map(t => t.key).sort().join('|');
  const structureChanged = prevKeys !== newKeys;

  // pre-apply restored positions before setModel (it preserves what we set)
  if (restore) applyLayoutData(result, restore);

  diagram.setModel(result);
  diagram._tmapDirty = true;

  if (arrange) {
    layout(result, layoutOpts, diagram.hidden);
    diagram.fit();
  } else if (restore) {
    diagram.setHidden(restore.hidden);               // restore hidden tables before placing
    placeNewTables(result);                          // tables not in the saved layout
    diagram.setAnnotations(sanitizeAnnotations(restore.annotations));
    if (restore.camera) diagram.setCamera(restore.camera);
    else diagram.fit();
  } else if (firstRender) {
    layout(result, layoutOpts, diagram.hidden);
    diagram.fit();
  } else if (structureChanged) {
    placeNewTables(result);                          // keep manual layout, place only new tables
  }

  diagram.markDirty();
  lastModel = result;
  firstRender = false;
  saveLayoutDebounced();
}

function updateStatus(result, sql) {
  const hasTables = result.tables.length > 0;
  emptyEl.style.display = hasTables ? 'none' : 'grid';
  const nT = result.tables.length;
  const nR = result.relations.length;
  if (!hasTables && sql.trim()) {
    statusEl.textContent = 'No CREATE TABLE found';
    statusEl.className = 'status warn';
  } else if (hasTables) {
    statusEl.textContent = `${nT} table${nT !== 1 ? 's' : ''} · ${nR} relation${nR !== 1 ? 's' : ''}`;
    statusEl.className = 'status ok';
  } else {
    statusEl.textContent = '';
    statusEl.className = 'status';
  }
}

// ---- canvas editing: edit a table/column on the diagram -> rewrite SQL ----
diagram.onEdit = (change) => {
  const sql = sqlEl.value;
  const fresh = parseSchema(sql);          // parse current text for accurate spans
  const result = applyEdit(sql, fresh, change);
  if (!result) return;

  sqlEl.value = result.sql;
  localStorage.setItem('dbdiga-sql', result.sql);
  syncHighlight();

  // remember current positions so the edit doesn't reshuffle the diagram
  const oldPos = new Map(diagram.model.tables.map(t => [t.key, { x: t.x, y: t.y }]));
  const model = parseSchema(result.sql);
  for (const t of model.tables) {
    let p = oldPos.get(t.key);
    // a renamed table keeps the position of its old key
    if (!p && change.kind === 'table' && t.key === result.newKey) p = oldPos.get(change.tableKey);
    if (p && Number.isFinite(p.x)) { t.x = p.x; t.y = p.y; }
  }
  diagram.setModel(model);   // measures sizes, keeps the positions we set
  diagram.markDirty();
  updateStatus(model, result.sql);
  lastModel = model;
  saveLayoutDebounced();     // persist (a rename changes a table's key)
};

// ---- dialect (drives default column type + type suggestions) ----
let dialect = localStorage.getItem('dbdiga-dialect') || DEFAULT_DIALECT;
if (!DIALECTS[dialect]) dialect = DEFAULT_DIALECT;
diagram.typeSuggestions = DIALECTS[dialect].types;

// ---- add column on the canvas -> insert into SQL with the dialect default ----
diagram.onAddColumn = (tableKey) => {
  const sql = sqlEl.value;
  const fresh = parseSchema(sql);
  const table = fresh.tables.find(t => t.key === tableKey);
  if (!table) return;

  // pick a unique default name
  const existing = new Set(table.columns.map(c => c.name.toLowerCase()));
  let name = 'new_column', i = 2;
  while (existing.has(name.toLowerCase())) name = `new_column_${i++}`;

  const res = addColumn(sql, fresh, tableKey, name, DIALECTS[dialect].default);
  if (!res) return;

  sqlEl.value = res.sql;
  localStorage.setItem('dbdiga-sql', res.sql);
  syncHighlight();

  const oldPos = new Map(diagram.model.tables.map(t => [t.key, { x: t.x, y: t.y }]));
  const model = parseSchema(res.sql);
  for (const t of model.tables) {
    const p = oldPos.get(t.key);
    if (p && Number.isFinite(p.x)) { t.x = p.x; t.y = p.y; }
  }
  diagram.setModel(model);
  diagram.pinByKey(tableKey);          // keep the affordance visible
  updateStatus(model, res.sql);
  lastModel = model;
  diagram.editColumn(tableKey, name);  // open the new column for naming
};

// debounced live parsing; highlight repaints immediately (rAF-coalesced)
let timer = null;
sqlEl.addEventListener('input', () => {
  syncHighlight();
  clearTimeout(timer);
  timer = setTimeout(() => rebuild(), 180);
});

// ---- buttons ----
function loadExample() {
  sqlEl.value = EXAMPLE_SQL;
  firstRender = true;
  rebuild({ arrange: true });
}
$('btn-example').addEventListener('click', loadExample);
$('btn-example2')?.addEventListener('click', loadExample);

// Arrange button: re-arrange with current opts; the ▾ part toggles the menu.
const arrangeMenu = $('arrange-menu');
function syncMenu() {
  for (const el of arrangeMenu.querySelectorAll('[data-dir]'))
    el.classList.toggle('active', el.dataset.dir === layoutOpts.dir);
  for (const el of arrangeMenu.querySelectorAll('[data-spacing]'))
    el.classList.toggle('active', el.dataset.spacing === layoutOpts.spacing);
}
syncMenu();

$('btn-arrange').addEventListener('click', (e) => {
  e.stopPropagation();
  if (arrangeMenu.hidden) { arrangeMenu.hidden = false; }
  else { arrangeMenu.hidden = true; rebuild({ arrange: true }); }
});
arrangeMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const item = e.target.closest('.menu-item');
  if (!item) return;
  if (item.dataset.dir) {
    layoutOpts.dir = item.dataset.dir;
    localStorage.setItem('dbdiga-dir', layoutOpts.dir);
  }
  if (item.dataset.spacing) {
    layoutOpts.spacing = item.dataset.spacing;
    localStorage.setItem('dbdiga-spacing', layoutOpts.spacing);
  }
  syncMenu();
  rebuild({ arrange: true });
});
document.addEventListener('click', () => { arrangeMenu.hidden = true; });

$('btn-fit').addEventListener('click', () => diagram.fit());

// ---- annotation tools (note / group) ----
$('tool-note').addEventListener('click', () => diagram.addAnnotation('note'));
$('tool-group').addEventListener('click', () => diagram.addAnnotation('group'));

// ---- dialect dropdown ----
const dialectBtn = $('btn-dialect');
const dialectMenu = $('dialect-menu');
for (const [key, d] of Object.entries(DIALECTS)) {
  const b = document.createElement('button');
  b.className = 'menu-item';
  b.dataset.dialect = key;
  b.dataset.umamiEvent = 'dialect-' + key;
  b.textContent = d.label;
  dialectMenu.appendChild(b);
}
function syncDialect() {
  dialectBtn.textContent = DIALECTS[dialect].label;
  for (const el of dialectMenu.querySelectorAll('[data-dialect]'))
    el.classList.toggle('active', el.dataset.dialect === dialect);
  diagram.typeSuggestions = DIALECTS[dialect].types;
}
syncDialect();
dialectBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  dialectMenu.hidden = !dialectMenu.hidden;
});
dialectMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const item = e.target.closest('.menu-item');
  if (!item) return;
  dialect = item.dataset.dialect;
  localStorage.setItem('dbdiga-dialect', dialect);
  syncDialect();
  dialectMenu.hidden = true;
});
document.addEventListener('click', () => { dialectMenu.hidden = true; });

// ---- hide / show SQL panel (collapse from inside the panel, reopen from the canvas) ----
const layoutEl = $('layout');
function setSqlHidden(hidden) {
  localStorage.setItem('dbdiga-sql-hidden', hidden ? '1' : '0');
  layoutEl.classList.toggle('sql-hidden', hidden);
  diagram.resize();
}
$('btn-collapse-sql').addEventListener('click', () => setSqlHidden(true));
$('btn-open-sql').addEventListener('click', () => setSqlHidden(false));
// default: panel hidden on phones (diagram-first), shown on desktop
const savedSqlHidden = localStorage.getItem('dbdiga-sql-hidden');
setSqlHidden(savedSqlHidden === null ? window.matchMedia('(max-width: 720px)').matches : savedSqlHidden === '1');

$('zoom-in').addEventListener('click', () => diagram.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => diagram.zoomBy(0.8));
$('zoom-reset').addEventListener('click', () => diagram.resetZoom());

$('btn-theme').addEventListener('click', () => {
  const next = diagram.themeName === 'dark' ? 'light' : 'dark';
  diagram.setTheme(next);
  localStorage.setItem('dbdiga-theme', next);
});

function download(filename, href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('btn-png').addEventListener('click', () => {
  const url = diagram.exportPNG(2);
  if (url) download('schema.png', url);
});

$('btn-svg').addEventListener('click', () => {
  const svg = exportSVG(diagram.model, diagram.themeName, diagram.annotations, diagram.hidden);
  if (!svg) return;
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  download('schema.svg', url);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---- Save / Open project (SQL + layout + camera + dialect) ----
$('btn-save').addEventListener('click', () => {
  const project = {
    app: 'dbdiga',
    version: 1,
    sql: sqlEl.value,
    dialect,
    ...collectLayout(),
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  download('schema.sqltoerdiagram.json', url);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---- Share link (project encoded in the URL hash; nothing stored server-side) ----
function flashButton(btn, text) {
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = orig; }, 1500);
}
$('btn-share').addEventListener('click', async () => {
  const btn = $('btn-share');
  const project = { app: 'dbdiga', version: 1, sql: sqlEl.value, dialect, ...collectLayout() };
  let payload;
  try { payload = await encodeShare(project); }
  catch (err) { console.error(err); flashButton(btn, 'Failed'); return; }
  const hash = '#s=' + payload;
  history.replaceState(null, '', hash);                 // put it in the address bar too
  const url = location.origin + location.pathname + hash;
  try { await navigator.clipboard.writeText(url); flashButton(btn, 'Link copied ✓'); }
  catch { flashButton(btn, 'Link in URL ↑'); }          // clipboard blocked → it's in the URL
});

const fileInput = $('file-open');
$('btn-open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      if (typeof data.sql !== 'string') throw new Error('not a dbdiga project');
      sqlEl.value = data.sql;
      localStorage.setItem('dbdiga-sql', data.sql);
      if (data.dialect && DIALECTS[data.dialect]) { dialect = data.dialect; localStorage.setItem('dbdiga-dialect', dialect); syncDialect(); }
      firstRender = true;          // ensure a clean restore even if a model exists
      rebuild({ restore: { positions: data.positions, camera: data.camera, annotations: data.annotations, hidden: data.hidden } });
      saveLayout();
    } catch (err) {
      statusEl.textContent = 'Invalid project file';
      statusEl.className = 'status err';
      console.error(err);
    }
    fileInput.value = '';          // allow re-opening the same file
  };
  reader.readAsText(file);
});

// ---- splitter (resize editor pane) ----
const splitter = $('splitter');
const editorPane = $('editor-pane');
let dragSplit = null;
splitter.addEventListener('mousedown', (e) => {
  dragSplit = { startX: e.clientX, startW: editorPane.offsetWidth };
  document.body.style.cursor = 'col-resize';
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragSplit) return;
  const w = Math.max(220, Math.min(window.innerWidth - 320, dragSplit.startW + (e.clientX - dragSplit.startX)));
  editorPane.style.width = w + 'px';
  diagram.resize();
});
window.addEventListener('mouseup', () => {
  if (dragSplit) { dragSplit = null; document.body.style.cursor = ''; }
});

window.addEventListener('resize', () => diagram.resize());

// keyboard shortcuts
window.addEventListener('keydown', (e) => {
  const typing = document.activeElement &&
    (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT');
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    rebuild({ arrange: true });
  } else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && diagram.selectedAnno) {
    e.preventDefault();
    diagram.deleteSelectedAnnotation();
  } else if (!typing && (e.key === 'h' || e.key === 'H') && diagram.selected.size > 0) {
    e.preventDefault();
    diagram.hideTable(null);   // hide the current selection
  } else if (e.key === 'Escape' && !typing) {
    hideCtx();
    diagram.clearSelection();
  }
});

// ---- boot: shared link > last session > example ----
(async () => {
  // 1) shared link (#s=…) takes precedence
  if (location.hash.startsWith('#s=')) {
    try {
      const data = await decodeShare(location.hash.slice(3));
      sqlEl.value = data.sql || '';
      localStorage.setItem('dbdiga-sql', sqlEl.value);
      if (data.dialect && DIALECTS[data.dialect]) {
        dialect = data.dialect;
        localStorage.setItem('dbdiga-dialect', dialect);
        syncDialect();
      }
      firstRender = true;
      rebuild({ restore: { positions: data.positions, camera: data.camera, annotations: data.annotations, hidden: data.hidden } });
      saveLayout();
      return;
    } catch (err) {
      console.error('Could not read shared link', err);
      statusEl.textContent = 'Bad share link';
      statusEl.className = 'status err';
    }
  }
  // 2) last session
  const saved = localStorage.getItem('dbdiga-sql');
  if (saved && saved.trim()) {
    sqlEl.value = saved;
    const savedLayout = loadSavedLayout();
    if (savedLayout) rebuild({ restore: savedLayout });
    else rebuild();
    return;
  }
  // 3) first visit
  loadExample();
})();
