export function isTrafficLightAgg(aggFunc: string | undefined | null): boolean {
  return aggFunc === "trafficLight" || aggFunc === "rag";
}

export function foldTrafficLight(min: unknown, max: unknown): number | null {
  if (min == null || max == null) return null;
  const lo = typeof min === "number" ? min : Number(min);
  const hi = typeof max === "number" ? max : Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (lo === 1 && hi === 1) return 1;
  if (lo === 3 && hi === 3) return 3;
  return 2;
}
