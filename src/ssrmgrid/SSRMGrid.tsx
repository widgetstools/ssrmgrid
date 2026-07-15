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
  createPerspectiveDatasource,
  throttle,
} from "../ssrm/createPerspectiveDatasource";
import { getActiveFilterModel } from "../ssrm/activeFilterModel";
import { chartAllViaAgGrid } from "../ssrm/chartAllViaAgGrid";
import { exportAllViaAgGrid } from "../ssrm/exportAllViaAgGrid";
import {
  applyWorkerDirtyToGrid,
  type DirtyMessage,
} from "../ssrm/applyWorkerDirtyToGrid";
import { refreshAllLoadedServerSideStores } from "../ssrm/refreshAllLoadedStores";
import { ConfiguredGate } from "../ssrm/configuredGate";
import { mergeLeafUpdateRows } from "../ssrm/mergeLeafUpdateRows";
import { RowMirror } from "../ssrm/rowMirror";
import {
  MirrorLoadingCellRenderer,
  setActiveRowMirror,
} from "../ssrm/mirrorLoadingCell";
import {
  patchGrandTotalFromMirror,
  patchLoadedGroupAggregatesFromMirror,
} from "../ssrm/patchLoadedGroupAggregates";
import { SsrmBlockCache } from "../ssrm/ssrmBlockCache";
import type { FeedConfig } from "../ssrm/types";
import { createWorkerClient } from "../ssrm/workerClient";
import {
  chunkRows,
  projectRowsForSchema,
  schemaKeysFromFeed,
} from "../ssrm/ingestRows";
import { fetchAllGroupLeafRows, toGroupLeafCols } from "../ssrm/getGroupLeafRows";
import { PIVOT_FIELD_SEPARATOR } from "../workers/ssrmQueryEngine";
import { foldTrafficLight } from "../ssrm/trafficLightAgg";
import { buildColumnOverride, type SSRMColDef } from "./columnOverride";
import { SSRM_DEFAULT_STATUS_BAR } from "./ssrmStatusBarPanels";

const DATASET = "main";

/** Client stub so AG Grid Values panel keeps `trafficLight` (SSRM computes server-side). */
function trafficLightAggFunc(params: { values: unknown[] }): number | null {
  const nums = params.values
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n): n is number => Number.isFinite(n));
  if (nums.length === 0) return null;
  return foldTrafficLight(Math.min(...nums), Math.max(...nums));
}

export type GrandTotalRowMode =
  | boolean
  | "top"
  | "bottom"
  | "pinnedTop"
  | "pinnedBottom";

export type GroupTotalRowMode = "top" | "bottom";

function resolveGrandTotalRow(
  mode: GrandTotalRowMode | undefined,
): "top" | "bottom" | "pinnedTop" | "pinnedBottom" | undefined {
  if (mode === true) return "pinnedBottom";
  if (mode === false || mode == null) return undefined;
  return mode;
}

/** Use AG Grid 36 native grandTotalData (not a React pinned-row workaround). */
function usesNativeGrandTotal(
  mode: GrandTotalRowMode | undefined,
): boolean {
  const resolved = resolveGrandTotalRow(mode);
  return (
    resolved === "top" ||
    resolved === "bottom" ||
    resolved === "pinnedTop" ||
    resolved === "pinnedBottom"
  );
}

