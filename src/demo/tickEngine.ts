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
  desk: string;
  sector: string;
  issuer: string;
  ticker: string;
  cusip: string;
  country: string;
  exchange: string;
  strategy: string;
  counterparty: string;
  settlement: string;
  rating: string;
  tenor: string;
  price: number;
  quantity: number;
  notional: number;
  pnl: number;
  dailyPnl: number;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  dv01: number;
  cs01: number;
  ytm: number;
  duration: number;
  convexity: number;
  volatility: number;
  beta: number;
  volume: number;
  openInterest: number;
  margin: number;
  haircut: number;
  riskLimit: number;
  utilization: number;
}

const BOOKS = ["Rates-A", "Rates-B", "Credit-A", "Credit-B", "FX-A", "FX-B", "Eq-A", "Eq-B"];
const TRADERS = ["A. Chen", "N. Williams", "R. Patel", "S. Kim", "M. Rossi", "T. Ito", "L. Diaz", "K. Novak"];
const REGIONS = ["Americas", "EMEA", "APAC"];
const CCYS = ["USD", "EUR", "GBP", "JPY"];
const TYPES = ["Bond", "Swap", "Future", "Option", "Equity"];
const DESKS = ["Flow", "Prop", "Hedge", "Structuring"];
const SECTORS = ["Sovereign", "Financials", "Energy", "Tech", "Industrials"];
const ISSUERS = ["US Treas", "JPM", "AAPL", "XOM", "BMW", "HSBC"];
const TICKERS = ["T", "JPM", "AAPL", "XOM", "BMW", "HSBA"];
const COUNTRIES = ["US", "GB", "DE", "JP", "FR"];
const EXCHANGES = ["XNYS", "XLON", "XETR", "XTKS"];
const STRATEGIES = ["RV", "Carry", "Momentum", "Basis"];
const CPS = ["GS", "MS", "BAML", "UBS", "DB"];
const SETTLEMENTS = ["T+0", "T+1", "T+2"];
const RATINGS = ["AAA", "AA", "A", "BBB", "BB"];
const TENORS = ["2Y", "5Y", "10Y", "30Y", "Spot"];

/** Numeric fields mutated on each tick (partial patches — tests merge path). */
export const TICK_FIELDS = [
  "price",
  "notional",
  "pnl",
  "dailyPnl",
  "bid",
  "ask",
  "mid",
  "spread",
  "delta",
  "gamma",
  "vega",
  "theta",
  "dv01",
  "cs01",
  "ytm",
  "duration",
  "convexity",
  "volatility",
  "beta",
  "volume",
  "utilization",
] as const;

// Deterministic LCG so the initial snapshot is stable across reloads.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const pick = <T,>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function generateRows(count: number): DemoRow[] {
  const rng = lcg(42);
  const rows: DemoRow[] = [];
  for (let i = 0; i < count; i++) {
    const price = 50 + rng() * 150;
    const quantity = Math.round((rng() * 2 - 1) * 10000);
    const notional = Math.round(price * quantity);
    const bid = price - rng() * 0.2;
    const ask = price + rng() * 0.2;
    const issuerIdx = Math.floor(rng() * ISSUERS.length);
    rows.push({
      id: `POS-${String(i).padStart(6, "0")}`,
      book: pick(rng, BOOKS),
      trader: pick(rng, TRADERS),
      region: pick(rng, REGIONS),
      currency: pick(rng, CCYS),
      instrumentType: pick(rng, TYPES),
      desk: pick(rng, DESKS),
      sector: pick(rng, SECTORS),
      issuer: ISSUERS[issuerIdx]!,
      ticker: TICKERS[issuerIdx]!,
      cusip: `C${String(10000000 + i)}`,
      country: pick(rng, COUNTRIES),
      exchange: pick(rng, EXCHANGES),
      strategy: pick(rng, STRATEGIES),
      counterparty: pick(rng, CPS),
      settlement: pick(rng, SETTLEMENTS),
      rating: pick(rng, RATINGS),
      tenor: pick(rng, TENORS),
      price: round2(price),
      quantity,
      notional,
      pnl: Math.round((rng() * 2 - 1) * 50000),
      dailyPnl: Math.round((rng() * 2 - 1) * 8000),
      bid: round2(bid),
      ask: round2(ask),
      mid: round2((bid + ask) / 2),
      spread: round2(ask - bid),
      delta: round2((rng() * 2 - 1) * 0.8),
      gamma: round2(rng() * 0.05),
      vega: round2(rng() * 200),
      theta: round2((rng() * 2 - 1) * 50),
      dv01: round2((rng() * 2 - 1) * 10_000),
      cs01: round2((rng() * 2 - 1) * 5_000),
      ytm: round2(1 + rng() * 8),
      duration: round2(1 + rng() * 20),
      convexity: round2(rng() * 150),
      volatility: round2(5 + rng() * 40),
      beta: round2(0.5 + rng() * 1.5),
      volume: Math.round(rng() * 1_000_000),
      openInterest: Math.round(rng() * 500_000),
      margin: round2(rng() * 50_000),
      haircut: round2(rng() * 15),
      riskLimit: Math.round(100_000 + rng() * 900_000),
      utilization: round2(rng() * 100),
    });
  }
  return rows;
}

/**
 * Start ticking. Every ~50ms, mutate `perTick` random rows' measures and call
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
      row.price = Math.max(1, round2(row.price + drift));
      row.bid = round2(row.price - rng() * 0.15);
      row.ask = round2(row.price + rng() * 0.15);
      row.mid = round2((row.bid + row.ask) / 2);
      row.spread = round2(row.ask - row.bid);
      row.notional = Math.round(row.price * row.quantity);
      row.pnl = Math.round(row.pnl + (rng() * 2 - 1) * 500);
      row.dailyPnl = Math.round(row.dailyPnl + (rng() * 2 - 1) * 200);
      row.delta = round2(row.delta + (rng() * 2 - 1) * 0.01);
      row.gamma = Math.max(0, round2(row.gamma + (rng() * 2 - 1) * 0.001));
      row.vega = round2(row.vega + (rng() * 2 - 1) * 2);
      row.theta = round2(row.theta + (rng() * 2 - 1) * 0.5);
      row.dv01 = round2(row.dv01 + (rng() * 2 - 1) * 50);
      row.cs01 = round2(row.cs01 + (rng() * 2 - 1) * 25);
      row.ytm = Math.max(0, round2(row.ytm + (rng() * 2 - 1) * 0.02));
      row.duration = Math.max(0, round2(row.duration + (rng() * 2 - 1) * 0.05));
      row.convexity = Math.max(0, round2(row.convexity + (rng() * 2 - 1) * 0.5));
      row.volatility = Math.max(1, round2(row.volatility + (rng() * 2 - 1) * 0.2));
      row.beta = Math.max(0, round2(row.beta + (rng() * 2 - 1) * 0.01));
      row.volume = Math.max(0, Math.round(row.volume + (rng() * 2 - 1) * 1000));
      row.utilization = Math.min(100, Math.max(0, round2(row.utilization + (rng() * 2 - 1) * 0.5)));

      // Partial update — only the key + changed fields (Perspective merges by id).
      const patch: Partial<DemoRow> = { id: row.id };
      for (const f of TICK_FIELDS) {
        (patch as Record<string, unknown>)[f] = row[f];
      }
      updates.push(patch);
    }
    onTick(updates);
  }, intervalMs);
  return () => window.clearInterval(handle);
}
