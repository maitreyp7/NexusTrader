import { Candle } from './marketData.js';
import { INDICATORS, TECHNICAL_WEIGHTS } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// INDICATORS.TS — Component 2: Indicator Engine
//
// Calculates technical indicators from raw OHLCV candle data.
// All calculations are done manually (no external libraries) so we understand
// exactly what's happening and can audit every number.
//
// IMPORTANT — These indicators are tools, not oracles:
//   RSI < 30 does NOT mean "buy". It means price has fallen fast relative to
//   recent history. That can mean oversold (bounce coming) OR strong downtrend
//   (keep falling). Context from other signals always matters.
//
// Every function returns a normalized score (0–1) alongside the raw value.
// 0.5 = neutral, >0.5 = bullish lean, <0.5 = bearish lean.
// These scores feed directly into the Decision Engine's weighted model.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface RSIResult {
  value: number;          // Raw RSI value (0–100)
  signal: 'overbought' | 'oversold' | 'neutral';
  normalized: number;     // 0–1 score for Decision Engine
  // How to read: RSI=28 → oversold → normalized≈0.75 (bullish lean)
  //              RSI=75 → overbought → normalized≈0.25 (bearish lean)
  //              RSI=50 → neutral → normalized=0.50
}

export interface MACDResult {
  macdLine: number;       // MACD line (12EMA - 26EMA)
  signalLine: number;     // 9EMA of MACD line
  histogram: number;      // macdLine - signalLine (positive = bullish momentum)
  trend: 'bullish_crossover' | 'bearish_crossover' | 'bullish' | 'bearish';
  normalized: number;     // 0–1 score
}

export interface MovingAverageResult {
  sma20: number;          // 20-period simple moving average
  sma50: number;          // 50-period simple moving average (only on daily)
  ema12: number;          // 12-period exponential moving average
  ema26: number;          // 26-period exponential moving average
  priceVsSma20: number;   // % price is above/below SMA20
  trend: 'bullish' | 'bearish' | 'neutral';
  normalized: number;
}

export interface ATRResult {
  value: number;          // ATR in price units (e.g. $1,240 for BTC)
  atrPct: number;         // ATR as % of current price (e.g. 0.015 = 1.5%)
  volatility: 'low' | 'normal' | 'high' | 'extreme';
  // Used by Risk Manager for position sizing: larger ATR → smaller position
}

export interface VolumeResult {
  current: number;        // Current candle volume
  average: number;        // 20-period average volume
  ratio: number;          // current / average (>1 = above average)
  signal: 'high' | 'normal' | 'low';
  normalized: number;     // 0–1 (high volume on bullish candle = higher score)
}

