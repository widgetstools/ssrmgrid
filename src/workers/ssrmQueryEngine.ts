import {
  getCalculatedColumnNames,
  getCalculatedExpressions,
} from "../data/calculatedColumns";
import {
  getDatasetMeta,
  getDatasetPrimaryKey,
  getSchema,
  type SchemaType,
} from "../data/schemas";
import type { DatasetId, SsrmGetRowsRequest, SsrmSortEntry } from "../ssrm/types";
import {
  foldTrafficLight,
  isTrafficLightAgg,
} from "../ssrm/trafficLightAgg";
import { absSortExprName } from "./perspectiveExpr";
import { aggregateAlias } from "./sumTotals";
import {
  applyPostPredicate,
  mapFilterModel,
  mergeFilterPlans,
  quickFilterToPlan,
  type FilterPlan,
  type PerspectiveFilter,
} from "./ssrmFilters";

/** Matches Perspective `split_by` column path separator (`EUR|pnl`). */
export const PIVOT_FIELD_SEPARATOR = "|";

/** Synthetic group_by used when pivot mode has no row groups (grand total). */
export const PIVOT_ROOT_EXPR = "__ssrm_pivot_root";

export interface PerspectiveViewConfig {
  group_by?: string[];
  split_by?: string[];
  columns: string[];
  aggregates?: Record<string, string>;
  filter?: PerspectiveFilter[];
  filter_op?: "and" | "or";
  sort?: [string, "asc" | "desc"][];
  expressions?: Record<string, string>;
}

export interface MappedQuery {
  mode: "group" | "leaf" | "pivot" | "tree";
  viewConfig: PerspectiveViewConfig;
  /** Optional second view for group expand counts when split_by is active. */
  structureViewConfig?: PerspectiveViewConfig;
  /** field that holds the group key value for the current level */
  groupField?: string;
  /** Next row-group field used for distinct child counts in pivot mode. */
  nextGroupField?: string;
  /** When true, group rows must not expand further (pivot leaf groups). */
  suppressChildren?: boolean;
  /** Past last row group in pivot mode — return no rows. */
  empty?: boolean;
  /**
   * Sorts applied after Perspective fetch (pivot result paths like `USD|pnl`
   * cannot be sorted by Perspective and would abort the view).
   */
  clientSort?: SsrmSortEntry[];
  /** Client-side row predicate for filters Perspective cannot express. */
  postPredicate?: FilterPlan["postPredicate"];
  startRow: number;
  endRow: number;
}

/** Fallback count-aggregate source column (overridden by callers with the
 *  dataset's real primary key via getCountAggField). */
export const COUNT_AGG_FIELD = "id";

export function getCountAggField(dataset: DatasetId): string {
  return getDatasetPrimaryKey(dataset);
}

export function getTreeHierarchy(dataset: DatasetId): string[] {
  return getDatasetMeta(dataset).treeFields;
}

function schemaOf(dataset: DatasetId): Record<string, SchemaType> {
  return getSchema(dataset);
}

export function getStringColumns(dataset: DatasetId): string[] {
  const schema = schemaOf(dataset);
  return Object.entries(schema)
    .filter(([, t]) => t === "string")
    .map(([k]) => k);
}

/**
 * String columns searched by quick filter. Excludes the dataset primary key
 * (IDs rarely belong in "search"). Optional `fields` further restricts the set.
 */
export function getQuickFilterColumns(
  dataset: DatasetId,
  fields?: string[],
): string[] {
  const pk = getDatasetPrimaryKey(dataset);
  const stringCols = getStringColumns(dataset).filter((k) => k !== pk);
  if (fields && fields.length > 0) {
    const allowed = new Set(fields);
    return stringCols.filter((k) => allowed.has(k));
  }
  return stringCols;
}

const AGG_FUNC_MAP: Record<string, string> = {
  sum: "sum",
  avg: "avg",
  mean: "avg",
  count: "count",
  min: "min",
  max: "max",
  first: "first",
  last: "last",
  lastByIndex: "last by index",
  countDistinct: "distinct count",
  distinct: "distinct count",
  "distinct count": "distinct count",
  median: "median",
  stddev: "stddev",
  var: "var",
  // Perspective has no weighted mean — approximate with avg at view time;
  // getAggregates / post paths compute true weighted average by quantity.
  weightedAvg: "avg",
};

export { applyPostPredicate, mapFilterModel };

