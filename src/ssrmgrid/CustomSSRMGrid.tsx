/**
 * CustomSSRMGrid — AG Grid SSRM over the main-thread RowMirror engine.
 * No Perspective worker. Use `<SSRMGrid>` for Perspective-backed scale.
 */
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
import {
  GRAND_TOTAL_ROW_ID,
  type CellValueChangedEvent,
  type ChartType,
  type ColDef,
  type DefaultMenuItem,
  type GetContextMenuItemsParams,
  type GetDetailRowDataParams,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type IServerSideGroupSelectionState,
  type IServerSideSelectionState,
  type MenuItemDef,
  type Theme,
} from "ag-grid-community";
import "../agGrid/modules";
import { theme as defaultTheme } from "../agGrid/theme";
import {
  applyWorkerDirtyToGrid,
  type DirtyMessage,
} from "../ssrm/applyWorkerDirtyToGrid";
import { chartAllViaAgGrid } from "../ssrm/chartAllViaAgGrid";
import { ConfiguredGate } from "../ssrm/configuredGate";
import { createCustomDatasource } from "../ssrm/createCustomDatasource";
import { createCustomEngine } from "../ssrm/engine/customEngine";
import { exportAllViaAgGrid } from "../ssrm/exportAllViaAgGrid";
import { fetchAllGroupLeafRows, toGroupLeafCols } from "../ssrm/getGroupLeafRows";
import {
  MirrorLoadingCellRenderer,
  setActiveRowMirror,
} from "../ssrm/mirrorLoadingCell";
import {
  patchGrandTotalFromMirror,
  patchLoadedGroupAggregatesFromMirror,
} from "../ssrm/patchLoadedGroupAggregates";
import { buildQueryAllRequestFromApi } from "../ssrm/readGridQueryState";
import { refreshAllLoadedServerSideStores } from "../ssrm/refreshAllLoadedStores";
import { SsrmBlockCache } from "../ssrm/ssrmBlockCache";
import type { FeedConfig, QueryAllRequest, QueryAllResult } from "../ssrm/types";
import { foldTrafficLight } from "../ssrm/trafficLightAgg";
import { buildColumnOverride, type SSRMColDef } from "./columnOverride";
import { QuickFilterHighlightCellRenderer } from "./QuickFilterHighlightCellRenderer";
import "./quickFilterHighlight.css";
import { SSRM_DEFAULT_STATUS_BAR } from "./ssrmStatusBarPanels";
import { parseQuickFilterTokens } from "../workers/ssrmFilters";
import type {
  GrandTotalRowMode,
  GroupTotalRowMode,
  SSRMTransaction,
} from "./SSRMGrid";

const DATASET = "main";

function trafficLightAggFunc(params: { values: unknown[] }): number | null {
  const nums = params.values
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n): n is number => Number.isFinite(n));
  if (nums.length === 0) return null;
  return foldTrafficLight(Math.min(...nums), Math.max(...nums));
}

function resolveGrandTotalRow(
  mode: GrandTotalRowMode | undefined,
): "top" | "bottom" | "pinnedTop" | "pinnedBottom" | undefined {
  if (mode === true) return "pinnedBottom";
  if (mode === false || mode == null) return undefined;
  return mode;
}

function usesNativeGrandTotal(mode: GrandTotalRowMode | undefined): boolean {
  const resolved = resolveGrandTotalRow(mode);
  return (
    resolved === "top" ||
    resolved === "bottom" ||
    resolved === "pinnedTop" ||
    resolved === "pinnedBottom"
  );
}

export interface CustomSSRMGridHandle {
  applyTransaction(tx: SSRMTransaction): void;
  applyTransactionAsync(tx: SSRMTransaction): void;
  getApi(): GridApi | null;
  getServerSideSelectionState():
    | IServerSideSelectionState
    | IServerSideGroupSelectionState
    | null;
  setServerSideSelectionState(
    state: IServerSideSelectionState | IServerSideGroupSelectionState,
  ): void;
  countMatching(filterModel: Record<string, unknown>): Promise<number>;
  getGroupLeafRows(opts: {
    groupKeys: string[];
    filterModel?: Record<string, unknown>;
    quickFilterText?: string;
  }): Promise<Record<string, unknown>[]>;
  queryAll(
    opts?: Partial<Omit<QueryAllRequest, "dataset">>,
  ): Promise<QueryAllResult>;
  forEachMatching(
    callback: (data: Record<string, unknown>, index: number) => void,
    opts?: Partial<Omit<QueryAllRequest, "dataset">>,
  ): Promise<{ rowCount: number }>;
  chartFilteredData(opts?: {
    categoryField?: string;
    chartType?: ChartType;
  }): Promise<{ rowCount: number; chartId?: string } | null>;
}

