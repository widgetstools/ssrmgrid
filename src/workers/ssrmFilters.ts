/**
 * Map AG Grid SSRM filterModel (simple, set, multi, advanced) → Perspective filters.
 * Cross-field OR is pushed into Perspective via a boolean expression column when
 * possible; otherwise we fall back to postPredicate (client filter after fetch).
 */

import {
  escapePerspectiveString,
  OR_MATCH_EXPR,
  QUICK_FILTER_EXPR,
} from "./perspectiveExpr";

export type PerspectiveFilter = [
  string,
  string,
  string | number | boolean | null | string[],
];

export type FilterPlan = {
  filters?: PerspectiveFilter[];
  /** Perspective `filter_op` — applies to all perspective filters. */
  filterOp?: "and" | "or";
  /** Extra Perspective expressions (e.g. OR / quick-filter match columns). */
  expressions?: Record<string, string>;
  /**
   * When set, host must fetch the full filtered (or unfiltered) set, apply this
   * predicate, then sort/slice. Used for nested Advanced Filter OR/AND mixes
   * that cannot be expressed as Perspective expressions.
   */
  postPredicate?: (row: Record<string, unknown>) => boolean;
};

function literal(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return `"${escapePerspectiveString(value)}"`;
}

/** Convert a Perspective filter tuple into an expression fragment, or null. */
export function perspectiveFilterToExpr(
  filter: PerspectiveFilter,
): string | null {
  const [field, op, operand] = filter;
  const col = `"${field}"`;
  switch (op) {
    case "is null":
      return `${col} == null`;
    case "is not null":
      return `${col} != null`;
    case "==":
      return `${col} == ${literal(operand as string | number | boolean | null)}`;
    case "!=":
      return `${col} != ${literal(operand as string | number | boolean | null)}`;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return `${col} ${op} ${literal(operand as string | number | boolean | null)}`;
    case "contains":
      return `contains(lower(string(${col})), ${literal(String(operand ?? "").toLowerCase())})`;
    case "!contains":
      return `not contains(lower(string(${col})), ${literal(String(operand ?? "").toLowerCase())})`;
    case "starts with":
      return `starts_with(lower(string(${col})), ${literal(String(operand ?? "").toLowerCase())})`;
    case "ends with":
      return `ends_with(lower(string(${col})), ${literal(String(operand ?? "").toLowerCase())})`;
    case "in": {
      if (!Array.isArray(operand) || operand.length === 0) return null;
      return `(${operand.map((v) => `${col} == ${literal(String(v))}`).join(" or ")})`;
    }
    default:
      return null;
  }
}

function orExpressionPlan(
  filters: PerspectiveFilter[],
  predicates: Array<(row: Record<string, unknown>) => boolean> = [],
): FilterPlan {
  if (predicates.length > 0) {
    return {
      postPredicate: (row) => {
        const filterOk =
          filters.length === 0 ||
          filters.some((f) => evalPerspectiveFilter(f, row));
        return filterOk || predicates.some((p) => p(row));
      },
    };
  }
  const parts = filters.map(perspectiveFilterToExpr);
  if (parts.some((p) => p == null) || parts.length === 0) {
    return {
      postPredicate: (row) =>
        filters.some((f) => evalPerspectiveFilter(f, row)),
    };
  }
  return {
    expressions: { [OR_MATCH_EXPR]: parts.join(" or ") },
    filters: [[OR_MATCH_EXPR, "==", true]],
    filterOp: "and",
  };
}

/**
 * Server-side quick filter: OR of case-insensitive contains across text columns.
 * Implemented as a Perspective expression so the engine filters before slice.
 */
export function quickFilterToPlan(
  text: string | null | undefined,
  stringColumns: string[],
): FilterPlan {
  const needle = (text ?? "").trim().toLowerCase();
  if (!needle || stringColumns.length === 0) return {};
  const lit = literal(needle);
  const parts = stringColumns.map(
    (field) => `contains(lower(string("${field}")), ${lit})`,
  );
  return {
    expressions: { [QUICK_FILTER_EXPR]: parts.join(" or ") },
    filters: [[QUICK_FILTER_EXPR, "==", true]],
    filterOp: "and",
  };
}

