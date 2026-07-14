// Calculated (derived) columns are Perspective expression columns. They live in
// the dataset registry (populated at configure from the consumer's columnDefs),
// so the query engine can merge them into every view — which makes them fully
// groupable / aggregatable / sortable / filterable server-side, unlike a
// client-side valueGetter.
import { getDatasetMeta } from "./schemas";

/** name -> Perspective expression for the dataset's calculated columns. */
export function getCalculatedExpressions(dataset: string): Record<string, string> {
  return getDatasetMeta(dataset).calcExpressions;
}

export function getCalculatedColumnNames(dataset: string): string[] {
  return Object.keys(getDatasetMeta(dataset).calcExpressions);
}
