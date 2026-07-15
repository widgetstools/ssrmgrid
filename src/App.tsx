import { useEffect, useMemo, useRef, useState } from "react";
import { SSRMGrid, type SSRMGridHandle } from "./ssrmgrid/SSRMGrid";
import type { SSRMColDef } from "./ssrmgrid/columnOverride";
import { generateRows, startTicking, type DemoRow } from "./demo/tickEngine";

const ROW_COUNT = 50_000;

const numFmt2 = (p: { value?: unknown }) =>
  typeof p.value === "number" ? p.value.toFixed(2) : "";
const numFmt1 = (p: { value?: unknown }) =>
  typeof p.value === "number" ? p.value.toFixed(1) : "";
const numFmtInt = (p: { value?: unknown }) =>
  typeof p.value === "number" ? p.value.toLocaleString() : "";
const pnlStyle = (p: { value?: unknown }) =>
  typeof p.value === "number"
    ? { color: p.value < 0 ? "#c0392b" : "#1e8449" }
    : null;

function dim(field: string, headerName?: string, width?: number): SSRMColDef {
  return {
    field,
    ...(headerName ? { headerName } : {}),
    enableRowGroup: true,
    filter: "agSetColumnFilter",
    ...(width != null ? { width } : {}),
  };
}

function measure(
  field: string,
  opts?: {
    headerName?: string;
    aggFunc?: string;
    formatter?: (p: { value?: unknown }) => string;
    style?: boolean;
    width?: number;
  },
): SSRMColDef {
  return {
    field,
    cellDataType: "number",
    filter: "agNumberColumnFilter",
    ...(opts?.headerName ? { headerName: opts.headerName } : {}),
    ...(opts?.aggFunc ? { aggFunc: opts.aggFunc } : { aggFunc: "sum" }),
    ...(opts?.formatter ? { valueFormatter: opts.formatter } : {}),
    ...(opts?.style ? { cellStyle: pnlStyle } : {}),
    ...(opts?.width != null ? { width: opts.width } : {}),
  };
}

