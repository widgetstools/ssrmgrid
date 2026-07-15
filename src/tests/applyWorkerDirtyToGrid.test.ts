import { describe, expect, it, vi } from "vitest";

import { applyWorkerDirtyToGrid } from "../ssrm/applyWorkerDirtyToGrid";

describe("applyWorkerDirtyToGrid", () => {
  it("applies surgical leaf update + soft refresh", () => {
    const applyServerSideTransactionAsync = vi.fn();
    const throttleRefresh = vi.fn();
    const purgeRefresh = vi.fn();
    const api = { applyServerSideTransactionAsync };

    const mode = applyWorkerDirtyToGrid(
      api as never,
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
    expect(applyServerSideTransactionAsync).toHaveBeenCalledWith({
      update: [{ id: "a", mid: 1 }],
    });
    expect(throttleRefresh).toHaveBeenCalledTimes(1);
    expect(purgeRefresh).not.toHaveBeenCalled();
  });

  it("applies surgical add without update", () => {
    const applyServerSideTransactionAsync = vi.fn();
    const throttleRefresh = vi.fn();
    const purgeRefresh = vi.fn();

    applyWorkerDirtyToGrid(
      { applyServerSideTransactionAsync } as never,
      {
        type: "dirty",
        at: 2,
        transaction: { dataset: "main", add: [{ id: "b" }] },
      },
      { throttleRefresh, purgeRefresh },
    );

    expect(applyServerSideTransactionAsync).toHaveBeenCalledWith({
      add: [{ id: "b" }],
    });
    expect(throttleRefresh).toHaveBeenCalled();
    expect(purgeRefresh).not.toHaveBeenCalled();
  });

  it("purges when dirty has no leaf payload", () => {
    const applyServerSideTransactionAsync = vi.fn();
    const throttleRefresh = vi.fn();
    const purgeRefresh = vi.fn();

    const mode = applyWorkerDirtyToGrid(
      { applyServerSideTransactionAsync } as never,
      { type: "dirty", at: 3 },
      { throttleRefresh, purgeRefresh },
    );

    expect(mode).toBe("purge");
    expect(applyServerSideTransactionAsync).not.toHaveBeenCalled();
    expect(throttleRefresh).not.toHaveBeenCalled();
    expect(purgeRefresh).toHaveBeenCalledTimes(1);
  });

  it("purges when transaction has empty arrays", () => {
    const applyServerSideTransactionAsync = vi.fn();
    const throttleRefresh = vi.fn();
    const purgeRefresh = vi.fn();

    applyWorkerDirtyToGrid(
      { applyServerSideTransactionAsync } as never,
      {
        type: "dirty",
        at: 4,
        transaction: { dataset: "main", update: [], add: [] },
      },
      { throttleRefresh, purgeRefresh },
    );

    expect(applyServerSideTransactionAsync).not.toHaveBeenCalled();
    expect(purgeRefresh).toHaveBeenCalledTimes(1);
  });
});