const TEXT_OP: Record<string, string> = {
  equals: "==",
  notEqual: "!=",
  contains: "contains",
  notContains: "!contains",
  startsWith: "starts with",
  endsWith: "ends with",
  blank: "is null",
  notBlank: "is not null",
};

const NUMBER_OP: Record<string, string> = {
  equals: "==",
  notEqual: "!=",
  lessThan: "<",
  lessThanOrEqual: "<=",
  greaterThan: ">",
  greaterThanOrEqual: ">=",
  blank: "is null",
  notBlank: "is not null",
};

const DATE_OP: Record<string, string> = {
  equals: "==",
  notEqual: "!=",
  lessThan: "<",
  lessThanOrEqual: "<=",
  greaterThan: ">",
  greaterThanOrEqual: ">=",
  blank: "is null",
  notBlank: "is not null",
};

function datePresetRange(
  type: string,
  now = new Date(),
): { from: string; to: string } | null {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const addDays = (d: Date, n: number) => {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  };

  switch (type) {
    case "today":
      return { from: iso(today), to: iso(today) };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: iso(y), to: iso(y) };
    }
    case "last7Days":
      return { from: iso(addDays(today, -6)), to: iso(today) };
    case "last14Days":
      return { from: iso(addDays(today, -13)), to: iso(today) };
    case "last30Days":
      return { from: iso(addDays(today, -29)), to: iso(today) };
    case "thisMonth": {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      return { from: iso(start), to: iso(today) };
    }
    case "thisYear": {
      const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      return { from: iso(start), to: iso(today) };
    }
    default:
      return null;
  }
}

function normalizeDateValue(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  if (s.length >= 10) return s.slice(0, 10);
  return s;
}

/** Convert a single simple condition into Perspective filter tuples. */
export function simpleConditionToFilters(
  field: string,
  filter: Record<string, unknown>,
): PerspectiveFilter[] {
  const filterType = filter.filterType;
  const type = typeof filter.type === "string" ? filter.type : undefined;

  if (filterType === "set") {
    const values = filter.values;
    if (!Array.isArray(values)) return [];
    if (values.length === 0) {
      return [[field, "==", "__ssrm_set_filter_empty__"]];
    }
    return [[field, "in", values.map((v) => String(v)) as unknown as string]];
  }

  if (type === "blank") {
    return [[field, "is null", null]];
  }
  if (type === "notBlank") {
    return [[field, "is not null", null]];
  }

  if (filterType === "text" || filterType === "agTextColumnFilter") {
    if (!type) return [];
    const op = TEXT_OP[type];
    if (!op) return [];
    if (op === "is null" || op === "is not null") {
      return [[field, op, null]];
    }
    const value = filter.filter;
    if (typeof value !== "string" && value !== null) return [];
    return [[field, op, value]];
  }

  if (filterType === "number" || filterType === "agNumberColumnFilter") {
    if (!type) return [];
    if (type === "inRange") {
      const from = filter.filter;
      const to = filter.filterTo;
      const out: PerspectiveFilter[] = [];
      if (typeof from === "number") out.push([field, ">=", from]);
      if (typeof to === "number") out.push([field, "<=", to]);
      return out;
    }
    const op = NUMBER_OP[type];
    if (!op) return [];
    if (op === "is null" || op === "is not null") {
      return [[field, op, null]];
    }
    const value = filter.filter;
    if (typeof value !== "number" && value !== null) return [];
    return [[field, op, value]];
  }

  if (filterType === "date" || filterType === "agDateColumnFilter") {
    if (!type) return [];
    const preset = datePresetRange(type);
    if (preset) {
      return [
        [field, ">=", preset.from],
        [field, "<=", preset.to],
      ];
    }
    if (type === "inRange") {
      const from = normalizeDateValue(filter.dateFrom);
      const to = normalizeDateValue(filter.dateTo);
      const out: PerspectiveFilter[] = [];
      if (from) out.push([field, ">=", from]);
      if (to) out.push([field, "<=", to]);
      return out;
    }
    const op = DATE_OP[type];
    if (!op) return [];
    if (op === "is null" || op === "is not null") {
      return [[field, op, null]];
    }
    const from = normalizeDateValue(filter.dateFrom);
    if (from == null && filter.dateFrom !== null) return [];
    return [[field, op, from]];
  }

  return [];
}

