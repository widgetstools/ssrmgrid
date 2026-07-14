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
  WorkerInbound,
  WorkerOutbound,
} from "./types";
import type { DatasetId } from "./types";

export type StatusHandler = (s: Extract<WorkerOutbound, { type: "status" }>) => void;
export type DirtyHandler = (msg: Extract<WorkerOutbound, { type: "dirty" }>) => void;

const RPC_RESULT_TYPES = new Set<WorkerOutbound["type"]>([
  "configureResult",
  "setRowDataResult",
  "getRowsResult",
  "getFilterValuesResult",
  "updateRowsResult",
  "removeRowsResult",
  "applyTransactionResult",
  "getAggregatesResult",
  "queryAllResult",
  "getSeriesDataResult",
  "getDetailRowsResult",
]);

export function createWorkerClient() {
  const worker = new Worker(
    new URL("../workers/perspective-ssrm.worker.ts", import.meta.url),
    { type: "module" },
  );
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let onStatus: StatusHandler | null = null;
  let onDirty: DirtyHandler | null = null;

  worker.onmessage = (ev: MessageEvent<WorkerOutbound>) => {
    const msg = ev.data;
    if (msg.type === "status") return onStatus?.(msg);
    if (msg.type === "dirty") return onDirty?.(msg);
    if (!("requestId" in msg) || !RPC_RESULT_TYPES.has(msg.type)) return;
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error));
  };

  function rpc<T>(message: WorkerInbound): Promise<T> {
    return new Promise((resolve, reject) => {
      pending.set(message.requestId, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage(message);
    });
  }

  return {
    configure(config: FeedConfig) {
      return rpc({ type: "configure", requestId: crypto.randomUUID(), config });
    },
    setRowData(dataset: DatasetId, rows: Record<string, unknown>[]): Promise<number> {
      return rpc<{ ok: true; rowCount: number }>({
        type: "setRowData",
        requestId: crypto.randomUUID(),
        dataset,
        rows,
      }).then((r) => r.rowCount);
    },
    getRows(request: SsrmGetRowsRequest): Promise<SsrmGetRowsResult> {
      return rpc<{ ok: true; result: SsrmGetRowsResult }>({
        type: "getRows",
        requestId: crypto.randomUUID(),
        request,
      }).then((r) => r.result);
    },
    getFilterValues(dataset: DatasetId, field: string): Promise<string[]> {
      return rpc<{ ok: true; values: string[] }>({
        type: "getFilterValues",
        requestId: crypto.randomUUID(),
        dataset,
        field,
      }).then((r) => r.values);
    },
    updateRows(dataset: DatasetId, rows: Record<string, unknown>[]): Promise<void> {
      return rpc<{ ok: true }>({
        type: "updateRows",
        requestId: crypto.randomUUID(),
        dataset,
        rows,
      }).then(() => undefined);
    },
    removeRows(dataset: DatasetId, ids: (string | number)[]): Promise<void> {
      return rpc<{ ok: true }>({
        type: "removeRows",
        requestId: crypto.randomUUID(),
        dataset,
        ids,
      }).then(() => undefined);
    },
    applyTransaction(request: TransactionRequest): Promise<void> {
      return rpc<{ ok: true }>({
        type: "applyTransaction",
        requestId: crypto.randomUUID(),
        request,
      }).then(() => undefined);
    },
    getAggregates(request: AggregateRequest): Promise<AggregateResult> {
      return rpc<{ ok: true; result: AggregateResult }>({
        type: "getAggregates",
        requestId: crypto.randomUUID(),
        request,
      }).then((r) => r.result);
    },
    queryAll(request: QueryAllRequest): Promise<QueryAllResult> {
      return rpc<{
        ok: true;
        rowData: Record<string, unknown>[];
        rowCount: number;
        pivotResultFields?: string[];
      }>({
        type: "queryAll",
        requestId: crypto.randomUUID(),
        request,
      }).then((r) => ({
        rowData: r.rowData,
        rowCount: r.rowCount,
        pivotResultFields: r.pivotResultFields,
      }));
    },
    getSeriesData(request: SeriesDataRequest): Promise<SeriesDataResult> {
      return rpc<{ ok: true; result: SeriesDataResult }>({
        type: "getSeriesData",
        requestId: crypto.randomUUID(),
        request,
      }).then((r) => r.result);
    },
    getDetailRows(request: DetailRowsRequest): Promise<Record<string, unknown>[]> {
      return rpc<{ ok: true; rowData: Record<string, unknown>[] }>({
        type: "getDetailRows",
        requestId: crypto.randomUUID(),
        request,
      }).then((r) => r.rowData);
    },
    setStatusHandler(h: StatusHandler) {
      onStatus = h;
    },
    setDirtyHandler(h: DirtyHandler) {
      onDirty = h;
    },
    dispose() {
      worker.postMessage({ type: "dispose", requestId: crypto.randomUUID() });
      worker.terminate();
    },
  };
}
