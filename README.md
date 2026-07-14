# &lt;SSRMGrid&gt;

A **transparent CSRM-style AG Grid component backed by FINOS Perspective**.

You use it like a client-side-row-model ag-grid — pass `columnDefs`, `rowData`,
`getRowId`, and call `applyTransaction` for realtime updates. Under the hood it
runs **AG Grid Enterprise in Server-Side Row Model (SSRM) mode** against a
**Perspective (WASM) engine in a Web Worker**, so grouping, aggregation, pivot,
sorting and filtering all happen server-side at scale — and every row can tick
live without the client holding the whole dataset.

Because it *is* ag-grid, you get 100% of its look/feel/features for free (set
filters, floating filters, tool panels, row-group & pivot panels, status bar,
charts, Excel export, master/detail, a11y). Because Perspective is the engine,
it stays fast and live-updates at high tick rates.

## Design laws

- **Data semantics live in Perspective; presentation stays in ag-grid.**
- All **aggregations** are Perspective aggregates (`aggFunc` selects one).
- All **calculated columns** are Perspective **expressions** (`perspectiveExpression`
  on the ColDef) — so they group/aggregate/sort/filter server-side.
- All CSRM data features are implemented on the Perspective backend (the query
  engine): group-expand-to-leaf, aggregation, sort, filter, set-filter distinct
  values, pivot, quick filter, totals.
- To the consumer it's transparent — they never see SSRM or Perspective.

## Usage

```tsx
const gridRef = useRef<SSRMGridHandle>(null);

<SSRMGrid
  ref={gridRef}
  columnDefs={[
    { field: "book", rowGroup: true, filter: "agSetColumnFilter" },
    { field: "pnl", cellDataType: "number", aggFunc: "sum" },
    { field: "pnlBps", perspectiveExpression: '"pnl" / "notional" * 10000', aggFunc: "avg" },
  ]}
  rowData={rows}
  getRowId="id"
/>

// realtime — routes into Perspective + throttled SSRM refresh
gridRef.current.applyTransactionAsync({ update: changedRows });
```

## Run

```bash
npm install
npm run dev
```

Optional AG Grid Enterprise license via `VITE_AG_GRID_LICENSE` (a watermark shows
without one; all features still work).

The demo (`src/App.tsx` + `src/demo/tickEngine.ts`) synthesizes a 5k-row blotter
grouped by book, aggregated, with a Perspective calculated column, and ticks a
tunable number of rows/sec through `applyTransactionAsync`.

## Layout

- `src/ssrmgrid/` — the reusable component (`SSRMGrid.tsx`, `columnOverride.ts`).
- `src/ssrm/` — worker client, SSRM datasource, refresh policy, protocol types.
- `src/workers/` — the Perspective SSRM backend (host, query engine, filters).
- `src/data/schemas.ts` — the per-dataset schema/index registry (set at configure).
- `src/demo/` — the live-ticking demo data.

Productized from the `agssrm` spike (STOMP-fed) into a protocol-agnostic component:
STOMP ingest replaced by the consumer `rowData`/`applyTransaction` bridge, and the
hardcoded positions/trades schema replaced by a schema derived from `columnDefs`.
