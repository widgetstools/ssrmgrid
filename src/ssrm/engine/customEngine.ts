import { RowMirror } from "../rowMirror";
import { aggregateMirrorTotals } from "../mirrorGroupAgg";
import { materializeCalcColumns } from "./materializeCalcColumns";
import type { SsrmEngine } from "./types";
import type {
  AggregateRequest,
  AggregateResult,
  DetailRowsRequest,
  FeedConfig,
  QueryAllRequest,
  QueryAllResult,
  SeriesDataRequest,
  SeriesDataResult,
  SsrmGetRowsRequest,
  SsrmGetRowsResult,
  TransactionRequest,
  DatasetId,
} from "../types";
import type { DirtyMessage } from "../applyWorkerDirtyToGrid";

/**
 * Main-thread SSRM engine — RowMirror only, no Perspective worker.
 *
 * Supports flat + row-group + tree + named aggs + absSort + rowKeepExpression +
 * main-thread-safe filters + quick filter. Pivot mode is not supported.
 */
export function createCustomEngine(): SsrmEngine & {
  getMirror(): RowMirror;
} {
  const mirror = new RowMirror();
  let index = "id";
  let calcExpressions: Record<string, string> = {};
  let treeFields: string[] = [];
  let dirtyHandler: ((msg: DirtyMessage) => void) | null = null;

  const emitDirty = (transaction?: DirtyMessage["transaction"]) => {
    dirtyHandler?.({
      type: "dirty",
      at: Date.now(),
      ...(transaction ? { transaction } : {}),
    });
  };

  const withCalcs = (rows: Record<string, unknown>[]) =>
    materializeCalcColumns(rows, calcExpressions);

  const resolveRowGroupCols = (request: {
    treeData?: boolean;
    rowGroupCols?: SsrmGetRowsRequest["rowGroupCols"];
  }) => {
    if (request.treeData && treeFields.length > 0) {
      return treeFields.map((field) => ({
        id: field,
        field,
        displayName: field,
      }));
    }
    return request.rowGroupCols ?? [];
  };

  const engine: SsrmEngine & { getMirror(): RowMirror } = {
    getMirror: () => mirror,

    configure(config: FeedConfig) {
      index = config.index;
      calcExpressions = config.calcExpressions ?? {};
      treeFields = config.treeFields ?? [];
      mirror.clear();
    },

    setRowData(_dataset: DatasetId, rows: Record<string, unknown>[]) {
      const projected = withCalcs(rows);
      mirror.replaceAll(projected, index);
      emitDirty();
      return projected.length;
    },

    getRows(request: SsrmGetRowsRequest): SsrmGetRowsResult {
      if (request.pivotMode) {
        throw new Error("CustomEngine: pivot mode is not supported");
      }
      const rowGroupCols = resolveRowGroupCols(request);
      const slice = mirror.tryGetRows({
        startRow: request.startRow,
        endRow: request.endRow,
        rowGroupCols,
        groupKeys: request.groupKeys ?? [],
        pivotMode: false,
        filterModel: request.filterModel ?? {},
        sortModel: request.sortModel ?? [],
        valueCols: request.valueCols,
        quickFilterText: request.quickFilterText,
        quickFilterFields: request.quickFilterFields,
        treeData: request.treeData,
        absSort: request.absSort,
        rowKeepExpression: request.rowKeepExpression,
        idField: index,
      });
      if (!slice) {
        throw new Error(
          "CustomEngine: request not supported (unsafe filter / empty book)",
        );
      }
      return {
        rowData: slice.rowData,
        rowCount: slice.rowCount,
        totals: slice.totals,
        aggregates: slice.aggregates,
        filteredRowCount: slice.filteredRowCount,
      };
    },

    getFilterValues(_dataset: DatasetId, field: string) {
      const seen = new Set<string | null>();
      const out: (string | null)[] = [];
      for (const row of mirror.getAllRows()) {
        const v = row[field];
        const key = v == null ? null : String(v);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
      out.sort((a, b) =>
        String(a ?? "").localeCompare(String(b ?? ""), undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
      return out;
    },

    updateRows(_dataset: DatasetId, rows: Record<string, unknown>[]) {
      const projected = withCalcs(rows);
      const merged = mirror.patchById(projected);
      emitDirty({ dataset: "main", update: merged });
    },

    removeRows(_dataset: DatasetId, ids: (string | number)[]) {
      mirror.removeByIds(ids);
      emitDirty();
    },

    applyTransaction(request: TransactionRequest) {
      if (request.remove?.length) {
        mirror.removeByIds(request.remove);
      }
      const add = request.add?.length ? withCalcs(request.add) : undefined;
      const update = request.update?.length
        ? mirror.patchById(withCalcs(request.update))
        : undefined;
      if (add?.length) {
        mirror.patchById(add);
      }
      if (add?.length || request.remove?.length) {
        emitDirty();
      } else if (update?.length) {
        emitDirty({ dataset: "main", update });
      } else {
        emitDirty();
      }
    },

    getAggregates(request: AggregateRequest): AggregateResult {
      const slice = mirror.tryGetRows({
        startRow: 0,
        endRow: Number.MAX_SAFE_INTEGER,
        rowGroupCols: [],
        groupKeys: [],
        pivotMode: false,
        filterModel: request.filterModel ?? {},
        sortModel: [],
        valueCols: request.valueCols,
        quickFilterText: request.quickFilterText,
        quickFilterFields: request.quickFilterFields,
        rowKeepExpression: request.rowKeepExpression,
        idField: index,
      });
      if (!slice) {
        return { totals: {}, aggregates: {}, rowCount: 0 };
      }
      if (request.valueCols.length === 0) {
        return {
          totals: {},
          aggregates: {},
          rowCount: slice.rowCount,
        };
      }
      // Prefer unstamped leaves for agg (strip __ssrm_* if present)
      const leaves = slice.rowData.map((r) => {
        const { __ssrm_aggs: _a, __ssrm_sums: _s, ...rest } = r;
        void _a;
        void _s;
        return rest;
      });
      const { totals, aggregates } = aggregateMirrorTotals(
        leaves,
        request.valueCols,
      );
      return { totals, aggregates, rowCount: slice.rowCount };
    },

    queryAll(request: QueryAllRequest): QueryAllResult {
      if (request.pivotMode) {
        throw new Error("CustomEngine.queryAll: pivot mode is not supported");
      }
      const limit =
        request.limit === null || request.limit === undefined
          ? Number.MAX_SAFE_INTEGER
          : request.limit;
      const includeStructure = Boolean(request.includeStructure);
      const rowGroupCols = includeStructure
        ? resolveRowGroupCols({
            treeData: request.treeData,
            rowGroupCols: request.rowGroupCols,
          })
        : [];
      const groupKeys = includeStructure ? (request.groupKeys ?? []) : [];

      const slice = mirror.tryGetRows({
        startRow: 0,
        endRow: limit,
        rowGroupCols,
        groupKeys,
        pivotMode: false,
        filterModel: request.filterModel ?? {},
        sortModel: request.sortModel ?? [],
        valueCols: request.valueCols,
        quickFilterText: request.quickFilterText,
        quickFilterFields: request.quickFilterFields,
        treeData: request.treeData,
        absSort: request.absSort,
        rowKeepExpression: request.rowKeepExpression,
        idField: index,
      });
      if (!slice) {
        throw new Error("CustomEngine.queryAll: unsupported filter shape");
      }
      return { rowData: slice.rowData, rowCount: slice.rowCount };
    },

    getSeriesData(request: SeriesDataRequest): SeriesDataResult {
      const slice = mirror.tryGetRows({
        startRow: 0,
        endRow: request.limit ?? Number.MAX_SAFE_INTEGER,
        rowGroupCols: [
          { id: request.categoryField, field: request.categoryField },
        ],
        groupKeys: [],
        pivotMode: false,
        filterModel: request.filterModel ?? {},
        sortModel: [],
        valueCols: request.valueCols,
        quickFilterText: request.quickFilterText,
        quickFilterFields: request.quickFilterFields,
        rowKeepExpression: request.rowKeepExpression,
        idField: index,
      });
      if (!slice) {
        return { rowData: [], rowCount: 0 };
      }
      return { rowData: slice.rowData, rowCount: slice.rowCount };
    },

    getDetailRows(request: DetailRowsRequest): Record<string, unknown>[] {
      const filterModel: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(request.match)) {
        if (typeof value === "number") {
          filterModel[field] = {
            filterType: "number",
            type: "equals",
            filter: value,
          };
        } else if (typeof value === "boolean") {
          filterModel[field] = {
            filterType: "text",
            type: "equals",
            filter: String(value),
          };
        } else {
          filterModel[field] = {
            filterType: "text",
            type: "equals",
            filter: value == null ? "" : String(value),
          };
        }
      }
      const slice = mirror.tryGetRows({
        startRow: 0,
        endRow: request.limit ?? 500,
        rowGroupCols: [],
        groupKeys: [],
        pivotMode: false,
        filterModel,
        sortModel: [],
        idField: index,
      });
      return slice?.rowData ?? [];
    },

    setDirtyHandler(handler) {
      dirtyHandler = handler;
    },

    dispose() {
      dirtyHandler = null;
      mirror.clear();
      calcExpressions = {};
      treeFields = [];
    },
  };

  return engine;
}