function evalSimpleAgainstRow(
  field: string,
  filter: Record<string, unknown>,
  row: Record<string, unknown>,
): boolean {
  const value = row[field];
  const type = typeof filter.type === "string" ? filter.type : "";
  const filterType = filter.filterType;

  if (type === "blank") return value == null || value === "";
  if (type === "notBlank") return value != null && value !== "";

  if (filterType === "set") {
    const values = filter.values;
    if (!Array.isArray(values) || values.length === 0) return false;
    return values.map(String).includes(String(value));
  }

  if (filterType === "text" || filterType === "agTextColumnFilter") {
    const s = value == null ? "" : String(value);
    const needle = filter.filter == null ? "" : String(filter.filter);
    switch (type) {
      case "equals":
        return s === needle;
      case "notEqual":
        return s !== needle;
      case "contains":
        return s.includes(needle);
      case "notContains":
        return !s.includes(needle);
      case "startsWith":
        return s.startsWith(needle);
      case "endsWith":
        return s.endsWith(needle);
      default:
        return true;
    }
  }

  if (filterType === "number" || filterType === "agNumberColumnFilter") {
    const n = typeof value === "number" ? value : Number(value);
    const f = filter.filter as number | null | undefined;
    const t = filter.filterTo as number | null | undefined;
    if (type === "inRange") {
      if (typeof f === "number" && !(n >= f)) return false;
      if (typeof t === "number" && !(n <= t)) return false;
      return Number.isFinite(n);
    }
    if (!Number.isFinite(n) && f !== null) return false;
    switch (type) {
      case "equals":
        return n === f;
      case "notEqual":
        return n !== f;
      case "lessThan":
        return typeof f === "number" && n < f;
      case "lessThanOrEqual":
        return typeof f === "number" && n <= f;
      case "greaterThan":
        return typeof f === "number" && n > f;
      case "greaterThanOrEqual":
        return typeof f === "number" && n >= f;
      default:
        return true;
    }
  }

  if (filterType === "date" || filterType === "agDateColumnFilter") {
    const s = normalizeDateValue(value) ?? "";
    const preset = datePresetRange(type);
    if (preset) return s >= preset.from && s <= preset.to;
    if (type === "inRange") {
      const from = normalizeDateValue(filter.dateFrom);
      const to = normalizeDateValue(filter.dateTo);
      if (from && s < from) return false;
      if (to && s > to) return false;
      return true;
    }
    const from = normalizeDateValue(filter.dateFrom);
    switch (type) {
      case "equals":
        return s === from;
      case "notEqual":
        return s !== from;
      case "lessThan":
        return from != null && s < from;
      case "lessThanOrEqual":
        return from != null && s <= from;
      case "greaterThan":
        return from != null && s > from;
      case "greaterThanOrEqual":
        return from != null && s >= from;
      default:
        return true;
    }
  }

  return true;
}

