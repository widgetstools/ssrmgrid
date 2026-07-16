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
 * Shared data-plane contract for `<SSRMGrid>` (Perspective) and
 * `<CustomSSRMGrid>` (RowMirror / main-thread).
 *
 * Grid chrome, ColDefs, and AG Grid SSRM wiring stay shared; only the engine
 * behind getRows / mutations / full-set queries changes.
 */
export interface SsrmEngine {
  configure(config: FeedConfig): Promise<void> | void;
  setRowData(dataset: DatasetId, rows: Record<string, unknown>[]): Promise<number> | number;
  getRows(request: SsrmGetRowsRequest): Promise<SsrmGetRowsResult> | SsrmGetRowsResult;
  getFilterValues(dataset: DatasetId, field: string): Promise<(string | null)[]> | (string | null)[];
  updateRows(dataset: DatasetId, rows: Record<string, unknown>[]): Promise<void> | void;
  removeRows(dataset: DatasetId, ids: (string | number)[]): Promise<void> | void;
  applyTransaction(request: TransactionRequest): Promise<void> | void;
  getAggregates(request: AggregateRequest): Promise<AggregateResult> | AggregateResult;
  queryAll(request: QueryAllRequest): Promise<QueryAllResult> | QueryAllResult;
  getSeriesData(request: SeriesDataRequest): Promise<SeriesDataResult> | SeriesDataResult;
  getDetailRows(request: DetailRowsRequest): Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  setDirtyHandler?(handler: ((msg: DirtyMessage) => void) | null): void;
  dispose(): void;
}

export type SsrmEngineKind = "perspective" | "custom";
