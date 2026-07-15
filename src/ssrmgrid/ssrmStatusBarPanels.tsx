import { useEffect, useState } from "react";
import type { CustomStatusPanelProps } from "ag-grid-react";
import type { GridApi, IServerSideSelectionState } from "ag-grid-community";

type CountContext = {
  totalRowCount?: number;
  filteredRowCount?: number;
};

function readCounts(api: GridApi): {
  total: number | null;
  filtered: number | null;
} {
  const ctx = api.getGridOption("context") as CountContext | undefined;
  return {
    total: typeof ctx?.totalRowCount === "number" ? ctx.totalRowCount : null,
    filtered:
      typeof ctx?.filteredRowCount === "number" ? ctx.filteredRowCount : null,
  };
}

/** Same DOM/classes as AG Grid's provided status panels (CSRM look). */
function StatusNameValue({
  panelClass,
  label,
  value,
  hidden = false,
}: {
  panelClass: string;
  label: string;
  value: string;
  hidden?: boolean;
}) {
  return (
    <div
      className={`ag-status-name-value ag-status-panel ${panelClass}${hidden ? " ag-hidden" : ""}`}
      aria-hidden={hidden}
    >
      <span data-ref="eLabel">{label}</span>
      {" :\u00A0"}
      <span className="ag-status-name-value-value" data-ref="eValue">
        {value}
      </span>
    </div>
  );
}

function useModelAndContextCounts(api: GridApi) {
  const [counts, setCounts] = useState(() => readCounts(api));
  useEffect(() => {
    const sync = () => setCounts(readCounts(api));
    sync();
    api.addEventListener("modelUpdated", sync);
    // Totals land in context without always firing modelUpdated.
    const id = window.setInterval(sync, 400);
    return () => {
      api.removeEventListener("modelUpdated", sync);
      window.clearInterval(id);
    };
  }, [api]);
  return counts;
}

/**
 * SSRM stand-in for `agTotalAndFilteredRowCountComponent`.
 * Unfiltered: `Rows : 500`. Filtered: `Rows : 224 of 400`.
 */
export function ServerTotalAndFilteredRowCountPanel({
  api,
}: CustomStatusPanelProps) {
  const { total, filtered } = useModelAndContextCounts(api);
  const isFiltered =
    total != null && filtered != null && filtered !== total;
  const value =
    total == null && filtered == null
      ? "…"
      : isFiltered
        ? `${filtered!.toLocaleString()} of ${total!.toLocaleString()}`
        : (total ?? filtered)!.toLocaleString();

  return (
    <StatusNameValue
      panelClass="ag-status-panel-total-and-filtered-row-count"
      label="Rows"
      value={value}
    />
  );
}

/**
 * SSRM stand-in for `agFilteredRowCountComponent`.
 * Hidden (ag-hidden) when no filter is active — matches CSRM.
 */
export function ServerFilteredRowCountPanel({ api }: CustomStatusPanelProps) {
  const { total, filtered } = useModelAndContextCounts(api);
  const isFiltered =
    total != null && filtered != null && filtered !== total;
  const value =
    filtered == null ? "…" : filtered.toLocaleString();

  return (
    <StatusNameValue
      panelClass="ag-status-panel-filtered-row-count"
      label="Filtered"
      value={value}
      hidden={!isFiltered}
    />
  );
}

function readSsrmSelectedCount(api: GridApi): number {
  const state = api.getServerSideSelectionState?.() as
    | IServerSideSelectionState
    | null
    | undefined;
  if (state && typeof state.selectAll === "boolean") {
    if (state.selectAll) {
      const { total, filtered } = readCounts(api);
      const universe = filtered ?? total;
      if (typeof universe === "number") {
        return Math.max(0, universe - (state.toggledNodes?.length ?? 0));
      }
      return state.toggledNodes?.length ?? 0;
    }
    return state.toggledNodes?.length ?? 0;
  }
  return api.getSelectedNodes?.()?.length ?? 0;
}

/**
 * SSRM stand-in for `agSelectedRowCountComponent` (native shows "?" under SSRM).
 * Hidden when count is 0 — matches CSRM.
 */
export function ServerSelectedRowCountPanel({ api }: CustomStatusPanelProps) {
  const [count, setCount] = useState(() => readSsrmSelectedCount(api));
  useEffect(() => {
    const sync = () => setCount(readSsrmSelectedCount(api));
    sync();
    api.addEventListener("modelUpdated", sync);
    api.addEventListener("selectionChanged", sync);
    return () => {
      api.removeEventListener("modelUpdated", sync);
      api.removeEventListener("selectionChanged", sync);
    };
  }, [api]);

  return (
    <StatusNameValue
      panelClass="ag-status-panel-selected-row-count"
      label="Selected"
      value={count.toLocaleString()}
      hidden={count === 0}
    />
  );
}

/** Default SSRM status bar — mirrors CSRM Overview / lab chrome. */
export const SSRM_DEFAULT_STATUS_BAR = {
  statusPanels: [
    {
      statusPanel: ServerTotalAndFilteredRowCountPanel,
      align: "left" as const,
    },
    {
      statusPanel: ServerFilteredRowCountPanel,
      align: "left" as const,
    },
    {
      statusPanel: ServerSelectedRowCountPanel,
      align: "center" as const,
    },
    {
      statusPanel: "agAggregationComponent",
      align: "right" as const,
    },
  ],
};
