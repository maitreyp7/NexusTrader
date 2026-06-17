import * as fs from 'fs';
import * as path from 'path';
import { LOGGING, STRATEGY, SIGNAL_WEIGHTS } from '../config.js';
import { DecisionResult } from '../core/decisionEngine.js';
import { PortfolioState } from '../core/riskManager.js';
import { askGroqSafe } from './groqClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// JOURNAL / LEARNING AGENT — Component 9
//
// Two responsibilities:
//
//   1. REAL-TIME BOOKKEEPING (called during the session)
//      Records every trade entry and exit to a JSON session log.
//      Tracks dailyPnL, dailySpentUsd, and consecutiveLosses so the
//      Risk Manager's circuit breaker gates actually fire.
//      The session orchestrator calls buildPortfolioStateFromJournal()
//      to get a fresh PortfolioState before every risk check.
//
//   2. END-OF-SESSION ANALYSIS (called after the session ends)
//      Reviews all trades, computes win rates per pattern, identifies
//      which signal combinations worked and which didn't, suggests
//      signal weight adjustments, and asks Groq to write a human-readable
//      journal entry summarizing the session.
//
// WHY THIS MATTERS:
//   Without this agent, the Risk Manager's two most important circuit
//   breakers (maxConsecutiveLosses and maxDailyLossUsd) always see 0.
//   That means the bot could keep trading through a losing streak —
//   exactly what the circuit breaker is supposed to prevent.
//
// FILES WRITTEN:
//   logs/sessions/YYYY-MM-DD.json     — raw structured trade log
//   logs/journal/YYYY-MM-DD.md        — human-readable session review
//   logs/strategy-versions.json       — weight change history
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

/** A completed trade — entry + exit paired together. */
export interface TradeRecord {
  tradeId:      string;           // Unique ID (symbol + timestamp)
  symbol:       string;
  entryPrice:   number;
  exitPrice:    number | null;    // Null until position closes
  sizeUsd:      number;          // Dollar value at entry
  coinsTraded:  number;
  realizedPnL:  number | null;    // Null until exit
  realizedPnLPct: number | null;
  outcome:      'WIN' | 'LOSS' | 'BREAK_EVEN' | 'OPEN';
  exitReason:   string | null;    // e.g. "Stop-loss triggered", "Session end"
  pattern:      string | null;    // Which pattern triggered the entry
  decision:     DecisionResult;   // Full signal breakdown at entry
  enteredAt:    Date;
  exitedAt:     Date | null;
  durationMs:   number | null;    // How long the trade lasted
}

/** The full log for one trading session (one day). */
export interface SessionLog {
  date:               string;       // YYYY-MM-DD
  trades:             TradeRecord[];
  dailyPnL:           number;       // Sum of all closed trade P&L
  dailyPnLPct:        number;       // As % of starting portfolio value
  dailySpentUsd:      number;       // Total USD deployed across all trades
  startingValue:      number;       // Portfolio value at session start
  consecutiveLosses:  number;       // Current streak at session close
  circuitBreakered:   boolean;      // Did the circuit breaker fire today?
  sessionStartedAt:   string;
  sessionEndedAt:     string | null;
  strategyVersion:    string;
  // Quant metrics — computed at session end
  sharpeRatio:        number | null;
  sortinoRatio:       number | null;
  maxDrawdownPct:     number | null;
}

/** Aggregated pattern performance across all recorded sessions. */
export interface PatternStats {
  pattern:    string;
  trades:     number;
  wins:       number;
  losses:     number;
  winRate:    number;     // 0–1
  avgPnLPct:  number;     // Average % gain/loss per trade
}

/** Weight adjustment recommendation from the learning analysis. */
export interface WeightAdjustment {
  signal:       keyof typeof SIGNAL_WEIGHTS extends string ? keyof typeof SIGNAL_WEIGHTS : never;
  currentWeight: number;
  suggestedWeight: number;
  delta:        number;
  reason:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION LOG — load and save
// ─────────────────────────────────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function sessionLogPath(date?: string): string {
  return path.join(LOGGING.sessionLogDir, `${date ?? todayKey()}.json`);
}

