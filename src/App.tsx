import { useEffect, useMemo, useRef, useState } from "react";
import { SSRMGrid, type SSRMGridHandle } from "./ssrmgrid/SSRMGrid";
import type { SSRMColDef } from "./ssrmgrid/columnOverride";
import { generateRows, startTicking, type DemoRow } from "./demo/tickEngine";

const ROW_COUNT = 50_000;

/** Demo stress presets (rows updated / second). */
const TICK_PRESETS = [
  { label: "Off", rate: 0 },
  { label: "1k", rate: 1_000 },
  { label: "5k", rate: 5_000 },
  { label: "10k", rate: 10_000 },
  { label: "20k", rate: 20_000 },
] as const;

const DEFAULT_TICK_RATE = 10_000;
const MAX_TICK_RATE = 20_000;

const pnlStyle = (p: { value?: unknown }) =>
  typeof p.value === "number"
    ? { color: p.value < 0 ? "#c0392b" : "#1e8449" }
    : null;

function dim(
  field: string,
  headerName?: string,
  width?: number,
  opts?: { rowGroup?: boolean },
): SSRMColDef {
  return {
    field,
    ...(headerName ? { headerName } : {}),
    enableRowGroup: true,
    filter: "agSetColumnFilter",
    ...(width != null ? { width } : {}),
    ...(opts?.rowGroup ? { rowGroup: true, hide: true } : {}),
  };
}

function measure(
  field: string,
  opts?: {
    headerName?: string;
    aggFunc?: string;
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
    ...(opts?.style ? { cellStyle: pnlStyle } : {}),
    ...(opts?.width != null ? { width: opts.width } : {}),
  };
}

export default function App() {
  const gridRef = useRef<SSRMGridHandle>(null);
  const rowsRef = useRef<DemoRow[]>([]);
  if (rowsRef.current.length === 0) rowsRef.current = generateRows(ROW_COUNT);

  const [rate, setRate] = useState(DEFAULT_TICK_RATE);
  const [totals, setTotals] = useState("");
  const [quickFilter, setQuickFilter] = useState("");

  const columnDefs = useMemo<SSRMColDef[]>(
    () => [
      // Dimensions (stable under partial ticks — merge must preserve these).
      // Demo opens grouped by book so group-agg + tick path is stressed.
      dim("book", undefined, undefined, { rowGroup: true }),
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
      // Core measures (tick) — raw numbers (no valueFormatter) for tick/flash debugging.
      measure("price", { aggFunc: "avg" }),
      measure("quantity", { headerName: "Qty" }),
      measure("notional"),
      measure("pnl", { headerName: "PnL", style: true }),
      measure("dailyPnl", { headerName: "Daily PnL", style: true }),
      measure("bid", { aggFunc: "avg" }),
      measure("ask", { aggFunc: "avg" }),
      measure("mid", { aggFunc: "avg" }),
      measure("spread", { aggFunc: "avg" }),
      // Risk / greeks (tick)
      measure("delta", { aggFunc: "avg" }),
      measure("gamma", { aggFunc: "avg" }),
      measure("vega", { aggFunc: "avg" }),
      measure("theta", { aggFunc: "avg" }),
      measure("dv01", { headerName: "DV01", style: true }),
      measure("cs01", { headerName: "CS01", style: true }),
      measure("ytm", { headerName: "YTM", aggFunc: "avg" }),
      measure("duration", { aggFunc: "avg" }),
      measure("convexity", { aggFunc: "avg" }),
      measure("volatility", { headerName: "Vol", aggFunc: "avg" }),
      measure("beta", { aggFunc: "avg" }),
      measure("volume"),
      measure("openInterest", { headerName: "OI" }),
      measure("margin"),
      measure("haircut", { aggFunc: "avg" }),
      measure("riskLimit", { headerName: "Limit" }),
      measure("utilization", { headerName: "Util %", aggFunc: "avg" }),
      // Perspective expressions (server-side)
      {
        field: "pnlBps",
        headerName: "PnL (bps)",
        cellDataType: "number",
        perspectiveExpression:
          '"notional" != 0 and "notional" != null ? "pnl" / "notional" * 10000 : null',
        aggFunc: "avg",
      },
      {
        field: "trafficlight",
        headerName: "RAG",
        cellDataType: "number",
        perspectiveExpression: 'if("price" >= 105, 1, if("price" >= 95, 2, 3))',
        aggFunc: "trafficLight",
        width: 90,
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
          AG Grid SSRM · grouped by book · {ROW_COUNT.toLocaleString()} ×{" "}
          {colCount} cols · ticks update leaf + group aggs
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
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>
            Tick: <strong>{rate.toLocaleString()}</strong>/s
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {TICK_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setRate(p.rate)}
                style={{
                  padding: "2px 8px",
                  font: "12px Inter, system-ui",
                  cursor: "pointer",
                  borderRadius: 3,
                  border: "1px solid #555",
                  background: rate === p.rate ? "#3d5a80" : "#2b2b2b",
                  color: "#e6e8ec",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={MAX_TICK_RATE}
            step={500}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            style={{ width: 140 }}
            title="Rows updated per second"
          />
        </div>
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
          // Omit quickFilterFields → all string columns (CSRM-like). Tokens are
          // AND'd across words ("Rates Chen" matches book+trader).
          enableCharts
          enableCellChangeFlash
          grandTotalRow="bottom"
          groupTotalRow="bottom"
        />
      </div>
    </div>
  );
}
