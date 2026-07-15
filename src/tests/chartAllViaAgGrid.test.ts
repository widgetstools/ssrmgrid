import { describe, expect, it } from "vitest";

import { resolveChartCategoryField } from "../ssrm/chartAllViaAgGrid";

function fakeApi(opts: {
  groupFields?: string[];
  columns?: {
    field: string;
    chartDataType?: string;
    cellDataType?: string;
    aggFunc?: string;
  }[];
}) {
  return {
    getRowGroupColumns: () =>
      (opts.groupFields ?? []).map((field) => ({
        getColDef: () => ({ field }),
      })),
    getAllDisplayedColumns: () =>
      (opts.columns ?? []).map((col) => ({
        getColDef: () => col,
        getColId: () => col.field,
      })),
    getValueColumns: () => [],
  } as unknown as Parameters<typeof resolveChartCategoryField>[0];
}

describe("resolveChartCategoryField", () => {
  it("prefers the first row-group field", () => {
    expect(
      resolveChartCategoryField(
        fakeApi({
          groupFields: ["book", "trader"],
          columns: [{ field: "region", chartDataType: "category" }],
        }),
      ),
    ).toBe("book");
  });

  it("falls back to chartDataType category", () => {
    expect(
      resolveChartCategoryField(
        fakeApi({
          columns: [
            { field: "pnl", cellDataType: "number", aggFunc: "sum" },
            { field: "currency", chartDataType: "category" },
          ],
        }),
      ),
    ).toBe("currency");
  });

  it("uses explicit fallback when nothing else qualifies", () => {
    expect(
      resolveChartCategoryField(
        fakeApi({
          columns: [{ field: "pnl", cellDataType: "number", aggFunc: "sum" }],
        }),
        "id",
      ),
    ).toBe("id");
  });
});
