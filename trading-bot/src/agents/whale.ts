import { WHALE_CONFIG } from '../config.js';
import { retry } from '../core/retry.js';
import { getEquityBars } from '../tools/marketData.js';
import { MicrostructureResult } from '../tools/microstructure.js';

// ─────────────────────────────────────────────────────────────────────────────
// INSTITUTIONAL FLOW AGENT  (formerly "Whale Watcher")
//
// Detects whether large institutional traders are buying or distributing.
// For US equities, "whale" signals come from three places:
//
//   1. ORDER BOOK PRESSURE (microstructure)
//      Large bid walls below price = institutions defending a level (bullish)
//      Large ask walls above price = institutions selling into strength (bearish)
//      Source: microstructure data already computed in orbAnalyst
//
//   2. RELATIVE VOLUME SURGE
//      Institutional buying leaves a volume fingerprint.
//      Volume 2×+ above the 20-day average on a UP candle = accumulation
//      Volume 2×+ above average on a DOWN candle = distribution
//      Source: Alpaca 5-minute bars (already fetched in orbAnalyst)
//
//   3. SPY OPTIONS PUT/CALL RATIO (market-wide sentiment)
//      Measures whether institutions are hedging (buying puts) or bullish
//      (buying calls). A low P/C ratio = institutions leaning long = bullish.
//      A high P/C ratio = heavy hedging = risk-off = bearish for ORB entries.
//      Source: Yahoo Finance public options summary (no API key needed)
//
//      P/C ratio interpretation (equity-specific):
//        < 0.7  → strongly bullish (institutions buying calls)
//        0.7–0.9 → mildly bullish
//        0.9–1.1 → neutral
//        1.1–1.3 → mildly bearish (hedging)
//        > 1.3  → strongly bearish (heavy put buying)
//
// WHY NOT BYBIT/BINANCE?
//   This bot trades US equities (QQQ, SPY, NVDA, etc.) — not crypto.
//   Bybit funding rates and Binance large trades are crypto derivatives signals.
//   They are completely meaningless for equity ORB trading and have been removed.
//
// OUTPUT: score (0–1)
//   0.00–0.35 = Distribution / institutional selling → bearish for ORB entry
//   0.35–0.65 = Neutral / unclear
//   0.65–1.00 = Accumulation / institutional buying → bullish for ORB entry
// ─────────────────────────────────────────────────────────────────────────────

export interface WhaleResult {
  score:                   number;    // 0–1 for Decision Engine
  signal:                  'accumulation' | 'distribution' | 'neutral';
  orderBookSignal:         number;    // 0–1 from bid/ask wall analysis
  relativeVolumeScore:     number;    // 0–1 from volume surge analysis
  putCallScore:            number;    // 0–1 from SPY options P/C ratio (0=bearish, 1=bullish)
  putCallRatio:            number;    // Raw P/C ratio (< 1 = bullish, > 1 = bearish)
  relativeVolume:          number;    // Current volume vs 20-day average (e.g. 1.8 = 80% above avg)
  exchangeOutflowDetected: boolean;   // Volume spike on up-candle = institutional accumulation

  // Legacy fields kept for interface compatibility (always 0 for equities)
  largeTradeBias:    number;
  largeTradeCount:   number;
  fundingRate:       number;
  fundingRateScore:  number;
  openInterest:      number;
  liquidationBias:   number;
  longLiquidations:  number;
  shortLiquidations: number;

