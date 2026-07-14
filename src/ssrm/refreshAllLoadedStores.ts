import type { GridApi } from "ag-grid-community";

/**
 * Bare refreshServerSide() only reloads the root store. Nested group
 * aggregates and open leaf stores stay stale unless each loaded route
 * is refreshed explicitly.
 */
export function refreshAllLoadedServerSideStores(
  api: GridApi,
  options: { purge?: boolean } = {},
): void {
  const purge = options.purge ?? false;
  const levels = api.getServerSideGroupLevelState?.() ?? [];

  if (levels.length === 0) {
    api.refreshServerSide({ purge });
    return;
  }

  for (const level of levels) {
    api.refreshServerSide({ route: level.route ?? [], purge });
  }
}
