import { ORB, ASSETS, RISK } from '../config.js';
import { fetchHistoricalBars, monthsAgo } from '../tools/historicalData.js';
import { buildOpeningRange, detectVwapReclaim, detectBreakout, detectVwapRejectionShort, computeRelativeStrength, validateRange, isRangeTooTight } from '../strategy/openingRange.js';
import { log } from './logger.js';
import type { Candle } from '../tools/marketData.js';
import {
  updateLearnedWeights,
  updateRegimeMemory,
  updateCoinMemory,
  classifyRegime,
} from '../agents/brain.js';
import type { SessionLog, TradeRecord } from '../agents/journal.js';

// ─────────────────────────────────────────────────────────────────────────────
// ORB BACKTESTER
//
// Replays the ORB strategy on months of real Alpaca 1-minute bars.
// Each historical trading day is treated as a "session" — the same logic
// the live bot runs, but replayed at full speed.
//
// Two modes:
//   REPORT MODE (default) — print results, no brain update
//   TRAIN MODE  (--train) — feed every simulated trade into the brain so ARIA
//                           starts tomorrow already knowing what works
//
// Usage:
//   npm run backtest              → report, all symbols, 6 months
//   npm run backtest -- QQQ       → report, single symbol
//   npm run backtest -- --train   → train brain on all symbols
//   npm run backtest -- QQQ --train --months 3
// ─────────────────────────────────────────────────────────────────────────────

// Realistic trading cost applied to EVERY backtest trade. Without this the
// backtest is pure-frictionless fantasy. Each round trip (enter + exit) pays
// slippage on both fills plus commission. 0.10% round-trip is conservative-
// realistic for these high-volatility names on market/marketable orders.
// This is the single biggest reason backtests look great and fail live.
const ROUND_TRIP_COST_PCT = 0.0010; // 0.10% deducted from every trade's pnlPct

export interface OrbBacktestTrade {
  date:          string;
  symbol:        string;
  rangeHigh:     number;
  rangeLow:      number;
  rangeSizePct:  number;
  entryPrice:    number;
  stopPrice:     number;
  partialPrice:  number;   // 1× target
  targetPrice:   number;   // 2× target
  exitPrice:     number;
  exitReason:    'stop_loss' | 'partial_then_stop' | 'partial_then_target' | 'take_profit' | 'hard_close';
  exitTime:      string;
  pnlPct:        number;
  outcome:       'WIN' | 'LOSS';
  volumeRatio:   number;
  confidence:    number;
}

