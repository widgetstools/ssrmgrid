import perspective from "@finos/perspective";
import type { Client, Table } from "@finos/perspective";
import SERVER_WASM from "@finos/perspective/dist/wasm/perspective-server.wasm?url";
import CLIENT_WASM from "@finos/perspective/dist/wasm/perspective-js.wasm?url";
import SERVER_WORKER_URL from "@finos/perspective/dist/cdn/perspective-server.worker.js?url";

import { getDatasetPrimaryKey, getSchema } from "../data/schemas";
import { getCalculatedExpressions } from "../data/calculatedColumns";
import type {
  AggregateRequest,
  AggregateResult,
  DatasetId,
  DetailRowsRequest,
  QueryAllRequest,
  QueryAllResult,
  SeriesDataRequest,
  SeriesDataResult,
  SsrmGetRowsRequest,
  SsrmGetRowsResult,
  TransactionRequest,
} from "../ssrm/types";
import {
  mapFilterModel,
  mergeFilterPlans,
  quickFilterToPlan,
  rowKeepExpressionToPlan,
  type PerspectiveFilter,
} from "./ssrmFilters";
import { aggregateAlias, collectAggregateSpecs } from "./sumTotals";
import {
  foldTrafficLight,
  isTrafficLightAgg,
} from "../ssrm/trafficLightAgg";
import {
  applyClientSort,
  applyPostPredicate,
  collectPivotResultFields,
  dropPerspectiveTotalsRow,
  getCountAggField,
  getLeafColumns,
  getQuickFilterColumns,
  mapAggFunc,
  mapSsrmRequestToView,
  shapeGroupRows,
  shapeLeafRows,
  shapePivotRows,
  shapeTreeGroupRows,
  shapeTreeLeafRows,
} from "./ssrmQueryEngine";

/** Synthetic group_by so Perspective emits a grand-total `__ROW_PATH__` row. */
const AGG_ROOT_EXPR = "__ssrm_agg_root";

const AGG_CACHE_MAX = 8;

function aggregateCacheKey(request: AggregateRequest): string {
  const specs = request.valueCols
    .map((c) => `${c.field}:${c.aggFunc || "sum"}`)
    .sort()
    .join(",");
  return JSON.stringify({
    d: request.dataset,
    f: request.filterModel ?? {},
    q: request.quickFilterText ?? "",
    qf: request.quickFilterFields ?? [],
    k: request.rowKeepExpression ?? "",
    s: specs,
  });
}

