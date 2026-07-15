/**
 * CSRM-style quick-filter match highlighting: wrap matching substrings in
 * <mark class="ssrm-qf-mark">. Escape first so values stay text-safe.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Merge overlapping [start, end) ranges. */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!;
    const last = out[out.length - 1]!;
    if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Build HTML with <mark> around every case-insensitive occurrence of any token.
 * Empty tokens → plain escaped text.
 */
export function highlightQuickFilterHtml(
  text: string,
  tokens: string[],
): string {
  if (!text) return "";
  const needles = tokens.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return escapeHtml(text);

  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const tok of needles) {
    let from = 0;
    while (from < lower.length) {
      const i = lower.indexOf(tok, from);
      if (i < 0) break;
      ranges.push([i, i + tok.length]);
      from = i + tok.length;
    }
  }
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return escapeHtml(text);

  let out = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    out += escapeHtml(text.slice(cursor, start));
    out += `<mark class="ssrm-qf-mark">${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  out += escapeHtml(text.slice(cursor));
  return out;
}