function columnFilterToPlan(
  field: string,
  raw: Record<string, unknown>,
): FilterPlan {
  // Compound simple filter: { operator, conditions: [...] }
  if (Array.isArray(raw.conditions) && typeof raw.operator === "string") {
    const conditions = raw.conditions as Record<string, unknown>[];
    const op = raw.operator.toUpperCase() === "OR" ? "or" : "and";

    // OR of equals → single `in` filter (Perspective-friendly).
    if (
      op === "or" &&
      conditions.every(
        (c) =>
          (c.filterType === "text" ||
            c.filterType === "agTextColumnFilter" ||
            c.filterType === "set" ||
            !c.filterType) &&
          (c.type === "equals" || c.filterType === "set"),
      )
    ) {
      const values = new Set<string>();
      for (const c of conditions) {
        if (c.filterType === "set" && Array.isArray(c.values)) {
          for (const v of c.values) values.add(String(v));
        } else if (c.filter != null) {
          values.add(String(c.filter));
        }
      }
      if (values.size > 0) {
        return {
          filters: [[field, "in", [...values] as unknown as string]],
        };
      }
    }

    if (op === "and") {
      const filters: PerspectiveFilter[] = [];
      for (const c of conditions) {
        filters.push(
          ...simpleConditionToFilters(field, {
            ...c,
            filterType: c.filterType ?? raw.filterType,
          }),
        );
      }
      return { filters, filterOp: "and" };
    }

    // OR of non-equals → Perspective boolean expression when expressible.
    const orFilters: PerspectiveFilter[] = [];
    for (const c of conditions) {
      orFilters.push(
        ...simpleConditionToFilters(field, {
          ...c,
          filterType: c.filterType ?? raw.filterType,
        }),
      );
    }
    return orExpressionPlan(orFilters);
  }

  // Multi filter
  if (raw.filterType === "multi" && Array.isArray(raw.filterModels)) {
    const plans = (raw.filterModels as unknown[])
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .map((m) => columnFilterToPlan(field, m));
    return mergeFilterPlans(plans, "and");
  }

  return { filters: simpleConditionToFilters(field, raw) };
}

function evalAdvancedNode(
  node: Record<string, unknown>,
  row: Record<string, unknown>,
): boolean {
  if (node.filterType === "join") {
    const type = String(node.type ?? "AND").toUpperCase();
    const conditions = Array.isArray(node.conditions)
      ? (node.conditions as Record<string, unknown>[])
      : [];
    if (type === "OR") {
      return conditions.some((c) => evalAdvancedNode(c, row));
    }
    return conditions.every((c) => evalAdvancedNode(c, row));
  }

  const colId = typeof node.colId === "string" ? node.colId : "";
  if (!colId) return true;
  return evalSimpleAgainstRow(colId, node, row);
}

function advancedToPlan(model: Record<string, unknown>): FilterPlan {
  // Pure join of simple columns with AND → perspective AND filters
  if (model.filterType === "join") {
    const type = String(model.type ?? "AND").toUpperCase();
    const conditions = Array.isArray(model.conditions)
      ? (model.conditions as Record<string, unknown>[])
      : [];

    const allSimple =
      conditions.length > 0 &&
      conditions.every(
        (c) =>
          c.filterType !== "join" &&
          typeof c.colId === "string" &&
          !Array.isArray(c.conditions),
      );

    if (allSimple && type === "AND") {
      const filters: PerspectiveFilter[] = [];
      for (const c of conditions) {
        filters.push(...simpleConditionToFilters(String(c.colId), c));
      }
      return { filters, filterOp: "and" };
    }

    if (allSimple && type === "OR") {
      const byField = new Map<string, Record<string, unknown>[]>();
      for (const c of conditions) {
        const colId = String(c.colId);
        const list = byField.get(colId) ?? [];
        list.push(c);
        byField.set(colId, list);
      }
      if (
        byField.size === 1 &&
        conditions.every((c) => c.type === "equals" || c.filterType === "set")
      ) {
        const [field, list] = [...byField.entries()][0]!;
        const values = new Set<string>();
        for (const c of list) {
          if (c.filterType === "set" && Array.isArray(c.values)) {
            for (const v of c.values) values.add(String(v));
          } else if (c.filter != null) {
            values.add(String(c.filter));
          }
        }
        return {
          filters: [[field, "in", [...values] as unknown as string]],
        };
      }

      const orFilters: PerspectiveFilter[] = [];
      for (const c of conditions) {
        orFilters.push(...simpleConditionToFilters(String(c.colId), c));
      }
      return orExpressionPlan(orFilters);
    }

    // Nested joins — keep correctness via client predicate.
    return { postPredicate: (row) => evalAdvancedNode(model, row) };
  }

  if (typeof model.colId === "string") {
    return {
      filters: simpleConditionToFilters(model.colId, model),
    };
  }

  return {};
}

