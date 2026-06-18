import { runOrbBacktest, runOrbBacktestAll } from '../core/orbBacktester.js';
import { ASSETS } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// BACKTEST RUNNER
//
// Usage:
//   npm run backtest                        → full watchlist, 6 months
//   npm run backtest -- QQQ                 → single symbol, 6 months
//   npm run backtest -- QQQ SPY             → multiple symbols
//   npm run backtest -- --train             → run + feed results into ARIA brain
//   npm run backtest -- --months 3          → limit to 3 months of data
//   npm run backtest -- --train --months 12 → 12 months + train brain
//
// Results printed to terminal. Uses real Alpaca 1-minute bars.
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

const trainMode = args.includes('--train');

const monthsIdx = args.indexOf('--months');
const months = monthsIdx !== -1 && args[monthsIdx + 1]
  ? parseInt(args[monthsIdx + 1], 10)
  : 6;

// Symbol args are uppercase tickers passed directly (e.g. QQQ SPY NVDA)
const requested = args
  .filter(a => /^[A-Z]{1,5}$/.test(a))
  .map(s => s.toUpperCase());

const symbols = requested.length > 0 ? requested : ASSETS.watchlist;

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  ORB Backtester — Using Real Alpaca 1-Minute Bars');
console.log(`  Symbols: ${symbols.join(', ')}`);
console.log(`  Months:  ${months}  |  Train mode: ${trainMode ? 'ON (feeding ARIA brain)' : 'OFF'}`);
console.log('═══════════════════════════════════════════════════════════');
console.log('');

if (symbols.length === 1) {
  const result = await runOrbBacktest(symbols[0], months, trainMode);

  console.log(`\n── ${symbols[0]} ─────────────────────────────────────────────`);
  console.log(`  Trades:          ${result.totalTrades}`);
  console.log(`  Win Rate:        ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`  Profit Factor:   ${result.profitFactor.toFixed(2)}`);
  console.log(`  Expectancy:      ${result.expectancy >= 0 ? '+' : ''}${(result.expectancy * 100).toFixed(3)}% per trade`);
  console.log(`  Sharpe:          ${result.sharpeRatio.toFixed(2)}`);
  console.log(`  Max Drawdown:    -${(result.maxDrawdownPct * 100).toFixed(2)}%`);
  console.log(`  Avg Win:         +${(result.avgWinPct * 100).toFixed(2)}%`);
  console.log(`  Avg Loss:        ${(result.avgLossPct * 100).toFixed(2)}%`);
  console.log(`  Days analyzed:   ${result.daysAnalyzed}`);
  console.log(`  Days traded:     ${result.daysWithBreakout}`);
  console.log('');
} else {
  const summary = await runOrbBacktestAll(symbols, months, trainMode);
  const results = summary.results;

  console.log('');
  const header = 'Symbol   Trades  Win%   PF    Expect/trade  Sharpe  MaxDD';
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const r of results) {
    const line = [
      r.symbol.padEnd(8),
      String(r.totalTrades).padEnd(7),
      `${(r.winRate * 100).toFixed(0)}%`.padEnd(7),
      r.profitFactor.toFixed(2).padEnd(6),
      `${r.expectancy >= 0 ? '+' : ''}${(r.expectancy * 100).toFixed(3)}%`.padEnd(14),
      r.sharpeRatio.toFixed(2).padEnd(8),
      `-${(r.maxDrawdownPct * 100).toFixed(2)}%`,
    ].join('');
    console.log(line);
  }

  console.log('');

  // Summary stats across all symbols
  const withTrades = results.filter(r => r.totalTrades > 0);
  if (withTrades.length > 0) {
    const avgWinRate = withTrades.reduce((s, r) => s + r.winRate, 0) / withTrades.length;
    const avgPF      = withTrades.reduce((s, r) => s + r.profitFactor, 0) / withTrades.length;
    const totalTrades = withTrades.reduce((s, r) => s + r.totalTrades, 0);
    console.log(`Portfolio avg — Win rate: ${(avgWinRate * 100).toFixed(1)}%  PF: ${avgPF.toFixed(2)}  Total trades: ${totalTrades}`);
    console.log(`Best: ${summary.bestSymbol ?? 'n/a'}  |  Failed: ${summary.failed.join(', ') || 'none'}`);
    console.log('');
  }
}
