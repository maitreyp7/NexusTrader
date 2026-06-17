import { log } from '../core/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// EARNINGS CALENDAR — NASDAQ API (free, no key required)
//
// Fetches today's actual earnings calendar from NASDAQ's public API.
// Returns exact symbols reporting today so we can skip them.
//
// We also check ±1 day (yesterday after-hours, tomorrow pre-market) because:
//   - Yesterday after-hours earnings still affect today's open
//   - Tomorrow pre-market earnings cause pre-earnings drift today
//
// Cached per session — one fetch at pre-market covers the whole day.
// Falls back to allowing all trades if the API is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

interface NasdaqRow {
  symbol: string;
  time:   string;  // 'time-pre-market' | 'time-after-hours' | 'time-not-supplied'
}

interface NasdaqResponse {
  data?: { rows?: NasdaqRow[] };
}

const NASDAQ_BASE = 'https://api.nasdaq.com/api/calendar/earnings';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'application/json, text/plain, */*',
};

// Cache: date string → set of symbols reporting that day
let earningsCache: Map<string, Set<string>> | null = null;

function dateStr(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}

async function fetchEarningsForDate(date: string): Promise<Set<string>> {
  if (earningsCache?.has(date)) return earningsCache.get(date)!;

  try {
    const res = await fetch(`${NASDAQ_BASE}?date=${date}`, {
      headers: HEADERS,
      signal:  AbortSignal.timeout(8_000),
    });

    if (!res.ok) throw new Error(`NASDAQ ${res.status}: ${res.statusText}`);

    const body   = await res.json() as NasdaqResponse;
    const rows   = body?.data?.rows ?? [];
    const symbols = new Set(rows.map(r => r.symbol.toUpperCase()));

    if (!earningsCache) earningsCache = new Map();
    earningsCache.set(date, symbols);

    log.info(`[Earnings] NASDAQ calendar for ${date}: ${symbols.size} companies reporting`);
    return symbols;
  } catch (err) {
    log.warn(`[Earnings] NASDAQ fetch failed for ${date}: ${err instanceof Error ? err.message : err} — allowing all trades`);
    if (!earningsCache) earningsCache = new Map();
    earningsCache.set(date, new Set()); // cache empty so we don't retry on every symbol
    return new Set();
  }
}

/**
 * Returns true if symbol has earnings today, yesterday (after-hours), or
 * tomorrow (pre-market drift). Falls back to false on any error.
 */
export async function hasEarningsNearby(symbol: string): Promise<boolean> {
  const [today, yesterday, tomorrow] = await Promise.all([
    fetchEarningsForDate(dateStr(0)),
    fetchEarningsForDate(dateStr(-1)),
    fetchEarningsForDate(dateStr(1)),
  ]);

  if (today.has(symbol)) {
    log.warn(`[Earnings] ${symbol}: reporting today — skipping`);
    return true;
  }
  if (yesterday.has(symbol)) {
    log.warn(`[Earnings] ${symbol}: reported yesterday after-hours — skipping (overnight reaction still in play)`);
    return true;
  }
  if (tomorrow.has(symbol)) {
    log.warn(`[Earnings] ${symbol}: reporting tomorrow — skipping (pre-earnings drift)`);
    return true;
  }

  return false;
}

/**
 * Checks all watchlist symbols at once. Fetches 3 days of NASDAQ calendar
 * in parallel (3 requests total regardless of watchlist size).
 */
export async function getSymbolsWithNearbyEarnings(symbols: string[]): Promise<Set<string>> {
  // Warm the cache for all 3 dates in one shot
  await Promise.all([
    fetchEarningsForDate(dateStr(0)),
    fetchEarningsForDate(dateStr(-1)),
    fetchEarningsForDate(dateStr(1)),
  ]);

  const results = await Promise.all(
    symbols.map(async sym => ({ sym, hasEarnings: await hasEarningsNearby(sym) }))
  );

  const flagged = new Set(results.filter(r => r.hasEarnings).map(r => r.sym));

  if (flagged.size > 0) {
    log.info(`[Earnings] Symbols with nearby earnings (skipping): ${[...flagged].join(', ')}`);
  } else {
    log.info('[Earnings] No earnings conflicts today');
  }

  return flagged;
}

/** Call at session end to clear cache for the next day. */
export function clearEarningsCache(): void {
  earningsCache = null;
}
