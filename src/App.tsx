import { useEffect, useMemo, useRef, useState } from "react";
import { SSRMGrid, type SSRMGridHandle } from "./ssrmgrid/SSRMGrid";
import type { SSRMColDef } from "./ssrmgrid/columnOverride";
import { generateRows, startTicking, type DemoRow } from "./demo/tickEngine";

const ROW_COUNT = 5000;

export default function App() {
  const gridRef = useRef<SSRMGridHandle>(null);
  const rowsRef = useRef<DemoRow[]>([]);
  if (rowsRef.current.length === 0) rowsRef.current = generateRows(ROW_COUNT);

  const [rate, setRate] = useState(500);
  const [totals, setTotals] = useState("");

  const columnDefs = useMemo<SSRMColDef[]>(
    () => [
      { field: "book", enableRowGroup: true, rowGroup: true, hide: true, filter: "agSetColumnFilter" },
      { field: "trader", enableRowGroup: true, filter: "agSetColumnFilter" },
      { field: "region", enableRowGroup: true, filter: "agSetColumnFilter" },
      { field: "currency", headerName: "Ccy", enableRowGroup: true, filter: "agSetColumnFilter", width: 90 },
      { field: "instrumentType", headerName: "Type", enableRowGroup: true, filter: "agSetColumnFilter" },
      {
        field: "price",
        cellDataType: "number",
        filter: "agNumberColumnFilter",
        aggFunc: "avg",
        valueFormatter: (p) => (typeof p.value === "number" ? p.value.toFixed(2) : ""),
      },
      { field: "quantity", headerName: "Qty", cellDataType: "number", filter: "agNumberColumnFilter", aggFunc: "sum" },
      {
        field: "notional",
        cellDataType: "number",
        filter: "agNumberColumnFilter",
        aggFunc: "sum",
        valueFormatter: (p) => (typeof p.value === "number" ? p.value.toLocaleString() : ""),
      },
      {
        field: "pnl",
        headerName: "PnL",
        cellDataType: "number",
        filter: "agNumberColumnFilter",
        aggFunc: "sum",
        cellStyle: (p) =>
          typeof p.value === "number" ? { color: p.value < 0 ? "#c0392b" : "#1e8449" } : null,
        valueFormatter: (p) => (typeof p.value === "number" ? p.value.toLocaleString() : ""),
      },
      { field: "dailyPnl", headerName: "Daily PnL", cellDataType: "number", filter: "agNumberColumnFilter", aggFunc: "sum" },
      // Calculated column — computed inside Perspective (server-side), so it
      // aggregates/sorts/filters like a real column.
      {
        field: "pnlBps",
        headerName: "PnL (bps)",
        cellDataType: "number",
        perspectiveExpression:
          '"notional" != 0 and "notional" != null ? "pnl" / "notional" * 10000 : null',
        aggFunc: "avg",
        valueFormatter: (p) => (typeof p.value === "number" ? p.value.toFixed(1) : ""),
      },
    ],
    [],
  );

  useEffect(() => {
    const stop = startTicking(rowsRef.current, rate, (updates) => {
      gridRef.current?.applyTransactionAsync({ update: updates });
    });
    return stop;
  }, [rate]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", margin: 0 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "8px 16px",
          borderBottom: "1px solid #ddd",
          font: "13px Inter, system-ui, sans-serif",
        }}
      >
        <strong>&lt;SSRMGrid&gt;</strong>
        <span style={{ color: "#666" }}>
          AG Grid Enterprise (SSRM) · FINOS Perspective engine · {ROW_COUNT.toLocaleString()} rows,
          all ticking
        </span>
        <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          Tick rate: <strong>{rate.toLocaleString()}</strong> rows/s
          <input
            type="range"
            min={0}
            max={5000}
            step={100}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </label>
        <span style={{ color: "#333", minWidth: 260, textAlign: "right" }}>{totals}</span>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SSRMGrid
          ref={gridRef}
          columnDefs={columnDefs}
          rowData={rowsRef.current}
          getRowId="id"
          onTotals={setTotals}
        />
      </div>
    </div>
  );
}
