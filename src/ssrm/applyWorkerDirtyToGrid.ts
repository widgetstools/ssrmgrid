import type { WorkerOutbound } from "./types";

export type DirtyMessage = Extract<WorkerOutbound, { type: "dirty" }>;

export type DirtyRefreshActions = {
  /** Soft refresh of loaded stores (leaf update/add path). */
  throttleRefresh: () => void;
  /** Hard purge refresh (replace / remove / structural). */
  purgeRefresh: () => void;
};

/**
 * Choose refresh strategy for a worker `dirty` event.
 *
 * - Leaf `update`/`add` → soft refresh of loaded stores (matches host tick path;
 *   route-aware surgical txs are OUT for grouped SSRM).
 * - Otherwise → purge refresh (full replace / removes / empty payload).
 */
export function applyWorkerDirtyToGrid(
  msg: DirtyMessage,
  actions: DirtyRefreshActions,
): "surgical" | "purge" {
  const tx = msg.transaction;
  const update = tx?.update;
  const add = tx?.add;
  const hasLeaf =
    (update != null && update.length > 0) || (add != null && add.length > 0);

  if (hasLeaf) {
    actions.throttleRefresh();
    return "surgical";
  }

  actions.purgeRefresh();
  return "purge";
}
