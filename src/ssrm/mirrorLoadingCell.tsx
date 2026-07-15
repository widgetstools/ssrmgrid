import type {
  ILoadingCellRendererComp,
  ILoadingCellRendererParams,
  IRowNode,
} from "ag-grid-community";

import type { RowMirror } from "./rowMirror";

export type MirrorLoadingContext = {
  rowMirror?: RowMirror | null;
};

/** Set by SSRMGrid so loaders do not depend on context surviving setGridOption merges. */
let activeRowMirror: RowMirror | null = null;

export function setActiveRowMirror(mirror: RowMirror | null): void {
  activeRowMirror = mirror;
}

export function getActiveRowMirror(): RowMirror | null {
  return activeRowMirror;
}

/**
 * Text for an SSRM stub/loading cell from the main-thread leaf book.
 * Root store / stubs only — grouped child stores use local indices.
 */
export function stubDisplayFromMirror(
  mirror: RowMirror | null | undefined,
  node: Pick<IRowNode, "rowIndex" | "parent" | "stub" | "level">,
  field: string | undefined | null,
): string {
  const book = mirror ?? activeRowMirror;
  if (!book?.isReady || field == null || field === "") return "";
  if (node.rowIndex == null || node.rowIndex < 0) return "";

  // Grouped child stores use local indices that may not match the root mirror view.
  // Stubs always paint (they are placeholders for a store index about to load).
  if (!node.stub) {
    const level = node.level ?? 0;
    if (level > 0) return "";
    if (node.parent != null && node.parent.level !== -1) return "";
  }

  const row = book.getLeafAt(node.rowIndex);
  if (!row) return "";
  const v = row[field];
  if (v == null) return "";
  return String(v);
}

function fieldFromParams(params: ILoadingCellRendererParams): string | undefined {
  return (
    params.colDef?.field ??
    params.column?.getColDef()?.field ??
    params.column?.getColId() ??
    undefined
  );
}

/**
 * Imperative loading-cell renderer. AG Grid often creates the stub before
 * `rowIndex` is assigned; functional cells that return once stay blank forever.
 * `refresh` re-paints when the node/index updates.
 */
export class MirrorLoadingCellRenderer implements ILoadingCellRendererComp {
  private gui!: HTMLSpanElement;
  private params!: ILoadingCellRendererParams;

  init(params: ILoadingCellRendererParams): void {
    this.params = params;
    this.gui = document.createElement("span");
    this.gui.className = "ssrm-mirror-loading-cell";
    this.paint();
  }

  getGui(): HTMLElement {
    return this.gui;
  }

  refresh(params: ILoadingCellRendererParams): boolean {
    this.params = params;
    this.paint();
    return true;
  }

  private paint(): void {
    const ctx = this.params.context as MirrorLoadingContext | undefined;
    const mirror = ctx?.rowMirror ?? activeRowMirror;
    this.gui.textContent = stubDisplayFromMirror(
      mirror,
      this.params.node,
      fieldFromParams(this.params),
    );
  }
}
