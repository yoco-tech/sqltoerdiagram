// Visual editor: a form-based lens on the same SQL. Every control routes through
// the caller-supplied `actions`, which rewrite the SQL (via edit.js) and re-render
// the model — so Code view, Visual view and the diagram stay in lockstep.
//
// createVisualEditor({ mount, getModel, getDialect, getEditable, getFormatLabel, actions })
//   actions: rename(kind, tableKey, colName, value) · setType(tableKey, colName, value)
//            toggleConstraint(tableKey, colName, kind, on) -> bool · deleteColumn(tableKey, colName)
//            addColumn(tableKey) -> newName · addTable() -> {key,name} · deleteTable(tableKey)
//            focusTable(tableKey)

const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
const TARGET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6"/></svg>';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function createVisualEditor(opts) {
  const { mount, getModel, getDialect, getEditable, getFormatLabel, actions } = opts;
  const expanded = new Set();      // table keys currently expanded
  let focusAfter = null;           // {key, col} — input to focus after next render

  function typeOptions() {
    const d = getDialect ? getDialect() : null;
    const types = (d && d.types) || [];
    return types.map(t => `<option value="${esc(t)}"></option>`).join('');
  }

  function colRow(c) {
    const chip = (kind, cls, label, on, live = true) =>
      `<button class="ve-chip ${cls}${on ? ' on' : ''}" ${live ? `data-act="tog" data-kind="${kind}"` : ''} title="${label}" ${live ? '' : 'tabindex="-1"'}>${cls === 'fk' ? 'FK' : label}</button>`;
    return `<div class="ve-col" data-col="${esc(c.name)}">
      <input class="ve-cname" data-act="rename-col" value="${esc(c.name)}" spellcheck="false" autocomplete="off" />
      <input class="ve-ctype" data-act="set-type" list="ve-types" value="${esc(c.type || '')}" placeholder="type" spellcheck="false" autocomplete="off" />
      ${chip('pk', 'pk', 'PK', c.pk)}
      ${chip('unique', 'u', 'U', c.unique)}
      ${chip('nn', 'nn', 'NN', c.nn)}
      ${c.fk ? `<span class="ve-chip fk on" title="Foreign key">FK</span>` : ''}
      <button class="ve-cdel" data-act="del-col" title="Delete column" aria-label="Delete column">✕</button>
    </div>`;
  }

  function tableCard(t) {
    const open = expanded.has(t.key);
    const cols = open
      ? `<div class="ve-cols">${t.columns.map(colRow).join('')}<button class="ve-add-col" data-act="add-col">+ column</button></div>`
      : '';
    return `<div class="ve-table${open ? ' open' : ''}" data-key="${esc(t.key)}">
      <div class="ve-th">
        <button class="ve-exp" data-act="expand" aria-label="Expand">${CHEVRON}</button>
        <input class="ve-tname" data-act="rename-table" value="${esc(t.name)}" spellcheck="false" autocomplete="off" />
        <span class="ve-count">${t.columns.length}</span>
        <button class="ve-ticon" data-act="focus" title="Center on canvas" aria-label="Center on canvas">${TARGET}</button>
        <button class="ve-ticon del" data-act="del-table" title="Delete table" aria-label="Delete table">${TRASH}</button>
      </div>${cols}
    </div>`;
  }

  function render() {
    const model = getModel();
    const editable = getEditable ? getEditable() : true;
    const scroll = mount.querySelector('.ve-scroll');
    const prevScroll = scroll ? scroll.scrollTop : 0;

    if (!editable) {
      const fmt = getFormatLabel ? getFormatLabel() : 'this format';
      mount.innerHTML = `<div class="ve-scroll"><div class="ve-empty">
        Visual editing works on <strong>SQL</strong> input.<br>
        This schema was read from <strong>${esc(fmt)}</strong>, which is view-only.<br>
        Switch the format to SQL (or paste SQL) to edit tables &amp; columns here.
      </div></div>`;
      return;
    }

    const tables = (model && model.tables) || [];
    const body = tables.length
      ? tables.map(tableCard).join('')
      : `<div class="ve-empty">No tables yet.<br>Click <strong>+ Add table</strong> to start.</div>`;

    mount.innerHTML =
      `<div class="ve-toolbar"><button class="ve-add-table" data-act="add-table">+ Add table</button></div>` +
      `<datalist id="ve-types">${typeOptions()}</datalist>` +
      `<div class="ve-scroll">${body}</div>`;

    const sc = mount.querySelector('.ve-scroll');
    if (sc) sc.scrollTop = prevScroll;

    if (focusAfter) {
      const sel = focusAfter.col
        ? `.ve-table[data-key="${cssq(focusAfter.key)}"] .ve-col[data-col="${cssq(focusAfter.col)}"] .ve-cname`
        : `.ve-table[data-key="${cssq(focusAfter.key)}"] .ve-tname`;
      const el = mount.querySelector(sel);
      if (el) { el.focus(); el.select(); }
      focusAfter = null;
    }
  }

  // ---- event delegation (survives innerHTML rebuilds) ----
  const tableKeyOf = (el) => el.closest('.ve-table')?.dataset.key;
  const colOf = (el) => el.closest('.ve-col')?.dataset.col;

  mount.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const key = tableKeyOf(btn);
    if (act === 'expand') {
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      render();
    } else if (act === 'focus') {
      actions.focusTable(key);
    } else if (act === 'del-table') {
      const t = getModel().tables.find(x => x.key === key);
      if (t && window.confirm(`Delete table "${t.name}" and its columns?`)) actions.deleteTable(key);
    } else if (act === 'del-col') {
      actions.deleteColumn(key, colOf(btn));
    } else if (act === 'tog') {
      const col = colOf(btn);
      const c = getModel().tables.find(x => x.key === key)?.columns.find(x => x.name === col);
      if (!c) return;
      const on = btn.dataset.kind === 'unique' ? c.unique : btn.dataset.kind === 'pk' ? c.pk : c.nn;
      actions.toggleConstraint(key, col, btn.dataset.kind, !on);
    } else if (act === 'add-col') {
      const name = actions.addColumn(key);
      if (name) { expanded.add(key); focusAfter = { key, col: name }; render(); }
    } else if (act === 'add-table') {
      const res = actions.addTable();
      if (res) { expanded.add(res.key); focusAfter = { key: res.key, col: null }; render(); }
    }
  });

  mount.addEventListener('change', (e) => {
    const el = e.target;
    const act = el.dataset && el.dataset.act;
    if (!act) return;
    const key = tableKeyOf(el);
    const value = el.value.trim();
    if (act === 'rename-table') {
      const t = getModel().tables.find(x => x.key === key);
      if (!t || !value || value === t.name) { render(); return; }
      if (expanded.has(key)) { expanded.delete(key); expanded.add(value.toLowerCase()); }
      actions.rename('table', key, null, value);
    } else if (act === 'rename-col') {
      const col = colOf(el);
      if (!value || value === col) { render(); return; }
      actions.rename('column', key, col, value);
    } else if (act === 'set-type') {
      actions.setType(key, colOf(el), value);
    }
  });

  mount.addEventListener('keydown', (e) => {
    if (!e.target.matches('input')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    else if (e.key === 'Escape') { render(); }
  });

  return {
    render,
    expandTable(key) { if (key) expanded.add(key); },
  };
}

// escape a value for use inside a CSS attribute selector
function cssq(s) { return String(s).replace(/["\\]/g, '\\$&'); }
