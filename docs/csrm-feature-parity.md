# CSRM feature parity — what works in `<SSRMGrid>` and what doesn't

`<SSRMGrid>` presents a CSRM-style API but runs AG Grid in **SSRM** against
Perspective. That shifts every *data* operation to the server (the Perspective
query engine). Three consequences shape the gap list:

1. **Presentation features are unaffected** — anything ag-grid renders client-side
   (renderers, styles, column ops, panels) works exactly as in CSRM.
2. **Data features must be implemented server-side** — grouping/agg/sort/filter/
   pivot are done by the query engine. Most are done; a few need wiring.
3. **Client-callback data features cannot work** — any feature that runs *your JS*
   over the data (custom aggFunc, valueGetter-for-data, comparator, doesFilterPass)
   can't, because the client never holds all rows. These have a Perspective
   equivalent (expressions / aggregates) instead.

Legend: ✅ works · 🟡 works but needs a prop/wiring (not on by default) ·
⚙️ engine supports it, component doesn't expose it yet · 🔴 fundamentally not
possible in SSRM — use the Perspective equivalent. (v) = verified live.

## 🔴 Fundamentally NOT available (CSRM-only client callbacks)

| CSRM feature | Why not | Do this instead |
|---|---|---|
| Custom **`aggFunc`** as a JS function | agg runs in Perspective over blocks, not in the browser | a Perspective aggregate name, or a `perspectiveExpression` column + sum |
| **`valueGetter`** feeding grouping/agg/sort/filter | server never sees a client getter | `perspectiveExpression` (real Perspective column) ✅(v — calc col works) |
| Custom sort **`comparator`** (JS) | sort is server-side | Perspective sort semantics (or an expression to sort on) |
| **`postSortRows`** hook | client-side reorder of all rows | n/a |
| **External filter** (`isExternalFilterPresent`/`doesExternalFilterPass`) | client callback | encode as a filterModel / Perspective filter |
| Custom **filter component** `doesFilterPass` (client) | client callback | a server-mapped filter (text/number/date/set/custom-model) |
| `forEachNode` / `getModel().getRow(i)` over **all** rows | only loaded blocks are in memory | the queryAll escape hatch (worker `queryAll`) |
| `getRowClass`/`getRowStyle` computed from **all** rows | only sees loaded rows | per-row styles from row values work; whole-dataset ones don't |

## ✅ Works today (verified or clearly wired)

**Data (server-side via Perspective):**
- Row grouping + expand-to-leaf ✅(v)
- Aggregation — sum/avg/min/max/count/first/last/median/stddev/var/distinct-count/weighted-avg ✅(v sum/avg)
- Calculated columns via `perspectiveExpression` — group/agg/sort/filter on them ✅(v)
- Sorting (single) ✅; multi-column sort ✅ (engine maps a sortModel array; ctrl-click)
- Filters: text (equals/contains/…), number (inRange/gt/lt/…), date, **set** (distinct values from Perspective), multi-condition (AND/OR), advanced-filter mapping ✅(v set + filtering)
- Live transactions — `applyTransaction`/`applyTransactionAsync` → Perspective upsert/remove, live aggregate ripple ✅(v)

**Presentation / interaction (ag-grid client-side, unchanged):**
- Cell renderers, `valueFormatter`, `cellStyle`, `cellClassRules` ✅(v cellStyle PnL colour)
- Column ops: resize, reorder, pin, hide, autosize, column groups, column state ✅
- Row selection (single/multi, checkbox, header checkbox) ✅(v); cell range selection + fill handle ✅
- Cell editing → `updateRows` (Perspective), provided editors (text/number/date/select/largeText/checkbox), undo/redo ✅
- Clipboard copy; paste onto editable cells → edit path ✅
- Status bar (row count + aggregation) ✅(v); Side bar Columns + Filters tool panels ✅(v)
- Row-group panel ✅(v), pivot panel ✅(v), floating filters ✅(v), column menu, context menu ✅
- Themes, localisation, ARIA, loading / no-rows overlays ✅

## 🟡 Available but not on by default (needs a prop / small wiring)

| Feature | State | To enable |
|---|---|---|
| **Quick filter** (global search) | engine has server-side quick filter; component doesn't pass `quickFilterText` or render a box | add a search input → thread `quickFilterText` through the datasource extras (already plumbed in `createPerspectiveDatasource`) |
| **Pagination** | `PaginationModule` registered; SSRM paginates server-side | set `pagination`/`paginationPageSize` on the grid |
| **Advanced filter** | engine maps it; removed because it *replaces* column/set filters | expose an opt-in `advancedFilter` prop (mutually exclusive with column filters) |
| **Export all rows** (CSV/Excel) | default export = **loaded blocks only**; engine has `queryAll` + the `exportAllViaAgGrid` helper | wire context-menu export → `exportAllViaAgGrid` |
| **Pinned top/bottom rows** | passthrough props | pass `pinnedTopRowData`/`pinnedBottomRowData` |
| **"Select all" across unloaded rows** | ag-grid SSRM has server-side selection state | opt into `selectAll`/selection state config |
| **Abs-value sort** | engine has `absSort`; component passes empty extras | thread `absSort` through extras |

## ⚙️ Engine supports it, component doesn't expose it yet

| Feature | Engine | Missing wiring |
|---|---|---|
| **Master / detail** | worker `getDetailRows` (a Perspective query per master) | `masterDetail` + `isRowMaster` + `detailCellRendererParams` on the grid, and consumer props to declare the detail dataset/join |
| **Integrated charts** (full-set series) | worker `getSeriesData` | `enableCharts` + range-chart wiring (range charts on loaded rows work already; full-set series needs the helper) |
| **Tree data** | query engine has a tree path (`treeData`/hierarchy) | `treeData` + `isServerSideGroup`/`getServerSideGroupKey`; consumer declares hierarchy fields |
| **Pivot** | `split_by` + pivot result fields in the query engine | pivot is plumbed (`serverSidePivotResultFieldSeparator` set); needs a live verification pass across multi-value/multi-pivot |
| **Group footers / grand-total row** | not built | add a totals-row query + `grandTotalRow`/`groupTotalRow` |

## Bottom line

The **common CSRM surface works** — grouping, aggregation, calculated columns,
sorting, all the filter types incl. set filters, selection, editing, live ticking,
and the whole presentation/chrome layer. The gaps are: (a) a handful of **client-JS
callbacks that must become Perspective expressions/aggregates** (unavoidable, but
with a clean equivalent), and (b) several **enterprise features already built in
the query engine that just need to be surfaced as `<SSRMGrid>` props** — quick
filter, pagination, export-all, master/detail, charts, tree data, advanced filter,
grand totals. None of (b) is hard; each is a request→Perspective mapping plus grid
options, most already present in the `agssrm` base.
