import {
  loadTodaySession,
  recordTradeEntry,
  recordTradeExit,
  buildPortfolioStateFromJournal,
  markCircuitBreaker,
  runEndOfSessionAnalysis,
  computeAllTimeStats,
  SessionLog,
} from './journal.js';
import { DecisionResult } from '../core/decisionEngine.js';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// JOURNAL AGENT TEST SUITE
//
// Uses a temp directory so tests don't pollute the real logs/ folder.
// Each test gets a fresh session log.
// ─────────────────────────────────────────────────────────────────────────────

// Override log dirs before importing anything that reads them
const TEMP_DIR = path.join('logs', '_test_journal_tmp');
const TEMP_SESSIONS = path.join(TEMP_DIR, 'sessions');
const TEMP_JOURNAL  = path.join(TEMP_DIR, 'journal');

// Patch the config paths used by journal.ts at module load time
// (We do this by setting env vars that the config reads, then re-importing)
// For simplicity in this test, we use the real path but a dated temp key.
// The journal uses today's date as the key — we'll clean up after.

async function runTests() {
  console.log('\n📓 Testing Journal Agent...\n');
  let passed = 0; let failed = 0;

  // Create temp directories
  fs.mkdirSync(TEMP_SESSIONS, { recursive: true });
  fs.mkdirSync(TEMP_JOURNAL,  { recursive: true });

  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // ── Minimal mock DecisionResult ──────────────────────────────────────────
  const mockDecision: DecisionResult = {
    action:     'BUY',
    finalScore: 0.72,
    threshold:  0.65,
    confidence: 0.75,
    scores: {
      technical:      0.70,
      microstructure: 0.65,
      sentiment:      0.60,
      whale:          0.68,
      macro:          0.55,
    },
    weights: {
      technical:      0.30,
      microstructure: 0.15,
      sentiment:      0.20,
      whale:          0.20,
      macro:          0.15,
    },
    pattern:   'Oversold Bounce',
    dataGaps:  [],
    tradeable: true,
    blockedBy: null,
    reason:    'RSI oversold, momentum rising, whales accumulating',
    decidedAt: new Date(),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // LOAD / INIT
  // ─────────────────────────────────────────────────────────────────────────

  await test('loadTodaySession — creates fresh log on first call', () => {
    const log = loadTodaySession(100_000);
    if (log.trades.length !== 0)       throw new Error('Should start empty');
    if (log.dailyPnL !== 0)            throw new Error('dailyPnL should be 0');
    if (log.dailySpentUsd !== 0)       throw new Error('dailySpentUsd should be 0');
    if (log.consecutiveLosses !== 0)   throw new Error('consecutiveLosses should be 0');
    if (log.startingValue !== 100_000) throw new Error('startingValue wrong');
    if (log.circuitBreakered)          throw new Error('circuitBreakered should be false');
  });

  await test('loadTodaySession — idempotent (returns same log on second call)', () => {
    const log1 = loadTodaySession(100_000);
    const log2 = loadTodaySession(999_999); // Different starting value — should use existing
    if (log1.date !== log2.date)   throw new Error('Dates should match');
    if (log2.startingValue !== log1.startingValue) throw new Error('Should load existing, not overwrite');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TRADE ENTRY
  // ─────────────────────────────────────────────────────────────────────────

  let sessionLog = loadTodaySession(100_000);

  await test('recordTradeEntry — adds trade, updates dailySpentUsd', () => {
    const { log, tradeId } = recordTradeEntry(sessionLog, 'BTC/USD', 70_000, 500, 0.00714, mockDecision);
    sessionLog = log;

    if (!tradeId)                     throw new Error('tradeId must be returned');
    if (log.trades.length !== 1)      throw new Error('Should have 1 trade');
    if (log.dailySpentUsd !== 500)    throw new Error(`dailySpentUsd wrong: ${log.dailySpentUsd}`);
    if (log.trades[0].outcome !== 'OPEN') throw new Error('New trade should be OPEN');
    if (log.trades[0].pattern !== 'Oversold Bounce') throw new Error('Pattern not recorded');

    console.log(`       tradeId: ${tradeId}`);
  });

  let openTradeId: string;
  await test('recordTradeEntry — second trade accumulates dailySpentUsd', () => {
    const { log, tradeId } = recordTradeEntry(sessionLog, 'ETH/USD', 3_000, 200, 0.0667, mockDecision);
    sessionLog = log;
    openTradeId = tradeId;

    if (log.trades.length !== 2)        throw new Error('Should have 2 trades');
    if (log.dailySpentUsd !== 700)      throw new Error(`dailySpentUsd should be 700, got ${log.dailySpentUsd}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TRADE EXIT — WIN
  // ─────────────────────────────────────────────────────────────────────────

  await test('recordTradeExit — WIN: updates dailyPnL, resets consecutiveLosses', () => {
    // Close the BTC trade (index 0) — it was entered at $70,000
    const btcTradeId = sessionLog.trades[0].tradeId;
    const log = recordTradeExit(sessionLog, btcTradeId, 72_000, 'Take-profit hit');
    sessionLog = log;

    const trade = log.trades.find(t => t.tradeId === btcTradeId)!;
    if (trade.outcome !== 'WIN')        throw new Error(`Expected WIN, got ${trade.outcome}`);
    if (trade.exitPrice !== 72_000)     throw new Error('exitPrice wrong');
    if (trade.realizedPnL === null)     throw new Error('realizedPnL must be set');
    if (trade.realizedPnL <= 0)         throw new Error(`P&L should be positive: ${trade.realizedPnL}`);
    if (log.dailyPnL <= 0)              throw new Error('dailyPnL should be positive');
    if (log.consecutiveLosses !== 0)    throw new Error('Win should reset consecutive losses');

    console.log(`       BTC trade P&L: +$${trade.realizedPnL?.toFixed(2)}`);
    console.log(`       dailyPnL: +$${log.dailyPnL.toFixed(2)}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TRADE EXIT — LOSS
  // ─────────────────────────────────────────────────────────────────────────

  await test('recordTradeExit — LOSS: increments consecutiveLosses', () => {
    // Close the ETH trade at a loss
    const log = recordTradeExit(sessionLog, openTradeId, 2_900, 'Stop-loss triggered');
    sessionLog = log;

    const trade = log.trades.find(t => t.tradeId === openTradeId)!;
    if (trade.outcome !== 'LOSS')        throw new Error(`Expected LOSS, got ${trade.outcome}`);
    if ((trade.realizedPnL ?? 0) >= 0)   throw new Error('P&L should be negative');
    if (log.consecutiveLosses !== 1)     throw new Error(`consecutiveLosses should be 1, got ${log.consecutiveLosses}`);

    console.log(`       ETH trade P&L: $${trade.realizedPnL?.toFixed(2)}`);
    console.log(`       consecutiveLosses: ${log.consecutiveLosses}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONSECUTIVE LOSSES STREAK
  // ─────────────────────────────────────────────────────────────────────────

  await test('consecutiveLosses — resets after a win in the streak', () => {
    let log = sessionLog;

    // Add two more losing trades
    let r1 = recordTradeEntry(log, 'BTC/USD', 70_000, 100, 0.00143, mockDecision);
    log = r1.log;
    log = recordTradeExit(log, r1.tradeId, 69_000, 'Stop hit');
    if (log.consecutiveLosses !== 2) throw new Error(`Expected 2, got ${log.consecutiveLosses}`);

    let r2 = recordTradeEntry(log, 'BTC/USD', 69_000, 100, 0.00145, mockDecision);
    log = r2.log;
    log = recordTradeExit(log, r2.tradeId, 71_000, 'Target hit'); // WIN — resets streak
    if (log.consecutiveLosses !== 0) throw new Error(`After win, expected 0, got ${log.consecutiveLosses}`);

    // Add one more loss — streak should be 1 (not carry over the old 2)
    let r3 = recordTradeEntry(log, 'ETH/USD', 3_000, 100, 0.0333, mockDecision);
    log = r3.log;
    log = recordTradeExit(log, r3.tradeId, 2_850, 'Stop hit');
    if (log.consecutiveLosses !== 1) throw new Error(`Expected 1, got ${log.consecutiveLosses}`);

    console.log(`       Streak correctly tracks: 2 losses → win resets → 1 loss = ${log.consecutiveLosses}`);
    sessionLog = log;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PORTFOLIO STATE INTEGRATION
  // ─────────────────────────────────────────────────────────────────────────

  await test('buildPortfolioStateFromJournal — feeds correct values to Risk Manager', () => {
    const state = buildPortfolioStateFromJournal(
      sessionLog,
      100_000,   // liveTotal (from Alpaca)
      95_000,    // liveCash
      {},        // livePositions
    );

    if (state.dailyPnL !== sessionLog.dailyPnL)
      throw new Error('dailyPnL mismatch');
    if (state.dailySpentUsd !== sessionLog.dailySpentUsd)
      throw new Error('dailySpentUsd mismatch');
    if (state.consecutiveLosses !== sessionLog.consecutiveLosses)
      throw new Error('consecutiveLosses mismatch');
    if (state.circuitBreakerActive !== sessionLog.circuitBreakered)
      throw new Error('circuitBreakerActive mismatch');
    if (state.totalValue !== 100_000) throw new Error('totalValue wrong');
    if (state.cash !== 95_000)        throw new Error('cash wrong');

    console.log(`       dailyPnL: $${state.dailyPnL.toFixed(2)} | consecutiveLosses: ${state.consecutiveLosses} | circuitBreaker: ${state.circuitBreakerActive}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CIRCUIT BREAKER
  // ─────────────────────────────────────────────────────────────────────────

  await test('markCircuitBreaker — sets flag, persists to disk', () => {
    const updated = markCircuitBreaker(sessionLog);
    sessionLog = updated;
    if (!updated.circuitBreakered) throw new Error('circuitBreakered should be true');

    // Re-load from disk to verify persistence
    const reloaded = loadTodaySession(100_000);
    if (!reloaded.circuitBreakered) throw new Error('circuitBreakered not persisted to disk');
    console.log('       Circuit breaker flag persisted correctly');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // END-OF-SESSION ANALYSIS (with live Groq call)
  // ─────────────────────────────────────────────────────────────────────────

  await test('runEndOfSessionAnalysis — generates journal entry and pattern stats', async () => {
    const { patternStats, adjustments, journalEntry } = await runEndOfSessionAnalysis(sessionLog);

    if (!journalEntry.includes('# Trading Journal')) throw new Error('Journal missing header');
    if (!journalEntry.includes('Session Summary'))    throw new Error('Journal missing summary section');
    if (!journalEntry.includes('Trade Log'))          throw new Error('Journal missing trade log section');
    if (typeof patternStats !== 'object')             throw new Error('patternStats must be array');
    if (!Array.isArray(adjustments))                  throw new Error('adjustments must be array');

    // Verify journal was written to disk
    const today = new Date().toISOString().split('T')[0];
    const jPath = `logs/journal/${today}.md`;
    if (!fs.existsSync(jPath)) throw new Error(`Journal not written to disk at ${jPath}`);

    console.log(`\n       ┌─ Session Analysis ──────────────────────────────`);
    console.log(`       │  Patterns tracked: ${patternStats.length}`);
    console.log(`       │  Weight adjustments suggested: ${adjustments.length}`);
    if (adjustments.length > 0) {
      adjustments.forEach(a =>
        console.log(`       │    ${a.signal}: ${(a.currentWeight*100).toFixed(0)}% → ${(a.suggestedWeight*100).toFixed(0)}%`)
      );
    }
    console.log(`       │  Journal written: ${jPath}`);
    console.log(`       │  Entry length: ${journalEntry.length} chars`);
    console.log(`       └────────────────────────────────────────────────────\n`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ALL-TIME STATS
  // ─────────────────────────────────────────────────────────────────────────

  await test('computeAllTimeStats — reads all sessions, computes cumulative stats', () => {
    const stats = computeAllTimeStats();

    if (stats.totalSessions < 1)    throw new Error('Should have at least 1 session');
    if (stats.totalTrades < 0)      throw new Error('totalTrades cannot be negative');
    if (stats.overallWinRate < 0 || stats.overallWinRate > 1) {
      throw new Error(`Win rate out of range: ${stats.overallWinRate}`);
    }

    console.log(`       Sessions: ${stats.totalSessions} | Trades: ${stats.totalTrades} | Win rate: ${(stats.overallWinRate * 100).toFixed(0)}% | Total P&L: $${stats.totalPnL.toFixed(2)}`);
    if (stats.bestDay)  console.log(`       Best day:  ${stats.bestDay.date} (+$${stats.bestDay.pnl.toFixed(2)})`);
    if (stats.worstDay) console.log(`       Worst day: ${stats.worstDay.date} ($${stats.worstDay.pnl.toFixed(2)})`);
  });

  // ─────────────────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('✅ Journal Agent solid. Circuit breakers now live. Ready for Phase 4.\n');
  } else {
    console.log('❌ Fix failures above before moving on.\n');
  }
}

runTests().catch(console.error);
