import { describe, expect, it } from "vitest";
import { createCustomEngine } from "../ssrm/engine/customEngine";
import { materializeCalcColumns } from "../ssrm/engine/materializeCalcColumns";

describe("materializeCalcColumns", () => {
  it("evaluates Perspective-style column refs", () => {
    const rows = materializeCalcColumns(
      [{ id: "1", bid: 10, ask: 12 }],
      { mid: '("bid" + "ask") / 2' },
    );
    expect(rows[0]?.mid).toBe(11);
  });

  it("supports if() like Perspective", () => {
    const rows = materializeCalcColumns(
      [{ id: "1", price: 100 }],
      { rag: 'if("price" >= 105, 1, if("price" >= 95, 2, 3))' },
    );
    expect(rows[0]?.rag).toBe(2);
  });

  it("supports IFS and SUM for share-of-total style calcs", () => {
    const rows = materializeCalcColumns(
      [
        { id: "1", pnl: 10 },
        { id: "2", pnl: 30 },
      ],
      {
        share: 'SUM("pnl") == 0 ? null : "pnl" / SUM("pnl")',
        // Perspective: "col" = column, 'str' = string literal
        band: "IFS(\"pnl\" >= 20, 'hi', \"pnl\" >= 10, 'mid', 'lo')",
      },
    );
    expect(rows[0]?.share).toBe(0.25);
    expect(rows[1]?.share).toBe(0.75);
    expect(rows[0]?.band).toBe("mid");
    expect(rows[1]?.band).toBe("hi");
  });
});

