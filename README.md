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
- **Required vs nullable**: a nullable column's type carries a trailing `?`
  (`varchar(255)?`) — `NOT NULL` and primary-key columns are unmarked. Input formats
  that can't express nullability (Mermaid, PlantUML, BigQuery) show no marker at all.

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
  raw-DEFLATE-compressed + URL-safe base64. The `#…` fragment is never sent to a server, so sharing
  needs **no backend**, and opening the link restores the exact diagram.
- **Export** to **PNG** (raster) and **SVG** (vector).
- **Embed**: copies an `<iframe>` snippet for a read-only, live-panning/zooming
  version of the diagram — see [Embedding a diagram](#embedding-a-diagram) below.
- **Schema comparisons**: send both SQL snapshots to highlight added and removed
  tables, columns and foreign keys — see [Code review links](#code-review-links).

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

## Schema comparisons

In the app, choose **File → Compare with previous schema…**, then paste or open the
older schema. The SQL already in the editor becomes the new schema. The editor then
shows **Previous** and **New** tabs; edit either and the diagram updates. The
visual editor, input format and dialect pickers are unavailable while comparing.
**Exit comparison** (in the editor header or the File menu) keeps the new schema.

### Code review links

Generate a comparison link from two complete PostgreSQL schema snapshots, such as
`pg_dump --schema-only` artifacts. Run this from CI with Node.js 18 or newer; no
package installation is required:

```bash
node scripts/create-comparison-link.mjs previous.sql current.sql
```

The script prints a URL. Its optional third argument selects a self-hosted viewer
or an embed, for example `https://your-viewer.example/?embed=1`.

For integrations in another language, encode this project object as UTF-8 JSON,
compress it with **raw DEFLATE** (without a gzip or zlib wrapper), then encode the
bytes as unpadded URL-safe base64. Append it to the viewer URL as `#s=z<encoded>`:

```json
{
  "app": "dbdiga",
  "version": 2,
  "mode": "diff",
  "dialect": "postgres",
  "previousSql": "CREATE TABLE users (id bigint, name text);",
  "sql": "CREATE TABLE users (id bigint, name text, email text);"
}
```

`previousSql` is the baseline; `sql` is the proposed schema. Either may be an empty
string to represent an empty database. Supply complete snapshots, not migration
scripts. Existing single-schema links continue to work.

The diagram combines both versions in one layout. Additions are green with `+`;
removals are red with `−`. Changed columns appear as adjacent old and new rows.
Removed foreign keys use dashed red lines. Unchanged objects retain their usual
appearance. Pan, zoom, arrange and hide tables as usual; on-diagram editing and
inferred relationships are disabled in comparisons. Share, Embed and Save retain both
snapshots and the layout, and PNG/SVG exports retain the change colours. Open a
saved comparison JSON file to restore it. Code-format exports are disabled because
the combined diagram contains objects from two different schemas.

Comparison covers table and column names, declared column types, nullability,
primary/unique column flags, enum values and foreign-key endpoints (including all
columns of composite foreign keys). PostgreSQL `ALTER TABLE … ADD` primary and
unique keys are recognised. Unqualified table names are treated as `public`, and
schema-qualified names and quoted identifier case distinguish objects.
Whitespace, SQL comments and ordering do not count as changes. Renames appear as
a removal and an addition; equivalent type aliases can appear as type changes.

This is a diagram comparison, not a full PostgreSQL migration analyser. Defaults,
checks, indexes, constraint names, foreign-key actions, composite primary/unique
constraint grouping and database objects outside the diagram are not compared.
SQL `COMMENT ON` changes alone are not highlighted. Parse errors identify which
snapshot needs attention.

Both snapshots are carried in the URL, so links grow with schema size. The
generator omits layout data to keep CI links smaller. If a review tool cannot
handle a long link, distribute the same JSON payload as a downloadable project
file and open it with **Open**.

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
