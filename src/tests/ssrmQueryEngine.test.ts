import { beforeEach, describe, expect, it } from "vitest";

import { registerDataset } from "../data/schemas";
import type { SsrmGetRowsRequest } from "../ssrm/types";
import {
  COUNT_AGG_FIELD,
  PIVOT_ROOT_EXPR,
  applyClientSort,
  buildValueAggPlan,
  collectPivotResultFields,
  getQuickFilterColumns,
  mapAggFunc,
  mapSsrmRequestToView,
  shapeGroupRows,
  shapeLeafRows,
  shapePivotRows,
} from "../workers/ssrmQueryEngine";
import { aggregateAlias } from "../workers/sumTotals";

const BASE_ROW_GROUP_COLS: SsrmGetRowsRequest["rowGroupCols"] = [
  { id: "desk", field: "desk", displayName: "Desk" },
  { id: "bookName", field: "bookName", displayName: "Book" },
];

const BASE_VALUE_COLS: SsrmGetRowsRequest["valueCols"] = [
  { id: "notionalAmount", field: "notionalAmount", aggFunc: "sum" },
];

beforeEach(() => {
  registerDataset("positions", {
    schema: {
      positionId: "string",
      desk: "string",
      bookName: "string",
      notionalAmount: "float",
      pnl: "float",
    },
    index: "positionId",
    calcExpressions: {
      pnlPct: '"pnl" / "notionalAmount" * 100',
    },
    treeFields: ["desk", "bookName"],
  });
});

function makeRequest(
  overrides: Partial<SsrmGetRowsRequest> = {},
): SsrmGetRowsRequest {
  return {
    dataset: "positions",
    startRow: 0,
    endRow: 100,
    rowGroupCols: BASE_ROW_GROUP_COLS,
    valueCols: BASE_VALUE_COLS,
    pivotCols: [],
    pivotMode: false,
    groupKeys: [],
    filterModel: {},
    sortModel: [],
    ...overrides,
  };
}

describe("mapAggFunc", () => {
  it("maps sum to Perspective sum", () => {
    expect(mapAggFunc("sum")).toBe("sum");
  });
});

