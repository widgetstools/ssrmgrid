import {
  GRAND_TOTAL_ROW_ID,
  type ColDef,
  type Column,
  type GridApi,
} from "ag-grid-community";

import type { MirrorValueCol } from "./mirrorGroupAgg";
import type { RowMirror } from "./rowMirror";

function readValueCols(api: GridApi): MirrorValueCol[] {
  const cols = api.getValueColumns?.() ?? [];
  return cols.map((col: Column) => {
    const def = col.getColDef() as ColDef;
    return {
      id: col.getColId(),
      field: def.field ?? col.getColId(),
      aggFunc: String(col.getAggFunc?.() ?? def.aggFunc ?? "sum"),
    };
  });
}

function readRowGroupCols(api: GridApi): { id: string; field: string }[] {
  return (api.getRowGroupColumns?.() ?? []).map((col) => {
    const def = col.getColDef() as ColDef;
    return {
      id: col.getColId(),
      field: def.field ?? col.getColId(),
    };
  });
}

function measureFieldsEqual(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
  fields: string[],
): boolean {
  if (!prev) return false;
  for (const field of fields) {
    if (prev[field] !== next[field]) return false;
  }
  return true;
}

function buildGrandTotalData(
  valueCols: MirrorValueCol[],
  aggregates?: Record<string, Record<string, unknown>>,
  totals?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if ((!aggregates || Object.keys(aggregates).length === 0) && !totals) {
    return undefined;
  }
  const row: Record<string, unknown> = {};
  let hasValue = false;
  for (const vc of valueCols) {
    if (!vc.field) continue;
    const fromAgg = aggregates?.[vc.field]?.[vc.aggFunc];
    const value = fromAgg !== undefined ? fromAgg : totals?.[vc.field];
    if (value !== undefined) {
      // Keep full precision — rounding avgs hid grand-total flashes when a few
      // leaf prices moved inside a large book (portfolio avg barely moves at 2dp).
      row[vc.field] = value;
      hasValue = true;
    }
  }
  return hasValue ? row : undefined;
}

export type MirrorAggPatchExtras = {
  quickFilterText?: string;
  quickFilterFields?: string[];
  absSort?: boolean;
  rowKeepExpression?: string;
  /** Primary key field — stamped with GRAND_TOTAL_ROW_ID for getRowId. */
  idField?: string;
};

/**
 * Patch the native AG Grid `grandTotalRow` from the main-thread leaf book.
 * SSRM only refreshes grand totals via getRows / transactions with
 * `getRowId === GRAND_TOTAL_ROW_ID` — leaf txs alone leave the footer stale.
 */
export function patchGrandTotalFromMirror(
  api: GridApi,
  mirror: RowMirror,
  extras?: MirrorAggPatchExtras,
): void {
  if (!mirror.isReady) return;
  const valueCols = readValueCols(api);
  if (valueCols.length === 0) return;

  const rowGroupCols = readRowGroupCols(api);
  const filterModel =
    (api.getFilterModel?.() as Record<string, unknown> | null) ?? {};
  const slice = mirror.tryGetRows({
    startRow: 0,
    endRow: 0,
    rowGroupCols,
    groupKeys: [],
    pivotMode: Boolean(api.isPivotMode?.()),
    filterModel,
    sortModel: [],
    valueCols,
    quickFilterText: extras?.quickFilterText,
    quickFilterFields: extras?.quickFilterFields,
    absSort: extras?.absSort,
    rowKeepExpression: extras?.rowKeepExpression,
  });
  if (!slice?.totals && !slice?.aggregates) return;

  const grandTotalData = buildGrandTotalData(
    valueCols,
    slice.aggregates,
    slice.totals,
  );
  if (!grandTotalData) return;

  const idField = extras?.idField ?? "id";
  grandTotalData[idField] = GRAND_TOTAL_ROW_ID;

  const fields = valueCols.map((vc) => vc.field).filter(Boolean);
  const prev = api.getRowNode?.(GRAND_TOTAL_ROW_ID)?.data as
    | Record<string, unknown>
    | undefined;
  if (measureFieldsEqual(prev, grandTotalData, fields)) return;

  api.applyServerSideTransactionAsync({
    update: [grandTotalData],
  });
}

/**
 * Recompute group-header aggregates from the main-thread leaf book and patch
 * every loaded group store in place (keeps ticks live under row grouping).
 */
export function patchLoadedGroupAggregatesFromMirror(
  api: GridApi,
  mirror: RowMirror,
  extras?: MirrorAggPatchExtras,
): void {
  if (!mirror.isReady) return;
  const rowGroupCols = readRowGroupCols(api);
  if (rowGroupCols.length === 0) return;

  const valueCols = readValueCols(api);
  const measureFields = valueCols.map((vc) => vc.field).filter(Boolean);
  const filterModel =
    (api.getFilterModel?.() as Record<string, unknown> | null) ?? {};
  const levels = api.getServerSideGroupLevelState?.() ?? [];

  for (const level of levels) {
    const route = [...(level.route ?? [])].map(String);
    // Leaf stores have route length === rowGroupCols.length — skip.
    if (route.length >= rowGroupCols.length) continue;

    const groups = mirror.getGroupRowsForRoute({
      rowGroupCols,
      groupKeys: route,
      pivotMode: Boolean(api.isPivotMode?.()),
      filterModel,
      sortModel: [],
      valueCols,
      quickFilterText: extras?.quickFilterText,
      quickFilterFields: extras?.quickFilterFields,
      absSort: extras?.absSort,
      rowKeepExpression: extras?.rowKeepExpression,
    });
    if (!groups?.length) continue;

    const changed: Record<string, unknown>[] = [];
    for (const next of groups) {
      const key = String(next.__ssrmGroupKey ?? "");
      const nodeId = `g:${[...route, key].join("|")}`;
      const prev = api.getRowNode?.(nodeId)?.data as
        | Record<string, unknown>
        | undefined;
      if (measureFieldsEqual(prev, next, measureFields)) continue;
      changed.push(next);
    }
    if (changed.length === 0) continue;

    api.applyServerSideTransactionAsync({
      route,
      update: changed,
    });
  }
}
