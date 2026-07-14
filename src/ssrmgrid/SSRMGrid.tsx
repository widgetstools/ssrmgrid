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
import type { CustomStatusPanelProps } from "ag-grid-react";
import type {
  CellValueChangedEvent,
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GetDetailRowDataParams,
  GetRowIdParams,
  GridApi,
  MenuItemDef,
} from "ag-grid-community";
import "../agGrid/modules";
import { theme } from "../agGrid/theme";
import {
  createPerspectiveDatasource,
  throttle,
} from "../ssrm/createPerspectiveDatasource";
import { exportAllViaAgGrid } from "../ssrm/exportAllViaAgGrid";
import { refreshAllLoadedServerSideStores } from "../ssrm/refreshAllLoadedStores";
import type { FeedConfig } from "../ssrm/types";
import { createWorkerClient } from "../ssrm/workerClient";
import { PIVOT_FIELD_SEPARATOR } from "../workers/ssrmQueryEngine";
import { buildColumnOverride, type SSRMColDef } from "./columnOverride";

const DATASET = "main";

/**
 * Total (filtered) leaf-row count for the SSRM status bar. AG Grid's built-in
 * agTotalRowCount / agFilteredRowCount / agTotalAndFilteredRowCount panels warn
 * and render nothing under the Server-Side Row Model, so — per AG Grid's own
 * custom-status-panel guidance — we render the server-side count that SSRMGrid
 * stashes in grid context (`filteredRowCount`) on every totals refresh.
 */
