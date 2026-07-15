import { describe, it, expect, vi } from "vitest";
import {
  fetchAllGroupLeafRows,
  mergeGroupPathIntoFilterModel,
} from "../ssrm/getGroupLeafRows";
import type { QueryAllRequest, QueryAllResult } from "../ssrm/types";

describe("mergeGroupPathIntoFilterModel", () => {
  it("adds text-equals filters for each group key", () => {
    const model = mergeGroupPathIntoFilterModel(
      { px: { filterType: "number", type: "greaterThan", filter: 0 } },
      [{ field: "assetClass" }, { field: "book" }],
      ["IG Credit", "BOOK002"],
    );
    expect(model.px).toEqual({
      filterType: "number",
      type: "greaterThan",
      filter: 0,
    });
    expect(model.assetClass).toEqual({
      filterType: "text",
      type: "equals",
      filter: "IG Credit",
    });
    expect(model.book).toEqual({
      filterType: "text",
      type: "equals",
      filter: "BOOK002",
    });
  });

  it("group path overrides a prior filter on the same field", () => {
    const model = mergeGroupPathIntoFilterModel(
      { assetClass: { filterType: "set", values: ["HY"] } },
      [{ field: "assetClass" }],
      ["IG Credit"],
    );
    expect(model.assetClass).toEqual({
      filterType: "text",
      type: "equals",
      filter: "IG Credit",
    });
  });
});

describe("fetchAllGroupLeafRows", () => {
  it("calls queryAll uncapped with merged filters and includeStructure false", async () => {
    const rows = [{ id: "1" }, { id: "2" }];
    const queryAll = vi.fn(
      async (req: QueryAllRequest): Promise<QueryAllResult> => {
        expect(req.limit).toBeNull();
        expect(req.includeStructure).toBe(false);
        expect(req.filterModel.assetClass).toEqual({
          filterType: "text",
          type: "equals",
          filter: "IG Credit",
        });
        expect(req.filterModel.other).toEqual({ filterType: "text", type: "equals", filter: "x" });
        return { rowData: rows, rowCount: rows.length };
      },
    );

    const out = await fetchAllGroupLeafRows(queryAll, {
      dataset: "positions",
      rowGroupCols: [{ field: "assetClass" }, { field: "book" }],
      groupKeys: ["IG Credit"],
      filterModel: { other: { filterType: "text", type: "equals", filter: "x" } },
    });

    expect(out).toEqual(rows);
    expect(queryAll).toHaveBeenCalledOnce();
  });
});
