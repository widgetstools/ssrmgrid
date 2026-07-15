/**
 * Slim row projection + chunked Perspective ingest for SSRM snapshots.
 *
 * Full FI position objects often carry 200+ keys; the Perspective schema only
 * needs the columns that appear in ColDefs / sample enrichment. Projecting
 * before `postMessage` cuts structured-clone cost dramatically on large books.
 */

export const SSRM_INGEST_CHUNK_SIZE = 2_500;

/** Keep only keys that exist in the Perspective schema (plus optional extras). */
export function projectRowsForSchema(
  rows: readonly Record<string, unknown>[],
  schemaKeys: readonly string[],
): Record<string, unknown>[] {
  if (rows.length === 0 || schemaKeys.length === 0) return [...rows];
  const keys = schemaKeys;
  const out: Record<string, unknown>[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const src = rows[i]!;
    const dst: Record<string, unknown> = {};
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k]!;
      if (key in src) dst[key] = src[key];
    }
    out[i] = dst;
  }
  return out;
}

export function schemaKeysFromFeed(
  schema: Record<string, unknown>,
  index?: string,
): string[] {
  const keys = Object.keys(schema);
  if (index && !keys.includes(index)) keys.push(index);
  return keys;
}

/**
 * Split a large snapshot into chunks for progressive worker ingest.
 * First chunk is meant for `setRowData` / replace; the rest for `updateRows`.
 */
export function chunkRows<T>(
  rows: readonly T[],
  chunkSize = SSRM_INGEST_CHUNK_SIZE,
): T[][] {
  if (rows.length === 0) return [];
  if (rows.length <= chunkSize) return [[...rows]];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize) as T[]);
  }
  return chunks;
}
