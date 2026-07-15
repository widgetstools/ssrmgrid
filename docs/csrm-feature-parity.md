# CSRM feature parity — what works in `<SSRMGrid>` and what doesn't

`<SSRMGrid>` presents a CSRM-style API but runs AG Grid **36** in **SSRM** against
Perspective. That shifts every *data* operation to the server (the Perspective
query engine). Three consequences shape the gap list:

1. **Presentation features are unaffected** — anything ag-grid renders client-side
   (renderers, styles, column ops, panels) works exactly as in CSRM.
2. **Data features must be implemented server-side** — grouping/agg/sort/filter/
   pivot are done by the query engine.
3. **Client-callback data features cannot work** — any feature that runs *your JS*
   over the data (custom aggFunc, valueGetter-for-data, comparator, doesFilterPass)
   can't, because the client never holds all rows. These have a Perspective
   equivalent (expressions / aggregates) instead.

Legend: ✅ works · 🟡 opt-in prop · 🔴 fundamentally not possible in SSRM —
use the Perspective equivalent. (v) = verified live. Targets **AG Grid 36**.

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
| `rowSelection.selectAll: 'filtered' \| 'currentPage'` | AG Grid 36: SSRM only allows `'all'` | use `selectAll: 'all'` + `get/setServerSideSelectionState` |

## ✅ Works today (verified or clearly wired)

**Data (server-side via Perspective):**
- Row grouping + expand-to-leaf ✅(v)
- Aggregation — sum/avg/min/max/count/first/last/median/stddev/var/distinct-count/weighted-avg ✅(v sum/avg)
- Calculated columns via `perspectiveExpression` — group/agg/sort/filter on them ✅(v)
- Sorting (single + multi) ✅; `absSort` ✅
- Filters: text, number, date, **set**, multi-condition, advanced filter ✅(v)
- Quick filter (`quickFilterText` / `quickFilterFields`) ✅(v)
- Pivot (`split_by`, multi-value / multi-pivot result fields) ✅
- Live transactions — `applyTransaction` / `applyTransactionAsync` ✅(v)
- Pagination (`pagination` / `paginationPageSize`) ✅
- Tree data (`treeFields`) ✅
- Export all filtered rows (context menu → `queryAll`) ✅
- Grand total row — AG Grid 36 `grandTotalRow` + datasource `grandTotalData` ✅
- Group footers — AG Grid 36 `groupTotalRow` (aggs already on group rows) ✅
- Select-all across unloaded rows — `selectAll: 'all'` + SSRM selection state API on the handle ✅
- Full-set charts — context menu / `chartFilteredData()` via `getSeriesData` ✅
- Master/detail — consumer `getDetailRowData` **or** worker `matchFields` → `getDetailRows` ✅

**Presentation / interaction (ag-grid client-side, unchanged):**
- Cell renderers, `valueFormatter`, `cellStyle`, `cellClassRules` ✅(v)
- Column ops: resize, reorder, pin, hide, autosize, column groups, column state ✅
- Row selection (multi + checkbox + header checkbox + group descendants) ✅(v)
- Cell range selection + fill handle ✅
- Cell editing → `updateRows`, undo/redo ✅
- Clipboard; side bar; status bar (custom server row count) ✅(v)
- Row-group panel, pivot panel, floating filters, column/context menu ✅
- Themes, localisation, ARIA, loading / no-rows overlays ✅

## 🟡 Opt-in props (off by default)

| Feature | Prop / API |
|---|---|
| Quick filter | `quickFilterText`, `quickFilterFields` |
| Pagination | `pagination`, `paginationPageSize` |
| Advanced filter | `advancedFilter` (exclusive with column filters) |
| Abs-value sort | `absSort` |
| Pinned rows | `pinnedTopRowData` / `pinnedBottomRowData` |
| Grand total | `grandTotalRow` (`true` ≡ `'pinnedBottom'`, or `'top'\|'bottom'\|'pinnedTop'\|'pinnedBottom'`) |
| Group footers | `groupTotalRow` (`'top'\|'bottom'`) |
| Charts | `enableCharts` + range charts on loaded cells; **Chart all filtered rows** / `ref.chartFilteredData()` for full set |
| Master/detail | `masterDetail={{ detailColumnDefs, getDetailRowData? \| matchFields? }}` |
| Tree data | `treeFields` |
| SSRM selection state | `ref.getServerSideSelectionState()` / `setServerSideSelectionState()` |

## Bottom line

The **common CSRM surface works** on AG Grid 36 — grouping, aggregation, calculated
columns, sorting, filters (incl. set), selection (including select-all across
unloaded rows), editing, live ticking, group/grand totals, full-set export/charts,
master/detail, and the presentation/chrome layer.

Remaining gaps are **only** client-JS data callbacks that must become Perspective
expressions/aggregates (unavoidable under SSRM, with a clean equivalent).
