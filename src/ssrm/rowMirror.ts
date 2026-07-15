import {
  filterPlanIsMainThreadSafe,
  mapFilterModel,
  rowMatchesFilterPlan,
  rowMatchesQuickFilter,
  type PerspectiveFilter,
} from "../workers/ssrmFilters";
import {
  aggregateMirrorGroupRows,
  aggregateMirrorTotals,
  type MirrorValueCol,
} from "./mirrorGroupAgg";

export type MirrorGetRowsRequest = {
  startRow: number;
  endRow: number;
  rowGroupCols: { id: string; field: string }[];
  groupKeys: string[];
  pivotMode: boolean;
  filterModel: Record<string, unknown>;
  sortModel: { colId: string; sort: string }[];
  valueCols?: MirrorValueCol[];
  quickFilterText?: string;
  quickFilterFields?: string[];
  treeData?: boolean;
  absSort?: boolean;
  rowKeepExpression?: string;
};

export type MirrorSlice = {
  rowData: Record<string, unknown>[];
  rowCount: number;
  totals?: Record<string, unknown>;
  aggregates?: Record<string, Record<string, unknown>>;
  filteredRowCount?: number;
};

/**
 * Main-thread ordered leaf book for sync SSRM getRows (Perspective-like scroll).
 * Flat / leaf / group-header requests (safe filters) slice here without a worker
 * round-trip.
 */
export class RowMirror {
  private idField = "id";
  private byId = new Map<string, Record<string, unknown>>();
  /** Full book in ingest order (ids stable). */
  private all: Record<string, unknown>[] = [];
  /** Filtered + sorted leaf or group view for the active query shape. */
  private view: Record<string, unknown>[] = [];
  private viewKey = "";
  /** Root totals for the cached view (avoid re-scanning 50k leaves per block). */
  private viewRootRollup: {
    totals: Record<string, unknown>;
    aggregates: Record<string, Record<string, unknown>>;
    filteredRowCount: number;
  } | null = null;
  private ready = false;

  get isReady(): boolean {
    return this.ready && this.all.length > 0;
  }

  get size(): number {
    return this.all.length;
  }

  clear(): void {
    this.byId.clear();
    this.all = [];
    this.view = [];
    this.viewKey = "";
    this.viewRootRollup = null;
    this.ready = false;
  }

  /** Replace the full book (after configure / setRowData). */
  replaceAll(rows: Record<string, unknown>[], idField: string): void {
    this.idField = idField;
    this.byId.clear();
    this.all = rows.map((r) => ({ ...r }));
    for (const row of this.all) {
      const id = row[idField];
      if (id != null && id !== "") this.byId.set(String(id), row);
    }
    this.view = [];
    this.viewKey = "";
    this.viewRootRollup = null;
    this.ready = true;
  }

  /**
   * Merge partial patches by id into the book and current view (in place).
   * Returns merged rows suitable for AG SSRM transactions.
   */
  patchById(patches: Record<string, unknown>[]): Record<string, unknown>[] {
    const merged: Record<string, unknown>[] = [];
    for (const patch of patches) {
      const raw = patch[this.idField];
      if (raw == null || raw === "") continue;
      const id = String(raw);
      const existing = this.byId.get(id);
      if (!existing) {
        const row = { ...patch };
        this.byId.set(id, row);
        this.all.push(row);
        this.viewKey = "";
        merged.push(row);
        continue;
      }
      Object.assign(existing, patch);
      merged.push(existing);
    }
    // Group views cache aggregates — always stale after leaf measure patches.
    this.viewKey = "";
    this.viewRootRollup = null;
    return merged;
  }

  removeByIds(ids: (string | number)[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids.map(String));
    this.all = this.all.filter((r) => !drop.has(String(r[this.idField])));
    for (const id of drop) this.byId.delete(id);
    this.viewKey = "";
    this.viewRootRollup = null;
  }

  findById(id: string): Record<string, unknown> | undefined {
    return this.byId.get(id);
  }

  /** Drop cached filtered/sorted view (next getRows / stub paint rebuilds). */
  invalidateView(): void {
    this.view = [];
    this.viewKey = "";
    this.viewRootRollup = null;
  }

  /**
   * Leaf at a root-store index for stub/loading cells.
   * Only valid for flat (ungrouped) root stores.
   */
  getLeafAt(index: number): Record<string, unknown> | undefined {
    if (!this.ready || index < 0) return undefined;
    const src = this.viewKey ? this.view : this.all;
    return src[index];
  }

