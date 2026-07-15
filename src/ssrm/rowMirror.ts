import {
  filterPlanIsMainThreadSafe,
  mapFilterModel,
  rowMatchesFilterPlan,
  type PerspectiveFilter,
} from "../workers/ssrmFilters";

export type MirrorGetRowsRequest = {
  startRow: number;
  endRow: number;
  rowGroupCols: { id: string; field: string }[];
  groupKeys: string[];
  pivotMode: boolean;
  filterModel: Record<string, unknown>;
  sortModel: { colId: string; sort: string }[];
  quickFilterText?: string;
  quickFilterFields?: string[];
  treeData?: boolean;
  absSort?: boolean;
  rowKeepExpression?: string;
};

export type MirrorSlice = {
  rowData: Record<string, unknown>[];
  rowCount: number;
};

/**
 * Main-thread ordered leaf book for sync SSRM getRows (Perspective-like scroll).
 * Flat / fully-expanded leaf requests slice here without a worker round-trip.
 */
export class RowMirror {
  private idField = "id";
  private byId = new Map<string, Record<string, unknown>>();
  /** Full book in ingest order (ids stable). */
  private all: Record<string, unknown>[] = [];
  /** Filtered + sorted leaf view for the active query shape. */
  private view: Record<string, unknown>[] = [];
  private viewKey = "";
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
        // New leaf — append.
        const row = { ...patch };
        this.byId.set(id, row);
        this.all.push(row);
        this.viewKey = ""; // view stale
        merged.push(row);
        continue;
      }
      Object.assign(existing, patch);
      merged.push(existing);
    }
    return merged;
  }

  removeByIds(ids: (string | number)[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids.map(String));
    this.all = this.all.filter((r) => !drop.has(String(r[this.idField])));
    for (const id of drop) this.byId.delete(id);
    this.viewKey = "";
  }

  findById(id: string): Record<string, unknown> | undefined {
    return this.byId.get(id);
  }

  /** Drop cached filtered/sorted view (next getRows / stub paint rebuilds). */
  invalidateView(): void {
    this.view = [];
    this.viewKey = "";
  }

  /**
   * Leaf at a root-store index for stub/loading cells (AG Grid defers getRows
   * via setTimeout — stubs must paint from the mirror or the viewport goes blank).
   * Prefers the active filtered/sorted view when built; otherwise ingest order.
   */
  getLeafAt(index: number): Record<string, unknown> | undefined {
    if (!this.ready || index < 0) return undefined;
    const src = this.viewKey ? this.view : this.all;
    return src[index];
  }

  /**
   * Sync leaf/flat slice, or null when this request must go to the worker
   * (group headers, pivot, unsafe filters, abs sort, rowKeep, tree).
   */
  tryGetRows(req: MirrorGetRowsRequest): MirrorSlice | null {
    if (!this.ready || this.all.length === 0) return null;
    if (req.pivotMode || req.treeData || req.absSort) return null;
    if (req.rowKeepExpression) return null;

    const rowGroupCols = req.rowGroupCols ?? [];
    const groupKeys = req.groupKeys ?? [];
    // Group header levels still use the worker.
    if (rowGroupCols.length > 0 && groupKeys.length < rowGroupCols.length) {
      return null;
    }

    const plan = mapFilterModel(req.filterModel);
    if (!filterPlanIsMainThreadSafe(plan)) return null;

    const key = JSON.stringify({
      g: groupKeys,
      rg: rowGroupCols.map((c) => c.field),
      f: req.filterModel,
      s: req.sortModel,
      q: req.quickFilterText ?? "",
      qf: req.quickFilterFields ?? null,
    });
    if (key !== this.viewKey) {
      const built = this.buildView(req, plan);
      if (!built) return null;
      this.view = built;
      this.viewKey = key;
    }

    const start = Math.max(0, req.startRow);
    const end = Math.max(start, req.endRow);
    return {
      // Share row objects with the mirror — avoids cloning 50×N fields on every
      // block. AG Grid edits should flow through cellValueChanged / tx paths.
      rowData: this.view.slice(start, end),
      rowCount: this.view.length,
    };
  }

  private buildView(
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

    const q = (req.quickFilterText ?? "").trim().toLowerCase();
    const qFields = req.quickFilterFields;

    let rows = this.all.filter((row) => {
      for (const f of ancestorFilters) {
        if (!rowMatchesFilterPlan({ filters: [f] }, row)) return false;
      }
      if (!rowMatchesFilterPlan(plan, row)) return false;
      if (q) {
        const fields =
          qFields && qFields.length > 0
            ? qFields
            : Object.keys(row).filter((k) => k !== this.idField);
        const hit = fields.some((field) =>
          String(row[field] ?? "")
            .toLowerCase()
            .includes(q),
        );
        if (!hit) return false;
      }
      return true;
    });

    const sortModel = req.sortModel ?? [];
    if (sortModel.length > 0) {
      rows = [...rows].sort((a, b) => {
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

    return rows;
  }
}
