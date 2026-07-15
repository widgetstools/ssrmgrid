import { describe, expect, it, vi } from "vitest";

import { ConfiguredGate } from "../ssrm/configuredGate";
import { createPerspectiveDatasource } from "../ssrm/createPerspectiveDatasource";
import { SsrmBlockCache } from "../ssrm/ssrmBlockCache";

describe("ConfiguredGate", () => {
  it("resolves waiters when markReady is called", async () => {
    const gate = new ConfiguredGate();
    const p = gate.wait(5_000);
    expect(gate.isReady).toBe(false);
    queueMicrotask(() => gate.markReady());
    await expect(p).resolves.toBe(true);
    expect(gate.isReady).toBe(true);
    await expect(gate.wait(100)).resolves.toBe(true);
  });

  it("times out when never marked ready", async () => {
    const gate = new ConfiguredGate();
    await expect(gate.wait(30)).resolves.toBe(false);
  });

  it("reset clears readiness", async () => {
    const gate = new ConfiguredGate();
    gate.markReady();
    gate.reset();
    expect(gate.isReady).toBe(false);
    await expect(gate.wait(20)).resolves.toBe(false);
  });
});

describe("createPerspectiveDatasource waitUntilConfigured", () => {
  it("awaits gate instead of failing immediately when not configured", async () => {
    const gate = new ConfiguredGate();
    const getRows = vi.fn(async () => ({
      rowData: [{ id: "1" }],
      rowCount: 1,
    }));
    let configured = false;
    const ds = createPerspectiveDatasource(
      () => ({ getRows }) as never,
      () => "main",
      () => ({
        isConfigured: configured,
        refreshGeneration: 0,
        waitUntilConfigured: () => gate.wait(5_000),
      }),
      undefined,
      new SsrmBlockCache(),
    );

    const params = {
      request: {
        startRow: 0,
        endRow: 100,
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

    ds.getRows(params as never);
    expect(params.success).not.toHaveBeenCalled();

    configured = true;
    gate.markReady();

    await vi.waitFor(() => expect(params.success).toHaveBeenCalledTimes(1));
    expect(params.fail).not.toHaveBeenCalled();
    expect(getRows).toHaveBeenCalledTimes(1);
  });
});
