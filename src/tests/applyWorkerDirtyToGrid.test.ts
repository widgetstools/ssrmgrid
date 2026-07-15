import { describe, expect, it, vi } from "vitest";

import { applyWorkerDirtyToGrid } from "../ssrm/applyWorkerDirtyToGrid";

describe("applyWorkerDirtyToGrid", () => {
  it("soft-refreshes on leaf update", () => {
    const throttleRefresh = vi.fn();
    const purgeRefresh = vi.fn();

    const mode = applyWorkerDirtyToGrid(
      {
        type: "dirty",
        at: 1,
        transaction: {
          dataset: "main",
          update: [{ id: "a", mid: 1 }],
        },
      },
      { throttleRefresh, purgeRefresh },
    );

    expect(mode).toBe("surgical");
    expect(throttleRefresh).toHaveBeenCalledTimes(1);
    expect(purgeRefresh).not.toHaveBeenCalled();
  });

  it("soft-refreshes on leaf add", () => {
    const throttleRefresh = vi.fn();
    const purgeRefresh = vi.fn();

    applyWorkerDirtyToGrid(
      {
        type: "dirty",
        at: 2,
        transaction: { dataset: "main", add: [{ id: "b" }] },
      },
      { throttleRefresh, purgeRefresh },
    );

    expect(throttleRefresh).toHaveBeenCalled();
    expect(purgeRefresh).not.toHaveBeenCalled();
  });

  it("purges when dirty has no leaf payload", () => {
    const throttleRefresh = vi.fn();
    const purgeRefresh = vi.fn();

    const mode = applyWorkerDirtyToGrid(
      { type: "dirty", at: 3 },
      { throttleRefresh, purgeRefresh },
    );

    expect(mode).toBe("purge");
    expect(throttleRefresh).not.toHaveBeenCalled();
    expect(purgeRefresh).toHaveBeenCalledTimes(1);
  });

  it("purges when transaction has empty arrays", () => {
    const throttleRefresh = vi.fn();
    const purgeRefresh = vi.fn();

    applyWorkerDirtyToGrid(
      {
        type: "dirty",
        at: 4,
        transaction: { dataset: "main", update: [], add: [] },
      },
      { throttleRefresh, purgeRefresh },
    );

    expect(purgeRefresh).toHaveBeenCalledTimes(1);
  });
});
