import type { IServerSideDatasource } from "ag-grid-community";

import type { DatasetId } from "./types";
import type { createWorkerClient } from "./workerClient";

export function throttle(fn: () => void, ms: number): () => void {
  let last = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return () => {
    const now = Date.now();
    const remaining = ms - (now - last);

    if (remaining <= 0) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      last = now;
      fn();
      return;
    }

    if (!timeout) {
      timeout = setTimeout(() => {
        last = Date.now();
        timeout = null;
        fn();
      }, remaining);
    }
  };
}

function buildGrandTotalData(
  valueCols: { field: string; aggFunc: string }[],
  aggregates?: Record<string, Record<string, unknown>>,
  totals?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if ((!aggregates || Object.keys(aggregates).length === 0) && !totals) {
    return undefined;
  }
  const row: Record<string, unknown> = {};
  let hasValue = false;
  for (const vc of valueCols) {
    if (!vc.field) continue;
    const fromAgg = aggregates?.[vc.field]?.[vc.aggFunc];
    const value = fromAgg !== undefined ? fromAgg : totals?.[vc.field];
    if (value !== undefined) {
      row[vc.field] = value;
      hasValue = true;
    }
  }
  return hasValue ? row : undefined;
}

export function createPerspectiveDatasource(
  getClient: () => ReturnType<typeof createWorkerClient> | null,
  getDataset: () => DatasetId,
  getExtras?: () => {
    quickFilterText?: string;
    quickFilterFields?: string[];
    treeData?: boolean;
    absSort?: boolean;
    /** Bumped on purge refresh; drop block results from an older generation. */
    refreshGeneration?: number;
    /**
     * When true, attach AG Grid 36 `grandTotalData` on success (native
     * `grandTotalRow` modes).
     */
    includeGrandTotal?: boolean;
  },
  onTotals?: (
    totals: Record<string, unknown>,
    filteredRowCount: number,
    aggregates?: Record<string, Record<string, unknown>>,
  ) => void,
): IServerSideDatasource {
  return {
    getRows(params) {
      const client = getClient();
      if (!client) {
        params.fail();
        return;
      }
      const req = params.request;
      const extras = getExtras?.() ?? {};
      const generationAtStart = extras.refreshGeneration ?? 0;
      const valueCols = (req.valueCols ?? []).map((c) => ({
        id: c.id,
        field: c.field ?? "",
        aggFunc: c.aggFunc ?? "",
      }));
      client
        .getRows({
          dataset: getDataset(),
          startRow: req.startRow ?? 0,
          endRow: req.endRow ?? 100,
          rowGroupCols: (req.rowGroupCols ?? []).map((c) => ({
            id: c.id,
            field: c.field ?? "",
            displayName: c.displayName ?? "",
          })),
          valueCols,
          pivotCols: (req.pivotCols ?? []).map((c) => ({
            id: c.id,
            field: c.field ?? "",
            displayName: c.displayName ?? "",
          })),
          pivotMode: Boolean(req.pivotMode),
          groupKeys: req.groupKeys ?? [],
          filterModel: (req.filterModel ?? {}) as Record<string, unknown>,
          sortModel: (req.sortModel ?? []).map((s) => ({
            colId: s.colId,
            sort: s.sort as "asc" | "desc",
          })),
          quickFilterText: extras.quickFilterText,
          quickFilterFields: extras.quickFilterFields,
          treeData: extras.treeData,
          absSort: extras.absSort,
        })
        .then((result) => {
          const currentGen = getExtras?.().refreshGeneration ?? 0;
          if (generationAtStart !== currentGen) {
            // Superseded by a purge refresh. Still settle so AG Grid does not
            // leave the store stuck on the Loading overlay.
            params.fail();
            return;
          }
          if (result.totals && onTotals) {
            onTotals(
              result.totals,
              result.filteredRowCount ?? result.rowCount,
              result.aggregates,
            );
          }

          const includeGrandTotal =
            Boolean(extras.includeGrandTotal) &&
            // Root store only — nested group stores must not replace the footer.
            (req.groupKeys?.length ?? 0) === 0 &&
            (params.needsGrandTotal || Boolean(result.aggregates || result.totals));

          const grandTotalData = includeGrandTotal
            ? buildGrandTotalData(valueCols, result.aggregates, result.totals)
            : undefined;

          params.success({
            rowData: result.rowData,
            rowCount: result.rowCount,
            ...(result.pivotResultFields
              ? { pivotResultFields: result.pivotResultFields }
              : {}),
            ...(grandTotalData ? { grandTotalData } : {}),
          });
        })
        .catch(() => {
          const currentGen = getExtras?.().refreshGeneration ?? 0;
          if (generationAtStart !== currentGen) {
            params.fail();
            return;
          }
          params.fail();
        });
    },
  };
}