describe("mapSsrmRequestToView", () => {
  it("maps top-level groups when groupKeys is empty", () => {
    const mapped = mapSsrmRequestToView(makeRequest({ groupKeys: [] }));

    expect(mapped.mode).toBe("group");
    expect(mapped.groupField).toBe("desk");
    expect(mapped.startRow).toBe(0);
    expect(mapped.endRow).toBe(100);
    expect(mapped.viewConfig.group_by).toEqual(["desk"]);
    expect(mapped.viewConfig.aggregates).toEqual({
      desk: "any",
      notionalAmount: "sum",
      [COUNT_AGG_FIELD]: "count",
    });
    expect(mapped.viewConfig.columns).toEqual([
      "desk",
      "notionalAmount",
      COUNT_AGG_FIELD,
    ]);
    expect(mapped.viewConfig.filter).toBeUndefined();
  });

  it("maps second-level groups with ancestor equality filters", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({ groupKeys: ["IG Credit"] }),
    );

    expect(mapped.mode).toBe("group");
    expect(mapped.groupField).toBe("bookName");
    expect(mapped.viewConfig.group_by).toEqual(["bookName"]);
    expect(mapped.viewConfig.filter).toEqual([["desk", "==", "IG Credit"]]);
    expect(mapped.viewConfig.aggregates).toEqual({
      bookName: "any",
      notionalAmount: "sum",
      [COUNT_AGG_FIELD]: "count",
    });
  });

  it("maps leaf mode when groupKeys length equals rowGroupCols length", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({ groupKeys: ["IG Credit", "BOOK002"] }),
    );

    expect(mapped.mode).toBe("leaf");
    expect(mapped.groupField).toBeUndefined();
    expect(mapped.viewConfig.group_by).toBeUndefined();
    expect(mapped.viewConfig.filter).toEqual([
      ["desk", "==", "IG Credit"],
      ["bookName", "==", "BOOK002"],
    ]);
    expect(mapped.viewConfig.aggregates).toBeUndefined();
    expect(mapped.viewConfig.columns).toContain("positionId");
    expect(mapped.viewConfig.columns).toContain("desk");
    expect(mapped.viewConfig.columns).toContain("notionalAmount");
  });

  it("maps sortModel and simple text/number filterModel", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        sortModel: [{ colId: "notionalAmount", sort: "desc" }],
        filterModel: {
          desk: {
            filterType: "text",
            type: "contains",
            filter: "Credit",
          },
          notionalAmount: {
            filterType: "number",
            type: "greaterThan",
            filter: 1_000_000,
          },
        },
      }),
    );

    expect(mapped.viewConfig.sort).toEqual([["notionalAmount", "desc"]]);
    expect(mapped.clientSort).toBeUndefined();
    expect(mapped.viewConfig.filter).toEqual([
      ["desk", "contains", "Credit"],
      ["notionalAmount", ">", 1_000_000],
    ]);
  });

  it("does not send pivot result path sorts to Perspective", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        pivotMode: true,
        pivotCols: [{ id: "currency", field: "currency", displayName: "CCY" }],
        sortModel: [{ colId: "USD|notionalAmount", sort: "desc" }],
      }),
    );

    expect(mapped.viewConfig.sort).toBeUndefined();
    expect(mapped.clientSort).toEqual([
      { colId: "USD|notionalAmount", sort: "desc" },
    ]);
  });

  it("remaps ag-Grid-AutoColumn sort to the current group field", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        pivotMode: true,
        pivotCols: [{ id: "currency", field: "currency", displayName: "CCY" }],
        sortModel: [{ colId: "ag-Grid-AutoColumn", sort: "asc" }],
      }),
    );

    expect(mapped.viewConfig.sort).toEqual([["desk", "asc"]]);
    expect(mapped.clientSort).toBeUndefined();
  });

  it("maps set filterModel values to Perspective in filters", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        filterModel: {
          region: {
            filterType: "set",
            values: ["APAC", "EMEA"],
          },
        },
      }),
    );

    expect(mapped.viewConfig.filter).toEqual([
      ["region", "in", ["APAC", "EMEA"]],
    ]);
  });

  it("treats empty rowGroupCols as a flat leaf store", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        rowGroupCols: [],
        groupKeys: [],
      }),
    );

    expect(mapped.mode).toBe("leaf");
    expect(mapped.groupField).toBeUndefined();
    expect(mapped.viewConfig.group_by).toBeUndefined();
  });

  it("ignores incomplete row group cols from mid drag-and-drop", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        rowGroupCols: [
          { id: "desk", field: "desk", displayName: "Desk" },
          { id: "tmp", field: "", displayName: "" },
        ],
        groupKeys: [],
      }),
    );

    expect(mapped.mode).toBe("group");
    expect(mapped.groupField).toBe("desk");
  });

  it("maps pivot mode with split_by and structure counts", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        pivotMode: true,
        pivotCols: [{ id: "currency", field: "currency", displayName: "CCY" }],
        groupKeys: [],
      }),
    );

    expect(mapped.mode).toBe("pivot");
    expect(mapped.groupField).toBe("desk");
    expect(mapped.nextGroupField).toBe("bookName");
    expect(mapped.suppressChildren).toBe(false);
    expect(mapped.viewConfig.split_by).toEqual(["currency"]);
    expect(mapped.viewConfig.group_by).toEqual(["desk"]);
    expect(mapped.viewConfig.columns).toEqual(["notionalAmount"]);
    expect(mapped.structureViewConfig?.aggregates).toEqual({
      desk: "any",
      bookName: "distinct count",
    });
  });

  it("suppresses children at deepest pivot group level", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        pivotMode: true,
        pivotCols: [{ id: "currency", field: "currency", displayName: "CCY" }],
        groupKeys: ["IG Credit"],
      }),
    );

    expect(mapped.mode).toBe("pivot");
    expect(mapped.groupField).toBe("bookName");
    expect(mapped.suppressChildren).toBe(true);
    expect(mapped.structureViewConfig).toBeUndefined();
  });

  it("returns empty past last pivot group level", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        pivotMode: true,
        pivotCols: [{ id: "currency", field: "currency", displayName: "CCY" }],
        groupKeys: ["IG Credit", "BOOK002"],
      }),
    );

    expect(mapped.empty).toBe(true);
  });

  it("uses a synthetic root group for pivot-only requests", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        pivotMode: true,
        rowGroupCols: [],
        groupKeys: [],
        pivotCols: [{ id: "currency", field: "currency", displayName: "CCY" }],
      }),
    );

    expect(mapped.mode).toBe("pivot");
    expect(mapped.viewConfig.expressions).toEqual({ [PIVOT_ROOT_EXPR]: "1" });
    expect(mapped.viewConfig.group_by).toEqual([PIVOT_ROOT_EXPR]);
    expect(mapped.viewConfig.split_by).toEqual(["currency"]);
    expect(mapped.suppressChildren).toBe(true);
  });
});

