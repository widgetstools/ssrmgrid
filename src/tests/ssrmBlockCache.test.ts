import { describe, expect, it, vi } from "vitest";

import { createPerspectiveDatasource } from "../ssrm/createPerspectiveDatasource";
import {
  fingerprintBlockRequest,
  SsrmBlockCache,
} from "../ssrm/ssrmBlockCache";

describe("SsrmBlockCache", () => {
  it("fingerprints by range and query shape", () => {
    const base = {
      dataset: "main",
      startRow: 0,
      endRow: 100,
      rowGroupCols: [] as { id: string; field: string }[],
      valueCols: [] as { id: string; field: string; aggFunc: string }[],
      pivotCols: [] as { id: string; field: string }[],
      pivotMode: false,
      groupKeys: [] as string[],
      filterModel: {},
      sortModel: [] as { colId: string; sort: string }[],
      refreshGeneration: 0,
    };
    const a = fingerprintBlockRequest(base);
    const b = fingerprintBlockRequest({ ...base, startRow: 100, endRow: 200 });
    const c = fingerprintBlockRequest({ ...base, refreshGeneration: 1 });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(fingerprintBlockRequest(base));
  });

  it("getOrLoad dedupes in-flight loads", async () => {
    const cache = new SsrmBlockCache();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return {
        rowData: [{ id: 1 }],
        rowCount: 1,
      };
    };
    const [a, b] = await Promise.all([
      cache.getOrLoad("k", loader),
      cache.getOrLoad("k", loader),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(cache.get("k")?.rowCount).toBe(1);
  });

  it("clear drops blocks and late in-flight loads do not repopulate", async () => {
    const cache = new SsrmBlockCache();
    const p = cache.getOrLoad("k", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { rowData: [], rowCount: 0 };
    });
    cache.clear();
    await expect(p).resolves.toEqual({ rowData: [], rowCount: 0 });
    expect(cache.size).toBe(0);
  });
});

describe("createPerspectiveDatasource sync cache", () => {
  function mockParams(overrides?: {
    startRow?: number;
    endRow?: number;
  }) {
    return {
      request: {
        startRow: overrides?.startRow ?? 0,
        endRow: overrides?.endRow ?? 100,
        rowGroupCols: [],
        valueCols: [],
        pivotCols: [],
        pivotMode: false,
        groupKeys: [],
        filterModel: {},
        sortModel: [],
      },
      success: vi.fn(),
      fail: vi.fn(),
      needsGrandTotal: false,
    };
  }

  it("calls params.success synchronously on cache hit", async () => {
    const cache = new SsrmBlockCache();
    const key = fingerprintBlockRequest({
      dataset: "main",
      startRow: 0,
      endRow: 100,
      rowGroupCols: [],
      valueCols: [],
      pivotCols: [],
      pivotMode: false,
      groupKeys: [],
      filterModel: {},
      sortModel: [],
      refreshGeneration: 0,
    });
    cache.set(key, {
      rowData: [{ id: "a" }],
      rowCount: 1,
    });

    const getRows = vi.fn(async () => ({
      rowData: [{ id: "prefetch" }],
      rowCount: 1,
    }));
    const ds = createPerspectiveDatasource(
      () => ({ getRows }) as never,
      () => "main",
      () => ({ isConfigured: true, refreshGeneration: 0 }),
      undefined,
      cache,
    );

    const params = mockParams();
    ds.getRows(params as never);

    expect(params.success).toHaveBeenCalledTimes(1);
    expect(params.success).toHaveBeenCalledWith({
      rowData: [{ id: "a" }],
      rowCount: 1,
    });
    expect(params.fail).not.toHaveBeenCalled();
    // Neighbor prefetch may fire async; primary block did not need the worker.
    await vi.waitFor(() => expect(getRows.mock.calls.length).toBeGreaterThan(0));
    expect(getRows.mock.calls[0]![0].startRow).toBe(100);
  });

  it("fetches async on miss then serves sync on repeat", async () => {
    const cache = new SsrmBlockCache();
    const getRows = vi.fn(async () => ({
      rowData: [{ id: "b" }],
      rowCount: 10,
    }));
    const ds = createPerspectiveDatasource(
      () => ({ getRows }) as never,
      () => "main",
      () => ({ isConfigured: true, refreshGeneration: 0 }),
      undefined,
      cache,
    );

    const first = mockParams();
    ds.getRows(first as never);
    expect(first.success).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(first.success).toHaveBeenCalledTimes(1));
    const callsAfterFirst = getRows.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    const second = mockParams();
    ds.getRows(second as never);
    expect(second.success).toHaveBeenCalledTimes(1);
    expect(second.success).toHaveBeenCalledWith({
      rowData: [{ id: "b" }],
      rowCount: 10,
    });
    // Sync hit must not issue another primary fetch (prefetch may already have).
    expect(getRows.mock.calls.length).toBe(callsAfterFirst);
  });
});