export interface IndicatorSuite {
  rsi: RSIResult;
  macd: MACDResult;
  ma: MovingAverageResult;
  atr: ATRResult;
  volume: VolumeResult;
  // Composite technical score — weighted combination of all indicators
  technicalScore: number;   // 0–1, feeds into Decision Engine
  timeframe: string;
  computedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — computeIndicators
// Takes a candle array and returns the full indicator suite.
// Call this once per timeframe per analysis cycle.
// ─────────────────────────────────────────────────────────────────────────────
export function computeIndicators(candles: Candle[], timeframe: string): IndicatorSuite {
  // Per-timeframe minimum: daily needs 50 for SMA50, others need 30
  const minRequired = timeframe === '1d' ? INDICATORS.minCandlesRequired : 30;
  if (candles.length < minRequired) {
    throw new Error(
      `Not enough candles to compute indicators for ${timeframe}: ` +
      `got ${candles.length}, need ${minRequired}`
    );
  }

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const currentPrice = closes[closes.length - 1];

  const rsi    = computeRSI(closes, INDICATORS.rsi.period);
  const macd   = computeMACD(closes, INDICATORS.macd.fastPeriod, INDICATORS.macd.slowPeriod, INDICATORS.macd.signalPeriod);
  const ma     = computeMovingAverages(closes, currentPrice, timeframe);
  const atr    = computeATR(highs, lows, closes, INDICATORS.atr.period);
  const volume = computeVolume(volumes, closes);

  // Composite score — weighted average of individual indicator scores
  const tw = TECHNICAL_WEIGHTS;
  const technicalScore = (
    rsi.normalized    * tw.rsi    +
    macd.normalized   * tw.macd   +
    ma.normalized     * tw.ma     +
    volume.normalized * tw.volume
  );

  // Clamp to 0–1 range (floating point can sometimes drift slightly outside)
  const clampedScore = Math.max(0, Math.min(1, technicalScore));

  return { rsi, macd, ma, atr, volume, technicalScore: clampedScore, timeframe, computedAt: new Date() };
}

// ─────────────────────────────────────────────────────────────────────────────
// RSI — Relative Strength Index
//
// Measures how fast price has been rising vs falling over the last N periods.
// Uses Wilder's smoothing (standard RSI method, not simple average).
//
// Edge case note: RSI is most useful at extremes (< 30, > 70).
// In the middle range (30–70) it has little predictive value on its own.
// ─────────────────────────────────────────────────────────────────────────────
export function computeRSI(closes: number[], period: number): RSIResult {
  if (closes.length < period + 1) {
    throw new Error(`RSI needs at least ${period + 1} closes, got ${closes.length}`);
  }

  // Step 1: calculate price changes
  const changes = closes.slice(1).map((close, i) => close - closes[i]);

  // Step 2: separate into gains and losses
  const gains  = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);

  // Step 3: first average (simple average for the seed value)
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Step 4: Wilder's smoothing for remaining values
  for (let i = period; i < changes.length; i++) {
    avgGain = ((avgGain * (period - 1)) + gains[i]) / period;
    avgLoss = ((avgLoss * (period - 1)) + losses[i]) / period;
  }

  // Step 5: calculate RSI
  // Guard against division by zero (if avgLoss is 0, price only went up = RSI = 100)
  const rs  = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));

  // Step 6: determine signal
  const signal = rsi >= INDICATORS.rsi.overbought ? 'overbought'
               : rsi <= INDICATORS.rsi.oversold   ? 'oversold'
               : 'neutral';

  // Step 7: normalize to 0–1
  // Oversold (low RSI) = high score (bullish lean)
  // Overbought (high RSI) = low score (bearish lean)
  // Linear inversion: normalized = 1 - (rsi / 100)
  // But we apply stronger signals at extremes using a curve
  const normalized = normalizeRSI(rsi);

  return { value: Math.round(rsi * 100) / 100, signal, normalized };
}

// RSI normalization curve — gives stronger signals at extremes
function normalizeRSI(rsi: number): number {
  const c = TECHNICAL_WEIGHTS.rsiCurve;
  if (rsi <= c.extremeOversoldMax) return c.extremeOversoldScore;
  if (rsi <= c.oversoldMax) return c.oversoldBaseScore + ((c.oversoldMax - rsi) / (c.oversoldMax - c.extremeOversoldMax)) * c.oversoldRange;
  if (rsi <= c.neutralMax) return c.neutralBaseScore - ((rsi - c.oversoldMax) / (c.neutralMax - c.oversoldMax)) * c.neutralRange;
  if (rsi <= c.overboughtMax) return c.overboughtBaseScore - ((rsi - c.neutralMax) / (c.overboughtMax - c.neutralMax)) * c.overboughtRange;
  return c.extremeOverboughtScore;
}

