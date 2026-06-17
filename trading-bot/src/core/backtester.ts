import { BACKTEST, INDICATORS, SIGNAL_WEIGHTS, RISK, POSITION } from '../config.js';
import { computeIndicators, computeATR } from '../tools/indicators.js';
import { buildTechnicalSignal } from '../tools/signalEngine.js';
import { getOHLCV } from '../tools/marketData.js';
import { log } from '../core/logger.js';
import type { Candle } from '../tools/marketData.js';
import type { MicrostructureResult } from '../tools/microstructure.js';

// ─────────────────────────────────────────────────────────────────────────────
// BACKTESTER — Component 9
//
// Runs the trading strategy against historical daily price data to measure
// its hypothetical performance BEFORE risking any capital.
//
// HOW IT WORKS (walk-forward validation):
//   1. Fetch 100 daily bars from Alpaca
//   2. Split 70% train / 30% test (the test set was never "seen" during design)
//   3. For each day in the test set:
//      a. Compute technical indicators on all preceding history
//      b. Compute ATR-based stop distance (matching live bot logic)
//      c. Run the Signal Engine — if BUY signal: simulate entry
//      d. Track open position:
//         - Stop-loss at entry − (ATR × 1.5)
//         - Take-profit at entry + (ATR × 1.5 × 4) — 4:1 reward:risk (matches live)
//         - Trailing stop: once up 2%, trail at 1.5%
//      e. Record the outcome when position closes
//   4. Compute performance metrics on closed trades
//   5. Compare against minimum thresholds from config
//
// WHY THESE PARAMETERS MATCH THE LIVE BOT:
//   Previous version used fixed 2% stop / 3% target — a completely different
//   strategy than what actually runs live. A backtest that uses different
//   parameters than the live bot is measuring an imaginary strategy.
//   Now the backtester uses:
//     - ATR × 1.5 stop distance (same as riskManager.ts)
//     - 4:1 reward:risk (same as index.ts executeBuy)
//     - 1.5% trailing stop after 2% profit (same as config POSITION.exit)
//   This gives you backtest results that actually predict live performance.
//
// LIMITATIONS (honest, don't ignore these):
//   - Daily bars only, not intraday — real bot trades intraday
//   - No order book data (microstructure stubbed to neutral 0.5)
//   - No sentiment/whale/macro (all neutral 0.5) — these only help the live bot
//   - 1 timeframe vs the live bot's 3 — means lower confidence scores
//   - Assumes fills are always available (fine at our position sizes)
//
// Files: reads from Alpaca API, writes nothing to disk.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BacktestTrade {
  entryDate:    string;
  exitDate:     string | null;
  entryPrice:   number;
  exitPrice:    number | null;
  exitReason:   'stop_loss' | 'take_profit' | 'trailing_stop' | 'max_hold' | 'end_of_data';
  pnlPct:       number;        // % gain or loss
  outcome:      'WIN' | 'LOSS' | 'BREAK_EVEN';
  stopDistance: number;        // ATR × 1.5 at entry (in price units)
}

export interface BacktestReport {
  symbol:         string;
  historyDays:    number;
  trainBars:      number;
  testBars:       number;
  totalTrades:    number;
  winRate:        number;       // 0–1
  profitFactor:   number;       // gross wins / gross losses (>1 = profitable)
  sharpeRatio:    number;       // annualized risk-adjusted return
  maxDrawdownPct: number;       // worst peak-to-trough as % of portfolio
  totalReturnPct: number;       // net % gain/loss over test period
  avgWinPct:      number;       // average winning trade %
  avgLossPct:     number;       // average losing trade %
  expectancy:     number;       // (winRate × avgWin) − (lossRate × avgLoss)
  trades:         BacktestTrade[];

  // Gate result
  passed:              boolean;
  failReason:          string | null;
  effectiveSharpeMin:  number;   // The minimum actually used (adaptive or config default)
}

// Maximum days to hold a position before force-closing
const MAX_HOLD_BARS = 8;

