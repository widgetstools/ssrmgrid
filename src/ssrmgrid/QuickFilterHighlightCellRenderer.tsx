import type { CustomCellRendererProps } from "ag-grid-react";

import { highlightQuickFilterHtml } from "./quickFilterHighlight";

type QfContext = {
  quickFilterTokens?: string[];
  highlightQuickFilter?: boolean;
};

/**
 * Default cell renderer: when quick-filter tokens are active, mark matching
 * substrings in the formatted cell text. Falls back to plain text otherwise.
 * Column-specific `cellRenderer`s still win over this default.
 */
export function QuickFilterHighlightCellRenderer(
  params: CustomCellRendererProps,
) {
  const ctx = (params.context ?? {}) as QfContext;
  const tokens = ctx.quickFilterTokens ?? [];
  const enabled = ctx.highlightQuickFilter !== false;
  const raw =
    params.valueFormatted != null && params.valueFormatted !== ""
      ? String(params.valueFormatted)
      : params.value == null
        ? ""
        : String(params.value);

  if (!enabled || tokens.length === 0) {
    return raw;
  }

  return (
    <span
      className="ssrm-qf-cell"
      dangerouslySetInnerHTML={{
        __html: highlightQuickFilterHtml(raw, tokens),
      }}
    />
  );
}
