import { describe, expect, it } from "vitest";

import { mergeLeafUpdateRows } from "../ssrm/mergeLeafUpdateRows";
import { SsrmBlockCache } from "../ssrm/ssrmBlockCache";

describe("mergeLeafUpdateRows", () => {
  it("merges partial patches onto existing rows", () => {
    const existing = new Map<string, Record<string, unknown>>([
      ["a", { id: "a", book: "FX-A", price: 1 }],
    ]);
    const out = mergeLeafUpdateRows(
      "id",
      [{ id: "a", price: 2 }],
      (id) => existing.get(id),
    );
    expect(out).toEqual([{ id: "a", book: "FX-A", price: 2 }]);
  });

  it("keeps patch as-is when no existing row", () => {
    const out = mergeLeafUpdateRows("id", [{ id: "b", price: 3 }], () => undefined);
    expect(out).toEqual([{ id: "b", price: 3 }]);
  });
});

describe("SsrmBlockCache.findRow", () => {
  it("returns cached row by id after patchRows", () => {
    const cache = new SsrmBlockCache();
    cache.set("b0", {
      rowData: [{ id: "a", book: "FX-A", price: 1 }],
      rowCount: 1,
    });
    cache.patchRows("id", [{ id: "a", price: 9 }]);
    expect(cache.findRow("id", "a")).toEqual({
      id: "a",
      book: "FX-A",
      price: 9,
    });
  });
});
