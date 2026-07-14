/**
 * Escape a string for embedding inside a Perspective expression string literal.
 * Perspective expressions use SINGLE quotes for string literals (double quotes
 * denote a COLUMN reference), so we escape backslashes and single quotes.
 */
export function escapePerspectiveString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Synthetic boolean column used for OR / quick-filter expression match. */
export const OR_MATCH_EXPR = "__ssrm_or_match";
export const QUICK_FILTER_EXPR = "__ssrm_quick_filter";
export const ABS_SORT_PREFIX = "__ssrm_abs_";

export function absSortExprName(field: string): string {
  return `${ABS_SORT_PREFIX}${field}`;
}
