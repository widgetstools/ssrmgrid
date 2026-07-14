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

export function createPerspectiveDatasource(
  getClient: () => ReturnType<typeof createWorkerClient> | null,
  getDataset: () => DatasetId,
  getExtras?: () => {
    quickFilterText?: string;
    treeData?: boolean;
    absSort?: boolean;
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
          valueCols: (req.valueCols ?? []).map((c) => ({
            id: c.id,
            field: c.field ?? "",
            aggFunc: c.aggFunc ?? "",
          })),
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
          treeData: extras.treeData,
          absSort: extras.absSort,
        })
        .then((result) => {
          if (result.totals && onTotals) {
            onTotals(
              result.totals,
              result.filteredRowCount ?? result.rowCount,
              result.aggregates,
            );
          }
          params.success({
            rowData: result.rowData,
            rowCount: result.rowCount,
            ...(result.pivotResultFields
              ? { pivotResultFields: result.pivotResultFields }
              : {}),
          });
        })
        .catch(() => params.fail());
    },
  };
}
