import { describe, expect, it } from "vitest";

import {
  applyPostPredicate,
  mapFilterModel,
  parseQuickFilterTokens,
  quickFilterToPlan,
  rowKeepExpressionToPlan,
  rowMatchesQuickFilter,
  simpleConditionToFilters,
} from "../workers/ssrmFilters";

describe("simpleConditionToFilters", () => {
  it("maps blank / notBlank", () => {
    expect(
      simpleConditionToFilters("desk", { filterType: "text", type: "blank" }),
    ).toEqual([["desk", "is null", null]]);
    expect(
      simpleConditionToFilters("desk", {
        filterType: "text",
        type: "notBlank",
      }),
    ).toEqual([["desk", "is not null", null]]);
  });

  it("maps number inRange to inclusive bounds", () => {
    expect(
      simpleConditionToFilters("pnl", {
        filterType: "number",
        type: "inRange",
        filter: 10,
        filterTo: 20,
      }),
    ).toEqual([
      ["pnl", ">=", 10],
      ["pnl", "<=", 20],
    ]);
  });

  it("maps date presets and inRange", () => {
    const preset = simpleConditionToFilters("tradeDate", {
      filterType: "date",
      type: "today",
    });
    expect(preset).toHaveLength(2);
    expect(preset[0]?.[1]).toBe(">=");
    expect(preset[1]?.[1]).toBe("<=");

    expect(
      simpleConditionToFilters("tradeDate", {
        filterType: "date",
        type: "inRange",
        dateFrom: "2024-01-01",
        dateTo: "2024-01-31T12:00:00Z",
      }),
    ).toEqual([
      ["tradeDate", ">=", "2024-01-01"],
      ["tradeDate", "<=", "2024-01-31"],
    ]);
  });
});

describe("mapFilterModel", () => {
  it("maps set + number AND filters to Perspective", () => {
    const plan = mapFilterModel({
      region: { filterType: "set", values: ["APAC", "EMEA"] },
      pnl: { filterType: "number", type: "greaterThan", filter: 0 },
    });
    expect(plan.filters).toEqual([
      ["region", "in", ["APAC", "EMEA"]],
      ["pnl", ">", 0],
    ]);
    expect(plan.postPredicate).toBeUndefined();
  });

  it("maps compound OR equals on one field to in", () => {
    const plan = mapFilterModel({
      desk: {
        filterType: "text",
        operator: "OR",
        conditions: [
          { type: "equals", filter: "A", filterType: "text" },
          { type: "equals", filter: "B", filterType: "text" },
        ],
      },
    });
    expect(plan.filters).toEqual([["desk", "in", ["A", "B"]]]);
  });

  it("maps Advanced Filter AND of simple conditions", () => {
    const plan = mapFilterModel({
      filterType: "join",
      type: "AND",
      conditions: [
        {
          filterType: "text",
          colId: "desk",
          type: "contains",
          filter: "Credit",
        },
        {
          filterType: "number",
          colId: "pnl",
          type: "greaterThan",
          filter: 100,
        },
      ],
    });
    expect(plan.filters).toEqual([
      ["desk", "contains", "Credit"],
      ["pnl", ">", 100],
    ]);
    expect(plan.filterOp).toBe("and");
  });

  it("uses postPredicate for nested Advanced Filter OR/AND mixes", () => {
    const plan = mapFilterModel({
      filterType: "join",
      type: "AND",
      conditions: [
        {
          filterType: "join",
          type: "OR",
          conditions: [
            {
              filterType: "text",
              colId: "desk",
              type: "equals",
              filter: "A",
            },
            {
              filterType: "text",
              colId: "region",
              type: "equals",
              filter: "EMEA",
            },
          ],
        },
        {
          filterType: "number",
          colId: "pnl",
          type: "greaterThan",
          filter: 0,
        },
      ],
    });
    expect(plan.postPredicate).toBeTypeOf("function");
    const pred = plan.postPredicate!;
    expect(pred({ desk: "A", region: "APAC", pnl: 5 })).toBe(true);
    expect(pred({ desk: "B", region: "EMEA", pnl: 5 })).toBe(true);
    expect(pred({ desk: "B", region: "APAC", pnl: 5 })).toBe(false);
    expect(pred({ desk: "A", region: "APAC", pnl: 0 })).toBe(false);
  });

  it("maps flat Advanced Filter OR across fields to a Perspective expression", () => {
    const plan = mapFilterModel({
      filterType: "join",
      type: "OR",
      conditions: [
        {
          filterType: "text",
          colId: "desk",
          type: "contains",
          filter: "Cred",
        },
        {
          filterType: "text",
          colId: "region",
          type: "equals",
          filter: "EMEA",
        },
      ],
    });
    expect(plan.postPredicate).toBeUndefined();
    expect(plan.expressions?.__ssrm_or_match).toContain("match(lower");
    expect(plan.filters).toEqual([["__ssrm_or_match", "==", true]]);
  });

  it("applyPostPredicate filters rows", () => {
    const rows = applyPostPredicate(
      [{ a: 1 }, { a: 2 }],
      (row) => row.a === 2,
    );
    expect(rows).toEqual([{ a: 2 }]);
  });
});

