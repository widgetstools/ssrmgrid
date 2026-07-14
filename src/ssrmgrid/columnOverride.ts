import type { ColDef } from "ag-grid-community";
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

function typeFromSample(value: unknown): PerspectiveColumnType {
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "datetime";
  return "string";
}

function resolveType(
  def: SSRMColDef,
  sample: unknown,
): PerspectiveColumnType {
  return (
    def.perspectiveType ??
    typeFromCellDataType(def.cellDataType) ??
    (sample === undefined || sample === null ? "string" : typeFromSample(sample))
  );
}

/**
 * Turn the consumer's columnDefs into (a) a Perspective schema + calc expressions
 * for the worker, and (b) the ColDefs the inner ag-grid gets. Pure and testable.
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
  const agGridColumnDefs: ColDef[] = [];
  const sample = opts.sampleRow ?? {};

  for (const def of columnDefs) {
    const field = def.field;
    // Strip our two custom keys before handing the def to ag-grid.
    const { perspectiveExpression, perspectiveType, ...agDef } = def;
    void perspectiveType;

    if (field && perspectiveExpression) {
      // Calculated column: computed in Perspective, not a real stored column.
      calcExpressions[field] = perspectiveExpression;
    } else if (field) {
      schema[field] = resolveType(def, sample[field]);
    }

    // Rewire a set filter to pull distinct values from Perspective (server-side).
    if (field && agDef.filter === "agSetColumnFilter" && opts.getFilterValues) {
      const getValues = opts.getFilterValues;
      agDef.filterParams = {
        ...(agDef.filterParams as object | undefined),
        values: (params: { success: (v: (string | null)[]) => void }) => {
          void getValues(field).then((vals) => params.success(vals));
        },
      };
    }

    agGridColumnDefs.push(agDef as ColDef);
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
