import type { IServerSideDatasource } from "ag-grid-community";
import type { SsrmEngine } from "./engine/types";
import type { DatasetId, SsrmGetRowsResult } from "./types";
import type { RowMirror } from "./rowMirror";
import {
  fingerprintBlockRequest,
  type BlockCacheKeyParts,
  type CachedGetRows,
  type SsrmBlockCache,
} from "./ssrmBlockCache";

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

function toCached(result: SsrmGetRowsResult): CachedGetRows {
  return {
    rowData: result.rowData,
    rowCount: result.rowCount,
    ...(result.totals ? { totals: result.totals } : {}),
    ...(result.aggregates ? { aggregates: result.aggregates } : {}),
    ...(result.filteredRowCount != null
      ? { filteredRowCount: result.filteredRowCount }
      : {}),
  };
}

export type CustomDatasourceExtras = {
  quickFilterText?: string;
  quickFilterFields?: string[];
  includeGrandTotal?: boolean;
  isConfigured?: boolean;
  waitUntilConfigured?: () => Promise<boolean>;
  rowMirror?: RowMirror | null;
  treeData?: boolean;
  absSort?: boolean;
  rowKeepExpression?: string;
};

/**
 * AG Grid SSRM datasource backed by {@link SsrmEngine} (custom / RowMirror).
 * Prefers sync `getRows` when the engine returns immediately.
 */
export function createCustomDatasource(
  getEngine: () => SsrmEngine | null,
  getDataset: () => DatasetId,
  getExtras?: () => CustomDatasourceExtras,
  onTotals?: (
    totals: Record<string, unknown>,
    filteredRowCount: number,
    aggregates?: Record<string, Record<string, unknown>>,
  ) => void,
  blockCache?: SsrmBlockCache,
): IServerSideDatasource {
  return {
    getRows(params) {
      const engine = getEngine();
      if (!engine) {
        params.fail();
        return;
      }
      const extras = getExtras?.() ?? {};
      const run = async () => {
        if (extras.waitUntilConfigured) {
          const ok = await extras.waitUntilConfigured();
          if (!ok) {
            params.fail();
            return;
          }
        } else if (extras.isConfigured === false) {
          params.fail();
          return;
        }

        const req = params.request;
        const valueCols = (req.valueCols ?? []).map((c) => ({
          id: c.id,
          field: c.field ?? "",
          aggFunc: String(c.aggFunc ?? "sum"),
        }));
        const startRow = req.startRow ?? 0;
        const endRow = req.endRow ?? 100;

        const keyParts: BlockCacheKeyParts = {
          dataset: getDataset(),
          startRow,
          endRow,
          rowGroupCols: (req.rowGroupCols ?? []).map((c) => ({
            id: c.id,
            field: c.field ?? "",
          })),
          valueCols,
          pivotCols: (req.pivotCols ?? []).map((c) => ({
            id: c.id,
            field: c.field ?? "",
          })),
          groupKeys: (req.groupKeys ?? []).map(String),
          filterModel: (req.filterModel ?? {}) as Record<string, unknown>,
          sortModel: (req.sortModel ?? []) as {
            colId: string;
            sort: "asc" | "desc";
          }[],
          pivotMode: Boolean(req.pivotMode),
          quickFilterText: extras.quickFilterText ?? "",
          quickFilterFields: extras.quickFilterFields ?? [],
        };
        const cacheKey = fingerprintBlockRequest(keyParts);
        const cached = blockCache?.get(cacheKey);
        if (cached) {
          params.success({
            rowData: cached.rowData,
            rowCount: cached.rowCount,
            ...(extras.includeGrandTotal
              ? {
                  grandTotalData: buildGrandTotalData(
                    valueCols,
                    cached.aggregates,
                    cached.totals,
                  ),
                }
              : {}),
          });
          if (cached.totals && onTotals) {
            onTotals(
              cached.totals,
              cached.filteredRowCount ?? cached.rowCount,
              cached.aggregates,
            );
          }
          return;
        }

        try {
          const result = await Promise.resolve(
            engine.getRows({
              dataset: getDataset(),
              startRow,
              endRow,
              rowGroupCols: (req.rowGroupCols ?? []).map((c) => ({
                id: c.id,
                field: c.field ?? "",
                displayName: c.displayName ?? c.field ?? c.id,
              })),
              valueCols,
              pivotCols: (req.pivotCols ?? []).map((c) => ({
                id: c.id,
                field: c.field ?? "",
                displayName: c.displayName ?? c.field ?? c.id,
              })),
              pivotMode: Boolean(req.pivotMode),
              groupKeys: (req.groupKeys ?? []).map(String),
              filterModel: (req.filterModel ?? {}) as Record<string, unknown>,
              sortModel: (req.sortModel ?? []).map((s) => ({
                colId: s.colId,
                sort: s.sort as "asc" | "desc",
              })),
              quickFilterText: extras.quickFilterText,
              quickFilterFields: extras.quickFilterFields,
              treeData: extras.treeData,
              absSort: extras.absSort,
              rowKeepExpression: extras.rowKeepExpression,
            }),
          );

          blockCache?.set(cacheKey, toCached(result));
          params.success({
            rowData: result.rowData,
            rowCount: result.rowCount,
            ...(extras.includeGrandTotal
              ? {
                  grandTotalData: buildGrandTotalData(
                    valueCols,
                    result.aggregates,
                    result.totals,
                  ),
                }
              : {}),
          });
          if (result.totals && onTotals) {
            onTotals(
              result.totals,
              result.filteredRowCount ?? result.rowCount,
              result.aggregates,
            );
          }
        } catch {
          params.fail();
        }
      };

      void run();
    },
  };
}
