import { describe, expect, it } from "vitest";

import {
  formatShareOfTotal,
  resolveAggregate,
  shareExceeds,
  shareOfAggregate,
  shareOfTotal,
} from "../ssrm/shareOfTotal";
import {
  collectAggregateSpecs,
  collectSumFields,
} from "../workers/sumTotals";
import type { SsrmGetRowsRequest } from "../ssrm/types";

describe("shareOfTotal / shareOfAggregate", () => {
  it("uses __ssrm_aggs for any aggFunc (sum/avg/max)", () => {
    const data = {
      pnl: 25,
      __ssrm_aggs: {
        pnl: { sum: 100, avg: 10, max: 40, min: -5, count: 10 },
      },
    };
    expect(shareOfTotal(25, "pnl", data)).toBe(0.25);
    expect(shareOfAggregate(25, "pnl", "avg", data)).toBe(2.5);
    expect(shareOfAggregate(25, "pnl", "max", data)).toBe(0.625);
    expect(resolveAggregate("pnl", "min", data)).toBe(-5);
    expect(formatShareOfTotal(25, "pnl", { data })).toBe("25.00%");
    expect(shareExceeds(25, "pnl", 0.2, { data })).toBe(true);
  });

  it("falls back to legacy __ssrm_sums / context.totals for sum", () => {
    expect(
      shareOfTotal(10, "pnl", { __ssrm_sums: { pnl: 50 } }),
    ).toBe(0.2);
    expect(
      shareOfTotal(10, "pnl", {}, { totals: { pnl: 50 } }),
    ).toBe(0.2);
  });
});

describe("collectAggregateSpecs", () => {
  it("requests sum/avg/min/max/count for defaults plus valueCol aggs", () => {
    const request = {
      dataset: "positions",
      valueCols: [{ id: "dv01", field: "dv01", aggFunc: "avg" }],
    } as SsrmGetRowsRequest;
    const specs = collectAggregateSpecs(request);
    expect(specs.some((s) => s.field === "pnl" && s.aggFunc === "sum")).toBe(
      true,
    );
    expect(specs.some((s) => s.field === "pnl" && s.aggFunc === "avg")).toBe(
      true,
    );
    expect(specs.some((s) => s.field === "dv01" && s.aggFunc === "avg")).toBe(
      true,
    );
    expect(specs.some((s) => s.field === "dv01" && s.aggFunc === "sum")).toBe(
      true,
    );
    expect(collectSumFields(request)).toContain("pnl");
  });
});