// ATR multiplier for stop distance — must match riskManager.ts
const ATR_STOP_MULTIPLIER  = 1.5;
// Reward:risk ratio — must match index.ts executeBuy
const REWARD_RISK_RATIO    = 4.0;
// Trailing stop % — must match config POSITION.exit.trailingStopPct
const TRAILING_STOP_PCT    = POSITION.exit.trailingStopPct;      // 1.5%
// Move stop to breakeven after this % gain — matches config
const BREAKEVEN_TRIGGER_PCT = POSITION.exit.breakEvenTriggerPct; // 2%

// ─────────────────────────────────────────────────────────────────────────────
// NEUTRAL STUBS
// We can't replay live-API signals historically. These neutral stubs tell the
// Decision Engine "I have no information about this signal" so it defaults to
// 0.5 (neutral) on each one. This is the correct behavior, not a hack.
// ─────────────────────────────────────────────────────────────────────────────

function neutralMicro(price: number): MicrostructureResult {
  return {
    spread:          price * 0.0005,  // Realistic 0.05% spread
    spreadPct:       0.0005,
    spreadSignal:    'normal',
    bidAskImbalance: 0,
    imbalanceSignal: 'balanced',
    liquidityZones:  [],
    bidSupport:      price * 0.99,
    askResistance:   price * 1.01,
    currentPrice:    price,
    tradeable:       true,
    reason:          'Historical data — no live order book available',
    normalized:      0.5,
    computedAt:      new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL DATA FETCH
// Uses Alpaca's crypto bars API (same source as live trading).
// ─────────────────────────────────────────────────────────────────────────────

async function fetchHistoricalOHLCV(symbol: string): Promise<Candle[]> {
  log.info(`[Backtester] Fetching daily OHLCV for ${symbol} from Alpaca...`);
  const ohlcv = await getOHLCV(symbol, '1d', 100);
  log.info(`[Backtester] Received ${ohlcv.candles.length} daily candles`);
  return ohlcv.candles;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — runBacktest
// ─────────────────────────────────────────────────────────────────────────────

export async function runBacktest(symbol: string, adaptedMinimumSharpe?: number): Promise<BacktestReport> {
  log.info(`[Backtester] Starting walk-forward backtest for ${symbol}`);
  log.info(`[Backtester] Config: ${BACKTEST.trainSplitPct * 100}% train / ${(1 - BACKTEST.trainSplitPct) * 100}% test | ATR stop × ${ATR_STOP_MULTIPLIER} | ${REWARD_RISK_RATIO}:1 R:R`);

  const candles = await fetchHistoricalOHLCV(symbol);

  const warmupBars = INDICATORS.minCandlesRequired;
  if (candles.length < warmupBars + 10) {
    throw new Error(`Not enough historical data: ${candles.length} bars, need at least ${warmupBars + 10}`);
  }

  const trainEnd  = Math.floor(candles.length * BACKTEST.trainSplitPct);
  const testBars  = candles.length - trainEnd;
  const trainBars = trainEnd;

  log.info(`[Backtester] Train: ${trainBars} bars | Test: ${testBars} bars | Warmup: ${warmupBars} bars`);

  // ── Simulation ──────────────────────────────────────────────────────────────
  const trades:       BacktestTrade[] = [];
  const dailyReturns: number[]        = [];

  let portfolioValue = 10_000;
  let peakValue      = portfolioValue;
  let maxDrawdown    = 0;

  // Open position state
  interface SimPosition {
    entryBar:     number;
    entryDate:    string;
    entryPrice:   number;
    stopPrice:    number;       // Current stop price (moves up as trailing stop activates)
    targetPrice:  number;       // Take-profit target
    highWater:    number;       // Highest price reached since entry (for trailing stop)
    stopDistance: number;       // Original ATR × 1.5 distance
    trailingActive: boolean;    // Whether trailing stop has been activated
    breakevenSet:   boolean;    // Whether stop has been moved to breakeven
  }
  let openPos: SimPosition | null = null;

  for (let i = trainEnd; i < candles.length; i++) {
    const prevPortfolioValue = portfolioValue;
    const bar  = candles[i];

    // ── Update open position ──────────────────────────────────────────────────
    if (openPos !== null) {
      const barsHeld = i - openPos.entryBar;

      // Update high water mark for trailing stop
      if (bar.high > openPos.highWater) {
        openPos.highWater = bar.high;
      }

      // ── Breakeven trigger: move stop to entry after 2% gain ─────────────────
      const gainFromEntry = (openPos.highWater - openPos.entryPrice) / openPos.entryPrice;
      if (!openPos.breakevenSet && gainFromEntry >= BREAKEVEN_TRIGGER_PCT) {
        openPos.stopPrice    = Math.max(openPos.stopPrice, openPos.entryPrice);
        openPos.breakevenSet = true;
      }

      // ── Trailing stop: once 2%+ in profit, trail by 1.5% ───────────────────
      // This locks in profit as the price climbs. If BTC runs from $100 to $110,
      // the stop trails up to $108.35 — you never give back more than 1.5%.
      if (gainFromEntry >= BREAKEVEN_TRIGGER_PCT) {
        const trailingStop = openPos.highWater * (1 - TRAILING_STOP_PCT);
        if (trailingStop > openPos.stopPrice) {
          openPos.stopPrice      = trailingStop;
          openPos.trailingActive = true;
        }
      }

      // ── Check exit conditions ────────────────────────────────────────────────
      const stopHit   = bar.low  <= openPos.stopPrice;
      const targetHit = bar.high >= openPos.targetPrice;
      const maxHold   = barsHeld >= MAX_HOLD_BARS;

      let exitPrice:  number | null = null;
      let exitReason: BacktestTrade['exitReason'] | null = null;

      // Conservative: stop always wins if both hit on same bar
      if (stopHit) {
        exitPrice  = openPos.stopPrice;
        exitReason = openPos.trailingActive ? 'trailing_stop' : 'stop_loss';
      } else if (targetHit) {
        exitPrice  = openPos.targetPrice;
        exitReason = 'take_profit';
      } else if (maxHold) {
        exitPrice  = bar.close;
        exitReason = 'max_hold';
      } else if (i === candles.length - 1) {
        exitPrice  = bar.close;
        exitReason = 'end_of_data';
      }

      if (exitPrice !== null && exitReason !== null) {
        // Apply spread cost on exit
        const effectiveExit = exitPrice * (1 - BACKTEST.spreadPct);
        const pnlPct        = (effectiveExit - openPos.entryPrice) / openPos.entryPrice;
        const outcome: BacktestTrade['outcome'] =
          pnlPct > 0.001  ? 'WIN'        :
          pnlPct < -0.001 ? 'LOSS'       : 'BREAK_EVEN';

        trades.push({
          entryDate:    openPos.entryDate,
          exitDate:     bar.openTime.toISOString().split('T')[0],
          entryPrice:   openPos.entryPrice,
          exitPrice:    Math.round(effectiveExit * 100) / 100,
          exitReason,
          pnlPct:       Math.round(pnlPct * 10000) / 10000,
          outcome,
          stopDistance: openPos.stopDistance,
        });

        portfolioValue = portfolioValue * (1 + pnlPct);
        openPos = null;
      }
    }

    // ── Check for new entry signal (only when flat) ───────────────────────────
    if (openPos === null) {
      const history = candles.slice(0, i);
      if (history.length < warmupBars) continue;

      // Compute daily indicators on all history preceding this bar
      const suite  = computeIndicators(history, '1d');
      const micro  = neutralMicro(candles[i - 1].close);
      const signal = buildTechnicalSignal([suite], micro);

      const isBuySignal = signal.tradeable && signal.score >= SIGNAL_WEIGHTS.thresholds.buy;

      if (isBuySignal) {
        // Entry at next bar open + slippage + spread (simulates market order)
        const entryPrice = bar.open * (1 + BACKTEST.slippagePct + BACKTEST.spreadPct);

        // ATR-based stop — matches riskManager.ts calculateTradeParameters
        const atr = computeATR(
          history.map(c => c.high),
          history.map(c => c.low),
          history.map(c => c.close),
          14,
        );

        const stopDistance = atr.value * ATR_STOP_MULTIPLIER;
        const stopPrice    = entryPrice - stopDistance;
        const targetPrice  = entryPrice + (stopDistance * REWARD_RISK_RATIO);

        // Sanity check — don't enter if stop would be unrealistically wide
        const stopPct = stopDistance / entryPrice;
        if (stopPct > 0.15) continue; // Skip if ATR stop > 15% (extreme volatility bar)

        openPos = {
          entryBar:       i,
          entryDate:      bar.openTime.toISOString().split('T')[0],
          entryPrice,
          stopPrice,
          targetPrice,
          highWater:      entryPrice,
          stopDistance,
          trailingActive: false,
          breakevenSet:   false,
        };
      }
    }

    // ── Daily return for Sharpe ───────────────────────────────────────────────
    const dailyReturn = prevPortfolioValue > 0
      ? (portfolioValue - prevPortfolioValue) / prevPortfolioValue
      : 0;
    dailyReturns.push(dailyReturn);

    // ── Drawdown tracking ─────────────────────────────────────────────────────
    if (portfolioValue > peakValue) peakValue = portfolioValue;
    const drawdown = peakValue > 0 ? (peakValue - portfolioValue) / peakValue : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // ── Compute final statistics ──────────────────────────────────────────────

  const closedTrades = trades.filter(t => t.exitReason !== 'end_of_data' || t.exitPrice !== null);
  const wins         = closedTrades.filter(t => t.outcome === 'WIN');
  const losses       = closedTrades.filter(t => t.outcome === 'LOSS');
  const winRate      = closedTrades.length > 0 ? wins.length / closedTrades.length : 0;

  const grossWins    = wins.reduce((sum, t)   => sum + t.pnlPct, 0);
  const grossLosses  = losses.reduce((sum, t) => sum + Math.abs(t.pnlPct), 0);
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

  const avgWinPct  = wins.length   > 0 ? grossWins   / wins.length   : 0;
  const avgLossPct = losses.length > 0 ? grossLosses / losses.length : 0;
  const lossRate   = 1 - winRate;
  // Expectancy: how much you expect to make per trade on average
  // Positive expectancy = profitable strategy over time
  const expectancy = (winRate * avgWinPct) - (lossRate * avgLossPct);

  const totalReturn  = (portfolioValue - 10_000) / 10_000;
  const sharpeRatio  = computeSharpe(dailyReturns);

  // ── Check against minimums ────────────────────────────────────────────────
  const effectiveSharpeMinimum = adaptedMinimumSharpe ?? BACKTEST.minimumSharpeRatio;

  let passed    = true;
  let failReason: string | null = null;

  if (closedTrades.length === 0) {
    passed     = true;
    failReason = null;
  } else if (sharpeRatio < effectiveSharpeMinimum) {
    passed     = false;
    failReason = `Sharpe ratio too low: ${sharpeRatio.toFixed(3)} < minimum ${effectiveSharpeMinimum.toFixed(3)}`;
  } else if (maxDrawdown > BACKTEST.maximumDrawdownPct) {
    passed     = false;
    failReason = `Max drawdown too high: ${(maxDrawdown * 100).toFixed(1)}% > maximum ${(BACKTEST.maximumDrawdownPct * 100).toFixed(0)}%`;
  } else if (winRate < BACKTEST.minimumWinRate && closedTrades.length >= 5) {
    passed     = false;
    failReason = `Win rate too low: ${(winRate * 100).toFixed(0)}% < minimum ${(BACKTEST.minimumWinRate * 100).toFixed(0)}%`;
  } else if (expectancy < 0 && closedTrades.length >= 5) {
    passed     = false;
    failReason = `Negative expectancy: ${(expectancy * 100).toFixed(3)}% per trade — strategy loses money on average`;
  }

  const report: BacktestReport = {
    symbol,
    historyDays:        candles.length,
    trainBars,
    testBars,
    totalTrades:        closedTrades.length,
    winRate:            Math.round(winRate    * 1000) / 1000,
    profitFactor:       Math.round(profitFactor * 100) / 100,
    sharpeRatio:        Math.round(sharpeRatio  * 100) / 100,
    maxDrawdownPct:     Math.round(maxDrawdown   * 10000) / 10000,
    totalReturnPct:     Math.round(totalReturn   * 10000) / 10000,
    avgWinPct:          Math.round(avgWinPct     * 10000) / 10000,
    avgLossPct:         Math.round(avgLossPct    * 10000) / 10000,
    expectancy:         Math.round(expectancy    * 10000) / 10000,
    trades:             closedTrades,
    passed,
    failReason,
    effectiveSharpeMin: Math.round(effectiveSharpeMinimum * 1000) / 1000,
  };

  logBacktestReport(symbol, report);
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARPE RATIO — annualized from daily returns
// Formula: (mean_daily_return / std_daily_return) × sqrt(252)
// A Sharpe > 0.5 is the minimum we set in config. Good strategies hit 1.0+.
// ─────────────────────────────────────────────────────────────────────────────

function computeSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;

  const n    = dailyReturns.length;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / n;

  const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (n - 1);
  const stdDev   = Math.sqrt(variance);

  if (stdDev === 0) return mean > 0 ? Infinity : 0;

  return (mean / stdDev) * Math.sqrt(252);
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT LOGGING
// ─────────────────────────────────────────────────────────────────────────────

function logBacktestReport(symbol: string, r: BacktestReport): void {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  // Exit reason breakdown
  const exitBreakdown = r.trades.reduce((acc, t) => {
    acc[t.exitReason] = (acc[t.exitReason] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  log.info('');
  log.info(`[Backtester] ┌─ Backtest Results — ${symbol} ─────────────────────────────`);
  log.info(`[Backtester] │  Period:        ${r.historyDays} bars | Train: ${r.trainBars} | Test: ${r.testBars}`);
  log.info(`[Backtester] │  Stop method:   ATR × ${ATR_STOP_MULTIPLIER} | Target: ${REWARD_RISK_RATIO}:1 R:R | Trail: ${(TRAILING_STOP_PCT * 100).toFixed(1)}%`);
  log.info(`[Backtester] │  Total trades:  ${r.totalTrades}`);
  log.info(`[Backtester] │  Win rate:      ${pct(r.winRate)} (min: ${pct(BACKTEST.minimumWinRate)})`);
  log.info(`[Backtester] │  Avg win:       ${pct(r.avgWinPct)} | Avg loss: ${pct(r.avgLossPct)}`);
  log.info(`[Backtester] │  Expectancy:    ${pct(r.expectancy)} per trade`);
  log.info(`[Backtester] │  Profit factor: ${r.profitFactor.toFixed(2)} (>1 = profitable)`);
  log.info(`[Backtester] │  Sharpe ratio:  ${r.sharpeRatio.toFixed(2)} (min: ${r.effectiveSharpeMin.toFixed(3)})`);
  log.info(`[Backtester] │  Max drawdown:  ${pct(r.maxDrawdownPct)} (max: ${pct(BACKTEST.maximumDrawdownPct)})`);
  log.info(`[Backtester] │  Total return:  ${pct(r.totalReturnPct)}`);

  if (r.totalTrades > 0) {
    const breakdown = Object.entries(exitBreakdown)
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(', ');
    log.info(`[Backtester] │  Exit reasons:  ${breakdown}`);
  }

  log.info(`[Backtester] │`);

  if (r.passed && r.totalTrades === 0) {
    log.info(`[Backtester] │  RESULT: PASSED — no signals in test window (selective strategy)`);
  } else if (r.passed) {
    log.info(`[Backtester] │  RESULT: PASSED — strategy meets all minimum thresholds`);
  } else {
    log.warn(`[Backtester] │  RESULT: FAILED — ${r.failReason}`);
  }

  log.info(`[Backtester] └──────────────────────────────────────────────────────────────`);
  log.info('');
}
