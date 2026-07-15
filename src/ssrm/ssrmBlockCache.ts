import type { SsrmGetRowsResult } from "./types";

/** Cached worker getRows payload (main-thread; enables sync params.success). */
export type CachedGetRows = Pick<
  SsrmGetRowsResult,
  | "rowData"
  | "rowCount"
  | "pivotResultFields"
  | "totals"
  | "aggregates"
  | "filteredRowCount"
>;

/** Fields that uniquely identify a Perspective SSRM block slice. */
export type BlockCacheKeyParts = {
  dataset: string;
  startRow: number;
  endRow: number;
  rowGroupCols: { id: string; field: string }[];
  valueCols: { id: string; field: string; aggFunc: string }[];
  pivotCols: { id: string; field: string }[];
  pivotMode: boolean;
  groupKeys: string[];
  filterModel: Record<string, unknown>;
  sortModel: { colId: string; sort: string }[];
  quickFilterText?: string;
  quickFilterFields?: string[];
  treeData?: boolean;
  absSort?: boolean;
  rowKeepExpression?: string;
  /** Bumped on purge / data replace — stale async results must miss. */
  refreshGeneration: number;
};

/** Stable fingerprint for Map lookup (key order fixed by this object). */
export function fingerprintBlockRequest(parts: BlockCacheKeyParts): string {
  return JSON.stringify(parts);
}

/**
 * Main-thread cache of SSRM blocks from the Perspective worker.
 * Cache hits allow `params.success` synchronously (no Loading flash).
 */
export class SsrmBlockCache {
  private readonly blocks = new Map<string, CachedGetRows>();
  private readonly inflight = new Map<string, Promise<CachedGetRows>>();
  /** Bumped on clear() so late in-flight loads do not repopulate. */
  private epoch = 0;

  get(key: string): CachedGetRows | undefined {
    return this.blocks.get(key);
  }

  set(key: string, value: CachedGetRows): void {
    this.blocks.set(key, value);
  }

  clear(): void {
    this.epoch += 1;
    this.blocks.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.blocks.size;
  }

  /**
   * Return cached value, join an in-flight load, or run `loader` once.
   */
  getOrLoad(
    key: string,
    loader: () => Promise<CachedGetRows>,
  ): Promise<CachedGetRows> {
    const hit = this.blocks.get(key);
    if (hit) return Promise.resolve(hit);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const epochAtStart = this.epoch;
    const p = loader()
      .then((value) => {
        if (this.epoch === epochAtStart) {
          this.blocks.set(key, value);
        }
        this.inflight.delete(key);
        return value;
      })
      .catch((err) => {
        this.inflight.delete(key);
        throw err;
      });
    this.inflight.set(key, p);
    return p;
  }
}
