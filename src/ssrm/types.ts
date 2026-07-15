/** A dataset is just a named Perspective table; the component uses one ("main"). */
export type DatasetId = string;

export type PerspectiveColumnType =
  | "string"
  | "float"
  | "integer"
  | "date"
  | "datetime"
  | "boolean";

/**
 * Configure a dataset. The <SSRMGrid> component derives this from the consumer's
 * columnDefs (types + calculated-column expressions + optional tree hierarchy)
 * and the getRowId field (`index`). Protocol-agnostic: no feed/transport here —
 * the consumer supplies data via setRowData + applyTransaction.
 */
export interface FeedConfig {
  dataset: DatasetId;
  /** column -> Perspective type; the table is created from this schema. */
  schema: Record<string, PerspectiveColumnType>;
  /** primary-key column: Perspective `index` and ag-grid `getRowId`. */
  index: string;
  /** name -> Perspective expression for calculated columns. */
  calcExpressions?: Record<string, string>;
  /** Optional tree-data hierarchy fields (outer -> inner). */
  treeFields?: string[];
  /** Live-refresh throttle in ms (default 150). */
  refreshThrottleMs?: number;
  /** When true, SSRM uses hierarchy fields as tree data instead of OLAP groups. */
  treeDataMode?: boolean;
  /** Absolute-value sort for numeric measure columns. */
  absSort?: boolean;
}

export interface SsrmSortEntry {
  colId: string;
  sort: "asc" | "desc";
  /** Compare / sort by abs(value) for numeric columns. */
  abs?: boolean;
}

export interface SsrmGetRowsRequest {
  dataset: DatasetId;
  // mirror fields used from IServerSideGetRowsRequest
  startRow: number;
  endRow: number;
  rowGroupCols: { id: string; field: string; displayName: string }[];
  valueCols: { id: string; field: string; aggFunc: string }[];
  pivotCols: { id: string; field: string; displayName: string }[];
  /** True when AG Grid pivot mode is active (no leaf drill-down). */
  pivotMode: boolean;
  groupKeys: string[];
  filterModel: Record<string, unknown>;
  sortModel: SsrmSortEntry[];
  /** Server-side quick filter (OR contains across text columns). */
  quickFilterText?: string;
  /** Restrict quick filter to these string fields (default: all non-PK strings). */
  quickFilterFields?: string[];
  /** Treat groupKeys as a tree path over hierarchy fields. */
  treeData?: boolean;
  /** Absolute-value sort for numeric measure columns. */
  absSort?: boolean;
}

export interface SsrmGetRowsResult {
  rowData: Record<string, unknown>[];
  rowCount: number;
  /** Pivot result field ids for AG Grid (separator matches Perspective `|`). */
  pivotResultFields?: string[];
  /**
   * Convenience map: field → filtered sum(field). Prefer `aggregates` when
   * you need avg/min/max/count/….
   */
  totals?: Record<string, unknown>;
  /**
   * Filtered aggregates from the worker: field → aggFunc → value over the
   * full matching set (not just the loaded SSRM block). Used for col/agg(col)
   * formatters and cellClassRules via context.aggregates / row.__ssrm_aggs.
   */
  aggregates?: Record<string, Record<string, unknown>>;
  /** Row count of the filtered set used for aggregates (leaf-level). */
  filteredRowCount?: number;
}

export interface AggregateRequest {
  dataset: DatasetId;
  valueCols: { id: string; field: string; aggFunc: string }[];
  filterModel: Record<string, unknown>;
  quickFilterText?: string;
  /** Restrict quick filter to these string fields (default: all non-PK strings). */
  quickFilterFields?: string[];
}

export interface AggregateResult {
  /** field → sum(field) when a sum was requested (compat shortcut). */
  totals: Record<string, unknown>;
  /** field → aggFunc → value for every requested aggregate. */
  aggregates: Record<string, Record<string, unknown>>;
  rowCount: number;
}

export interface QueryAllRequest {
  dataset: DatasetId;
  filterModel: Record<string, unknown>;
  sortModel: SsrmSortEntry[];
  /** Cap rows returned for safety (default 50_000). */
  limit?: number;
  quickFilterText?: string;
  quickFilterFields?: string[];
  /** When true (default false), include current group/pivot structure. */
  includeStructure?: boolean;
  rowGroupCols?: SsrmGetRowsRequest["rowGroupCols"];
  valueCols?: SsrmGetRowsRequest["valueCols"];
  pivotCols?: SsrmGetRowsRequest["pivotCols"];
  pivotMode?: boolean;
  groupKeys?: string[];
  treeData?: boolean;
  absSort?: boolean;
}

