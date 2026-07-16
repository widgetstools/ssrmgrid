import { describe, expect, it } from "vitest";
import {
  compileEditableExpression,
  compileExpression,
  resolveAggFuncName,
  tryCalculatedExpressionToPerspective,
  tryValueGetterToPerspective,
} from "../ssrm/compileColExpression";
import { buildColumnOverride } from "../ssrmgrid/columnOverride";

describe("compileExpression", () => {
  it("evaluates data-scoped bodies", () => {
    const fn = compileExpression("data.price > 100");
    expect(fn({ data: { price: 150 } })).toBe(true);
    expect(fn({ data: { price: 50 } })).toBe(false);
  });

  it("compiles editable expressions to booleans", () => {
    const editable = compileEditableExpression("data.book === 'HY'");
    expect(editable({ data: { book: "HY" } })).toBe(true);
    expect(editable({ data: { book: "IG" } })).toBe(false);
  });
});

describe("tryValueGetterToPerspective", () => {
  it("ignores pure field aliases", () => {
    expect(tryValueGetterToPerspective("data.price")).toBeNull();
  });

  it("maps arithmetic over data.*", () => {
    expect(tryValueGetterToPerspective("data.bid + data.ask")).toBe(
      '"bid" + "ask"',
    );
    expect(tryValueGetterToPerspective("data.pnl / data.notional * 10000")).toBe(
      '"pnl" / "notional" * 10000',
    );
  });

  it("rejects lambdas and statements", () => {
    expect(tryValueGetterToPerspective("(p) => p.data.x")).toBeNull();
    expect(tryValueGetterToPerspective("return data.x")).toBeNull();
  });
});

describe("tryCalculatedExpressionToPerspective", () => {
  it("rewrites same-row bracket refs", () => {
    expect(
      tryCalculatedExpressionToPerspective("[revenue] - [cost]"),
    ).toBe('"revenue" - "cost"');
  });

  it("rejects sheet/range-like refs", () => {
    expect(tryCalculatedExpressionToPerspective("Sheet1!A1")).toBeNull();
    expect(tryCalculatedExpressionToPerspective("[A1] + [B2]")).toBeNull();
  });
});

describe("resolveAggFuncName", () => {
  it("keeps string names", () => {
    expect(resolveAggFuncName("avg")).toBe("avg");
  });

  it("maps known function names", () => {
    function trafficLight() {
      return 1;
    }
    expect(resolveAggFuncName(trafficLight, { warn: false })).toBe(
      "trafficLight",
    );
  });

  it("falls back to sum for anonymous custom JS", () => {
    expect(resolveAggFuncName(() => 1, { warn: false })).toBe("sum");
  });
});

describe("buildColumnOverride expression approximations", () => {
  it("lifts calculatedExpression to Perspective and strips client recompute", () => {
    const { calcExpressions, agGridColumnDefs } = buildColumnOverride(
      [
        { field: "revenue", cellDataType: "number" },
        { field: "cost", cellDataType: "number" },
        {
          colId: "profit",
          field: "profit",
          calculatedExpression: "[revenue] - [cost]",
          cellDataType: "number",
        } as never,
      ],
      { index: "id", sampleRow: { id: "1", revenue: 10, cost: 4 } },
    );
    expect(calcExpressions.profit).toBe('"revenue" - "cost"');
    const profit = agGridColumnDefs.find((c) => c.field === "profit");
    expect(
      (profit as { calculatedExpression?: string } | undefined)
        ?.calculatedExpression,
    ).toBeUndefined();
  });

  it("compiles string editable / cellClassRules for loaded rows", () => {
    const { agGridColumnDefs } = buildColumnOverride(
      [
        {
          field: "price",
          editable: "data.price != null",
          cellClassRules: { "rag-red": "data.price < 0" },
        } as never,
      ],
      { index: "id", sampleRow: { id: "1", price: 1 } },
    );
    const def = agGridColumnDefs[0]!;
    expect(typeof def.editable).toBe("function");
    expect(
      (def.editable as (p: { data: { price: number } }) => boolean)({
        data: { price: 2 },
      }),
    ).toBe(true);
    expect(typeof def.cellClassRules?.["rag-red"]).toBe("function");
  });

  it("lifts arithmetic string valueGetter to Perspective", () => {
    const { calcExpressions, schema } = buildColumnOverride(
      [
        {
          field: "mid",
          valueGetter: "data.bid + data.ask",
          cellDataType: "number",
        } as never,
      ],
      { index: "id", sampleRow: { id: "1", bid: 1, ask: 2 } },
    );
    expect(calcExpressions.mid).toBe('"bid" + "ask"');
    expect(schema.mid).toBeUndefined();
  });
});
