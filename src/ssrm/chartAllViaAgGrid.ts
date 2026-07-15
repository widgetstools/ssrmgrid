import {
  createGrid,
  type ChartType,
  type ColDef,
  type GridApi,
} from "ag-grid-community";

import { getActiveFilterModel } from "./activeFilterModel";
import type { DatasetId } from "./types";
import type { createWorkerClient } from "./workerClient";

function readValueCols(api: GridApi): {
  id: string;
  field: string;
  aggFunc: string;
}[] {
  return api.getValueColumns().map((col) => {
    const def = col.getColDef();
    return {
      id: col.getColId(),
      field: def.field ?? col.getColId(),
      aggFunc: String(col.getAggFunc?.() ?? def.aggFunc ?? "sum"),
    };
  });
}

/**
 * Pick a category axis for a full-set chart: first row-group field, else first
 * string/category column, else the primary key.
 */
export function resolveChartCategoryField(
  api: GridApi,
  fallback?: string,
): string | undefined {
  const groupCols = api.getRowGroupColumns();
  const groupField = groupCols[0]?.getColDef().field;
  if (groupField) return groupField;

  for (const col of api.getAllDisplayedColumns()) {
    const def = col.getColDef();
    if (!def.field) continue;
    if (def.chartDataType === "category") return def.field;
    if (def.chartDataType === "series" || def.chartDataType === "excluded") {
      continue;
    }
    if (def.cellDataType === "number" || def.aggFunc) continue;
    return def.field;
  }
  return fallback;
}

/**
 * Fetch filtered aggregates by category via Perspective `getSeriesData`, then
 * open an AG Grid 36 range chart (unlinked) so the series covers the full
 * filtered set — not just loaded SSRM blocks.
 */
export async function chartAllViaAgGrid(options: {
  liveApi: GridApi;
  client: ReturnType<typeof createWorkerClient>;
  dataset: DatasetId;
  categoryField?: string;
  chartType?: ChartType;
  quickFilterText?: string;
  quickFilterFields?: string[];
  rowKeepExpression?: string;
  limit?: number;
}): Promise<{ rowCount: number; chartId?: string }> {
  const {
    liveApi,
    client,
    dataset,
    chartType = "groupedColumn",
    quickFilterText,
    quickFilterFields,
    rowKeepExpression,
    limit = 500,
  } = options;

  const categoryField =
    options.categoryField ?? resolveChartCategoryField(liveApi);
  if (!categoryField) {
    throw new Error("No category field available for full-set chart");
  }

  let valueCols = readValueCols(liveApi);
  if (valueCols.length === 0) {
    // Fall back to numeric displayed columns when nothing is in Values.
    valueCols = liveApi
      .getAllDisplayedColumns()
      .map((col) => {
        const def = col.getColDef();
        const field = def.field;
        if (!field || field === categoryField) return null;
        if (def.cellDataType !== "number" && def.chartDataType !== "series") {
          return null;
        }
        return {
          id: col.getColId(),
          field,
          aggFunc: String(def.aggFunc ?? "sum"),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c != null);
  }
  if (valueCols.length === 0) {
    throw new Error("No value columns available for full-set chart");
  }

  const filterModel = getActiveFilterModel(liveApi);
  const { rowData, rowCount } = await client.getSeriesData({
    dataset,
    categoryField,
    valueCols,
    filterModel,
    quickFilterText,
    quickFilterFields,
    rowKeepExpression,
    limit,
  });

  if (rowData.length === 0) {
    return { rowCount: 0 };
  }

  const columnDefs: ColDef[] = [
    { field: categoryField, chartDataType: "category" },
    ...valueCols.map((vc) => ({
      field: vc.field,
      chartDataType: "series" as const,
      aggFunc: vc.aggFunc,
    })),
  ];

  const host = document.createElement("div");
  host.setAttribute("data-agssrm-chart-host", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:800px;height:400px;opacity:0;pointer-events:none;";
  document.body.appendChild(host);

  try {
    const chartId = await new Promise<string | undefined>((resolve, reject) => {
      const chartApi = createGrid(host, {
        columnDefs,
        rowData,
        defaultColDef: { flex: 1, minWidth: 80 },
        enableCharts: true,
        cellSelection: true,
        suppressColumnVirtualisation: true,
        suppressRowVirtualisation: true,
        onFirstDataRendered: (e) => {
          try {
            const ref = e.api.createRangeChart({
              chartType,
              unlinkChart: true,
              cellRange: {
                columns: [categoryField, ...valueCols.map((v) => v.field)],
              },
            });
            resolve(ref?.chartId);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          } finally {
            // Chart is unlinked — safe to tear down the staging grid.
            queueMicrotask(() => chartApi.destroy());
          }
        },
      });
    });

    return { rowCount, chartId };
  } finally {
    host.remove();
  }
}
