import type { GridApi } from "ag-grid-community";
import type { QueryAllRequest } from "./types";
import { getActiveFilterModel } from "./activeFilterModel";
import { resolveAggFuncName } from "./compileColExpression";

export function readSortModel(
  api: GridApi,
): { colId: string; sort: "asc" | "desc" }[] {
  return api
    .getColumnState()
    .filter((c) => c.colId && (c.sort === "asc" || c.sort === "desc"))
    .map((c) => ({ colId: c.colId!, sort: c.sort as "asc" | "desc" }))
    .sort((a, b) => {
      const state = api.getColumnState();
      const aIdx = state.find((c) => c.colId === a.colId)?.sortIndex ?? 0;
      const bIdx = state.find((c) => c.colId === b.colId)?.sortIndex ?? 0;
      return aIdx - bIdx;
    });
}

export function readGroupCols(api: GridApi): QueryAllRequest["rowGroupCols"] {
  return api
    .getRowGroupColumns()
    .map((col) => {
      const def = col.getColDef();
      return {
        id: col.getColId(),
        field: def.field ?? col.getColId(),
        displayName: def.headerName ?? def.field ?? col.getColId(),
      };
    })
    .filter((c) => c.field);
}

export function readValueCols(api: GridApi): QueryAllRequest["valueCols"] {
  return api.getValueColumns().map((col) => {
    const def = col.getColDef();
    return {
      id: col.getColId(),
      field: def.field ?? col.getColId(),
      aggFunc: resolveAggFuncName(col.getAggFunc?.() ?? def.aggFunc ?? "sum"),
    };
  });
}

export function readPivotCols(api: GridApi): QueryAllRequest["pivotCols"] {
  return api.getPivotColumns().map((col) => {
    const def = col.getColDef();
    return {
      id: col.getColId(),
      field: def.field ?? col.getColId(),
      displayName: def.headerName ?? def.field ?? col.getColId(),
    };
  });
}

/** Build a default queryAll request from the live grid's filter/sort/structure. */
export function buildQueryAllRequestFromApi(
  api: GridApi,
  base: {
    dataset: QueryAllRequest["dataset"];
    quickFilterText?: string;
    quickFilterFields?: string[];
    rowKeepExpression?: string;
    treeData?: boolean;
    absSort?: boolean;
    limit?: number | null;
    includeStructure?: boolean;
  },
  overrides?: Partial<QueryAllRequest>,
): QueryAllRequest {
  const pivotMode = Boolean(api.isPivotMode?.());
  const rowGroupCols = readGroupCols(api);
  const includeStructure =
    overrides?.includeStructure ??
    base.includeStructure ??
    (pivotMode || (rowGroupCols?.length ?? 0) > 0 || Boolean(base.treeData));

  return {
    dataset: base.dataset,
    filterModel: overrides?.filterModel ?? getActiveFilterModel(api),
    sortModel: overrides?.sortModel ?? readSortModel(api),
    limit: overrides?.limit ?? base.limit ?? 50_000,
    quickFilterText: overrides?.quickFilterText ?? base.quickFilterText,
    quickFilterFields: overrides?.quickFilterFields ?? base.quickFilterFields,
    rowKeepExpression: overrides?.rowKeepExpression ?? base.rowKeepExpression,
    includeStructure,
    rowGroupCols: overrides?.rowGroupCols ?? rowGroupCols,
    valueCols: overrides?.valueCols ?? readValueCols(api),
    pivotCols: overrides?.pivotCols ?? readPivotCols(api),
    pivotMode: overrides?.pivotMode ?? pivotMode,
    groupKeys: overrides?.groupKeys ?? [],
    treeData: overrides?.treeData ?? base.treeData,
    absSort: overrides?.absSort ?? base.absSort,
  };
}
