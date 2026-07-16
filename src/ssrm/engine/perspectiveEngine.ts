import type { SsrmEngine } from "./types";
import { createWorkerClient } from "../workerClient";
import type {
  AggregateRequest,
  DetailRowsRequest,
  FeedConfig,
  QueryAllRequest,
  SeriesDataRequest,
  SsrmGetRowsRequest,
  TransactionRequest,
  DatasetId,
} from "../types";
import type { DirtyMessage } from "../applyWorkerDirtyToGrid";

/**
 * Perspective worker adapter — same surface as {@link SsrmEngine}.
 * `<SSRMGrid>` still owns its client today; this exists so both engines share
 * one contract for MarketsGrid / dual-engine hosts.
 */
export function createPerspectiveEngine(): SsrmEngine {
  const client = createWorkerClient();
  return {
    configure(config: FeedConfig) {
      return client.configure(config).then(() => undefined);
    },
    setRowData(dataset: DatasetId, rows: Record<string, unknown>[]) {
      return client.setRowData(dataset, rows);
    },
    getRows(request: SsrmGetRowsRequest) {
      return client.getRows(request);
    },
    getFilterValues(dataset: DatasetId, field: string) {
      return client.getFilterValues(dataset, field);
    },
    updateRows(dataset: DatasetId, rows: Record<string, unknown>[]) {
      return client.updateRows(dataset, rows);
    },
    removeRows(dataset: DatasetId, ids: (string | number)[]) {
      return client.removeRows(dataset, ids);
    },
    applyTransaction(request: TransactionRequest) {
      return client.applyTransaction(request);
    },
    getAggregates(request: AggregateRequest) {
      return client.getAggregates(request);
    },
    queryAll(request: QueryAllRequest) {
      return client.queryAll(request);
    },
    getSeriesData(request: SeriesDataRequest) {
      return client.getSeriesData(request);
    },
    getDetailRows(request: DetailRowsRequest) {
      return client.getDetailRows(request);
    },
    setDirtyHandler(handler: ((msg: DirtyMessage) => void) | null) {
      client.setDirtyHandler(handler);
    },
    dispose() {
      client.dispose();
    },
  };
}
