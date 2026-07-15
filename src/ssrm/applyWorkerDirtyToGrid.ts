import type { WorkerOutbound } from "./types";

export type DirtyMessage = Extract<WorkerOutbound, { type: "dirty" }>;

export type LeafDirtyTransaction = {
  update?: Record<string, unknown>[];
  add?: Record<string, unknown>[];
};

export type DirtyRefreshActions = {
  /**
   * Prefer for leaf update/add: patch loaded SSRM rows in place (no store
   * reload). Soft-refreshing every loaded block on each tick fights scroll.
   */
  applyLeafTransaction?: (tx: LeafDirtyTransaction) => void;
  /** Soft refresh of loaded stores (fallback when surgical tx unavailable). */
  throttleRefresh: () => void;
  /** Hard purge refresh (replace / remove / structural). */
  purgeRefresh: () => void;
};

/**
 * Choose refresh strategy for a worker `dirty` event.
 *
 * - Leaf `update`/`add` → surgical SSRM transaction when provided; else soft refresh.
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
    if (actions.applyLeafTransaction) {
      actions.applyLeafTransaction({
        ...(update != null && update.length > 0 ? { update } : {}),
        ...(add != null && add.length > 0 ? { add } : {}),
      });
      return "surgical";
    }
    actions.throttleRefresh();
    return "surgical";
  }

  actions.purgeRefresh();
  return "purge";
}
