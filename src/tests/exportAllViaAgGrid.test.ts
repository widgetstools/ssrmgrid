import { describe, expect, it } from "vitest";

import { getExportColumnDefs } from "../ssrm/exportAllViaAgGrid";

describe("getExportColumnDefs", () => {
  it("keeps displayed columns that have a field", () => {
    const api = {
      getAllDisplayedColumns: () => [
        {
          getColDef: () => ({ field: "desk", headerName: "Desk" }),
        },
        {
          getColDef: () => ({ headerName: "No field" }),
        },
        {
          getColDef: () => ({
            field: "pnl",
            headerName: "PnL",
            valueFormatter: (p: { value: number }) => String(p.value),
          }),
        },
      ],
    };

    const defs = getExportColumnDefs(api as never);
    expect(defs).toEqual([
      { field: "desk", headerName: "Desk", valueFormatter: undefined, valueGetter: undefined },
      {
        field: "pnl",
        headerName: "PnL",
        valueFormatter: expect.any(Function),
        valueGetter: undefined,
      },
    ]);
  });
});