function journalPath(date?: string): string {
  return path.join(LOGGING.journalDir, `${date ?? todayKey()}.md`);
}

/**
 * Load today's session log from disk, or create a fresh one.
 * Called at session start and before every trade to ensure we have
 * the latest state (in case of crash + restart).
 */
export function loadTodaySession(startingPortfolioValue: number): SessionLog {
  const filePath = sessionLogPath();

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as SessionLog;
    } catch {
      // Corrupted JSON — rename the bad file and start fresh rather than crashing
      const backup = filePath.replace('.json', `.corrupt-${Date.now()}.json`);
      try { fs.renameSync(filePath, backup); } catch { /* ignore rename failure */ }
      console.warn(`[Journal] Corrupted session log renamed to ${backup} — starting fresh`);
    }
  }

  // No log yet for today — create one
  const freshLog: SessionLog = {
    date:              todayKey(),
    trades:            [],
    dailyPnL:          0,
    dailyPnLPct:       0,
    dailySpentUsd:     0,
    startingValue:     startingPortfolioValue,
    consecutiveLosses: 0,
    circuitBreakered:  false,
    sessionStartedAt:  new Date().toISOString(),
    sessionEndedAt:    null,
    strategyVersion:   STRATEGY.currentVersion,
    sharpeRatio:       null,
    sortinoRatio:      null,
    maxDrawdownPct:    null,
  };

  saveSessionLog(freshLog);
  return freshLog;
}

