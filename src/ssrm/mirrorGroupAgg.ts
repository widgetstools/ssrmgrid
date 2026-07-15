import { foldTrafficLight, isTrafficLightAgg } from "./trafficLightAgg";

export type MirrorValueCol = {
  id: string;
  field: string;
  aggFunc: string;
};

/** AG Grid auto-group column id when sorting group headers. */
const AG_AUTO_GROUP_COL_ID = "ag-Grid-AutoColumn";

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

type MeasureAcc = {
  field: string;
  func: string;
  sum: number;
  n: number;
  min: number | null;
  max: number | null;
  first: unknown;
  last: unknown;
  hasFirst: boolean;
};

function createMeasureAcc(vc: MirrorValueCol): MeasureAcc {
  return {
    field: vc.field,
    func: vc.aggFunc || "sum",
    sum: 0,
    n: 0,
    min: null,
    max: null,
    first: null,
    last: null,
    hasFirst: false,
  };
}

function observeMeasure(acc: MeasureAcc, row: Record<string, unknown>): void {
  const raw = row[acc.field];
  if (!acc.hasFirst) {
    acc.first = raw;
    acc.hasFirst = true;
  }
  acc.last = raw;

  if (acc.func === "count" || acc.func === "first" || acc.func === "last") {
    return;
  }

  const n = asNumber(raw);
  if (n == null) return;
  acc.n += 1;
  acc.sum += n;
  acc.min = acc.min == null ? n : Math.min(acc.min, n);
  acc.max = acc.max == null ? n : Math.max(acc.max, n);
}

function finishMeasure(acc: MeasureAcc, childCount: number): unknown {
  const { func } = acc;
  if (isTrafficLightAgg(func)) {
    return foldTrafficLight(acc.min, acc.max);
  }
  switch (func) {
    case "count":
      return childCount;
    case "first":
      return acc.hasFirst ? acc.first : null;
    case "last":
      return acc.hasFirst ? acc.last : null;
    case "min":
      return acc.min;
    case "max":
      return acc.max;
    case "avg":
    case "mean":
    case "weightedAvg":
      return acc.n > 0 ? acc.sum / acc.n : null;
    case "sum":
    default:
      return acc.n > 0 ? acc.sum : null;
  }
}

function aggregateField(
  rows: Record<string, unknown>[],
  field: string,
  aggFunc: string,
): unknown {
  if (rows.length === 0) return null;
  const acc = createMeasureAcc({ id: field, field, aggFunc });
  for (const row of rows) observeMeasure(acc, row);
  return finishMeasure(acc, rows.length);
}

function compareValues(av: unknown, bv: unknown): number {
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Build AG SSRM group-header rows from already-filtered leaves.
 * Single pass: bucket + streaming aggs (no per-measure rescans).
 * Shape matches worker `shapeGroupRows` (`__ssrmGroupKey`, `childCount`, measures).
 */
export function aggregateMirrorGroupRows(
  leaves: Record<string, unknown>[],
  groupField: string,
  valueCols: MirrorValueCol[],
  sortModel: { colId: string; sort: string }[] = [],
): Record<string, unknown>[] {
  const measures = valueCols.filter(
    (vc) => vc.field && vc.field !== groupField,
  );
  const buckets = new Map<
    string,
    { display: unknown; childCount: number; measures: MeasureAcc[] }
  >();

  for (const row of leaves) {
    const display = row[groupField];
    const key = display == null ? "" : String(display);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        display,
        childCount: 0,
        measures: measures.map(createMeasureAcc),
      };
      buckets.set(key, bucket);
    }
    bucket.childCount += 1;
    for (const acc of bucket.measures) observeMeasure(acc, row);
  }

  const groups: Record<string, unknown>[] = [];
  for (const [key, bucket] of buckets) {
    const shaped: Record<string, unknown> = {
      [groupField]: bucket.display,
      __ssrmGroupKey: key,
      childCount: bucket.childCount,
    };
    for (const acc of bucket.measures) {
      shaped[acc.field] = finishMeasure(acc, bucket.childCount);
    }
    groups.push(shaped);
  }

  if (sortModel.length === 0) {
    // Stable key order for predictable first paint.
    groups.sort((a, b) =>
      compareValues(a.__ssrmGroupKey, b.__ssrmGroupKey),
    );
    return groups;
  }

  return groups.sort((a, b) => {
    for (const s of sortModel) {
      const field =
        s.colId === AG_AUTO_GROUP_COL_ID ? groupField : s.colId;
      const cmp = compareValues(a[field], b[field]);
      if (cmp !== 0) return s.sort === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

/** Roll up filtered leaves into grand-total style totals for root getRows. */
export function aggregateMirrorTotals(
  leaves: Record<string, unknown>[],
  valueCols: MirrorValueCol[],
): {
  totals: Record<string, unknown>;
  aggregates: Record<string, Record<string, unknown>>;
} {
  const totals: Record<string, unknown> = {};
  const aggregates: Record<string, Record<string, unknown>> = {};
  for (const vc of valueCols) {
    if (!vc.field) continue;
    const value = aggregateField(leaves, vc.field, vc.aggFunc || "sum");
    const func = vc.aggFunc || "sum";
    if (!aggregates[vc.field]) aggregates[vc.field] = {};
    aggregates[vc.field]![func] = value;
    if (func === "sum") totals[vc.field] = value;
  }
  return { totals, aggregates };
}
