/**
 * AG Grid SSRM `update` transactions replace the row's `data` object.
 * Perspective / demo ticks send partial patches (id + changed fields).
 * Merge onto the existing row so categorical columns are not wiped.
 */
export function mergeLeafUpdateRows(
  idField: string,
  patches: Record<string, unknown>[],
  getExisting: (id: string) => Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const merged: Record<string, unknown>[] = [];
  for (const patch of patches) {
    const rawId = patch[idField];
    if (rawId == null || rawId === "") continue;
    const id = String(rawId);
    const existing = getExisting(id);
    merged.push(existing ? { ...existing, ...patch } : patch);
  }
  return merged;
}