export function getLeafColumns(dataset?: DatasetId): string[] {
  if (!dataset) return [];
  const calc = getCalculatedColumnNames(dataset);
  return [...Object.keys(schemaOf(dataset)), ...calc].sort();
}

function buildAncestorFilters(
  rowGroupCols: SsrmGetRowsRequest["rowGroupCols"],
  groupKeys: string[],
): PerspectiveFilter[] {
  const filters: PerspectiveFilter[] = [];
  for (let i = 0; i < groupKeys.length; i++) {
    const groupCol = rowGroupCols[i];
    if (!groupCol) {
      continue;
    }
    filters.push([groupCol.field, "==", groupKeys[i]]);
  }
  return filters;
}

/** AG Grid uses this colId when sorting the auto-group column. */
export const AG_AUTO_GROUP_COL_ID = "ag-Grid-AutoColumn";

export function remapSortColId(colId: string, groupField?: string): string {
  if (colId === AG_AUTO_GROUP_COL_ID && groupField) {
    return groupField;
  }
  return colId;
}

function withAbsSortFlags(
  sortModel: SsrmSortEntry[],
  absSort?: boolean,
  dataset?: DatasetId,
): SsrmSortEntry[] {
  if (!absSort || !dataset) return sortModel;
  const schema = schemaOf(dataset);
  return sortModel.map((entry) => {
    const field = entry.colId.includes(PIVOT_FIELD_SEPARATOR)
      ? entry.colId.slice(entry.colId.lastIndexOf(PIVOT_FIELD_SEPARATOR) + 1)
      : entry.colId;
    const t = schema[field];
    if (t === "float" || t === "integer") {
      return { ...entry, abs: true };
    }
    return entry;
  });
}

/**
 * Partition AG Grid sortModel into Perspective-safe sorts vs post-fetch sorts.
 * Abs sorts use a synthetic expression column when Perspective-safe.
 */
export function resolveSortModel(
  sortModel: SsrmSortEntry[],
  options: {
    groupField?: string;
    perspectiveSortable: Iterable<string>;
  },
): {
  perspectiveSort?: PerspectiveViewConfig["sort"];
  clientSort?: SsrmSortEntry[];
  absExpressions?: Record<string, string>;
} {
  if (sortModel.length === 0) {
    return {};
  }

  const sortable = new Set(options.perspectiveSortable);
  const remapped = sortModel.map((entry) => ({
    ...entry,
    colId: remapSortColId(entry.colId, options.groupField),
  }));

  const absExpressions: Record<string, string> = {};
  const perspectiveEntries: [string, "asc" | "desc"][] = [];
  let needsClient = false;

  for (const entry of remapped) {
    if (
      entry.colId.includes(PIVOT_FIELD_SEPARATOR) ||
      !sortable.has(entry.colId)
    ) {
      needsClient = true;
      break;
    }
    if (entry.abs) {
      const exprName = absSortExprName(entry.colId);
      absExpressions[exprName] = `abs("${entry.colId}")`;
      perspectiveEntries.push([exprName, entry.sort]);
    } else {
      perspectiveEntries.push([entry.colId, entry.sort]);
    }
  }

  if (needsClient) {
    return { clientSort: remapped };
  }

  return {
    perspectiveSort: perspectiveEntries,
    absExpressions:
      Object.keys(absExpressions).length > 0 ? absExpressions : undefined,
  };
}

