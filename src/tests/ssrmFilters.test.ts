import { describe, expect, it } from "vitest";

import {
  applyPostPredicate,
  mapFilterModel,
  quickFilterToPlan,
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

describe("quickFilterToPlan", () => {
  it("builds an OR contains expression across text columns", () => {
    const plan = quickFilterToPlan("usd", ["desk", "currency", "ticker"]);
    expect(plan.filters).toEqual([["__ssrm_quick_filter", "==", true]]);
    expect(plan.expressions?.__ssrm_quick_filter).toContain("desk");
    expect(plan.expressions?.__ssrm_quick_filter).toContain("currency");
  });

  it("returns empty plan for blank quick filter", () => {
    expect(quickFilterToPlan("  ", ["desk"])).toEqual({});
  });
});
