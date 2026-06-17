import { API, COINS, INDICATORS } from '../config.js';
import { retry } from '../core/retry.js';

// Alpaca auth headers — reused across all Alpaca data calls
const alpacaHeaders = {
  'APCA-API-KEY-ID':     API.alpaca.key,
  'APCA-API-SECRET-KEY': API.alpaca.secret,
};

// ─────────────────────────────────────────────────────────────────────────────
// MARKET DATA TOOL — Component 1: Data Layer
//
// This is the only file in the entire system that talks to external price APIs.
// Every agent that needs market data calls functions from here — never fetches
// directly. This gives us one place to handle errors, validate data, and
// swap data providers if needed.
//
// Data sources:
//   Binance  → live prices, OHLCV candles, order book (fast, reliable, free)
//   CoinGecko → historical data for backtesting (6+ years, free)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PriceData {
  symbol: string;        // e.g. 'BTC/USD'
  price: number;         // Current price in USD
  priceChange24h: number; // % change in last 24 hours
  high24h: number;
  low24h: number;
  volume24h: number;     // Trading volume in USD last 24h
  fetchedAt: Date;       // When this data was fetched (used for staleness check)
}

export interface Candle {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: Date;
  vwap?: number;         // Volume-weighted average price (from Alpaca bars)
}

export interface OHLCVData {
  symbol: string;
  timeframe: string;     // '1h', '4h', '1d'
  candles: Candle[];
  fetchedAt: Date;
}

export interface OrderBook {
  symbol: string;
  bids: [number, number][]; // [price, quantity] — buyers
  asks: [number, number][]; // [price, quantity] — sellers
  spread: number;           // ask - bid (cost to enter and exit immediately)
  spreadPct: number;        // spread as % of mid price
  bidAskImbalance: number;  // -1 to +1. Positive = more buying pressure.
  fetchedAt: Date;
}

export interface HistoricalPrice {
  timestamp: Date;
  price: number;
}

// ─── Timeframe mapping ────────────────────────────────────────────────────────
// Maps our timeframe strings to Binance's interval format
const TIMEFRAME_MAP: Record<string, string> = {
  '1h':  '1Hour',
  '4h':  '4Hour',
  '1d':  '1Day',
};

