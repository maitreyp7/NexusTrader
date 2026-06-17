import { API } from '../config.js';
import { log }  from '../core/logger.js';
import type { Candle } from './marketData.js';

// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL DATA FETCHER
//
// Alpaca's /v2/stocks/bars endpoint returns max 10,000 bars per request
// and supports pagination via a `next_page_token`. For backtesting we need
// months of 1-minute bars, so we paginate until we have everything.
//
// 1 trading day ≈ 390 1-minute bars (6.5 hours × 60)
// 6 months ≈ 126 trading days ≈ 49,140 bars → ~5 API pages
//
// We add a 300ms delay between pages to stay within Alpaca's rate limits
// (200 requests/minute on free tier — we're nowhere near that).
//
// Results are returned oldest-first, same as getEquityBars().
// ─────────────────────────────────────────────────────────────────────────────

const alpacaHeaders = {
  'APCA-API-KEY-ID':     API.alpaca.key,
  'APCA-API-SECRET-KEY': API.alpaca.secret,
};

interface AlpacaBar {
  t:  string;   // timestamp ISO
  o:  number;
  h:  number;
  l:  number;
  c:  number;
  v:  number;
  vw: number;
}

interface AlpacaBarsResponse {
  bars:            Record<string, AlpacaBar[]>;
  next_page_token: string | null;
}

/**
 * Fetches all 1-minute bars for a symbol between startDate and endDate.
 * Paginates automatically. Use this for backtesting only — too slow for live.
 *
 * @param symbol   e.g. 'QQQ'
 * @param start    ISO date string 'YYYY-MM-DD'
 * @param end      ISO date string 'YYYY-MM-DD' (defaults to today)
 */
export async function fetchHistoricalBars(
  symbol:  string,
  start:   string,
  end?:    string,
): Promise<Candle[]> {
  const endDate = end ?? new Date().toISOString().split('T')[0];
  log.info(`[HistoricalData] Fetching 1m bars for ${symbol} from ${start} to ${endDate}...`);

  const allBars: AlpacaBar[] = [];
  let pageToken: string | null = null;
  let page = 0;

  do {
    page++;
    const params = new URLSearchParams({
      symbols:   symbol,
      timeframe: '1Min',
      start:     `${start}T09:00:00Z`,
      end:       `${endDate}T23:59:59Z`,
      limit:     '10000',
      sort:      'asc',
      feed:      'iex',
    });

    if (pageToken) params.set('page_token', pageToken);

    const url = `${API.alpacaData.baseUrl}/v2/stocks/bars?${params}`;
    const res  = await fetch(url, { headers: alpacaHeaders });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Alpaca historical bars page ${page}: HTTP ${res.status}: ${text}`);
    }

    const body = await res.json() as AlpacaBarsResponse;
    const bars  = body.bars?.[symbol] ?? [];
    allBars.push(...bars);
    pageToken = body.next_page_token ?? null;

    log.info(`[HistoricalData] ${symbol}: page ${page} — ${bars.length} bars (total: ${allBars.length})${pageToken ? ', fetching next...' : ''}`);

    if (pageToken) await new Promise(r => setTimeout(r, 300)); // Rate limit courtesy
  } while (pageToken);

  log.info(`[HistoricalData] ${symbol}: done — ${allBars.length} total bars across ${page} pages`);

  return allBars.map((bar): Candle => ({
    openTime:  new Date(bar.t),
    open:      bar.o,
    high:      bar.h,
    low:       bar.l,
    close:     bar.c,
    volume:    bar.v,
    closeTime: new Date(bar.t),
    vwap:      bar.vw ?? undefined,
  }));
}

/**
 * Returns YYYY-MM-DD for N months ago from today.
 */
export function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}
