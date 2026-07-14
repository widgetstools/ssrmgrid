import { describe, expect, it, vi } from "vitest";

import { refreshAllLoadedServerSideStores } from "../ssrm/refreshAllLoadedStores";

describe("refreshAllLoadedServerSideStores", () => {
  it("refreshes root when no group levels are loaded", () => {
    const refreshServerSide = vi.fn();
    const api = {
      getServerSideGroupLevelState: () => [],
      refreshServerSide,
    };

    refreshAllLoadedServerSideStores(api as never, { purge: false });

    expect(refreshServerSide).toHaveBeenCalledTimes(1);
    expect(refreshServerSide).toHaveBeenCalledWith({ purge: false });
  });

  it("refreshes every loaded route including nested groups and leaves", () => {
    const refreshServerSide = vi.fn();
    const api = {
      getServerSideGroupLevelState: () => [
        { route: [] },
        { route: ["IG Credit"] },
        { route: ["IG Credit", "BOOK001"] },
      ],
      refreshServerSide,
    };

    refreshAllLoadedServerSideStores(api as never, { purge: false });

    expect(refreshServerSide).toHaveBeenCalledTimes(3);
    expect(refreshServerSide).toHaveBeenNthCalledWith(1, {
      route: [],
      purge: false,
    });
    expect(refreshServerSide).toHaveBeenNthCalledWith(2, {
      route: ["IG Credit"],
      purge: false,
    });
    expect(refreshServerSide).toHaveBeenNthCalledWith(3, {
      route: ["IG Credit", "BOOK001"],
      purge: false,
    });
  });
});
