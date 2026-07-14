// In-memory demo data + a tick generator. This stands in for ANY data source —
// the point of <SSRMGrid> is that the consumer owns the feed and just calls
// applyTransaction. Here we synthesize a positions-style blotter and tick a
// random slice of it at a tunable rate.

export interface DemoRow extends Record<string, unknown> {
  id: string;
  book: string;
  trader: string;
  region: string;
  currency: string;
  instrumentType: string;
  price: number;
  quantity: number;
  notional: number;
  pnl: number;
  dailyPnl: number;
}

const BOOKS = ["Rates-A", "Rates-B", "Credit-A", "Credit-B", "FX-A", "FX-B", "Eq-A", "Eq-B"];
const TRADERS = ["A. Chen", "N. Williams", "R. Patel", "S. Kim", "M. Rossi", "T. Ito", "L. Diaz", "K. Novak"];
const REGIONS = ["Americas", "EMEA", "APAC"];
const CCYS = ["USD", "EUR", "GBP", "JPY"];
const TYPES = ["Bond", "Swap", "Future", "Option", "Equity"];

// Deterministic LCG so the initial snapshot is stable across reloads.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const pick = <T,>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;

export function generateRows(count: number): DemoRow[] {
  const rng = lcg(42);
  const rows: DemoRow[] = [];
  for (let i = 0; i < count; i++) {
    const price = 50 + rng() * 150;
    const quantity = Math.round((rng() * 2 - 1) * 10000);
    const notional = Math.round(price * quantity);
    rows.push({
      id: `POS-${String(i).padStart(6, "0")}`,
      book: pick(rng, BOOKS),
      trader: pick(rng, TRADERS),
      region: pick(rng, REGIONS),
      currency: pick(rng, CCYS),
      instrumentType: pick(rng, TYPES),
      price: Math.round(price * 100) / 100,
      quantity,
      notional,
      pnl: Math.round((rng() * 2 - 1) * 50000),
      dailyPnl: Math.round((rng() * 2 - 1) * 8000),
    });
  }
  return rows;
}

/**
 * Start ticking. Every ~50ms, mutate `perTick` random rows' price/pnl and call
 * `onTick` with the (partial) updated rows. `ratePerSec` controls how many rows
 * change per second. Returns a stop function.
 */
export function startTicking(
  rows: DemoRow[],
  ratePerSec: number,
  onTick: (updated: Partial<DemoRow>[]) => void,
): () => void {
  const rng = lcg(7);
  const intervalMs = 50;
  const perTick = Math.max(1, Math.round((ratePerSec * intervalMs) / 1000));
  const handle = window.setInterval(() => {
    const updates: Partial<DemoRow>[] = [];
    for (let k = 0; k < perTick; k++) {
      const row = rows[Math.floor(rng() * rows.length)]!;
      const drift = (rng() * 2 - 1) * 0.5;
      row.price = Math.max(1, Math.round((row.price + drift) * 100) / 100);
      row.notional = Math.round(row.price * row.quantity);
      row.pnl = Math.round(row.pnl + (rng() * 2 - 1) * 500);
      row.dailyPnl = Math.round(row.dailyPnl + (rng() * 2 - 1) * 200);
      // Partial update — only the key + changed fields (Perspective merges by id).
      updates.push({
        id: row.id,
        price: row.price,
        notional: row.notional,
        pnl: row.pnl,
        dailyPnl: row.dailyPnl,
      });
    }
    onTick(updates);
  }, intervalMs);
  return () => window.clearInterval(handle);
}
