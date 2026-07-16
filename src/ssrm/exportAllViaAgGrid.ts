import {
  createGrid,
  type ColDef,
  type GridApi,
} from "ag-grid-community";

import type { createWorkerClient } from "./workerClient";
import type { DatasetId } from "./types";
import { buildQueryAllRequestFromApi } from "./readGridQueryState";

export type ExportFormat = "excel" | "csv";

/** Visible, field-backed columns from the live SSRM grid (export schema). */
export function getExportColumnDefs(api: GridApi): ColDef[] {
  return api
    .getAllDisplayedColumns()
    .map((col) => col.getColDef())
    .filter((def): def is ColDef & { field: string } => typeof def.field === "string")
    .map((def) => ({
      field: def.field,
      headerName: def.headerName ?? def.field,
      valueFormatter: def.valueFormatter,
      valueGetter: def.valueGetter,
    }));
}

/**
 * Fetch the full filtered set from Perspective (`queryAll`), including current
 * group/pivot structure when active, then use a short-lived CSRM grid so AG
 * Grid's Excel/CSV exporters own the file format.
 */
export async function exportAllViaAgGrid(options: {
  liveApi: GridApi;
  client: ReturnType<typeof createWorkerClient>;
  dataset: DatasetId;
  format: ExportFormat;
  fileName?: string;
  limit?: number;
  quickFilterText?: string;
  quickFilterFields?: string[];
  rowKeepExpression?: string;
  treeData?: boolean;
  absSort?: boolean;
}): Promise<{ rowCount: number }> {
  const {
    liveApi,
    client,
    dataset,
    format,
    limit = 50_000,
    quickFilterText,
    quickFilterFields,
    rowKeepExpression,
    treeData,
    absSort,
  } = options;
  const columnDefs = getExportColumnDefs(liveApi);

  const { rowData, rowCount } = await client.queryAll(
    buildQueryAllRequestFromApi(liveApi, {
      dataset,
      limit,
      quickFilterText,
      quickFilterFields,
      rowKeepExpression,
      treeData,
      absSort,
    }),
  );

  const host = document.createElement("div");
  host.setAttribute("data-agssrm-export-host", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:800px;height:400px;opacity:0;pointer-events:none;";
  document.body.appendChild(host);

  const fileName =
    options.fileName ??
    `${dataset}-all.${format === "excel" ? "xlsx" : "csv"}`;

  try {
    const exportApi = createGrid(host, {
      columnDefs:
        columnDefs.length > 0
          ? columnDefs
          : rowData[0]
            ? Object.keys(rowData[0]).map((field) => ({ field }))
            : [{ field: "empty" }],
      rowData,
      defaultColDef: { flex: 1, minWidth: 80 },
      suppressColumnVirtualisation: true,
      suppressRowVirtualisation: true,
    });

    try {
      if (format === "excel") {
        exportApi.exportDataAsExcel({ fileName });
      } else {
        exportApi.exportDataAsCsv({ fileName });
      }
    } finally {
      exportApi.destroy();
    }
  } finally {
    host.remove();
  }

  return { rowCount };
}