describe("shapePivotRows", () => {
  it("shapes split_by columns and merges distinct child counts", () => {
    const shaped = shapePivotRows(
      [
        {
          __ROW_PATH__: ["IG Credit"],
          "USD|notionalAmount": 100,
          "EUR|notionalAmount": 50,
        },
      ],
      {
        groupField: "desk",
        valueCols: BASE_VALUE_COLS,
        suppressChildren: false,
        nextGroupField: "bookName",
        structureRows: [
          { __ROW_PATH__: ["IG Credit"], desk: "IG Credit", bookName: 3 },
        ],
      },
    );

    expect(shaped).toEqual([
      {
        desk: "IG Credit",
        __ssrmGroupKey: "IG Credit",
        childCount: 3,
        "USD|notionalAmount": 100,
        "EUR|notionalAmount": 50,
      },
    ]);
  });

  it("forces childCount 0 when children are suppressed", () => {
    const shaped = shapePivotRows(
      [{ __ROW_PATH__: ["BOOK002"], "USD|notionalAmount": 10 }],
      {
        groupField: "bookName",
        valueCols: BASE_VALUE_COLS,
        suppressChildren: true,
      },
    );

    expect(shaped[0].childCount).toBe(0);
  });
});

describe("applyClientSort", () => {
  it("sorts by pivot result field descending with nulls last", () => {
    const rows = applyClientSort(
      [
        { desk: "A", "USD|notionalAmount": 10 },
        { desk: "B", "USD|notionalAmount": 40 },
        { desk: "C", "USD|notionalAmount": null },
      ],
      [{ colId: "USD|notionalAmount", sort: "desc" }],
    );

    expect(rows.map((r) => r.desk)).toEqual(["B", "A", "C"]);
  });
});

describe("collectPivotResultFields", () => {
  it("keeps only value measure paths from Perspective column_paths", () => {
    expect(
      collectPivotResultFields(
        ["USD|notionalAmount", "USD|positionId", "EUR|notionalAmount"],
        BASE_VALUE_COLS,
      ),
    ).toEqual(["USD|notionalAmount", "EUR|notionalAmount"]);
  });

  it("keeps multi-value measure paths under each pivot key", () => {
    const multiValue = [
      { id: "notionalAmount", field: "notionalAmount", aggFunc: "sum" },
      { id: "pnl", field: "pnl", aggFunc: "sum" },
    ];
    expect(
      collectPivotResultFields(
        [
          "USD|notionalAmount",
          "USD|pnl",
          "EUR|notionalAmount",
          "EUR|pnl",
          "USD|desk",
        ],
        multiValue,
      ),
    ).toEqual([
      "USD|notionalAmount",
      "USD|pnl",
      "EUR|notionalAmount",
      "EUR|pnl",
    ]);
  });
});

