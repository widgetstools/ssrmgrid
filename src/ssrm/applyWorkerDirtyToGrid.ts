import type { GridApi } from "ag-grid-community";
import type { WorkerOutbound } from "./types";

export type DirtyMessage = Extract<WorkerOutbound, { type: "dirty" }>;

export type DirtyRefreshActions = {
  /** Soft refresh of loaded stores (leaf update/add path). */
  throttleRefresh: () => void;
  /** Hard purge refresh (replace / remove / structural). */
  purgeRefresh: () => void;
};

/**
 * Apply a worker `dirty` event to the AG Grid SSRM surface.
 *
 * - Leaf `update`/`add` → surgical `applyServerSideTransactionAsync` + soft refresh
 *   (group stores still need a refresh; surgical update helps flash visible leaves).
 * - Otherwise → purge refresh (full replace / removes / empty payload).
 */
export function applyWorkerDirtyToGrid(
  api: GridApi,
  msg: DirtyMessage,
  actions: DirtyRefreshActions,
): "surgical" | "purge" {
  const tx = msg.transaction;
  const update = tx?.update;
  const add = tx?.add;
  const hasLeaf =
    (update != null && update.length > 0) || (add != null && add.length > 0);

  if (hasLeaf) {
    api.applyServerSideTransactionAsync({
      ...(update?.length ? { update } : {}),
      ...(add?.length ? { add } : {}),
    });
    actions.throttleRefresh();
    return "surgical";
  }

  actions.purgeRefresh();
  return "purge";
}