// ─── Staleness threshold ──────────────────────────────────────────────────────
// Reject any price data older than this (in milliseconds)
// Stale prices can lead to wrong decisions — better to skip than trade on bad data
const MAX_PRICE_AGE_MS = 5 * 60 * 1000; // 5 minutes

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1 — getCurrentPrice
// Gets the live price of a coin from Binance.
//
// Why Binance? It's the most liquid crypto exchange — prices are accurate
// and the public API requires no authentication.
// ─────────────────────────────────────────────────────────────────────────────
export async function getCurrentPrice(symbol: string): Promise<PriceData> {
  const coinConfig = COINS.symbols[symbol];
  if (!coinConfig) {
    throw new Error(`Unknown symbol: ${symbol}. Add it to COINS.symbols in config.ts`);
  }

  // Use Alpaca data API — already authenticated, US-friendly, reliable
  const snapshotData = await retry(`Alpaca snapshot (${symbol})`, async () => {
    const res = await fetch(
      `${API.alpacaData.baseUrl}/v1beta3/crypto/us/snapshots?symbols=${coinConfig.alpaca}`,
      { headers: alpacaHeaders }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json() as Promise<{
      snapshots: Record<string, {
        latestTrade:  { p: number; t: string };
        dailyBar:     { o: number; h: number; l: number; c: number; v: number };
        prevDailyBar: { c: number };
      }>;
    }>;
  });

  const snap = snapshotData.snapshots[coinConfig.alpaca];
  if (!snap) throw new Error(`No snapshot data returned for ${symbol}`);

  const price      = snap.latestTrade.p;
  const high24h    = snap.dailyBar.h;
  const low24h     = snap.dailyBar.l;
  const volume24h  = snap.dailyBar.v;
  const prevClose  = snap.prevDailyBar.c;
  const priceChange24h = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  validatePrice(price, symbol);
  if (isNaN(high24h) || isNaN(low24h) || isNaN(volume24h)) {
    throw new Error(`Alpaca returned invalid numeric data for ${symbol}`);
  }
  if (low24h > high24h) {
    throw new Error(`Impossible data: low (${low24h}) > high (${high24h}) for ${symbol}`);
  }

  return { symbol, price, priceChange24h, high24h, low24h, volume24h, fetchedAt: new Date() };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2 — getOHLCV
// Gets candlestick data (Open, High, Low, Close, Volume) for a coin.
// Used by the Indicator Engine to calculate RSI, MACD, moving averages, ATR.
//
// Timeframes: '1h' (hourly), '4h' (4-hourly), '1d' (daily)
// We fetch more candles than we need to ensure indicators have enough history.
// ─────────────────────────────────────────────────────────────────────────────
export async function getOHLCV(
  symbol: string,
  timeframe: string,
  limit: number = 100,
): Promise<OHLCVData> {
  const coinConfig = COINS.symbols[symbol];
  if (!coinConfig) throw new Error(`Unknown symbol: ${symbol}`);

  const alpacaTimeframe = TIMEFRAME_MAP[timeframe];
  if (!alpacaTimeframe) {
    throw new Error(`Unknown timeframe: ${timeframe}. Use: ${Object.keys(TIMEFRAME_MAP).join(', ')}`);
  }

  const safeLimit = Math.max(limit, INDICATORS.minCandlesRequired);

  // Calculate start date far enough back to guarantee enough candles
  // 1h → go back 7 days, 4h → 30 days, 1d → 120 days
  const lookbackDays = timeframe === '1d' ? 120 : timeframe === '4h' ? 90 : 14;
  const start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const data = await retry(`Alpaca OHLCV bars (${symbol} ${timeframe})`, async () => {
    const res = await fetch(
      `${API.alpacaData.baseUrl}/v1beta3/crypto/us/bars?symbols=${coinConfig.alpaca}&timeframe=${alpacaTimeframe}&limit=${safeLimit}&sort=asc&start=${start}`,
      { headers: alpacaHeaders }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json() as Promise<{
      bars: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]>;
    }>;
  });

  const rawBars = data.bars[coinConfig.alpaca];
  if (!rawBars?.length) {
    throw new Error(`Alpaca returned empty bar data for ${symbol} ${timeframe}`);
  }

  const candles: Candle[] = rawBars.map((bar, i) => {
    const { o: open, h: high, l: low, c: close, v: volume } = bar;

    if ([open, high, low, close, volume].some(isNaN)) {
      throw new Error(`Invalid candle data at index ${i} for ${symbol}`);
    }
    if (low > high) throw new Error(`Impossible candle at index ${i}: low (${low}) > high (${high})`);
    if (open <= 0 || close <= 0) throw new Error(`Non-positive price in candle at index ${i}`);

    return {
      openTime:  new Date(bar.t),
      open, high, low, close, volume,
      closeTime: new Date(bar.t), // Alpaca provides bar start time only; closeTime approximated
    };
  });

  // Per-timeframe minimums: daily needs 50 (for MA50), shorter timeframes need 30 (for MACD-26)
  const minRequired = timeframe === '1d' ? INDICATORS.minCandlesRequired : 30;
  if (candles.length < minRequired) {
    throw new Error(
      `Not enough candles for ${symbol} ${timeframe}: got ${candles.length}, need ${minRequired}.`
    );
  }

  return { symbol, timeframe, candles, fetchedAt: new Date() };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3 — getOrderBook
// Gets the current order book — a list of all pending buy and sell orders.
//
// Why this matters:
// The order book reveals real-time supply/demand. If there are 10x more buyers
// than sellers right now, price is likely to move up. This is called
// "order book imbalance" and is a real microstructure edge.
// ─────────────────────────────────────────────────────────────────────────────
export async function getOrderBook(symbol: string, depth: number = 20): Promise<OrderBook> {
  // Legacy function — Binance order book for crypto symbols
  // For equity ORB, use getEquitySnapshot instead
  const binanceSymbol = symbol.replace('/', '') + 'T'; // BTC/USD → BTCUSDT

  const data = await retry(`Binance order book (${symbol})`, async () => {
    const res = await fetch(
      `https://api.binance.us/api/v3/depth?symbol=${binanceSymbol}&limit=${depth}`
    );

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    return res.json() as Promise<{
      bids: [string, string][];  // [price, quantity]
      asks: [string, string][];
    }>;
  });

  if (!data.bids?.length || !data.asks?.length) {
    throw new Error(`Binance returned empty order book for ${symbol}`);
  }

  // Parse bids and asks
  const bids: [number, number][] = data.bids.map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  const asks: [number, number][] = data.asks.map(([p, q]) => [parseFloat(p), parseFloat(q)]);

  // Best bid = highest buyer price. Best ask = lowest seller price.
  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];

  if (bestBid <= 0 || bestAsk <= 0) {
    throw new Error(`Invalid order book prices for ${symbol}: bid=${bestBid}, ask=${bestAsk}`);
  }
  if (bestBid >= bestAsk) {
    throw new Error(`Crossed order book for ${symbol}: bid (${bestBid}) >= ask (${bestAsk})`);
  }

  const spread    = bestAsk - bestBid;
  const midPrice  = (bestBid + bestAsk) / 2;
  const spreadPct = spread / midPrice;

  // Calculate imbalance: total bid volume vs total ask volume
  // Result is -1 (all sellers) to +1 (all buyers)
  // Note: this is a SNAPSHOT — it changes every millisecond in real trading
  const totalBidVolume = bids.reduce((sum, [, qty]) => sum + qty, 0);
  const totalAskVolume = asks.reduce((sum, [, qty]) => sum + qty, 0);
  const totalVolume    = totalBidVolume + totalAskVolume;
  const bidAskImbalance = totalVolume > 0
    ? (totalBidVolume - totalAskVolume) / totalVolume
    : 0;

  return {
    symbol,
    bids,
    asks,
    spread,
    spreadPct,
    bidAskImbalance,
    fetchedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 4 — getHistoricalPrices
// Gets historical daily prices from CoinGecko for backtesting.
//
// This is NOT used during live trading — only by the Backtesting Agent.
// CoinGecko's free tier gives us up to 365 days of daily price history.
// ─────────────────────────────────────────────────────────────────────────────
export async function getHistoricalPrices(
  symbol: string,
  days: number = 180,
): Promise<HistoricalPrice[]> {
  if (days < 1 || days > 365) {
    throw new Error(`days must be between 1 and 365. Got: ${days}`);
  }

  // Legacy function: CoinGecko for crypto, Alpaca daily bars for equities
  // For equity symbols (QQQ, SPY), use Alpaca equity bars
  const equitySymbols = Object.keys(COINS.symbols);
  if (equitySymbols.includes(symbol)) {
    const bars = await getEquityBars(symbol, '1d', Math.min(days, 365));
    return bars.map(b => ({ timestamp: b.openTime, price: b.close }));
  }

  // Crypto: use CoinGecko
  const coingeckoId = symbol === 'BTC/USD' ? 'bitcoin'
                    : symbol === 'ETH/USD' ? 'ethereum'
                    : symbol.toLowerCase().replace('/usd', '');

  const data = await retry(`CoinGecko historical prices (${symbol})`, async () => {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}&interval=daily`
    );

    if (res.status === 429) {
      throw new Error('CoinGecko rate limit hit. Wait 60 seconds before retrying.');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    return res.json() as Promise<{
      prices: [number, number][]; // [timestamp_ms, price_usd]
    }>;
  });

  if (!data.prices?.length) {
    throw new Error(`CoinGecko returned no historical data for ${symbol}`);
  }

  // Parse and validate
  const prices: HistoricalPrice[] = data.prices
    .map(([timestamp, price]) => ({
      timestamp: new Date(timestamp),
      price: parseFloat(String(price)),
    }))
    .filter(({ price }) => {
      // Remove any entries with invalid prices (gaps in CoinGecko data)
      return !isNaN(price) && price > 0;
    });

  if (prices.length < 30) {
    throw new Error(`Not enough historical data for ${symbol}: only ${prices.length} valid days returned`);
  }

  return prices;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 5 — checkStaleness
// Call before using any market data to ensure it's still fresh.
// Stale prices = wrong decisions. Better to skip a trade than use old data.
//
// Price data and order books: stale after 5 minutes (they change constantly).
// OHLCV candle data: stale after 30 minutes (bars change much more slowly).
// ─────────────────────────────────────────────────────────────────────────────
export function checkStaleness(data: PriceData | OrderBook | OHLCVData): void {
  const maxAgeMs = 'candles' in data ? 30 * 60 * 1000 : MAX_PRICE_AGE_MS;
  const label    = 'candles' in data ? `OHLCV (${data.symbol} ${data.timeframe})`
                 : 'bids'    in data ? `Order book (${data.symbol})`
                 : `Price (${data.symbol})`;

  const ageMs = Date.now() - data.fetchedAt.getTime();
  if (ageMs > maxAgeMs) {
    throw new Error(
      `${label} data is stale (${Math.round(ageMs / 1000)}s old). ` +
      `Max allowed age: ${maxAgeMs / 1000}s. Refetch before trading.`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function validatePrice(price: number, symbol: string): void {
  if (isNaN(price)) {
    throw new Error(`Price for ${symbol} is NaN — API returned non-numeric data`);
  }
  if (price <= 0) {
    throw new Error(`Price for ${symbol} is ${price} — must be a positive number`);
  }
  if (price > 10_000_000) {
    throw new Error(`Price for ${symbol} is suspiciously high (${price}) — possible API error`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EQUITY MARKET DATA — Alpaca Stocks API
//
// These functions fetch data for US equities (QQQ, SPY, etc.) using the
// Alpaca data API's stocks endpoint. Different from the crypto endpoint above.
//
// Base URL: https://data.alpaca.markets
// Stocks bars: /v2/stocks/bars?symbols=QQQ&timeframe=1Min&limit=30&sort=asc
// Auth: same APCA headers as above
// ─────────────────────────────────────────────────────────────────────────────

// Timeframe mapping for equity bars (Alpaca stocks API format)
const EQUITY_TIMEFRAME_MAP: Record<string, string> = {
  '1m':  '1Min',
  '5m':  '5Min',
  '15m': '15Min',
  '1h':  '1Hour',
  '1d':  '1Day',
  '1Day': '1Day',
};

// Raw Alpaca bar shape
interface AlpacaBar {
  t: string;  // Timestamp (ISO 8601)
  o: number;  // Open
  h: number;  // High
  l: number;  // Low
  c: number;  // Close
  v: number;  // Volume
  n?: number; // Number of trades (optional)
  vw?: number;// Volume-weighted average price (optional)
}

// ─── getEquityBars ────────────────────────────────────────────────────────────
// Fetch OHLCV candles for a US equity symbol from Alpaca.
// Used for ORB range building (1m) and macro context (1d).
//
// extended: if true, includes pre-market and after-hours bars.
//   Useful for fetching pre-market price action (9:00–9:29 AM).
// ─────────────────────────────────────────────────────────────────────────────
export async function getEquityBars(
  symbol:    string,
  timeframe: string,
  limit:     number  = 30,
  extended:  boolean = false,
  startDate?: string,  // YYYY-MM-DD — overrides the default lookback window
): Promise<Candle[]> {
  const alpacaTimeframe = EQUITY_TIMEFRAME_MAP[timeframe] ?? timeframe;

  let start: string;
  if (startDate) {
    start = startDate;
  } else {
    const lookbackDays = timeframe === '1d' || timeframe === '1Day' ? 60
                       : timeframe === '1h' ? 7
                       : 2;
    start = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
  }

  // IEX feed is free and real-time (vs SIP which requires paid subscription)
  const feedParam = '&feed=iex';

  const data = await retry(`Alpaca equity bars (${symbol} ${timeframe})`, async () => {
    const url = `${API.alpacaData.baseUrl}/v2/stocks/bars?symbols=${symbol}&timeframe=${alpacaTimeframe}&limit=${limit}&sort=asc&start=${start}${feedParam}`;
    const res = await fetch(url, { headers: alpacaHeaders });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<{ bars: Record<string, AlpacaBar[]> }>;
  });

  const rawBars = data.bars?.[symbol];
  if (!rawBars || rawBars.length === 0) {
    throw new Error(`Alpaca returned no equity bars for ${symbol} (${timeframe})`);
  }

  return rawBars.map((bar, i): Candle => {
    const { o: open, h: high, l: low, c: close, v: volume } = bar;

    if ([open, high, low, close, volume].some(v => isNaN(v))) {
      throw new Error(`Invalid candle data at index ${i} for equity ${symbol}`);
    }
    if (low > high) {
      throw new Error(`Impossible candle at index ${i}: low (${low}) > high (${high}) for ${symbol}`);
    }

    return {
      openTime:  new Date(bar.t),
      open, high, low, close, volume,
      closeTime: new Date(bar.t),
      vwap:      bar.vw ?? undefined,
    };
  });
}

// ─── getEquitySnapshot ────────────────────────────────────────────────────────
// Fetch the latest quote and trade snapshot for a US equity symbol.
// Returns a simplified price summary for quick price checks.
// ─────────────────────────────────────────────────────────────────────────────
export interface EquitySnapshot {
  symbol:        string;
  latestPrice:   number;
  bidPrice:      number;
  askPrice:      number;
  prevClose:     number;
  changeFromPrev: number;  // Absolute price change
  changePct:     number;   // % change from previous close
  fetchedAt:     Date;
}

export async function getEquitySnapshot(symbol: string): Promise<EquitySnapshot> {
  const data = await retry(`Alpaca equity snapshot (${symbol})`, async () => {
    const res = await fetch(
      `${API.alpacaData.baseUrl}/v2/stocks/snapshots?symbols=${symbol}`,
      { headers: alpacaHeaders },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<{
      [symbol: string]: {
        latestTrade:  { p: number; t: string };
        latestQuote:  { bp: number; ap: number };
        dailyBar:     { o: number; h: number; l: number; c: number; v: number };
        prevDailyBar: { c: number };
      };
    }>;
  });

  const snap = data[symbol];
  if (!snap) {
    throw new Error(`Alpaca returned no snapshot for ${symbol}`);
  }

  const latestPrice    = snap.latestTrade?.p ?? snap.dailyBar?.c ?? 0;
  const prevClose      = snap.prevDailyBar?.c ?? 0;
  const changeFromPrev = latestPrice - prevClose;
  const changePct      = prevClose > 0 ? changeFromPrev / prevClose : 0;

  return {
    symbol,
    latestPrice,
    bidPrice:      snap.latestQuote?.bp ?? latestPrice,
    askPrice:      snap.latestQuote?.ap ?? latestPrice,
    prevClose,
    changeFromPrev: Math.round(changeFromPrev * 100) / 100,
    changePct:      Math.round(changePct      * 10000) / 10000,
    fetchedAt:      new Date(),
  };
}

// ─── getVixLevel ─────────────────────────────────────────────────────────────
// Estimate VIX using VIXY and VXX as proxies.
//
// VIX itself is not available via Alpaca. VIXY and VXX are ETFs that track
// short-term VIX futures. Their prices differ from the VIX index because they
// hold futures (not spot VIX) and have ETF expenses.
//
// We cross-validate both ETFs: if they agree within 15%, we blend them.
// If they diverge sharply, we log a warning and rely on the one that produced
// a sane estimate (VIX historically ranges 10–80; extreme values flag bad data).
//
// Calibration (as of 2024–2025):
//   VIXY ≈ VIX × 0.18  → multiply by ~5.5
//   VXX  ≈ VIX × 0.21  → multiply by ~4.8
// These factors drift over time with NAV decay — the cross-check catches drift.
// ─────────────────────────────────────────────────────────────────────────────
export async function getVixLevel(): Promise<number> {
  const VIXY_FACTOR = 5.5;  // VIXY price → estimated VIX
  const VXX_FACTOR  = 4.8;  // VXX  price → estimated VIX
  const VIX_MIN = 8;
  const VIX_MAX = 90;

  const clamp = (v: number) => Math.max(VIX_MIN, Math.min(VIX_MAX, v));
  const isPlausible = (v: number) => v >= VIX_MIN && v <= VIX_MAX;

  let vixyEstimate: number | null = null;
  let vxxEstimate:  number | null = null;

  try {
    const snap = await getEquitySnapshot('VIXY');
    const est  = snap.latestPrice * VIXY_FACTOR;
    if (isPlausible(est)) vixyEstimate = est;
  } catch { /* VIXY unavailable */ }

  try {
    const bars = await getEquityBars('VXX', '1d', 1);
    const last = bars[bars.length - 1]?.close ?? 0;
    const est  = last * VXX_FACTOR;
    if (last > 0 && isPlausible(est)) vxxEstimate = est;
  } catch { /* VXX unavailable */ }

  // Both available — cross-validate
  if (vixyEstimate !== null && vxxEstimate !== null) {
    const spread = Math.abs(vixyEstimate - vxxEstimate);
    const avg    = (vixyEstimate + vxxEstimate) / 2;
    const divergePct = spread / avg;
    if (divergePct > 0.15) {
      // >15% divergence — estimates disagree, trust VIXY (more liquid)
      console.warn(
        `[VIX] VIXY/VXX divergence ${(divergePct * 100).toFixed(1)}% ` +
        `(VIXY≈${vixyEstimate.toFixed(1)}, VXX≈${vxxEstimate.toFixed(1)}) — using VIXY`
      );
      return Math.round(clamp(vixyEstimate) * 100) / 100;
    }
    // Blend 60/40 (VIXY slightly more liquid and precise)
    const blended = vixyEstimate * 0.6 + vxxEstimate * 0.4;
    return Math.round(clamp(blended) * 100) / 100;
  }

  if (vixyEstimate !== null) return Math.round(clamp(vixyEstimate) * 100) / 100;
  if (vxxEstimate  !== null) return Math.round(clamp(vxxEstimate)  * 100) / 100;

  // Both failed — return neutral (won't trigger kill switch)
  console.warn('[VIX] Both VIXY and VXX unavailable — defaulting to VIX=20');
  return 20;
}
