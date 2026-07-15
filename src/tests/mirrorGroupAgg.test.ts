import { describe, expect, it } from "vitest";

import {
  aggregateMirrorGroupRows,
  aggregateMirrorTotals,
} from "../ssrm/mirrorGroupAgg";

describe("aggregateMirrorGroupRows", () => {
  it("sums and averages by group field", () => {
    const groups = aggregateMirrorGroupRows(
      [
        { id: "1", book: "A", pnl: 10, price: 2 },
        { id: "2", book: "B", pnl: 5, price: 4 },
        { id: "3", book: "A", pnl: 30, price: 6 },
      ],
      "book",
      [
        { id: "pnl", field: "pnl", aggFunc: "sum" },
        { id: "price", field: "price", aggFunc: "avg" },
      ],
    );
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.__ssrmGroupKey === "A");
    const b = groups.find((g) => g.__ssrmGroupKey === "B");
    expect(a).toMatchObject({
      book: "A",
      childCount: 2,
      pnl: 40,
      price: 4,
    });
    expect(b).toMatchObject({
      book: "B",
      childCount: 1,
      pnl: 5,
      price: 4,
    });
  });

  it("sorts by measure desc", () => {
    const groups = aggregateMirrorGroupRows(
      [
        { book: "A", pnl: 10 },
        { book: "B", pnl: 50 },
      ],
      "book",
      [{ id: "pnl", field: "pnl", aggFunc: "sum" }],
      [{ colId: "pnl", sort: "desc" }],
    );
    expect(groups.map((g) => g.__ssrmGroupKey)).toEqual(["B", "A"]);
  });
});

describe("aggregateMirrorTotals", () => {
  it("rolls filtered leaves into totals + aggregates", () => {
    const { totals, aggregates } = aggregateMirrorTotals(
      [
        { pnl: 10 },
        { pnl: 30 },
      ],
      [{ id: "pnl", field: "pnl", aggFunc: "sum" }],
    );
    expect(totals.pnl).toBe(40);
    expect(aggregates.pnl?.sum).toBe(40);
  });
});