export interface CustomSSRMGridProps {
  columnDefs: SSRMColDef[];
  rowData?: Record<string, unknown>[];
  getRowId: string;
  refreshThrottleMs?: number;
  cacheBlockSize?: number;
  blockLoadDebounceMillis?: number;
  maxBlocksInCache?: number;
  rowBuffer?: number;
  suppressAnimationFrame?: boolean;
  enableCellChangeFlash?: boolean;
  defaultColDef?: ColDef;
  onTotals?: (summary: string) => void;
  onDirty?: (msg: DirtyMessage) => void;
  height?: string | number;
  theme?: Theme;
  loadThemeGoogleFonts?: boolean;
  rowHeight?: number;
  headerHeight?: number;
  sideBar?: unknown;
  statusBar?: unknown;
  components?: Record<string, unknown>;
  onGridReady?: (event: GridReadyEvent) => void;
  suppressNoRowsOverlay?: boolean;
  overlayNoRowsTemplate?: string;
  showLoadingOverlay?: boolean;
  quickFilterText?: string;
  quickFilterFields?: string[];
  highlightQuickFilter?: boolean;
  pagination?: boolean;
  paginationPageSize?: number;
  advancedFilter?: boolean;
  pinnedTopRowData?: Record<string, unknown>[];
  pinnedBottomRowData?: Record<string, unknown>[];
  grandTotalRow?: GrandTotalRowMode;
  groupTotalRow?: GroupTotalRowMode;
  calculatedColumns?: boolean;
  /** Absolute-value sort for numeric measures. */
  absSort?: boolean;
  /** Perspective-like keep predicate (main-thread eval). */
  rowKeepExpression?: string;
  /** Tree hierarchy fields (outer → inner). Enables AG Grid SSRM treeData. */
  treeFields?: string[];
  /** Integrated charts + full-set chart via context menu / handle. */
  enableCharts?: boolean;
  masterDetail?: {
    detailColumnDefs: ColDef[];
    getDetailRowData?: (
      masterRow: Record<string, unknown>,
    ) => Promise<Record<string, unknown>[]>;
    matchFields?: Record<string, string>;
    detailDataset?: string;
    detailLimit?: number;
    isRowMaster?: (row: Record<string, unknown>) => boolean;
  };
}

