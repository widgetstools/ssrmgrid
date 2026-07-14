import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  CellValueChangedEvent,
  ColDef,
  GetRowIdParams,
  GridApi,
} from "ag-grid-community";
import "../agGrid/modules";
import { theme } from "../agGrid/theme";
import {
  createPerspectiveDatasource,
  throttle,
} from "../ssrm/createPerspectiveDatasource";
import { refreshAllLoadedServerSideStores } from "../ssrm/refreshAllLoadedStores";
import type { FeedConfig } from "../ssrm/types";
import { createWorkerClient } from "../ssrm/workerClient";
import { PIVOT_FIELD_SEPARATOR } from "../workers/ssrmQueryEngine";
import { buildColumnOverride, type SSRMColDef } from "./columnOverride";

const DATASET = "main";

/** ag-grid-style transaction (add/update by object, remove by object or id). */
export interface SSRMTransaction {
  add?: Record<string, unknown>[];
  update?: Record<string, unknown>[];
  remove?: (Record<string, unknown> | string | number)[];
}

export interface SSRMGridHandle {
  /** Apply an add/update/remove transaction (routes into Perspective). */
  applyTransaction(tx: SSRMTransaction): void;
  /** Batched high-frequency variant — coalesced into one Perspective update. */
  applyTransactionAsync(tx: SSRMTransaction): void;
  /** The underlying ag-grid GridApi (escape hatch). */
  getApi(): GridApi | null;
}

export interface SSRMGridProps {
  /** ag-grid column defs (+ optional perspectiveExpression / perspectiveType). */
  columnDefs: SSRMColDef[];
  /** Initial snapshot rows. */
  rowData?: Record<string, unknown>[];
  /** Primary-key field: Perspective index AND ag-grid row id. */
  getRowId: string;
  /** Live-refresh throttle in ms (default 150). */
  refreshThrottleMs?: number;
  /** Passthrough default column def. */
  defaultColDef?: ColDef;
  /** Called with a short summary string of filtered totals after each refresh. */
  onTotals?: (summary: string) => void;
  /** Grid host height (default 100%). */
  height?: string | number;
}

function coerceEdited(
  schema: Record<string, string>,
  field: string,
  value: unknown,
): unknown {
  const type = schema[field];
  if (type === "float" || type === "integer") {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    return type === "integer" ? Math.trunc(n) : n;
  }
  if (value == null) return null;
  return String(value);
}

