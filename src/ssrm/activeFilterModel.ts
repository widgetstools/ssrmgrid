import type { GridApi } from "ag-grid-community";

/**
 * Prefer the Advanced Filter model when active; otherwise the column filter model.
 * Shared by export-all and totals so both see the same filtered universe.
 */
export function getActiveFilterModel(api: GridApi): Record<string, unknown> {
  const advanced = api.getAdvancedFilterModel?.();
  if (advanced) {
    return advanced as unknown as Record<string, unknown>;
  }
  return (api.getFilterModel() ?? {}) as Record<string, unknown>;
}
