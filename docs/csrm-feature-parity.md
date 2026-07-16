# CSRM feature parity — what works in `<SSRMGrid>` and what doesn't

`<SSRMGrid>` presents a CSRM-style API but runs AG Grid **36** in **SSRM** against
Perspective. That shifts every *data* operation to the server (the Perspective
query engine). Three consequences shape the gap list:

1. **Presentation features are unaffected** — anything ag-grid renders client-side
   (renderers, styles, column ops, panels) works exactly as in CSRM.
2. **Data features must be implemented server-side** — grouping/agg/sort/filter/
   pivot are done by the query engine.
3. **Client-callback data features cannot work natively** — any feature that runs
   *your JS* over the full book (custom aggFunc, valueGetter-for-data, comparator,
   doesFilterPass) must become a Perspective expression / named aggregate, or use
   the handle escape hatches below.

## Two engines (pick one component)

| Component | Engine | When to use |
|---|---|---|
| **`<SSRMGrid>`** | Perspective worker (`createPerspectiveEngine`) | Very large books, **pivot**, full Perspective calc DSL |
| **`<CustomSSRMGrid>`** | Main-thread RowMirror (`createCustomEngine`) — **no Perspective** | Tick/scroll-sensitive blotters; MarketsGrid mid-size books |

Shared contract: `SsrmEngine` (`src/ssrm/engine/`).

**CustomSSRMGrid supports (P0–P2):** row grouping, named/`trafficLight` aggs,
quick/set filters, `rowKeepExpression`, richer calc materialize (`if`/`IFS`/`SUM`),
`__ssrm_aggs` for `shareOfTotal`, export-all, chart-all, `absSort`, tree data,
master/detail, floating filters, cell selection. **Not supported: pivot.**

Legend: ✅ works · 🟡 opt-in / approximate · 🔴 fundamentally not possible in SSRM —
use the Perspective equivalent. (v) = verified live. Targets **AG Grid 36**.

## 🔴 Fundamentally NOT available (CSRM-only client callbacks)

| CSRM feature | Why not | Do this instead |
|---|---|---|
| Custom **`aggFunc`** as arbitrary JS over all leaves | agg runs in Perspective over blocks, not in the browser | named Perspective agg (`sum`/`avg`/…), or **`trafficLight`/`rag`**. Function aggs are resolved by name when known, else approximated as **`sum`** (dev warn) |
| **`valueGetter`** (JS function) feeding grouping/agg/sort/filter | server never sees a client getter | `perspectiveExpression`, or a mappable string `valueGetter` / `calculatedExpression` (see approximations) |
| Custom sort **`comparator`** (JS) | sort is server-side | Perspective sort semantics (or an expression to sort on) |
| **`postSortRows`** hook | client-side reorder of all rows | n/a |
| **External filter** (`isExternalFilterPresent`/`doesExternalFilterPass`) | client callback | encode as a filterModel / Perspective filter |
| Custom **filter component** `doesFilterPass` (client) | client callback | a server-mapped filter (text/number/date/set/custom-model) |
| `forEachNode` / `getModel().getRow(i)` over **all** rows | only loaded blocks are in memory | `ref.queryAll()` / `ref.forEachMatching()` |
| `getRowClass`/`getRowStyle` computed from **all** rows | only sees loaded rows | per-row styles from row values work; whole-dataset ones don't |
| `rowSelection.selectAll: 'filtered' \| 'currentPage'` | AG Grid 36: SSRM only allows `'all'` | use `selectAll: 'all'` + `get/setServerSideSelectionState` |
| Excel **Formulas** (`FormulaModule`, `=SUM()` in cells) | AG Grid: unsupported with SSRM / grouping / pivot / agg | calculated columns / `perspectiveExpression` |

## 🟡 Approximations (server-side stand-ins for CSRM callbacks)

| CSRM pattern | SSRM approximation |
|---|---|
| String / bracket **calculated columns** | AG Grid `calculatedExpression` + `calculatedColumns` (default on) for **loaded rows**. Same-row `[field]` refs that rewrite cleanly are also registered as `perspectiveExpression` so group/agg/sort/filter work over the full book |
| String **`valueGetter`** (`data.a + data.b`) | Compiled for loaded-row display; arithmetic forms lift to Perspective calc columns |
| String **`editable` / `cellStyle` / `cellClassRules`** | Compiled to functions for loaded rows (CSRM tooling DSLs) |
| Custom JS **`aggFunc`** | Named string aggs + `trafficLight`/`rag`. Unknown functions → `sum` (dev warn) |
| `forEachNode` over the book | `ref.forEachMatching(cb)` / `ref.queryAll()` via Perspective |

