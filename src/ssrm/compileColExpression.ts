/**
 * CSRM-style string expression helpers for SSRM loaded rows, plus approximations
 * that map simple client getters into Perspective expressions for server ops.
 *
 * AG Grid evaluates some ColDef callbacks as string bodies (valueGetter).
 * editable / cellStyle / cellClassRules typically need functions — we compile
 * those here so MarketsGrid / config tooling can keep string DSLs.
 */

const IDENT_RE = /^[a-zA-Z_][\w]*$/;

/** Compile a ColDef-style expression body against AG Grid params. */
export function compileExpression(
  body: string,
): (params: Record<string, unknown>) => unknown {
  const src = body.trim();
  // Params as scope: data, node, column, colDef, api, context, value, ...
  // eslint-disable-next-line no-new-func -- intentional CSRM expression bridge
  const fn = new Function(
    "params",
    `"use strict";
     const { data, node, column, colDef, api, context, value, getValue, rowIndex } = params;
     return (${src});`,
  ) as (params: Record<string, unknown>) => unknown;
  return (params) => {
    try {
      return fn(params);
    } catch {
      return undefined;
    }
  };
}

export function compileEditableExpression(
  body: string,
): (params: Record<string, unknown>) => boolean {
  const evalExpr = compileExpression(body);
  return (params) => Boolean(evalExpr(params));
}

export function compileCellStyleExpression(
  body: string,
): (params: Record<string, unknown>) => Record<string, string> | null | undefined {
  const evalExpr = compileExpression(body);
  return (params) => {
    const out = evalExpr(params);
    if (out == null) return null;
    if (typeof out === "object") return out as Record<string, string>;
    return undefined;
  };
}

export function compileCellClassRuleExpression(
  body: string,
): (params: Record<string, unknown>) => boolean {
  return compileEditableExpression(body);
}

/**
 * Map a simple JS valueGetter body onto a Perspective expression.
 * Handles `data.field` and arithmetic over `data.*` / bracket-free idents.
 * Returns null when the expression is too rich for a safe rewrite.
 */
export function tryValueGetterToPerspective(expr: string): string | null {
  const s = expr.trim();
  if (!s || s.includes("=>") || s.includes("function") || s.includes("return ")) {
    return null;
  }
  // Pure `data.field` is a base-column alias, not a calculated column.
  if (/^data\.[a-zA-Z_][\w]*$/.test(s)) return null;

  // data.a + data.b * …  — rewrite data.X → "X"
  if (!/\bdata\./.test(s)) return null;
  if (!/^[\w.\s+\-*/%()!<>=&|?:]+$/.test(s)) return null;
  // Must involve an operator / call site beyond a single identifier.
  if (!/[+\-*/%?:]|&&|\|\|/.test(s)) return null;
  return s.replace(/\bdata\.([a-zA-Z_][\w]*)/g, '"$1"');
}

/**
 * Map AG Grid calculatedExpression (`[revenue] - [cost]`) to Perspective
 * (`"revenue" - "cost"`). Same-row bracket refs only.
 */
export function tryCalculatedExpressionToPerspective(
  expr: string,
): string | null {
  const s = expr.trim();
  if (!s || !s.includes("[")) return null;
  // Reject Excel-ish range / sheet refs that Perspective can't evaluate.
  if (/[!]/.test(s) || /\[[A-Z]+\d+/.test(s)) return null;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "[") {
      const end = s.indexOf("]", i + 1);
      if (end < 0) return null;
      const ref = s.slice(i + 1, end).trim();
      if (!IDENT_RE.test(ref)) return null;
      out += `"${ref}"`;
      i = end + 1;
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

const KNOWN_SERVER_AGGS = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "first",
  "last",
  "median",
  "stddev",
  "var",
  "unique",
  "distinctCount",
  "weightedAvg",
  "trafficLight",
  "rag",
]);

/**
 * Resolve a ColDef / column aggFunc to a Perspective-capable name.
 * Custom JS functions cannot run over the full book under SSRM — fall back to
 * the function's name when it matches a known agg, else `"sum"`.
 */
export function resolveAggFuncName(
  aggFunc: unknown,
  opts?: { warn?: boolean },
): string {
  if (typeof aggFunc === "string" && aggFunc.trim()) {
    return aggFunc.trim();
  }
  if (typeof aggFunc === "function") {
    const name = (aggFunc as { name?: string }).name?.trim() ?? "";
    if (name && KNOWN_SERVER_AGGS.has(name)) return name;
    // trafficLightAggFunc → trafficLight heuristic
    const lower = name.toLowerCase();
    if (lower.includes("trafficlight") || lower === "rag") {
      return lower.includes("rag") && !lower.includes("traffic")
        ? "rag"
        : "trafficLight";
    }
    if (opts?.warn !== false && import.meta.env?.DEV) {
      console.warn(
        `[SSRMGrid] Custom JS aggFunc${name ? ` "${name}"` : ""} is not executed server-side; using "sum". Prefer a named Perspective agg or trafficLight/rag.`,
      );
    }
    return "sum";
  }
  return "sum";
}