export function mergeFilterPlans(
  plans: FilterPlan[],
  defaultOp: "and" | "or" = "and",
): FilterPlan {
  const filters: PerspectiveFilter[] = [];
  const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
  const expressions: Record<string, string> = {};
  let sawOr = false;
  let sawAnd = false;

  for (const plan of plans) {
    if (plan.filters?.length) {
      filters.push(...plan.filters);
    }
    if (plan.postPredicate) {
      predicates.push(plan.postPredicate);
    }
    if (plan.expressions) {
      Object.assign(expressions, plan.expressions);
    }
    if (plan.filterOp === "or") sawOr = true;
    if (plan.filterOp === "and") sawAnd = true;
  }

  if (defaultOp === "or" || (sawOr && !sawAnd && Object.keys(expressions).length === 0)) {
    return orExpressionPlan(filters, predicates);
  }

  if (sawOr && sawAnd) {
    // Mixed AND/OR without a shared expression — evaluate client-side.
    return {
      postPredicate: (row) => {
        const perspOk =
          filters.length === 0 ||
          filters.every((f) => evalPerspectiveFilter(f, row));
        const predOk =
          predicates.length === 0 || predicates.every((p) => p(row));
        return perspOk && predOk;
      },
    };
  }

  return {
    filters: filters.length > 0 ? filters : undefined,
    filterOp: filters.length > 0 ? "and" : undefined,
    expressions: Object.keys(expressions).length > 0 ? expressions : undefined,
    postPredicate:
      predicates.length === 0
        ? undefined
        : (row) => predicates.every((p) => p(row)),
  };
}

function evalPerspectiveFilter(
  filter: PerspectiveFilter,
  row: Record<string, unknown>,
): boolean {
  const [field, op, operand] = filter;
  const value = row[field];
  switch (op) {
    case "is null":
      return value == null || value === "";
    case "is not null":
      return value != null && value !== "";
    case "==":
      return value == operand;
    case "!=":
      return value != operand;
    case "<":
      return value != null && (value as never) < (operand as never);
    case "<=":
      return value != null && (value as never) <= (operand as never);
    case ">":
      return value != null && (value as never) > (operand as never);
    case ">=":
      return value != null && (value as never) >= (operand as never);
    case "contains":
      return String(value ?? "").includes(String(operand ?? ""));
    case "!contains":
      return !String(value ?? "").includes(String(operand ?? ""));
    case "starts with":
      return String(value ?? "").startsWith(String(operand ?? ""));
    case "ends with":
      return String(value ?? "").endsWith(String(operand ?? ""));
    case "in":
      return Array.isArray(operand)
        ? operand.map(String).includes(String(value))
        : false;
    default:
      return true;
  }
}

/**
 * Map AG Grid SSRM filterModel to a FilterPlan.
 * Supports column filters map OR AdvancedFilterModel (join tree).
 */
export function mapFilterModel(filterModel: Record<string, unknown> | null | undefined): FilterPlan {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return {};
  }

  // Advanced Filter is a single join/col node, not a colId→filter map
  if (
    filterModel.filterType === "join" ||
    (typeof filterModel.colId === "string" && filterModel.filterType)
  ) {
    return advancedToPlan(filterModel);
  }

  const plans: FilterPlan[] = [];
  for (const [field, raw] of Object.entries(filterModel)) {
    if (!raw || typeof raw !== "object") continue;
    plans.push(columnFilterToPlan(field, raw as Record<string, unknown>));
  }

  return mergeFilterPlans(plans, "and");
}

export function applyPostPredicate(
  rows: Record<string, unknown>[],
  postPredicate?: (row: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  if (!postPredicate) return rows;
  return rows.filter(postPredicate);
}
