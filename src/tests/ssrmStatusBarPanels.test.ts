import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ServerFilteredRowCountPanel,
  ServerSelectedRowCountPanel,
  ServerTotalAndFilteredRowCountPanel,
} from "../ssrmgrid/ssrmStatusBarPanels";

function fakeApi(ctx: {
  totalRowCount?: number;
  filteredRowCount?: number;
  selected?: number;
  selectAll?: boolean;
  toggledNodes?: string[];
}) {
  return {
    getGridOption: (key: string) => (key === "context" ? ctx : undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getServerSideSelectionState: () =>
      ctx.selectAll != null || ctx.toggledNodes
        ? {
            selectAll: ctx.selectAll ?? false,
            toggledNodes: ctx.toggledNodes ?? [],
          }
        : null,
    getSelectedNodes: () =>
      Array.from({ length: ctx.selected ?? 0 }, (_, i) => ({ id: String(i) })),
  };
}

describe("SSRM status bar panels", () => {
  it("renders Rows : N like CSRM when unfiltered", () => {
    const html = renderToStaticMarkup(
      createElement(ServerTotalAndFilteredRowCountPanel, {
        api: fakeApi({ totalRowCount: 500, filteredRowCount: 500 }) as never,
      }),
    );
    expect(html).toContain("ag-status-panel-total-and-filtered-row-count");
    expect(html).toContain(">Rows</span>");
    expect(html).toMatch(/ag-status-name-value-value[^>]*>500</);
    expect(html).not.toContain(" of ");
  });

  it("renders Rows : filtered of total when filtered", () => {
    const html = renderToStaticMarkup(
      createElement(ServerTotalAndFilteredRowCountPanel, {
        api: fakeApi({ totalRowCount: 400, filteredRowCount: 224 }) as never,
      }),
    );
    expect(html).toContain("224 of 400");
  });

  it("hides Filtered panel when unfiltered", () => {
    const html = renderToStaticMarkup(
      createElement(ServerFilteredRowCountPanel, {
        api: fakeApi({ totalRowCount: 400, filteredRowCount: 400 }) as never,
      }),
    );
    expect(html).toContain("ag-hidden");
    expect(html).toContain(">Filtered</span>");
  });

  it("shows Filtered : N when filtered", () => {
    const html = renderToStaticMarkup(
      createElement(ServerFilteredRowCountPanel, {
        api: fakeApi({ totalRowCount: 400, filteredRowCount: 224 }) as never,
      }),
    );
    expect(html).not.toContain("ag-hidden");
    expect(html).toMatch(/ag-status-name-value-value[^>]*>224</);
  });

  it("hides Selected when zero", () => {
    const html = renderToStaticMarkup(
      createElement(ServerSelectedRowCountPanel, {
        api: fakeApi({ selected: 0 }) as never,
      }),
    );
    expect(html).toContain("ag-hidden");
  });

  it("shows Selected count from SSRM selection state", () => {
    const html = renderToStaticMarkup(
      createElement(ServerSelectedRowCountPanel, {
        api: fakeApi({
          selectAll: false,
          toggledNodes: ["a", "b", "c"],
        }) as never,
      }),
    );
    expect(html).not.toContain("ag-hidden");
    expect(html).toMatch(/ag-status-name-value-value[^>]*>3</);
  });
});
