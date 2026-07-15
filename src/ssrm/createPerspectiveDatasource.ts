import type { IServerSideDatasource } from "ag-grid-community";

import {
  fingerprintBlockRequest,
  type BlockCacheKeyParts,
  type CachedGetRows,
  type SsrmBlockCache,
} from "./ssrmBlockCache";
import type { RowMirror } from "./rowMirror";
import type { DatasetId, SsrmGetRowsResult } from "./types";
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

function toCached(result: SsrmGetRowsResult): CachedGetRows {
  return {
    rowData: result.rowData,
    rowCount: result.rowCount,
    ...(result.pivotResultFields
      ? { pivotResultFields: result.pivotResultFields }
      : {}),
    ...(result.totals ? { totals: result.totals } : {}),
    ...(result.aggregates ? { aggregates: result.aggregates } : {}),
    ...(result.filteredRowCount != null
      ? { filteredRowCount: result.filteredRowCount }
      : {}),
  };
}

export type PerspectiveDatasourceExtras = {
  quickFilterText?: string;
  quickFilterFields?: string[];
  treeData?: boolean;
  absSort?: boolean;
  rowKeepExpression?: string;
  /** Bumped on purge refresh; drop block results from an older generation. */
  refreshGeneration?: number;
  /**
   * When true, attach AG Grid 36 `grandTotalData` on success (native
   * `grandTotalRow` modes).
   */
  includeGrandTotal?: boolean;
  /** False until configure + initial setRowData finish. */
  isConfigured?: boolean;
  /**
   * Prefer over polling `isConfigured`: resolves when configure finishes
   * (or false on timeout). Used by getRows cold-start wait.
   */
  waitUntilConfigured?: () => Promise<boolean>;
  /**
   * Main-thread leaf book for sync flat/leaf getRows (Perspective-like scroll).
   */
  rowMirror?: RowMirror | null;
};

export function createPerspectiveDatasource(
  getClient: () => ReturnType<typeof createWorkerClient> | null,
  getDataset: () => DatasetId,
  getExtras?: () => PerspectiveDatasourceExtras,
  onTotals?: (
    totals: Record<string, unknown>,
    filteredRowCount: number,
    aggregates?: Record<string, Record<string, unknown>>,
  ) => void,
  /**
   * Optional main-thread block cache. Hits call `params.success` synchronously.
   * Host should `clear()` on purge; leaf ticks should `patchRows` instead.
   */
  blockCache?: SsrmBlockCache,
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
        pivotMode: Boolean(req.pivotMode),
        groupKeys: [...(req.groupKeys ?? [])],
        filterModel: (req.filterModel ?? {}) as Record<string, unknown>,
        sortModel: (req.sortModel ?? []).map((s) => ({
          colId: s.colId,
          sort: s.sort,
        })),
        quickFilterText: extras.quickFilterText,
        quickFilterFields: extras.quickFilterFields,
        treeData: extras.treeData,
        absSort: extras.absSort,
        rowKeepExpression: extras.rowKeepExpression,
        refreshGeneration: generationAtStart,
      };
      const cacheKey = fingerprintBlockRequest(keyParts);

      const deliver = (result: CachedGetRows) => {
        if (result.totals && onTotals) {
          onTotals(
            result.totals,
            result.filteredRowCount ?? result.rowCount,
            result.aggregates,
          );
        }

        const includeGrandTotal =
          Boolean(extras.includeGrandTotal) &&
          (req.groupKeys?.length ?? 0) === 0 &&
          (params.needsGrandTotal ||
            Boolean(result.aggregates || result.totals));

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
      };

      // Sync path: main-thread leaf mirror → no blank placeholder rows on fling.
      if (extras.isConfigured && extras.rowMirror?.isReady) {
        const mirrored = extras.rowMirror.tryGetRows({
          startRow,
          endRow,
          rowGroupCols: keyParts.rowGroupCols,
          groupKeys: keyParts.groupKeys,
          pivotMode: keyParts.pivotMode,
          filterModel: keyParts.filterModel,
          sortModel: keyParts.sortModel,
          quickFilterText: extras.quickFilterText,
          quickFilterFields: extras.quickFilterFields,
          treeData: extras.treeData,
          absSort: extras.absSort,
          rowKeepExpression: extras.rowKeepExpression,
        });
        if (mirrored) {
          const cached: CachedGetRows = {
            rowData: mirrored.rowData,
            rowCount: mirrored.rowCount,
          };
          if (blockCache) blockCache.set(cacheKey, cached);
          deliver(cached);
          return;
        }
      }

      // Sync path: block cache hit → no Loading flash.
      if (blockCache && extras.isConfigured) {
        const hit = blockCache.get(cacheKey);
        if (hit) {
          deliver(hit);
          return;
        }
      }

      const run = async () => {
        // Cold mounts fire getRows before configure+setRowData. Await the gate
        // instead of a busy-wait poll so we do not stack timers.
        const extrasLive = getExtras?.() ?? {};
        const ready = extrasLive.isConfigured
          ? true
          : extrasLive.waitUntilConfigured
            ? await extrasLive.waitUntilConfigured()
            : false;
        if (!ready && !getExtras?.().isConfigured) {
          params.fail();
          return;
        }

        const load = async (): Promise<CachedGetRows> => {
          const result = await client.getRows({
            dataset: getDataset(),
            startRow,
            endRow,
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
            rowKeepExpression: extras.rowKeepExpression,
          });
          return toCached(result);
        };

        const result = blockCache
          ? await blockCache.getOrLoad(cacheKey, load)
          : await load();

        const currentGen = getExtras?.().refreshGeneration ?? 0;
        if (generationAtStart !== currentGen) {
          params.fail();
          return;
        }

        deliver(result);
      };

      void run().catch((err) => {
        const currentGen = getExtras?.().refreshGeneration ?? 0;
        if (generationAtStart !== currentGen) {
          params.fail();
          return;
        }
        console.error("[SSRM getRows] failed", err);
        params.fail();
      });
    },
  };
}
