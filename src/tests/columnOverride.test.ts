import { describe, expect, it } from "vitest";
import {
  buildColumnOverride,
  collectLeafFieldsForTest,
} from "../ssrmgrid/columnOverride";

describe("buildColumnOverride", () => {
  it("includes nested ColGroupDef leaf fields in the Perspective schema", () => {
    const { schema } = buildColumnOverride(
      [
        {
          headerName: "Reference",
          groupId: "g_reference",
          children: [
            { field: "assetClass", headerName: "Class" },
            { field: "issuerSector", headerName: "Sector" },
          ],
        } as never,
        { field: "cusip", headerName: "CUSIP" },
      ],
      { index: "id", sampleRow: { id: "1", assetClass: "Rates", issuerSector: "Sov", cusip: "X" } },
    );

    expect(schema.assetClass).toBe("string");
    expect(schema.issuerSector).toBe("string");
    expect(schema.cusip).toBe("string");
    expect(schema.id).toBe("string");
    expect(collectLeafFieldsForTest([
      {
        headerName: "Reference",
        children: [{ field: "assetClass" }, { field: "issuerSector" }],
      } as never,
      { field: "cusip" },
    ])).toEqual(["assetClass", "issuerSector", "cusip"]);
  });

  it("enriches schema from sample keys missing in columnDefs", () => {
    const { schema } = buildColumnOverride([{ field: "cusip" }], {
      index: "id",
      sampleRow: {
        id: "1",
        cusip: "X",
        book: "HY",
        dailyPnL: 1.5,
        krdSparkline: [1, 2, 3],
      },
    });
    expect(schema.book).toBe("string");
    expect(schema.dailyPnL).toBe("float");
    expect(schema.krdSparkline).toBeUndefined();
  });
});