  /**
   * Sync flat / leaf / group-header slice, or null when this request must go
   * to the worker (pivot, unsafe filters, abs sort, rowKeep, tree).
   */
  tryGetRows(req: MirrorGetRowsRequest): MirrorSlice | null {
    if (!this.ready || this.all.length === 0) return null;
    if (req.pivotMode || req.treeData || req.absSort) return null;
    if (req.rowKeepExpression) return null;

    const plan = mapFilterModel(req.filterModel);
    if (!filterPlanIsMainThreadSafe(plan)) return null;

    const rowGroupCols = req.rowGroupCols ?? [];
    const groupKeys = req.groupKeys ?? [];
    const isGroupHeader =
      rowGroupCols.length > 0 && groupKeys.length < rowGroupCols.length;

    const key = JSON.stringify({
      kind: isGroupHeader ? "group" : "leaf",
      g: groupKeys,
      rg: rowGroupCols.map((c) => c.field),
      f: req.filterModel,
      s: req.sortModel,
      v: (req.valueCols ?? []).map((c) => `${c.field}:${c.aggFunc}`),
      q: req.quickFilterText ?? "",
      qf: req.quickFilterFields ?? null,
    });
    if (key !== this.viewKey) {
      const leaves = this.filterLeaves(req, plan);
      if (!leaves) return null;
      if (isGroupHeader) {
        const groupField = rowGroupCols[groupKeys.length]?.field;
        if (!groupField) return null;
        this.view = aggregateMirrorGroupRows(
          leaves,
          groupField,
          req.valueCols ?? [],
          req.sortModel ?? [],
        );
      } else {
        this.view = this.sortLeaves(leaves, req.sortModel ?? []);
      }
      this.viewKey = key;
      this.viewRootRollup = null;
      // Root rollup once per view shape — not on every block getRows.
      if (groupKeys.length === 0 && (req.valueCols?.length ?? 0) > 0) {
        const { totals, aggregates } = aggregateMirrorTotals(
          leaves,
          req.valueCols ?? [],
        );
        this.viewRootRollup = {
          totals,
          aggregates,
          filteredRowCount: leaves.length,
        };
      }
    }

    const start = Math.max(0, req.startRow);
    const end = Math.max(start, req.endRow);
    const slice: MirrorSlice = {
      rowData: this.view.slice(start, end),
      rowCount: this.view.length,
    };

    if (this.viewRootRollup && groupKeys.length === 0) {
      slice.totals = this.viewRootRollup.totals;
      slice.aggregates = this.viewRootRollup.aggregates;
      slice.filteredRowCount = this.viewRootRollup.filteredRowCount;
    }

    return slice;
  }

  /**
   * All group rows for a store route (used to surgically patch header aggs
   * after leaf ticks without soft-refreshing the store).
   */
  getGroupRowsForRoute(
    req: Omit<MirrorGetRowsRequest, "startRow" | "endRow">,
  ): Record<string, unknown>[] | null {
    const slice = this.tryGetRows({
      ...req,
      startRow: 0,
      endRow: Number.MAX_SAFE_INTEGER,
    });
    if (!slice) return null;
    const rowGroupCols = req.rowGroupCols ?? [];
    const groupKeys = req.groupKeys ?? [];
    if (!(rowGroupCols.length > 0 && groupKeys.length < rowGroupCols.length)) {
      return null;
    }
    return slice.rowData;
  }

  private filterLeaves(
    req: MirrorGetRowsRequest,
    plan: ReturnType<typeof mapFilterModel>,
  ): Record<string, unknown>[] | null {
    const rowGroupCols = req.rowGroupCols ?? [];
    const groupKeys = req.groupKeys ?? [];

    const ancestorFilters: PerspectiveFilter[] = [];
    for (let i = 0; i < groupKeys.length; i++) {
      const field = rowGroupCols[i]?.field;
      if (!field) return null;
      ancestorFilters.push([field, "==", groupKeys[i]!]);
    }

    const qFields = req.quickFilterFields;

    return this.all.filter((row) => {
      for (const f of ancestorFilters) {
        if (!rowMatchesFilterPlan({ filters: [f] }, row)) return false;
      }
      if (!rowMatchesFilterPlan(plan, row)) return false;
      const fields =
        qFields && qFields.length > 0
          ? qFields
          : Object.keys(row).filter((k) => k !== this.idField);
      if (!rowMatchesQuickFilter(row, req.quickFilterText, fields)) return false;
      return true;
    });
  }

  private sortLeaves(
    rows: Record<string, unknown>[],
    sortModel: { colId: string; sort: string }[],
  ): Record<string, unknown>[] {
    if (sortModel.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const s of sortModel) {
        const field = s.colId;
        const av = a[field];
        const bv = b[field];
        if (av == null && bv == null) continue;
        if (av == null) return 1;
        if (bv == null) return -1;
        let cmp = 0;
        if (typeof av === "number" && typeof bv === "number") {
          cmp = av - bv;
        } else {
          cmp = String(av).localeCompare(String(bv), undefined, {
            numeric: true,
            sensitivity: "base",
          });
        }
        if (cmp !== 0) return s.sort === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }
}