export interface PerspectiveHost {
  ready: Promise<void>;
  replaceDataset(dataset: DatasetId, rows: Record<string, unknown>[]): Promise<number>;
  upsertRows(dataset: DatasetId, rows: Record<string, unknown>[]): Promise<void>;
  removeRows(dataset: DatasetId, ids: (string | number)[]): Promise<void>;
  applyTransaction(request: TransactionRequest): Promise<void>;
  query(request: SsrmGetRowsRequest): Promise<SsrmGetRowsResult>;
  getAggregates(request: AggregateRequest): Promise<AggregateResult>;
  queryAll(request: QueryAllRequest): Promise<QueryAllResult>;
  getSeriesData(request: SeriesDataRequest): Promise<SeriesDataResult>;
  getDetailRows(request: DetailRowsRequest): Promise<Record<string, unknown>[]>;
  getFilterValues(dataset: DatasetId, field: string): Promise<string[]>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

export interface PerspectiveHostOptions {
  /** Injected client for unit tests or main-thread fallback. */
  client?: Client;
  dataset?: DatasetId;
}

type TableInput = Parameters<Client["table"]>[0];

/** Map app schema types onto Perspective column types (native date for date fields). */
function toPerspectiveTableSchema(
  schema: Record<string, string>,
): TableInput {
  const mapped: Record<string, string> = {};
  for (const [key, type] of Object.entries(schema)) {
    // Perspective `date` accepts ISO `YYYY-MM-DD` strings from the flattener.
    mapped[key] = type;
  }
  return mapped as unknown as TableInput;
}

// Schema + index now come from the registry (registered per dataset at
// `configure` from the consumer's columnDefs), not hardcoded constants.
const datasetSchema = (dataset: DatasetId): Record<string, string> =>
  getSchema(dataset) as Record<string, string>;
const datasetIndex = (dataset: DatasetId): string => getDatasetPrimaryKey(dataset);

async function createClient(): Promise<Client> {
  perspective.init_server(fetch(SERVER_WASM));
  perspective.init_client(fetch(CLIENT_WASM));
  // perspective.worker() defaults use `window`, which is undefined inside a Vite
  // worker. Spawn the nested Perspective server worker explicitly instead.
  const nestedWorker = new Worker(SERVER_WORKER_URL, { type: "classic" });
  return perspective.worker(Promise.resolve(nestedWorker));
}

function pickTotalsRow(
  jsonRows: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  if (jsonRows.length === 0) return undefined;
  if (jsonRows.length === 1) return jsonRows[0];
  const totals = jsonRows.find((row) => {
    const path = row.__ROW_PATH__;
    return Array.isArray(path) && path.length === 0;
  });
  return totals ?? jsonRows[0];
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function aggregateFilteredRows(
  rows: Record<string, unknown>[],
  valueCols: AggregateRequest["valueCols"],
): AggregateResult {
  const aggregates: Record<string, Record<string, unknown>> = {};
  const totals: Record<string, unknown> = {};

  const setAgg = (field: string, aggFunc: string, value: unknown) => {
    if (!aggregates[field]) aggregates[field] = {};
    aggregates[field][aggFunc] = value;
    if (aggFunc === "sum") totals[field] = value;
  };

  for (const valueCol of valueCols) {
    const field = valueCol.field;
    if (!field) continue;
    const agg = mapAggFunc(valueCol.aggFunc);
    const rawAgg = valueCol.aggFunc || "sum";
    const nums = rows
      .map((row) => numberOrNull(row[field]))
      .filter((n): n is number => n != null);

    let value: unknown;
    switch (
      rawAgg === "weightedAvg"
        ? "weightedAvg"
        : isTrafficLightAgg(rawAgg)
          ? "trafficLight"
          : agg
    ) {
      case "sum":
        value = nums.reduce((acc, n) => acc + n, 0);
        break;
      case "avg":
        value =
          nums.length === 0
            ? null
            : nums.reduce((acc, n) => acc + n, 0) / nums.length;
        break;
      case "weightedAvg": {
        let weighted = 0;
        let weightSum = 0;
        for (const row of rows) {
          const v = numberOrNull(row[field]);
          const w = numberOrNull(row.quantity) ?? 0;
          if (v == null || w === 0) continue;
          weighted += v * w;
          weightSum += w;
        }
        value = weightSum === 0 ? null : weighted / weightSum;
        break;
      }
      case "count":
        value = rows.filter((row) => row[field] != null).length;
        break;
      case "min":
        value = nums.length === 0 ? null : Math.min(...nums);
        break;
      case "max":
        value = nums.length === 0 ? null : Math.max(...nums);
        break;
      case "trafficLight":
      case "rag": {
        value =
          nums.length === 0
            ? null
            : foldTrafficLight(Math.min(...nums), Math.max(...nums));
        break;
      }
      case "first":
        value = rows[0]?.[field] ?? null;
        break;
      case "last":
      case "last by index":
        value = rows[rows.length - 1]?.[field] ?? null;
        break;
      case "median": {
        if (nums.length === 0) {
          value = null;
          break;
        }
        const sorted = [...nums].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        value =
          sorted.length % 2 === 0
            ? (sorted[mid - 1]! + sorted[mid]!) / 2
            : sorted[mid]!;
        break;
      }
      case "stddev": {
        if (nums.length < 2) {
          value = null;
          break;
        }
        const mean = nums.reduce((a, n) => a + n, 0) / nums.length;
        const variance =
          nums.reduce((a, n) => a + (n - mean) ** 2, 0) / (nums.length - 1);
        value = Math.sqrt(variance);
        break;
      }
      case "var": {
        if (nums.length < 2) {
          value = null;
          break;
        }
        const mean = nums.reduce((a, n) => a + n, 0) / nums.length;
        value =
          nums.reduce((a, n) => a + (n - mean) ** 2, 0) / (nums.length - 1);
        break;
      }
      case "distinct count": {
        const set = new Set(rows.map((row) => String(row[field])));
        value = set.size;
        break;
      }
      default:
        value = nums.reduce((acc, n) => acc + n, 0);
        break;
    }
    setAgg(field, rawAgg, value);
  }
  return { totals, aggregates, rowCount: rows.length };
}

export function createPerspectiveHost(
  options: PerspectiveHostOptions = {},
): PerspectiveHost {
  let activeDataset: DatasetId = options.dataset ?? "main";
  let client: Client | null = options.client ?? null;
  const tables = new Map<DatasetId, Table>();
  /** Short-lived filtered-aggregate results shared across SSRM blocks in one refresh. */
  const aggregateCache = new Map<string, AggregateResult>();

  const invalidateAggregateCache = (): void => {
    aggregateCache.clear();
  };

  const rememberAggregate = (key: string, result: AggregateResult): void => {
    if (aggregateCache.size >= AGG_CACHE_MAX) {
      const oldest = aggregateCache.keys().next().value;
      if (oldest !== undefined) aggregateCache.delete(oldest);
    }
    aggregateCache.set(key, result);
  };

  const ready = (async () => {
    if (!client) {
      client = await createClient();
    }
  })();

  async function ensureClient(): Promise<Client> {
    await ready;
    return client!;
  }

  async function ensureTable(dataset: DatasetId): Promise<Table> {
    const c = await ensureClient();
    const existing = tables.get(dataset);
    if (existing) {
      return existing;
    }

    const table = await c.table(toPerspectiveTableSchema(datasetSchema(dataset)), {
      index: datasetIndex(dataset),
      name: dataset,
    });
    tables.set(dataset, table);
    return table;
  }

  const host: PerspectiveHost = {
    ready,

    async replaceDataset(
      dataset: DatasetId,
      rows: Record<string, unknown>[],
    ): Promise<number> {
      invalidateAggregateCache();
      const c = await ensureClient();
      activeDataset = dataset;

      const existing = tables.get(dataset);
      if (existing) {
        if (rows.length > 0) {
          await existing.replace(rows);
        } else {
          await existing.clear();
        }
        return Number(await existing.size());
      }

      const table =
        rows.length > 0
          ? await c.table(rows, {
              index: datasetIndex(dataset),
              name: dataset,
            })
          : await c.table(toPerspectiveTableSchema(datasetSchema(dataset)), {
              index: datasetIndex(dataset),
              name: dataset,
            });
      tables.set(dataset, table);
      return Number(await table.size());
    },

    async upsertRows(
      dataset: DatasetId,
      rows: Record<string, unknown>[],
    ): Promise<void> {
      invalidateAggregateCache();
      activeDataset = dataset;
      const table = await ensureTable(dataset);
      await table.update(rows);
    },

    async removeRows(
      dataset: DatasetId,
      ids: (string | number)[],
    ): Promise<void> {
      if (ids.length === 0) return;
      invalidateAggregateCache();
      activeDataset = dataset;
      const table = await ensureTable(dataset);
      await table.remove(ids);
    },

    async applyTransaction(request: TransactionRequest): Promise<void> {
      invalidateAggregateCache();
      const { dataset, add, update, remove } = request;
      activeDataset = dataset;
      const table = await ensureTable(dataset);

      if (remove && remove.length > 0) {
        await table.remove(remove);
      }

      const upserts = [...(add ?? []), ...(update ?? [])];
      if (upserts.length > 0) {
        await table.update(upserts);
      }
    },

    async query(request: SsrmGetRowsRequest): Promise<SsrmGetRowsResult> {
      const dataset = request.dataset;
      const table = await ensureTable(dataset);
      const countField = getCountAggField(dataset);
      const mapped = mapSsrmRequestToView(request, countField, dataset);

      const attachFilteredAggregates = async (
        result: SsrmGetRowsResult,
        opts?: { force?: boolean },
      ): Promise<SsrmGetRowsResult> => {
        // Nested group/leaf block fetches pay a full second aggregate query.
        // Skip unless forced — root pages still attach for share-of-total /
        // grandTotal; SSRMGrid refreshTotals covers status-bar sums.
        const nestedUnderGroups = (request.groupKeys?.length ?? 0) > 0;
        if (nestedUnderGroups && !opts?.force) return result;

        const specs = collectAggregateSpecs(request);
        if (specs.length === 0) return result;
        try {
          const agg = await host.getAggregates({
            dataset,
            filterModel: request.filterModel,
            quickFilterText: request.quickFilterText,
            quickFilterFields: request.quickFilterFields,
            valueCols: specs.map((s) => ({
              id: `${s.field}:${s.aggFunc}`,
              field: s.field,
              aggFunc: s.aggFunc,
            })),
          });
          const aggregates = agg.aggregates;
          const totals = agg.totals;
          return {
            ...result,
            totals,
            aggregates,
            filteredRowCount: agg.rowCount,
            rowData: result.rowData.map((row) => ({
              ...row,
              __ssrm_aggs: aggregates,
              __ssrm_sums: totals,
            })),
          };
        } catch {
          return result;
        }
      };

      if (mapped.empty) {
        return attachFilteredAggregates({
          rowData: [],
          rowCount: 0,
          pivotResultFields: [],
        });
      }

      const view = await table.view(mapped.viewConfig);
      let structureView: Awaited<ReturnType<Table["view"]>> | null = null;
      try {
        const isGrouped =
          mapped.mode === "group" ||
          (mapped.mode === "tree" && Boolean(mapped.groupField)) ||
          (mapped.mode === "pivot" &&
            (mapped.viewConfig.group_by?.length ?? 0) > 0);

        const needsFullMaterialize =
          mapped.mode === "pivot" ||
          Boolean(mapped.postPredicate) ||
          Boolean(mapped.clientSort?.length);

        // When Perspective already applied filter+sort, window via to_json so
        // SSRM blocks don't pull the entire matching view into the worker.
        if (!needsFullMaterialize) {
          const rawCount = Number(await view.num_rows());
          // Perspective emits a leading grand-total row (empty __ROW_PATH__) for
          // group_by views — offset the window so startRow indexes logical groups.
          const rowOffset = isGrouped ? 1 : 0;
          const baseCount = Math.max(rawCount - rowOffset, 0);
          const window = {
            start_row: mapped.startRow + rowOffset,
            end_row: mapped.endRow + rowOffset,
            start_col: null,
            end_col: null,
            id: null,
            index: null,
            leaves_only: null,
            formatted: null,
            compression: null,
          };
          const jsonRows = (await view.to_json(window)) as Record<
            string,
            unknown
          >[];

          let rowData =
            mapped.mode === "group" && mapped.groupField
              ? shapeGroupRows(
                  jsonRows,
                  mapped.groupField,
                  request.valueCols,
                  countField,
                )
              : mapped.mode === "tree" && mapped.groupField
                ? shapeTreeGroupRows(
                    jsonRows,
                    mapped.groupField,
                    request.valueCols,
                    countField,
                  )
                : mapped.mode === "tree"
                  ? shapeTreeLeafRows(jsonRows, getDatasetPrimaryKey(dataset))
                  : shapeLeafRows(jsonRows);

          return attachFilteredAggregates({
            rowData,
            rowCount: baseCount,
          });
        }

        // Always fetch the full view result; pagination happens after shaping /
        // postPredicate / clientSort so start/end never truncate before filter.
        const rawCount = Number(await view.num_rows());
        let jsonRows = (await view.to_json()) as Record<string, unknown>[];

        if (isGrouped) {
          jsonRows = dropPerspectiveTotalsRow(jsonRows);
        }

        const baseCount = isGrouped ? Math.max(rawCount - 1, 0) : rawCount;

        let pivotResultFields: string[] | undefined;
        if (mapped.mode === "pivot") {
          let structureRows: Record<string, unknown>[] | undefined;
          if (mapped.structureViewConfig) {
            structureView = await table.view(mapped.structureViewConfig);
            structureRows = dropPerspectiveTotalsRow(
              (await structureView.to_json()) as Record<string, unknown>[],
            );
          }

          let rowData = shapePivotRows(jsonRows, {
            groupField: mapped.groupField,
            valueCols: request.valueCols,
            suppressChildren: mapped.suppressChildren,
            structureRows,
            nextGroupField: mapped.nextGroupField,
          });

          if (mapped.postPredicate) {
            rowData = applyPostPredicate(rowData, mapped.postPredicate);
            rowData = applyClientSort(rowData, mapped.clientSort);
            const rowCount = rowData.length;
            rowData = rowData.slice(mapped.startRow, mapped.endRow);
            const columnPaths = (await view.column_paths()) as string[];
            pivotResultFields =
              (request.pivotCols?.length ?? 0) > 0
                ? collectPivotResultFields(columnPaths, request.valueCols)
                : undefined;
            return attachFilteredAggregates({
              rowData,
              rowCount,
              ...(pivotResultFields ? { pivotResultFields } : {}),
            });
          }

          rowData = applyClientSort(rowData, mapped.clientSort);
          const rowCount = rowData.length;
          rowData = rowData.slice(mapped.startRow, mapped.endRow);

          const columnPaths = (await view.column_paths()) as string[];
          pivotResultFields =
            (request.pivotCols?.length ?? 0) > 0
              ? collectPivotResultFields(columnPaths, request.valueCols)
              : undefined;

          return attachFilteredAggregates({
            rowData,
            rowCount,
            ...(pivotResultFields ? { pivotResultFields } : {}),
          });
        }

        let rowData =
          mapped.mode === "group" && mapped.groupField
            ? shapeGroupRows(
                jsonRows,
                mapped.groupField,
                request.valueCols,
                countField,
              )
            : mapped.mode === "tree" && mapped.groupField
              ? shapeTreeGroupRows(
                  jsonRows,
                  mapped.groupField,
                  request.valueCols,
                  countField,
                )
              : mapped.mode === "tree"
                ? shapeTreeLeafRows(jsonRows, getDatasetPrimaryKey(dataset))
                : shapeLeafRows(jsonRows);

        if (mapped.postPredicate) {
          rowData = applyPostPredicate(rowData, mapped.postPredicate);
          rowData = applyClientSort(rowData, mapped.clientSort);
          const rowCount = rowData.length;
          return attachFilteredAggregates({
            rowData: rowData.slice(mapped.startRow, mapped.endRow),
            rowCount,
          });
        }

        if (mapped.clientSort?.length) {
          rowData = applyClientSort(rowData, mapped.clientSort);
          const rowCount = rowData.length;
          return attachFilteredAggregates({
            rowData: rowData.slice(mapped.startRow, mapped.endRow),
            rowCount,
          });
        }

        return attachFilteredAggregates({
          rowData: rowData.slice(mapped.startRow, mapped.endRow),
          rowCount: baseCount,
        });
      } finally {
        await view.delete();
        if (structureView) {
          await structureView.delete();
        }
      }
    },

    async getAggregates(request: AggregateRequest): Promise<AggregateResult> {
      const cacheKey = aggregateCacheKey(request);
      const cached = aggregateCache.get(cacheKey);
      if (cached) return cached;

      const dataset = request.dataset;
      const table = await ensureTable(dataset);
      const countField = getCountAggField(dataset);
      const valueCols = request.valueCols.filter(
        (col) => typeof col.field === "string" && col.field.length > 0,
      );
      const plan = mergeFilterPlans(
        [
          mapFilterModel(request.filterModel),
          quickFilterToPlan(
            request.quickFilterText,
            getQuickFilterColumns(dataset, request.quickFilterFields),
          ),
          rowKeepExpressionToPlan(request.rowKeepExpression),
        ],
        "and",
      );

      const needsClientAgg =
        Boolean(plan.postPredicate) ||
        valueCols.some((c) => c.aggFunc === "weightedAvg");

      // When Perspective cannot express the full filter / weighted avg, aggregate after fetch.
      if (needsClientAgg) {
        const leafColumns = getLeafColumns(dataset);
        const view = await table.view({
          columns: leafColumns,
          filter: plan.filters,
          filter_op: plan.filterOp,
          expressions: plan.expressions,
        });
        try {
          let rows = shapeLeafRows(
            (await view.to_json()) as Record<string, unknown>[],
          );
          rows = applyPostPredicate(rows, plan.postPredicate);
          const result = aggregateFilteredRows(rows, valueCols);
          rememberAggregate(cacheKey, result);
          return result;
        } finally {
          await view.delete();
        }
      }

      // One Perspective aggregate slot per (field, aggFunc) via synthetic aliases
      // so the same column can contribute sum + avg + min + … in one view.
      const perspectiveAggregates: Record<string, string> = {
        [countField]: "count",
        [AGG_ROOT_EXPR]: "any",
      };
      const columns: string[] = [countField];
      const exprMap: Record<string, string> = {
        [AGG_ROOT_EXPR]: "1",
        // Calc columns are Perspective expressions — define them so a value col
        // that IS a calc column (e.g. pnlBps) can be referenced/aggregated here.
        ...getCalculatedExpressions(dataset),
        ...plan.expressions,
      };
      const aliasBySpec: Array<{
        field: string;
        aggFunc: string;
        alias: string;
      }> = [];

      for (const valueCol of valueCols) {
        const field = valueCol.field;
        if (!field) continue;
        const rawAgg = valueCol.aggFunc || "sum";

        if (isTrafficLightAgg(rawAgg)) {
          const minAlias = aggregateAlias(field, "min");
          const maxAlias = aggregateAlias(field, "max");
          const calcs = getCalculatedExpressions(dataset);
          const sourceExpr = calcs[field] ?? `"${field}"`;
          aliasBySpec.push(
            { field, aggFunc: "min", alias: minAlias },
            { field, aggFunc: "max", alias: maxAlias },
          );
          exprMap[minAlias] = sourceExpr;
          exprMap[maxAlias] = sourceExpr;
          perspectiveAggregates[minAlias] = "min";
          perspectiveAggregates[maxAlias] = "max";
          if (!columns.includes(minAlias)) columns.push(minAlias);
          if (!columns.includes(maxAlias)) columns.push(maxAlias);
          continue;
        }

        const aggFunc = rawAgg;
        const alias = aggregateAlias(field, aggFunc);
        aliasBySpec.push({
          field,
          aggFunc,
          alias,
        });
        exprMap[alias] = `"${field}"`;
        perspectiveAggregates[alias] = mapAggFunc(aggFunc);
        if (!columns.includes(alias)) columns.push(alias);
      }

      const view = await table.view({
        expressions: exprMap,
        group_by: [AGG_ROOT_EXPR],
        columns: [...columns, ...Object.keys(plan.expressions ?? {})],
        aggregates: perspectiveAggregates,
        filter: plan.filters,
        filter_op: plan.filterOp,
      });
      try {
        const jsonRows = (await view.to_json()) as Record<string, unknown>[];
        const totalsRow = pickTotalsRow(jsonRows);
        const aggregates: Record<string, Record<string, unknown>> = {};
        const totals: Record<string, unknown> = {};
        for (const { field, aggFunc, alias } of aliasBySpec) {
          if (!aggregates[field]) aggregates[field] = {};
          const value = totalsRow?.[alias] ?? null;
          aggregates[field][aggFunc] = value;
          if (aggFunc === "sum") totals[field] = value;
        }
        for (const valueCol of valueCols) {
          const field = valueCol.field;
          const rawAgg = valueCol.aggFunc || "sum";
          if (!field || !isTrafficLightAgg(rawAgg)) continue;
          if (!aggregates[field]) aggregates[field] = {};
          aggregates[field][rawAgg] = foldTrafficLight(
            aggregates[field]["min"],
            aggregates[field]["max"],
          );
        }
        const result: AggregateResult = {
          totals,
          aggregates,
          rowCount: Number(totalsRow?.[countField]) || 0,
        };
        rememberAggregate(cacheKey, result);
        return result;
      } finally {
        await view.delete();
      }
    },

    async queryAll(request: QueryAllRequest): Promise<QueryAllResult> {
      const uncapped = request.limit === null;
      const limit = uncapped ? undefined : (request.limit ?? 50_000);
      const countField = getCountAggField(request.dataset);
      const includeStructure = Boolean(request.includeStructure);
      const table = await ensureTable(request.dataset);
      const endRow = uncapped ? Number(await table.size()) : (limit as number);
      const mapped = mapSsrmRequestToView(
        {
          dataset: request.dataset,
          startRow: 0,
          endRow,
          rowGroupCols: includeStructure ? (request.rowGroupCols ?? []) : [],
          valueCols: includeStructure ? (request.valueCols ?? []) : [],
          pivotCols: includeStructure ? (request.pivotCols ?? []) : [],
          pivotMode: includeStructure ? Boolean(request.pivotMode) : false,
          groupKeys: includeStructure ? (request.groupKeys ?? []) : [],
          filterModel: request.filterModel,
          sortModel: request.sortModel,
          quickFilterText: request.quickFilterText,
          quickFilterFields: request.quickFilterFields,
          treeData: includeStructure ? request.treeData : false,
          absSort: request.absSort,
        },
        countField,
        request.dataset,
      );
      const view = await table.view(mapped.viewConfig);
      let structureView: Awaited<ReturnType<Table["view"]>> | null = null;
      try {
        let jsonRows = (await view.to_json()) as Record<string, unknown>[];
        const isGrouped =
          mapped.mode === "group" ||
          (mapped.mode === "tree" && Boolean(mapped.groupField)) ||
          (mapped.mode === "pivot" &&
            (mapped.viewConfig.group_by?.length ?? 0) > 0);

        if (isGrouped) {
          jsonRows = dropPerspectiveTotalsRow(jsonRows);
        }

        let pivotResultFields: string[] | undefined;
        let rowData: Record<string, unknown>[];

        if (mapped.mode === "pivot") {
          let structureRows: Record<string, unknown>[] | undefined;
          if (mapped.structureViewConfig) {
            structureView = await table.view(mapped.structureViewConfig);
            structureRows = dropPerspectiveTotalsRow(
              (await structureView.to_json()) as Record<string, unknown>[],
            );
          }
          rowData = shapePivotRows(jsonRows, {
            groupField: mapped.groupField,
            valueCols: request.valueCols ?? [],
            suppressChildren: mapped.suppressChildren,
            structureRows,
            nextGroupField: mapped.nextGroupField,
          });
          const columnPaths = (await view.column_paths()) as string[];
          pivotResultFields =
            (request.pivotCols?.length ?? 0) > 0
              ? collectPivotResultFields(columnPaths, request.valueCols ?? [])
              : undefined;
        } else if (
          (mapped.mode === "group" || mapped.mode === "tree") &&
          mapped.groupField
        ) {
          rowData =
            mapped.mode === "tree"
              ? shapeTreeGroupRows(
                  jsonRows,
                  mapped.groupField,
                  request.valueCols ?? [],
                  countField,
                )
              : shapeGroupRows(
                  jsonRows,
                  mapped.groupField,
                  request.valueCols ?? [],
                  countField,
                );
        } else if (mapped.mode === "tree") {
          rowData = shapeTreeLeafRows(
            jsonRows,
            getDatasetPrimaryKey(request.dataset),
          );
        } else {
          rowData = shapeLeafRows(jsonRows);
        }

        rowData = applyPostPredicate(rowData, mapped.postPredicate);
        rowData = applyClientSort(rowData, mapped.clientSort);
        const rowCount = rowData.length;
        return {
          rowData: limit == null ? rowData : rowData.slice(0, limit),
          rowCount,
          ...(pivotResultFields ? { pivotResultFields } : {}),
        };
      } finally {
        await view.delete();
        if (structureView) {
          await structureView.delete();
        }
      }
    },

    async getSeriesData(request: SeriesDataRequest): Promise<SeriesDataResult> {
      const dataset = request.dataset;
      const table = await ensureTable(dataset);
      const limit = request.limit ?? 500;
      const valueCols = request.valueCols.filter(
        (col) => typeof col.field === "string" && col.field.length > 0,
      );
      const plan = mergeFilterPlans(
        [
          mapFilterModel(request.filterModel),
          quickFilterToPlan(
            request.quickFilterText,
            getQuickFilterColumns(dataset, request.quickFilterFields),
          ),
          rowKeepExpressionToPlan(request.rowKeepExpression),
        ],
        "and",
      );

      const categoryField = request.categoryField;
      const aggregates: Record<string, string> = {
        [categoryField]: "any",
      };
      const columns: string[] = [categoryField];
      for (const valueCol of valueCols) {
        aggregates[valueCol.field] = mapAggFunc(valueCol.aggFunc);
        if (!columns.includes(valueCol.field)) {
          columns.push(valueCol.field);
        }
      }

      if (
        plan.postPredicate ||
        valueCols.some(
          (c) => c.aggFunc === "weightedAvg" || isTrafficLightAgg(c.aggFunc),
        )
      ) {
        const leafColumns = getLeafColumns(dataset);
        const view = await table.view({
          columns: leafColumns,
          filter: plan.filters,
          filter_op: plan.filterOp,
          expressions: plan.expressions,
        });
        try {
          let rows = shapeLeafRows(
            (await view.to_json()) as Record<string, unknown>[],
          );
          rows = applyPostPredicate(rows, plan.postPredicate);
          const byCat = new Map<string, Record<string, unknown>[]>();
          for (const row of rows) {
            const key = row[categoryField] == null ? "" : String(row[categoryField]);
            const list = byCat.get(key) ?? [];
            list.push(row);
            byCat.set(key, list);
          }
          const series: Record<string, unknown>[] = [];
          for (const [cat, groupRows] of byCat) {
            const agg = aggregateFilteredRows(groupRows, valueCols);
            series.push({ [categoryField]: cat || null, ...agg.totals });
          }
          series.sort((a, b) =>
            String(a[categoryField] ?? "").localeCompare(
              String(b[categoryField] ?? ""),
            ),
          );
          return {
            rowData: series.slice(0, limit),
            rowCount: series.length,
          };
        } finally {
          await view.delete();
        }
      }

      const view = await table.view({
        group_by: [categoryField],
        columns: [...columns, ...Object.keys(plan.expressions ?? {})],
        aggregates,
        filter: plan.filters,
        filter_op: plan.filterOp,
        expressions: plan.expressions,
      });
      try {
        let jsonRows = dropPerspectiveTotalsRow(
          (await view.to_json()) as Record<string, unknown>[],
        );
        jsonRows = jsonRows.map((row) => {
          const path = row.__ROW_PATH__;
          const key =
            Array.isArray(path) && path.length > 0
              ? path[path.length - 1]
              : row[categoryField];
          const shaped: Record<string, unknown> = {
            [categoryField]: key ?? null,
          };
          for (const valueCol of valueCols) {
            shaped[valueCol.field] = row[valueCol.field];
          }
          return shaped;
        });
        return {
          rowData: jsonRows.slice(0, limit),
          rowCount: jsonRows.length,
        };
      } finally {
        await view.delete();
      }
    },

    async getDetailRows(
      request: DetailRowsRequest,
    ): Promise<Record<string, unknown>[]> {
      const table = await ensureTable(request.dataset);
      const leafColumns = getLeafColumns(request.dataset);
      const filters: PerspectiveFilter[] = [];
      for (const [field, value] of Object.entries(request.match)) {
        filters.push([field, "==", value]);
      }
      const limit = request.limit ?? 500;

      const view = await table.view({
        columns: leafColumns,
        ...(filters.length > 0 ? { filter: filters } : {}),
      });
      try {
        const rows = (await view.to_json()) as Record<string, unknown>[];
        return rows.slice(0, limit);
      } finally {
        await view.delete();
      }
    },

    async getFilterValues(dataset: DatasetId, field: string): Promise<string[]> {
      const table = await ensureTable(dataset);
      const schema = datasetSchema(dataset);
      if (!(field in schema)) {
        return [];
      }

      const view = await table.view({
        group_by: [field],
        columns: [field],
        aggregates: { [field]: "any" },
      });
      try {
        let jsonRows = (await view.to_json()) as Record<string, unknown>[];
        if (jsonRows.length > 0) {
          jsonRows = dropPerspectiveTotalsRow(jsonRows);
        }
        const values = jsonRows
          .map((row) => row[field])
          .filter((v): v is string | number => v != null)
          .map((v) => String(v));
        values.sort((a, b) => a.localeCompare(b));
        return values;
      } finally {
        await view.delete();
      }
    },

    async clear(): Promise<void> {
      invalidateAggregateCache();
      await ensureClient();
      for (const table of tables.values()) {
        await table.delete();
      }
      tables.clear();
    },

    async size(): Promise<number> {
      const table = await ensureTable(activeDataset);
      return Number(await table.size());
    },
  };
  return host;
}