function ServerRowCountStatusPanel({ api }: CustomStatusPanelProps) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const read = () => {
      const ctx = api.getGridOption("context") as
        | { filteredRowCount?: number }
        | undefined;
      setCount(
        typeof ctx?.filteredRowCount === "number" ? ctx.filteredRowCount : null,
      );
    };
    read();
    api.addEventListener("modelUpdated", read);
    return () => api.removeEventListener("modelUpdated", read);
  }, [api]);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "0 12px",
        lineHeight: "1.5",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ opacity: 0.7 }}>Rows:</span>
      <strong>{count == null ? "…" : count.toLocaleString()}</strong>
    </span>
  );
}

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

  // ---- gap-closing options (all off/absent by default) -------------------
  /** Server-side quick filter (global search across text columns). */
  quickFilterText?: string;
  /** Enable server-side pagination. */
  pagination?: boolean;
  paginationPageSize?: number;
  /** Use the Advanced Filter builder instead of column/set filters (exclusive). */
  advancedFilter?: boolean;
  /** Absolute-value sort for numeric measures. */
  absSort?: boolean;
  /** Pinned rows (passthrough — client-set, independent of the row model). */
  pinnedTopRowData?: Record<string, unknown>[];
  pinnedBottomRowData?: Record<string, unknown>[];
  /** Integrated Charts on the selected range. */
  enableCharts?: boolean;
  /** Show a grand-total pinned bottom row (filtered aggregates). */
  grandTotalRow?: boolean;
  /** Master/detail: expandable detail grid per master row. */
  masterDetail?: {
    detailColumnDefs: ColDef[];
    getDetailRowData: (masterRow: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
    isRowMaster?: (row: Record<string, unknown>) => boolean;
  };
  /** Tree data: hierarchy fields (outer -> inner); leaf rows drill under them. */
  treeFields?: string[];
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
    // Grand-total pinned bottom row (managed via state so React doesn't clobber
    // it — a static pinnedBottomRowData prop would reset an imperative set).
    const [grandTotalData, setGrandTotalData] = useState<Record<string, unknown>[] | undefined>();

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

    const treeData = (props.treeFields?.length ?? 0) > 0;
    const feedConfig = useMemo<FeedConfig>(
      () => ({
        dataset: DATASET,
        schema: override.schema,
        index: idField,
        calcExpressions: override.calcExpressions,
        refreshThrottleMs: props.refreshThrottleMs ?? 150,
        treeFields: props.treeFields,
        treeDataMode: treeData,
        absSort: props.absSort,
      }),
      [override, idField, props.refreshThrottleMs, props.treeFields, treeData, props.absSort],
    );
    const feedConfigRef = useRef(feedConfig);
    feedConfigRef.current = feedConfig;

    // Live extras threaded into every getRows request (read at call time).
    const quickFilterRef = useRef(props.quickFilterText ?? "");
    quickFilterRef.current = props.quickFilterText ?? "";
    const absSortRef = useRef(props.absSort ?? false);
    absSortRef.current = props.absSort ?? false;

    const refreshTotals = useCallback(async () => {
      const client = clientRef.current;
      const api = apiRef.current;
      if (!client || !api) return;
      const filterModelForCount = (api.getFilterModel() ?? {}) as Record<
        string,
        unknown
      >;
      // Always resolve the total filtered leaf-row count for the status bar.
      // Uses NO value columns, so it can't throw on calculated columns the way
      // the full aggregate query can — the count is what the status bar needs.
      try {
        const countRes = await client.getAggregates({
          dataset: DATASET,
          valueCols: [],
          filterModel: filterModelForCount,
          quickFilterText: quickFilterRef.current || undefined,
        });
        api.setGridOption("context", {
          ...(api.getGridOption("context") as object | undefined),
          filteredRowCount: countRes.rowCount,
        });
      } catch {
        /* ignore transient count failures */
      }
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
        // Grand-total pinned bottom row (filtered aggregates), if requested.
        if (props.grandTotalRow) {
          const totalRow: Record<string, unknown> = { __ssrmGrandTotal: true };
          for (const vc of valueCols) totalRow[vc.field] = result.aggregates[vc.field]?.[vc.aggFunc];
          api.setGridOption("pinnedBottomRowData", [totalRow]);
        }
      } catch {
        /* ignore transient totals failures */
      }
    }, [props]);

    const datasource = useMemo(
      () =>
        createPerspectiveDatasource(
          () => clientRef.current,
          () => DATASET,
          () => ({
            quickFilterText: quickFilterRef.current || undefined,
            treeData: treeData || undefined,
            absSort: absSortRef.current || undefined,
          }),
          (totals, filteredRowCount, aggregates) => {
            const api = apiRef.current;
            if (api) {
              api.setGridOption("context", {
                ...(api.getGridOption("context") as object | undefined),
                totals,
                aggregates,
                filteredRowCount,
              });
              // Grand-total pinned bottom row: use each measure's own aggFunc
              // value (aggregates), falling back to the sum in `totals`.
              if (props.grandTotalRow) {
                const row: Record<string, unknown> = { __ssrmGrandTotal: true };
                for (const c of columnDefs) {
                  const f = c.field;
                  if (!f || !c.aggFunc) continue;
                  const byFn = aggregates?.[f] as Record<string, unknown> | undefined;
                  row[f] = byFn?.[String(c.aggFunc)] ?? totals[f];
                }
                setGrandTotalData([row]);
              }
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

    // Quick filter / abs sort changes: server-side re-query (debounced purge).
    useEffect(() => {
      if (!gridReadyRef.current || !apiRef.current) return;
      const h = window.setTimeout(() => {
        if (apiRef.current) {
          refreshAllLoadedServerSideStores(apiRef.current, { purge: true });
          void refreshTotals();
        }
      }, 200);
      return () => window.clearTimeout(h);
    }, [props.quickFilterText, props.absSort, refreshTotals]);

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
        // Tree data row (from the tree shaper).
        if (treeData && data.__treeKey != null) {
          const route = [...(params.parentKeys ?? []), String(data.__treeKey)].join("|");
          return data.group ? `t:${route}` : `tl:${data.__treeKey}`;
        }
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
      [idField, treeData],
    );

    // ---- Master / detail ---------------------------------------------------
    const md = props.masterDetail;
    const isRowMaster = useCallback(
      (data: Record<string, unknown> | undefined) => {
        if (!md || !data || typeof data.childCount === "number" || data.group === true) return false;
        return md.isRowMaster ? md.isRowMaster(data) : true;
      },
      [md],
    );
    const detailCellRendererParams = useMemo(
      () =>
        md
          ? {
              detailGridOptions: {
                columnDefs: md.detailColumnDefs,
                defaultColDef: { flex: 1, minWidth: 90 },
              },
              getDetailRowData: (p: GetDetailRowDataParams<Record<string, unknown>>) => {
                void md
                  .getDetailRowData(p.data)
                  .then((rows) => p.successCallback(rows))
                  .catch(() => p.successCallback([]));
              },
            }
          : undefined,
      [md],
    );

    // ---- Tree data ---------------------------------------------------------
    const isServerSideGroup = useCallback(
      (d: Record<string, unknown>) => d.group === true,
      [],
    );
    const getServerSideGroupKey = useCallback(
      (d: Record<string, unknown>) => String(d.__treeKey ?? ""),
      [],
    );

    // ---- Export ALL filtered rows (not just loaded blocks) -----------------
    const handleExportAll = useCallback(
      async (format: "excel" | "csv") => {
        const client = clientRef.current;
        const api = apiRef.current;
        if (!client || !api) return;
        await exportAllViaAgGrid({
          liveApi: api,
          client,
          dataset: DATASET,
          format,
          fileName: `export-all.${format === "excel" ? "xlsx" : "csv"}`,
          limit: 100_000,
          quickFilterText: quickFilterRef.current,
          treeData,
          absSort: absSortRef.current,
        });
      },
      [treeData],
    );
    const getContextMenuItems = useCallback(
      (params: GetContextMenuItemsParams): (DefaultMenuItem | MenuItemDef)[] =>
        (params.defaultItems ?? []).flatMap((item): (DefaultMenuItem | MenuItemDef)[] => {
          if (item === "csvExport")
            return [{ name: "CSV export (all filtered rows)", action: () => void handleExportAll("csv") }];
          if (item === "excelExport")
            return [{ name: "Excel export (all filtered rows)", action: () => void handleExportAll("excel") }];
          if (item === "export")
            return [
              {
                name: "Export (all filtered rows)",
                subMenu: [
                  { name: "CSV", action: () => void handleExportAll("csv") },
                  { name: "Excel", action: () => void handleExportAll("excel") },
                ],
              },
            ];
          return [item];
        }),
      [handleExportAll],
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
        // Persistent filter row under the headers — the most discoverable place
        // for filters (the header funnel button only shows on hover in v36, and
        // the ⋮ column menu no longer contains the filter).
        floatingFilter: true,
        // Always show the header filter (funnel) button too, not just on hover.
        suppressHeaderFilterButton: false,
        enableValue: true,
        enableRowGroup: true,
        enablePivot: true,
        enableCellChangeFlash: true,
        ...props.defaultColDef,
      }),
      [props.defaultColDef],
    );

    // The auto group column needs real width or the group key clips to just the
    // "(count)". Consumers can override via defaultColDef-style width if needed.
    const autoGroupColumnDef = useMemo<ColDef>(
      () => ({ headerName: "Group", minWidth: 240, flex: 1, pinned: "left" }),
      [],
    );
    const sideBar = useMemo(() => ({ toolPanels: ["columns", "filters"] }), []);
    const statusBar = useMemo(
      () => ({
        // The built-in total/filtered row-count panels are client-side-row-model
        // only (they warn + render nothing under SSRM), so the leaf count comes
        // from a custom panel fed by the server-side count. Selected-count and
        // range aggregation are native and sit on the right.
        statusPanels: [
          { statusPanel: ServerRowCountStatusPanel, align: "left" as const },
          { statusPanel: "agSelectedRowCountComponent", align: "right" as const },
          { statusPanel: "agAggregationComponent", align: "right" as const },
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
          loadThemeGoogleFonts
          columnDefs={override.agGridColumnDefs}
          defaultColDef={defaultColDef}
          autoGroupColumnDef={autoGroupColumnDef}
          rowModelType="serverSide"
          serverSideDatasource={datasource}
          cacheBlockSize={100}
          animateRows
          cellFlashDuration={500}
          rowGroupPanelShow={treeData ? "never" : "always"}
          pivotPanelShow="always"
          sideBar={sideBar}
          statusBar={statusBar}
          rowSelection={rowSelection}
          cellSelection={cellSelection}
          undoRedoCellEditing
          pagination={props.pagination}
          paginationPageSize={props.paginationPageSize ?? 100}
          enableAdvancedFilter={props.advancedFilter}
          enableCharts={props.enableCharts}
          pinnedTopRowData={props.pinnedTopRowData}
          pinnedBottomRowData={props.grandTotalRow ? grandTotalData : props.pinnedBottomRowData}
          treeData={treeData}
          isServerSideGroup={treeData ? isServerSideGroup : undefined}
          getServerSideGroupKey={treeData ? getServerSideGroupKey : undefined}
          masterDetail={Boolean(md)}
          isRowMaster={md ? isRowMaster : undefined}
          detailCellRendererParams={detailCellRendererParams}
          getContextMenuItems={getContextMenuItems}
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
          onFirstDataRendered={() => void refreshTotals()}
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