describe("createCustomEngine", () => {
  it("serves flat getRows without a Perspective worker", async () => {
    const engine = createCustomEngine();
    engine.configure({
      dataset: "main",
      schema: { id: "string", book: "string", pnl: "float" },
      index: "id",
    });
    engine.setRowData("main", [
      { id: "1", book: "HY", pnl: 10 },
      { id: "2", book: "IG", pnl: 20 },
      { id: "3", book: "HY", pnl: 5 },
    ]);

    const page = await Promise.resolve(
      engine.getRows({
        dataset: "main",
        startRow: 0,
        endRow: 10,
        rowGroupCols: [],
        valueCols: [],
        pivotCols: [],
        pivotMode: false,
        groupKeys: [],
        filterModel: {},
        sortModel: [],
      }),
    );
    expect(page.rowCount).toBe(3);
    expect(page.rowData).toHaveLength(3);

    const grouped = await Promise.resolve(
      engine.getRows({
        dataset: "main",
        startRow: 0,
        endRow: 10,
        rowGroupCols: [{ id: "book", field: "book", displayName: "Book" }],
        valueCols: [{ id: "pnl", field: "pnl", aggFunc: "sum" }],
        pivotCols: [],
        pivotMode: false,
        groupKeys: [],
        filterModel: {},
        sortModel: [],
      }),
    );
    expect(grouped.rowCount).toBe(2);
    const hy = grouped.rowData.find(
      (r) => r.__ssrmGroupKey === "HY" || r.book === "HY",
    );
    expect(hy).toBeTruthy();

    engine.dispose();
  });

  it("rejects pivot mode", () => {
    const engine = createCustomEngine();
    engine.configure({
      dataset: "main",
      schema: { id: "string" },
      index: "id",
    });
    engine.setRowData("main", [{ id: "1" }]);
    expect(() =>
      engine.getRows({
        dataset: "main",
        startRow: 0,
        endRow: 10,
        rowGroupCols: [],
        valueCols: [],
        pivotCols: [],
        pivotMode: true,
        groupKeys: [],
        filterModel: {},
        sortModel: [],
      }),
    ).toThrow(/pivot/i);
    engine.dispose();
  });

  it("applies rowKeepExpression", async () => {
    const engine = createCustomEngine();
    engine.configure({
      dataset: "main",
      schema: { id: "string", pnl: "float" },
      index: "id",
    });
    engine.setRowData("main", [
      { id: "1", pnl: 10 },
      { id: "2", pnl: -5 },
    ]);
    const page = await Promise.resolve(
      engine.getRows({
        dataset: "main",
        startRow: 0,
        endRow: 10,
        rowGroupCols: [],
        valueCols: [],
        pivotCols: [],
        pivotMode: false,
        groupKeys: [],
        filterModel: {},
        sortModel: [],
        rowKeepExpression: '"pnl" > 0',
      }),
    );
    expect(page.rowCount).toBe(1);
    expect(page.rowData[0]?.id).toBe("1");
    engine.dispose();
  });

  it("absSort orders by absolute value", async () => {
    const engine = createCustomEngine();
    engine.configure({
      dataset: "main",
      schema: { id: "string", pnl: "float" },
      index: "id",
    });
    engine.setRowData("main", [
      { id: "a", pnl: -30 },
      { id: "b", pnl: 10 },
      { id: "c", pnl: 20 },
    ]);
    const page = await Promise.resolve(
      engine.getRows({
        dataset: "main",
        startRow: 0,
        endRow: 10,
        rowGroupCols: [],
        valueCols: [],
        pivotCols: [],
        pivotMode: false,
        groupKeys: [],
        filterModel: {},
        sortModel: [{ colId: "pnl", sort: "desc" }],
        absSort: true,
      }),
    );
    expect(page.rowData.map((r) => r.id)).toEqual(["a", "c", "b"]);
    engine.dispose();
  });

  it("treeData shapes group headers with __treeKey", async () => {
    const engine = createCustomEngine();
    engine.configure({
      dataset: "main",
      schema: { id: "string", desk: "string", book: "string" },
      index: "id",
      treeFields: ["desk", "book"],
    });
    engine.setRowData("main", [
      { id: "1", desk: "NY", book: "HY" },
      { id: "2", desk: "NY", book: "IG" },
      { id: "3", desk: "LN", book: "HY" },
    ]);
    const root = await Promise.resolve(
      engine.getRows({
        dataset: "main",
        startRow: 0,
        endRow: 10,
        rowGroupCols: [],
        valueCols: [],
        pivotCols: [],
        pivotMode: false,
        groupKeys: [],
        filterModel: {},
        sortModel: [],
        treeData: true,
      }),
    );
    expect(root.rowCount).toBe(2);
    expect(root.rowData.every((r) => r.group === true)).toBe(true);
    expect(root.rowData.some((r) => r.__treeKey === "NY")).toBe(true);
    engine.dispose();
  });

  it("queryAll returns filtered leaves", async () => {
    const engine = createCustomEngine();
    engine.configure({
      dataset: "main",
      schema: { id: "string", book: "string" },
      index: "id",
    });
    engine.setRowData("main", [
      { id: "1", book: "HY" },
      { id: "2", book: "IG" },
    ]);
    const all = await Promise.resolve(
      engine.queryAll({
        dataset: "main",
        filterModel: {
          book: { filterType: "text", type: "equals", filter: "HY" },
        },
        sortModel: [],
        limit: 100,
      }),
    );
    expect(all.rowCount).toBe(1);
    expect(all.rowData[0]?.book).toBe("HY");
    engine.dispose();
  });

  it("stamps __ssrm_aggs for shareOfTotal on root leaves", async () => {
    const engine = createCustomEngine();
    engine.configure({
      dataset: "main",
      schema: { id: "string", pnl: "float" },
      index: "id",
    });
    engine.setRowData("main", [
      { id: "1", pnl: 10 },
      { id: "2", pnl: 30 },
    ]);
    const page = await Promise.resolve(
      engine.getRows({
        dataset: "main",
        startRow: 0,
        endRow: 10,
        rowGroupCols: [],
        valueCols: [{ id: "pnl", field: "pnl", aggFunc: "sum" }],
        pivotCols: [],
        pivotMode: false,
        groupKeys: [],
        filterModel: {},
        sortModel: [],
      }),
    );
    expect(page.aggregates?.pnl?.sum).toBe(40);
    expect((page.rowData[0] as { __ssrm_aggs?: { pnl?: { sum?: number } } })
      .__ssrm_aggs?.pnl?.sum).toBe(40);
    engine.dispose();
  });
});
