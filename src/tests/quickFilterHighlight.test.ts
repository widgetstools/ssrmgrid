import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  highlightQuickFilterHtml,
} from "../ssrmgrid/quickFilterHighlight";

describe("highlightQuickFilterHtml", () => {
  it("marks case-insensitive substring matches", () => {
    expect(highlightQuickFilterHtml("Rates-A", ["rates"])).toBe(
      '<mark class="ssrm-qf-mark">Rates</mark>-A',
    );
  });

  it("marks multiple tokens", () => {
    const html = highlightQuickFilterHtml("A. Chen / Rates-A", ["chen", "rates"]);
    expect(html).toContain('<mark class="ssrm-qf-mark">Chen</mark>');
    expect(html).toContain('<mark class="ssrm-qf-mark">Rates</mark>');
  });

  it("escapes HTML in values", () => {
    expect(highlightQuickFilterHtml("<b>x</b>", ["x"])).toBe(
      '&lt;b&gt;<mark class="ssrm-qf-mark">x</mark>&lt;/b&gt;',
    );
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("returns escaped text when no tokens match", () => {
    expect(highlightQuickFilterHtml("Credit", ["rates"])).toBe("Credit");
  });
});