describe("multi-pivot / multi-value mapping", () => {
  it("maps multiple pivot columns into split_by", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        pivotMode: true,
        pivotCols: [
          { id: "currency", field: "currency", displayName: "CCY" },
          { id: "region", field: "region", displayName: "Region" },
        ],
        valueCols: [
          { id: "notionalAmount", field: "notionalAmount", aggFunc: "sum" },
          { id: "pnl", field: "pnl", aggFunc: "avg" },
        ],
        groupKeys: [],
      }),
    );

    expect(mapped.mode).toBe("pivot");
    expect(mapped.viewConfig.split_by).toEqual(["currency", "region"]);
    expect(mapped.viewConfig.columns).toEqual(["notionalAmount", "pnl"]);
    expect(mapped.viewConfig.aggregates).toMatchObject({
      notionalAmount: "sum",
      pnl: "avg",
    });
  });

  it("shapes multi-pivot result paths with multiple measures", () => {
    const shaped = shapePivotRows(
      [
        {
          __ROW_PATH__: ["IG Credit"],
          "USD|NA|notionalAmount": 100,
          "USD|NA|pnl": 5,
          "EUR|EMEA|notionalAmount": 50,
          "EUR|EMEA|pnl": 2,
        },
      ],
      {
        groupField: "desk",
        valueCols: [
          { id: "notionalAmount", field: "notionalAmount", aggFunc: "sum" },
          { id: "pnl", field: "pnl", aggFunc: "sum" },
        ],
        suppressChildren: true,
      },
    );

    expect(shaped[0]).toMatchObject({
      desk: "IG Credit",
      childCount: 0,
      "USD|NA|notionalAmount": 100,
      "USD|NA|pnl": 5,
      "EUR|EMEA|notionalAmount": 50,
      "EUR|EMEA|pnl": 2,
    });
  });
});

describe("shapeGroupRows", () => {
  it("adds childCount from the count aggregate column", () => {
    const shaped = shapeGroupRows(
      [
        {
          desk: "IG Credit",
          notionalAmount: 5_000_000,
          [COUNT_AGG_FIELD]: 42,
        },
      ],
      "desk",
      BASE_VALUE_COLS,
    );

    expect(shaped).toEqual([
      {
        desk: "IG Credit",
        notionalAmount: 5_000_000,
        childCount: 42,
        __ssrmGroupKey: "IG Credit",
      },
    ]);
  });

  it("folds trafficLight min/max aliases into a single RAG value", () => {
    const field = "ragStatus";
    const minAlias = aggregateAlias(field, "min");
    const maxAlias = aggregateAlias(field, "max");
    const valueCols: SsrmGetRowsRequest["valueCols"] = [
      { id: field, field, aggFunc: "trafficLight" },
    ];

    const shaped = shapeGroupRows(
      [
        {
          desk: "IG Credit",
          [minAlias]: 1,
          [maxAlias]: 3,
          [COUNT_AGG_FIELD]: 10,
        },
      ],
      "desk",
      valueCols,
    );

    expect(shaped[0]?.[field]).toBe(2);
  });
});

describe("buildValueAggPlan", () => {
  it("expands trafficLight to min+max aliases instead of raw agg name", () => {
    const plan = buildValueAggPlan([
      { id: "ragStatus", field: "ragStatus", aggFunc: "trafficLight" },
    ]);

    expect(plan.aggregates).toEqual({
      [aggregateAlias("ragStatus", "min")]: "min",
      [aggregateAlias("ragStatus", "max")]: "max",
    });
    expect(plan.aggregates).not.toHaveProperty("ragStatus");
    expect(plan.measureColumns).toEqual([
      aggregateAlias("ragStatus", "min"),
      aggregateAlias("ragStatus", "max"),
    ]);
    expect(plan.expressions[aggregateAlias("ragStatus", "min")]).toBe(
      '"ragStatus"',
    );
  });

  it("inlines calc expressions into trafficLight min/max aliases", () => {
    const calc = 'if("price" >= 105, 1, if("price" >= 95, 2, 3))';
    const plan = buildValueAggPlan(
      [{ id: "trafficlight", field: "trafficlight", aggFunc: "trafficLight" }],
      { trafficlight: calc },
    );
    expect(plan.expressions[aggregateAlias("trafficlight", "min")]).toBe(calc);
    expect(plan.expressions[aggregateAlias("trafficlight", "max")]).toBe(calc);
  });
});

