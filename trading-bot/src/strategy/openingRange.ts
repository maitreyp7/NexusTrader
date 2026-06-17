import { ORB, ORB_CONFIDENCE, QUANT } from '../config.js';
import type { Candle } from '../tools/marketData.js';
import { computeRSI, computeEMAValues } from '../tools/indicators.js';

// ─────────────────────────────────────────────────────────────────────────────
// OPENING RANGE BREAKOUT (ORB) — Core Strategy Logic
//
// The Opening Range Breakout is one of the most reliable intraday strategies.
// Here's the simple idea:
//
//   1. In the first 15 minutes (9:30–9:44), the market "finds its range."
//      The highest price = ORH (Opening Range High)
//      The lowest price  = ORL (Opening Range Low)
//
//   2. From 9:45–10:15, we watch for price to BREAK OUT of that range.
//      - Break ABOVE ORH with volume → LONG entry (we buy)
//      - Break BELOW ORL → SHORT (we skip — long-only bot)
//
//   3. Stop loss = range midpoint (halfway between high and low)
//      If price breaks up but reverses back below midpoint, we exit.
//
//   4. Take profit = 1.5× the range size above the breakout point
//      Example: range is $2 wide → target is $3 above ORH
//
// WHY VOLUME CONFIRMATION?
//   A price breakout with no volume is often a "fake-out" — price briefly
//   pokes above the level then falls back. When volume SURGES on the break,
//   it means real buyers showed up. That's the real signal.
// ─────────────────────────────────────────────────────────────────────────────

// Re-export Candle so importers don't need a separate import
export type { Candle };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpeningRange {
  symbol:    string;
  high:      number;   // ORH — opening range high
  low:       number;   // ORL — opening range low
  midpoint:  number;   // (high + low) / 2
  size:      number;   // high - low (absolute dollar difference)
  sizePct:   number;   // size / low (range as % of price)
  volume:    number;   // total volume during range period
  avgVolume: number;   // rolling average volume of prior 10 candles
  lockedAt:  Date;     // when range was finalized (9:45 AM)
  candles:   Candle[]; // the 1-min candles that built this range
}

export interface BreakoutSignal {
  direction:      'LONG' | 'SHORT' | 'NONE';
  breakoutPrice:  number;        // The ORH or ORL price that was broken
  entryPrice:     number;        // Suggested entry (breakout price)
  stopPrice:      number;        // Midpoint of opening range
  targetPrice:    number;        // Entry ± (1.5 × range size)
  stopDistance:   number;        // Distance from entry to stop (in dollars)
  confidence:     number;        // 0–1 score
  volumeRatio:    number;        // breakout candle volume / avg volume
  breakoutCandle: Candle;        // The candle that caused the breakout
  reason:         string;        // Human-readable explanation
}