// ─────────────────────────────────────────────────────────────────────────────
// MACD — Moving Average Convergence Divergence
//
// Measures momentum by comparing two EMAs of different lengths.
// MACD crossing above its signal line = potential upward momentum building.
// MACD crossing below = potential downward momentum.
//
// Limitation: MACD and RSI both use price data, so they are correlated.
// The Decision Engine accounts for this — don't double-count them.
// ─────────────────────────────────────────────────────────────────────────────
export function computeMACD(closes: number[], fast: number, slow: number, signal: number): MACDResult {
  if (closes.length < slow + signal) {
    throw new Error(`MACD needs at least ${slow + signal} closes, got ${closes.length}`);
  }

  const ema12Values = computeEMAValues(closes, fast);
  const ema26Values = computeEMAValues(closes, slow);

  // Align the two EMA arrays (EMA26 starts later so is shorter)
  const offset = ema12Values.length - ema26Values.length;
  const macdValues = ema26Values.map((ema26, i) => ema12Values[i + offset] - ema26);

  const signalValues  = computeEMAValues(macdValues, signal);
  const lastMACD      = macdValues[macdValues.length - 1];
  const prevMACD      = macdValues[macdValues.length - 2];
  const lastSignal    = signalValues[signalValues.length - 1];
  const prevSignal    = signalValues[signalValues.length - 2];
  const histogram     = lastMACD - lastSignal;
  const prevHistogram = prevMACD - prevSignal;

  // Detect crossovers — the most meaningful MACD signals
  let trend: MACDResult['trend'];
  if (prevHistogram <= 0 && histogram > 0) {
    trend = 'bullish_crossover';    // MACD just crossed above signal (strong bullish)
  } else if (prevHistogram >= 0 && histogram < 0) {
    trend = 'bearish_crossover';    // MACD just crossed below signal (strong bearish)
  } else if (histogram > 0) {
    trend = 'bullish';              // MACD above signal (mild bullish)
  } else {
    trend = 'bearish';              // MACD below signal (mild bearish)
  }

  // Normalize: crossovers get extreme scores, mild trends get moderate scores
  const ms = TECHNICAL_WEIGHTS.macdScores;
  const normalized = ms[trend as keyof typeof ms] ?? 0.50;

  return {
    macdLine:   Math.round(lastMACD   * 100) / 100,
    signalLine: Math.round(lastSignal * 100) / 100,
    histogram:  Math.round(histogram  * 100) / 100,
    trend,
    normalized,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVING AVERAGES
//
// Smoothed price averages that filter out noise and reveal trend direction.
// Price above SMA20 = short-term uptrend.
// SMA20 above SMA50 = overall uptrend ("golden cross" on longer timeframes).
//
// On 4h/1h timeframes, we skip SMA50 (not enough data from Alpaca free tier).
// ─────────────────────────────────────────────────────────────────────────────
function computeMovingAverages(closes: number[], currentPrice: number, timeframe: string): MovingAverageResult {
  const sma20 = computeSMA(closes, INDICATORS.movingAverages.short);
  // Compute each EMA array once and take the last value — not twice
  const ema12 = computeEMAValues(closes, 12).at(-1)!;
  const ema26 = computeEMAValues(closes, 26).at(-1)!;

  // SMA50 only on daily timeframe where we have enough candles
  const sma50 = timeframe === '1d' && closes.length >= 50
    ? computeSMA(closes, INDICATORS.movingAverages.long)
    : sma20; // fallback to sma20 on shorter timeframes

  const priceVsSma20 = ((currentPrice - sma20) / sma20) * 100;

  // Trend: bullish if price above both MAs, bearish if below both
  const aboveSma20 = currentPrice > sma20;
  const aboveSma50 = currentPrice > sma50;

  const trend = aboveSma20 && aboveSma50 ? 'bullish'
              : !aboveSma20 && !aboveSma50 ? 'bearish'
              : 'neutral';

  // Normalize: how far is price from its MA? Further above = more overbought
  // We use a sigmoid-like curve to prevent extreme outliers from dominating
  const rawScore = aboveSma20 ? 0.5 + Math.min(0.30, Math.abs(priceVsSma20) / 10 * 0.30)
                              : 0.5 - Math.min(0.30, Math.abs(priceVsSma20) / 10 * 0.30);

  // Adjust for trend alignment
  const trendBonus = trend === 'bullish' ? 0.05 : trend === 'bearish' ? -0.05 : 0;
  const normalized = Math.max(0, Math.min(1, rawScore + trendBonus));

  return {
    sma20:        Math.round(sma20 * 100) / 100,
    sma50:        Math.round(sma50 * 100) / 100,
    ema12:        Math.round(ema12 * 100) / 100,
    ema26:        Math.round(ema26 * 100) / 100,
    priceVsSma20: Math.round(priceVsSma20 * 100) / 100,
    trend,
    normalized,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATR — Average True Range
//
// Measures average price volatility over N periods.
// Used by the Risk Manager to size positions: larger ATR = smaller position.
// NOT used as a buy/sell signal — only for risk management.
//
// True Range = biggest of: (high-low), |high-prevClose|, |low-prevClose|
// ─────────────────────────────────────────────────────────────────────────────
export function computeATR(highs: number[], lows: number[], closes: number[], period: number): ATRResult {
  if (highs.length < period + 1) {
    throw new Error(`ATR needs at least ${period + 1} candles, got ${highs.length}`);
  }

  const trueRanges: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],                         // High-low range
      Math.abs(highs[i] - closes[i - 1]),          // Gap up
      Math.abs(lows[i]  - closes[i - 1]),          // Gap down
    );
    trueRanges.push(tr);
  }

  // Wilder's smoothing for ATR (same as RSI smoothing)
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }

  const currentPrice = closes[closes.length - 1];
  const atrPct = atr / currentPrice;

  // Classify volatility level
  const vt = TECHNICAL_WEIGHTS.volatility;
  const volatility = atrPct < vt.lowMax    ? 'low'
                   : atrPct < vt.normalMax ? 'normal'
                   : atrPct < vt.highMax   ? 'high'
                   : 'extreme';

  return {
    value:      Math.round(atr * 100) / 100,
    atrPct:     Math.round(atrPct * 10000) / 10000,
    volatility,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VOLUME ANALYSIS
//
// Compares current volume to its recent average.
// High volume on a bullish candle = more conviction behind the move (stronger signal).
// Low volume = weak move, likely to reverse.
//
// Note: volume alone means little. It matters in CONTEXT of price direction.
// ─────────────────────────────────────────────────────────────────────────────
function computeVolume(volumes: number[], closes: number[]): VolumeResult {
  if (volumes.length < 20) {
    throw new Error(`Volume analysis needs at least 20 candles, got ${volumes.length}`);
  }

  const recent  = volumes.slice(-20);
  const average = recent.reduce((a, b) => a + b, 0) / recent.length;
  const current = volumes[volumes.length - 1];
  const ratio   = average > 0 ? current / average : 1;

  const signal = ratio > 1.5 ? 'high'
               : ratio < 0.5 ? 'low'
               : 'normal';

  // Volume only confirms price direction — it's not bullish or bearish on its own.
  // High volume on a RISING candle = conviction behind the move (bullish).
  // High volume on a FALLING candle = panic selling behind the move (bearish).
  // Low volume = weak move either way, lean neutral.
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const priceDirBullish = lastClose >= prevClose;

  let normalized: number;
  if (signal === 'high') {
    normalized = priceDirBullish ? 0.70 : 0.30; // High vol + up = bullish, + down = bearish
  } else if (signal === 'low') {
    normalized = 0.45; // Low volume = weak signal, slightly lean bearish (lack of conviction)
  } else {
    normalized = 0.50; // Normal volume = neutral
  }

  return {
    current: Math.round(current * 100) / 100,
    average: Math.round(average * 100) / 100,
    ratio:   Math.round(ratio   * 100) / 100,
    signal,
    normalized,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-TIMEFRAME CONFLUENCE
// Combines indicator suites from multiple timeframes into one signal.
// Agreement across timeframes = higher confidence.
//
// Example: 1h says bullish, 4h says bullish, 1d says bullish = strong buy
//          1h says bullish, 4h says neutral, 1d says bearish = conflicting, stay out
// ─────────────────────────────────────────────────────────────────────────────
export function computeMultiTimeframeScore(suites: IndicatorSuite[]): {
  score: number;
  confidence: number;
  summary: string;
} {
  if (suites.length === 0) throw new Error('No indicator suites provided');

  const scores = suites.map(s => s.technicalScore);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  // Confidence = how much the timeframes agree with each other
  // If all say 0.7, confidence is high. If one says 0.8 and another 0.3, confidence is low.
  const maxDiff = Math.max(...scores) - Math.min(...scores);
  const confidence = Math.max(0, 1 - (maxDiff * 2)); // 0 diff = 1.0 confidence, 0.5 diff = 0 confidence

  const direction = avgScore > 0.6 ? 'bullish' : avgScore < 0.4 ? 'bearish' : 'neutral';
  const timeframes = suites.map(s => s.timeframe).join(', ');
  const summary = `${direction} across ${timeframes} (avg score: ${avgScore.toFixed(2)}, confidence: ${confidence.toFixed(2)})`;

  return { score: Math.round(avgScore * 100) / 100, confidence: Math.round(confidence * 100) / 100, summary };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL MATH HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function computeSMA(closes: number[], period: number): number {
  if (closes.length < period) {
    throw new Error(`SMA(${period}) needs ${period} closes, got ${closes.length}`);
  }
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ─────────────────────────────────────────────────────────────────────────────
// RELATIVE VOLUME (RVOL)
//
// Compares current volume to the average volume at the same time of day
// across the last N sessions. A ratio of 2.0 means twice the normal activity
// for this time slot — a much stronger signal than comparing to session average.
//
// candles: today's 1m bars so far
// historicalCandles: several days of 1m bars (used to build the time-of-day baseline)
// ─────────────────────────────────────────────────────────────────────────────
export function computeRVOL(
  todayCandles:      Candle[],
  historicalCandles: Candle[],
): number {
  if (todayCandles.length === 0 || historicalCandles.length === 0) return 1.0;

  // Bucket candles by ET minute-of-day so DST transitions don't misalign slots.
  // Intl.DateTimeFormat is locale-independent and handles EDT/EST automatically.
  function etMinuteOfDay(d: Date): number {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour:     'numeric',
      minute:   'numeric',
      hour12:   false,
    });
    const parts = fmt.formatToParts(d);
    const h = parseInt(parts.find(p => p.type === 'hour')!.value,   10);
    const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
    return h * 60 + m;
  }

  // Group historical candles by their ET minute-of-day
  const byMinute = new Map<number, number[]>();
  for (const c of historicalCandles) {
    const key = etMinuteOfDay(c.openTime);
    const bucket = byMinute.get(key) ?? [];
    bucket.push(c.volume);
    byMinute.set(key, bucket);
  }

  // Average volume for each minute slot that today has data for
  let totalRatio = 0;
  let count = 0;
  for (const c of todayCandles) {
    const key  = etMinuteOfDay(c.openTime);
    const hist = byMinute.get(key);
    if (!hist || hist.length === 0) continue;
    const avgVol = hist.reduce((s, v) => s + v, 0) / hist.length;
    if (avgVol > 0) {
      totalRatio += c.volume / avgVol;
      count++;
    }
  }

  return count > 0 ? Math.round((totalRatio / count) * 100) / 100 : 1.0;
}

export function computeEMAValues(values: number[], period: number): number[] {
  if (values.length < period) {
    throw new Error(`EMA(${period}) needs at least ${period} values, got ${values.length}`);
  }

  const multiplier = 2 / (period + 1);
  const emas: number[] = [];

  // Seed with SMA of first N values
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emas.push(seed);

  for (let i = period; i < values.length; i++) {
    emas.push((values[i] - emas[emas.length - 1]) * multiplier + emas[emas.length - 1]);
  }

  return emas;
}