describe("shapeLeafRows", () => {
  it("passes through leaf rows unchanged", () => {
    const rows = [
      {
        positionId: "POS-1",
        desk: "IG Credit",
        bookName: "BOOK002",
        notionalAmount: 250_000,
      },
    ];

    expect(shapeLeafRows(rows)).toEqual(rows);
  });
});

describe("getQuickFilterColumns", () => {
  it("excludes the primary key from searchable strings", () => {
    expect(getQuickFilterColumns("positions")).toEqual([
      "desk",
      "bookName",
    ]);
  });

  it("honors provided field list including non-string schema cols", () => {
    expect(getQuickFilterColumns("positions", ["desk", "pnl"])).toEqual([
      "desk",
      "pnl",
    ]);
  });
});

describe("mapSsrmRequestToView tree + quick filter + calc cols", () => {
  it("forces hierarchy row groups in treeData mode", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        treeData: true,
        rowGroupCols: [],
        groupKeys: [],
      }),
      COUNT_AGG_FIELD,
      "positions",
    );
    expect(mapped.mode).toBe("tree");
    expect(mapped.groupField).toBe("desk");
    expect(mapped.viewConfig.group_by).toEqual(["desk"]);
  });

  it("attaches quick filter + calculated expressions on leaf views", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        rowGroupCols: [],
        quickFilterText: "credit",
      }),
      COUNT_AGG_FIELD,
      "positions",
    );
    expect(mapped.mode).toBe("leaf");
    expect(mapped.viewConfig.expressions?.pnlPct).toContain("pnl");
    const qf = mapped.viewConfig.expressions?.__ssrm_quick_filter ?? "";
    expect(qf).toContain("match(lower(");
    expect(qf).toContain("credit");
    // PK excluded from searchable columns
    expect(qf).not.toContain("positionId");
    expect(mapped.viewConfig.filter).toEqual([
      ["__ssrm_quick_filter", "==", true],
    ]);
  });

  it("attaches rowKeepExpression as __ssrm_row_keep", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        rowGroupCols: [],
        rowKeepExpression: 'not("ccy" == \'INR\')',
      }),
      COUNT_AGG_FIELD,
      "positions",
    );
    expect(mapped.viewConfig.expressions?.__ssrm_row_keep).toBe(
      'not("ccy" == \'INR\')',
    );
    expect(mapped.viewConfig.filter).toEqual([
      ["__ssrm_row_keep", "==", true],
    ]);
  });

  it("honors quickFilterFields restriction", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        rowGroupCols: [],
        quickFilterText: "x",
        quickFilterFields: ["desk"],
      }),
      COUNT_AGG_FIELD,
      "positions",
    );
    const qf = mapped.viewConfig.expressions?.__ssrm_quick_filter ?? "";
    expect(qf).toContain('"desk"');
    expect(qf).not.toContain("bookName");
  });

  it("marks abs sort with synthetic expression", () => {
    const mapped = mapSsrmRequestToView(
      makeRequest({
        rowGroupCols: [],
        absSort: true,
        sortModel: [{ colId: "pnl", sort: "desc" }],
      }),
      COUNT_AGG_FIELD,
      "positions",
    );
    expect(mapped.viewConfig.expressions?.__ssrm_abs_pnl).toBe('abs("pnl")');
    expect(mapped.viewConfig.sort).toEqual([["__ssrm_abs_pnl", "desc"]]);
  });
});

describe("applyClientSort abs", () => {
  it("sorts by absolute value when abs flag is set", () => {
    const rows = applyClientSort(
      [{ pnl: -5 }, { pnl: 2 }, { pnl: -10 }],
      [{ colId: "pnl", sort: "asc", abs: true }],
    );
    expect(rows.map((r) => r.pnl)).toEqual([2, -5, -10]);
  });
});
