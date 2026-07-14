/**
 * Helpers for col/agg(col) once SSRM has resolved filtered aggregates.
 * Values come from getRows: `result.aggregates` / row `__ssrm_aggs`
 * (plus legacy `totals` / `__ssrm_sums` for sum-only).
 */

export type SsrmSums = Record<string, unknown>;
export type SsrmAggregates = Record<string, Record<string, unknown>>;

export function getRowAggregates(
  data?: Record<string, unknown>,
  context?: { aggregates?: SsrmAggregates; totals?: SsrmSums },
): SsrmAggregates | undefined {
  if (data?.__ssrm_aggs && typeof data.__ssrm_aggs === "object") {
    return data.__ssrm_aggs as SsrmAggregates;
  }
  return context?.aggregates;
}

/** Resolve a single filtered aggregate from SSRM stamps / context. */
export function resolveAggregate(
  field: string,
  aggFunc: string,
  data?: Record<string, unknown>,
  context?: { aggregates?: SsrmAggregates; totals?: SsrmSums },
): unknown {
  const nested = getRowAggregates(data, context)?.[field]?.[aggFunc];
  if (nested !== undefined) return nested;

  // Legacy sum-only path.
  if (aggFunc === "sum") {
    if (data?.__ssrm_sums && typeof data.__ssrm_sums === "object") {
      return (data.__ssrm_sums as SsrmSums)[field];
    }
    return context?.totals?.[field];
  }
  return undefined;
}

export function getRowSums(
  data: Record<string, unknown> | undefined,
  context?: { totals?: SsrmSums; aggregates?: SsrmAggregates },
): SsrmSums | undefined {
  if (data?.__ssrm_sums && typeof data.__ssrm_sums === "object") {
    return data.__ssrm_sums as SsrmSums;
  }
  if (context?.totals) return context.totals;

  const aggs = getRowAggregates(data, context);
  if (!aggs) return undefined;
  const sums: SsrmSums = {};
  for (const [field, byFunc] of Object.entries(aggs)) {
    if (byFunc.sum !== undefined) sums[field] = byFunc.sum;
  }
  return Object.keys(sums).length > 0 ? sums : undefined;
}

/** value / agg(field) using server-resolved filtered aggregates. */
export function shareOfAggregate(
  value: unknown,
  field: string,
  aggFunc: string,
  data?: Record<string, unknown>,
  context?: { aggregates?: SsrmAggregates; totals?: SsrmSums },
): number | null {
  const denom = resolveAggregate(field, aggFunc, data, context);
  const n = typeof value === "number" ? value : Number(value);
  const d = typeof denom === "number" ? denom : Number(denom);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

/** value / sum(field) — common case of shareOfAggregate(..., "sum"). */
export function shareOfTotal(
  value: unknown,
  field: string,
  data?: Record<string, unknown>,
  context?: { totals?: SsrmSums; aggregates?: SsrmAggregates },
): number | null {
  return shareOfAggregate(value, field, "sum", data, context);
}

export function formatShareOfTotal(
  value: unknown,
  field: string,
  params: {
    data?: Record<string, unknown>;
    context?: { totals?: SsrmSums; aggregates?: SsrmAggregates };
  },
  digits = 2,
): string {
  const share = shareOfTotal(value, field, params.data, params.context);
  if (share == null) return "";
  return `${(share * 100).toFixed(digits)}%`;
}

export function formatShareOfAggregate(
  value: unknown,
  field: string,
  aggFunc: string,
  params: {
    data?: Record<string, unknown>;
    context?: { aggregates?: SsrmAggregates; totals?: SsrmSums };
  },
  digits = 2,
): string {
  const share = shareOfAggregate(
    value,
    field,
    aggFunc,
    params.data,
    params.context,
  );
  if (share == null) return "";
  return `${(share * 100).toFixed(digits)}%`;
}

/** CSS rule helper: true when col/agg(col) exceeds threshold. */
export function shareExceeds(
  value: unknown,
  field: string,
  threshold: number,
  params: {
    data?: Record<string, unknown>;
    context?: { totals?: SsrmSums; aggregates?: SsrmAggregates };
  },
  aggFunc = "sum",
): boolean {
  const share = shareOfAggregate(
    value,
    field,
    aggFunc,
    params.data,
    params.context,
  );
  return share != null && share > threshold;
}