function formatTotals(totals: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(totals)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      parts.push(
        `${k}=${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
      );
    }
  }
  return parts.slice(0, 4).join(" · ");
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

export const CustomSSRMGrid = forwardRef<
  CustomSSRMGridHandle,
  CustomSSRMGridProps
>(function CustomSSRMGrid(props, ref) {
  const { columnDefs, rowData, getRowId: idField } = props;
  const apiRef = useRef<GridApi | null>(null);
  const engineRef = useRef(createCustomEngine());
  const configuredGateRef = useRef(new ConfiguredGate());
  const configuredRef = useRef(false);
  const blockCacheRef = useRef(new SsrmBlockCache());
  const asyncBufferRef = useRef<SSRMTransaction | null>(null);
  const groupAggPatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [, forceRerender] = useState(0);
  const grandTotalRowOpt = resolveGrandTotalRow(props.grandTotalRow);

  const mirror = engineRef.current.getMirror();
  setActiveRowMirror(mirror);

  const quickFilterRef = useRef(props.quickFilterText ?? "");
  quickFilterRef.current = props.quickFilterText ?? "";
  const quickFilterFieldsRef = useRef(props.quickFilterFields);
  quickFilterFieldsRef.current = props.quickFilterFields;
  const rowKeepExpressionRef = useRef(props.rowKeepExpression ?? "");
  rowKeepExpressionRef.current = props.rowKeepExpression ?? "";
  const absSortRef = useRef(props.absSort ?? false);
  absSortRef.current = props.absSort ?? false;
  const treeData = (props.treeFields?.length ?? 0) > 0;

  const sampleRowRef = useRef<Record<string, unknown> | undefined>(rowData?.[0]);
  const [sampleVersion, setSampleVersion] = useState(() =>
    rowData?.[0] ? 1 : 0,
  );
  if (rowData?.[0] && !sampleRowRef.current) {
    sampleRowRef.current = rowData[0];
  }
  if (sampleRowRef.current && sampleVersion === 0) {
    setSampleVersion(1);
  }
  const rowDataRef = useRef(rowData);
  rowDataRef.current = rowData;

  const getFilterValues = useCallback(async (field: string) => {
    const ok = await configuredGateRef.current.wait(10_000);
    if (!ok || !configuredRef.current) return [];
    return engineRef.current.getFilterValues(DATASET, field);
  }, []);

  const override = useMemo(
    () =>
      buildColumnOverride(columnDefs, {
        index: idField,
        sampleRow: sampleRowRef.current,
        getFilterValues,
      }),
    [columnDefs, idField, getFilterValues, sampleVersion],
  );
  const schemaRef = useRef(override.schema);
  schemaRef.current = override.schema;

  const feedConfig = useMemo((): FeedConfig => {
    return {
      dataset: DATASET,
      schema: override.schema,
      index: idField,
      calcExpressions: override.calcExpressions,
      refreshThrottleMs: props.refreshThrottleMs,
      treeFields: props.treeFields,
      treeDataMode: treeData,
      absSort: props.absSort,
    };
  }, [
    override,
    idField,
    props.refreshThrottleMs,
    props.treeFields,
    treeData,
    props.absSort,
  ]);
  const feedConfigRef = useRef(feedConfig);
  feedConfigRef.current = feedConfig;

  useEffect(() => {
    const engine = engineRef.current;
    engine.setDirtyHandler?.((msg) => {
      props.onDirty?.(msg);
      const api = apiRef.current;
      if (!api || !configuredRef.current) return;
      applyWorkerDirtyToGrid(msg, {
        applyLeafTransaction: (tx) => {
          const updates = tx.update ?? [];
          if (updates.length) {
            api.applyServerSideTransaction({ update: updates });
            blockCacheRef.current.patchRows(updates, idField);
            if (groupAggPatchTimerRef.current) {
              clearTimeout(groupAggPatchTimerRef.current);
            }
            groupAggPatchTimerRef.current = setTimeout(() => {
              groupAggPatchTimerRef.current = null;
              patchLoadedGroupAggregatesFromMirror(api, mirror);
              if (usesNativeGrandTotal(props.grandTotalRow)) {
                patchGrandTotalFromMirror(api, mirror);
              }
            }, 100);
          }
        },
        throttleRefresh: () => {
          refreshAllLoadedServerSideStores(api, { purge: false });
          blockCacheRef.current.clear();
          mirror.invalidateView();
        },
        purgeRefresh: () => {
          blockCacheRef.current.clear();
          mirror.invalidateView();
          refreshAllLoadedServerSideStores(api, { purge: true });
        },
      });
    });
    return () => {
      engine.setDirtyHandler?.(null);
      setActiveRowMirror(null);
      if (groupAggPatchTimerRef.current) {
        clearTimeout(groupAggPatchTimerRef.current);
      }
      engine.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, []);

  const configureAndLoad = useCallback(async () => {
    const engine = engineRef.current;
    const rows = rowDataRef.current ?? [];
    if (!sampleRowRef.current && rows.length === 0) return;
    configuredRef.current = false;
    configuredGateRef.current.reset();
    mirror.clear();
    blockCacheRef.current.clear();
    await Promise.resolve(engine.configure(feedConfigRef.current));
    await Promise.resolve(engine.setRowData(DATASET, rows));
    configuredRef.current = true;
    configuredGateRef.current.open();
    const api = apiRef.current;
    if (api) {
      refreshAllLoadedServerSideStores(api, { purge: true });
    }
    forceRerender((n) => n + 1);
  }, [mirror]);

  useEffect(() => {
    void configureAndLoad();
  }, [feedConfig, configureAndLoad]);

  useEffect(() => {
    if (!configuredRef.current) return;
    void Promise.resolve(
      engineRef.current.setRowData(DATASET, rowDataRef.current ?? []),
    ).then(() => {
      blockCacheRef.current.clear();
      mirror.invalidateView();
      const api = apiRef.current;
      if (api) refreshAllLoadedServerSideStores(api, { purge: true });
    });
    // Identity of rowData snapshot — host replaces book
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowData]);

  useEffect(() => {
    mirror.invalidateView();
    blockCacheRef.current.clear();
    const api = apiRef.current;
    if (api && configuredRef.current) {
      refreshAllLoadedServerSideStores(api, { purge: true });
    }
    api?.setGridOption("context", {
      ...(api.getGridOption("context") as object | undefined),
      quickFilterText: props.quickFilterText ?? "",
      quickFilterTokens: parseQuickFilterTokens(props.quickFilterText),
      highlightQuickFilter: props.highlightQuickFilter !== false,
    });
  }, [
    props.quickFilterText,
    props.quickFilterFields,
    props.highlightQuickFilter,
    props.rowKeepExpression,
    props.absSort,
    mirror,
  ]);

  const commit = useCallback(
    (tx: SSRMTransaction) => {
      const removeIds = (tx.remove ?? []).map((r) =>
        typeof r === "object" && r != null ? String(r[idField]) : r,
      );
      engineRef.current.applyTransaction({
        dataset: DATASET,
        add: tx.add,
        update: tx.update,
        remove: removeIds,
      });
    },
    [idField],
  );

  const datasource = useMemo(
    () =>
      createCustomDatasource(
        () => engineRef.current,
        () => DATASET,
        () => ({
          quickFilterText: quickFilterRef.current || undefined,
          quickFilterFields: quickFilterFieldsRef.current,
          includeGrandTotal: usesNativeGrandTotal(props.grandTotalRow),
          isConfigured: configuredRef.current,
          waitUntilConfigured: () => configuredGateRef.current.wait(10_000),
          rowMirror: mirror,
          treeData,
          absSort: absSortRef.current,
          rowKeepExpression: rowKeepExpressionRef.current || undefined,
        }),
        (totals, _filtered, aggregates) => {
          const api = apiRef.current;
          if (api) {
            api.setGridOption("context", {
              ...(api.getGridOption("context") as object | undefined),
              totals,
              aggregates,
            });
          }
          props.onTotals?.(formatTotals(totals));
        },
        blockCacheRef.current,
      ),
    [mirror, props.grandTotalRow, props.onTotals, treeData],
  );

  const countMatching = useCallback(
    async (filterModel: Record<string, unknown>) => {
      const result = await Promise.resolve(
        engineRef.current.getAggregates({
          dataset: DATASET,
          valueCols: [],
          filterModel,
        }),
      );
      return result.rowCount;
    },
    [],
  );

  const getGroupLeafRows = useCallback(
    async (opts: {
      groupKeys: string[];
      filterModel?: Record<string, unknown>;
      quickFilterText?: string;
    }) => {
      const api = apiRef.current;
      const rowGroupCols = toGroupLeafCols(
        (api?.getRowGroupColumns() ?? []).map((col) => {
          const def = col.getColDef();
          return {
            field: def.field ?? col.getColId(),
            id: col.getColId(),
            displayName: def.headerName,
          };
        }),
      );
      const filterModel =
        opts.filterModel ??
        (api ? ((api.getFilterModel() as Record<string, unknown>) ?? {}) : {});
        return fetchAllGroupLeafRows(
        (req) => Promise.resolve(engineRef.current.queryAll(req)),
        {
          dataset: DATASET,
          rowGroupCols,
          groupKeys: opts.groupKeys,
          filterModel,
          quickFilterText:
            opts.quickFilterText ?? (quickFilterRef.current || undefined),
          quickFilterFields: quickFilterFieldsRef.current,
          rowKeepExpression: rowKeepExpressionRef.current || undefined,
        },
      );
    },
    [],
  );

  const queryAll = useCallback(
    async (
      opts: Partial<Omit<QueryAllRequest, "dataset">> = {},
    ): Promise<QueryAllResult> => {
      const api = apiRef.current;
      if (!api) {
        return Promise.resolve(
          engineRef.current.queryAll({
            dataset: DATASET,
            filterModel: opts.filterModel ?? {},
            sortModel: opts.sortModel ?? [],
            limit: opts.limit ?? 50_000,
            quickFilterText:
              opts.quickFilterText ?? (quickFilterRef.current || undefined),
            quickFilterFields:
              opts.quickFilterFields ?? quickFilterFieldsRef.current,
            rowKeepExpression:
              opts.rowKeepExpression ??
              (rowKeepExpressionRef.current || undefined),
            includeStructure: opts.includeStructure ?? false,
            treeData: opts.treeData ?? treeData,
            absSort: opts.absSort ?? absSortRef.current,
            ...opts,
          }),
        );
      }
      return Promise.resolve(
        engineRef.current.queryAll(
          buildQueryAllRequestFromApi(
            api,
            {
              dataset: DATASET,
              quickFilterText: quickFilterRef.current || undefined,
              quickFilterFields: quickFilterFieldsRef.current,
              rowKeepExpression: rowKeepExpressionRef.current || undefined,
              treeData,
              absSort: absSortRef.current,
              limit: 50_000,
            },
            opts,
          ),
        ),
      );
    },
    [treeData],
  );

  const forEachMatching = useCallback(
    async (
      callback: (data: Record<string, unknown>, index: number) => void,
      opts?: Partial<Omit<QueryAllRequest, "dataset">>,
    ) => {
      const { rowData: rows, rowCount } = await queryAll({
        ...opts,
        includeStructure: opts?.includeStructure ?? false,
      });
      for (let i = 0; i < rows.length; i++) callback(rows[i]!, i);
      return { rowCount };
    },
    [queryAll],
  );

  const handleExportAll = useCallback(
    async (format: "excel" | "csv") => {
      const api = apiRef.current;
      if (!api) return;
      await exportAllViaAgGrid({
        liveApi: api,
        client: engineRef.current,
        dataset: DATASET,
        format,
        fileName: `export-all.${format === "excel" ? "xlsx" : "csv"}`,
        limit: 100_000,
        quickFilterText: quickFilterRef.current,
        quickFilterFields: quickFilterFieldsRef.current,
        rowKeepExpression: rowKeepExpressionRef.current || undefined,
        treeData,
        absSort: absSortRef.current,
      });
    },
    [treeData],
  );

  const handleChartAll = useCallback(
    async (opts?: { categoryField?: string; chartType?: ChartType }) => {
      const api = apiRef.current;
      if (!api || !props.enableCharts) return null;
      return chartAllViaAgGrid({
        liveApi: api,
        client: engineRef.current,
        dataset: DATASET,
        categoryField: opts?.categoryField,
        chartType: opts?.chartType,
        quickFilterText: quickFilterRef.current,
        quickFilterFields: quickFilterFieldsRef.current,
        rowKeepExpression: rowKeepExpressionRef.current || undefined,
      });
    },
    [props.enableCharts],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams): (DefaultMenuItem | MenuItemDef)[] => {
      const items = (params.defaultItems ?? []).flatMap(
        (item): (DefaultMenuItem | MenuItemDef)[] => {
          if (item === "csvExport")
            return [
              {
                name: "CSV export (all filtered rows)",
                action: () => void handleExportAll("csv"),
              },
            ];
          if (item === "excelExport")
            return [
              {
                name: "Excel export (all filtered rows)",
                action: () => void handleExportAll("excel"),
              },
            ];
          if (item === "export")
            return [
              {
                name: "Export (all filtered rows)",
                subMenu: [
                  { name: "CSV", action: () => void handleExportAll("csv") },
                  {
                    name: "Excel",
                    action: () => void handleExportAll("excel"),
                  },
                ],
              },
            ];
          return [item];
        },
      );
      if (props.enableCharts) {
        items.push({
          name: "Chart all filtered rows",
          action: () => void handleChartAll(),
        });
      }
      return items;
    },
    [handleExportAll, handleChartAll, props.enableCharts],
  );

  const md = props.masterDetail;
  const isRowMaster = useCallback(
    (data: Record<string, unknown> | undefined) => {
      if (!md || !data || typeof data.childCount === "number" || data.group === true) {
        return false;
      }
      return md.isRowMaster ? md.isRowMaster(data) : true;
    },
    [md],
  );
  const detailCellRendererParams = useMemo(() => {
    if (!md) return undefined;
    const fetchDetail = async (
      master: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => {
      if (md.getDetailRowData) return md.getDetailRowData(master);
      if (md.matchFields && Object.keys(md.matchFields).length > 0) {
        const match: Record<string, string | number | boolean | null> = {};
        for (const [detailField, masterField] of Object.entries(md.matchFields)) {
          const v = master[masterField];
          match[detailField] =
            v === undefined ? null : (v as string | number | boolean | null);
        }
        return Promise.resolve(
          engineRef.current.getDetailRows({
            dataset: md.detailDataset ?? DATASET,
            match,
            limit: md.detailLimit ?? 500,
          }),
        );
      }
      return [];
    };
    return {
      detailGridOptions: {
        columnDefs: md.detailColumnDefs,
        defaultColDef: { flex: 1, minWidth: 90 },
      },
      getDetailRowData: (p: GetDetailRowDataParams<Record<string, unknown>>) => {
        void fetchDetail(p.data)
          .then((rows) => p.successCallback(rows))
          .catch(() => p.successCallback([]));
      },
    };
  }, [md]);

  const isServerSideGroup = useCallback(
    (d: Record<string, unknown>) => d.group === true,
    [],
  );
  const getServerSideGroupKey = useCallback(
    (d: Record<string, unknown>) => String(d.__treeKey ?? ""),
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      applyTransaction: commit,
      applyTransactionAsync: (tx) => {
        const buf = asyncBufferRef.current ?? {
          add: [],
          update: [],
          remove: [],
        };
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
      getServerSideSelectionState: () =>
        apiRef.current?.getServerSideSelectionState() ?? null,
      setServerSideSelectionState: (state) => {
        apiRef.current?.setServerSideSelectionState(state);
      },
      countMatching,
      getGroupLeafRows,
      queryAll,
      forEachMatching,
      chartFilteredData: (opts) => handleChartAll(opts),
    }),
    [
      commit,
      countMatching,
      getGroupLeafRows,
      queryAll,
      forEachMatching,
      handleChartAll,
    ],
  );

  const getRowIdCb = useCallback(
    (params: GetRowIdParams) => {
      const data = params.data as Record<string, unknown> | undefined;
      if (!data) return crypto.randomUUID();
      if (data[idField] === GRAND_TOTAL_ROW_ID) return GRAND_TOTAL_ROW_ID;
      if (treeData && data.__treeKey != null) {
        const route = [...(params.parentKeys ?? []), String(data.__treeKey)].join(
          "|",
        );
        return data.group ? `t:${route}` : `tl:${data.__treeKey}`;
      }
      if (typeof data.childCount === "number") {
        const key =
          typeof data.__ssrmGroupKey === "string" ? data.__ssrmGroupKey : "";
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

  const onCellValueChanged = useCallback(
    (e: CellValueChangedEvent) => {
      const field = e.colDef.field;
      if (!field || !e.data) return;
      const id = e.data[idField];
      if (id == null) return;
      const patch = {
        [idField]: id,
        [field]: coerceEdited(schemaRef.current, field, e.newValue),
      };
      engineRef.current.updateRows(DATASET, [patch]);
    },
    [idField],
  );

  const onStructureChanged = useCallback(() => {
    blockCacheRef.current.clear();
    mirror.invalidateView();
  }, [mirror]);

  const defaultColDef = useMemo(
    () => ({
      flex: 1,
      minWidth: 100,
      filter: true,
      floatingFilter: true,
      suppressHeaderFilterButton: false,
      enableValue: true,
      enableRowGroup: true,
      enablePivot: false,
      enableCellChangeFlash: props.enableCellChangeFlash ?? false,
      ...((props.showLoadingOverlay ?? false)
        ? {}
        : { loadingCellRenderer: MirrorLoadingCellRenderer }),
      ...(props.highlightQuickFilter === false
        ? {}
        : { cellRenderer: QuickFilterHighlightCellRenderer }),
      ...(props.defaultColDef ?? {}),
    }),
    [
      props.defaultColDef,
      props.highlightQuickFilter,
      props.enableCellChangeFlash,
      props.showLoadingOverlay,
    ],
  );

  const autoGroupColumnDef = useMemo(
    () => ({
      minWidth: 200,
      cellRendererParams: { suppressCount: false },
    }),
    [],
  );

  const rowSelection = useMemo(
    () => ({
      mode: "multiRow" as const,
      checkboxes: true,
      headerCheckbox: true,
      enableClickSelection: true,
      selectAll: "all" as const,
      groupSelects: "descendants" as const,
    }),
    [],
  );

  const cellSelection = useMemo(
    () => ({ handle: { mode: "fill" as const } }),
    [],
  );

  const aggFuncs = useMemo(
    () => ({
      trafficLight: trafficLightAggFunc,
      rag: trafficLightAggFunc,
    }),
    [],
  );

  void forceRerender;

  const resolvedTheme = props.theme ?? defaultTheme;

  return (
    <div style={{ height: props.height ?? "100%", width: "100%" }}>
      <AgGridReact
        theme={resolvedTheme}
        loadThemeGoogleFonts={
          props.loadThemeGoogleFonts ?? props.theme == null
        }
        columnDefs={override.agGridColumnDefs}
        defaultColDef={defaultColDef}
        autoGroupColumnDef={autoGroupColumnDef}
        rowModelType="serverSide"
        serverSideDatasource={datasource}
        cacheBlockSize={props.cacheBlockSize ?? 50}
        {...(props.maxBlocksInCache != null
          ? { maxBlocksInCache: props.maxBlocksInCache }
          : {})}
        maxConcurrentDatasourceRequests={8}
        rowBuffer={props.rowBuffer ?? 20}
        blockLoadDebounceMillis={props.blockLoadDebounceMillis ?? 25}
        suppressAnimationFrame={props.suppressAnimationFrame ?? true}
        animateRows={false}
        suppressServerSideFullWidthLoadingRow={
          !(props.showLoadingOverlay ?? false)
        }
        rowHeight={props.rowHeight}
        headerHeight={props.headerHeight}
        {...(props.enableCellChangeFlash
          ? { cellFlashDuration: 500 }
          : { cellFlashDuration: 0 })}
        asyncTransactionWaitMillis={50}
        rowGroupPanelShow={treeData ? "never" : "always"}
        pivotPanelShow="never"
        sideBar={
          (props.sideBar ?? { toolPanels: ["columns", "filters"] }) as never
        }
        statusBar={(props.statusBar ?? SSRM_DEFAULT_STATUS_BAR) as never}
        components={
          {
            ...(props.components ?? {}),
            agLoadingCellRenderer: MirrorLoadingCellRenderer,
          } as never
        }
        suppressNoRowsOverlay={props.suppressNoRowsOverlay ?? true}
        overlayNoRowsTemplate={props.overlayNoRowsTemplate ?? " "}
        rowSelection={rowSelection}
        cellSelection={cellSelection}
        aggFuncs={aggFuncs}
        undoRedoCellEditing
        pagination={props.pagination}
        paginationPageSize={props.paginationPageSize ?? 100}
        enableAdvancedFilter={props.advancedFilter}
        enableCharts={props.enableCharts}
        calculatedColumns={props.calculatedColumns !== false}
        grandTotalRow={grandTotalRowOpt}
        groupTotalRow={props.groupTotalRow}
        pinnedTopRowData={props.pinnedTopRowData}
        pinnedBottomRowData={props.pinnedBottomRowData}
        treeData={treeData}
        isServerSideGroup={treeData ? isServerSideGroup : undefined}
        getServerSideGroupKey={treeData ? getServerSideGroupKey : undefined}
        masterDetail={Boolean(md)}
        isRowMaster={md ? isRowMaster : undefined}
        detailCellRendererParams={detailCellRendererParams}
        getContextMenuItems={getContextMenuItems}
        getRowId={getRowIdCb}
        getChildCount={(data) =>
          typeof data?.childCount === "number" ? data.childCount : undefined
        }
        onColumnRowGroupChanged={onStructureChanged}
        onFilterChanged={() => {
          mirror.invalidateView();
          blockCacheRef.current.clear();
        }}
        onCellValueChanged={onCellValueChanged}
        onGridReady={(e) => {
          apiRef.current = e.api;
          e.api.setGridOption("context", {
            ...(e.api.getGridOption("context") as object | undefined),
            rowMirror: mirror,
            ssrmCountMatching: countMatching,
            ssrmConfigured: configuredRef.current,
            quickFilterText: props.quickFilterText ?? "",
            quickFilterTokens: parseQuickFilterTokens(props.quickFilterText),
            highlightQuickFilter: props.highlightQuickFilter !== false,
          });
          if (!configuredRef.current) {
            void configureAndLoad();
          }
          props.onGridReady?.(e);
        }}
      />
    </div>
  );
});
