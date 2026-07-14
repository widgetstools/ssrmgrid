// Generic dataset registry (SSRMGrid). The worker no longer hardcodes
// positions/trades schemas — the <SSRMGrid> component derives a schema + index
// (+ calculated-column expressions + optional tree hierarchy) from the consumer's
// columnDefs/rowData and sends it in the `configure` message. Everything on the
// worker side reads the active dataset's shape from this registry. It's a plain
// module singleton, which is safe because the whole worker is single-threaded.

export type SchemaType =
  | "string"
  | "float"
  | "integer"
  | "date"
  | "datetime"
  | "boolean";

export interface DatasetMeta {
  /** column -> Perspective type; the Perspective table is created from this. */
  schema: Record<string, SchemaType>;
  /** primary-key column: Perspective table `index` AND ag-grid `getRowId`. */
  index: string;
  /** Perspective expression columns: name -> expression (calculated columns). */
  calcExpressions: Record<string, string>;
  /** Optional tree-data hierarchy fields (outer -> inner). */
  treeFields: string[];
}

const REGISTRY = new Map<string, DatasetMeta>();

export function registerDataset(
  dataset: string,
  meta: {
    schema: Record<string, SchemaType>;
    index: string;
    calcExpressions?: Record<string, string>;
    treeFields?: string[];
  },
): void {
  REGISTRY.set(dataset, {
    schema: meta.schema,
    index: meta.index,
    calcExpressions: meta.calcExpressions ?? {},
    treeFields: meta.treeFields ?? [],
  });
}

export function getDatasetMeta(dataset: string): DatasetMeta {
  return (
    REGISTRY.get(dataset) ?? {
      schema: {},
      index: "id",
      calcExpressions: {},
      treeFields: [],
    }
  );
}

export function getSchema(dataset: string): Record<string, SchemaType> {
  return getDatasetMeta(dataset).schema;
}

/** Unique / primary key field for a dataset (Perspective index + getRowId). */
export function getDatasetPrimaryKey(dataset: string): string {
  return getDatasetMeta(dataset).index;
}
