import type { ColDef, ColGroupDef } from "ag-grid-community";
import type { PerspectiveColumnType } from "../ssrm/types";
import {
  compileCellClassRuleExpression,
  compileCellStyleExpression,
  compileEditableExpression,
  compileExpression,
  resolveAggFuncName,
  tryCalculatedExpressionToPerspective,
  tryValueGetterToPerspective,
} from "../ssrm/compileColExpression";

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
  /**
   * String bodies accepted for CSRM-style tooling (compiled to functions for
   * loaded-row presentation). Prefer functions when authoring ColDefs directly.
   */
  editable?: ColDef["editable"] | string;
  cellStyle?: ColDef["cellStyle"] | string;
  valueGetter?: ColDef["valueGetter"] | string;
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

function normalizePresentationExprs(agDef: ColDef): void {
  if (typeof agDef.editable === "string") {
    agDef.editable = compileEditableExpression(agDef.editable) as ColDef["editable"];
  }

  if (typeof agDef.cellStyle === "string") {
    agDef.cellStyle = compileCellStyleExpression(
      agDef.cellStyle,
    ) as ColDef["cellStyle"];
  }

  if (agDef.cellClassRules && typeof agDef.cellClassRules === "object") {
    const rules = { ...agDef.cellClassRules };
    let changed = false;
    for (const [cls, rule] of Object.entries(rules)) {
      if (typeof rule === "string") {
        rules[cls] = compileCellClassRuleExpression(rule);
        changed = true;
      }
    }
    if (changed) agDef.cellClassRules = rules;
  }

  if (typeof agDef.valueGetter === "string") {
    const body = agDef.valueGetter;
    agDef.valueGetter = compileExpression(body) as ColDef["valueGetter"];
  }

  if (agDef.aggFunc != null && typeof agDef.aggFunc !== "string") {
    agDef.aggFunc = resolveAggFuncName(agDef.aggFunc);
  }
}

function resolvePerspectiveExpression(def: SSRMColDef): string | undefined {
  if (def.perspectiveExpression) return def.perspectiveExpression;

  if (typeof def.valueGetter === "string") {
    const fromGetter = tryValueGetterToPerspective(def.valueGetter);
    if (fromGetter) return fromGetter;
  }

  const calcExpr =
    typeof (def as { calculatedExpression?: unknown }).calculatedExpression ===
    "string"
      ? (def as { calculatedExpression: string }).calculatedExpression
      : undefined;
  if (calcExpr) {
    const fromCalc = tryCalculatedExpressionToPerspective(calcExpr);
    if (fromCalc) return fromCalc;
  }

  return undefined;
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
    void perspectiveExpression;

    if (children?.length) {
      return {
        ...(rest as ColGroupDef),
        children: children.map(mapDef),
      } as ColDef;
    }

    const field = def.field ?? (typeof def.colId === "string" ? def.colId : undefined);
    const agDef: ColDef = { ...rest };
    normalizePresentationExprs(agDef);

    const serverExpr = resolvePerspectiveExpression(def);
    if (field && serverExpr) {
      calcExpressions[field] = serverExpr;
      // Perspective owns the value for group/agg/sort/filter — drop client
      // recompute sources so AG Grid displays the server-provided field.
      if (!agDef.field) agDef.field = field;
      delete (agDef as { calculatedExpression?: string }).calculatedExpression;
      if (typeof def.valueGetter === "string") {
        delete agDef.valueGetter;
      }
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
