import { log } from '../core/logger.js';
import { getEquityBars } from './marketData.js';
import {
  buildOpeningRange, detectVwapReclaim, detectVwapBounce,
  detectMeanReversion, detectMomentumContinuation,
} from '../strategy/openingRange.js';
import { ASSETS, RISK, QUANT } from '../config.js';
import { computeRVOL } from './indicators.js';
import type { Candle } from './marketData.js';

// ─────────────────────────────────────────────────────────────────────────────
// PAPER REPLAY — Back-test all 4 strategies on real historical data
//
// Usage:  npx tsx src/tools/paperReplay.ts [days]
// Example: npx tsx src/tools/paperReplay.ts 10
//
// Fetches the last N days of 1m and 5m bars for each watchlist symbol,
// simulates the full strategy pipeline (same gates as live), records
// hypothetical entries/exits, and prints a summary report.
// ─────────────────────────────────────────────────────────────────────────────

interface ReplayTrade {
  date:       string;
  symbol:     string;
  strategy:   string;
  entryPrice: number;
  stopPrice:  number;
  targetPrice: number;
  exitPrice:  number;
  pnl:        number;
  outcome:    'WIN' | 'LOSS' | 'TIMEOUT';
  barsHeld:   number;
}

async function replayDay(symbol: string, date: string): Promise<ReplayTrade[]> {
  const trades: ReplayTrade[] = [];

  try {
    // Fetch 1m bars for the full session — Alpaca free tier gives us 15 months
    const bars1m = await getEquityBars(symbol, '1m', 400);
    const bars5m = await getEquityBars(symbol, '5m', 80);

    if (bars1m.length < 50 || bars5m.length < 20) return trades;

    // Simulate 9:30–9:44 opening range
    const sessionBars = bars1m.slice(0, 15); // first 15 1m candles
    if (sessionBars.length < 10) return trades;

    const range = buildOpeningRange(symbol, sessionBars, bars1m.slice(15, 25));

    // Simulate 9:45 onward — walk forward bar by bar
    for (let i = 15; i < Math.min(bars1m.length - 5, 50); i++) {
      const recentCandles = bars1m.slice(Math.max(0, i - 15), i + 1);
      const spyBars       = bars1m.slice(Math.max(0, i - 10), i + 1); // proxy SPY with same bars for replay

      // Skip if less than 15 5m candles available (same gate as live)
      if (bars5m.length < 15) continue;

      const rvol = computeRVOL(recentCandles, bars1m.slice(0, i));
      const rvolTooLow = rvol < QUANT.minRvolToEnter;

      let signal: { valid: boolean; entryPrice: number; stopPrice: number; targetPrice: number; strategy: string } | null = null;

      // Try strategies in priority order
      const reclaim = detectVwapReclaim(range, recentCandles, spyBars);
      if (reclaim.valid && !rvolTooLow) {
        signal = { ...reclaim, strategy: 'VWAP Reclaim' };
      }

      if (!signal) {
        const bounce = (!rvolTooLow) ? detectVwapBounce(range, recentCandles, spyBars) : { valid: false as const };
        if (bounce.valid) signal = { ...bounce, strategy: 'VWAP Bounce' };
      }

      if (!signal) {
        const mr = detectMeanReversion(recentCandles);
        if (mr.valid) signal = { ...mr, strategy: 'Mean Reversion' };
      }

      if (!signal) {
        const mom = detectMomentumContinuation(recentCandles, bars5m.slice(0, Math.min(bars5m.length, 30)));
        if (mom.valid && !rvolTooLow) signal = { ...mom, strategy: 'Momentum' };
      }

      if (!signal) continue;

      // Simulate forward — check if stop or target hit in next 30 bars
      const entry  = signal.entryPrice;
      const stop   = signal.stopPrice;
      const target = signal.targetPrice;
      let exitPrice = entry;
      let outcome: 'WIN' | 'LOSS' | 'TIMEOUT' = 'TIMEOUT';
      let barsHeld = 0;

      for (let j = i + 1; j < Math.min(i + 31, bars1m.length); j++) {
        barsHeld++;
        const bar = bars1m[j];
        if (bar.low <= stop) {
          exitPrice = stop;
          outcome   = 'LOSS';
          break;
        }
        if (bar.high >= target) {
          exitPrice = target;
          outcome   = 'WIN';
          break;
        }
        // Timeout — exit at close of bar 30
        if (j === Math.min(i + 30, bars1m.length - 1)) {
          exitPrice = bar.close;
          outcome   = 'TIMEOUT';
        }
      }

      const pnl = exitPrice - entry;
      trades.push({ date, symbol, strategy: signal.strategy, entryPrice: entry, stopPrice: stop, targetPrice: target, exitPrice, pnl, outcome, barsHeld });

      // Only one trade per symbol per day
      break;
    }
  } catch (err) {
    log.warn(`[Replay] ${symbol} ${date}: ${err instanceof Error ? err.message : err}`);
  }

  return trades;
}

async function main() {
  const daysArg = parseInt(process.argv[2] ?? '5', 10);
  const symbols = ASSETS.watchlist;

  log.info(`[Replay] Starting paper replay — last ${daysArg} trading days, ${symbols.length} symbols`);

  const allTrades: ReplayTrade[] = [];

  // Generate list of recent trading dates (skip weekends)
  const dates: string[] = [];
  const cursor = new Date();
  while (dates.length < daysArg) {
    cursor.setDate(cursor.getDate() - 1);
    if (cursor.getDay() === 0 || cursor.getDay() === 6) continue;
    dates.push(cursor.toISOString().split('T')[0]);
  }

  for (const date of dates) {
    for (const symbol of symbols) {
      const trades = await replayDay(symbol, date);
      allTrades.push(...trades);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const wins    = allTrades.filter(t => t.outcome === 'WIN').length;
  const losses  = allTrades.filter(t => t.outcome === 'LOSS').length;
  const timeouts = allTrades.filter(t => t.outcome === 'TIMEOUT').length;
  const total   = allTrades.length;
  const netPnl  = allTrades.reduce((s, t) => s + t.pnl, 0);
  const winRate = total > 0 ? (wins / total * 100).toFixed(1) : '0';

  // By strategy
  const byStrategy: Record<string, { wins: number; total: number; pnl: number }> = {};
  for (const t of allTrades) {
    if (!byStrategy[t.strategy]) byStrategy[t.strategy] = { wins: 0, total: 0, pnl: 0 };
    byStrategy[t.strategy].total++;
    byStrategy[t.strategy].pnl += t.pnl;
    if (t.outcome === 'WIN') byStrategy[t.strategy].wins++;
  }

  console.log('\n════════════════════════════════════════');
  console.log(`  PAPER REPLAY — Last ${daysArg} days`);
  console.log('════════════════════════════════════════');
  console.log(`  Trades:   ${total}  (${wins}W / ${losses}L / ${timeouts} timeout)`);
  console.log(`  Win Rate: ${winRate}%`);
  console.log(`  Net P&L:  ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} per-share`);
  console.log('\n  By Strategy:');
  for (const [strat, stats] of Object.entries(byStrategy)) {
    const wr = stats.total > 0 ? (stats.wins / stats.total * 100).toFixed(0) : '0';
    console.log(`    ${strat.padEnd(18)} ${stats.total} trades | ${wr}% WR | ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}`);
  }
  console.log('════════════════════════════════════════\n');

  log.info('[Replay] Done');
}

main().catch(err => { console.error(err); process.exit(1); });
