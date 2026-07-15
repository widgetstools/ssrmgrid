import type { ColDef, ColGroupDef } from "ag-grid-community";
import type { PerspectiveColumnType } from "../ssrm/types";

/**
 * A consumer ColDef, extended with the two SSRM-specific knobs. Everything else
 * is plain ag-grid and passes straight through to the inner grid.
 */
export interface SSRMColDef extends ColDef {
  /**
   * Perspective expression for a CALCULATED column (server-side). When set, the
   * column is computed inside Perspective (so it groups/aggregates/sorts/filters
   * server-side) rather than via a client valueGetter. `field` is the column name.
   */
  perspectiveExpression?: string;
  /** Explicit Perspective column type (else derived from cellDataType / sample). */
  perspectiveType?: PerspectiveColumnType;
  /** Column-group children — walked for Perspective schema extraction. */
  children?: SSRMColDef[];
}

export interface ColumnOverrideResult {
  /** column -> Perspective type for the real (non-calculated) columns. */
  schema: Record<string, PerspectiveColumnType>;
  /** calculated column name -> Perspective expression. */
  calcExpressions: Record<string, string>;
  /** the ColDefs actually handed to AgGridReact (set-filter values rewired). */
  agGridColumnDefs: ColDef[];
}

function typeFromCellDataType(cdt: unknown): PerspectiveColumnType | undefined {
  switch (cdt) {
    case "number":
      return "float";
    case "text":
      return "string";
    case "date":
      return "date";
    case "dateString":
      return "string";
    case "boolean":
      return "boolean";
    default:
      return undefined;
  }
}

function typeFromSample(value: unknown): PerspectiveColumnType | undefined {
  if (value === null || value === undefined) return undefined;
  // Perspective scalars only — skip arrays/objects (sparklines, nested payloads).
  if (typeof value === "object" && !(value instanceof Date)) return undefined;
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "datetime";
  if (typeof value === "string") return "string";
  return undefined;
}

function resolveType(
  def: SSRMColDef,
  sample: unknown,
): PerspectiveColumnType {
  return (
    def.perspectiveType ??
    typeFromCellDataType(def.cellDataType) ??
    typeFromSample(sample) ??
    "string"
  );
}

function isColGroup(
  def: SSRMColDef,
): def is SSRMColDef & ColGroupDef & { children: SSRMColDef[] } {
  return Array.isArray(def.children) && def.children.length > 0;
}

/**
 * Turn the consumer's columnDefs into (a) a Perspective schema + calc expressions
 * for the worker, and (b) the ColDefs the inner ag-grid gets. Pure and testable.
 *
 * Walks nested {@link ColGroupDef} children so fields like `assetClass` under
 * header groups still enter the Perspective schema (otherwise SSRM row-grouping
 * fails with `Invalid column 'assetClass'`).
 *
 * @param getFilterValues async provider of a column's distinct values, used to
 *   rewire `agSetColumnFilter` so set filters work under SSRM.
 */
export function buildColumnOverride(
  columnDefs: SSRMColDef[],
  opts: {
    index: string;
    sampleRow?: Record<string, unknown>;
    getFilterValues?: (field: string) => Promise<(string | null)[]>;
  },
): ColumnOverrideResult {
  const schema: Record<string, PerspectiveColumnType> = {};
  const calcExpressions: Record<string, string> = {};
  const sample = opts.sampleRow ?? {};

  const mapDef = (def: SSRMColDef): ColDef => {
    // Strip our two custom keys before handing the def to ag-grid.
    const { perspectiveExpression, perspectiveType, children, ...rest } = def;
    void perspectiveType;

    if (children?.length) {
      return {
        ...(rest as ColGroupDef),
        children: children.map(mapDef),
      } as ColDef;
    }

    const field = def.field;
    const agDef: ColDef = { ...rest };

    if (field && perspectiveExpression) {
      calcExpressions[field] = perspectiveExpression;
    } else if (field) {
      schema[field] = resolveType(def, sample[field]);
    }

    if (field && agDef.filter === "agSetColumnFilter" && opts.getFilterValues) {
      const getValues = opts.getFilterValues;
      agDef.filterParams = {
        ...(agDef.filterParams as object | undefined),
        suppressClearModelOnRefreshValues: true,
        values: (params: { success: (v: (string | null)[]) => void }) => {
          void getValues(field).then((vals) => params.success(vals));
        },
      };
    }

    return agDef;
  };

  const agGridColumnDefs = columnDefs.map(mapDef);

  // Safety net: any *scalar* field present on the sample row but missing from
  // ColDefs (e.g. grouping dims only applied via column-customization) still
  // needs a Perspective column or getRows fails with "Invalid column".
  // Skip arrays/objects — they are not Perspective column types and cause
  // "Cannot coerce array to string" on setRowData.
  for (const [key, value] of Object.entries(sample)) {
    if (key in schema || key in calcExpressions) continue;
    const t = typeFromSample(value);
    if (t) schema[key] = t;
  }

  // The index (getRowId) column must exist in the Perspective schema even if the
  // consumer didn't declare a ColDef for it.
  if (!(opts.index in schema) && !(opts.index in calcExpressions)) {
    schema[opts.index] = resolveType(
      { field: opts.index },
      sample[opts.index],
    );
  }

  return { schema, calcExpressions, agGridColumnDefs };
}

/** @internal exported for tests */
export function collectLeafFieldsForTest(columnDefs: SSRMColDef[]): string[] {
  const fields: string[] = [];
  const walk = (defs: SSRMColDef[]) => {
    for (const def of defs) {
      if (isColGroup(def)) walk(def.children);
      else if (def.field) fields.push(def.field);
    }
  };
  walk(columnDefs);
  return fields;
}