  reason:    string;
  dataGaps:  string[];
  fetchedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — analyzeWhaleActivity
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeWhaleActivity(
  symbol:        string,
  micro:         MicrostructureResult,
  recentVolumes: number[],  // Last 20 candle volumes (from OHLCV)
  recentCloses:  number[],  // Last 20 closes (for volume-price correlation)
): Promise<WhaleResult> {
  const dataGaps: string[] = [];

  // Run all signals in parallel
  const [putCallResult, dailyVolResult] = await Promise.all([
    fetchPutCallRatio(symbol, dataGaps),
    fetchRelativeVolume(symbol, dataGaps),
  ]);

  const orderBookSignal       = analyzeOrderBookForInstitutions(micro);
  const exchangeOutflowDetected = detectVolumeAccumulation(recentVolumes, recentCloses);

  // Combine using configured weights
  const outflowBoost = exchangeOutflowDetected ? WHALE_CONFIG.accumulationBonus : 0.0;
  const w            = WHALE_CONFIG.weights;

  const rawScore =
    (orderBookSignal      * w.orderBook) +
    (dailyVolResult.score * w.volume)    +
    (putCallResult.score  * w.putCall)   +
    outflowBoost;

  const score = Math.round(Math.max(0, Math.min(1, rawScore)) * 1000) / 1000;

  const signal: WhaleResult['signal'] =
    score >= WHALE_CONFIG.accumulationThreshold ? 'accumulation' :
    score <= WHALE_CONFIG.distributionThreshold ? 'distribution' : 'neutral';

  const reason = buildReason(
    signal, orderBookSignal, dailyVolResult, putCallResult, exchangeOutflowDetected,
  );

  return {
    score,
    signal,
    orderBookSignal:         Math.round(orderBookSignal           * 1000) / 1000,
    relativeVolumeScore:     Math.round(dailyVolResult.score      * 1000) / 1000,
    putCallScore:            Math.round(putCallResult.score       * 1000) / 1000,
    putCallRatio:            putCallResult.ratio,
    relativeVolume:          dailyVolResult.relativeVolume,
    exchangeOutflowDetected,
    // Legacy fields — zero for equities
    largeTradeBias:    0.5,
    largeTradeCount:   0,
    fundingRate:       0,
    fundingRateScore:  0.5,
    openInterest:      0,
    liquidationBias:   0.5,
    longLiquidations:  0,
    shortLiquidations: 0,
    reason,
    dataGaps,
    fetchedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL 1: Order Book Institutional Pressure
// Reuses microstructure data — no extra API call
// ─────────────────────────────────────────────────────────────────────────────
function analyzeOrderBookForInstitutions(micro: MicrostructureResult): number {
  const { liquidityZones, bidAskImbalance } = micro;

  const strongBidWalls = liquidityZones.filter(z => z.side === 'bid' && z.strength === 'strong').length;
  const strongAskWalls = liquidityZones.filter(z => z.side === 'ask' && z.strength === 'strong').length;

  const wallBias = strongBidWalls + strongAskWalls === 0
    ? 0.50
    : strongBidWalls / (strongBidWalls + strongAskWalls);

  // bidAskImbalance: -1 (all sellers) to +1 (all buyers) → normalize to 0–1
  const imbalanceScore = (bidAskImbalance + 1) / 2;

  return (wallBias * 0.60) + (imbalanceScore * 0.40);
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL 2: Relative Volume
//
// Fetches the last 21 daily bars for the symbol and computes:
//   relativeVolume = today's volume / 20-day avg volume
//
// Then checks price direction on the high-volume day:
//   High vol + up = institutional accumulation → bullish
//   High vol + down = institutional distribution → bearish
//   Normal vol = no strong signal → neutral
// ─────────────────────────────────────────────────────────────────────────────

interface RelativeVolumeResult {
  score:          number;  // 0–1
  relativeVolume: number;  // e.g. 1.8 = 80% above 20-day avg
  direction:      'up' | 'down' | 'flat';
}

async function fetchRelativeVolume(symbol: string, dataGaps: string[]): Promise<RelativeVolumeResult> {
  const neutral: RelativeVolumeResult = { score: 0.50, relativeVolume: 1.0, direction: 'flat' };

  try {
    const bars = await getEquityBars(symbol, '1d', 21);
    if (bars.length < 5) {
      dataGaps.push(`${symbol}: not enough daily bars for relative volume`);
      return neutral;
    }

    // Most recent completed day
    const today    = bars[bars.length - 1];
    const history  = bars.slice(0, -1); // All but today

    const avgVol   = history.reduce((s, b) => s + b.volume, 0) / history.length;
    if (avgVol === 0) return neutral;

    const relativeVolume = today.volume / avgVol;
    const direction: 'up' | 'down' | 'flat' =
      today.close > today.open * 1.002 ? 'up'   :
      today.close < today.open * 0.998 ? 'down' : 'flat';

    // Score mapping:
    //   Neutral vol (0.8–1.3×):       0.50 — no institutional signal
    //   High vol + up (>1.5× + up):   0.70–0.85 — accumulation
    //   High vol + down (>1.5× + dn): 0.20–0.35 — distribution
    //   Extreme vol (>2.5×):          amplify the directional signal
    let score: number;
    if (relativeVolume > 2.5) {
      score = direction === 'up' ? 0.85 : direction === 'down' ? 0.15 : 0.50;
    } else if (relativeVolume > 1.5) {
      score = direction === 'up' ? 0.70 : direction === 'down' ? 0.30 : 0.50;
    } else if (relativeVolume > 1.2) {
      score = direction === 'up' ? 0.60 : direction === 'down' ? 0.40 : 0.50;
    } else {
      score = 0.50; // Below-average or normal volume = no signal
    }

    return {
      score:          Math.round(score          * 1000) / 1000,
      relativeVolume: Math.round(relativeVolume * 100)  / 100,
      direction,
    };
  } catch (err) {
    dataGaps.push(`Relative volume fetch failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return neutral;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL 3: SPY Put/Call Ratio
//
// Fetches the current SPY options put/call ratio from Yahoo Finance's
// public statistics endpoint. No API key required.
//
// The P/C ratio measures the total open interest of put options vs call options.
// When institutions are worried about a market decline, they buy puts to hedge.
// A high P/C ratio = heavy hedging = bearish posture = risky for ORB entries.
// A low P/C ratio = institutions are bullish = tailwind for ORB entries.
//
// Note: We always use SPY for this signal regardless of symbol being analyzed,
// because the P/C ratio reflects broad market institutional positioning.
// ─────────────────────────────────────────────────────────────────────────────

interface PutCallResult {
  score: number;  // 0–1 (0 = heavy puts/bearish, 1 = heavy calls/bullish)
  ratio: number;  // Raw P/C ratio
}

async function fetchPutCallRatio(symbol: string, dataGaps: string[]): Promise<PutCallResult> {
  const neutral: PutCallResult = { score: 0.50, ratio: 1.0 };

  try {
    // Fetch per-symbol options P/C ratio first; fall back to SPY if no data
    const fetchOptions = async (ticker: string) => {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?straddle=false`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        optionChain?: { result?: { options?: { puts?: { openInterest?: number }[]; calls?: { openInterest?: number }[] }[] }[] };
      }>;
    };

    // Try symbol-specific P/C first (more relevant than broad market SPY)
    let data = await retry(`Yahoo Finance ${symbol} options`, () => fetchOptions(symbol)).catch(() => null);
    let usedTicker = symbol;

    // Check if we got usable OI data
    const getOI = (d: typeof data) => {
      const opts = d?.optionChain?.result?.[0]?.options?.[0];
      const putOI  = (opts?.puts  ?? []).reduce((s, p) => s + (p.openInterest ?? 0), 0);
      const callOI = (opts?.calls ?? []).reduce((s, c) => s + (c.openInterest ?? 0), 0);
      return { putOI, callOI };
    };
    if (!data || getOI(data).callOI === 0) {
      data = await retry('Yahoo Finance SPY options fallback', () => fetchOptions('SPY')).catch(() => null);
      usedTicker = 'SPY';
    }

    if (!data) {
      dataGaps.push(`Yahoo Finance: no options data for ${symbol} or SPY`);
      return neutral;
    }

    const { putOI, callOI } = getOI(data);
    if (callOI === 0) {
      dataGaps.push(`Yahoo Finance: zero call OI for ${usedTicker} (market closed or no data)`);
      return neutral;
    }

    const ratio = putOI / callOI;

    // Convert ratio to 0–1 bullish score (inverted — lower ratio = more bullish)
    //   < 0.7  → score 0.80 (strongly bullish)
    //   0.7–0.9 → score 0.65
    //   0.9–1.1 → score 0.50 (neutral)
    //   1.1–1.3 → score 0.35
    //   > 1.3  → score 0.20 (strongly bearish)
    const score =
      ratio < 0.7  ? 0.80 :
      ratio < 0.9  ? 0.65 :
      ratio < 1.1  ? 0.50 :
      ratio < 1.3  ? 0.35 :
      0.20;

    if (usedTicker !== symbol) {
      dataGaps.push(`P/C ratio: using SPY (${usedTicker}) as fallback — no ${symbol}-specific data`);
    }
    return {
      score: Math.round(score * 1000) / 1000,
      ratio: Math.round(ratio * 1000) / 1000,
    };
  } catch (err) {
    dataGaps.push(`Put/call ratio unavailable: ${err instanceof Error ? err.message : 'unknown'} — using neutral`);
    return neutral;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL 4: Volume Accumulation Heuristic (intraday)
// Volume spike on a rising candle = institutional buying absorbed sell pressure
// ─────────────────────────────────────────────────────────────────────────────
function detectVolumeAccumulation(volumes: number[], closes: number[]): boolean {
  if (volumes.length < 5 || closes.length < 5) return false;

  const avgVol  = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const lastVol = volumes[volumes.length - 1];
  const priceUp = closes[closes.length - 1] > closes[closes.length - 2];

  return lastVol > avgVol * 2 && priceUp;
}

// ─────────────────────────────────────────────────────────────────────────────
// REASON BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildReason(
  signal:     WhaleResult['signal'],
  orderBook:  number,
  vol:        RelativeVolumeResult,
  putCall:    PutCallResult,
  outflow:    boolean,
): string {
  const parts: string[] = [];

  parts.push(`Institutional signal: ${signal}`);

  parts.push(
    `Order book: ${orderBook > 0.6 ? 'strong bid support' : orderBook < 0.4 ? 'heavy ask pressure' : 'balanced'} ` +
    `(${(orderBook * 100).toFixed(0)}%)`
  );

  parts.push(
    `Relative volume: ${vol.relativeVolume.toFixed(2)}× avg ` +
    `(${vol.direction === 'up' ? 'accumulation' : vol.direction === 'down' ? 'distribution' : 'flat'})`
  );

  const pcLabel =
    putCall.ratio < 0.7  ? 'strongly bullish (heavy call buying)' :
    putCall.ratio < 0.9  ? 'mildly bullish' :
    putCall.ratio < 1.1  ? 'neutral' :
    putCall.ratio < 1.3  ? 'mildly bearish (hedging)' :
    'strongly bearish (heavy put buying)';
  parts.push(`SPY P/C ratio: ${putCall.ratio.toFixed(2)} — ${pcLabel}`);

  if (outflow) parts.push('Intraday accumulation candle detected');

  return parts.join(' | ');
}