Prefer an explicit `perspectiveExpression` when the column must participate in
server grouping/aggregation — it is the source of truth under SSRM.

## ✅ Works today (verified or clearly wired)

**Data (server-side via Perspective):**
- Row grouping + expand-to-leaf ✅(v)
- Aggregation — sum/avg/min/max/count/first/last/median/stddev/var/distinct-count/weighted-avg ✅(v sum/avg)
- Calculated columns via `perspectiveExpression` — group/agg/sort/filter on them ✅(v)
- AG Grid `calculatedExpression` (same-row) on loaded SSRM rows + auto-lift when mappable 🟡
- Sorting (single + multi) ✅; `absSort` ✅
- Filters: text, number, date, **set**, multi-condition, advanced filter ✅(v)
- Quick filter (`quickFilterText` / `quickFilterFields`) + match highlighting ✅(v)
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
- Full-set walk — `ref.queryAll()` / `ref.forEachMatching()` ✅

**Presentation / interaction (ag-grid client-side, unchanged):**
- Cell renderers, `valueFormatter`, `cellStyle`, `cellClassRules` ✅(v)
- String expression forms for editable / cellStyle / cellClassRules (compiled) 🟡
- Column ops: resize, reorder, pin, hide, autosize, column groups, column state ✅
- Row selection (multi + checkbox + header checkbox + group descendants) ✅(v)
- Cell range selection + fill handle ✅
- Cell editing → `updateRows`, undo/redo ✅
- Clipboard; side bar; status bar (custom server row count) ✅(v)
- Row-group panel, pivot panel, floating filters, column/context menu ✅
- Themes, localisation, ARIA, loading / no-rows overlays ✅

## 🟡 Opt-in props / handle APIs

| Feature | Prop / API |
|---|---|
| Quick filter | `quickFilterText`, `quickFilterFields`, `highlightQuickFilter` |
| Pagination | `pagination`, `paginationPageSize` |
| Advanced filter | `advancedFilter` (exclusive with column filters) |
| Abs-value sort | `absSort` |
| Pinned rows | `pinnedTopRowData` / `pinnedBottomRowData` |
| Grand total | `grandTotalRow` (`true` ≡ `'pinnedBottom'`, or `'top'\|'bottom'\|'pinnedTop'\|'pinnedBottom'`) |
| Group footers | `groupTotalRow` (`'top'\|'bottom'`) |
| Charts | `enableCharts` + range charts on loaded cells; **Chart all filtered rows** / `ref.chartFilteredData()` for full set |
| Master/detail | `masterDetail={{ detailColumnDefs, getDetailRowData? \| matchFields? }}` |
| Tree data | `treeFields` |
| AG Grid calculated columns | `calculatedColumns` (default **true**) + ColDef `calculatedExpression` |
| SSRM selection state | `ref.getServerSideSelectionState()` / `setServerSideSelectionState()` |
| Count matching | `ref.countMatching(filterModel)` |
| Group leaf fetch | `ref.getGroupLeafRows({ groupKeys })` |
| Full-set query | `ref.queryAll(opts?)` |
| Full-set walk | `ref.forEachMatching(callback, opts?)` |

Helpers exported from the package for tooling: `compileExpression`,
`tryValueGetterToPerspective`, `tryCalculatedExpressionToPerspective`,
`resolveAggFuncName`.

## Bottom line

The **common CSRM surface works** on AG Grid 36 — grouping, aggregation, calculated
columns (Perspective + AG Grid same-row), sorting, filters (incl. set), selection
(including select-all across unloaded rows), editing, live ticking, group/grand
totals, full-set export/charts/`queryAll`/`forEachMatching`, master/detail, and
the presentation/chrome layer.

Remaining hard gaps are only **arbitrary client-JS data callbacks** that cannot
run over an unloaded book. Those have Perspective / handle equivalents — use
them explicitly rather than expecting CSRM semantics by accident.
