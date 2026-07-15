/**
 * Uncapped fetch of all leaf rows under a row-group path (Phase 4a).
 *
 * Builds equality filters for each `groupKeys[i]` on `rowGroupCols[i].field`,
 * merges with the active filterModel, and calls `queryAll` with `limit: null`
 * so Perspective returns every matching leaf (no product cap).
 */

import type { QueryAllRequest, QueryAllResult, SsrmGetRowsRequest } from "./types";

export type GroupLeafRowGroupCol = {
  field: string;
  id?: string;
  displayName?: string;
};

/**
 * Merge group path equalities into an AG Grid-style filterModel.
 * Later keys override same-field entries from `base` (group path wins).
 */
export function mergeGroupPathIntoFilterModel(
  base: Record<string, unknown> | undefined,
  rowGroupCols: readonly GroupLeafRowGroupCol[],
  groupKeys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  const n = Math.min(rowGroupCols.length, groupKeys.length);
  for (let i = 0; i < n; i++) {
    const field = rowGroupCols[i]?.field;
    if (!field) continue;
    out[field] = {
      filterType: "text",
      type: "equals",
      filter: groupKeys[i],
    };
  }
  return out;
}

export type QueryAllFn = (request: QueryAllRequest) => Promise<QueryAllResult>;

/**
 * Fetch every leaf row under the given group path.
 * @param queryAll - worker client `queryAll`
 * @param opts.dataset - Perspective dataset id
 * @param opts.rowGroupCols - current row group columns (outer → inner)
 * @param opts.groupKeys - path to the selected group (length ≤ rowGroupCols)
 * @param opts.filterModel - active grid filters (group path merged on top)
 * @param opts.quickFilterText / quickFilterFields - optional
 */
export async function fetchAllGroupLeafRows(
  queryAll: QueryAllFn,
  opts: {
    dataset: QueryAllRequest["dataset"];
    rowGroupCols: readonly GroupLeafRowGroupCol[];
    groupKeys: readonly string[];
    filterModel?: Record<string, unknown>;
    quickFilterText?: string;
    quickFilterFields?: string[];
    rowKeepExpression?: string;
    sortModel?: QueryAllRequest["sortModel"];
  },
): Promise<Record<string, unknown>[]> {
  const filterModel = mergeGroupPathIntoFilterModel(
    opts.filterModel,
    opts.rowGroupCols,
    opts.groupKeys,
  );

  const result = await queryAll({
    dataset: opts.dataset,
    filterModel,
    sortModel: opts.sortModel ?? [],
    limit: null,
    quickFilterText: opts.quickFilterText,
    quickFilterFields: opts.quickFilterFields,
    rowKeepExpression: opts.rowKeepExpression,
    includeStructure: false,
  });

  return result.rowData;
}

/** Narrow rowGroupCols from AG Grid / SSRM request shapes. */
export function toGroupLeafCols(
  cols: SsrmGetRowsRequest["rowGroupCols"] | readonly GroupLeafRowGroupCol[],
): GroupLeafRowGroupCol[] {
  return cols.map((c) => ({
    field: c.field,
    id: "id" in c ? c.id : undefined,
    displayName: "displayName" in c ? c.displayName : undefined,
  }));
}
