/**
 * Perspective accepts dotted column names as literal schema keys
 * (e.g. `rating.moody`). Validated against @finos/perspective 3.x so
 * STOMP `rowShape: 'ssrm'` can keep AG Grid `field` strings as-is.
 */
import { describe, it, expect } from "vitest";
import perspective from "@finos/perspective";

describe("Perspective dotted column names", () => {
  it("accepts literal dotted schema keys and round-trips values", async () => {
    const table = await perspective.table({
      id: "string",
      "rating.moody": "string",
    });
    await table.update([{ id: "1", "rating.moody": "Aa" }]);
    const view = await table.view();
    const rows = (await view.to_json()) as Record<string, unknown>[];
    expect(rows).toEqual([{ id: "1", "rating.moody": "Aa" }]);
    const schema = await table.schema();
    expect(schema).toMatchObject({ id: "string", "rating.moody": "string" });
    await view.delete();
    await table.delete();
  });
});
