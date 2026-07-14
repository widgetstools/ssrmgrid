import "./perspectiveWorkerPolyfill";
import type { WorkerInbound, WorkerOutbound } from "../ssrm/types";
import { registerDataset } from "../data/schemas";
import { createPerspectiveHost, type PerspectiveHost } from "./perspectiveHost";

let host: PerspectiveHost | null = null;
let hostInitPromise: Promise<PerspectiveHost> | null = null;
let configureChain: Promise<void> = Promise.resolve();

function emit(msg: WorkerOutbound): void {
  self.postMessage(msg);
}

async function ensureHost(): Promise<PerspectiveHost> {
  if (!hostInitPromise) {
    hostInitPromise = (async () => {
      const h = createPerspectiveHost();
      await h.ready;
      // No dataset is created here — `configure` registers the schema/index first
      // (from the consumer's columnDefs), then creates the empty table.
      host = h;
      return h;
    })();
  }
  return hostInitPromise;
}

function errorReply(msg: WorkerInbound, error: string): WorkerOutbound | null {
  switch (msg.type) {
    case "configure":
      return { type: "configureResult", requestId: msg.requestId, ok: false, error };
    case "setRowData":
      return { type: "setRowDataResult", requestId: msg.requestId, ok: false, error };
    case "getRows":
      return { type: "getRowsResult", requestId: msg.requestId, ok: false, error };
    case "getFilterValues":
      return { type: "getFilterValuesResult", requestId: msg.requestId, ok: false, error };
    case "updateRows":
      return { type: "updateRowsResult", requestId: msg.requestId, ok: false, error };
    case "removeRows":
      return { type: "removeRowsResult", requestId: msg.requestId, ok: false, error };
    case "applyTransaction":
      return { type: "applyTransactionResult", requestId: msg.requestId, ok: false, error };
    case "getAggregates":
      return { type: "getAggregatesResult", requestId: msg.requestId, ok: false, error };
    case "queryAll":
      return { type: "queryAllResult", requestId: msg.requestId, ok: false, error };
    case "getDetailRows":
      return { type: "getDetailRowsResult", requestId: msg.requestId, ok: false, error };
    case "getSeriesData":
      return { type: "getSeriesDataResult", requestId: msg.requestId, ok: false, error };
    default:
      return null;
  }
}

self.onmessage = async (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;

  try {
    switch (msg.type) {
      case "configure": {
        const configureMsg = msg;
        const runConfigure = async (): Promise<void> => {
          const h = await ensureHost();
          const cfg = configureMsg.config;
          // Register the schema/index/calc/tree the consumer derived from
          // columnDefs, then create the (empty) Perspective table for it.
          registerDataset(cfg.dataset, {
            schema: cfg.schema,
            index: cfg.index,
            calcExpressions: cfg.calcExpressions,
            treeFields: cfg.treeFields,
          });
          await h.replaceDataset(cfg.dataset, []);
          const rowCount = await h.size();
          const reply: WorkerOutbound = {
            type: "configureResult",
            requestId: configureMsg.requestId,
            ok: true,
            rowCount,
          };
          self.postMessage(reply);
        };
        configureChain = configureChain.then(runConfigure, runConfigure);
        await configureChain;
        break;
      }
      case "setRowData": {
        const h = await ensureHost();
        const rowCount = await h.replaceDataset(msg.dataset, msg.rows);
        const reply: WorkerOutbound = {
          type: "setRowDataResult",
          requestId: msg.requestId,
          ok: true,
          rowCount,
        };
        self.postMessage(reply);
        break;
      }
      case "getRows": {
        const h = await ensureHost();
        const result = await h.query(msg.request);
        const reply: WorkerOutbound = {
          type: "getRowsResult",
          requestId: msg.requestId,
          ok: true,
          result,
        };
        self.postMessage(reply);
        break;
      }
      case "getFilterValues": {
        const h = await ensureHost();
        const values = await h.getFilterValues(msg.dataset, msg.field);
        const reply: WorkerOutbound = {
          type: "getFilterValuesResult",
          requestId: msg.requestId,
          ok: true,
          values,
        };
        self.postMessage(reply);
        break;
      }
      case "updateRows": {
        const h = await ensureHost();
        await h.upsertRows(msg.dataset, msg.rows);
        const reply: WorkerOutbound = {
          type: "updateRowsResult",
          requestId: msg.requestId,
          ok: true,
        };
        self.postMessage(reply);
        break;
      }
      case "removeRows": {
        const h = await ensureHost();
        await h.removeRows(msg.dataset, msg.ids);
        const reply: WorkerOutbound = {
          type: "removeRowsResult",
          requestId: msg.requestId,
          ok: true,
        };
        self.postMessage(reply);
        break;
      }
      case "applyTransaction": {
        const h = await ensureHost();
        await h.applyTransaction(msg.request);
        const reply: WorkerOutbound = {
          type: "applyTransactionResult",
          requestId: msg.requestId,
          ok: true,
        };
        self.postMessage(reply);
        break;
      }
      case "getAggregates": {
        const h = await ensureHost();
        const result = await h.getAggregates(msg.request);
        const reply: WorkerOutbound = {
          type: "getAggregatesResult",
          requestId: msg.requestId,
          ok: true,
          result,
        };
        self.postMessage(reply);
        break;
      }
      case "queryAll": {
        const h = await ensureHost();
        const { rowData, rowCount } = await h.queryAll(msg.request);
        const reply: WorkerOutbound = {
          type: "queryAllResult",
          requestId: msg.requestId,
          ok: true,
          rowData,
          rowCount,
        };
        self.postMessage(reply);
        break;
      }
      case "getDetailRows": {
        const h = await ensureHost();
        const rowData = await h.getDetailRows(msg.request);
        const reply: WorkerOutbound = {
          type: "getDetailRowsResult",
          requestId: msg.requestId,
          ok: true,
          rowData,
        };
        self.postMessage(reply);
        break;
      }
      case "getSeriesData": {
        const h = await ensureHost();
        const result = await h.getSeriesData(msg.request);
        const reply: WorkerOutbound = {
          type: "getSeriesDataResult",
          requestId: msg.requestId,
          ok: true,
          result,
        };
        self.postMessage(reply);
        break;
      }
      case "dispose": {
        if (host) {
          await host.clear();
          host = null;
        }
        hostInitPromise = null;
        break;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (msg.type === "configure") {
      emit({
        type: "status",
        status: "error",
        detail: error,
      });
    }
    const reply = errorReply(msg, error);
    if (reply) self.postMessage(reply);
  }
};
