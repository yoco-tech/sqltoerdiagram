# SQL to ER Diagram

**A free, open-source online ERD generator.** Paste a SQL schema (`CREATE TABLE`
statements) → get a clean, interactive entity-relationship diagram.

![deps](https://img.shields.io/badge/deps-2-blue) ![bundle](https://img.shields.io/badge/bundle-32KB%20gzip-brightgreen)

**100% local · no signup · no upload.** It runs entirely in your browser, so your
schema never leaves your machine — no server, no backend. Live at
**[sqltoerdiagram.com](https://sqltoerdiagram.com)**.

## Why

Every other SQL-diagram tool is either paywalled, ugly, or slow. SQL to ER Diagram is
a single static page that stays smooth at **hundreds of tables**, edits your SQL
two-way, and shares a whole diagram in a single link — with no account and nothing
leaving your browser.

## Features

### Parse

- Standard `CREATE TABLE` / `ALTER TABLE` DDL across **PostgreSQL, MySQL, SQLite,
  SQL Server & Snowflake**.

### Visualize & navigate

- **Canvas renderer** with cached bitmaps + viewport culling — smooth at hundreds of
  tables (benchmarked **~120fps** while zooming 300 tables / 593 FKs).
- **Declutter dense schemas**: FK lines are soft by default; **hover** a table to
  highlight just its relationships, **click** to pin focus (fades every unrelated
  table and line), click empty space to clear.
- **Drag** tables, **scroll / pinch to zoom**, and pan.

### Smart layout

- **Hub-aware layered auto-arrange**: the most-connected table is placed on one side
  with its related tables aligned beside it. **Horizontal / Vertical** direction and
  **Compact / Comfortable / Spacious** spacing live under the **Arrange ▾** menu.
- **Overlap-free**: auto-arrange runs a separation pass so no two tables overlap.
- **Your arrangement is saved**: positions and the camera persist automatically, so
  reloading restores your exact layout. Editing SQL keeps your manual positions —
  only brand-new tables get auto-placed beside the rest. **Arrange** re-runs layout
  on demand.

### Edit on the canvas → SQL updates

- **Double-click** a table name, column name, or column type to edit it inline. The
  change is applied as a *surgical text edit* (comments, formatting, and unsupported
  clauses are preserved), and a table rename updates every `REFERENCES` to it.
- **Add columns**: pin a table, then **+ add column**. The new column is inserted into
  your SQL with a default type for the selected **dialect** (PostgreSQL / MySQL /
  SQLite / SQL Server / Snowflake) and opens inline so you can name it. Editing a
  column type shows dialect-aware suggestions.

### Annotate

- A bottom-left palette adds **sticky notes** and **group boxes** to label and cluster
  sections. Drag to move, drag the corner to resize, double-click to edit text, click
  to select (colour swatches + delete), or press Delete. They're part of the diagram —
  included in saves, share links, and PNG/SVG exports.

### Save, share & export

- **Save / Open projects**: **Save** downloads a `.json` project (SQL + layout + camera
  + dialect); **Open** loads one back.
- **Share link**: **Share** copies a URL with the entire project encoded in the hash —
  gzip-compressed + base64. The `#…` fragment is never sent to a server, so sharing
  needs **no backend**, and opening the link restores the exact diagram.
- **Export** to **PNG** (raster) and **SVG** (vector).
- **Embed**: copies an `<iframe>` snippet for a read-only, live-panning/zooming
  version of the diagram — see [Embedding a diagram](#embedding-a-diagram) below.

### Editor & appearance

- **Syntax-highlighted SQL editor**: keywords / types / strings / comments / numbers
  are colored via a paint layer behind the textarea. Re-tokenizing is a single linear
  pass coalesced to one animation frame, so typing stays instant (~6ms full repaint on
  a 45KB / 300-table script, sub-ms on normal schemas).
- **Hide the SQL panel** (⬚ in the toolbar) for a full-width diagram.
- **Light + dark themes**, and it remembers your last schema locally.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

## Build & host

```bash
npm run build    # outputs static files to dist/
npm run preview  # preview the production build locally
```

`dist/` is plain static HTML/JS/CSS — drop it on any static host:

- **GitHub Pages** — push `dist/` to a `gh-pages` branch, or use an action.
- **Netlify / Vercel / Cloudflare Pages** — build command `npm run build`, publish dir `dist`.
- **Any web server / S3 bucket** — just upload the contents of `dist/`.

## Embedding a diagram

Click **Embed** to copy an `<iframe>` snippet that renders a read-only, live
version of the diagram (pan / zoom still work, editing doesn't) — same idea as
**Share**, just wrapped in a frame instead of a link:

```html
<iframe src="https://sqltoerdiagram.com/?embed=1#s=…" width="100%"
        style="border:1px solid #e5e7eb;border-radius:10px;aspect-ratio:1200/700"
        title="ER diagram"></iframe>
```

- **Responsive by default, no JavaScript required**: the snippet has no fixed
  `height` — it uses CSS `aspect-ratio`, baked in from however the diagram was
  framed (zoom + pan) when you clicked **Embed**. Drop it into a narrow sidebar
  or a full-width article and it resizes cleanly at any width. This works even
  though the diagram is served cross-origin — a host page normally can't read
  an iframe's content size to auto-size it, but `aspect-ratio` sidesteps that
  entirely: it's plain CSS on the *host's own* iframe element, so no
  `postMessage` bridge is needed.
- **You can still set your own `height` / `max-height`**: `aspect-ratio` is just
  the suggested default so the frame isn't a fixed size — it's plain CSS on
  your own `<iframe>`, so replace or add to it however you like, e.g.
  `style="width:100%;max-height:400px"`. You don't need to work out an aspect
  ratio yourself; if the box you give it ends up a different shape than the
  one it was composed at, the diagram scales down to fit inside it (like
  `object-fit: contain`) rather than cropping — it may just leave a little
  empty margin on one axis instead of filling the box edge-to-edge.
- Requires a browser with `aspect-ratio` support (every evergreen browser,
  Safari 15+) to size itself with no configured height. Older browsers, or a
  host page that sets its own fixed height, fall back to the iframe's
  specified/default size — the diagram still fits itself inside that box.

## Supported SQL

- `CREATE [OR REPLACE] [TEMPORARY | TRANSIENT] TABLE [IF NOT EXISTS] name ( ... )` with quoted / backtick / `[bracket]` / `schema.qualified` names.
- Inline column constraints: `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `REFERENCES other(col)`.
- Table-level constraints: `PRIMARY KEY (...)`, `UNIQUE (...)`,
  `FOREIGN KEY (...) REFERENCES other(...)`, `CONSTRAINT ... FOREIGN KEY ...`.
- `ALTER TABLE x ADD [CONSTRAINT ...] FOREIGN KEY (...) REFERENCES y(...)`.
- Line (`--`, `#`) and block (`/* */`) comments are ignored.

## BigQuery

Select **BigQuery** from the dialect dropdown to work with BigQuery SQL instead of DDL.

- Paste a raw `WITH … AS (…)` query — no `CREATE TABLE` statements needed. Each CTE becomes a table node in the diagram.
- Column names are extracted from the `SELECT` list of each CTE (using aliases where present).
- Relationships are inferred automatically from `FROM` and `JOIN` references: a CTE that reads from another CTE gets an edge between them, and references to base tables create stub nodes connected to the CTE.
- Backtick-quoted three-part names (`project.dataset.table`) are supported — the table portion is used as the node label.

## Tech

- **Vite** — build + dev server.
- **@dagrejs/dagre** — layered auto-layout.
- Custom canvas renderer + SQL DDL parser (no heavy SQL-parser dependency).

## Shortcuts

| Key                     | Action             |
| ----------------------- | ------------------ |
| **⌘ / Ctrl + Enter**   | Re-arrange         |
| **Double-click** canvas | Zoom in            |
| Drag the pane divider   | Resize the editor  |

## License

[MIT](./LICENSE) © Royal Bhati. Fork it, self-host it, add your own SQL dialects — go for it.
