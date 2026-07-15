import { describe, expect, it, vi } from "vitest";

import { createPerspectiveDatasource } from "../ssrm/createPerspectiveDatasource";
import { RowMirror } from "../ssrm/rowMirror";
import { SsrmBlockCache } from "../ssrm/ssrmBlockCache";

describe("RowMirror", () => {
  it("serves flat getRows synchronously", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", price: 1 },
        { id: "2", book: "B", price: 2 },
        { id: "3", book: "A", price: 3 },
      ],
      "id",
    );
    const slice = mirror.tryGetRows({
      startRow: 0,
      endRow: 2,
      rowGroupCols: [],
      groupKeys: [],
      pivotMode: false,
      filterModel: {},
      sortModel: [],
    });
    expect(slice?.rowCount).toBe(3);
    expect(slice?.rowData).toHaveLength(2);
    expect(slice?.rowData.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("getLeafAt serves ingest order before a view is built", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A" },
        { id: "2", book: "B" },
      ],
      "id",
    );
    expect(mirror.getLeafAt(1)?.book).toBe("B");
  });

  it("getLeafAt prefers filtered view after tryGetRows", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", price: 1 },
        { id: "2", book: "B", price: 2 },
        { id: "3", book: "A", price: 3 },
      ],
      "id",
    );
    mirror.tryGetRows({
      startRow: 0,
      endRow: 10,
      rowGroupCols: [],
      groupKeys: [],
      pivotMode: false,
      filterModel: {
        book: { filterType: "text", type: "equals", filter: "A" },
      },
      sortModel: [],
    });
    expect(mirror.getLeafAt(0)?.id).toBe("1");
    expect(mirror.getLeafAt(1)?.id).toBe("3");
    expect(mirror.getLeafAt(2)).toBeUndefined();
  });

  it("filters and sorts on the main thread", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", price: 10 },
        { id: "2", book: "B", price: 5 },
        { id: "3", book: "A", price: 1 },
      ],
      "id",
    );
    const slice = mirror.tryGetRows({
      startRow: 0,
      endRow: 10,
      rowGroupCols: [],
      groupKeys: [],
      pivotMode: false,
      filterModel: {
        book: { filterType: "set", values: ["A"] },
      },
      sortModel: [{ colId: "price", sort: "asc" }],
    });
    expect(slice?.rowData.map((r) => r.id)).toEqual(["3", "1"]);
  });

  it("quick filter ANDs tokens across columns under grouping", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "Rates-A", trader: "A. Chen", pnl: 10 },
        { id: "2", book: "Credit-B", trader: "A. Chen", pnl: 5 },
        { id: "3", book: "Rates-A", trader: "N. Williams", pnl: 30 },
      ],
      "id",
    );
    const slice = mirror.tryGetRows({
      startRow: 0,
      endRow: 100,
      rowGroupCols: [{ id: "book", field: "book" }],
      groupKeys: [],
      pivotMode: false,
      filterModel: {},
      sortModel: [],
      valueCols: [{ id: "pnl", field: "pnl", aggFunc: "sum" }],
      quickFilterText: "Rates Chen",
      quickFilterFields: ["book", "trader"],
    });
    // Only id=1 matches both tokens → one group Rates-A with childCount 1.
    expect(slice?.rowCount).toBe(1);
    expect(slice?.rowData[0]).toMatchObject({
      __ssrmGroupKey: "Rates-A",
      childCount: 1,
      pnl: 10,
    });
  });

  it("serves group header rows with aggregates synchronously", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", pnl: 10 },
        { id: "2", book: "B", pnl: 5 },
        { id: "3", book: "A", pnl: 30 },
      ],
      "id",
    );
    const slice = mirror.tryGetRows({
      startRow: 0,
      endRow: 100,
      rowGroupCols: [{ id: "book", field: "book" }],
      groupKeys: [],
      pivotMode: false,
      filterModel: {},
      sortModel: [],
      valueCols: [{ id: "pnl", field: "pnl", aggFunc: "sum" }],
    });
    expect(slice?.rowCount).toBe(2);
    const a = slice?.rowData.find((r) => r.__ssrmGroupKey === "A");
    expect(a).toMatchObject({ book: "A", childCount: 2, pnl: 40 });
    // Grand totals roll every matching leaf (A + B).
    expect(slice?.totals?.pnl).toBe(45);
  });

  it("serves leaf store under a group key", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", price: 1 },
        { id: "2", book: "B", price: 2 },
      ],
      "id",
    );
    const slice = mirror.tryGetRows({
      startRow: 0,
      endRow: 10,
      rowGroupCols: [{ id: "book", field: "book" }],
      groupKeys: ["A"],
      pivotMode: false,
      filterModel: {},
      sortModel: [],
    });
    expect(slice?.rowData.map((r) => r.id)).toEqual(["1"]);
  });

  it("patchById merges into the book", () => {
    const mirror = new RowMirror();
    mirror.replaceAll([{ id: "1", book: "A", price: 1 }], "id");
    const merged = mirror.patchById([{ id: "1", price: 9 }]);
    expect(merged[0]).toEqual({ id: "1", book: "A", price: 9 });
    expect(mirror.findById("1")?.book).toBe("A");
  });
});

describe("createPerspectiveDatasource + RowMirror", () => {
  it("calls params.success synchronously from the mirror", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "a", book: "FX" },
        { id: "b", book: "EQ" },
      ],
      "id",
    );
    const getRows = vi.fn();
    const ds = createPerspectiveDatasource(
      () => ({ getRows }) as never,
      () => "main",
      () => ({
        isConfigured: true,
        refreshGeneration: 0,
        rowMirror: mirror,
      }),
      undefined,
      new SsrmBlockCache(),
    );
    const params = {
      request: {
        startRow: 0,
        endRow: 100,
        rowGroupCols: [],
        valueCols: [],
        pivotCols: [],
        pivotMode: false,
        groupKeys: [],
        filterModel: {},
        sortModel: [],
      },
      success: vi.fn(),
      fail: vi.fn(),
      needsGrandTotal: false,
    };
    ds.getRows(params as never);
    expect(params.success).toHaveBeenCalledTimes(1);
    expect(getRows).not.toHaveBeenCalled();
    expect(params.success).toHaveBeenCalledWith(
      expect.objectContaining({
        rowCount: 2,
        rowData: expect.arrayContaining([
          expect.objectContaining({ id: "a" }),
          expect.objectContaining({ id: "b" }),
        ]),
      }),
    );
  });
});