describe("parseQuickFilterTokens", () => {
  it("splits words and keeps quoted phrases", () => {
    expect(parseQuickFilterTokens("Tony Ireland")).toEqual(["tony", "ireland"]);
    expect(parseQuickFilterTokens('"Rates A" Chen')).toEqual([
      "rates a",
      "chen",
    ]);
  });
});

describe("rowMatchesQuickFilter", () => {
  it("ANDs tokens across columns (CSRM semantics)", () => {
    const row = { book: "Rates-A", trader: "A. Chen" };
    expect(rowMatchesQuickFilter(row, "Rates Chen", ["book", "trader"])).toBe(
      true,
    );
    expect(rowMatchesQuickFilter(row, "Rates Bond", ["book", "trader"])).toBe(
      false,
    );
    // Whole-string contains would miss this; tokenization must win.
    expect(rowMatchesQuickFilter(row, "Rates Chen", ["book", "trader"])).toBe(
      true,
    );
  });
});

describe("quickFilterToPlan", () => {
  it("builds an OR of case-insensitive contains across text columns", () => {
    const plan = quickFilterToPlan("usd", ["desk", "currency", "ticker"]);
    expect(plan.filters).toEqual([["__ssrm_quick_filter", "==", true]]);
    const expr = plan.expressions?.__ssrm_quick_filter ?? "";
    expect(expr).toContain('match(lower(string("desk"))');
    expect(expr).toContain('match(lower(string("currency"))');
    expect(expr).toContain(" or ");
  });

  it("ANDs multiple tokens (each OR'd across columns)", () => {
    const plan = quickFilterToPlan("tony ireland", ["name", "country"]);
    const expr = plan.expressions?.__ssrm_quick_filter ?? "";
    expect(expr).toContain(" and ");
    expect(expr).toContain("tony");
    expect(expr).toContain("ireland");
    expect(expr.startsWith("(")).toBe(true);
  });

  it("returns empty plan for blank quick filter", () => {
    expect(quickFilterToPlan("  ", ["desk"])).toEqual({});
  });
});

describe("rowKeepExpressionToPlan", () => {
  it("wraps a Perspective keep expression as a boolean column filter", () => {
    const plan = rowKeepExpressionToPlan('not("ccy" == \'INR\')');
    expect(plan.filters).toEqual([["__ssrm_row_keep", "==", true]]);
    expect(plan.expressions?.__ssrm_row_keep).toBe('not("ccy" == \'INR\')');
    expect(plan.filterOp).toBe("and");
  });

  it("returns empty plan for blank keep expression", () => {
    expect(rowKeepExpressionToPlan("  ")).toEqual({});
    expect(rowKeepExpressionToPlan(undefined)).toEqual({});
  });
});
