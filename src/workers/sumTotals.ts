import type { DatasetId, SsrmGetRowsRequest } from "../ssrm/types";

/** Default measure fields that need filtered aggregates for share / class rules. */
const DEFAULT_MEASURE_FIELDS: Record<DatasetId, string[]> = {
  // Live <SSRMGrid> dataset id.
  main: ["pnl", "notional", "notionalAmount", "marketValue", "quantity", "dailyPnl"],
  // Legacy spike / test dataset ids.
  positions: ["pnl", "notionalAmount", "marketValue", "quantity", "dailyPnl"],
  trades: ["notionalAmount", "quantity", "price"],
};

/** Aggregates resolved on every getRows for default measure fields. */
export const DEFAULT_AGG_FUNCS = ["sum", "avg", "min", "max", "count"] as const;

export type AggregateSpec = { field: string; aggFunc: string };

/**
 * Specs whose filtered aggregates must be resolved in the SSRM worker so
 * clients can evaluate col/agg(col) (any aggFunc) in formatters / class rules.
 */
export function collectAggregateSpecs(
  request: SsrmGetRowsRequest,
): AggregateSpec[] {
  const byKey = new Map<string, AggregateSpec>();
  const add = (field: string, aggFunc: string) => {
    if (!field) return;
    const func = aggFunc || "sum";
    byKey.set(`${field}::${func}`, { field, aggFunc: func });
  };

  for (const field of DEFAULT_MEASURE_FIELDS[request.dataset] ?? []) {
    for (const aggFunc of DEFAULT_AGG_FUNCS) {
      add(field, aggFunc);
    }
  }

  for (const col of request.valueCols ?? []) {
    if (!col.field) continue;
    add(col.field, col.aggFunc || "sum");
    // Always ensure sum exists for col/sum(col) share formatting.
    add(col.field, "sum");
  }

  return [...byKey.values()];
}

/** @deprecated use collectAggregateSpecs */
export function collectSumFields(request: SsrmGetRowsRequest): string[] {
  return [
    ...new Set(collectAggregateSpecs(request).map((s) => s.field)),
  ];
}

/** Synthetic Perspective column alias so one source field can have many aggs. */
export function aggregateAlias(field: string, aggFunc: string): string {
  const safe = aggFunc.replace(/[^a-zA-Z0-9]+/g, "_");
  return `__ssrm_agg_${field}_${safe}`;
}