export interface QueryAllResult {
  rowData: Record<string, unknown>[];
  rowCount: number;
  pivotResultFields?: string[];
}

export interface SeriesDataRequest {
  dataset: DatasetId;
  /** Category / group_by field (e.g. desk). */
  categoryField: string;
  valueCols: { id: string; field: string; aggFunc: string }[];
  filterModel: Record<string, unknown>;
  quickFilterText?: string;
  /** Restrict quick filter to these string fields (default: all non-PK strings). */
  quickFilterFields?: string[];
  limit?: number;
}

export interface SeriesDataResult {
  rowData: Record<string, unknown>[];
  rowCount: number;
}

export interface DetailRowsRequest {
  dataset: DatasetId;
  /** Field equality map, e.g. { cusip: "…" }. */
  match: Record<string, string | number | boolean | null>;
  limit?: number;
}

export interface TransactionRequest {
  dataset: DatasetId;
  add?: Record<string, unknown>[];
  update?: Record<string, unknown>[];
  remove?: (string | number)[];
}

export type WorkerInbound =
  | { type: "configure"; requestId: string; config: FeedConfig }
  | {
      type: "setRowData";
      requestId: string;
      dataset: DatasetId;
      rows: Record<string, unknown>[];
    }
  | { type: "getRows"; requestId: string; request: SsrmGetRowsRequest }
  | {
      type: "getFilterValues";
      requestId: string;
      dataset: DatasetId;
      field: string;
    }
  | {
      type: "updateRows";
      requestId: string;
      dataset: DatasetId;
      rows: Record<string, unknown>[];
    }
  | {
      type: "removeRows";
      requestId: string;
      dataset: DatasetId;
      ids: (string | number)[];
    }
  | {
      type: "applyTransaction";
      requestId: string;
      request: TransactionRequest;
    }
  | {
      type: "getAggregates";
      requestId: string;
      request: AggregateRequest;
    }
  | {
      type: "queryAll";
      requestId: string;
      request: QueryAllRequest;
    }
  | {
      type: "getSeriesData";
      requestId: string;
      request: SeriesDataRequest;
    }
  | {
      type: "getDetailRows";
      requestId: string;
      request: DetailRowsRequest;
    }
  | { type: "dispose"; requestId: string };

export type WorkerOutbound =
  | { type: "configureResult"; requestId: string; ok: true; rowCount: number }
  | { type: "configureResult"; requestId: string; ok: false; error: string }
  | { type: "setRowDataResult"; requestId: string; ok: true; rowCount: number }
  | { type: "setRowDataResult"; requestId: string; ok: false; error: string }
  | { type: "getRowsResult"; requestId: string; ok: true; result: SsrmGetRowsResult }
  | { type: "getRowsResult"; requestId: string; ok: false; error: string }
  | {
      type: "getFilterValuesResult";
      requestId: string;
      ok: true;
      values: string[];
    }
  | {
      type: "getFilterValuesResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | { type: "updateRowsResult"; requestId: string; ok: true }
  | { type: "updateRowsResult"; requestId: string; ok: false; error: string }
  | { type: "removeRowsResult"; requestId: string; ok: true }
  | { type: "removeRowsResult"; requestId: string; ok: false; error: string }
  | { type: "applyTransactionResult"; requestId: string; ok: true }
  | { type: "applyTransactionResult"; requestId: string; ok: false; error: string }
  | {
      type: "getAggregatesResult";
      requestId: string;
      ok: true;
      result: AggregateResult;
    }
  | {
      type: "getAggregatesResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "queryAllResult";
      requestId: string;
      ok: true;
      rowData: Record<string, unknown>[];
      rowCount: number;
      pivotResultFields?: string[];
    }
  | { type: "queryAllResult"; requestId: string; ok: false; error: string }
  | {
      type: "getSeriesDataResult";
      requestId: string;
      ok: true;
      result: SeriesDataResult;
    }
  | {
      type: "getSeriesDataResult";
      requestId: string;
      ok: false;
      error: string;
    }
  | {
      type: "getDetailRowsResult";
      requestId: string;
      ok: true;
      rowData: Record<string, unknown>[];
    }
  | { type: "getDetailRowsResult"; requestId: string; ok: false; error: string }
  | { type: "status"; status: "connecting" | "snapshot" | "live" | "error"; detail?: string }
  | {
      type: "dirty";
      at: number;
      /** Optional surgical leaf updates for applyServerSideTransaction. */
      transaction?: {
        dataset: DatasetId;
        update?: Record<string, unknown>[];
        add?: Record<string, unknown>[];
      };
    };
