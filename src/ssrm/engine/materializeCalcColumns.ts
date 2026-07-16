/**
 * Apply calculated-column expressions onto a row copy for the custom engine.
 * Supports a Perspective-like subset: `"field"` refs, `if`/`IFS`, `not`/`and`/`or`,
 * arithmetic, and `SUM("field")` against book-level sums (share-of-total style).
 */
export function materializeCalcColumns(
  rows: Record<string, unknown>[],
  calcExpressions: Record<string, string> | undefined,
): Record<string, unknown>[] {
  if (!calcExpressions || Object.keys(calcExpressions).length === 0) {
    return rows;
  }

  const sums: Record<string, number> = {};
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        sums[k] = (sums[k] ?? 0) + v;
      }
    }
  }

  const compiled = Object.entries(calcExpressions).map(([name, expr]) => ({
    name,
    fn: compileCalcExpr(expr),
  }));

  return rows.map((row) => {
    const out = { ...row };
    for (const { name, fn } of compiled) {
      try {
        out[name] = fn(out, sums);
      } catch {
        out[name] = null;
      }
    }
    return out;
  });
}

/** Compile a keep / calc expression to a boolean (truthy) predicate. */
export function compileKeepPredicate(
  expression: string,
): (row: Record<string, unknown>) => boolean {
  const fn = compileCalcExpr(expression);
  return (row) => {
    try {
      return Boolean(fn(row, {}));
    } catch {
      return false;
    }
  };
}

export function compileCalcExpr(
  expr: string,
): (row: Record<string, unknown>, sums: Record<string, number>) => unknown {
  let body = expr.trim();
  // "col" → __row["col"]
  body = body.replace(/"([a-zA-Z_][\w]*)"/g, '__row["$1"]');
  // SUM("col") after rewrite becomes SUM(__row["col"]) — fix to __sums
  body = body.replace(
    /\bSUM\s*\(\s*__row\["([a-zA-Z_][\w]*)"\]\s*\)/gi,
    '__sums["$1"]',
  );
  body = body.replace(/\bSUM\s*\(\s*"([a-zA-Z_][\w]*)"\s*\)/gi, '__sums["$1"]');
  // Perspective helpers that are not JS keywords/functions
  body = body.replace(/\bIFS\s*\(/gi, "__ifs(");
  body = body.replace(/\bif\s*\(/g, "__if(");
  body = body.replace(/\bnot\s*\(/gi, "__not(");
  body = body.replace(/\band\s*\(/gi, "__and(");
  body = body.replace(/\bor\s*\(/gi, "__or(");
  body = body.replace(/\babs\s*\(/gi, "Math.abs(");

  // eslint-disable-next-line no-new-func -- custom-engine calc bridge
  return new Function(
    "__row",
    "__sums",
    `"use strict";
     const __if = (c, a, b) => (c ? a : b);
     const __not = (c) => !c;
     const __and = (...args) => args.every(Boolean);
     const __or = (...args) => args.some(Boolean);
     const __ifs = (...args) => {
       for (let i = 0; i + 1 < args.length; i += 2) {
         if (args[i]) return args[i + 1];
       }
       return args.length % 2 === 1 ? args[args.length - 1] : null;
     };
     try { return (${body}); } catch { return null; }`,
  ) as (row: Record<string, unknown>, sums: Record<string, number>) => unknown;
}