export interface RangeValidation {
  valid:  boolean;
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 1 — buildOpeningRange
//
// Takes the 1-minute candles from 9:30–9:44 and finds the highest high
// and lowest low across all of them. That becomes our "range" for the day.
//
// priorCandles: the 10 candles BEFORE 9:30 (used to establish average volume).
//               This is our baseline — we compare breakout volume against it.
// ─────────────────────────────────────────────────────────────────────────────
export function buildOpeningRange(
  symbol:       string,
  candles1m:    Candle[],    // 1-min candles from 9:30–9:44 (expect ~15 candles)
  priorCandles: Candle[],    // Prior candles for volume baseline (expect ~10 candles)
): OpeningRange {
  if (candles1m.length === 0) {
    throw new Error(`buildOpeningRange: no candles provided for ${symbol}`);
  }

  // Find the highest high and lowest low across all range candles
  let high   = -Infinity;
  let low    = Infinity;
  let volume = 0;

  for (const c of candles1m) {
    if (c.high > high)  high   = c.high;
    if (c.low  < low)   low    = c.low;
    volume += c.volume;
  }

  // Compute average volume of prior candles (baseline for volume confirmation)
  const priorVols = priorCandles.map(c => c.volume).filter(v => v > 0);
  const avgVolume = priorVols.length > 0
    ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length
    : volume / candles1m.length;  // Fall back to range average if no prior data

  const midpoint = (high + low) / 2;
  const size     = high - low;
  const sizePct  = low > 0 ? size / low : 0;

  return {
    symbol,
    high:      Math.round(high      * 100) / 100,
    low:       Math.round(low       * 100) / 100,
    midpoint:  Math.round(midpoint  * 100) / 100,
    size:      Math.round(size      * 100) / 100,
    sizePct:   Math.round(sizePct   * 10000) / 10000,
    volume:    Math.round(volume),
    avgVolume: Math.round(avgVolume),
    lockedAt:  new Date(),
    candles:   candles1m,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2 — detectBreakout
//
// Called every 10 seconds during the 9:45–10:15 trading window.
// Checks if the latest completed candle broke out of the opening range.
//
// Rules:
//   LONG:  candle CLOSES above ORH (not just a wick) + volume > threshold
//   SHORT: candle closes below ORL → we return NONE (long-only bot)
//   NONE:  price is still inside the range, or volume is too low
//
// We require a CLOSE above the level (not just a wick) because wicks above
// a resistance level are common — they probe it and get rejected. A candle
// that CLOSES above ORH means buyers held the breakout through the close,
// which is a much stronger signal.
// ─────────────────────────────────────────────────────────────────────────────
export function detectBreakout(
  range:         OpeningRange,
  latestCandle:  Candle,
  recentCandles: Candle[],   // Recent candles for additional context (last 3-5)
): BreakoutSignal {
  const noSignal = (reason: string): BreakoutSignal => ({
    direction:      'NONE',
    breakoutPrice:  range.high,
    entryPrice:     range.high,
    stopPrice:      range.midpoint,
    targetPrice:    range.high + (range.size * ORB.takeProfitMultiplier),
    stopDistance:   range.high - range.midpoint,
    confidence:     0,
    volumeRatio:    0,
    breakoutCandle: latestCandle,
    reason,
  });

  // Volume ratio: how much higher is this candle's volume vs the average?
  // A ratio of 1.3 means "30% above average" — our minimum threshold
  const volumeRatio = range.avgVolume > 0
    ? latestCandle.volume / range.avgVolume
    : 1.0;

  const hasVolumeConfirmation = volumeRatio >= ORB.volumeConfirmationMultiplier;

  // ── Check for LONG breakout ─────────────────────────────────────────────────
  // Candle must CLOSE above the ORH (not just touch it with a wick)
  if (latestCandle.close > range.high) {
    if (!hasVolumeConfirmation) {
      return noSignal(
        `Price closed above ORH ($${range.high.toFixed(2)}) but volume too low ` +
        `(ratio: ${volumeRatio.toFixed(2)}× — need ${ORB.volumeConfirmationMultiplier}×)`
      );
    }

    // Calculate ORB-specific entry levels
    const entryPrice    = latestCandle.close;
    const stopPrice     = range.midpoint;           // Stop at midpoint
    const stopDistance  = entryPrice - stopPrice;
    const targetPrice   = entryPrice + (range.size * ORB.takeProfitMultiplier);

    // Guard: if stop distance is zero or negative, we can't size the trade
    if (stopDistance <= 0) {
      return noSignal(
        `Invalid stop distance (entry $${entryPrice.toFixed(2)} ≤ midpoint $${stopPrice.toFixed(2)}) — skipping`
      );
    }

    // Confidence increases with volume surge and how far above ORH we closed
    const volumeBoost      = Math.min(ORB_CONFIDENCE.volumeBoostMax,  (volumeRatio - 1) * 0.10);
    const breakoutStrength = range.size > 0
      ? Math.min(ORB_CONFIDENCE.strengthBoostMax, ((latestCandle.close - range.high) / range.size) * 0.5)
      : 0;

    // VWAP confirmation: entry above session VWAP = institutional reference supports breakout
    // Compute session VWAP from range candles that have vwap data
    const vwapCandles = range.candles.filter(c => c.vwap != null && c.volume > 0);
    let vwapBoost = 0;
    if (vwapCandles.length >= 3) {
      const totalVolume = vwapCandles.reduce((s, c) => s + c.volume, 0);
      const sessionVwap = vwapCandles.reduce((s, c) => s + c.vwap! * c.volume, 0) / totalVolume;
      if (entryPrice > sessionVwap) {
        vwapBoost = 0.05;   // Above VWAP — institutional support
      } else {
        vwapBoost = -0.05;  // Below VWAP — breakout against institutional flow, reduce confidence
      }
    }

    const confidence = Math.min(
      ORB_CONFIDENCE.maxConfidence,
      ORB_CONFIDENCE.base + volumeBoost + breakoutStrength + vwapBoost,
    );

    return {
      direction:      'LONG',
      breakoutPrice:  range.high,
      entryPrice:     Math.round(entryPrice  * 100) / 100,
      stopPrice:      Math.round(stopPrice   * 100) / 100,
      targetPrice:    Math.round(targetPrice * 100) / 100,
      stopDistance:   Math.round(stopDistance * 100) / 100,
      confidence:     Math.round(confidence  * 1000) / 1000,
      volumeRatio:    Math.round(volumeRatio * 100) / 100,
      breakoutCandle: latestCandle,
      reason: [
        `LONG breakout: close $${latestCandle.close.toFixed(2)} > ORH $${range.high.toFixed(2)}`,
        `Volume: ${volumeRatio.toFixed(2)}× avg (confirmed)`,
        `Stop: $${stopPrice.toFixed(2)} (midpoint) | Target: $${targetPrice.toFixed(2)}`,
      ].join(' | '),
    };
  }

  // ── Check for SHORT breakout ─────────────────────────────────────────────────
  if (latestCandle.close < range.low) {
    if (!hasVolumeConfirmation) {
      return noSignal(
        `SHORT: close $${latestCandle.close.toFixed(2)} < ORL $${range.low.toFixed(2)} but volume too low ` +
        `(${volumeRatio.toFixed(2)}× — need ${ORB.volumeConfirmationMultiplier}×)`
      );
    }

    const entryPrice   = latestCandle.close;
    const stopPrice    = range.midpoint;               // Stop at midpoint (above entry for short)
    const stopDistance = stopPrice - entryPrice;       // Always positive
    const targetPrice  = entryPrice - (range.size * ORB.takeProfitMultiplier);

    if (stopDistance <= 0) {
      return noSignal(`Invalid short stop distance (entry $${entryPrice.toFixed(2)} ≥ midpoint $${stopPrice.toFixed(2)})`);
    }

    const volumeBoost      = Math.min(ORB_CONFIDENCE.volumeBoostMax, (volumeRatio - 1) * 0.10);
    const breakoutStrength = range.size > 0
      ? Math.min(ORB_CONFIDENCE.strengthBoostMax, ((range.low - latestCandle.close) / range.size) * 0.5)
      : 0;

    const vwapCandles = range.candles.filter(c => c.vwap != null && c.volume > 0);
    let vwapBoost = 0;
    if (vwapCandles.length >= 3) {
      const totalVolume = vwapCandles.reduce((s, c) => s + c.volume, 0);
      const sessionVwap = vwapCandles.reduce((s, c) => s + c.vwap! * c.volume, 0) / totalVolume;
      vwapBoost = entryPrice < sessionVwap ? 0.05 : -0.05;
    }

    const confidence = Math.min(
      ORB_CONFIDENCE.maxConfidence,
      ORB_CONFIDENCE.base + volumeBoost + breakoutStrength + vwapBoost,
    );

    return {
      direction:      'SHORT',
      breakoutPrice:  range.low,
      entryPrice:     Math.round(entryPrice  * 100) / 100,
      stopPrice:      Math.round(stopPrice   * 100) / 100,
      targetPrice:    Math.round(targetPrice * 100) / 100,
      stopDistance:   Math.round(stopDistance * 100) / 100,
      confidence:     Math.round(confidence  * 1000) / 1000,
      volumeRatio:    Math.round(volumeRatio * 100) / 100,
      breakoutCandle: latestCandle,
      reason: [
        `SHORT breakout: close $${latestCandle.close.toFixed(2)} < ORL $${range.low.toFixed(2)}`,
        `Volume: ${volumeRatio.toFixed(2)}× avg (confirmed)`,
        `Stop: $${stopPrice.toFixed(2)} (midpoint) | Target: $${targetPrice.toFixed(2)}`,
      ].join(' | '),
    };
  }

  // ── No breakout ─────────────────────────────────────────────────────────────
  const distanceFromHigh = range.high - latestCandle.close;
  const distancePct      = (distanceFromHigh / range.size * 100).toFixed(1);

  return noSignal(
    `Price $${latestCandle.close.toFixed(2)} inside range ` +
    `[$${range.low.toFixed(2)}–$${range.high.toFixed(2)}] — ` +
    `${distancePct}% below ORH`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 2.5 — detectFade (Mean-Reversion Fade)
//
// Identifies failed breakouts — price pops above ORH (or below ORL) and then
// closes back INSIDE the range within a few candles. This is a high-probability
// reversal setup: the breakout had no follow-through, trapped buyers/sellers,
// and price typically retraces toward the opposite extreme of the range.
//
// Direction:
//   - Failed LONG breakout (above ORH, reclaimed inside) → SHORT fade
//   - Failed SHORT breakdown (below ORL, reclaimed inside) → LONG fade
//
// Stop: just beyond the failed extreme (buffer)
// Target: range midpoint (or opposite extreme if FADE.targetMode = 'opposite')
//
// Inputs:
//   range:         the locked opening range
//   latestCandle:  the candle that just closed (must be INSIDE the range)
//   recentCandles: the last N completed candles (for breakout-then-reclaim detection)
// ─────────────────────────────────────────────────────────────────────────────
export interface FadeSignal {
  direction:      'LONG' | 'SHORT' | 'NONE';
  failedExtreme:  number;          // ORH or ORL — the level that was breached and reclaimed
  entryPrice:     number;          // Reclaim candle close
  stopPrice:      number;          // Just beyond the failed extreme
  targetPrice:    number;          // Midpoint or opposite extreme
  stopDistance:   number;          // |entry - stop|
  confidence:     number;          // 0–1
  overshootPct:   number;          // How far beyond the extreme the failed candle pushed (% of range)
  candlesAgo:     number;          // How many candles ago the failed breakout occurred
  reclaimCandle:  Candle;
  reason:         string;
}

export function detectFade(
  range:         OpeningRange,
  latestCandle:  Candle,
  recentCandles: Candle[],     // last ~5 candles (must include latestCandle as the final one)
): FadeSignal {
  const noSignal = (reason: string): FadeSignal => ({
    direction:      'NONE',
    failedExtreme:  range.high,
    entryPrice:     latestCandle.close,
    stopPrice:      range.high,
    targetPrice:    range.midpoint,
    stopDistance:   0,
    confidence:     0,
    overshootPct:   0,
    candlesAgo:     0,
    reclaimCandle:  latestCandle,
    reason,
  });

  // FADE.enabled check happens in the analyst — keep detection pure here.

  // The current candle MUST be inside the range — fade is a reclaim setup.
  if (latestCandle.close >= range.high || latestCandle.close <= range.low) {
    return noSignal(`Latest close $${latestCandle.close.toFixed(2)} not inside range — no reclaim yet`);
  }

  // Look back through recent candles to find a failed breakout (closed outside the range).
  // Walk backwards from second-to-last candle (latestCandle is the reclaim).
  const lookback = Math.min(recentCandles.length - 1, ORB_FADE_MAX_CANDLES);
  let failedDirection: 'ABOVE' | 'BELOW' | null = null;
  let failedCandle: Candle | null = null;
  let candlesAgo  = 0;
  let overshoot   = 0;

  for (let i = recentCandles.length - 2; i >= recentCandles.length - 1 - lookback && i >= 0; i--) {
    const c = recentCandles[i];
    if (c.close > range.high) {
      failedDirection = 'ABOVE';
      failedCandle    = c;
      candlesAgo      = recentCandles.length - 1 - i;
      overshoot       = range.size > 0 ? (c.close - range.high) / range.size : 0;
      break;
    }
    if (c.close < range.low) {
      failedDirection = 'BELOW';
      failedCandle    = c;
      candlesAgo      = recentCandles.length - 1 - i;
      overshoot       = range.size > 0 ? (range.low - c.close) / range.size : 0;
      break;
    }
  }

  if (!failedDirection || !failedCandle) {
    return noSignal('No failed breakout in lookback window');
  }

  // Overshoot guard: if the breakout went too far, the reversion is likely already played out.
  if (overshoot > ORB_FADE_MAX_OVERSHOOT) {
    return noSignal(`Overshoot ${(overshoot * 100).toFixed(1)}% > max ${(ORB_FADE_MAX_OVERSHOOT * 100).toFixed(0)}% — likely no reversion left`);
  }

  // Volume on reclaim candle. Failed breakouts often reclaim on softer volume — be lenient.
  const volRatio = range.avgVolume > 0 ? latestCandle.volume / range.avgVolume : 1.0;
  if (volRatio < ORB_FADE_RECLAIM_VOL_MULT) {
    return noSignal(`Reclaim volume ${volRatio.toFixed(2)}× too low (< ${ORB_FADE_RECLAIM_VOL_MULT}×)`);
  }

  // Direction: fade the failed breakout
  // ABOVE failure → SHORT (price came back down through ORH)
  // BELOW failure → LONG  (price came back up through ORL)
  const direction = failedDirection === 'ABOVE' ? 'SHORT' : 'LONG';

  const entryPrice    = latestCandle.close;
  const failedExtreme = failedDirection === 'ABOVE' ? range.high : range.low;
  const buffer        = range.size * ORB_FADE_STOP_BUFFER;

  // Stop beyond the failed extreme
  const stopPrice = failedDirection === 'ABOVE'
    ? failedExtreme + buffer    // SHORT fade: stop above the broken-then-reclaimed ORH
    : failedExtreme - buffer;   // LONG fade:  stop below the broken-then-reclaimed ORL

  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (stopDistance <= 0) {
    return noSignal(`Invalid stop distance for fade ($${entryPrice.toFixed(2)} vs $${stopPrice.toFixed(2)})`);
  }

  // Target: midpoint or opposite extreme
  const targetPrice = ORB_FADE_TARGET_MODE === 'opposite'
    ? (direction === 'SHORT' ? range.low : range.high)
    : range.midpoint;

  // Confidence: base + boost for tight failed-breakout (low overshoot) + softer volume penalty
  const overshootScore = Math.max(0, 0.10 - overshoot * 0.20);  // tight failure → +0.10, wide → 0
  const recencyScore   = Math.max(0, 0.05 - (candlesAgo - 1) * 0.02);  // immediate reclaim → +0.05
  const confidence     = Math.min(0.85, 0.55 + overshootScore + recencyScore);

  return {
    direction,
    failedExtreme:  Math.round(failedExtreme * 100) / 100,
    entryPrice:     Math.round(entryPrice    * 100) / 100,
    stopPrice:      Math.round(stopPrice     * 100) / 100,
    targetPrice:    Math.round(targetPrice   * 100) / 100,
    stopDistance:   Math.round(stopDistance  * 100) / 100,
    confidence:     Math.round(confidence    * 1000) / 1000,
    overshootPct:   Math.round(overshoot     * 1000) / 1000,
    candlesAgo,
    reclaimCandle:  latestCandle,
    reason: [
      `${direction} fade: failed ${failedDirection === 'ABOVE' ? 'long breakout above ORH' : 'short breakdown below ORL'}`,
      `Reclaim close $${entryPrice.toFixed(2)} inside range after ${candlesAgo} candle(s)`,
      `Overshoot ${(overshoot * 100).toFixed(1)}% of range | Vol ${volRatio.toFixed(2)}× avg`,
      `Stop $${stopPrice.toFixed(2)} | Target $${targetPrice.toFixed(2)}`,
    ].join(' | '),
  };
}

// Constants pulled out so detectFade stays config-independent and easy to test.
// The analyst layer reads from FADE config and passes these in via module-level state.
let ORB_FADE_MAX_CANDLES        = 3;
let ORB_FADE_MAX_OVERSHOOT      = 0.5;
let ORB_FADE_RECLAIM_VOL_MULT   = 0.8;
let ORB_FADE_STOP_BUFFER        = 0.10;
let ORB_FADE_TARGET_MODE: 'midpoint' | 'opposite' = 'midpoint';

export function configureFade(opts: {
  maxCandlesAfterBreakout: number;
  reclaimVolumeMultiplier: number;
  stopBufferPct:           number;
  maxOvershootPct:         number;
  targetMode:              'midpoint' | 'opposite';
}): void {
  ORB_FADE_MAX_CANDLES      = opts.maxCandlesAfterBreakout;
  ORB_FADE_RECLAIM_VOL_MULT = opts.reclaimVolumeMultiplier;
  ORB_FADE_STOP_BUFFER      = opts.stopBufferPct;
  ORB_FADE_MAX_OVERSHOOT    = opts.maxOvershootPct;
  ORB_FADE_TARGET_MODE      = opts.targetMode;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 3 — isRangeTooTight
//
// Returns true if the opening range should be skipped.
// Two failure modes:
//   1. Too tight: price barely moved in the first 15 min → no momentum to trade
//   2. Too wide: gap or news spike → unpredictable, ORB signals are noisy
// ─────────────────────────────────────────────────────────────────────────────
export function isRangeTooTight(range: OpeningRange): boolean {
  return range.sizePct < ORB.minRangeSize || range.sizePct > ORB.maxRangeSize;
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION — computeRelativeStrength
//
// Measures how much the symbol is outperforming SPY in the first 15 minutes.
// If a stock is up 1.5% while SPY is up 0.3%, RS = +1.2% — strong leader.
// We only want to trade stocks showing POSITIVE relative strength vs the market.
// A breakout on a lagging stock is just riding SPY coat-tails — unreliable.
// ─────────────────────────────────────────────────────────────────────────────
export function computeRelativeStrength(
  symbolCandles: Candle[],
  spyCandles:    Candle[],
): number {
  if (symbolCandles.length < 2 || spyCandles.length < 2) return 0;

  const symOpen  = symbolCandles[0].open;
  const symLast  = symbolCandles[symbolCandles.length - 1].close;
  const spyOpen  = spyCandles[0].open;
  const spyLast  = spyCandles[spyCandles.length - 1].close;

  if (symOpen <= 0 || spyOpen <= 0) return 0;

  const symReturn = (symLast - symOpen) / symOpen;
  const spyReturn = (spyLast - spyOpen) / spyOpen;

  return symReturn - spyReturn;  // Positive = outperforming SPY
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED HELPER — computeSessionVwap
// ─────────────────────────────────────────────────────────────────────────────
function computeSessionVwap(candles: Candle[]): number | null {
  const valid = candles.filter(c => c.volume > 0);
  if (valid.length < 5) return null;
  const totalVol = valid.reduce((s, c) => s + c.volume, 0);
  return valid.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0) / totalVol;
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION — detectVwapReclaim
//
// The new entry logic replacing raw ORB breakout chasing.
//
// Setup requires ALL of:
//   1. Price already broke above ORH at some point (breakout confirmed)
//   2. Price pulled back to within 0.1% of VWAP (the reclaim zone)
//   3. Current candle CLOSES back above VWAP with volume surge
//   4. Symbol is outperforming SPY by at least +0.1% (relative strength)
//
// Why this works better than raw breakout:
//   - You're buying a proven support level (VWAP) not chasing momentum
//   - The pullback shakes out weak hands — remaining buyers are committed
//   - Volume on the reclaim candle confirms institutional participation
//   - RS filter ensures you're in the market leader, not a follower
// ─────────────────────────────────────────────────────────────────────────────
export interface VwapReclaimSignal {
  valid:          boolean;
  entryPrice:     number;
  stopPrice:      number;      // Below the reclaim candle low (tighter than ORB midpoint)
  targetPrice:    number;      // 2× range size above entry
  stopDistance:   number;
  confidence:     number;
  volumeRatio:    number;
  relativeStrength: number;
  vwap:           number;
  reason:         string;
}

export function detectVwapReclaim(
  range:         OpeningRange,
  recentCandles: Candle[],     // Last 5–10 1m candles after breakout
  spyCandles:    Candle[],     // SPY 1m candles for relative strength
): VwapReclaimSignal {
  const noSignal = (reason: string): VwapReclaimSignal => ({
    valid: false, entryPrice: 0, stopPrice: 0, targetPrice: 0,
    stopDistance: 0, confidence: 0, volumeRatio: 0, relativeStrength: 0,
    vwap: 0, reason,
  });

  if (recentCandles.length < 3) return noSignal('Not enough candles for VWAP reclaim check');

  const vwap = computeSessionVwap([...range.candles, ...recentCandles]);
  if (vwap === null) return noSignal('Not enough candles to compute VWAP');

  // Check 1: did a candle CLOSE above ORH (confirmed breakout, not just a wick)?
  const brokeOut = recentCandles.some(c => c.close > range.high);
  if (!brokeOut) return noSignal(`No confirmed close above ORH $${range.high.toFixed(2)} yet`);

  const latest = recentCandles[recentCandles.length - 1];
  const prev   = recentCandles[recentCandles.length - 2];

  // Check 2: previous candle dipped to VWAP zone (within 0.15%)
  const vwapZone = vwap * 0.0015;
  const touchedVwap = prev.low <= vwap + vwapZone && prev.low >= vwap - vwapZone * 3;
  if (!touchedVwap) return noSignal(`No VWAP pullback (VWAP $${vwap.toFixed(2)}, prev low $${prev.low.toFixed(2)})`);

  // Check 3: current candle reclaims — closes above VWAP
  if (latest.close <= vwap) return noSignal(`No reclaim: close $${latest.close.toFixed(2)} ≤ VWAP $${vwap.toFixed(2)}`);

  // Check 4: volume confirmation on reclaim candle
  const volumeRatio = range.avgVolume > 0 ? latest.volume / range.avgVolume : 1.0;
  if (volumeRatio < ORB.volumeConfirmationMultiplier) {
    return noSignal(`Reclaim volume too low: ${volumeRatio.toFixed(2)}× (need ${ORB.volumeConfirmationMultiplier}×)`);
  }

  // Check 5: relative strength vs SPY
  const rs = computeRelativeStrength(recentCandles, spyCandles);
  if (rs < 0.001) {  // Must outperform SPY by at least 0.1%
    return noSignal(`Weak relative strength vs SPY: ${(rs * 100).toFixed(2)}%`);
  }

  // All checks passed — compute levels
  const entryPrice   = latest.close;
  const stopPrice    = Math.min(prev.low, vwap * 0.999);  // Below reclaim candle low
  const stopDistance = entryPrice - stopPrice;
  const targetPrice  = entryPrice + range.size * ORB.takeProfitMultiplier;

  if (stopPrice >= entryPrice) return noSignal(`Stop $${stopPrice.toFixed(2)} >= entry $${entryPrice.toFixed(2)} — invalid setup`);
  if (stopDistance <= 0) return noSignal('Invalid stop distance on reclaim');

  // Confidence: base + volume boost + RS boost + tight stop boost
  const volumeBoost = Math.min(0.15, (volumeRatio - 1) * 0.08);
  const rsBoost     = Math.min(0.10, rs * 5);
  const confidence  = Math.min(ORB_CONFIDENCE.maxConfidence,
    ORB_CONFIDENCE.base + volumeBoost + rsBoost,
  );

  return {
    valid:            true,
    entryPrice:       Math.round(entryPrice   * 100) / 100,
    stopPrice:        Math.round(stopPrice    * 100) / 100,
    targetPrice:      Math.round(targetPrice  * 100) / 100,
    stopDistance:     Math.round(stopDistance * 100) / 100,
    confidence:       Math.round(confidence   * 1000) / 1000,
    volumeRatio:      Math.round(volumeRatio  * 100) / 100,
    relativeStrength: Math.round(rs           * 10000) / 10000,
    vwap:             Math.round(vwap         * 100) / 100,
    reason: [
      `VWAP reclaim: close $${latest.close.toFixed(2)} > VWAP $${vwap.toFixed(2)}`,
      `RS vs SPY: +${(rs * 100).toFixed(2)}%`,
      `Volume: ${volumeRatio.toFixed(2)}× | Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)}`,
    ].join(' | '),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 4 — validateRange
//
// Full validation of an opening range before using it for trade decisions.
// Returns { valid, reason } so callers can log why a range was rejected.
// ─────────────────────────────────────────────────────────────────────────────
export function validateRange(range: OpeningRange): RangeValidation {
  // Must have candles
  if (range.candles.length === 0) {
    return { valid: false, reason: 'No candles in opening range' };
  }

  // Must have valid prices
  if (range.high <= 0 || range.low <= 0) {
    return { valid: false, reason: `Invalid prices: high=${range.high}, low=${range.low}` };
  }

  // High must be above low
  if (range.high <= range.low) {
    return { valid: false, reason: `High ($${range.high}) must be above low ($${range.low})` };
  }

  // Range too tight
  if (range.sizePct < ORB.minRangeSize) {
    return {
      valid:  false,
      reason: `Range too tight: ${(range.sizePct * 100).toFixed(3)}% < minimum ${(ORB.minRangeSize * 100).toFixed(1)}%`,
    };
  }

  // Range too wide (likely a gap open or news spike)
  if (range.sizePct > ORB.maxRangeSize) {
    return {
      valid:  false,
      reason: `Range too wide: ${(range.sizePct * 100).toFixed(2)}% > maximum ${(ORB.maxRangeSize * 100).toFixed(0)}%`,
    };
  }

  return {
    valid:  true,
    reason: `Valid range: $${range.low.toFixed(2)}–$${range.high.toFixed(2)} (${(range.sizePct * 100).toFixed(2)}% wide)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION 5 — detectVwapBounce
//
// Fires in choppy/inside-range markets where price never breaks out above ORH.
// Unlike detectVwapReclaim, this does NOT require a prior breakout — it just
// needs price to pull back to VWAP and bounce with volume.
//
// Setup requires ALL of:
//   1. Price is currently inside or near the opening range (not a runaway trend)
//   2. Previous candle touched or dipped below VWAP (the bounce zone)
//   3. Current candle closes ABOVE VWAP with volume confirmation
//   4. SPY is not in freefall (closes above its own VWAP — no buying into a falling market)
//   5. Stop below the bounce candle low — tight, well-defined risk
//
// Risk management:
//   - Stop: below the low of the bounce candle (typically 0.1–0.3% away)
//   - Target: 1.5× stop distance (conservative — works in choppy conditions)
//   - If stop distance is too large (>0.5%), the setup is rejected as sloppy
// ─────────────────────────────────────────────────────────────────────────────
export interface VwapBounceSignal {
  valid:        boolean;
  entryPrice:   number;
  stopPrice:    number;
  targetPrice:  number;
  stopDistance: number;
  confidence:   number;
  volumeRatio:  number;
  vwap:         number;
  reason:       string;
}

export function detectVwapBounce(
  range:         OpeningRange,
  recentCandles: Candle[],   // Last 5–15 1m candles
  spyCandles:    Candle[],   // SPY 1m candles
): VwapBounceSignal {
  const noSignal = (reason: string): VwapBounceSignal => ({
    valid: false, entryPrice: 0, stopPrice: 0, targetPrice: 0,
    stopDistance: 0, confidence: 0, volumeRatio: 0, vwap: 0, reason,
  });

  if (recentCandles.length < 3) return noSignal('Not enough candles for VWAP bounce check');

  const vwap = computeSessionVwap([...range.candles, ...recentCandles]);
  if (vwap === null) return noSignal('Not enough candles to compute VWAP');

  const latest = recentCandles[recentCandles.length - 1];
  const prev   = recentCandles[recentCandles.length - 2];

  // Check 1: price has NOT broken above ORH — this is the "inside range" bounce
  // (if it already broke out, detectVwapReclaim handles it)
  const alreadyBrokeOut = recentCandles.some(c => c.close > range.high);
  if (alreadyBrokeOut) return noSignal('Price already broke ORH — use VWAP reclaim instead');

  // Check 2: previous candle touched VWAP zone — must be near VWAP, not just anywhere below it
  const vwapZone    = vwap * 0.0025;
  const touchedVwap = prev.low <= vwap + vwapZone && prev.low >= vwap - vwapZone * 4;
  if (!touchedVwap) return noSignal(`No VWAP touch (VWAP $${vwap.toFixed(2)}, prev low $${prev.low.toFixed(2)})`);

  // Check 3: current candle closes above VWAP — the bounce
  if (latest.close <= vwap) return noSignal(`No bounce: close $${latest.close.toFixed(2)} ≤ VWAP $${vwap.toFixed(2)}`);

  // Check 4: volume confirmation — reject if no baseline to compare against
  if (range.avgVolume <= 0) return noSignal('No average volume data for confirmation');
  const volumeRatio = latest.volume / range.avgVolume;
  if (volumeRatio < ORB.volumeConfirmationMultiplier) {
    return noSignal(`Bounce volume too low: ${volumeRatio.toFixed(2)}× (need ${ORB.volumeConfirmationMultiplier}×)`);
  }

  // Check 5: SPY not in freefall — compute SPY VWAP and require SPY close above it
  if (spyCandles.length >= 5) {
    const spyVwap = computeSessionVwap(spyCandles);
    const spyLatest = spyCandles[spyCandles.length - 1];
    if (spyVwap !== null && spyLatest.close < spyVwap * 0.998) {
      return noSignal(`SPY below VWAP ($${spyLatest.close.toFixed(2)} < $${spyVwap.toFixed(2)}) — avoiding long in weak market`);
    }
  }

  // Risk levels
  const entryPrice   = latest.close;
  const stopPrice    = Math.min(prev.low, vwap * 0.999);
  const stopDistance = entryPrice - stopPrice;

  if (stopPrice >= entryPrice) return noSignal(`Stop $${stopPrice.toFixed(2)} >= entry $${entryPrice.toFixed(2)} — invalid setup`);
  if (stopDistance <= 0) return noSignal('Invalid stop distance');

  // Reject sloppy setups where stop is too far (>0.5% of price)
  if (stopDistance / entryPrice > 0.005) {
    return noSignal(`Stop too wide: ${(stopDistance / entryPrice * 100).toFixed(2)}% — setup is sloppy`);
  }

  // Conservative target: 1.5× risk (lower than ORB's 2× because we're in chop)
  const targetPrice = entryPrice + stopDistance * 1.5;

  // Confidence: moderate base, boosted by tight stop and strong volume
  const volumeBoost = Math.min(0.10, (volumeRatio - 1) * 0.06);
  const stopBoost   = Math.min(0.08, (0.005 - stopDistance / entryPrice) * 20); // tighter stop = higher confidence
  const confidence  = Math.min(0.78, ORB_CONFIDENCE.base + volumeBoost + stopBoost);

  return {
    valid:        true,
    entryPrice:   Math.round(entryPrice   * 100) / 100,
    stopPrice:    Math.round(stopPrice    * 100) / 100,
    targetPrice:  Math.round(targetPrice  * 100) / 100,
    stopDistance: Math.round(stopDistance * 100) / 100,
    confidence:   Math.round(confidence   * 1000) / 1000,
    volumeRatio:  Math.round(volumeRatio  * 100) / 100,
    vwap:         Math.round(vwap         * 100) / 100,
    reason: [
      `VWAP bounce: close $${latest.close.toFixed(2)} > VWAP $${vwap.toFixed(2)}`,
      `Volume: ${volumeRatio.toFixed(2)}× | Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)}`,
      `Risk: ${(stopDistance / entryPrice * 100).toFixed(2)}% | R:R 1.5×`,
    ].join(' | '),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY 3 — MEAN REVERSION
//
// Fires when price is stretched well below VWAP with RSI oversold and a
// rejection wick on the latest candle. Bets on snapback to VWAP.
//
// Conditions (all must pass):
//   1. RSI ≤ 38 — oversold
//   2. Price ≥ 0.8% below VWAP — stretched
//   3. Lower wick ≥ 40% of candle range — buyers pushing back
//   4. Current close > previous close — momentum turning
//   5. Stop ≤ 0.6% below entry — tight risk
// ─────────────────────────────────────────────────────────────────────────────

export interface MeanReversionSignal {
  valid:        boolean;
  entryPrice:   number;
  stopPrice:    number;
  targetPrice:  number;
  stopDistance: number;
  confidence:   number;
  rsi:          number;
  vwapStretch:  number;   // How far below VWAP as a fraction
  reason:       string;
}

export function detectMeanReversion(
  recentCandles: Candle[],
): MeanReversionSignal {
  const noSignal = (reason: string): MeanReversionSignal => ({
    valid: false, entryPrice: 0, stopPrice: 0, targetPrice: 0,
    stopDistance: 0, confidence: 0, rsi: 0, vwapStretch: 0, reason,
  });

  if (recentCandles.length < 15) return noSignal('Not enough candles for mean reversion');

  const vwap = computeSessionVwap(recentCandles);
  if (vwap === null) return noSignal('Cannot compute VWAP');

  const latest = recentCandles[recentCandles.length - 1];
  const prev   = recentCandles[recentCandles.length - 2];

  // 1. Price must be stretched below VWAP
  const vwapStretch = (vwap - latest.close) / vwap;
  if (vwapStretch < QUANT.meanReversion.vwapStretchPct) {
    return noSignal(`Price not stretched enough below VWAP: ${(vwapStretch * 100).toFixed(2)}% < ${(QUANT.meanReversion.vwapStretchPct * 100).toFixed(1)}%`);
  }

  // 2. RSI oversold
  const closes = recentCandles.map(c => c.close);
  let rsiValue: number;
  try {
    rsiValue = computeRSI(closes, 14).value;
  } catch {
    return noSignal('Not enough data for RSI');
  }
  if (rsiValue > QUANT.meanReversion.rsiThreshold) {
    return noSignal(`RSI ${rsiValue.toFixed(1)} not oversold enough (need ≤ ${QUANT.meanReversion.rsiThreshold})`);
  }

  // 3. Rejection wick on latest candle (lower wick ≥ 40% of range)
  const candleRange = latest.high - latest.low;
  if (candleRange <= 0) return noSignal('Zero-range candle');
  const lowerWick = latest.close - latest.low;
  const wickRatio = lowerWick / candleRange;
  if (wickRatio < QUANT.meanReversion.wickRejectionRatio) {
    return noSignal(`Lower wick too small: ${(wickRatio * 100).toFixed(0)}% < ${(QUANT.meanReversion.wickRejectionRatio * 100).toFixed(0)}% — no rejection`);
  }

  // 4. Momentum turning — current close > previous close
  if (latest.close <= prev.close) {
    return noSignal('No momentum turn: close not above previous close');
  }

  // 5. Risk levels — stop below the wick low, target at VWAP
  const entryPrice  = latest.close;
  const stopPrice   = Math.round(latest.low * (1 - 0.001) * 100) / 100; // 0.1% below wick low
  const stopDistance = entryPrice - stopPrice;

  if (stopPrice >= entryPrice) return noSignal(`Stop $${stopPrice.toFixed(2)} >= entry — invalid`);
  if (stopDistance / entryPrice > QUANT.meanReversion.maxStopPct) {
    return noSignal(`Stop too wide: ${(stopDistance / entryPrice * 100).toFixed(2)}% > ${(QUANT.meanReversion.maxStopPct * 100).toFixed(1)}%`);
  }

  // Target: VWAP (natural mean reversion target)
  const targetPrice = Math.round(vwap * 100) / 100;
  if (targetPrice <= entryPrice) return noSignal('VWAP target below entry — price already above VWAP');

  // Confidence: base + RSI depth boost + stretch boost
  const rsiBoost     = Math.min(0.10, (QUANT.meanReversion.rsiThreshold - rsiValue) / QUANT.meanReversion.rsiThreshold * 0.15);
  const stretchBoost = Math.min(0.08, vwapStretch * 5);
  const confidence   = Math.min(0.80, QUANT.meanReversion.confidenceBase + rsiBoost + stretchBoost);

  return {
    valid:        true,
    entryPrice:   Math.round(entryPrice   * 100) / 100,
    stopPrice:    Math.round(stopPrice    * 100) / 100,
    targetPrice:  Math.round(targetPrice  * 100) / 100,
    stopDistance: Math.round(stopDistance * 100) / 100,
    confidence:   Math.round(confidence   * 1000) / 1000,
    rsi:          Math.round(rsiValue     * 10)   / 10,
    vwapStretch:  Math.round(vwapStretch  * 10000) / 10000,
    reason: [
      `Mean reversion: RSI ${rsiValue.toFixed(1)}, ${(vwapStretch * 100).toFixed(2)}% below VWAP $${vwap.toFixed(2)}`,
      `Wick rejection: ${(wickRatio * 100).toFixed(0)}% | Stop: $${stopPrice.toFixed(2)} | Target VWAP: $${targetPrice.toFixed(2)}`,
      `Risk: ${(stopDistance / entryPrice * 100).toFixed(2)}% | R:R ${((targetPrice - entryPrice) / stopDistance).toFixed(1)}×`,
    ].join(' | '),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY 3b — SHORT MEAN REVERSION
//
// Mirror of detectMeanReversion. Fires when price is stretched well ABOVE VWAP
// with RSI overbought and a rejection (shooting star / upper wick) candle.
// Bets on a snapback DOWN to VWAP.
//
// Conditions (all must pass):
//   1. RSI ≥ 65 — overbought
//   2. Price ≥ 0.8% above VWAP — stretched upward
//   3. Upper wick ≥ 40% of candle range — sellers pushing back
//   4. Current close < previous close — momentum turning down
//   5. Stop ≤ 0.6% above entry — tight risk
// ─────────────────────────────────────────────────────────────────────────────

export interface ShortMeanReversionSignal {
  valid:        boolean;
  entryPrice:   number;
  stopPrice:    number;   // ABOVE entry
  targetPrice:  number;   // BELOW entry (VWAP)
  stopDistance: number;
  confidence:   number;
  rsi:          number;
  vwapStretch:  number;
  reason:       string;
}

export function detectShortMeanReversion(
  recentCandles: Candle[],
): ShortMeanReversionSignal {
  const noSignal = (reason: string): ShortMeanReversionSignal => ({
    valid: false, entryPrice: 0, stopPrice: 0, targetPrice: 0,
    stopDistance: 0, confidence: 0, rsi: 0, vwapStretch: 0, reason,
  });

  if (recentCandles.length < 15) return noSignal('Not enough candles for short mean reversion');

  const vwap = computeSessionVwap(recentCandles);
  if (vwap === null) return noSignal('Cannot compute VWAP');

  const latest = recentCandles[recentCandles.length - 1];
  const prev   = recentCandles[recentCandles.length - 2];

  // 1. Price stretched above VWAP
  const vwapStretch = (latest.close - vwap) / vwap;
  if (vwapStretch < QUANT.meanReversion.vwapStretchPct) {
    return noSignal(`Price not stretched enough above VWAP: ${(vwapStretch * 100).toFixed(2)}% < ${(QUANT.meanReversion.vwapStretchPct * 100).toFixed(1)}%`);
  }

  // 2. RSI overbought
  const closes = recentCandles.map(c => c.close);
  let rsiValue: number;
  try {
    rsiValue = computeRSI(closes, 14).value;
  } catch {
    return noSignal('Not enough data for RSI');
  }
  const rsiOverboughtThreshold = 100 - QUANT.meanReversion.rsiThreshold; // mirror of oversold
  if (rsiValue < rsiOverboughtThreshold) {
    return noSignal(`RSI ${rsiValue.toFixed(1)} not overbought enough (need ≥ ${rsiOverboughtThreshold})`);
  }

  // 3. Upper wick rejection on latest candle (upper wick ≥ 40% of range)
  const candleRange = latest.high - latest.low;
  if (candleRange <= 0) return noSignal('Zero-range candle');
  const upperWick = latest.high - latest.close;
  const wickRatio = upperWick / candleRange;
  if (wickRatio < QUANT.meanReversion.wickRejectionRatio) {
    return noSignal(`Upper wick too small: ${(wickRatio * 100).toFixed(0)}% < ${(QUANT.meanReversion.wickRejectionRatio * 100).toFixed(0)}% — no rejection`);
  }

  // 4. Momentum turning down
  if (latest.close >= prev.close) {
    return noSignal('No momentum turn: close not below previous close');
  }

  // 5. Risk levels — stop above the wick high, target at VWAP (below entry)
  const entryPrice   = latest.close;
  const stopPrice    = Math.round(latest.high * (1 + 0.001) * 100) / 100; // 0.1% above wick high
  const stopDistance = stopPrice - entryPrice;                              // always positive

  if (stopPrice <= entryPrice) return noSignal(`Stop $${stopPrice.toFixed(2)} <= entry — invalid`);
  if (stopDistance / entryPrice > QUANT.meanReversion.maxStopPct) {
    return noSignal(`Stop too wide: ${(stopDistance / entryPrice * 100).toFixed(2)}% > ${(QUANT.meanReversion.maxStopPct * 100).toFixed(1)}%`);
  }

  const targetPrice = Math.round(vwap * 100) / 100;
  if (targetPrice >= entryPrice) return noSignal('VWAP target above entry — price already below VWAP');

  const rsiBoost     = Math.min(0.10, (rsiValue - rsiOverboughtThreshold) / rsiOverboughtThreshold * 0.15);
  const stretchBoost = Math.min(0.08, vwapStretch * 5);
  const confidence   = Math.min(0.80, QUANT.meanReversion.confidenceBase + rsiBoost + stretchBoost);

  return {
    valid:        true,
    entryPrice:   Math.round(entryPrice   * 100) / 100,
    stopPrice:    Math.round(stopPrice    * 100) / 100,
    targetPrice:  Math.round(targetPrice  * 100) / 100,
    stopDistance: Math.round(stopDistance * 100) / 100,
    confidence:   Math.round(confidence   * 1000) / 1000,
    rsi:          Math.round(rsiValue     * 10)   / 10,
    vwapStretch:  Math.round(vwapStretch  * 10000) / 10000,
    reason: [
      `Short mean reversion: RSI ${rsiValue.toFixed(1)}, ${(vwapStretch * 100).toFixed(2)}% above VWAP $${vwap.toFixed(2)}`,
      `Upper wick rejection: ${(wickRatio * 100).toFixed(0)}% | Stop: $${stopPrice.toFixed(2)} | Target VWAP: $${targetPrice.toFixed(2)}`,
      `Risk: ${(stopDistance / entryPrice * 100).toFixed(2)}% | R:R ${((entryPrice - targetPrice) / stopDistance).toFixed(1)}×`,
    ].join(' | '),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY 3c — VWAP REJECTION SHORT
//
// Mirror of detectVwapBounce. Fires when price spikes above VWAP, fails to
// hold, and reverses back below with volume. Bets on continued move down.
//
// Conditions (all must pass):
//   1. Price has NOT broken below ORL (not a full breakdown — use detectBreakout)
//   2. Previous candle spiked above VWAP zone (the rejection zone)
//   3. Current candle closes BELOW VWAP — the rejection confirmed
//   4. Volume confirmation on rejection candle
//   5. SPY is not surging (SPY close below its own VWAP — weak market context)
//   6. Stop above the rejection candle high — tight, well-defined risk
// ─────────────────────────────────────────────────────────────────────────────
export interface VwapRejectionShortSignal {
  valid:        boolean;
  entryPrice:   number;
  stopPrice:    number;   // ABOVE entry
  targetPrice:  number;   // BELOW entry
  stopDistance: number;
  confidence:   number;
  volumeRatio:  number;
  vwap:         number;
  reason:       string;
}

export function detectVwapRejectionShort(
  range:         OpeningRange,
  recentCandles: Candle[],   // Last 5–15 1m candles
  spyCandles:    Candle[],   // SPY 1m candles
): VwapRejectionShortSignal {
  const noSignal = (reason: string): VwapRejectionShortSignal => ({
    valid: false, entryPrice: 0, stopPrice: 0, targetPrice: 0,
    stopDistance: 0, confidence: 0, volumeRatio: 0, vwap: 0, reason,
  });

  if (recentCandles.length < 3) return noSignal('Not enough candles for VWAP rejection short');

  const vwap = computeSessionVwap([...range.candles, ...recentCandles]);
  if (vwap === null) return noSignal('Not enough candles to compute VWAP');

  const latest = recentCandles[recentCandles.length - 1];
  const prev   = recentCandles[recentCandles.length - 2];

  // Check 1: price has NOT broken below ORL — full breakdown handled by detectBreakout
  const alreadyBrokenDown = recentCandles.some(c => c.close < range.low);
  if (alreadyBrokenDown) return noSignal('Price already broke ORL — use short breakdown instead');

  // Check 2: previous candle spiked into VWAP zone from above
  const vwapZone    = vwap * 0.0025;
  const spikedAbove = prev.high >= vwap - vwapZone && prev.high <= vwap + vwapZone * 4;
  if (!spikedAbove) return noSignal(`No VWAP spike (VWAP $${vwap.toFixed(2)}, prev high $${prev.high.toFixed(2)})`);

  // Check 3: current candle closes below VWAP — rejection confirmed
  if (latest.close >= vwap) return noSignal(`No rejection: close $${latest.close.toFixed(2)} ≥ VWAP $${vwap.toFixed(2)}`);

  // Check 4: volume confirmation
  if (range.avgVolume <= 0) return noSignal('No average volume data for confirmation');
  const volumeRatio = latest.volume / range.avgVolume;
  if (volumeRatio < ORB.volumeConfirmationMultiplier) {
    return noSignal(`Rejection volume too low: ${volumeRatio.toFixed(2)}× (need ${ORB.volumeConfirmationMultiplier}×)`);
  }

  // Check 5: SPY not surging — require SPY close below its own VWAP (weak market)
  if (spyCandles.length >= 5) {
    const spyVwap   = computeSessionVwap(spyCandles);
    const spyLatest = spyCandles[spyCandles.length - 1];
    if (spyVwap !== null && spyLatest.close > spyVwap * 1.002) {
      return noSignal(`SPY above VWAP ($${spyLatest.close.toFixed(2)} > $${spyVwap.toFixed(2)}) — avoiding short in strong market`);
    }
  }

  // Risk levels — stop above rejection candle high, target 1.5× below entry
  const entryPrice   = latest.close;
  const stopPrice    = Math.max(prev.high, vwap * 1.001);  // Above rejection high
  const stopDistance = stopPrice - entryPrice;              // Always positive

  if (stopPrice <= entryPrice) return noSignal(`Stop $${stopPrice.toFixed(2)} <= entry $${entryPrice.toFixed(2)} — invalid setup`);
  if (stopDistance <= 0) return noSignal('Invalid stop distance');

  // Reject sloppy setups where stop is too far (>0.5% of price)
  if (stopDistance / entryPrice > 0.005) {
    return noSignal(`Stop too wide: ${(stopDistance / entryPrice * 100).toFixed(2)}% — setup is sloppy`);
  }

  // Conservative target: 1.5× risk below entry
  const targetPrice = entryPrice - stopDistance * 1.5;

  // Confidence: moderate base, boosted by tight stop and strong volume
  const volumeBoost = Math.min(0.10, (volumeRatio - 1) * 0.06);
  const stopBoost   = Math.min(0.08, (0.005 - stopDistance / entryPrice) * 20);
  const confidence  = Math.min(0.78, ORB_CONFIDENCE.base + volumeBoost + stopBoost);

  return {
    valid:        true,
    entryPrice:   Math.round(entryPrice   * 100) / 100,
    stopPrice:    Math.round(stopPrice    * 100) / 100,
    targetPrice:  Math.round(targetPrice  * 100) / 100,
    stopDistance: Math.round(stopDistance * 100) / 100,
    confidence:   Math.round(confidence   * 1000) / 1000,
    volumeRatio:  Math.round(volumeRatio  * 100) / 100,
    vwap:         Math.round(vwap         * 100) / 100,
    reason: [
      `VWAP rejection short: close $${latest.close.toFixed(2)} < VWAP $${vwap.toFixed(2)}`,
      `Volume: ${volumeRatio.toFixed(2)}× | Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)}`,
      `Risk: ${(stopDistance / entryPrice * 100).toFixed(2)}% | R:R 1.5×`,
    ].join(' | '),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY 4 — MOMENTUM CONTINUATION
//
// Fires when price is in an established uptrend, pulls back cleanly to the
// 5m EMA9, and resumes higher. No new breakout needed — the trend is already
// confirmed. This catches the "second leg" of a move.
//
// Conditions (all must pass):
//   1. Price pulled back to within 0.1–0.8% of EMA9 (not overextended)
//   2. Current close > EMA9 (reclaimed after touch)
//   3. RSI 45–72 (momentum but not exhausted)
//   4. EMA9 is sloping up (trend intact)
//   5. Latest candle is a bullish candle (close > open)
// ─────────────────────────────────────────────────────────────────────────────

export interface MomentumSignal {
  valid:        boolean;
  entryPrice:   number;
  stopPrice:    number;
  targetPrice:  number;
  stopDistance: number;
  confidence:   number;
  rsi:          number;
  ema9:         number;
  reason:       string;
}

export function detectMomentumContinuation(
  recentCandles: Candle[],
  candles5m:     Candle[],
): MomentumSignal {
  const noSignal = (reason: string): MomentumSignal => ({
    valid: false, entryPrice: 0, stopPrice: 0, targetPrice: 0,
    stopDistance: 0, confidence: 0, rsi: 0, ema9: 0, reason,
  });

  if (candles5m.length < 15) return noSignal('Not enough 5m candles for momentum check');
  if (recentCandles.length < 5) return noSignal('Not enough 1m candles');

  // Compute EMA9 on 5m closes
  const closes5m = candles5m.map(c => c.close);
  const ema9Values = computeEMAValues(closes5m, 9);
  if (ema9Values.length < 5) return noSignal('EMA9 calculation failed');

  const ema9     = ema9Values[ema9Values.length - 1];
  const ema9Prev = ema9Values[ema9Values.length - 4]; // 3 candles back = ~15 min slope

  // 1. EMA9 must be sloping up
  if (ema9 <= ema9Prev) return noSignal(`EMA9 not sloping up ($${ema9.toFixed(2)} ≤ $${ema9Prev.toFixed(2)}) — no trend`);

  const latest = recentCandles[recentCandles.length - 1];
  const prev   = recentCandles[recentCandles.length - 2];

  // 2. Latest candle is bullish
  if (latest.close <= latest.open) return noSignal('Latest candle bearish — no momentum confirmation');

  // 3. Current close is above EMA9 (just reclaimed it)
  if (latest.close <= ema9) return noSignal(`Close $${latest.close.toFixed(2)} below EMA9 $${ema9.toFixed(2)}`);

  // 4. Previous candle touched EMA9 zone (the pullback).
  // distFromEma9 is negative when low dips below EMA9, positive when above.
  // Accept range: low came within minPullbackPct above EMA9, or dipped at most maxPullbackPct below.
  const distFromEma9 = (prev.low - ema9) / ema9;
  if (distFromEma9 > QUANT.momentum.minEma9PullbackPct) {
    return noSignal(`Pullback didn't reach EMA9: low ${(distFromEma9 * 100).toFixed(2)}% above EMA9 — not close enough`);
  }
  if (distFromEma9 < -QUANT.momentum.maxEma9PullbackPct) {
    return noSignal(`Price too far below EMA9: ${(Math.abs(distFromEma9) * 100).toFixed(2)}% — not a clean pullback`);
  }

  // 5. RSI in momentum zone — not exhausted, not flat
  const closes1m = recentCandles.map(c => c.close);
  // RSI requires at least period+1 values; enforce a minimum period of 5 to avoid degenerate results
  const rsiPeriod = Math.min(14, closes1m.length - 1);
  if (rsiPeriod < 5) return noSignal('Not enough 1m candles for RSI');
  let rsiValue: number;
  try {
    rsiValue = computeRSI(closes1m, rsiPeriod).value;
  } catch {
    return noSignal('Not enough data for RSI');
  }
  if (rsiValue < QUANT.momentum.minRsi) return noSignal(`RSI ${rsiValue.toFixed(1)} too low — momentum lost`);
  if (rsiValue > QUANT.momentum.maxRsi) return noSignal(`RSI ${rsiValue.toFixed(1)} overbought — chasing`);

  // Risk levels: stop below the pullback low (EMA9 touch candle)
  const entryPrice   = latest.close;
  const stopPrice    = Math.round(Math.min(prev.low, ema9 * 0.999) * 100) / 100;
  const stopDistance = entryPrice - stopPrice;

  if (stopPrice >= entryPrice) return noSignal(`Stop $${stopPrice.toFixed(2)} >= entry — invalid`);
  if (stopDistance / entryPrice > 0.012) {
    return noSignal(`Stop too wide: ${(stopDistance / entryPrice * 100).toFixed(2)}% > 1.2%`);
  }

  // Target: 2× risk
  const targetPrice = entryPrice + stopDistance * QUANT.momentum.targetRR;

  // Confidence: base + RSI quality + EMA slope boost
  const rsiMidBoost  = Math.min(0.08, Math.abs(rsiValue - 55) < 10 ? 0.06 : 0.02); // sweet spot 45–65
  const slopeBoost   = Math.min(0.07, ((ema9 - ema9Prev) / ema9Prev) * 500);
  const confidence   = Math.min(0.82, QUANT.momentum.confidenceBase + rsiMidBoost + slopeBoost);

  return {
    valid:        true,
    entryPrice:   Math.round(entryPrice   * 100) / 100,
    stopPrice:    Math.round(stopPrice    * 100) / 100,
    targetPrice:  Math.round(targetPrice  * 100) / 100,
    stopDistance: Math.round(stopDistance * 100) / 100,
    confidence:   Math.round(confidence   * 1000) / 1000,
    rsi:          Math.round(rsiValue     * 10)   / 10,
    ema9:         Math.round(ema9         * 100)  / 100,
    reason: [
      `Momentum continuation: EMA9 $${ema9.toFixed(2)} sloping up, RSI ${rsiValue.toFixed(1)}`,
      `Pullback touched EMA9, resumed → entry $${entryPrice.toFixed(2)}`,
      `Stop: $${stopPrice.toFixed(2)} | Target: $${targetPrice.toFixed(2)} | R:R ${QUANT.momentum.targetRR}×`,
    ].join(' | '),
  };
}