export default function App() {
  const gridRef = useRef<SSRMGridHandle>(null);
  const rowsRef = useRef<DemoRow[]>([]);
  if (rowsRef.current.length === 0) rowsRef.current = generateRows(ROW_COUNT);

  const [rate, setRate] = useState(500);
  const [totals, setTotals] = useState("");
  const [quickFilter, setQuickFilter] = useState("");

  const columnDefs = useMemo<SSRMColDef[]>(
    () => [
      // Dimensions (stable under partial ticks — merge must preserve these)
      dim("book"),
      dim("desk"),
      dim("trader"),
      dim("region"),
      dim("currency", "Ccy", 90),
      dim("instrumentType", "Type"),
      dim("sector"),
      dim("issuer"),
      dim("ticker", undefined, 90),
      dim("cusip", undefined, 110),
      dim("country", undefined, 80),
      dim("exchange", undefined, 90),
      dim("strategy"),
      dim("counterparty", "CP"),
      dim("settlement", "Settle", 80),
      dim("rating", undefined, 80),
      dim("tenor", undefined, 80),
      // Core measures (tick)
      measure("price", { aggFunc: "avg", formatter: numFmt2 }),
      measure("quantity", { headerName: "Qty" }),
      measure("notional", { formatter: numFmtInt }),
      measure("pnl", { headerName: "PnL", formatter: numFmtInt, style: true }),
      measure("dailyPnl", { headerName: "Daily PnL", formatter: numFmtInt, style: true }),
      measure("bid", { aggFunc: "avg", formatter: numFmt2 }),
      measure("ask", { aggFunc: "avg", formatter: numFmt2 }),
      measure("mid", { aggFunc: "avg", formatter: numFmt2 }),
      measure("spread", { aggFunc: "avg", formatter: numFmt2 }),
      // Risk / greeks (tick)
      measure("delta", { aggFunc: "avg", formatter: numFmt2 }),
      measure("gamma", { aggFunc: "avg", formatter: numFmt2 }),
      measure("vega", { aggFunc: "avg", formatter: numFmt1 }),
      measure("theta", { aggFunc: "avg", formatter: numFmt1 }),
      measure("dv01", { headerName: "DV01", formatter: numFmtInt, style: true }),
      measure("cs01", { headerName: "CS01", formatter: numFmtInt, style: true }),
      measure("ytm", { headerName: "YTM", aggFunc: "avg", formatter: numFmt2 }),
      measure("duration", { aggFunc: "avg", formatter: numFmt2 }),
      measure("convexity", { aggFunc: "avg", formatter: numFmt1 }),
      measure("volatility", { headerName: "Vol", aggFunc: "avg", formatter: numFmt1 }),
      measure("beta", { aggFunc: "avg", formatter: numFmt2 }),
      measure("volume", { formatter: numFmtInt }),
      measure("openInterest", { headerName: "OI", formatter: numFmtInt }),
      measure("margin", { formatter: numFmtInt }),
      measure("haircut", { aggFunc: "avg", formatter: numFmt1 }),
      measure("riskLimit", { headerName: "Limit", formatter: numFmtInt }),
      measure("utilization", { headerName: "Util %", aggFunc: "avg", formatter: numFmt1 }),
      // Perspective expressions (server-side)
      {
        field: "pnlBps",
        headerName: "PnL (bps)",
        cellDataType: "number",
        perspectiveExpression:
          '"notional" != 0 and "notional" != null ? "pnl" / "notional" * 10000 : null',
        aggFunc: "avg",
        valueFormatter: numFmt1,
      },
      {
        field: "trafficlight",
        headerName: "RAG",
        cellDataType: "number",
        perspectiveExpression: 'if("price" >= 105, 1, if("price" >= 95, 2, 3))',
        aggFunc: "trafficLight",
        width: 90,
        valueFormatter: (p) => {
          if (p.value === 1) return "🟢";
          if (p.value === 2) return "🟡";
          if (p.value === 3) return "🔴";
          return typeof p.value === "number" ? String(p.value) : "";
        },
      },
    ],
    [],
  );

  const colCount = columnDefs.length;

  useEffect(() => {
    const stop = startTicking(rowsRef.current, rate, (updates) => {
      gridRef.current?.applyTransactionAsync({ update: updates });
    });
    return stop;
  }, [rate]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "#1b1b1b",
        color: "#e6e8ec",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "8px 16px",
          borderBottom: "1px solid #3a3a3a",
          font: "13px Inter, system-ui, sans-serif",
        }}
      >
        <strong>&lt;SSRMGrid&gt;</strong>
        <span style={{ color: "#9aa4b0" }}>
          AG Grid Enterprise (SSRM) · Perspective · {ROW_COUNT.toLocaleString()}{" "}
          × {colCount} cols, all ticking
        </span>
        <input
          type="search"
          placeholder="Quick filter…"
          value={quickFilter}
          onChange={(e) => setQuickFilter(e.target.value)}
          style={{
            padding: "4px 8px",
            font: "13px Inter, system-ui",
            width: 160,
            background: "#2b2b2b",
            color: "#e6e8ec",
            border: "1px solid #444",
            borderRadius: 3,
          }}
        />
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
        <span style={{ color: "#9aa4b0", minWidth: 260, textAlign: "right" }}>{totals}</span>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <SSRMGrid
          ref={gridRef}
          columnDefs={columnDefs}
          rowData={rowsRef.current}
          getRowId="id"
          onTotals={setTotals}
          quickFilterText={quickFilter}
          quickFilterFields={[
            "book",
            "desk",
            "trader",
            "region",
            "currency",
            "instrumentType",
            "issuer",
            "ticker",
            "cusip",
          ]}
          enableCharts
          grandTotalRow="bottom"
          groupTotalRow="bottom"
        />
      </div>
    </div>
  );
}
