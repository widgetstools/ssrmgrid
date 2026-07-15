import { GRAND_TOTAL_ROW_ID } from "ag-grid-community";
import { describe, expect, it, vi } from "vitest";

import {
  patchGrandTotalFromMirror,
  patchLoadedGroupAggregatesFromMirror,
} from "../ssrm/patchLoadedGroupAggregates";
import { RowMirror } from "../ssrm/rowMirror";

describe("patchLoadedGroupAggregatesFromMirror", () => {
  it("patches root group store with recomputed sums", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", pnl: 10 },
        { id: "2", book: "A", pnl: 20 },
      ],
      "id",
    );
    const apply = vi.fn();
    const api = {
      getRowGroupColumns: () => [
        { getColId: () => "book", getColDef: () => ({ field: "book" }) },
      ],
      getValueColumns: () => [
        {
          getColId: () => "pnl",
          getColDef: () => ({ field: "pnl", aggFunc: "sum" }),
          getAggFunc: () => "sum",
        },
      ],
      getFilterModel: () => ({}),
      isPivotMode: () => false,
      getServerSideGroupLevelState: () => [{ route: [] }],
      applyServerSideTransactionAsync: apply,
    };

    patchLoadedGroupAggregatesFromMirror(api as never, mirror);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        route: [],
        update: expect.arrayContaining([
          expect.objectContaining({
            __ssrmGroupKey: "A",
            childCount: 2,
            pnl: 30,
          }),
        ]),
      }),
    );
  });
});

describe("patchGrandTotalFromMirror", () => {
  it("updates grand total via GRAND_TOTAL_ROW_ID transaction", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", pnl: 10 },
        { id: "2", book: "A", pnl: 20 },
      ],
      "id",
    );
    const apply = vi.fn();
    const api = {
      getRowGroupColumns: () => [
        { getColId: () => "book", getColDef: () => ({ field: "book" }) },
      ],
      getValueColumns: () => [
        {
          getColId: () => "pnl",
          getColDef: () => ({ field: "pnl", aggFunc: "sum" }),
          getAggFunc: () => "sum",
        },
      ],
      getFilterModel: () => ({}),
      isPivotMode: () => false,
      applyServerSideTransactionAsync: apply,
    };

    patchGrandTotalFromMirror(api as never, mirror, { idField: "id" });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({
      update: [{ id: GRAND_TOTAL_ROW_ID, pnl: 30 }],
    });
  });

  it("recomputes after leaf patches", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", pnl: 10 },
        { id: "2", book: "A", pnl: 20 },
      ],
      "id",
    );
    mirror.patchById([{ id: "1", pnl: 100 }]);
    const apply = vi.fn();
    const api = {
      getRowGroupColumns: () => [],
      getValueColumns: () => [
        {
          getColId: () => "pnl",
          getColDef: () => ({ field: "pnl", aggFunc: "sum" }),
          getAggFunc: () => "sum",
        },
      ],
      getFilterModel: () => ({}),
      isPivotMode: () => false,
      applyServerSideTransactionAsync: apply,
    };

    patchGrandTotalFromMirror(api as never, mirror, { idField: "id" });

    expect(apply).toHaveBeenCalledWith({
      update: [{ id: GRAND_TOTAL_ROW_ID, pnl: 120 }],
    });
  });

  it("skips transaction when grand total measures are unchanged", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", pnl: 10 },
        { id: "2", book: "A", pnl: 20 },
      ],
      "id",
    );
    const apply = vi.fn();
    const api = {
      getRowGroupColumns: () => [],
      getValueColumns: () => [
        {
          getColId: () => "pnl",
          getColDef: () => ({ field: "pnl", aggFunc: "sum" }),
          getAggFunc: () => "sum",
        },
      ],
      getFilterModel: () => ({}),
      isPivotMode: () => false,
      getRowNode: () => ({
        data: { id: GRAND_TOTAL_ROW_ID, pnl: 30 },
      }),
      applyServerSideTransactionAsync: apply,
    };

    patchGrandTotalFromMirror(api as never, mirror, { idField: "id" });

    expect(apply).not.toHaveBeenCalled();
  });

  it("patches avg when raw mean moves even slightly", () => {
    const mirror = new RowMirror();
    mirror.replaceAll(
      [
        { id: "1", book: "A", price: 10 },
        { id: "2", book: "A", price: 10 },
      ],
      "id",
    );
    mirror.patchById([{ id: "1", price: 10.5 }]);
    const apply = vi.fn();
    const api = {
      getRowGroupColumns: () => [],
      getValueColumns: () => [
        {
          getColId: () => "price",
          getColDef: () => ({ field: "price", aggFunc: "avg" }),
          getAggFunc: () => "avg",
        },
      ],
      getFilterModel: () => ({}),
      isPivotMode: () => false,
      getRowNode: () => ({
        data: { id: GRAND_TOTAL_ROW_ID, price: 10 },
      }),
      applyServerSideTransactionAsync: apply,
    };

    patchGrandTotalFromMirror(api as never, mirror, { idField: "id" });

    expect(apply).toHaveBeenCalledWith({
      update: [{ id: GRAND_TOTAL_ROW_ID, price: 10.25 }],
    });
  });
});