export interface OrbBacktestReport {
  symbol:           string;
  daysAnalyzed:     number;
  daysWithRange:    number;
  daysWithBreakout: number;
  totalTrades:      number;
  winRate:          number;
  avgWinPct:        number;
  avgLossPct:       number;
  profitFactor:     number;
  expectancy:       number;
  maxDrawdownPct:   number;
  sharpeRatio:      number;
  totalReturnPct:   number;
  avgVolRatio:      number;
  trades:           OrbBacktestTrade[];
  passed:           boolean;
  failReason:       string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ET TIME HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function toEtMinutes(date: Date): number {
  const year     = date.getUTCFullYear();
  const dstStart = nthSundayOfMonth(year, 3,  2);  // 2nd Sunday March
  const dstEnd   = nthSundayOfMonth(year, 11, 1);  // 1st Sunday November
  const isDst    = date >= dstStart && date < dstEnd;
  const offsetMs = isDst ? 4 * 3600000 : 5 * 3600000;
  const etDate   = new Date(date.getTime() - offsetMs);
  return etDate.getUTCHours() * 60 + etDate.getUTCMinutes();
}

function nthSundayOfMonth(year: number, month: number, nth: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day   = first.getUTCDay();
  const firstSunday = day === 0 ? 1 : 8 - day;
  return new Date(Date.UTC(year, month - 1, firstSunday + (nth - 1) * 7));
}

function formatEtTime(date: Date): string {
  const m = toEtMinutes(date);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP CANDLES BY TRADING DAY
// ─────────────────────────────────────────────────────────────────────────────

function groupByDay(candles: Candle[]): Map<string, Candle[]> {
  const days = new Map<string, Candle[]>();
  for (const c of candles) {
    const etMin = toEtMinutes(c.openTime);
    const offset = etMin < 0 ? 5 : 4;
    const dateKey = new Date(c.openTime.getTime() - offset * 3600000)
      .toISOString().split('T')[0];
    if (!days.has(dateKey)) days.set(dateKey, []);
    days.get(dateKey)!.push(c);
  }
  return days;
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATE ONE DAY — with partial profit logic (mirrors live positionManager)
// ─────────────────────────────────────────────────────────────────────────────

function simulateDay(
  symbol:     string,
  date:       string,
  candles:    Candle[],
  spyCandles: Candle[],  // SPY candles for the same day (SPY trend gate + RS)
): OrbBacktestTrade | null {
  const session = candles.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m <= 630;  // 9:30–10:30 ET
  });

  if (session.length < 20) return null;

  // ── SPY trend gate — skip if SPY 5m EMA9 is sloping down ─────────────────
  const spySession = spyCandles.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m <= 630;
  });
  if (spySession.length >= 9) {
    // Build a simple EMA9 slope check: compare last bar to 4 bars ago
    const closes = spySession.map(c => c.close);
    let ema = closes[0];
    const k = 2 / (9 + 1);
    const emaValues: number[] = [ema];
    for (let i = 1; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      emaValues.push(ema);
    }
    const last = emaValues[emaValues.length - 1];
    const prev = emaValues[Math.max(0, emaValues.length - 5)];
    if (last < prev) return null;  // SPY trending down — skip
  }

  const rangeCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m < 585;  // 9:30–9:44
  });

  const preRange = candles.filter(c => toEtMinutes(c.openTime) < 570).slice(-10);

  if (rangeCandles.length < 5) return null;

  let range;
  try {
    range = buildOpeningRange(symbol, rangeCandles, preRange);
  } catch {
    return null;
  }

  if (!validateRange(range).valid || isRangeTooTight(range)) return null;

  // Walk 9:45–10:00 for VWAP reclaim (tighter window = better entries)
  const tradingCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 585 && m < 610;  // 9:45–10:09 ET
  });

  let entered       = false;
  let entryPrice    = 0;
  let stopPrice     = 0;
  let partialPrice  = 0;
  let targetPrice   = 0;
  let entryCandle: Candle | null = null;
  let volumeRatio   = 0;
  let confidence    = 0;

  for (let i = 2; i < tradingCandles.length; i++) {
    if (entered) break;
    const recentWindow = tradingCandles.slice(0, i + 1);
    const spyWindow    = spySession.slice(0, Math.min(i + 1, spySession.length));

    const reclaim = detectVwapReclaim(range, recentWindow, spyWindow);

    if (reclaim.valid && reclaim.confidence >= RISK.minConfidenceToTrade) {
      entered      = true;
      entryPrice   = reclaim.entryPrice;
      stopPrice    = reclaim.stopPrice;
      partialPrice = entryPrice + range.size;
      targetPrice  = reclaim.targetPrice;
      entryCandle  = tradingCandles[i];
      volumeRatio  = reclaim.volumeRatio;
      confidence   = reclaim.confidence;
    }
  }

  if (!entered || !entryCandle) return null;

  // Walk remaining candles (up to 10:30) simulating partial profit logic
  const managingCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m > toEtMinutes(entryCandle!.openTime) && m <= 630;
  });

  let exitPrice: number  = entryPrice;
  let exitReason: OrbBacktestTrade['exitReason'] = 'hard_close';
  let exitTime = '10:30';
  let partialHit = false;

  for (const c of managingCandles) {
    // WORST-CASE INTRA-CANDLE ORDERING (LONG): if a single candle's range spans
    // BOTH the stop and the profit level, we cannot know which was hit first from
    // 1m bars. Always resolve the STOP first — the pessimistic outcome. This kills
    // the look-ahead bias that inflates backtest results vs live.
    if (!partialHit) {
      // Phase: OPEN — stop checked BEFORE partial (worst case)
      if (c.low <= stopPrice) {
        exitPrice  = stopPrice;
        exitReason = 'stop_loss';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
      if (c.high >= partialPrice) {
        // Partial profit hit — 50% sold, stop trails to entry.
        partialHit = true;
        stopPrice  = entryPrice;
      }
    } else {
      // Phase: PARTIAL_PROFIT — stop (now at entry) still checked FIRST.
      if (c.low <= stopPrice) {
        exitPrice  = (partialPrice + entryPrice) / 2;  // 50% at 1×, 50% at entry
        exitReason = 'partial_then_stop';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
      if (c.high >= targetPrice) {
        exitPrice  = (partialPrice + targetPrice) / 2; // 50% at 1×, 50% at 2×
        exitReason = 'partial_then_target';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
    }
  }

  // Hard close at 10:30
  if (exitReason === 'hard_close') {
    const last = managingCandles[managingCandles.length - 1];
    if (partialHit) {
      // 50% at partial price, 50% at last close
      exitPrice = (partialPrice + (last?.close ?? entryPrice)) / 2;
    } else {
      exitPrice = last?.close ?? entryPrice;
    }
  }

  const grossPnlPct = entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : 0;
  const pnlPct  = grossPnlPct - ROUND_TRIP_COST_PCT;  // deduct realistic trading cost
  const outcome: 'WIN' | 'LOSS' = pnlPct > 0 ? 'WIN' : 'LOSS';

  return {
    date,
    symbol,
    rangeHigh:    Math.round(range.high        * 100) / 100,
    rangeLow:     Math.round(range.low         * 100) / 100,
    rangeSizePct: Math.round(range.sizePct     * 10000) / 100,
    entryPrice:   Math.round(entryPrice        * 100) / 100,
    stopPrice:    Math.round(stopPrice         * 100) / 100,
    partialPrice: Math.round(partialPrice      * 100) / 100,
    targetPrice:  Math.round(targetPrice       * 100) / 100,
    exitPrice:    Math.round(exitPrice         * 100) / 100,
    exitReason,
    exitTime,
    pnlPct:       Math.round(pnlPct            * 10000) / 10000,
    outcome,
    volumeRatio:  Math.round(volumeRatio       * 100) / 100,
    confidence:   Math.round(confidence        * 1000) / 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATE ONE DAY — SHORT breakdown (mirrors simulateDay for longs)
//
// Looks for an ORB breakdown: close below ORL with volume confirmation.
// Manages position with symmetric partial-profit logic (target below entry).
// ─────────────────────────────────────────────────────────────────────────────

function simulateShortDay(
  symbol:     string,
  date:       string,
  candles:    Candle[],
  spyCandles: Candle[],
): OrbBacktestTrade | null {
  const session = candles.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m <= 630;  // 9:30–10:30 ET
  });

  if (session.length < 20) return null;

  // ── SPY trend gate — skip if SPY 5m EMA9 is sloping UP (tailwind against shorts) ──
  const spySession = spyCandles.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m <= 630;
  });
  if (spySession.length >= 9) {
    const closes = spySession.map(c => c.close);
    let ema = closes[0];
    const k = 2 / (9 + 1);
    const emaValues: number[] = [ema];
    for (let i = 1; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      emaValues.push(ema);
    }
    const last = emaValues[emaValues.length - 1];
    const prev = emaValues[Math.max(0, emaValues.length - 5)];
    if (last > prev) return null;  // SPY trending up — skip shorts
  }

  const rangeCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m < 585;  // 9:30–9:44
  });

  const preRange = candles.filter(c => toEtMinutes(c.openTime) < 570).slice(-10);

  if (rangeCandles.length < 5) return null;

  let range;
  try {
    range = buildOpeningRange(symbol, rangeCandles, preRange);
  } catch {
    return null;
  }

  if (!validateRange(range).valid || isRangeTooTight(range)) return null;

  // Walk 9:45–10:09 for ORB short breakdown
  const tradingCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 585 && m < 610;
  });

  let entered       = false;
  let entryPrice    = 0;
  let stopPrice     = 0;
  let partialPrice  = 0;
  let targetPrice   = 0;
  let entryCandle: Candle | null = null;
  let volumeRatio   = 0;
  let confidence    = 0;

  for (let i = 1; i < tradingCandles.length; i++) {
    if (entered) break;
    const recentWindow = tradingCandles.slice(0, i + 1);
    const sig = detectBreakout(range, tradingCandles[i], recentWindow);

    if (sig.direction === 'SHORT' && sig.confidence >= RISK.minConfidenceToTrade) {
      entered      = true;
      entryPrice   = sig.entryPrice;
      stopPrice    = sig.stopPrice;        // midpoint (above entry)
      partialPrice = entryPrice - range.size;           // 1× target below entry
      targetPrice  = entryPrice - (range.size * ORB.takeProfitMultiplier); // 2× target
      entryCandle  = tradingCandles[i];
      volumeRatio  = sig.volumeRatio;
      confidence   = sig.confidence;
    }
  }

  if (!entered || !entryCandle) return null;

  const managingCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m > toEtMinutes(entryCandle!.openTime) && m <= 630;
  });

  let exitPrice: number  = entryPrice;
  let exitReason: OrbBacktestTrade['exitReason'] = 'hard_close';
  let exitTime = '10:30';
  let partialHit = false;

  for (const c of managingCandles) {
    if (!partialHit) {
      // Phase: OPEN — stop above entry, partial target below entry
      if (c.high >= stopPrice) {
        exitPrice  = stopPrice;
        exitReason = 'stop_loss';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
      if (c.low <= partialPrice) {
        partialHit = true;
        stopPrice  = entryPrice;  // Stop to entry — risk-free on remainder
      }
    } else {
      // Phase: PARTIAL_PROFIT — trailing to 2× target
      if (c.high >= stopPrice) {
        exitPrice  = (partialPrice + entryPrice) / 2;  // blended: 50% at 1×, 50% at entry
        exitReason = 'partial_then_stop';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
      if (c.low <= targetPrice) {
        exitPrice  = (partialPrice + targetPrice) / 2;  // blended: 50% at 1×, 50% at 2×
        exitReason = 'partial_then_target';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
    }
  }

  // Hard close at 10:30
  if (exitReason === 'hard_close') {
    const last = managingCandles[managingCandles.length - 1];
    if (partialHit) {
      exitPrice = (partialPrice + (last?.close ?? entryPrice)) / 2;
    } else {
      exitPrice = last?.close ?? entryPrice;
    }
  }

  // Short P&L: profit when price falls
  const grossPnlPct = entryPrice > 0 ? (entryPrice - exitPrice) / entryPrice : 0;
  const pnlPct  = grossPnlPct - ROUND_TRIP_COST_PCT;  // deduct realistic trading cost
  const outcome: 'WIN' | 'LOSS' = pnlPct > 0 ? 'WIN' : 'LOSS';

  return {
    date,
    symbol,
    rangeHigh:    Math.round(range.high        * 100) / 100,
    rangeLow:     Math.round(range.low         * 100) / 100,
    rangeSizePct: Math.round(range.sizePct     * 10000) / 100,
    entryPrice:   Math.round(entryPrice        * 100) / 100,
    stopPrice:    Math.round(stopPrice         * 100) / 100,
    partialPrice: Math.round(partialPrice      * 100) / 100,
    targetPrice:  Math.round(targetPrice       * 100) / 100,
    exitPrice:    Math.round(exitPrice         * 100) / 100,
    exitReason,
    exitTime,
    pnlPct:       Math.round(pnlPct            * 10000) / 10000,
    outcome,
    volumeRatio:  Math.round(volumeRatio       * 100) / 100,
    confidence:   Math.round(confidence        * 1000) / 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATE ONE DAY — VWAP rejection short (midday fade after failed rally)
//
// Looks for price spiking into VWAP zone then closing below it.
// Manages position with same partial-profit logic as other strategies.
// ─────────────────────────────────────────────────────────────────────────────

function simulateVwapRejectionShortDay(
  symbol:     string,
  date:       string,
  candles:    Candle[],
  spyCandles: Candle[],
): OrbBacktestTrade | null {
  // Use midday window (10:30–12:00) where VWAP rejections are most common
  const session = candles.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m <= 720;  // 9:30–12:00 ET (need context from open)
  });

  if (session.length < 20) return null;

  const spySession = spyCandles.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m <= 720;
  });

  const rangeCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m < 585;
  });
  const preRange = candles.filter(c => toEtMinutes(c.openTime) < 570).slice(-10);
  if (rangeCandles.length < 5) return null;

  let range;
  try {
    range = buildOpeningRange(symbol, rangeCandles, preRange);
  } catch {
    return null;
  }
  if (!validateRange(range).valid || isRangeTooTight(range)) return null;

  // Walk 10:30–12:00 looking for a VWAP rejection short signal
  const tradingCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 630 && m < 720;
  });

  let entered      = false;
  let entryPrice   = 0;
  let stopPrice    = 0;
  let targetPrice  = 0;
  let entryCandle: Candle | null = null;
  let volumeRatio  = 0;
  let confidence   = 0;

  for (let i = 2; i < tradingCandles.length; i++) {
    if (entered) break;
    const allSoFar  = [...session.filter(c => toEtMinutes(c.openTime) < 630), ...tradingCandles.slice(0, i + 1)];
    const spyWindow = spySession.slice(0, Math.min(allSoFar.length, spySession.length));
    const sig = detectVwapRejectionShort(range, allSoFar.slice(-15), spyWindow.slice(-15));

    if (sig.valid && sig.confidence >= RISK.minConfidenceToTrade) {
      entered     = true;
      entryPrice  = sig.entryPrice;
      stopPrice   = sig.stopPrice;
      targetPrice = sig.targetPrice;
      entryCandle = tradingCandles[i];
      volumeRatio = sig.volumeRatio;
      confidence  = sig.confidence;
    }
  }

  if (!entered || !entryCandle) return null;

  const stopDistance = stopPrice - entryPrice;
  const partialPrice = entryPrice - stopDistance;  // 1× risk below entry

  const managingCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m > toEtMinutes(entryCandle!.openTime) && m <= 720;
  });

  let exitPrice: number = entryPrice;
  let exitReason: OrbBacktestTrade['exitReason'] = 'hard_close';
  let exitTime = '12:00';
  let partialHit = false;
  let activeStop = stopPrice;

  for (const c of managingCandles) {
    if (!partialHit) {
      if (c.high >= activeStop) {
        exitPrice  = activeStop;
        exitReason = 'stop_loss';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
      if (c.low <= partialPrice) {
        partialHit = true;
        activeStop = entryPrice;  // risk-free on remainder
      }
    } else {
      if (c.high >= activeStop) {
        exitPrice  = (partialPrice + entryPrice) / 2;
        exitReason = 'partial_then_stop';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
      if (c.low <= targetPrice) {
        exitPrice  = (partialPrice + targetPrice) / 2;
        exitReason = 'partial_then_target';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
    }
  }

  if (exitReason === 'hard_close') {
    const last = managingCandles[managingCandles.length - 1];
    exitPrice = partialHit
      ? (partialPrice + (last?.close ?? entryPrice)) / 2
      : (last?.close ?? entryPrice);
  }

  const grossPnlPct = entryPrice > 0 ? (entryPrice - exitPrice) / entryPrice : 0;
  const pnlPct  = grossPnlPct - ROUND_TRIP_COST_PCT;  // deduct realistic trading cost
  const outcome: 'WIN' | 'LOSS' = pnlPct > 0 ? 'WIN' : 'LOSS';

  return {
    date,
    symbol,
    rangeHigh:    Math.round(range.high        * 100) / 100,
    rangeLow:     Math.round(range.low         * 100) / 100,
    rangeSizePct: Math.round(range.sizePct     * 10000) / 100,
    entryPrice:   Math.round(entryPrice        * 100) / 100,
    stopPrice:    Math.round(stopPrice         * 100) / 100,
    partialPrice: Math.round(partialPrice      * 100) / 100,
    targetPrice:  Math.round(targetPrice       * 100) / 100,
    exitPrice:    Math.round(exitPrice         * 100) / 100,
    exitReason,
    exitTime,
    pnlPct:       Math.round(pnlPct            * 10000) / 10000,
    outcome,
    volumeRatio:  Math.round(volumeRatio       * 100) / 100,
    confidence:   Math.round(confidence        * 1000) / 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE METRICS from a list of trades
// ─────────────────────────────────────────────────────────────────────────────

function computeMetrics(trades: OrbBacktestTrade[]) {
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');

  const winRate      = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWinPct    = wins.length   > 0 ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   : 0;
  const avgLossPct   = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const grossWins    = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss    = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossWins / grossLoss : grossWins > 0 ? 999 : 0;
  const expectancy   = winRate * avgWinPct + (1 - winRate) * avgLossPct;
  const totalReturn  = trades.reduce((s, t) => s + t.pnlPct, 0);
  const mean         = trades.length > 0 ? totalReturn / trades.length : 0;
  const variance     = trades.length > 1
    ? trades.reduce((s, t) => s + Math.pow(t.pnlPct - mean, 2), 0) / (trades.length - 1)
    : 0;
  const sharpe       = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;
  const avgVolRatio  = trades.length > 0 ? trades.reduce((s, t) => s + t.volumeRatio, 0) / trades.length : 0;

  let peak = 0, maxDd = 0, cum = 0;
  for (const t of trades) {
    cum += t.pnlPct;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDd) maxDd = dd;
  }

  return { winRate, avgWinPct, avgLossPct, profitFactor, expectancy, totalReturn, sharpe, avgVolRatio, maxDrawdown: Math.abs(maxDd) };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMULATE ONE DAY — Mean-Reversion Fade
//
// Scans the post-ORB session (9:45–3:55) for failed breakouts: a candle that
// closed outside the opening range followed by a candle that closed back inside.
// On detection, simulates an entry at the reclaim close with stop just beyond
// the failed extreme and target at the range midpoint.
//
// At most ONE fade trade per symbol per day to avoid overcounting. We take the
// FIRST signal that fires and ignore later ones.
// ─────────────────────────────────────────────────────────────────────────────

function simulateFadeDay(
  symbol:     string,
  date:       string,
  candles:    Candle[],
  _spy:       Candle[],     // unused but kept for signature symmetry
): OrbBacktestTrade | null {
  const session = candles.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m <= 835;   // 9:30 ET – 13:55 ET (cover ORB + Midday windows; Power Hour rare for fades)
  });

  if (session.length < 30) return null;

  const rangeCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 570 && m < 585;   // 9:30–9:44
  });
  const preRange = candles.filter(c => toEtMinutes(c.openTime) < 570).slice(-10);

  if (rangeCandles.length < 5) return null;

  let range;
  try {
    range = buildOpeningRange(symbol, rangeCandles, preRange);
  } catch {
    return null;
  }
  if (!validateRange(range).valid || isRangeTooTight(range)) return null;

  // Walk post-range candles looking for failed-breakout-then-reclaim pattern.
  // Manual detection here (mirrors detectFade) so the backtester is self-contained
  // and doesn't depend on the analyst module's configureFade() side effect.
  const FADE_LOOKBACK    = 3;
  const FADE_VOL_FLOOR   = 0.8;
  const FADE_MAX_OVERSHOOT = 0.5;
  const FADE_STOP_BUFFER = 0.10;
  const FADE_MIN_CONFIDENCE = 0.55;

  const tradingCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m >= 585 && m < 835;
  });

  let entered      = false;
  let direction: 'LONG' | 'SHORT' = 'LONG';
  let entryPrice   = 0;
  let stopPrice    = 0;
  let targetPrice  = 0;
  let entryCandle: Candle | null = null;
  let volumeRatio  = 0;
  let confidence   = 0;

  for (let i = 1; i < tradingCandles.length; i++) {
    if (entered) break;
    const latest = tradingCandles[i];

    // Reclaim candle must be inside the range
    if (latest.close >= range.high || latest.close <= range.low) continue;

    // Find a failed-breakout candle within lookback
    let failedAbove = false, failedBelow = false, candlesAgo = 0, overshoot = 0;
    for (let j = i - 1; j >= Math.max(0, i - FADE_LOOKBACK); j--) {
      const c = tradingCandles[j];
      if (c.close > range.high) {
        failedAbove = true;
        candlesAgo  = i - j;
        overshoot   = range.size > 0 ? (c.close - range.high) / range.size : 0;
        break;
      }
      if (c.close < range.low) {
        failedBelow = true;
        candlesAgo  = i - j;
        overshoot   = range.size > 0 ? (range.low - c.close) / range.size : 0;
        break;
      }
    }
    if (!failedAbove && !failedBelow) continue;
    if (overshoot > FADE_MAX_OVERSHOOT) continue;

    const volRatio = range.avgVolume > 0 ? latest.volume / range.avgVolume : 1.0;
    if (volRatio < FADE_VOL_FLOOR) continue;

    direction       = failedAbove ? 'SHORT' : 'LONG';
    const failedExt = failedAbove ? range.high : range.low;
    const buffer    = range.size * FADE_STOP_BUFFER;

    entryPrice  = latest.close;
    stopPrice   = failedAbove ? failedExt + buffer : failedExt - buffer;
    targetPrice = range.midpoint;

    const overshootScore = Math.max(0, 0.10 - overshoot * 0.20);
    const recencyScore   = Math.max(0, 0.05 - (candlesAgo - 1) * 0.02);
    confidence           = Math.min(0.85, 0.55 + overshootScore + recencyScore);

    if (confidence < FADE_MIN_CONFIDENCE) continue;

    entered     = true;
    volumeRatio = volRatio;
    entryCandle = latest;
  }

  if (!entered || !entryCandle) return null;

  // Manage the position. Fade target is the midpoint — simpler than partial logic.
  // Max hold: 45 minutes (matches POSITION.maxHoldMinutes in live bot).
  const entryEtMin = toEtMinutes(entryCandle.openTime);
  const managingCandles = session.filter(c => {
    const m = toEtMinutes(c.openTime);
    return m > entryEtMin && m <= entryEtMin + 45 && m <= 835;
  });

  let exitPrice: number = entryPrice;
  let exitReason: OrbBacktestTrade['exitReason'] = 'hard_close';
  let exitTime = formatEtTime(entryCandle.openTime);

  for (const c of managingCandles) {
    if (direction === 'LONG') {
      if (c.low <= stopPrice) {
        exitPrice  = stopPrice;
        exitReason = 'stop_loss';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
      if (c.high >= targetPrice) {
        exitPrice  = targetPrice;
        exitReason = 'take_profit';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
    } else {
      if (c.high >= stopPrice) {
        exitPrice  = stopPrice;
        exitReason = 'stop_loss';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
      if (c.low <= targetPrice) {
        exitPrice  = targetPrice;
        exitReason = 'take_profit';
        exitTime   = formatEtTime(c.openTime);
        break;
      }
    }
  }

  // Hard close at end of managing window — exit at last managed candle's close
  if (exitReason === 'hard_close' && managingCandles.length > 0) {
    exitPrice = managingCandles[managingCandles.length - 1].close;
    exitTime  = formatEtTime(managingCandles[managingCandles.length - 1].openTime);
  }

  const grossPnlPct = direction === 'LONG'
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;
  const pnlPct = grossPnlPct - ROUND_TRIP_COST_PCT;  // deduct realistic trading cost
  const outcome: 'WIN' | 'LOSS' = pnlPct > 0 ? 'WIN' : 'LOSS';

  return {
    date,
    symbol:       `${symbol}:fade-${direction.toLowerCase()}`,
    rangeHigh:    range.high,
    rangeLow:     range.low,
    rangeSizePct: range.sizePct,
    entryPrice:   Math.round(entryPrice  * 100) / 100,
    stopPrice:    Math.round(stopPrice   * 100) / 100,
    partialPrice: Math.round(targetPrice * 100) / 100,  // fade has no partial — use target
    targetPrice:  Math.round(targetPrice * 100) / 100,
    exitPrice:    Math.round(exitPrice   * 100) / 100,
    exitReason,
    exitTime,
    pnlPct:       Math.round(pnlPct      * 10000) / 10000,
    outcome,
    volumeRatio:  Math.round(volumeRatio * 100) / 100,
    confidence:   Math.round(confidence  * 1000) / 1000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — runOrbBacktest
// ─────────────────────────────────────────────────────────────────────────────

export async function runOrbBacktest(
  symbol:    string,
  months:    number  = 6,
  trainMode: boolean = false,
): Promise<OrbBacktestReport> {
  log.info(`[Backtest] ${symbol}: fetching ${months} months of 1m bars...`);

  let allCandles: Candle[];
  let spyAllCandles: Candle[];
  try {
    [allCandles, spyAllCandles] = await Promise.all([
      fetchHistoricalBars(symbol, monthsAgo(months)),
      symbol === 'SPY'
        ? Promise.resolve([] as Candle[])
        : fetchHistoricalBars('SPY', monthsAgo(months)),
    ]);
  } catch (err) {
    throw new Error(`[Backtest] Failed to fetch ${symbol}: ${err instanceof Error ? err.message : err}`);
  }

  if (allCandles.length < 100) {
    throw new Error(`[Backtest] Not enough bars for ${symbol}: ${allCandles.length}`);
  }

  const dayMap    = groupByDay(allCandles);
  const spyDayMap = groupByDay(spyAllCandles);
  const sortedDays = Array.from(dayMap.keys()).sort();

  log.info(`[Backtest] ${symbol}: replaying ${sortedDays.length} trading days...`);

  const trades: OrbBacktestTrade[] = [];
  let daysWithRange = 0, daysWithBreakout = 0;

  for (const date of sortedDays) {
    const dayCandles = dayMap.get(date)!;
    const spyCandles = spyDayMap.get(date) ?? [];

    const rc = dayCandles.filter(c => { const m = toEtMinutes(c.openTime); return m >= 570 && m < 585; });
    if (rc.length >= 5) {
      const pre = dayCandles.filter(c => toEtMinutes(c.openTime) < 570).slice(-10);
      try {
        const r = buildOpeningRange(symbol, rc, pre);
        if (validateRange(r).valid && !isRangeTooTight(r)) daysWithRange++;
      } catch { /* skip */ }
    }

    const longTrade        = simulateDay(symbol, date, dayCandles, spyCandles);
    const shortTrade       = simulateShortDay(symbol, date, dayCandles, spyCandles);
    const vwapRejectTrade  = simulateVwapRejectionShortDay(symbol, date, dayCandles, spyCandles);
    const fadeTrade        = simulateFadeDay(symbol, date, dayCandles, spyCandles);

    if (longTrade) {
      daysWithBreakout++;
      trades.push(longTrade);
    }
    // Only take ORB short if no long trade that day
    if (shortTrade && !longTrade) {
      daysWithBreakout++;
      trades.push(shortTrade);
    }
    // VWAP rejection short is midday — never conflicts with ORB long/short
    if (vwapRejectTrade) {
      daysWithBreakout++;
      trades.push(vwapRejectTrade);
    }
    // Fade trades — independent of other strategies (different setup conditions)
    if (fadeTrade) {
      daysWithBreakout++;
      trades.push(fadeTrade);
    }
  }

  // Break out fade trades separately for reporting
  const fadeTrades = trades.filter(t => t.symbol.includes(':fade-'));
  if (fadeTrades.length > 0) {
    const fadeMetrics = computeMetrics(fadeTrades);
    const fadeWinRate = (fadeMetrics.winRate * 100).toFixed(0);
    const fadeExp     = (fadeMetrics.expectancy * 100).toFixed(2);
    const fadePF      = fadeMetrics.profitFactor.toFixed(2);
    const longFades   = fadeTrades.filter(t => t.symbol.includes('fade-long')).length;
    const shortFades  = fadeTrades.filter(t => t.symbol.includes('fade-short')).length;
    log.info(
      `[Backtest:FADE] ${symbol}: ${fadeTrades.length} fades ` +
      `(${longFades}L / ${shortFades}S) | WR ${fadeWinRate}% | ` +
      `Expectancy ${fadeExp}% | PF ${fadePF}`
    );
  } else {
    log.info(`[Backtest:FADE] ${symbol}: no fade setups detected in window`);
  }

  const m = computeMetrics(trades);
  const passed = m.sharpe >= 0.4 && m.expectancy > 0 && trades.length >= 5;
  const failReason = !passed
    ? trades.length < 5 ? `Only ${trades.length} trades (need 5+)`
    : m.expectancy <= 0 ? `Negative expectancy ${(m.expectancy * 100).toFixed(2)}%`
    : `Sharpe ${m.sharpe.toFixed(2)} below 0.40`
    : null;

  log.info(
    `[Backtest] ${symbol}: ${trades.length} trades | WR ${(m.winRate * 100).toFixed(0)}% | ` +
    `PF ${m.profitFactor.toFixed(2)} | Sharpe ${m.sharpe.toFixed(2)} | ${passed ? 'PASSED ✓' : `FAILED — ${failReason}`}`
  );

  // ── TRAIN MODE: feed results into the brain ────────────────────────────────
  if (trainMode && trades.length >= 5) {
    log.info(`[Backtest] ${symbol}: feeding ${trades.length} trades into brain...`);
    feedBrain(symbol, trades);
    log.info(`[Backtest] ${symbol}: brain updated ✓`);
  }

  return {
    symbol,
    daysAnalyzed:     sortedDays.length,
    daysWithRange,
    daysWithBreakout,
    totalTrades:      trades.length,
    winRate:          Math.round(m.winRate       * 10000) / 10000,
    avgWinPct:        Math.round(m.avgWinPct     * 10000) / 10000,
    avgLossPct:       Math.round(m.avgLossPct    * 10000) / 10000,
    profitFactor:     Math.round(m.profitFactor  * 100)   / 100,
    expectancy:       Math.round(m.expectancy    * 10000) / 10000,
    maxDrawdownPct:   Math.round(m.maxDrawdown   * 10000) / 10000,
    sharpeRatio:      Math.round(m.sharpe        * 1000)  / 1000,
    totalReturnPct:   Math.round(m.totalReturn   * 10000) / 10000,
    avgVolRatio:      Math.round(m.avgVolRatio   * 100)   / 100,
    trades,
    passed,
    failReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FEED BRAIN — converts backtest trades into the format brain.ts expects
// and calls the same learning functions the live bot uses after each session.
// ─────────────────────────────────────────────────────────────────────────────

function feedBrain(symbol: string, trades: OrbBacktestTrade[]): void {
  const nominalSize = 100;  // nominal shares — brain uses ratios not absolutes

  // Convert backtest trades into TradeRecord shape (brain only needs a subset)
  const tradeRecords: TradeRecord[] = trades.map(t => ({
    tradeId:        `bt-${t.symbol}-${t.date}`,
    symbol:         t.symbol,
    entryPrice:     t.entryPrice,
    exitPrice:      t.exitPrice,
    sizeUsd:        t.entryPrice * nominalSize,
    coinsTraded:    nominalSize,
    realizedPnL:    t.pnlPct * t.entryPrice * nominalSize,
    realizedPnLPct: t.pnlPct,
    outcome:        t.outcome,
    pattern:        t.entryPrice > t.targetPrice ? 'ORB SHORT' : 'ORB LONG',
    exitReason:     t.exitReason,
    enteredAt:      new Date(t.date),
    exitedAt:       new Date(t.date),
    durationMs:     45 * 60 * 1000,
    decision: {
      action:     'BUY' as const,
      finalScore: t.confidence,
      threshold:  0.50,
      confidence: t.confidence,
      scores: {
        technical:      t.confidence * 0.9,
        microstructure: t.volumeRatio > 1.3 ? 0.65 : 0.45,
        sentiment:      0.50,
        whale:          0.50,
        macro:          0.50,
      },
      weights: { technical: 0.35, microstructure: 0, sentiment: 0.10, whale: 0.05, macro: 0.20 },
      pattern:   'ORB LONG',
      dataGaps:  [] as string[],
      tradeable: true,
      blockedBy: null,
      reason:    `Backtest replay ${t.date}`,
      decidedAt: new Date(t.date),
    },
  }));

  // Group trades into "sessions" by date so brain learns per-day patterns
  const byDate = new Map<string, TradeRecord[]>();
  for (const tr of tradeRecords) {
    if (!byDate.has(tr.tradeId.split('-')[2])) byDate.set(tr.tradeId.split('-')[2], []);
    byDate.get(tr.tradeId.split('-')[2])!.push(tr);
  }

  // Feed each simulated session into brain's weight learning
  // We batch all trades together for weight learning (larger sample = better signal)
  updateLearnedWeights(tradeRecords);

  // Update coin memory with backtest results
  updateCoinMemory(tradeRecords);

  // Classify a neutral regime for backtest sessions (no real macro data available)
  const regime = classifyRegime({ macroScore: 0.50, fearGreed: 50, spyTrend: 'neutral', atrPct: 0.03 });

  // Build a minimal SessionLog for regime memory update
  const totalPnL  = trades.reduce((s, t) => s + t.pnlPct, 0);
  const sessionLog: SessionLog = {
    date:               new Date().toISOString().split('T')[0],
    startingValue:      100000,
    dailyPnL:           totalPnL * 100000,
    dailyPnLPct:        totalPnL,
    dailySpentUsd:      trades.length * 100 * 100,  // nominal
    trades:             tradeRecords,
    consecutiveLosses:  0,
    circuitBreakered:   false,
    sessionStartedAt:   new Date().toISOString(),
    sessionEndedAt:     new Date().toISOString(),
    strategyVersion:    'backtest',
    maxDrawdownPct:     0,
    sharpeRatio:        null,
    sortinoRatio:       null,
  };

  updateRegimeMemory(regime, sessionLog, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN ALL SYMBOLS
// ─────────────────────────────────────────────────────────────────────────────

export interface OrbBacktestSummary {
  results:     OrbBacktestReport[];
  passed:      string[];
  failed:      string[];
  bestSymbol:  string | null;
  worstSymbol: string | null;
  runAt:       Date;
}

export async function runOrbBacktestAll(
  symbols:    string[]  = ASSETS.watchlist,
  months:     number    = 6,
  trainMode:  boolean   = false,
): Promise<OrbBacktestSummary> {
  log.info(`[Backtest] Running ${months}-month ORB backtest for ${symbols.length} symbols${trainMode ? ' (TRAIN MODE — updating brain)' : ''}...`);

  const results: OrbBacktestReport[] = [];
  const failed: string[] = [];

  for (const symbol of symbols) {
    try {
      const report = await runOrbBacktest(symbol, months, trainMode);
      results.push(report);
      await new Promise(r => setTimeout(r, 500)); // Be nice to Alpaca rate limits
    } catch (err) {
      log.warn(`[Backtest] ${symbol} failed: ${err instanceof Error ? err.message : err}`);
      failed.push(symbol);
    }
  }

  const passed     = results.filter(r => r.passed).map(r => r.symbol);
  const bestSymbol = results.length > 0
    ? results.reduce((a, b) => a.sharpeRatio > b.sharpeRatio ? a : b).symbol
    : null;
  const worstSymbol = results.length > 0
    ? results.reduce((a, b) => a.sharpeRatio < b.sharpeRatio ? a : b).symbol
    : null;

  if (trainMode) {
    const totalTrades = results.reduce((s, r) => s + r.totalTrades, 0);
    log.info(`[Backtest] Brain training complete — ${totalTrades} simulated trades fed into ARIA's memory`);
  }

  return { results, passed, failed, bestSymbol, worstSymbol, runAt: new Date() };
}