/**
 * AG Grid's built-in total/filtered row-count panels are CSRM-only (they warn
 * and render nothing under SSRM). Default status bar uses SSRM stand-ins that
 * mirror the native `ag-status-name-value` markup — see ssrmStatusBarPanels.
 */

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
  /** AG Grid 36 SSRM selection state (select-all across unloaded rows). */
  getServerSideSelectionState():
    | IServerSideSelectionState
    | IServerSideGroupSelectionState
    | null;
  setServerSideSelectionState(
    state: IServerSideSelectionState | IServerSideGroupSelectionState,
  ): void;
  /**
   * Chart the full filtered set (Perspective getSeriesData), not just loaded
   * SSRM blocks. Requires `enableCharts`.
   */
  chartFilteredData(opts?: {
    categoryField?: string;
    chartType?: ChartType;
  }): Promise<{ rowCount: number; chartId?: string } | null>;
  /**
   * Count leaf rows matching an AG Grid filterModel (Perspective aggregates).
   * Used by quick-filter pill badges under SSRM (no forEachNode full book).
   */
  countMatching(filterModel: Record<string, unknown>): Promise<number>;
  /**
   * Fetch **all** leaf rows under a row-group path (Phase 4a).
   * No product row cap — Perspective returns the full matching set.
   */
  getGroupLeafRows(opts: {
    groupKeys: string[];
    filterModel?: Record<string, unknown>;
    quickFilterText?: string;
  }): Promise<Record<string, unknown>[]>;
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
  /**
   * SSRM rows per fetched block (default 100). Keep modest — large blocks make
   * AG Grid sync-materialize hundreds of row nodes after each thumb jump and
   * feel like a multi-second hang even when RowMirror getRows is instant.
   */
  cacheBlockSize?: number;
  /**
   * Debounce SSRM block loads while the thumb/wheel is moving (default 50ms).
   * Intermediate positions are skipped; stubs paint from RowMirror so the
   * viewport stays filled. Set `0` to load every block immediately.
   */
  blockLoadDebounceMillis?: number;
  /**
   * Max cached SSRM blocks. Default **unlimited** (omit) — data already lives
   * in the local Perspective worker; capping the grid cache forces re-fetch
   * and blank Loading rows when scrolling back (unlike CSRM).
   */
  maxBlocksInCache?: number;
  /**
   * Extra rows rendered above/below the viewport (default 20). Larger buffers
   * force more SSRM blocks to materialize after each thumb jump.
   */
  rowBuffer?: number;
  /**
   * When true (default), draw scroll rows synchronously. Required for SSRM
   * thumb jumps: with rAF deferral the viewport is empty until the next frame
   * and stub cells can sit blank. Set false only if you need softer wheel
   * animation and accept blank gaps on large thumb moves.
   */
  suppressAnimationFrame?: boolean;
  /**
   * Flash cells on value change. Default **false** — high-frequency ticks make
   * change-flash paint-heavy. Opt in for demos that need visual tick cues.
   */
  enableCellChangeFlash?: boolean;
  /** Passthrough default column def. */
  defaultColDef?: ColDef;
  /** Called with a short summary string of filtered totals after each refresh. */
  onTotals?: (summary: string) => void;
  /**
   * Fired when the Perspective worker reports data changed (`dirty`).
   * Grid refresh is handled internally; hosts may observe for analytics or
   * worker-originated feeds. Do not republish into RowChangeBus if the host
   * already published on `applyTransaction` (double alerts).
   */
  onDirty?: (msg: DirtyMessage) => void;
  /** Grid host height (default 100%). */
  height?: string | number;
  /**
   * AG Grid theme. When omitted, uses ssrmgrid's built-in dark Quartz theme
   * (standalone demo only). Host apps should pass their design-system theme.
   */
  theme?: Theme;
  /** Load Google Fonts referenced by the active theme (default: only for built-in theme). */
  loadThemeGoogleFonts?: boolean;
  /** Host presentation overrides (MarketsGrid / design-system chrome). */
  rowHeight?: number;
  headerHeight?: number;
  sideBar?: unknown;
  statusBar?: unknown;
  /** Extra AG Grid components map (e.g. stream-safe floating filters). */
  components?: Record<string, unknown>;
  /** Called after internal SSRM ready setup (configure may still be in flight). */
  onGridReady?: (event: GridReadyEvent) => void;
  suppressNoRowsOverlay?: boolean;
  overlayNoRowsTemplate?: string;
  /**
   * Show AG Grid SSRM loading rows/spinners while blocks fetch.
   * Default **false** — local Perspective is fast enough that the indicator
   * mostly flashes blank rows on scroll; cache hits already skip Loading.
   */
  showLoadingOverlay?: boolean;

  // ---- gap-closing options (all off/absent by default) -------------------
  /** Server-side quick filter (global search across text columns). */
  quickFilterText?: string;
  /**
   * Restrict quick filter to these string fields. Default: all non-PK string
   * columns from the schema.
   */
  quickFilterFields?: string[];
  /** Enable server-side pagination. */
  pagination?: boolean;
  paginationPageSize?: number;
  /** Use the Advanced Filter builder instead of column/set filters (exclusive). */
  advancedFilter?: boolean;
  /** Absolute-value sort for numeric measures. */
  absSort?: boolean;
  /**
   * Perspective boolean keep expression (AND with filters). Used by MarketsGrid
   * row-exclusion under SSRM (`not(excludePredicate)`).
   */
  rowKeepExpression?: string;
  /** Pinned rows (passthrough — client-set, independent of the row model). */
  pinnedTopRowData?: Record<string, unknown>[];
  pinnedBottomRowData?: Record<string, unknown>[];
  /** Integrated Charts on the selected range (+ full-set chart via context menu). */
  enableCharts?: boolean;
  /**
   * AG Grid 36 grand total row. `true` ≡ `'pinnedBottom'`. Uses native
   * `grandTotalData` from the SSRM datasource (not a manual pinned row).
   */
  grandTotalRow?: GrandTotalRowMode;
  /**
   * AG Grid 36 group footer rows (`'top' | 'bottom'`). Aggregates already come
   * from Perspective on group rows.
   */
  groupTotalRow?: GroupTotalRowMode;
  /**
   * Master/detail: expandable detail grid per master row.
   * Provide either `getDetailRowData` (consumer fetch) or `matchFields`
   * (Perspective worker equality filter on `detailDataset`, default main).
   */
  masterDetail?: {
    detailColumnDefs: ColDef[];
    getDetailRowData?: (
      masterRow: Record<string, unknown>,
    ) => Promise<Record<string, unknown>[]>;
    /**
     * Worker-backed join: detail-field → master-field. Example:
     * `{ book: "book", trader: "trader" }`.
     */
    matchFields?: Record<string, string>;
    /** Dataset for worker detail fetch (default: main). */
    detailDataset?: string;
    detailLimit?: number;
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
    if (import.meta.env.DEV && (!idField || idField.trim() === "")) {
      console.error(
        "[SSRMGrid] getRowId is required for SSRM transactions and live updates",
      );
    }
    const apiRef = useRef<GridApi | null>(null);
    const clientRef = useRef<ReturnType<typeof createWorkerClient> | null>(null);
    const throttleRef = useRef<(() => void) | null>(null);
    /** While true, tick-driven throttled refresh is suppressed (typing / post-filter). */
    const typingQuietRef = useRef(false);
    /** Epoch ms — suppress tick refresh until after a filter purge settles. */
    const tickQuietUntilRef = useRef(0);
    /** Throttle group-header agg patches under high-frequency ticks. */
    const groupAggPatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    /** Bumped on every purge refresh; datasource drops older-generation blocks. */
    const refreshGenerationRef = useRef(0);
    /**
     * Main-thread SSRM block cache — sync `params.success` on hit.
     * Cleared on purge / soft-refresh fallback; leaf updates patchRows.
     */
    const blockCacheRef = useRef(new SsrmBlockCache());
    /**
     * Full leaf book on the main thread — flat/leaf getRows succeed sync
     * (Perspective-viewer-like scroll; no blank placeholder rows on fling).
     */
    const rowMirrorRef = useRef(new RowMirror());
    // Keep loaders pointed at the live book even if grid context is overwritten.
    setActiveRowMirror(rowMirrorRef.current);
    /** Resolves getRows / filter-value waits without busy-polling. */
    const configuredGateRef = useRef(new ConfiguredGate());
    const gridReadyRef = useRef(false);
    const configuredRef = useRef(false);
    /** True while chunked snapshot ingest is in flight — suppress dirty purges. */
    const ingestingRef = useRef(false);
    /** True while configureAndLoad is running — prevents onGridReady re-entry. */
    const configureInFlightRef = useRef(false);
    const asyncBufferRef = useRef<SSRMTransaction | null>(null);
    const [, forceRerender] = useState(0);
    const grandTotalRowOpt = resolveGrandTotalRow(props.grandTotalRow);

    // Distinct values for set filters -> Perspective, server-side.
    // Wait until configure+snapshot finish so we never hand AG Grid an empty
    // list that would wipe selected set-filter values from quick-filter pills.
    const getFilterValues = useCallback(
      async (field: string): Promise<(string | null)[]> => {
        const ok = await configuredGateRef.current.wait(10_000);
        const client = clientRef.current;
        if (!ok || !client || !configuredRef.current) return [];
        return client.getFilterValues(DATASET, field);
      },
      [],
    );

    // Sample for type inference — capture ONCE. Depending on live
    // `rowData[0]` identity reconfigures on every calc-materialize pass
    // (new row objects) and cancels in-flight setRowData → permanent ERR.
    // Warm CSRM→SSRM switches already have rowData: seed version=1 so we
    // don't setState→re-render→second configureAndLoad on mount.
    const sampleRowRef = useRef<Record<string, unknown> | undefined>(
      rowData?.[0],
    );
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

    // columnDefs -> Perspective schema/calc + the ag-grid defs.
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
    const rowKeepExpressionRef = useRef(props.rowKeepExpression ?? "");
    rowKeepExpressionRef.current = props.rowKeepExpression ?? "";
    const quickFilterFieldsRef = useRef(props.quickFilterFields);
    quickFilterFieldsRef.current = props.quickFilterFields;
    const absSortRef = useRef(props.absSort ?? false);
    absSortRef.current = props.absSort ?? false;
    // Cached unfiltered total — only changes when the dataset changes (add/
    // remove), never on filter, so filter changes reuse it instead of re-querying.
    const totalRowCountRef = useRef<number | null>(null);
    const onTotalsPropRef = useRef(props.onTotals);
    onTotalsPropRef.current = props.onTotals;
    const grandTotalRowRef = useRef(props.grandTotalRow);
    grandTotalRowRef.current = props.grandTotalRow;

    const refreshTotals = useCallback(
      async (opts?: { refetchTotal?: boolean }) => {
        const client = clientRef.current;
        const api = apiRef.current;
        if (!client || !api) return;
        const filterModel = getActiveFilterModel(api);
        const quickFilter = quickFilterRef.current || undefined;
        const quickFilterFields = quickFilterFieldsRef.current;
        const rowKeep = rowKeepExpressionRef.current || undefined;
        const isFiltered =
          Object.keys(filterModel).length > 0 ||
          Boolean(quickFilter) ||
          Boolean(rowKeep);
        // Resolve row counts for the status bar via Perspective. Uses NO value
        // columns, so it can't throw on calculated columns the way the full
        // aggregate query can. The total is cached (see totalRowCountRef); only
        // the filtered count is re-queried on filter changes.
        try {
          if (opts?.refetchTotal !== false || totalRowCountRef.current == null) {
            const totalRes = await client.getAggregates({
              dataset: DATASET,
              valueCols: [],
              filterModel: {},
            });
            totalRowCountRef.current = totalRes.rowCount;
          }
          const total = totalRowCountRef.current ?? 0;
          const filtered = isFiltered
            ? (
                await client.getAggregates({
                  dataset: DATASET,
                  valueCols: [],
                  filterModel,
                  quickFilterText: quickFilter,
                  quickFilterFields,
                  rowKeepExpression: rowKeep,
                })
              ).rowCount
            : total;
          api.setGridOption("context", {
            ...(api.getGridOption("context") as object | undefined),
            rowMirror: rowMirrorRef.current,
            totalRowCount: total,
            filteredRowCount: filtered,
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
          const result = await client.getAggregates({
            dataset: DATASET,
            valueCols,
            filterModel,
            quickFilterText: quickFilter,
            quickFilterFields,
            rowKeepExpression: rowKeep,
          });
          api.setGridOption("context", {
            ...(api.getGridOption("context") as object | undefined),
            rowMirror: rowMirrorRef.current,
            totals: result.totals,
            aggregates: result.aggregates,
            filteredRowCount: result.rowCount,
          });
          onTotalsPropRef.current?.(
            `Σ ${result.rowCount.toLocaleString()} rows · ${formatTotals(result.totals)}`,
          );
          // Native AG Grid 36 grandTotalRow is fed via datasource grandTotalData;
          // refreshTotals only updates context / onTotals.
        } catch {
          /* ignore transient totals failures */
        }
      },
      [],
    );

    const purgeRefreshStores = useCallback(
      (opts?: {
        refetchTotal?: boolean;
        quietTicksMs?: number;
        bumpGeneration?: boolean;
      }) => {
        const api = apiRef.current;
        if (!api) return;
        blockCacheRef.current.clear();
        if (opts?.bumpGeneration !== false) {
          refreshGenerationRef.current += 1;
        }
        refreshAllLoadedServerSideStores(api, { purge: true });
        void refreshTotals(opts);
        if (opts?.quietTicksMs != null && opts.quietTicksMs > 0) {
          tickQuietUntilRef.current = Date.now() + opts.quietTicksMs;
        }
      },
      [refreshTotals],
    );

    const purgeRefreshStoresRef = useRef(purgeRefreshStores);
    purgeRefreshStoresRef.current = purgeRefreshStores;

    const onDirtyRef = useRef(props.onDirty);
    onDirtyRef.current = props.onDirty;
    const refreshTotalsRef = useRef(refreshTotals);
    refreshTotalsRef.current = refreshTotals;

    const datasource = useMemo(
      () =>
        createPerspectiveDatasource(
          () => clientRef.current,
          () => DATASET,
          () => ({
            quickFilterText: quickFilterRef.current || undefined,
            quickFilterFields: quickFilterFieldsRef.current,
            treeData: treeData || undefined,
            absSort: absSortRef.current || undefined,
            rowKeepExpression: rowKeepExpressionRef.current || undefined,
            refreshGeneration: refreshGenerationRef.current,
            includeGrandTotal: usesNativeGrandTotal(grandTotalRowRef.current),
            isConfigured: configuredRef.current,
            waitUntilConfigured: () => configuredGateRef.current.wait(10_000),
            rowMirror: rowMirrorRef.current,
          }),
          (totals, filteredRowCount, aggregates) => {
            const api = apiRef.current;
            if (api) {
              const prev = (api.getGridOption("context") as
                | Record<string, unknown>
                | undefined) ?? {};
              api.setGridOption("context", {
                ...prev,
                rowMirror: rowMirrorRef.current,
                totals,
                aggregates,
                filteredRowCount,
                // Keep cached unfiltered total when getRows only reports filtered.
                totalRowCount:
                  totalRowCountRef.current ??
                  (typeof prev.totalRowCount === "number"
                    ? prev.totalRowCount
                    : filteredRowCount),
              });
            }
            onTotalsPropRef.current?.(
              `Σ ${filteredRowCount.toLocaleString()} rows · ${formatTotals(totals)}`,
            );
          },
          blockCacheRef.current,
        ),
      [treeData],
    );

    // Boot the worker client once.
    useEffect(() => {
      const client = createWorkerClient();
      clientRef.current = client;

      const scheduleLiveAggPatch = (api: GridApi) => {
        const grouped = (api.getRowGroupColumns?.() ?? []).length > 0;
        const nativeGrand = usesNativeGrandTotal(grandTotalRowRef.current);
        if (!grouped && !nativeGrand) return;
        if (groupAggPatchTimerRef.current != null) return;
        const run = () => {
          groupAggPatchTimerRef.current = null;
          const quietLeft = tickQuietUntilRef.current - Date.now();
          if (quietLeft > 0) {
            groupAggPatchTimerRef.current = window.setTimeout(run, quietLeft);
            return;
          }
          const extras = {
            quickFilterText: quickFilterRef.current || undefined,
            quickFilterFields: quickFilterFieldsRef.current,
            absSort: absSortRef.current || undefined,
            rowKeepExpression: rowKeepExpressionRef.current || undefined,
            idField,
          };
          // Native grandTotalRow is sticky after first getRows — patch via
          // GRAND_TOTAL_ROW_ID transaction so ticks move the footer.
          if (usesNativeGrandTotal(grandTotalRowRef.current)) {
            patchGrandTotalFromMirror(api, rowMirrorRef.current, extras);
          }
          if ((api.getRowGroupColumns?.() ?? []).length > 0) {
            patchLoadedGroupAggregatesFromMirror(
              api,
              rowMirrorRef.current,
              extras,
            );
          }
        };
        groupAggPatchTimerRef.current = window.setTimeout(run, 100);
      };

      client.setDirtyHandler((msg) => {
        onDirtyRef.current?.(msg);
        // configureAndLoad owns the first refresh after setRowData; applying a
        // dirty purge mid-configure bumps refreshGeneration and abandons the
        // in-flight getRows → permanent Loading overlay.
        // Chunked ingest also emits dirty per updateRows batch — ignore those.
        if (!configuredRef.current || ingestingRef.current) return;
        const api = apiRef.current;
        if (!api) return;
        // Pivot cells are worker aggregates (not leaf row ids). Surgical txs
        // were a non-pivot optimization; in pivot mode fall back to the old
        // Perspective soft-refresh path so pivoted values keep ticking.
        const pivotMode = Boolean(api.isPivotMode?.());
        const mode = applyWorkerDirtyToGrid(msg, {
          applyLeafTransaction: pivotMode
            ? undefined
            : (leaf) => {
                // In-place SSRM patch — avoids soft-refreshing every loaded block
                // on each tick. AG Grid batches via asyncTransactionWaitMillis.
                // SSRM `update` replaces row.data — merge partial patches first or
                // Book/Trader/etc. blank out (ticks only send changed fields).
                if (leaf.update?.length) {
                  // Always keep mirror + block cache current (stub paint / sync getRows).
                  const fromMirror = rowMirrorRef.current.patchById(leaf.update);
                  blockCacheRef.current.patchRows(idField, leaf.update);
                  // While the user is scrolling, skip AG Grid txs — they fight the
                  // scroll pipeline and blank cells mid-drag. Still schedule a
                  // group-agg flush for after the quiet window.
                  scheduleLiveAggPatch(api);
                  if (Date.now() < tickQuietUntilRef.current) return;
                  const update = mergeLeafUpdateRows(
                    idField,
                    leaf.update,
                    (id) =>
                      rowMirrorRef.current.findById(id) ??
                      blockCacheRef.current.findRow(idField, id) ??
                      (api.getRowNode(id)?.data as
                        | Record<string, unknown>
                        | undefined),
                  );
                  api.applyServerSideTransactionAsync({
                    update: update.length ? update : fromMirror,
                    ...(leaf.add?.length ? { add: leaf.add } : {}),
                  });
                } else if (leaf.add?.length) {
                  rowMirrorRef.current.patchById(leaf.add);
                  blockCacheRef.current.clear();
                  scheduleLiveAggPatch(api);
                  if (Date.now() < tickQuietUntilRef.current) return;
                  api.applyServerSideTransactionAsync({ add: leaf.add });
                }
              },
          throttleRefresh: () => {
            // Keep mirror in sync even when we soft-refresh (pivot / no surgical).
            const tx = msg.transaction;
            if (tx?.update?.length) {
              rowMirrorRef.current.patchById(tx.update);
              blockCacheRef.current.patchRows(idField, tx.update);
            }
            if (tx?.add?.length) {
              rowMirrorRef.current.patchById(tx.add);
              blockCacheRef.current.clear();
            }
            throttleRef.current?.();
          },
          purgeRefresh: () =>
            purgeRefreshStoresRef.current({ bumpGeneration: false }),
        });
        // Purge path already refreshes totals inside purgeRefreshStores.
        // Surgical / soft-refresh ticks: refresh totals only when not scrolling
        // (worker is serial — totals queries steal bandwidth from block loads).
        if (mode === "surgical") {
          if (Date.now() >= tickQuietUntilRef.current) {
            void refreshTotalsRef.current();
          }
        }
      });

      return () => {
        if (groupAggPatchTimerRef.current != null) {
          window.clearTimeout(groupAggPatchTimerRef.current);
          groupAggPatchTimerRef.current = null;
        }
        client.dispose();
        clientRef.current = null;
        configuredRef.current = false;
        configuredGateRef.current.reset();
        rowMirrorRef.current.clear();
        setActiveRowMirror(null);
      };
    }, [idField]);

    // (Re)build the throttled refresh when the throttle changes.
    useEffect(() => {
      throttleRef.current = throttle(() => {
        if (typingQuietRef.current) return;
        if (Date.now() < tickQuietUntilRef.current) return;
        if (apiRef.current) {
          // Soft refresh re-queries; clear so we don't sync-serve pre-tick rows.
          blockCacheRef.current.clear();
          refreshAllLoadedServerSideStores(apiRef.current, { purge: false });
        }
      }, props.refreshThrottleMs ?? 150);
    }, [props.refreshThrottleMs]);

    const countMatching = useCallback(
      async (filterModel: Record<string, unknown>): Promise<number> => {
        const client = clientRef.current;
        if (!client || !configuredRef.current) return 0;
        const result = await client.getAggregates({
          dataset: DATASET,
          valueCols: [],
          filterModel,
        });
        return result.rowCount;
      },
      [],
    );

    const getGroupLeafRows = useCallback(
      async (opts: {
        groupKeys: string[];
        filterModel?: Record<string, unknown>;
        quickFilterText?: string;
      }): Promise<Record<string, unknown>[]> => {
        const client = clientRef.current;
        const api = apiRef.current;
        if (!client || !configuredRef.current) return [];
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
        const quickFilterText =
          opts.quickFilterText ?? (quickFilterRef.current || undefined);
        return fetchAllGroupLeafRows((req) => client.queryAll(req), {
          dataset: DATASET,
          rowGroupCols,
          groupKeys: opts.groupKeys,
          filterModel,
          quickFilterText,
          quickFilterFields: quickFilterFieldsRef.current,
          rowKeepExpression: rowKeepExpressionRef.current || undefined,
        });
      },
      [],
    );

    // Configure the dataset (schema/index) + load the initial snapshot.
    // Generation token drops superseded runs when sampleRow arrives mid-flight
    // (cold mount often starts with rowData=[] then jumps to the full book).
    const configureGenRef = useRef(0);
    const configureAndLoad = useCallback(async () => {
      const client = clientRef.current;
      if (!client) return;
      // Wait for a schema sample — configuring from an empty book then
      // reconfiguring when data arrives races the worker and surfaces as ERR.
      if (!sampleRowRef.current && !(rowDataRef.current?.length)) {
        return;
      }
        const gen = ++configureGenRef.current;
      configuredRef.current = false;
      configuredGateRef.current.reset();
      rowMirrorRef.current.clear();
      configureInFlightRef.current = true;
      try {
        await client.configure(feedConfigRef.current);
        if (gen !== configureGenRef.current) return;

        const rows = rowDataRef.current;
        if (rows && rows.length > 0) {
          const keys = schemaKeysFromFeed(
            feedConfigRef.current.schema,
            feedConfigRef.current.index,
          );
          const projected = projectRowsForSchema(rows, keys);
          const chunks = chunkRows(projected);
          ingestingRef.current = true;
          try {
            // Chunked postMessage keeps the main thread responsive; one grid
            // purge at the end avoids the CSRM→SSRM "loads twice" flash.
            await client.setRowData(DATASET, chunks[0] ?? []);
            if (gen !== configureGenRef.current) return;

            for (let i = 1; i < chunks.length; i++) {
              if (gen !== configureGenRef.current) return;
              await client.updateRows(DATASET, chunks[i]!);
            }
          } finally {
            if (gen === configureGenRef.current) ingestingRef.current = false;
          }
          // Sync leaf mirror for fling scroll (full projected book).
          rowMirrorRef.current.replaceAll(projected, idField);
        } else {
          rowMirrorRef.current.clear();
        }

        if (gen !== configureGenRef.current) return;
        configuredRef.current = true;
        configuredGateRef.current.markReady();
        if (apiRef.current) {
          const api = apiRef.current;
          const prev =
            (api.getGridOption("context") as Record<string, unknown> | undefined) ??
            {};
          api.setGridOption("context", {
            ...prev,
            rowMirror: rowMirrorRef.current,
            ssrmConfigured: true,
            ssrmCountMatching: countMatching,
          });
        }

        if (gridReadyRef.current && apiRef.current) {
          purgeRefreshStores({ bumpGeneration: false });
          const api = apiRef.current;
          // Defer set-filter value refresh so it does not contend with first getRows.
          window.setTimeout(() => {
            if (gen !== configureGenRef.current || !apiRef.current) return;
            for (const col of api.getColumns() ?? []) {
              const handler = api.getColumnFilterHandler?.(col.getColId()) as
                | { refreshFilterValues?: () => void }
                | undefined;
              handler?.refreshFilterValues?.();
            }
            api.dispatchEvent({ type: "ssrmConfigured" } as never);
          }, 0);
        }
      } catch (err) {
        if (gen !== configureGenRef.current) return;
        ingestingRef.current = false;
        // Leave configuredRef false so a later rowData/sample retry can run.
        console.error("[SSRMGrid] configureAndLoad failed", err);
      } finally {
        if (gen === configureGenRef.current) configureInFlightRef.current = false;
      }
    }, [purgeRefreshStores, countMatching, idField]);

    // Re-configure when the schema/config changes (including first sample).
    useEffect(() => {
      if (clientRef.current) void configureAndLoad();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [feedConfig]);

    // Quick filter / abs sort / row-keep changes: server-side re-query (debounced).
    const appliedQuickFilterRef = useRef(props.quickFilterText ?? "");
    const appliedAbsSortRef = useRef(props.absSort ?? false);
    const appliedRowKeepRef = useRef(props.rowKeepExpression ?? "");
    useEffect(() => {
      if (!gridReadyRef.current || !apiRef.current) return;
      const quick = props.quickFilterText ?? "";
      const abs = props.absSort ?? false;
      const keep = props.rowKeepExpression ?? "";
      if (
        quick === appliedQuickFilterRef.current &&
        abs === appliedAbsSortRef.current &&
        keep === appliedRowKeepRef.current
      ) {
        return;
      }
      typingQuietRef.current = true;
      const h = window.setTimeout(() => {
        appliedQuickFilterRef.current = quick;
        appliedAbsSortRef.current = abs;
        appliedRowKeepRef.current = keep;
        rowMirrorRef.current.invalidateView();
        purgeRefreshStoresRef.current({
          refetchTotal: false,
          quietTicksMs: 400,
        });
        typingQuietRef.current = false;
      }, 200);
      return () => {
        window.clearTimeout(h);
      };
    }, [props.quickFilterText, props.absSort, props.rowKeepExpression]);

    // Push rowData snapshots into the worker after configure.
    // Do not skip the first emission — configureAndLoad often races ahead
    // of async hub snapshot assembly (empty → full), and the first effect
    // pass would otherwise drop the real book.
    useEffect(() => {
      const client = clientRef.current;
      if (!client || !configuredRef.current || ingestingRef.current) return;
      const rows = rowData ?? [];
      const keys = schemaKeysFromFeed(
        feedConfigRef.current.schema,
        feedConfigRef.current.index,
      );
      const projected = projectRowsForSchema(rows, keys);
      // Keep main-thread mirror aligned with host snapshots.
      rowMirrorRef.current.replaceAll(projected, idField);
      // Worker emits `dirty` → purge refresh; no local .then refresh.
      void client.setRowData(DATASET, projected);
    }, [rowData, idField]);

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
        // Keep sync leaf mirror aligned before/with worker mutate.
        if (tx.update?.length) rowMirrorRef.current.patchById(tx.update);
        if (tx.add?.length) rowMirrorRef.current.patchById(tx.add);
        const removed = removeIds(tx.remove);
        if (removed.length) rowMirrorRef.current.removeByIds(removed);
        // UI refresh + totals come from the worker `dirty` event after mutate.
        void client.applyTransaction({
          dataset: DATASET,
          add: tx.add,
          update: tx.update,
          remove: removed,
        });
      },
      [removeIds],
    );

    const handleChartAll = useCallback(
      async (opts?: { categoryField?: string; chartType?: ChartType }) => {
        const client = clientRef.current;
        const api = apiRef.current;
        if (!client || !api || !props.enableCharts) return null;
        return chartAllViaAgGrid({
          liveApi: api,
          client,
          dataset: DATASET,
          categoryField: opts?.categoryField,
          chartType: opts?.chartType,
          quickFilterText: quickFilterRef.current || undefined,
          quickFilterFields: quickFilterFieldsRef.current,
          rowKeepExpression: rowKeepExpressionRef.current || undefined,
        });
      },
      [props.enableCharts],
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
        getServerSideSelectionState: () =>
          apiRef.current?.getServerSideSelectionState() ?? null,
        setServerSideSelectionState: (state) => {
          apiRef.current?.setServerSideSelectionState(state);
        },
        chartFilteredData: (opts) => handleChartAll(opts),
        countMatching,
        getGroupLeafRows,
      }),
      [commit, handleChartAll, countMatching, getGroupLeafRows],
    );

    const getRowIdCb = useCallback(
      (params: GetRowIdParams) => {
        const data = params.data as Record<string, unknown> | undefined;
        if (!data) return crypto.randomUUID();
        // Native grand total footer updates via applyServerSideTransaction.
        if (data[idField] === GRAND_TOTAL_ROW_ID) {
          return GRAND_TOTAL_ROW_ID;
        }
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
        if (md.getDetailRowData) {
          return md.getDetailRowData(master);
        }
        if (md.matchFields && Object.keys(md.matchFields).length > 0) {
          const match: Record<string, string | number | boolean | null> = {};
          for (const [detailField, masterField] of Object.entries(md.matchFields)) {
            const v = master[masterField];
            match[detailField] =
              v === undefined
                ? null
                : (v as string | number | boolean | null);
          }
          const client = clientRef.current;
          if (!client) return [];
          return client.getDetailRows({
            dataset: md.detailDataset ?? DATASET,
            match,
            limit: md.detailLimit ?? 500,
          });
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
          quickFilterFields: quickFilterFieldsRef.current,
          rowKeepExpression: rowKeepExpressionRef.current || undefined,
          treeData,
          absSort: absSortRef.current,
        });
      },
      [treeData],
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
        void clientRef.current
          ?.updateRows(DATASET, [patch])
          .then(() => {
            if (apiRef.current) {
              refreshAllLoadedServerSideStores(apiRef.current, { purge: false });
              void refreshTotals({ refetchTotal: false });
            }
          })
          .catch(() => {
            event.node.setDataValue(field, event.oldValue);
          });
      },
      [idField, refreshTotals],
    );

    const onStructureChanged = useCallback(() => {
      // AG Grid SSRM already tears down stores and re-issues getRows when the
      // row-group / pivot panels change. purgeRefreshStores() here double-loads
      // (Loading overlay + refreshGeneration abort) and is what makes "add a
      // group field" feel stuck. Only drop caches so the next getRows is fresh.
      blockCacheRef.current.clear();
      rowMirrorRef.current.invalidateView();
      tickQuietUntilRef.current = Date.now() + 300;
    }, []);

    const hostRef = useRef<HTMLDivElement | null>(null);

    // Soft-refresh from live ticks fights the scroll pipeline — quiet it while
    // the user is flinging (wheel / trackpad / thumb). Also pauses AG Grid
    // leaf txs (mirror still patches) so cells don't blank mid-drag.
    const onBodyScroll = useCallback(() => {
      tickQuietUntilRef.current = Date.now() + 800;
    }, []);

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
        // Default off — high-frequency ticks make flash paint-heavy (AG SSRM).
        enableCellChangeFlash: props.enableCellChangeFlash ?? false,
        // Empty loading cells when full-width loading row is suppressed.
        // Prefer mirror-backed stubs: AG Grid SSRM always defers getRows via
        // setTimeout, so sync success alone still paints one blank frame.
        ...((props.showLoadingOverlay ?? false)
          ? {}
          : { loadingCellRenderer: MirrorLoadingCellRenderer }),
        ...props.defaultColDef,
      }),
      [props.defaultColDef, props.enableCellChangeFlash, props.showLoadingOverlay],
    );

    // The auto group column needs real width or the group key clips to just the
    // "(count)". Consumers can override via defaultColDef-style width if needed.
    const autoGroupColumnDef = useMemo<ColDef>(
      () => ({ headerName: "Group", minWidth: 240, flex: 1, pinned: "left" }),
      [],
    );
    const sideBar = useMemo(
      () => props.sideBar ?? { toolPanels: ["columns", "filters"] },
      [props.sideBar],
    );
    const statusBar = useMemo(() => {
      if (props.statusBar !== undefined) return props.statusBar;
      return SSRM_DEFAULT_STATUS_BAR;
    }, [props.statusBar]);
    const rowSelection = useMemo(
      () => ({
        mode: "multiRow" as const,
        checkboxes: true,
        headerCheckbox: true,
        enableClickSelection: true,
        // AG Grid 36 SSRM: only `'all'` is valid (not filtered/currentPage).
        // Selection spans unloaded blocks via get/setServerSideSelectionState.
        selectAll: "all" as const,
        groupSelects: "descendants" as const,
      }),
      [],
    );
    const cellSelection = useMemo(() => ({ handle: { mode: "fill" as const } }), []);
    const aggFuncs = useMemo(
      () => ({
        trafficLight: trafficLightAggFunc,
        rag: trafficLightAggFunc,
      }),
      [],
    );

    void forceRerender;

    const resolvedTheme = props.theme ?? defaultTheme;
    const loadGoogleFonts =
      props.loadThemeGoogleFonts ?? props.theme == null;

    return (
      <div ref={hostRef} style={{ height: props.height ?? "100%", width: "100%" }}>
        <AgGridReact
          theme={resolvedTheme}
          loadThemeGoogleFonts={loadGoogleFonts}
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
          debounceVerticalScrollbar={false}
          blockLoadDebounceMillis={props.blockLoadDebounceMillis ?? 25}
          suppressAnimationFrame={props.suppressAnimationFrame ?? true}
          animateRows={false}
          // Prefer empty cells over full-width "Loading…" rows while blocks fetch
          // (AG Grid SSRM; restored via showLoadingOverlay).
          suppressServerSideFullWidthLoadingRow={!(props.showLoadingOverlay ?? false)}
          rowHeight={props.rowHeight}
          headerHeight={props.headerHeight}
          {...(props.enableCellChangeFlash
            ? { cellFlashDuration: 500 }
            : { cellFlashDuration: 0 })}
          // Batch high-frequency leaf ticks into one DOM pass (AG Grid SSRM).
          asyncTransactionWaitMillis={50}
          rowGroupPanelShow={treeData ? "never" : "always"}
          pivotPanelShow="always"
          sideBar={sideBar as never}
          statusBar={statusBar as never}
          components={props.components as never}
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
          serverSidePivotResultFieldSeparator={PIVOT_FIELD_SEPARATOR}
          getRowId={getRowIdCb}
          getChildCount={(data) =>
            typeof data?.childCount === "number" ? data.childCount : undefined
          }
          onBodyScroll={onBodyScroll}
          onColumnRowGroupChanged={onStructureChanged}
          onColumnPivotChanged={onStructureChanged}
          onColumnPivotModeChanged={onStructureChanged}
          onFilterChanged={() => {
            rowMirrorRef.current.invalidateView();
            void refreshTotals({ refetchTotal: false });
          }}
          onCellValueChanged={onCellValueChanged}
          onFirstDataRendered={() => void refreshTotals()}
          onGridReady={(e) => {
            apiRef.current = e.api;
            gridReadyRef.current = true;
            e.api.setGridOption("context", {
              ...(e.api.getGridOption("context") as object | undefined),
              rowMirror: rowMirrorRef.current,
              ssrmCountMatching: countMatching,
              ssrmConfigured: configuredRef.current,
            });
            // feedConfig effect already owns configureAndLoad. Re-entering here
            // (or purging again after it finishes) is what made CSRM→SSRM
            // appear to load/refresh twice.
            if (
              !configuredRef.current &&
              !configureInFlightRef.current &&
              !ingestingRef.current
            ) {
              void configureAndLoad();
            }
            props.onGridReady?.(e);
          }}
        />
      </div>
    );
  },
);