function saveSessionLog(log: SessionLog): void {
  const filePath = sessionLogPath(log.date);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// REAL-TIME BOOKKEEPING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call this immediately after an order fills (trade entry confirmed).
 * Records the open trade in the session log.
 */
// Symbols that indicate a test/audit run and must NEVER touch the live session log.
// Audit code uses 'TEST' as the sentinel symbol; reject it here so audits stay clean.
function isTestSymbol(symbol: string): boolean {
  return symbol === 'TEST' || symbol.startsWith('TEST_') || symbol.startsWith('AUDIT_');
}

export function recordTradeEntry(
  log:       SessionLog,
  symbol:    string,
  entryPrice: number,
  sizeUsd:   number,
  coins:     number,
  decision:  DecisionResult,
): { log: SessionLog; tradeId: string } {
  const tradeId = `${symbol.replace('/', '_')}_${Date.now()}`;

  if (isTestSymbol(symbol)) {
    // Return the in-memory log untouched. Audits still get a tradeId to round-trip,
    // but nothing is persisted to disk so the real session log stays clean.
    return { log, tradeId };
  }

  const trade: TradeRecord = {
    tradeId,
    symbol,
    entryPrice,
    exitPrice:      null,
    sizeUsd,
    coinsTraded:    coins,
    realizedPnL:    null,
    realizedPnLPct: null,
    outcome:        'OPEN',
    exitReason:     null,
    pattern:        decision.pattern,
    decision,
    enteredAt:      new Date(),
    exitedAt:       null,
    durationMs:     null,
  };

  const updated: SessionLog = {
    ...log,
    trades:        [...log.trades, trade],
    dailySpentUsd: log.dailySpentUsd + sizeUsd,
  };

  saveSessionLog(updated);
  return { log: updated, tradeId };
}

/**
 * Call this immediately after a position closes (stop hit, take-profit, session end).
 * Calculates realized P&L and updates the running totals used by the Risk Manager.
 */
export function recordTradeExit(
  log:        SessionLog,
  tradeId:    string,
  exitPrice:  number,
  exitReason: string,
): SessionLog {
  // Guard against test/audit calls — if the tradeId references a TEST symbol,
  // there's nothing to update (the entry was never persisted).
  if (tradeId.startsWith('TEST_') || tradeId.startsWith('AUDIT_')) return log;

  const tradeIdx = log.trades.findIndex(t => t.tradeId === tradeId);
  if (tradeIdx === -1) {
    console.warn(`[Journal] recordTradeExit: tradeId ${tradeId} not found`);
    return log;
  }

  const trade    = log.trades[tradeIdx];
  const nowMs    = Date.now();
  const isShort  = (trade.pattern ?? '').includes('SHORT');
  const pnl      = isShort
    ? (trade.entryPrice - exitPrice) * trade.coinsTraded
    : (exitPrice - trade.entryPrice) * trade.coinsTraded;
  const pnlPct   = isShort
    ? (trade.entryPrice - exitPrice) / trade.entryPrice
    : (exitPrice - trade.entryPrice) / trade.entryPrice;
  const outcome: TradeRecord['outcome'] =
    pnl > 0.01   ? 'WIN'        :
    pnl < -0.01  ? 'LOSS'       : 'BREAK_EVEN';

  const closedTrade: TradeRecord = {
    ...trade,
    exitPrice,
    exitReason,
    realizedPnL:    Math.round(pnl * 100) / 100,
    realizedPnLPct: Math.round(pnlPct * 10000) / 10000,
    outcome,
    exitedAt:   new Date(),
    durationMs: nowMs - new Date(trade.enteredAt).getTime(),
  };

  const updatedTrades = [...log.trades];
  updatedTrades[tradeIdx] = closedTrade;

  // Recompute session-level totals from all closed trades
  const closedTrades   = updatedTrades.filter(t => t.outcome !== 'OPEN');
  const newDailyPnL    = closedTrades.reduce((sum, t) => sum + (t.realizedPnL ?? 0), 0);
  const newDailyPnLPct = log.startingValue > 0 ? newDailyPnL / log.startingValue : 0;

  // Recompute consecutive losses from the end of the closed trades list
  let streak = 0;
  for (let i = closedTrades.length - 1; i >= 0; i--) {
    if (closedTrades[i].outcome === 'LOSS') streak++;
    else break;
  }

  const updated: SessionLog = {
    ...log,
    trades:            updatedTrades,
    dailyPnL:          Math.round(newDailyPnL * 100) / 100,
    dailyPnLPct:       Math.round(newDailyPnLPct * 10000) / 10000,
    consecutiveLosses: streak,
  };

  saveSessionLog(updated);
  return updated;
}

/**
 * Returns a PortfolioState that reflects everything that has happened today.
 * Call this before every Risk Manager check so circuit breakers work correctly.
 *
 * NOTE: totalValue and cash come from the Execution Engine (live Alpaca state).
 * The Journal supplies the daily-cumulative numbers the Execution Engine can't
 * compute on its own (dailyPnL, dailySpentUsd, consecutiveLosses).
 */
export function buildPortfolioStateFromJournal(
  log:           SessionLog,
  liveTotal:     number,
  liveCash:      number,
  livePositions: PortfolioState['openPositions'],
): PortfolioState {
  return {
    totalValue:           liveTotal,
    cash:                 liveCash,
    dailyPnL:             log.dailyPnL,
    dailyPnLPct:          log.dailyPnLPct,
    dailySpentUsd:        log.dailySpentUsd,
    openPositions:        livePositions,
    consecutiveLosses:    log.consecutiveLosses,
    circuitBreakerActive: log.circuitBreakered,
  };
}

/**
 * Call when the circuit breaker fires. Marks the session so future calls
 * to buildPortfolioStateFromJournal return circuitBreakerActive: true.
 */
export function markCircuitBreaker(log: SessionLog): SessionLog {
  const updated = { ...log, circuitBreakered: true };
  saveSessionLog(updated);
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// END-OF-SESSION ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full end-of-session review. Call this after all positions are closed.
 *
 * Steps:
 *   1. Finalize the session log (set sessionEndedAt)
 *   2. Compute pattern win rates
 *   3. Load historical pattern stats and update them
 *   4. Generate weight adjustment suggestions
 *   5. Ask Groq to write a human-readable journal entry
 *   6. Write the journal entry to disk
 *   7. Save the updated strategy version
 */
export function computeSessionMetrics(trades: TradeRecord[]): {
  sharpe:      number | null;
  sortino:     number | null;
  maxDrawdown: number | null;
} {
  const closed = trades.filter(t => t.outcome !== 'OPEN' && t.realizedPnLPct != null);
  if (closed.length < 2) return { sharpe: null, sortino: null, maxDrawdown: null };

  const returns = closed.map(t => t.realizedPnLPct ?? 0);
  const mean    = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev  = Math.sqrt(variance);

  // Sharpe: mean return / std dev (no risk-free rate — intraday)
  const sharpe  = stdDev > 0 ? Math.round((mean / stdDev) * 100) / 100 : null;

  // Sortino: mean return / downside deviation only
  const downside = returns.filter(r => r < 0);
  const downsideVariance = downside.length > 0
    ? downside.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downside.length
    : 0;
  const downsideStd = Math.sqrt(downsideVariance);
  const sortino = downsideStd > 0 ? Math.round((mean / downsideStd) * 100) / 100 : null;

  // Max drawdown: peak-to-trough on cumulative P&L
  let peak = 0, cumulative = 0, maxDD = 0;
  for (const r of returns) {
    cumulative += r;
    if (cumulative > peak) peak = cumulative;
    const dd = peak > 0 ? (peak - cumulative) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdown = Math.round(maxDD * 10000) / 10000;

  return { sharpe, sortino, maxDrawdown };
}

export async function runEndOfSessionAnalysis(log: SessionLog): Promise<{
  patternStats:  PatternStats[];
  adjustments:   WeightAdjustment[];
  journalEntry:  string;
}> {
  // Mark session as ended and compute quant metrics
  const metrics  = computeSessionMetrics(log.trades);

  // Recalculate dailyPnL from closed trades to ensure short P&L is correct
  const closedForPnL   = log.trades.filter(t => t.outcome !== 'OPEN');
  const correctedDailyPnL    = closedForPnL.reduce((sum, t) => sum + (t.realizedPnL ?? 0), 0);
  const correctedDailyPnLPct = log.startingValue > 0 ? correctedDailyPnL / log.startingValue : 0;

  const finalLog: SessionLog = {
    ...log,
    dailyPnL:       Math.round(correctedDailyPnL    * 100) / 100,
    dailyPnLPct:    Math.round(correctedDailyPnLPct * 10000) / 10000,
    sessionEndedAt: new Date().toISOString(),
    sharpeRatio:    metrics.sharpe,
    sortinoRatio:   metrics.sortino,
    maxDrawdownPct: metrics.maxDrawdown,
  };
  saveSessionLog(finalLog);

  const closedTrades = finalLog.trades.filter(t => t.outcome !== 'OPEN');

  // ── Step 1: Compute pattern stats for today ─────────────────────────────────
  const todayStats = computePatternStats(closedTrades);

  // ── Step 2: Load and merge historical stats ─────────────────────────────────
  const mergedStats = mergeWithHistoricalStats(todayStats);

  // ── Step 3: Generate weight adjustments ────────────────────────────────────
  const adjustments = generateWeightAdjustments(closedTrades, mergedStats);

  // ── Step 4: Ask Groq for the journal narrative ─────────────────────────────
  const journalEntry = await generateJournalEntry(finalLog, todayStats, adjustments);

  // ── Step 5: Write journal to disk ──────────────────────────────────────────
  const jPath = journalPath(finalLog.date);
  fs.mkdirSync(path.dirname(jPath), { recursive: true });
  fs.writeFileSync(jPath, journalEntry, 'utf-8');

  // ── Step 6: Save strategy version if weights changed ──────────────────────
  if (adjustments.length > 0) {
    saveStrategyVersion(adjustments, finalLog);
  }

  console.log(`[Journal] Session analysis complete. Journal → ${jPath}`);
  return { patternStats: mergedStats, adjustments, journalEntry };
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN STATS
// ─────────────────────────────────────────────────────────────────────────────

function computePatternStats(trades: TradeRecord[]): PatternStats[] {
  const byPattern = new Map<string, TradeRecord[]>();

  for (const trade of trades) {
    const key = trade.pattern ?? 'No Pattern';
    if (!byPattern.has(key)) byPattern.set(key, []);
    byPattern.get(key)!.push(trade);
  }

  const stats: PatternStats[] = [];
  for (const [pattern, tradeList] of byPattern) {
    const wins   = tradeList.filter(t => t.outcome === 'WIN').length;
    const losses = tradeList.filter(t => t.outcome === 'LOSS').length;
    const pnlPcts = tradeList.map(t => t.realizedPnLPct ?? 0);
    const avgPnLPct = pnlPcts.length > 0
      ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length
      : 0;

    stats.push({
      pattern,
      trades:   tradeList.length,
      wins,
      losses,
      winRate:  tradeList.length > 0 ? wins / tradeList.length : 0,
      avgPnLPct: Math.round(avgPnLPct * 10000) / 10000,
    });
  }

  return stats.sort((a, b) => b.trades - a.trades);
}

// ─────────────────────────────────────────────────────────────────────────────
// HISTORICAL STATS — read and merge all past sessions
// ─────────────────────────────────────────────────────────────────────────────

interface HistoricalStatsFile {
  updatedAt:    string;
  patternStats: PatternStats[];
}

const HISTORICAL_STATS_PATH = path.join(LOGGING.journalDir, 'pattern-stats.json');

function loadHistoricalStats(): PatternStats[] {
  if (!fs.existsSync(HISTORICAL_STATS_PATH)) return [];
  try {
    const raw = fs.readFileSync(HISTORICAL_STATS_PATH, 'utf-8');
    return (JSON.parse(raw) as HistoricalStatsFile).patternStats;
  } catch {
    console.warn('[Journal] Corrupted pattern-stats.json — starting with empty stats');
    return [];
  }
}

function mergeWithHistoricalStats(todayStats: PatternStats[]): PatternStats[] {
  const historical = loadHistoricalStats();
  const merged = new Map<string, PatternStats>();

  // Start with historical
  for (const s of historical) merged.set(s.pattern, { ...s });

  // Merge in today's stats
  for (const today of todayStats) {
    const existing = merged.get(today.pattern);
    if (!existing) {
      merged.set(today.pattern, { ...today });
      continue;
    }

    const totalTrades = existing.trades + today.trades;
    const totalWins   = existing.wins   + today.wins;
    // Weighted average of avgPnLPct
    const avgPnLPct   = totalTrades > 0
      ? (existing.avgPnLPct * existing.trades + today.avgPnLPct * today.trades) / totalTrades
      : 0;

    merged.set(today.pattern, {
      pattern:    today.pattern,
      trades:     totalTrades,
      wins:       totalWins,
      losses:     existing.losses + today.losses,
      winRate:    totalTrades > 0 ? totalWins / totalTrades : 0,
      avgPnLPct:  Math.round(avgPnLPct * 10000) / 10000,
    });
  }

  const result = Array.from(merged.values()).sort((a, b) => b.trades - a.trades);

  // Persist updated stats
  const file: HistoricalStatsFile = {
    updatedAt:    new Date().toISOString(),
    patternStats: result,
  };
  fs.mkdirSync(path.dirname(HISTORICAL_STATS_PATH), { recursive: true });
  fs.writeFileSync(HISTORICAL_STATS_PATH, JSON.stringify(file, null, 2), 'utf-8');

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// WEIGHT ADJUSTMENT RECOMMENDATIONS
//
// The learning logic: if a signal consistently scores high on winning trades
// and low on losing trades, we suggest raising its weight (and vice versa).
//
// We compare the average signal score on wins vs losses.
// If a signal distinguishes well → boost it. If it's the same either way → penalize.
//
// Changes are capped at SIGNAL_WEIGHTS.maxWeightAdjustmentPerSession per session
// and clamped between minWeight and maxWeight.
//
// These are SUGGESTIONS — the orchestrator must confirm before applying them.
// ─────────────────────────────────────────────────────────────────────────────

function generateWeightAdjustments(
  trades:   TradeRecord[],
  _patternStats: PatternStats[],
): WeightAdjustment[] {
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');

  // Need at least 3 closed trades to draw conclusions
  if (wins.length + losses.length < 3) return [];

  const signals: Array<keyof typeof SIGNAL_WEIGHTS> = [
    'technical', 'sentiment', 'whale', 'macro', 'microstructure',
  ];

  const adjustments: WeightAdjustment[] = [];
  const maxDelta = SIGNAL_WEIGHTS.maxWeightAdjustmentPerSession;

  for (const signal of signals) {
    const currentWeight = SIGNAL_WEIGHTS[signal] as number;
    if (typeof currentWeight !== 'number') continue;

    const avgWinScore  = avgSignalScore(wins,   signal);
    const avgLossScore = avgSignalScore(losses, signal);

    // How well does this signal separate wins from losses?
    // Positive = signal is higher on winning trades (good signal)
    // Negative = signal is higher on losing trades (misleading signal)
    const discrimination = avgWinScore - avgLossScore;

    let delta = 0;
    let reason = '';

    if (discrimination > 0.10) {
      // Signal clearly higher on wins → reward it
      delta  = Math.min(maxDelta, discrimination * 0.15);
      reason = `Higher on wins (avg ${avgWinScore.toFixed(3)}) vs losses (avg ${avgLossScore.toFixed(3)}) — good discriminator`;
    } else if (discrimination < -0.10) {
      // Signal higher on losses → penalize
      delta  = Math.max(-maxDelta, discrimination * 0.15);
      reason = `Higher on losses (avg ${avgLossScore.toFixed(3)}) than wins (avg ${avgWinScore.toFixed(3)}) — misleading signal`;
    } else {
      continue; // No meaningful difference — don't change
    }

    const suggestedWeight = Math.max(
      SIGNAL_WEIGHTS.minWeight,
      Math.min(SIGNAL_WEIGHTS.maxWeight, currentWeight + delta),
    );

    // Only recommend if there's an actual change
    if (Math.abs(suggestedWeight - currentWeight) < 0.001) continue;

    adjustments.push({
      signal:          signal as WeightAdjustment['signal'],
      currentWeight,
      suggestedWeight: Math.round(suggestedWeight * 1000) / 1000,
      delta:           Math.round(delta * 1000) / 1000,
      reason,
    });
  }

  return adjustments;
}

function avgSignalScore(trades: TradeRecord[], signal: string): number {
  const scores = trades.map(t => {
    const s = t.decision.scores as unknown as Record<string, number>;
    return s[signal] ?? 0.5;
  });
  if (scores.length === 0) return 0.5;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ JOURNAL NARRATIVE
// ─────────────────────────────────────────────────────────────────────────────

async function generateJournalEntry(
  log:         SessionLog,
  stats:       PatternStats[],
  adjustments: WeightAdjustment[],
): Promise<string> {
  const closedTrades  = log.trades.filter(t => t.outcome !== 'OPEN');
  const wins          = closedTrades.filter(t => t.outcome === 'WIN').length;
  const losses        = closedTrades.filter(t => t.outcome === 'LOSS').length;
  const winRate       = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(0) : '—';
  const pnlSign       = log.dailyPnL >= 0 ? '+' : '';

  // Format trade list for Groq context
  const tradeLines = closedTrades.slice(-10).map(t =>
    `  - ${t.symbol} | ${t.outcome} | P&L: ${t.realizedPnL !== null ? `$${t.realizedPnL.toFixed(2)}` : 'N/A'} | Pattern: ${t.pattern ?? 'None'} | Exit: ${t.exitReason ?? 'Unknown'}`
  ).join('\n');

  const patternLines = stats.slice(0, 5).map(s =>
    `  - ${s.pattern}: ${s.trades} trades, ${(s.winRate * 100).toFixed(0)}% win rate, avg ${(s.avgPnLPct * 100).toFixed(2)}% P&L`
  ).join('\n');

  const adjustmentLines = adjustments.map(a =>
    `  - ${a.signal}: ${(a.currentWeight * 100).toFixed(0)}% → ${(a.suggestedWeight * 100).toFixed(0)}% (${a.delta >= 0 ? '+' : ''}${(a.delta * 100).toFixed(1)}%) — ${a.reason}`
  ).join('\n') || '  - No adjustments suggested (insufficient data)';

  // Ask Groq to write the narrative section
  const groqResult = await askGroqSafe<{ analysis: string; lessons: string }>([
    {
      role:    'system',
      content: `You are a trading coach reviewing a day's performance for an autonomous crypto trading bot.
Write a concise, honest assessment. Max 4 sentences for analysis, max 3 bullet points for lessons.
Focus on what signals worked, what didn't, and one actionable improvement for tomorrow.
Respond with ONLY valid JSON: { "analysis": "...", "lessons": "- bullet 1\\n- bullet 2\\n- bullet 3" }`,
    },
    {
      role: 'user',
      content: `Review this trading session:

Date: ${log.date}
Net P&L: ${pnlSign}$${log.dailyPnL.toFixed(2)} (${pnlSign}${(log.dailyPnLPct * 100).toFixed(2)}%)
Trades: ${closedTrades.length} closed (${wins} wins, ${losses} losses, ${winRate}% win rate)
Daily spend: $${log.dailySpentUsd.toFixed(2)}
Circuit breaker fired: ${log.circuitBreakered ? 'YES' : 'No'}
Consecutive losses at end: ${log.consecutiveLosses}

Trades:
${tradeLines || '  (no trades today)'}

Pattern performance (all-time):
${patternLines || '  (no pattern data yet)'}

Suggested signal weight adjustments:
${adjustmentLines}`,
    },
  ]);

  const analysis = groqResult?.result?.analysis ?? 'AI analysis unavailable — review raw trades above.';
  const lessons  = groqResult?.result?.lessons  ?? '- Review trades manually';

  // Build the full markdown journal entry
  return [
    `# Trading Journal — ${log.date}`,
    '',
    `**Strategy Version:** ${log.strategyVersion}`,
    `**Session:** ${log.sessionStartedAt} → ${log.sessionEndedAt ?? 'in progress'}`,
    '',
    '## Session Summary',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Net P&L | ${pnlSign}$${log.dailyPnL.toFixed(2)} (${pnlSign}${(log.dailyPnLPct * 100).toFixed(2)}%) |`,
    `| Trades | ${closedTrades.length} (${wins}W / ${losses}L — ${winRate}% win rate) |`,
    `| Capital deployed | $${log.dailySpentUsd.toFixed(2)} |`,
    `| Consecutive losses | ${log.consecutiveLosses} |`,
    `| Circuit breaker | ${log.circuitBreakered ? 'FIRED' : 'Did not fire'} |`,
    `| Sharpe ratio | ${log.sharpeRatio != null ? log.sharpeRatio.toFixed(2) : '—'} |`,
    `| Sortino ratio | ${log.sortinoRatio != null ? log.sortinoRatio.toFixed(2) : '—'} |`,
    `| Max drawdown | ${log.maxDrawdownPct != null ? (log.maxDrawdownPct * 100).toFixed(2) + '%' : '—'} |`,
    '',
    '## Trade Log',
    '',
    closedTrades.length > 0
      ? closedTrades.map(t =>
        `### ${t.symbol} — ${t.outcome}` + '\n' +
        `- **Entry:** $${t.entryPrice.toFixed(2)} at ${new Date(t.enteredAt).toLocaleTimeString()}` + '\n' +
        `- **Exit:** $${t.exitPrice?.toFixed(2) ?? '—'} at ${t.exitedAt ? new Date(t.exitedAt).toLocaleTimeString() : '—'}` + '\n' +
        `- **P&L:** ${t.realizedPnL !== null ? `$${t.realizedPnL.toFixed(2)} (${((t.realizedPnLPct ?? 0) * 100).toFixed(2)}%)` : '—'}` + '\n' +
        `- **Pattern:** ${t.pattern ?? 'None'}` + '\n' +
        `- **Exit reason:** ${t.exitReason ?? '—'}` + '\n' +
        `- **Signals:** Tech ${t.decision.scores.technical.toFixed(3)} | Sent ${t.decision.scores.sentiment.toFixed(3)} | Whale ${t.decision.scores.whale.toFixed(3)} | Macro ${t.decision.scores.macro.toFixed(3)} | Micro ${t.decision.scores.microstructure.toFixed(3)}`
      ).join('\n\n')
      : '_No trades executed today._',
    '',
    '## Pattern Performance (All-Time)',
    '',
    stats.length > 0
      ? ['| Pattern | Trades | Win Rate | Avg P&L |',
         '|---------|--------|----------|---------|',
         ...stats.map(s =>
           `| ${s.pattern} | ${s.trades} | ${(s.winRate * 100).toFixed(0)}% | ${(s.avgPnLPct * 100).toFixed(2)}% |`
         )].join('\n')
      : '_No pattern data yet._',
    '',
    '## AI Analysis',
    '',
    analysis,
    '',
    '## Lessons Learned',
    '',
    lessons,
    '',
    '## Suggested Weight Adjustments',
    '',
    adjustments.length > 0
      ? ['| Signal | Current | Suggested | Change | Reason |',
         '|--------|---------|-----------|--------|--------|',
         ...adjustments.map(a =>
           `| ${a.signal} | ${(a.currentWeight * 100).toFixed(0)}% | ${(a.suggestedWeight * 100).toFixed(0)}% | ${a.delta >= 0 ? '+' : ''}${(a.delta * 100).toFixed(1)}% | ${a.reason} |`
         )].join('\n')
      : '_No adjustments suggested — need more trade data._',
    '',
    '---',
    `_Generated by Journal Agent at ${new Date().toISOString()}_`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY VERSIONING
// ─────────────────────────────────────────────────────────────────────────────

interface StrategyVersion {
  version:     string;
  date:        string;
  adjustments: WeightAdjustment[];
  sessionPnL:  number;
  winRate:     number;
}

function saveStrategyVersion(adjustments: WeightAdjustment[], log: SessionLog): void {
  const vPath = STRATEGY.versionFile;
  let versions: StrategyVersion[] = [];

  if (fs.existsSync(vPath)) {
    try {
      versions = JSON.parse(fs.readFileSync(vPath, 'utf-8')) as StrategyVersion[];
    } catch {
      console.warn('[Journal] Corrupted strategy-versions.json — starting fresh');
    }
  }

  const closedTrades = log.trades.filter(t => t.outcome !== 'OPEN');
  const wins         = closedTrades.filter(t => t.outcome === 'WIN').length;

  versions.push({
    version:     log.strategyVersion,
    date:        log.date,
    adjustments,
    sessionPnL:  log.dailyPnL,
    winRate:     closedTrades.length > 0 ? wins / closedTrades.length : 0,
  });

  fs.mkdirSync(path.dirname(vPath), { recursive: true });
  fs.writeFileSync(vPath, JSON.stringify(versions, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY — load all sessions for cross-session analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load all session logs from disk. Useful for computing week/month stats.
 * Returns sessions in chronological order.
 */
export function loadAllSessions(): SessionLog[] {
  if (!fs.existsSync(LOGGING.sessionLogDir)) return [];

  return fs.readdirSync(LOGGING.sessionLogDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .flatMap(f => {
      try {
        const raw = fs.readFileSync(path.join(LOGGING.sessionLogDir, f), 'utf-8');
        return [JSON.parse(raw) as SessionLog];
      } catch {
        console.warn(`[Journal] Skipping corrupted session file: ${f}`);
        return [];
      }
    });
}

/**
 * Returns overall stats across all sessions — useful for Discord summaries.
 */
export function computeAllTimeStats(): {
  totalSessions: number;
  totalTrades:   number;
  overallWinRate: number;
  totalPnL:      number;
  bestDay:       { date: string; pnl: number } | null;
  worstDay:      { date: string; pnl: number } | null;
} {
  const sessions    = loadAllSessions();
  const allClosed   = sessions.flatMap(s => s.trades.filter(t => t.outcome !== 'OPEN'));
  const wins        = allClosed.filter(t => t.outcome === 'WIN').length;
  const totalPnL    = sessions.reduce((sum, s) => sum + s.dailyPnL, 0);

  const sorted      = [...sessions].sort((a, b) => b.dailyPnL - a.dailyPnL);
  const best        = sorted[0]   ? { date: sorted[0].date,   pnl: sorted[0].dailyPnL   } : null;
  const worst       = sorted.at(-1) ? { date: sorted.at(-1)!.date, pnl: sorted.at(-1)!.dailyPnL } : null;

  return {
    totalSessions:   sessions.length,
    totalTrades:     allClosed.length,
    overallWinRate:  allClosed.length > 0 ? wins / allClosed.length : 0,
    totalPnL:        Math.round(totalPnL * 100) / 100,
    bestDay:         best,
    worstDay:        worst,
  };
}