function formatTotals(totals: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(totals)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      parts.push(`${k}=${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    }
  }
  return parts.slice(0, 4).join(" · ");
}

export const SSRMGrid = forwardRef<SSRMGridHandle, SSRMGridProps>(
  function SSRMGrid(props, ref) {
    const { columnDefs, rowData, getRowId: idField } = props;
    const apiRef = useRef<GridApi | null>(null);
    const clientRef = useRef<ReturnType<typeof createWorkerClient> | null>(null);
    const throttleRef = useRef<(() => void) | null>(null);
    const gridReadyRef = useRef(false);
    const configuredRef = useRef(false);
    const asyncBufferRef = useRef<SSRMTransaction | null>(null);
    const [, forceRerender] = useState(0);

    // Distinct values for set filters -> Perspective, server-side.
    const getFilterValues = useCallback(
      (field: string): Promise<(string | null)[]> => {
        const client = clientRef.current;
        if (!client) return Promise.resolve([]);
        return client.getFilterValues(DATASET, field);
      },
      [],
    );

    // columnDefs -> Perspective schema/calc + the ag-grid defs.
    const override = useMemo(
      () =>
        buildColumnOverride(columnDefs, {
          index: idField,
          sampleRow: rowData?.[0],
          getFilterValues,
        }),
      [columnDefs, idField, rowData, getFilterValues],
    );
    const schemaRef = useRef(override.schema);
    schemaRef.current = override.schema;

    const feedConfig = useMemo<FeedConfig>(
      () => ({
        dataset: DATASET,
        schema: override.schema,
        index: idField,
        calcExpressions: override.calcExpressions,
        refreshThrottleMs: props.refreshThrottleMs ?? 150,
      }),
      [override, idField, props.refreshThrottleMs],
    );
    const feedConfigRef = useRef(feedConfig);
    feedConfigRef.current = feedConfig;

    const refreshTotals = useCallback(async () => {
      const client = clientRef.current;
      const api = apiRef.current;
      if (!client || !api) return;
      const valueCols = api.getValueColumns().map((col) => {
        const def = col.getColDef();
        return {
          id: col.getColId(),
          field: def.field ?? col.getColId(),
          aggFunc: String(col.getAggFunc?.() ?? def.aggFunc ?? "sum"),
        };
      });
      if (valueCols.length === 0) return;
      try {
        const filterModel = (api.getFilterModel() ?? {}) as Record<string, unknown>;
        const result = await client.getAggregates({
          dataset: DATASET,
          valueCols,
          filterModel,
        });
        api.setGridOption("context", {
          ...(api.getGridOption("context") as object | undefined),
          totals: result.totals,
          aggregates: result.aggregates,
          filteredRowCount: result.rowCount,
        });
        props.onTotals?.(
          `Σ ${result.rowCount.toLocaleString()} rows · ${formatTotals(result.totals)}`,
        );
      } catch {
        /* ignore transient totals failures */
      }
    }, [props]);

    const datasource = useMemo(
      () =>
        createPerspectiveDatasource(
          () => clientRef.current,
          () => DATASET,
          () => ({}),
          (totals, filteredRowCount) => {
            const api = apiRef.current;
            if (api) {
              api.setGridOption("context", {
                ...(api.getGridOption("context") as object | undefined),
                totals,
                filteredRowCount,
              });
            }
            props.onTotals?.(
              `Σ ${filteredRowCount.toLocaleString()} rows · ${formatTotals(totals)}`,
            );
          },
        ),
      [props],
    );

    // Boot the worker client once.
    useEffect(() => {
      const client = createWorkerClient();
      clientRef.current = client;
      return () => {
        client.dispose();
        clientRef.current = null;
        configuredRef.current = false;
      };
    }, []);

    // (Re)build the throttled refresh when the throttle changes.
    useEffect(() => {
      throttleRef.current = throttle(() => {
        if (apiRef.current) {
          refreshAllLoadedServerSideStores(apiRef.current, { purge: false });
        }
      }, props.refreshThrottleMs ?? 150);
    }, [props.refreshThrottleMs]);

    // Configure the dataset (schema/index) + load the initial snapshot.
    const configureAndLoad = useCallback(async () => {
      const client = clientRef.current;
      if (!client) return;
      await client.configure(feedConfigRef.current);
      if (rowData && rowData.length > 0) {
        await client.setRowData(DATASET, rowData);
      }
      configuredRef.current = true;
      if (gridReadyRef.current && apiRef.current) {
        refreshAllLoadedServerSideStores(apiRef.current, { purge: true });
        void refreshTotals();
      }
    }, [rowData, refreshTotals]);

    // Re-configure when the schema/config changes.
    useEffect(() => {
      if (clientRef.current) void configureAndLoad();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [feedConfig]);

    // Push a new rowData snapshot when it changes after configure.
    const firstRowData = useRef(true);
    useEffect(() => {
      if (firstRowData.current) {
        firstRowData.current = false;
        return; // initial load handled by configureAndLoad
      }
      const client = clientRef.current;
      if (!client || !configuredRef.current) return;
      void client.setRowData(DATASET, rowData ?? []).then(() => {
        if (apiRef.current) {
          refreshAllLoadedServerSideStores(apiRef.current, { purge: true });
          void refreshTotals();
        }
      });
    }, [rowData, refreshTotals]);

    // Normalize a transaction's `remove` to id list (id field or object).
    const removeIds = useCallback(
      (remove: SSRMTransaction["remove"]): (string | number)[] =>
        (remove ?? []).map((r) =>
          typeof r === "object" && r !== null
            ? (r as Record<string, unknown>)[idField] as string | number
            : (r as string | number),
        ),
      [idField],
    );

    const commit = useCallback(
      (tx: SSRMTransaction) => {
        const client = clientRef.current;
        if (!client) return;
        void client
          .applyTransaction({
            dataset: DATASET,
            add: tx.add,
            update: tx.update,
            remove: removeIds(tx.remove),
          })
          .then(() => {
            throttleRef.current?.();
            void refreshTotals();
          });
      },
      [removeIds, refreshTotals],
    );

    useImperativeHandle(
      ref,
      (): SSRMGridHandle => ({
        applyTransaction: (tx) => commit(tx),
        applyTransactionAsync: (tx) => {
          // Coalesce a burst into one Perspective update on the next microtask.
          const buf = asyncBufferRef.current ?? { add: [], update: [], remove: [] };
          buf.add = [...(buf.add ?? []), ...(tx.add ?? [])];
          buf.update = [...(buf.update ?? []), ...(tx.update ?? [])];
          buf.remove = [...(buf.remove ?? []), ...(tx.remove ?? [])];
          if (!asyncBufferRef.current) {
            asyncBufferRef.current = buf;
            queueMicrotask(() => {
              const flush = asyncBufferRef.current;
              asyncBufferRef.current = null;
              if (flush) commit(flush);
            });
          }
        },
        getApi: () => apiRef.current,
      }),
      [commit],
    );

    const getRowIdCb = useCallback(
      (params: GetRowIdParams) => {
        const data = params.data as Record<string, unknown> | undefined;
        if (!data) return crypto.randomUUID();
        // Group row (from the server-side shaper).
        if (typeof data.childCount === "number") {
          const key = typeof data.__ssrmGroupKey === "string" ? data.__ssrmGroupKey : "";
          return `g:${[...(params.parentKeys ?? []), key].join("|")}`;
        }
        const id = data[idField];
        if (id == null || id === "") {
          return `missing:${JSON.stringify(params.parentKeys ?? [])}`;
        }
        return String(id);
      },
      [idField],
    );

    const onCellValueChanged = useCallback(
      (event: CellValueChangedEvent) => {
        const data = event.data as Record<string, unknown> | undefined;
        const field = event.colDef.field;
        if (!data || !field || typeof data.childCount === "number") return;
        const id = data[idField];
        if (id == null || id === "") return;
        const patch = {
          [idField]: id,
          [field]: coerceEdited(schemaRef.current, field, event.newValue),
        };
        void clientRef.current?.updateRows(DATASET, [patch]).catch(() => {
          event.node.setDataValue(field, event.oldValue);
        });
      },
      [idField],
    );

    const onStructureChanged = useCallback(() => {
      apiRef.current?.refreshServerSide({ purge: true });
      void refreshTotals();
    }, [refreshTotals]);

    const defaultColDef = useMemo<ColDef>(
      () => ({
        flex: 1,
        minWidth: 100,
        filter: true,
        enableValue: true,
        enableRowGroup: true,
        enablePivot: true,
        enableCellChangeFlash: true,
        ...props.defaultColDef,
      }),
      [props.defaultColDef],
    );

    const sideBar = useMemo(() => ({ toolPanels: ["columns", "filters"] }), []);
    const statusBar = useMemo(
      () => ({
        statusPanels: [
          { statusPanel: "agTotalAndFilteredRowCountComponent" },
          { statusPanel: "agAggregationComponent" },
        ],
      }),
      [],
    );
    const rowSelection = useMemo(
      () => ({
        mode: "multiRow" as const,
        checkboxes: true,
        headerCheckbox: true,
        enableClickSelection: true,
      }),
      [],
    );
    const cellSelection = useMemo(() => ({ handle: { mode: "fill" as const } }), []);

    void forceRerender;

    return (
      <div style={{ height: props.height ?? "100%", width: "100%" }}>
        <AgGridReact
          theme={theme}
          columnDefs={override.agGridColumnDefs}
          defaultColDef={defaultColDef}
          rowModelType="serverSide"
          serverSideDatasource={datasource}
          cacheBlockSize={100}
          animateRows
          cellFlashDuration={500}
          rowGroupPanelShow="always"
          pivotPanelShow="always"
          sideBar={sideBar}
          statusBar={statusBar}
          enableAdvancedFilter
          rowSelection={rowSelection}
          cellSelection={cellSelection}
          undoRedoCellEditing
          serverSidePivotResultFieldSeparator={PIVOT_FIELD_SEPARATOR}
          getRowId={getRowIdCb}
          getChildCount={(data) =>
            typeof data?.childCount === "number" ? data.childCount : undefined
          }
          onColumnRowGroupChanged={onStructureChanged}
          onColumnPivotChanged={onStructureChanged}
          onColumnPivotModeChanged={onStructureChanged}
          onFilterChanged={() => void refreshTotals()}
          onCellValueChanged={onCellValueChanged}
          onGridReady={(e) => {
            apiRef.current = e.api;
            gridReadyRef.current = true;
            if (!configuredRef.current) void configureAndLoad();
            else {
              refreshAllLoadedServerSideStores(e.api, { purge: true });
              void refreshTotals();
            }
          }}
        />
      </div>
    );
  },
);