function compareSortValues(a: unknown, b: unknown, abs?: boolean): number {
  if (typeof a === "number" && typeof b === "number") {
    const left = abs ? Math.abs(a) : a;
    const right = abs ? Math.abs(b) : b;
    return left - right;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** Stable multi-key sort for rows after a Perspective fetch. */
export function applyClientSort(
  rows: Record<string, unknown>[],
  clientSort?: SsrmSortEntry[],
): Record<string, unknown>[] {
  if (!clientSort || clientSort.length === 0) {
    return rows;
  }

  return [...rows].sort((left, right) => {
    for (const { colId, sort, abs } of clientSort) {
      const a = left[colId];
      const b = right[colId];
      if (a == null && b == null) continue;
      if (a == null) return 1;
      if (b == null) return -1;
      const cmp = compareSortValues(a, b, abs);
      if (cmp !== 0) {
        return sort === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function mergeFilters(
  ancestor: PerspectiveFilter[],
  plan: FilterPlan,
): Pick<PerspectiveViewConfig, "filter" | "filter_op"> & {
  postPredicate?: FilterPlan["postPredicate"];
  expressions?: Record<string, string>;
} {
  const filters = [...ancestor, ...(plan.filters ?? [])];
  return {
    filter: filters.length > 0 ? filters : undefined,
    filter_op: plan.filterOp,
    postPredicate: plan.postPredicate,
    expressions: plan.expressions,
  };
}

export type ValueAggPlan = {
  aggregates: Record<string, string>;
  measureColumns: string[];
  expressions: Record<string, string>;
};

/** Perspective aggregates for value cols; trafficLight expands to min+max aliases. */
export function buildValueAggPlan(
  valueCols: SsrmGetRowsRequest["valueCols"],
): ValueAggPlan {
  const aggregates: Record<string, string> = {};
  const measureColumns: string[] = [];
  const expressions: Record<string, string> = {};

  for (const valueCol of valueCols) {
    const field = valueCol.field;
    if (!field) continue;

    if (isTrafficLightAgg(valueCol.aggFunc)) {
      const minAlias = aggregateAlias(field, "min");
      const maxAlias = aggregateAlias(field, "max");
      expressions[minAlias] = `"${field}"`;
      expressions[maxAlias] = `"${field}"`;
      aggregates[minAlias] = "min";
      aggregates[maxAlias] = "max";
      if (!measureColumns.includes(minAlias)) measureColumns.push(minAlias);
      if (!measureColumns.includes(maxAlias)) measureColumns.push(maxAlias);
      continue;
    }

    aggregates[field] = mapAggFunc(valueCol.aggFunc);
    if (!measureColumns.includes(field)) measureColumns.push(field);
  }

  return { aggregates, measureColumns, expressions };
}

function buildValueAggregates(
  valueCols: SsrmGetRowsRequest["valueCols"],
): Record<string, string> {
  return buildValueAggPlan(valueCols).aggregates;
}

function filterNamedCols<T extends { field: string }>(cols: T[]): T[] {
  return cols.filter((col) => typeof col.field === "string" && col.field.length > 0);
}

export function mapAggFunc(agFunc: string): string {
  return AGG_FUNC_MAP[agFunc] ?? agFunc;
}

export function isPivotResultField(
  path: string,
  valueCols: SsrmGetRowsRequest["valueCols"],
): boolean {
  return valueCols.some(
    (vc) =>
      path === vc.field || path.endsWith(`${PIVOT_FIELD_SEPARATOR}${vc.field}`),
  );
}

function mergeViewExpressions(
  dataset: DatasetId | undefined,
  ...parts: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (dataset) {
    Object.assign(merged, getCalculatedExpressions(dataset));
  }
  for (const part of parts) {
    if (part) Object.assign(merged, part);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function finalizeView(
  view: PerspectiveViewConfig,
  dataset: DatasetId | undefined,
  filterExprs?: Record<string, string>,
  absExprs?: Record<string, string>,
  options: { includeCalculatedColumns?: boolean } = {},
): PerspectiveViewConfig {
  const expressions = mergeViewExpressions(
    dataset,
    filterExprs,
    absExprs,
    view.expressions,
  );
  if (!expressions) return view;

  const columns = new Set(view.columns);
  const calcNames = dataset
    ? new Set(getCalculatedColumnNames(dataset))
    : new Set<string>();

  // Leaf views expose all calc columns; group/pivot only keep ones already
  // selected as measures (already present in view.columns).
  if (options.includeCalculatedColumns) {
    for (const name of calcNames) {
      columns.add(name);
    }
  }

  for (const name of Object.keys(absExprs ?? {})) {
    columns.add(name);
  }
  for (const name of Object.keys(filterExprs ?? {})) {
    columns.add(name);
  }

  // Drop unused calc expressions from the view to keep aggregated views lean.
  const trimmed: Record<string, string> = {};
  for (const [name, expr] of Object.entries(expressions)) {
    if (calcNames.has(name) && !columns.has(name) && !options.includeCalculatedColumns) {
      continue;
    }
    trimmed[name] = expr;
  }

  return {
    ...view,
    columns: [...columns],
    expressions: Object.keys(trimmed).length > 0 ? trimmed : undefined,
  };
}

function mapPivotRequestToView(
  request: SsrmGetRowsRequest,
  rowGroupCols: SsrmGetRowsRequest["rowGroupCols"],
  groupKeys: string[],
  valueCols: SsrmGetRowsRequest["valueCols"],
  pivotCols: SsrmGetRowsRequest["pivotCols"],
  filterExtras: {
    filter?: PerspectiveFilter[];
    filter_op?: "and" | "or";
    postPredicate?: FilterPlan["postPredicate"];
    expressions?: Record<string, string>;
  },
  dataset?: DatasetId,
): MappedQuery {
  const splitBy = pivotCols.map((c) => c.field);
  const valueAggPlan = buildValueAggPlan(valueCols);
  const valueFields = valueAggPlan.measureColumns;
  const valueAggregates = valueAggPlan.aggregates;
  const valueExpressions = valueAggPlan.expressions;
  const { filter, filter_op, postPredicate, expressions: filterExprs } =
    filterExtras;
  const sortModel = withAbsSortFlags(
    request.sortModel,
    request.absSort,
    dataset,
  );

  if (rowGroupCols.length > 0 && groupKeys.length >= rowGroupCols.length) {
    return {
      mode: "pivot",
      viewConfig: { columns: valueFields.length > 0 ? valueFields : [] },
      suppressChildren: true,
      empty: true,
      startRow: request.startRow,
      endRow: request.endRow,
    };
  }

  if (rowGroupCols.length === 0) {
    const { perspectiveSort, clientSort, absExpressions } = resolveSortModel(
      sortModel,
      {
        perspectiveSortable: [...valueFields, PIVOT_ROOT_EXPR],
      },
    );

    return {
      mode: "pivot",
      viewConfig: finalizeView(
        {
          expressions: { [PIVOT_ROOT_EXPR]: "1", ...valueExpressions },
          group_by: [PIVOT_ROOT_EXPR],
          ...(splitBy.length > 0 ? { split_by: splitBy } : {}),
          columns: valueFields,
          aggregates: {
            ...valueAggregates,
            [PIVOT_ROOT_EXPR]: "any",
          },
          filter,
          filter_op,
          sort: perspectiveSort,
        },
        dataset,
        filterExprs,
        absExpressions,
      ),
      clientSort,
      postPredicate,
      suppressChildren: true,
      startRow: request.startRow,
      endRow: request.endRow,
    };
  }

  const groupField = rowGroupCols[groupKeys.length]?.field;
  if (!groupField) {
    return {
      mode: "pivot",
      viewConfig: finalizeView({ columns: valueFields }, dataset, filterExprs),
      suppressChildren: true,
      postPredicate,
      startRow: request.startRow,
      endRow: request.endRow,
    };
  }

  const nextGroupField = rowGroupCols[groupKeys.length + 1]?.field;
  const suppressChildren = !nextGroupField;

  const { perspectiveSort, clientSort, absExpressions } = resolveSortModel(
    sortModel,
    {
      groupField,
      perspectiveSortable: [groupField, ...valueFields],
    },
  );

  const pivotView: PerspectiveViewConfig = {
    group_by: [groupField],
    columns: valueFields,
    expressions:
      Object.keys(valueExpressions).length > 0 ? valueExpressions : undefined,
    aggregates: {
      ...valueAggregates,
      [groupField]: "any",
    },
    filter,
    filter_op,
    sort: perspectiveSort,
  };
  if (splitBy.length > 0) {
    pivotView.split_by = splitBy;
  }

  let structureViewConfig: PerspectiveViewConfig | undefined;
  if (nextGroupField) {
    structureViewConfig = finalizeView(
      {
        group_by: [groupField],
        columns: [groupField, nextGroupField],
        aggregates: {
          [groupField]: "any",
          [nextGroupField]: "distinct count",
        },
        filter,
        filter_op,
      },
      dataset,
      filterExprs,
    );
  }

  return {
    mode: "pivot",
    viewConfig: finalizeView(pivotView, dataset, filterExprs, absExpressions),
    structureViewConfig,
    groupField,
    nextGroupField,
    suppressChildren,
    clientSort,
    postPredicate,
    startRow: request.startRow,
    endRow: request.endRow,
  };
}

export function mapSsrmRequestToView(
  request: SsrmGetRowsRequest,
  countAggField: string = COUNT_AGG_FIELD,
  dataset?: DatasetId,
): MappedQuery {
  const resolvedDataset = dataset ?? request.dataset;
  const leafColumns = getLeafColumns(resolvedDataset);

  let rowGroupCols = filterNamedCols(request.rowGroupCols);
  if (request.treeData) {
    rowGroupCols = getTreeHierarchy(resolvedDataset).map((field) => ({
      id: field,
      field,
      displayName: field,
    }));
  }

  const groupKeys = request.groupKeys.slice(0, rowGroupCols.length);
  const valueCols = filterNamedCols(request.valueCols);
  const pivotCols = filterNamedCols(request.pivotCols ?? []);

  const ancestorFilters = buildAncestorFilters(rowGroupCols, groupKeys);
  const columnFilters = mapFilterModel(request.filterModel);
  const quickPlan = quickFilterToPlan(
    request.quickFilterText,
    getQuickFilterColumns(resolvedDataset, request.quickFilterFields),
  );
  const combinedPlan = mergeFilterPlans([columnFilters, quickPlan], "and");
  const filterExtras = mergeFilters(ancestorFilters, combinedPlan);
  const { filter, filter_op, postPredicate, expressions: filterExprs } =
    filterExtras;
  const sortModel = withAbsSortFlags(
    request.sortModel,
    request.absSort,
    resolvedDataset,
  );

  if (request.pivotMode) {
    return mapPivotRequestToView(
      { ...request, sortModel },
      rowGroupCols,
      groupKeys,
      valueCols,
      pivotCols,
      filterExtras,
      resolvedDataset,
    );
  }

  if (rowGroupCols.length === 0) {
    const { perspectiveSort, clientSort, absExpressions } = resolveSortModel(
      sortModel,
      { perspectiveSortable: leafColumns },
    );
    return {
      mode: "leaf",
      viewConfig: finalizeView(
        {
          columns: leafColumns,
          filter,
          filter_op,
          sort: perspectiveSort,
        },
        resolvedDataset,
        filterExprs,
        absExpressions,
      ),
      clientSort,
      postPredicate,
      startRow: request.startRow,
      endRow: request.endRow,
    };
  }

  const isLeaf = groupKeys.length === rowGroupCols.length;

  if (isLeaf) {
    const { perspectiveSort, clientSort, absExpressions } = resolveSortModel(
      sortModel,
      { perspectiveSortable: leafColumns },
    );
    return {
      mode: request.treeData ? "tree" : "leaf",
      viewConfig: finalizeView(
        {
          columns: leafColumns,
          filter,
          filter_op,
          sort: perspectiveSort,
        },
        resolvedDataset,
        filterExprs,
        absExpressions,
      ),
      clientSort,
      postPredicate,
      startRow: request.startRow,
      endRow: request.endRow,
    };
  }

  const groupField = rowGroupCols[groupKeys.length]?.field;
  if (!groupField) {
    const { perspectiveSort, clientSort, absExpressions } = resolveSortModel(
      sortModel,
      { perspectiveSortable: leafColumns },
    );
    return {
      mode: "leaf",
      viewConfig: finalizeView(
        {
          columns: leafColumns,
          filter,
          filter_op,
          sort: perspectiveSort,
        },
        resolvedDataset,
        filterExprs,
        absExpressions,
      ),
      clientSort,
      postPredicate,
      startRow: request.startRow,
      endRow: request.endRow,
    };
  }

  const { perspectiveSort, clientSort, absExpressions } = resolveSortModel(
    sortModel,
    {
      groupField,
      perspectiveSortable: [
        groupField,
        ...valueCols.map((c) => c.field),
        countAggField,
      ],
    },
  );

  const valueAggPlan = buildValueAggPlan(valueCols);
  const aggregates = {
    ...valueAggPlan.aggregates,
    [groupField]: "any",
    [countAggField]: "count",
  };
  const columns = [
    groupField,
    ...valueAggPlan.measureColumns.filter((field) => field !== groupField),
    countAggField,
  ];

  return {
    mode: request.treeData ? "tree" : "group",
    viewConfig: finalizeView(
      {
        group_by: [groupField],
        columns,
        aggregates,
        expressions:
          Object.keys(valueAggPlan.expressions).length > 0
            ? valueAggPlan.expressions
            : undefined,
        filter,
        filter_op,
        sort: perspectiveSort,
      },
      resolvedDataset,
      filterExprs,
      absExpressions,
    ),
    groupField,
    clientSort,
    postPredicate,
    startRow: request.startRow,
    endRow: request.endRow,
  };
}

export function shapeGroupRows(
  jsonRows: Record<string, unknown>[],
  groupField: string,
  valueCols: SsrmGetRowsRequest["valueCols"],
  countAggField: string = COUNT_AGG_FIELD,
): Record<string, unknown>[] {
  return jsonRows.map((row) => {
    const groupValue = row[groupField];
    const shaped: Record<string, unknown> = {
      [groupField]: groupValue,
      __ssrmGroupKey: groupValue == null ? "" : String(groupValue),
      childCount: Number(row[countAggField]) || 0,
    };

    for (const valueCol of valueCols) {
      if (!valueCol.field || valueCol.field === groupField) {
        continue;
      }
      if (isTrafficLightAgg(valueCol.aggFunc)) {
        const minAlias = aggregateAlias(valueCol.field, "min");
        const maxAlias = aggregateAlias(valueCol.field, "max");
        shaped[valueCol.field] = foldTrafficLight(row[minAlias], row[maxAlias]);
      } else {
        shaped[valueCol.field] = row[valueCol.field];
      }
    }

    return shaped;
  });
}

/** Shape OLAP-style group rows for AG Grid SSRM treeData mode. */
export function shapeTreeGroupRows(
  jsonRows: Record<string, unknown>[],
  groupField: string,
  valueCols: SsrmGetRowsRequest["valueCols"],
  countAggField: string = COUNT_AGG_FIELD,
): Record<string, unknown>[] {
  return shapeGroupRows(jsonRows, groupField, valueCols, countAggField).map(
    (row) => ({
      ...row,
      group: true,
      __treeKey: String(row.__ssrmGroupKey ?? ""),
      __treeLabel: row[groupField],
    }),
  );
}

export function shapeTreeLeafRows(
  jsonRows: Record<string, unknown>[],
  primaryKey: string,
): Record<string, unknown>[] {
  return jsonRows.map((row) => ({
    ...row,
    group: false,
    __treeKey: String(row[primaryKey] ?? ""),
    __treeLabel: row[primaryKey],
  }));
}

export function shapeLeafRows(
  jsonRows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return jsonRows;
}

function rowPathKey(row: Record<string, unknown>): string {
  const path = row.__ROW_PATH__;
  if (!Array.isArray(path) || path.length === 0) {
    return "";
  }
  return path[path.length - 1] == null ? "" : String(path[path.length - 1]);
}

export function shapePivotRows(
  jsonRows: Record<string, unknown>[],
  options: {
    groupField?: string;
    valueCols: SsrmGetRowsRequest["valueCols"];
    suppressChildren?: boolean;
    structureRows?: Record<string, unknown>[];
    nextGroupField?: string;
  },
): Record<string, unknown>[] {
  const {
    groupField,
    valueCols,
    suppressChildren = false,
    structureRows,
    nextGroupField,
  } = options;

  const countByKey = new Map<string, number>();
  if (!suppressChildren && structureRows && nextGroupField) {
    for (const row of structureRows) {
      const key =
        rowPathKey(row) ||
        (row[groupField!] == null ? "" : String(row[groupField!]));
      countByKey.set(key, Number(row[nextGroupField]) || 0);
    }
  }

  return jsonRows.map((row) => {
    const key = rowPathKey(row);
    const shaped: Record<string, unknown> = {};

    if (groupField) {
      shaped[groupField] = key === "" ? null : key;
      shaped.__ssrmGroupKey = key;
    } else {
      shaped.__ssrmGroupKey = "root";
    }

    shaped.childCount = suppressChildren ? 0 : (countByKey.get(key) ?? 0);

    for (const [field, value] of Object.entries(row)) {
      if (field === "__ROW_PATH__") continue;
      if (groupField && field === groupField) continue;
      if (
        isPivotResultField(field, valueCols) ||
        valueCols.some((v) => v.field === field)
      ) {
        shaped[field] = value;
      }
    }

    return shaped;
  });
}

export function dropPerspectiveTotalsRow(
  jsonRows: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (jsonRows.length === 0) return jsonRows;
  const first = jsonRows[0];
  const path = first.__ROW_PATH__;
  if (Array.isArray(path) && path.length === 0) {
    return jsonRows.slice(1);
  }
  return jsonRows;
}

export function collectPivotResultFields(
  columnPaths: string[],
  valueCols: SsrmGetRowsRequest["valueCols"],
): string[] {
  return columnPaths.filter((path) => isPivotResultField(path, valueCols));
}
