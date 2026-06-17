import * as fs   from 'fs';
import * as path from 'path';
import { log }         from '../core/logger.js';
import { askGroqSafe } from './groqClient.js';
import { SIGNAL_WEIGHTS, LOGGING, RISK, BRAIN_CONFIG } from '../config.js';
import type { SessionLog, TradeRecord, PatternStats } from './journal.js';
import type { DecisionResult } from '../core/decisionEngine.js';
import type { MacroResult }    from './macro.js';
import { runMonitor } from './monitor.js';

// ─────────────────────────────────────────────────────────────────────────────
// BRAIN.TS — The Self-Improving Intelligence Layer
//
// This is what separates a bot that just executes code from one that gets
// smarter every day. Four systems working together:
//
//   LAYER 1: ADAPTIVE WEIGHTS
//     Reads accumulated trade history and auto-applies signal weight
//     adjustments at session start. No human needed — it learns what
//     signals have actually been predicting wins vs losses and adjusts.
//
//   LAYER 2: REGIME MEMORY
//     Classifies the current market regime (bull/bear/ranging/fear/etc)
//     and looks up what has historically worked in that regime. Biases
//     position sizing and pattern selection accordingly.
//
//   LAYER 3: POST-TRADE REVIEW
//     After every losing trade, sends the full signal breakdown to Groq
//     and asks for a quant-level post-mortem. Stores lessons permanently.
//     Before the next trade in the same symbol, the bot reads and applies
//     the relevant lessons.
//
//   LAYER 4: PER-COIN BEHAVIORAL MEMORY
//     Each coin builds its own track record: which patterns work on it,
//     what its average win rate is, whether it tends to trigger false signals.
//     The bot becomes coin-specific in its decision-making over time.
//
// DESIGN PHILOSOPHY:
//   All learning is bounded. Weights never go outside config min/max.
//   Regime adjustments are multiplicative (scale sizing), never additive to score.
//   Lessons influence confidence thresholds, never override hard risk gates.
//   Every change is logged so the human can audit what the bot learned.
//
// FILES WRITTEN:
//   logs/brain/adaptive-weights.json    — current learned signal weights
//   logs/brain/regime-memory.json       — per-regime historical performance
//   logs/brain/lessons.json             — post-trade Groq lessons
//   logs/brain/coin-memory.json         — per-coin behavioral data
// ─────────────────────────────────────────────────────────────────────────────

const BRAIN_DIR = path.join(LOGGING.sessionLogDir, '..', 'brain');

const WEIGHTS_PATH  = path.join(BRAIN_DIR, 'adaptive-weights.json');
const REGIME_PATH   = path.join(BRAIN_DIR, 'regime-memory.json');
const LESSONS_PATH  = path.join(BRAIN_DIR, 'lessons.json');
const COIN_PATH     = path.join(BRAIN_DIR, 'coin-memory.json');

function ensureBrainDir(): void {
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — ADAPTIVE WEIGHTS
//
// At session start: load the learned weights and apply them to the live
// SIGNAL_WEIGHTS object so the decision engine uses them automatically.
//
// Weights are updated end-of-session based on signal discrimination:
// how much better each signal was at predicting wins vs losses.
//
// The weights are stored on disk and survive restarts. The config.ts values
// are only used as the starting point if no learned weights exist yet.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdaptiveWeights {
  technical:      number;
  microstructure: number;
  sentiment:      number;
  whale:          number;
  macro:          number;
  orb:            number;
  updatedAt:      string;
  sessionsLearned: number;
  changeLog:      Array<{
    date:   string;
    signal: string;
    from:   number;
    to:     number;
    reason: string;
  }>;
}

function loadAdaptiveWeights(): AdaptiveWeights | null {
  if (!fs.existsSync(WEIGHTS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf-8')) as AdaptiveWeights;
  } catch {
    log.warn('[Brain] Corrupted adaptive-weights.json — starting from defaults');
    return null;
  }
}

function saveAdaptiveWeights(w: AdaptiveWeights): void {
  ensureBrainDir();
  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(w, null, 2), 'utf-8');
}

/**
 * Called at session start. Applies learned weights to the live decision engine.
 * Returns a description of what was applied (for logging).
 */

/**
 * Reads weekly recommended_weights.json (written by portfolio-manager/weekly_review.py).
 * If the file is from the current week and all weights are within safe bounds,
 * blends them 50/50 with the current learned weights and applies the result.
 */
export function applyWeeklyRecommendations(): void {
  const recPath = '/opt/nexustrader/signals/recommended_weights.json';
  try {
    if (!fs.existsSync(recPath)) return;
    const ageHours = (Date.now() - fs.statSync(recPath).mtimeMs) / 3_600_000;
    if (ageHours > 7 * 24) {
      log.info('[Brain] recommended_weights.json is stale (>7 days) — ignoring');
      return;
    }
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf-8'));
    if (!rec.safe) {
      log.warn('[Brain] recommended_weights.json flagged as unsafe — ignoring');
      return;
    }

    const recWeights: Record<string, number> = rec.weights ?? {};
    const signals = ['technical', 'microstructure', 'sentiment', 'whale', 'macro', 'orb'];
    const minW = SIGNAL_WEIGHTS.minWeight;
    const maxW = SIGNAL_WEIGHTS.maxWeight;

    // Safety: reject if any weight is out of bounds
    for (const s of signals) {
      const w = recWeights[s] ?? 0;
      if (w < minW || w > maxW) {
        log.warn(`[Brain] Weekly recommendation rejected — ${s}=${w} out of [${minW}, ${maxW}]`);
        return;
      }
    }

    // Blend 50/50 with current live weights
    const mutableWeights = SIGNAL_WEIGHTS as unknown as Record<string, number>;
    const parts: string[] = [];
    for (const s of signals) {
      const current = mutableWeights[s] ?? (1 / signals.length);
      const blended = Math.round(((current + recWeights[s]) / 2) * 1000) / 1000;
      mutableWeights[s] = Math.max(minW, Math.min(maxW, blended));
      parts.push(`${s}:${(mutableWeights[s] * 100).toFixed(0)}%`);
    }
    log.info(`[Brain] Weekly recommendations blended in (${rec.trades_analyzed} trades, WR ${(rec.win_rate * 100).toFixed(0)}%): ${parts.join(' ')}`);
  } catch (err) {
    log.warn(`[Brain] Failed to apply weekly recommendations: ${err instanceof Error ? err.message : err}`);
  }
}

export function applyLearnedWeights(): string {
  const learned = loadAdaptiveWeights();
  if (!learned) {
    return 'No learned weights yet — using config defaults';
  }

  // Mutate the live SIGNAL_WEIGHTS object so all downstream code picks them up
  // TypeScript const objects are mutable at runtime — we cast to bypass the type
  const mutableWeights = SIGNAL_WEIGHTS as unknown as Record<string, number>;
  mutableWeights['technical']      = learned.technical;
  mutableWeights['microstructure'] = learned.microstructure;
  mutableWeights['sentiment']      = learned.sentiment;
  mutableWeights['whale']          = learned.whale;
  mutableWeights['macro']          = learned.macro;
  mutableWeights['orb']            = learned.orb;

  return [
    `Learned weights applied (${learned.sessionsLearned} sessions of data):`,
    `  Technical: ${(learned.technical * 100).toFixed(0)}%`,
    `  Microstructure: ${(learned.microstructure * 100).toFixed(0)}%`,
    `  Sentiment: ${(learned.sentiment * 100).toFixed(0)}%`,
    `  Whale: ${(learned.whale * 100).toFixed(0)}%`,
    `  Macro: ${(learned.macro * 100).toFixed(0)}%`,
    `  ORB: ${(learned.orb * 100).toFixed(0)}%`,
  ].join('\n');
}

/**
 * Called end-of-session with closed trades.
 * Computes how well each signal discriminated wins from losses and updates weights.
 */
export function updateLearnedWeights(trades: TradeRecord[]): void {
  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');

  // Need meaningful sample to learn from
  if (wins.length + losses.length < 3) {
    log.debug('[Brain] Not enough trades to update weights (<3 closed trades)');
    return;
  }

  const current = loadAdaptiveWeights() ?? {
    technical:       SIGNAL_WEIGHTS.technical,
    microstructure:  SIGNAL_WEIGHTS.microstructure,
    sentiment:       SIGNAL_WEIGHTS.sentiment,
    whale:           SIGNAL_WEIGHTS.whale,
    macro:           SIGNAL_WEIGHTS.macro,
    orb:             SIGNAL_WEIGHTS.orb,
    updatedAt:       new Date().toISOString(),
    sessionsLearned: 0,
    changeLog:       [],
  };

  const signals: Array<keyof Omit<AdaptiveWeights, 'updatedAt' | 'sessionsLearned' | 'changeLog'>> = [
    'technical', 'microstructure', 'sentiment', 'whale', 'macro', 'orb',
  ];

  const maxDelta = SIGNAL_WEIGHTS.maxWeightAdjustmentPerSession;
  const today    = new Date().toISOString().split('T')[0];
  const newChangeLog = [...current.changeLog];

  let changed = false;

  for (const signal of signals) {
    const avgWin  = avgScore(wins,   signal);
    const avgLoss = avgScore(losses, signal);
    const discrimination = avgWin - avgLoss;

    // Only adjust if discrimination is meaningful
    if (Math.abs(discrimination) < BRAIN_CONFIG.minDiscrimination) continue;

    const direction = discrimination > 0 ? 1 : -1;
    // Proportional adjustment — stronger discrimination = bigger change
    const delta = direction * Math.min(maxDelta, Math.abs(discrimination) * 0.12);

    const oldWeight = current[signal] as number;
    const newWeight = Math.max(
      SIGNAL_WEIGHTS.minWeight,
      Math.min(SIGNAL_WEIGHTS.maxWeight, oldWeight + delta),
    );

    if (Math.abs(newWeight - oldWeight) < 0.001) continue;

    (current as unknown as Record<string, number>)[signal] = Math.round(newWeight * 1000) / 1000;
    changed = true;

    const reason = discrimination > 0
      ? `Win score ${avgWin.toFixed(3)} vs loss score ${avgLoss.toFixed(3)} — good discriminator`
      : `Loss score ${avgLoss.toFixed(3)} vs win score ${avgWin.toFixed(3)} — misleading signal`;

    newChangeLog.push({ date: today, signal, from: oldWeight, to: newWeight, reason });
    log.info(`[Brain] Weight update: ${signal} ${(oldWeight * 100).toFixed(0)}% → ${(newWeight * 100).toFixed(0)}% — ${reason}`);
  }

  if (!changed) {
    log.debug('[Brain] No weight changes — signals not discriminating enough yet');
    return;
  }

  // Re-normalize so weights still sum to 1.0
  const total = signals.reduce((sum, s) => sum + (current[s] as number), 0);
  if (total > 0) {
    for (const s of signals) {
      (current as unknown as Record<string, number>)[s] =
        Math.round(((current[s] as number) / total) * 1000) / 1000;
    }
  }

  current.updatedAt       = new Date().toISOString();
  current.sessionsLearned = current.sessionsLearned + 1;
  current.changeLog       = newChangeLog.slice(-50); // Keep last 50 changes

  saveAdaptiveWeights(current);
  log.info(`[Brain] Adaptive weights saved (${current.sessionsLearned} sessions learned)`);
}

function avgScore(trades: TradeRecord[], signal: string): number {
  const scores = trades.map(t => {
    const s = t.decision.scores as unknown as Record<string, number>;
    return s[signal] ?? 0.5;
  });
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — REGIME MEMORY
//
// A "regime" is a named market condition: bull trend, bear trend, high fear,
// sideways chop, etc. The bot classifies the current regime each session
// and looks up what historically worked in that regime.
//
// Over time this builds a genuine playbook:
//   "In extreme fear regimes, Oversold Accumulation has 71% win rate"
//   "In risk-off macro regimes, reduce position size by 40%"
//   "In bull trend regimes, Trend Continuation has 65% win rate"
//
// Position sizing multiplier: returned to the risk manager so high-confidence
// regimes get full size and weak/uncertain regimes get reduced size.
// ─────────────────────────────────────────────────────────────────────────────

export type RegimeName =
  | 'bull_trend'
  | 'bear_trend'
  | 'sideways_chop'
  | 'extreme_fear'
  | 'extreme_greed'
  | 'risk_off_macro'
  | 'risk_on_macro'
  | 'high_volatility'
  | 'low_volatility'
  | 'unknown';

export interface RegimeStats {
  regime:           RegimeName;
  sessions:         number;
  totalTrades:      number;
  winRate:          number;
  avgSessionPnLPct: number;
  bestPatterns:     string[];        // Top 3 patterns by win rate in this regime
  positionSizeMult: number;          // 0.5–1.2 — how much to scale position size
  updatedAt:        string;
}

type RegimeMemory = Record<RegimeName, RegimeStats>;

function loadRegimeMemory(): RegimeMemory {
  if (!fs.existsSync(REGIME_PATH)) return {} as RegimeMemory;
  try {
    return JSON.parse(fs.readFileSync(REGIME_PATH, 'utf-8')) as RegimeMemory;
  } catch {
    log.warn('[Brain] Corrupted regime-memory.json — starting from defaults');
    return {} as RegimeMemory;
  }
}

function saveRegimeMemory(memory: RegimeMemory): void {
  ensureBrainDir();
  fs.writeFileSync(REGIME_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

/**
 * Classifies the current market regime from available signals.
 * Called at session start with the latest macro + fear/greed data.
 */
export function classifyRegime(params: {
  macroScore:    number;   // 0–1 from macro agent
  fearGreed:     number;   // 0–100
  spyTrend:      'bullish' | 'bearish' | 'neutral';  // SPY trend (not BTC)
  atrPct:        number;   // 0–1 volatility
}): RegimeName {
  const { macroScore, fearGreed, spyTrend, atrPct } = params;

  if (fearGreed <= 20)   return 'extreme_fear';
  if (fearGreed >= 80)   return 'extreme_greed';
  if (macroScore < 0.35) return 'risk_off_macro';
  if (macroScore > 0.65) return 'risk_on_macro';
  if (atrPct > 0.06)     return 'high_volatility';
  if (atrPct < 0.02)     return 'low_volatility';
  if (spyTrend === 'bullish') return 'bull_trend';
  if (spyTrend === 'bearish') return 'bear_trend';
  return 'sideways_chop';
}

/**
 * Look up the current regime's history and return sizing recommendation.
 * Returns 1.0 if no data yet (neutral — don't penalize unknown regimes).
 */
export function getRegimeSizingMultiplier(regime: RegimeName): number {
  const memory = loadRegimeMemory();
  const stats  = memory[regime];
  if (!stats || stats.totalTrades < 5) return 1.0; // Not enough data yet

  return stats.positionSizeMult;
}

/**
 * Returns the best-known patterns for the current regime (for logging).
 */
export function getRegimeContext(regime: RegimeName): string {
  const memory = loadRegimeMemory();
  const stats  = memory[regime];

  if (!stats || stats.totalTrades < 5) {
    return `Regime: ${regime} (no historical data yet — using defaults)`;
  }

  return [
    `Regime: ${regime} (${stats.sessions} sessions, ${(stats.winRate * 100).toFixed(0)}% win rate)`,
    `Best patterns: ${stats.bestPatterns.join(', ') || 'none yet'}`,
    `Position size: ${(stats.positionSizeMult * 100).toFixed(0)}% of normal`,
  ].join(' | ');
}

/**
 * Called end-of-session. Updates regime memory with today's results.
 */
export function updateRegimeMemory(
  regime:       RegimeName,
  session:      SessionLog,
  patternStats: PatternStats[],
): void {
  const memory  = loadRegimeMemory();
  const existing = memory[regime] ?? {
    regime,
    sessions:         0,
    totalTrades:      0,
    winRate:          0,
    avgSessionPnLPct: 0,
    bestPatterns:     [],
    positionSizeMult: 1.0,
    updatedAt:        new Date().toISOString(),
  };

  const closedTrades = session.trades.filter(t => t.outcome !== 'OPEN');
  const wins         = closedTrades.filter(t => t.outcome === 'WIN').length;
  const sessionWinRate = closedTrades.length > 0 ? wins / closedTrades.length : 0;

  // Rolling average — weight recent sessions more (exponential smoothing)
  const alpha = BRAIN_CONFIG.smoothingAlpha;
  const newWinRate    = existing.sessions === 0
    ? sessionWinRate
    : (existing.winRate * (1 - alpha)) + (sessionWinRate * alpha);
  const newPnLPct     = existing.sessions === 0
    ? session.dailyPnLPct
    : (existing.avgSessionPnLPct * (1 - alpha)) + (session.dailyPnLPct * alpha);

  // Best patterns in this regime = top 3 by win rate with >2 trades
  const regimePatterns = patternStats
    .filter(p => p.trades >= 2)
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 3)
    .map(p => p.pattern);

  // Position size multiplier: scale based on historical win rate in this regime
  const bc = BRAIN_CONFIG;
  let sizeMult: number;
  if (existing.sessions + 1 < 5) {
    sizeMult = 1.0; // Not enough data yet — don't penalize
  } else if (newWinRate >= 0.60) {
    sizeMult = Math.min(bc.regimeSizeMultMax, bc.regimeSizeBase + (newWinRate - 0.60) * 2.0);
  } else if (newWinRate <= 0.40) {
    sizeMult = Math.max(bc.regimeSizeMultMin, bc.regimeSizeBase - (0.40 - newWinRate) * 1.5);
  } else {
    sizeMult = 1.0;
  }

  const updated: RegimeStats = {
    regime,
    sessions:         existing.sessions + 1,
    totalTrades:      existing.totalTrades + closedTrades.length,
    winRate:          Math.round(newWinRate * 1000) / 1000,
    avgSessionPnLPct: Math.round(newPnLPct * 10000) / 10000,
    bestPatterns:     regimePatterns,
    positionSizeMult: Math.round(sizeMult * 100) / 100,
    updatedAt:        new Date().toISOString(),
  };

  memory[regime] = updated;
  saveRegimeMemory(memory);

  log.info(`[Brain] Regime memory updated: ${regime} → ${(newWinRate * 100).toFixed(0)}% win rate, size mult ${(sizeMult * 100).toFixed(0)}%`);
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — POST-TRADE REVIEW (Groq-powered)
//
// After every losing trade, sends the full signal breakdown to Groq and asks:
// "Why did this lose? What was misleading? What should the bot do differently?"
//
// The lessons are stored permanently and consulted before the next trade
// on the same symbol. This is the "learning from mistakes" layer.
//
// We only run this on LOSSES (not every trade) to:
//   a) Keep Groq API usage reasonable
//   b) Focus learning where it matters most
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeLessons {
  symbol:     string;
  lessons:    LessonEntry[];
}

export interface LessonEntry {
  date:          string;
  tradeId:       string;
  outcome:       string;
  exitReason:    string;
  pnlPct:        number;
  lesson:        string;   // Groq's one-sentence lesson
  signalToAvoid: string;   // Which signal was most misleading
  confidenceAdj: number;   // How much to adjust confidence threshold (-0.05 to +0.05)
}

type LessonsMemory = Record<string, TradeLessons>; // keyed by symbol

function loadLessons(): LessonsMemory {
  if (!fs.existsSync(LESSONS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(LESSONS_PATH, 'utf-8')) as LessonsMemory;
  } catch {
    log.warn('[Brain] Corrupted lessons.json — starting from defaults');
    return {};
  }
}

function saveLessons(memory: LessonsMemory): void {
  ensureBrainDir();
  fs.writeFileSync(LESSONS_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

/**
 * Called after a losing trade closes.
 * Asks Groq for a post-mortem and stores the lesson.
 */
export async function recordTradeLesson(trade: TradeRecord): Promise<void> {
  if (trade.outcome === 'OPEN') return;
  if (!trade.exitReason || !trade.realizedPnLPct) return;

  const scores = trade.decision.scores;

  const isLoss = trade.outcome === 'LOSS' || trade.outcome === 'BREAK_EVEN';

  const groqResult = await askGroqSafe<{
    lesson:        string;
    worst_signal:  string;
    confidence_adj: number;
  }>([
    {
      role: 'system',
      content: `You are ARIA — Autonomous Risk Intelligence Advisor. You have 100+ years of compounded quant trading experience across every market regime since the 1920s. You specialize in intraday equity strategies, specifically Opening Range Breakout (ORB) on US equities.

Your job: review this ${isLoss ? 'losing' : 'winning'} ORB trade and extract one precise, actionable lesson.
- For losses: identify what was misleading and how to avoid it
- For wins: identify what confluence confirmed the thesis and should be weighted higher

Be brutally specific. Not "volume was weak" but "volume ratio 1.1× was below the 1.3× minimum — borderline entries at 9:45 have a poor track record."

Identify the single most impactful signal (technical/microstructure/sentiment/whale/macro/orb).
Suggest a confidence threshold adjustment between -0.05 and +0.05.
Respond ONLY with valid JSON: { "lesson": "...", "worst_signal": "signal_name", "confidence_adj": 0.0 }`,
    },
    {
      role: 'user',
      content: `ORB trade post-mortem:

Symbol: ${trade.symbol} | Outcome: ${trade.outcome} | P&L: ${((trade.realizedPnLPct ?? 0) * 100).toFixed(2)}%
Exit reason: ${trade.exitReason}
Pattern: ${trade.pattern ?? 'ORB LONG'}
Hold time: ${trade.durationMs ? Math.round(trade.durationMs / 60000) + ' minutes' : 'unknown'}

Signal scores at entry:
  ORB confidence: ${scores.technical.toFixed(3)}
  Technical:      ${scores.technical.toFixed(3)}
  Sentiment:      ${scores.sentiment.toFixed(3)}
  Whale:          ${scores.whale.toFixed(3)}
  Macro:          ${scores.macro.toFixed(3)}
  Final score:    ${trade.decision.finalScore.toFixed(3)} (threshold: ${trade.decision.threshold.toFixed(3)})

Data gaps at entry: ${trade.decision.dataGaps.join(', ') || 'none'}`,
    },
  ]);

  if (!groqResult?.result) {
    log.debug(`[Brain] Post-trade review skipped for ${trade.symbol} — Groq unavailable`);
    return;
  }

  const { lesson, worst_signal, confidence_adj } = groqResult.result;

  const entry: LessonEntry = {
    date:          new Date().toISOString().split('T')[0],
    tradeId:       trade.tradeId,
    outcome:       trade.outcome,
    exitReason:    trade.exitReason ?? 'unknown',
    pnlPct:        trade.realizedPnLPct ?? 0,
    lesson:        lesson ?? 'No lesson generated',
    signalToAvoid: worst_signal ?? 'unknown',
    confidenceAdj: Math.max(-BRAIN_CONFIG.lessonConfAdjMax, Math.min(BRAIN_CONFIG.lessonConfAdjMax, confidence_adj ?? 0)),
  };

  const memory  = loadLessons();
  const existing = memory[trade.symbol] ?? { symbol: trade.symbol, lessons: [] };

  existing.lessons = [...existing.lessons, entry].slice(-20); // Keep last 20 lessons per coin
  memory[trade.symbol] = existing;
  saveLessons(memory);

  log.info(`[Brain] Lesson recorded for ${trade.symbol}: "${lesson}"`);
  log.info(`[Brain] Most misleading signal: ${worst_signal} | Confidence adj: ${confidence_adj >= 0 ? '+' : ''}${confidence_adj}`);
}

/**
 * Called before entering a trade. Returns recent lessons for the symbol
 * and a confidence threshold adjustment based on accumulated learning.
 */
export function getSymbolLessons(symbol: string): {
  recentLessons: string[];
  confidenceAdj: number;
  shouldSkip:    boolean;
} {
  const memory    = loadLessons();
  const symbolData = memory[symbol];

  if (!symbolData || symbolData.lessons.length === 0) {
    return { recentLessons: [], confidenceAdj: 0, shouldSkip: false };
  }

  // Use last 5 lessons
  const recent = symbolData.lessons.slice(-5);
  const recentLessons = recent.map(l => l.lesson);

  // Average confidence adjustment from recent losses
  const avgAdj = recent.reduce((sum, l) => sum + l.confidenceAdj, 0) / recent.length;
  const confidenceAdj = Math.max(-BRAIN_CONFIG.symbolConfAdjMax, Math.min(BRAIN_CONFIG.symbolConfAdjMax, Math.round(avgAdj * 1000) / 1000));

  // Skip the symbol entirely if: all 5 recent lessons flag it AND coin win rate < 40%
  // (requires minTradesRequired trades before penalizing)
  const coin = getCoinProfile(symbol);
  const allLessonsNegative = recent.length >= 5 && recent.every(l => l.confidenceAdj >= 0.04);
  const poorWinRate = coin.totalTrades >= BRAIN_CONFIG.coinMemory.minTradesRequired && coin.winRate < 0.40;
  const shouldSkip = allLessonsNegative && poorWinRate;

  return { recentLessons, confidenceAdj, shouldSkip };
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 4 — PER-COIN BEHAVIORAL MEMORY
//
// Each coin develops its own profile over time. This captures:
//   - Overall win rate for this specific coin
//   - Which patterns work best on this coin
//   - Whether the coin tends to false-signal (many entries, low win rate)
//   - Recommended confidence threshold adjustment for this coin
//
// Example after 30 days:
//   BTC: 64% win rate, best pattern: Trend Pullback, confidence adj: -0.02
//   DOGE: 38% win rate, best pattern: Oversold Accumulation, confidence adj: +0.05
//   → Bot becomes much more selective on DOGE, more aggressive on BTC
// ─────────────────────────────────────────────────────────────────────────────

export interface CoinProfile {
  symbol:           string;
  totalTrades:      number;
  winRate:          number;
  avgPnLPct:        number;
  bestPattern:      string | null;
  worstPattern:     string | null;
  patternStats:     Record<string, { trades: number; wins: number; avgPnL: number }>;
  confidenceAdj:    number;   // Adjustment to confidence threshold for this coin
  positionSizeMult: number;   // Coin-specific size multiplier (in addition to volatility mult)
  updatedAt:        string;
}

type CoinMemory = Record<string, CoinProfile>;

function loadCoinMemory(): CoinMemory {
  if (!fs.existsSync(COIN_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(COIN_PATH, 'utf-8')) as CoinMemory;
  } catch {
    log.warn('[Brain] Corrupted coin-memory.json — starting from defaults');
    return {};
  }
}

function saveCoinMemory(memory: CoinMemory): void {
  ensureBrainDir();
  fs.writeFileSync(COIN_PATH, JSON.stringify(memory, null, 2), 'utf-8');
}

/**
 * Returns the coin's learned profile (or defaults if no data yet).
 */
export function getCoinProfile(symbol: string): CoinProfile {
  const memory = loadCoinMemory();
  return memory[symbol] ?? {
    symbol,
    totalTrades:      0,
    winRate:          0.5,
    avgPnLPct:        0,
    bestPattern:      null,
    worstPattern:     null,
    patternStats:     {},
    confidenceAdj:    0,
    positionSizeMult: 1.0,
    updatedAt:        new Date().toISOString(),
  };
}

/**
 * Called end-of-session. Updates per-coin profiles with today's trades.
 */
export function updateCoinMemory(trades: TradeRecord[]): void {
  if (trades.length === 0) return;

  const memory = loadCoinMemory();

  // Group trades by symbol
  const bySymbol = new Map<string, TradeRecord[]>();
  for (const trade of trades) {
    if (!bySymbol.has(trade.symbol)) bySymbol.set(trade.symbol, []);
    bySymbol.get(trade.symbol)!.push(trade);
  }

  for (const [symbol, symbolTrades] of bySymbol) {
    const existing = memory[symbol] ?? {
      symbol,
      totalTrades:      0,
      winRate:          0.5,
      avgPnLPct:        0,
      bestPattern:      null,
      worstPattern:     null,
      patternStats:     {},
      confidenceAdj:    0,
      positionSizeMult: 1.0,
      updatedAt:        new Date().toISOString(),
    };

    const wins      = symbolTrades.filter(t => t.outcome === 'WIN').length;
    const todayRate = symbolTrades.length > 0 ? wins / symbolTrades.length : 0.5;
    const todayPnL  = symbolTrades.reduce((s, t) => s + (t.realizedPnLPct ?? 0), 0) / symbolTrades.length;

    // Exponential smoothing — recent sessions weighted more
    const alpha = BRAIN_CONFIG.smoothingAlpha;
    const newWinRate  = existing.totalTrades === 0
      ? todayRate
      : (existing.winRate * (1 - alpha)) + (todayRate * alpha);
    const newAvgPnL   = existing.totalTrades === 0
      ? todayPnL
      : (existing.avgPnLPct * (1 - alpha)) + (todayPnL * alpha);

    // Update pattern stats for this coin
    const patternStats = { ...existing.patternStats };
    for (const trade of symbolTrades) {
      const p = trade.pattern ?? 'No Pattern';
      if (!patternStats[p]) patternStats[p] = { trades: 0, wins: 0, avgPnL: 0 };
      const ps = patternStats[p];
      const pnl = trade.realizedPnLPct ?? 0;
      patternStats[p] = {
        trades:  ps.trades + 1,
        wins:    ps.wins + (trade.outcome === 'WIN' ? 1 : 0),
        avgPnL:  (ps.avgPnL * ps.trades + pnl) / (ps.trades + 1),
      };
    }

    // Find best and worst patterns (minimum 3 trades to qualify)
    const qualifiedPatterns = Object.entries(patternStats).filter(([, s]) => s.trades >= 3);
    const bestPattern  = qualifiedPatterns.sort(([, a], [, b]) =>
      (b.wins / b.trades) - (a.wins / a.trades)
    )[0]?.[0] ?? existing.bestPattern;
    const worstPattern = qualifiedPatterns.sort(([, a], [, b]) =>
      (a.wins / a.trades) - (b.wins / b.trades)
    )[0]?.[0] ?? existing.worstPattern;

    // Confidence adjustment and position size multiplier from config bands
    const totalTrades = existing.totalTrades + symbolTrades.length;
    let confidenceAdj    = 0;
    let positionSizeMult = 1.0;
    if (totalTrades >= BRAIN_CONFIG.coinMemory.minTradesRequired) {
      const band = BRAIN_CONFIG.coinMemory.winRateBands.find(b => newWinRate < b.maxWinRate)
        ?? BRAIN_CONFIG.coinMemory.winRateBands[BRAIN_CONFIG.coinMemory.winRateBands.length - 1];
      confidenceAdj    = band.confAdj;
      positionSizeMult = band.sizeMult;
    }

    memory[symbol] = {
      symbol,
      totalTrades:      totalTrades,
      winRate:          Math.round(newWinRate * 1000) / 1000,
      avgPnLPct:        Math.round(newAvgPnL  * 10000) / 10000,
      bestPattern,
      worstPattern,
      patternStats,
      confidenceAdj:    Math.round(confidenceAdj    * 1000) / 1000,
      positionSizeMult: Math.round(positionSizeMult * 100)  / 100,
      updatedAt:        new Date().toISOString(),
    };

    log.info(`[Brain] Coin memory updated: ${symbol} — ${(newWinRate * 100).toFixed(0)}% win rate over ${totalTrades} trades | conf adj: ${confidenceAdj >= 0 ? '+' : ''}${confidenceAdj} | size: ${(positionSizeMult * 100).toFixed(0)}%`);
  }

  saveCoinMemory(memory);
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION START — run all brain initialization
// Single entry point called at the top of startSession()
// ─────────────────────────────────────────────────────────────────────────────

export async function brainSessionStart(params: {
  macroScore: number;
  fearGreed:  number;
  spyTrend:   'bullish' | 'bearish' | 'neutral';
  atrPct:     number;
}): Promise<{ regime: RegimeName; regimeContext: string }> {
  ensureBrainDir();

  // Apply learned weights (daily) then blend in weekly recommendations
  const weightMsg = applyLearnedWeights();
  log.info(`[Brain] ${weightMsg}`);
  applyWeeklyRecommendations();

  // Classify regime
  const regime = classifyRegime(params);
  const regimeContext = getRegimeContext(regime);
  log.info(`[Brain] ${regimeContext}`);

  return { regime, regimeContext };
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION END — run all brain updates
// Single entry point called at the bottom of endSession()
// ─────────────────────────────────────────────────────────────────────────────

export async function brainSessionEnd(
  session:      SessionLog,
  regime:       RegimeName,
  patternStats: PatternStats[],
): Promise<void> {
  const closedTrades = session.trades.filter(t => t.outcome !== 'OPEN');

  log.info('[Brain] Running end-of-session learning...');

  // Layer 1: Update adaptive weights
  updateLearnedWeights(closedTrades);

  // Layer 2: Update regime memory
  updateRegimeMemory(regime, session, patternStats);

  // Layer 3: Post-trade review on all closed trades (wins teach too)
  for (const trade of closedTrades) {
    await recordTradeLesson(trade);
  }

  // Layer 4: Update coin memory
  updateCoinMemory(closedTrades);

  // Write human-readable brain snapshot for Obsidian
  writeBrainSnapshot(session, regime);

  // Write monitor report for end-of-day bug review
  const reportPath = runMonitor(session);
  log.info(`[Monitor] Bug report written → ${reportPath}`);

  log.info('[Brain] Learning complete for this session');
}

// ─────────────────────────────────────────────────────────────────────────────
// OBSIDIAN BRAIN WEB
//
// Writes a network of linked Markdown notes after every session so Obsidian's
// Graph View renders a live visual brain web:
//
//   logs/brain/
//     Brain.md                  ← hub note, links to everything
//     Signal Weights.md         ← bar chart of learned weights
//     symbols/NVDA.md           ← one note per symbol
//     regimes/sideways_chop.md  ← one note per regime seen
//     lessons/2026-05-11.md     ← one note per session that had lessons
//
// Every note uses [[wiki-links]] so Obsidian draws edges in the graph.
// The hub is the spider; symbols, regimes, and lessons are the web.
// ─────────────────────────────────────────────────────────────────────────────

function writeNote(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function writeBrainSnapshot(session: SessionLog, regime: RegimeName): void {
  const weights   = loadAdaptiveWeights();
  const coinMem   = loadCoinMemory();
  const regimeMem = loadRegimeMemory();
  const lessons   = loadLessons();

  const sessionsDir = path.join(BRAIN_DIR, '..', 'sessions');
  const allSessions: SessionLog[] = fs.existsSync(sessionsDir)
    ? fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json'))
        .flatMap(f => {
          try {
            return [JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8')) as SessionLog];
          } catch {
            return []; // skip corrupted session files
          }
        })
    : [session];

  const updatedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });

  const closedTrades = session.trades.filter(t => t.outcome !== 'OPEN');
  const wins         = closedTrades.filter(t => t.outcome === 'WIN').length;
  const losses       = closedTrades.filter(t => t.outcome === 'LOSS').length;
  const winRateToday = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(0) + '%' : '—';
  const pnlSign      = session.dailyPnL >= 0 ? '+' : '';

  const allClosed  = allSessions.flatMap(s => s.trades.filter(t => t.outcome !== 'OPEN'));
  const allWins    = allClosed.filter(t => t.outcome === 'WIN').length;
  const allPnL     = allSessions.reduce((sum, s) => sum + s.dailyPnL, 0);
  const allWinRate = allClosed.length > 0 ? ((allWins / allClosed.length) * 100).toFixed(1) + '%' : '—';

  // ── 1. Symbol notes ─────────────────────────────────────────────────────────
  const symbolsDir  = path.join(BRAIN_DIR, 'symbols');
  const symbolNames = Object.keys(coinMem);

  for (const sym of symbolNames) {
    const c       = coinMem[sym];
    const symLessons = lessons[sym]?.lessons ?? [];
    const trend   = c.winRate >= 0.60 ? '✅ Trusted' : c.winRate < 0.40 ? '🔴 Avoid' : '🟡 Neutral';
    const adjStr  = c.confidenceAdj >= 0 ? `+${(c.confidenceAdj * 100).toFixed(0)}%` : `${(c.confidenceAdj * 100).toFixed(0)}%`;

    // Recent trades for this symbol across all sessions
    const symTrades = allSessions
      .flatMap(s => s.trades.filter(t => t.symbol === sym && t.outcome !== 'OPEN'))
      .slice(-10)
      .reverse();

    const tradeRows = symTrades.map(t => {
      const icon = t.outcome === 'WIN' ? '✅' : t.outcome === 'LOSS' ? '🔴' : '🟡';
      const pnl  = t.realizedPnL !== null ? `$${t.realizedPnL.toFixed(2)}` : '—';
      const date = new Date(t.enteredAt).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
      return `| ${icon} ${t.outcome} | ${date} | $${t.entryPrice.toFixed(2)} → $${(t.exitPrice ?? 0).toFixed(2)} | ${pnl} | ${t.exitReason?.split(' ').slice(0, 4).join(' ') ?? '—'} |`;
    }).join('\n');

    const lessonLines = symLessons.slice(-5).reverse().map(l =>
      `- **${l.date}** ${l.lesson} _(${l.outcome}, conf adj ${l.confidenceAdj >= 0 ? '+' : ''}${l.confidenceAdj})_`
    ).join('\n');

    const regimeLink = `[[regimes/${regime}]]`;

    writeNote(path.join(symbolsDir, `${sym}.md`), [
      `# ${trend} ${sym}`,
      `tags: symbol`,
      '',
      `> Part of [[Brain]] · Current regime: ${regimeLink} · [[Signal Weights]]`,
      '',
      '## Stats',
      '',
      `| | |`,
      `|---|---|`,
      `| Win rate | **${(c.winRate * 100).toFixed(0)}%** over ${c.totalTrades} trades |`,
      `| Confidence adj | ${adjStr} (higher = more selective) |`,
      `| Position size | ${(c.positionSizeMult * 100).toFixed(0)}% of normal |`,
      `| Best pattern | ${c.bestPattern ?? '—'} |`,
      `| Worst pattern | ${c.worstPattern ?? '—'} |`,
      `| Last updated | ${new Date(c.updatedAt).toLocaleDateString()} |`,
      '',
      '## Recent Trades',
      '',
      symTrades.length > 0 ? [
        '| Result | Date | Entry → Exit | P&L | Reason |',
        '|--------|------|--------------|-----|--------|',
        tradeRows,
      ].join('\n') : '_No trades yet._',
      '',
      '## ARIA Lessons',
      '',
      lessonLines || '_No lessons yet — ARIA writes one after each trade._',
      '',
      '---',
      `_Updated ${updatedAt} ET_`,
    ].join('\n'));
  }

  // ── 2. Regime notes ──────────────────────────────────────────────────────────
  const regimesDir = path.join(BRAIN_DIR, 'regimes');

  for (const [regimeName, r] of Object.entries(regimeMem)) {
    const isActive = regimeName === regime;
    const sizePct  = (r.positionSizeMult * 100).toFixed(0);
    const wrPct    = (r.winRate * 100).toFixed(0);

    writeNote(path.join(regimesDir, `${regimeName}.md`), [
      `# ${isActive ? '🟢 ' : ''}${regimeName}${isActive ? ' ← today' : ''}`,
      `tags: regime`,
      '',
      `> Part of [[Brain]]`,
      '',
      `| | |`,
      `|---|---|`,
      `| Sessions seen | ${r.sessions} |`,
      `| Total trades | ${r.totalTrades} |`,
      `| Win rate | **${wrPct}%** |`,
      `| Position size multiplier | **${sizePct}%** of normal |`,
      `| Best patterns | ${r.bestPatterns.join(', ') || '—'} |`,
      `| Last updated | ${new Date(r.updatedAt).toLocaleDateString()} |`,
      '',
      '## Symbols traded in this regime',
      '',
      symbolNames
        .filter(s => coinMem[s]?.totalTrades > 0)
        .map(s => `- [[symbols/${s}]]`)
        .join('\n') || '_No data yet._',
      '',
      '---',
      `_Updated ${updatedAt} ET_`,
    ].join('\n'));
  }

  // ── 3. Daily lesson note (only if there were lessons today) ──────────────────
  const lessonsDir     = path.join(BRAIN_DIR, 'lessons');
  const todayLessons   = Object.values(lessons)
    .flatMap(sym => sym.lessons.filter(l => l.date === session.date))
    .filter(l => l.lesson);

  if (todayLessons.length > 0) {
    const lessonLines = todayLessons.map(l =>
      `- **${l.tradeId.split('_')[0]}** [${l.outcome}] ${l.lesson}\n  _Signal to watch: \`${l.signalToAvoid}\` · conf adj ${l.confidenceAdj >= 0 ? '+' : ''}${l.confidenceAdj}_`
    ).join('\n');

    writeNote(path.join(lessonsDir, `${session.date}.md`), [
      `# Lessons — ${session.date}`,
      `tags: lessons`,
      '',
      `> Part of [[Brain]] · Regime: [[regimes/${regime}]]`,
      '',
      lessonLines,
      '',
      '## Symbols',
      todayLessons.map(l => `- [[symbols/${l.tradeId.split('_')[0]}]]`).join('\n'),
      '',
      '---',
      `_Written by ARIA after session close_`,
    ].join('\n'));
  }

  // ── 4. Signal Weights note ───────────────────────────────────────────────────
  const weightBar = weights ? [
    'technical', 'orb', 'macro', 'sentiment', 'whale', 'microstructure',
  ].map(key => {
    const val = (weights as unknown as Record<string, number>)[key] ?? 0;
    const filled = Math.round(val * 30);
    const bar = '█'.repeat(filled) + '░'.repeat(30 - filled);
    return `\`${key.padEnd(14)}\` ${bar} **${(val * 100).toFixed(1)}%**`;
  }).join('\n') : '_No learned weights yet._';

  const changeSummary = weights?.changeLog.slice(-5).reverse().map(c =>
    `- **${c.date}** \`${c.signal}\` ${(c.from * 100).toFixed(0)}% → ${(c.to * 100).toFixed(0)}% — ${c.reason}`
  ).join('\n') ?? '_No changes yet._';

  writeNote(path.join(BRAIN_DIR, 'Signal Weights.md'), [
    `# Signal Weights`,
    `tags: weights`,
    '',
    `> Part of [[Brain]] · ${weights?.sessionsLearned ?? 0} sessions of learning`,
    '',
    '_Wider bar = more trusted signal. Updates automatically after every session._',
    '',
    weightBar,
    '',
    '## Recent Changes',
    '',
    changeSummary,
    '',
    '---',
    `_Updated ${updatedAt} ET_`,
  ].join('\n'));

  // ── 5. Hub note — Brain.md ───────────────────────────────────────────────────
  const symbolLinks   = symbolNames
    .sort((a, b) => (coinMem[b]?.winRate ?? 0) - (coinMem[a]?.winRate ?? 0))
    .map(s => {
      const c     = coinMem[s];
      const icon  = c.winRate >= 0.60 ? '✅' : c.winRate < 0.40 ? '🔴' : '🟡';
      return `${icon} [[symbols/${s}]] ${(c.winRate * 100).toFixed(0)}%wr`;
    }).join('  ·  ');

  const regimeLinks = Object.keys(regimeMem)
    .map(r => r === regime ? `**[[regimes/${r}]] ← today**` : `[[regimes/${r}]]`)
    .join('  ·  ');

  const lessonDates = fs.existsSync(lessonsDir)
    ? fs.readdirSync(lessonsDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 5)
        .map(f => `[[lessons/${f.replace('.md', '')}]]`).join('  ·  ')
    : '_None yet_';

  writeNote(path.join(BRAIN_DIR, 'Brain.md'), [
    `# 🧠 Brain`,
    `_Last updated: ${updatedAt} ET_`,
    '',
    '> **Open Graph View** (Ctrl+G / Cmd+G) to see the full web.',
    '',
    '## Today',
    '',
    `| | |`,
    `|---|---|`,
    `| Date | ${session.date} |`,
    `| Regime | [[regimes/${regime}]] |`,
    `| Trades | ${closedTrades.length} closed · ${wins}W / ${losses}L · ${winRateToday} |`,
    `| P&L | ${pnlSign}$${session.dailyPnL.toFixed(2)} |`,
    `| Sessions learned | ${weights?.sessionsLearned ?? 0} |`,
    '',
    '## All-Time',
    '',
    `| | |`,
    `|---|---|`,
    `| Total trades | ${allClosed.length} |`,
    `| Win rate | ${allWinRate} |`,
    `| Total P&L | ${allPnL >= 0 ? '+' : ''}$${allPnL.toFixed(2)} |`,
    `| Sessions | ${allSessions.length} |`,
    '',
    '## Signal Weights',
    '',
    `[[Signal Weights]]`,
    '',
    '## Symbols',
    '',
    symbolLinks || '_No symbols yet._',
    '',
    '## Regimes',
    '',
    regimeLinks || '_No regimes yet._',
    '',
    '## Recent Lessons',
    '',
    lessonDates,
    '',
    '---',
    `_Brain v${weights?.sessionsLearned ?? 0} · auto-generated by brain.ts_`,
  ].join('\n'));

  log.info(`[Brain] Obsidian web written → ${BRAIN_DIR}/Brain.md (${symbolNames.length} symbols, ${Object.keys(regimeMem).length} regimes)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-TRADE INTELLIGENCE
// Called before every BUY execution. Returns adjustments from all 4 layers.
// ─────────────────────────────────────────────────────────────────────────────

export interface PreTradeIntelligence {
  positionSizeMult:  number;
  confidenceAdj:     number;
  shouldSkip:        boolean;  // true = skip this symbol entirely (poor history + bad lessons)
  summary:           string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MORNING BRIEF — ARIA's daily market opinion
//
// Called at 8:50 AM before the session starts. Synthesizes all available
// intelligence — regime, recent lessons, adaptive weights, watchlist — into
// a 3-5 sentence opinion sent to Discord.
//
// This is the "boss speaking" moment. ARIA reads the room, states her thesis
// for the day, and calls out any symbols she's watching closely or avoiding.
// ─────────────────────────────────────────────────────────────────────────────

export async function morningBrief(params: {
  regime:          RegimeName;
  regimeContext:   string;
  vixLevel:        number;
  spyPremkt:       number;   // SPY pre-market % change
  qqqPremkt:       number;   // QQQ pre-market % change
  watchlist:       string[];
  earningsSymbols: Set<string>;
}): Promise<string> {
  const { regime, regimeContext, vixLevel, spyPremkt, qqqPremkt, watchlist, earningsSymbols } = params;

  const weights    = loadAdaptiveWeights();
  const lessons    = loadLessons();
  const coinMem    = loadCoinMemory();

  // Pull top 3 recent lessons across all symbols
  const recentLessons: string[] = [];
  for (const sym of watchlist) {
    const entry = lessons[sym];
    if (entry?.lessons.length) {
      recentLessons.push(`${sym}: "${entry.lessons.at(-1)!.lesson}"`);
    }
    if (recentLessons.length >= 3) break;
  }

  // Symbols to watch (strong recent win rate) vs avoid (poor win rate or earnings)
  const toWatch: string[] = [];
  const toAvoid: string[] = [...earningsSymbols];
  for (const sym of watchlist) {
    const profile = coinMem[sym];
    if (!profile || profile.totalTrades < 3) continue;
    if (profile.winRate >= 0.60) toWatch.push(`${sym}(${(profile.winRate * 100).toFixed(0)}%wr)`);
    else if (profile.winRate < 0.40) toAvoid.push(`${sym}(${(profile.winRate * 100).toFixed(0)}%wr)`);
  }

  const spyStr  = `${spyPremkt >= 0 ? '+' : ''}${(spyPremkt * 100).toFixed(2)}%`;
  const qqqStr  = `${qqqPremkt >= 0 ? '+' : ''}${(qqqPremkt * 100).toFixed(2)}%`;
  const sessionsLearned = weights?.sessionsLearned ?? 0;

  const prompt = `Today's data:
- Regime: ${regime} | ${regimeContext}
- VIX: ${vixLevel.toFixed(1)} | SPY pre-market: ${spyStr} | QQQ pre-market: ${qqqStr}
- Learned signal weights after ${sessionsLearned} sessions: ${weights ? `ORB ${(weights.orb * 100).toFixed(0)}%, Technical ${(weights.technical * 100).toFixed(0)}%, Macro ${(weights.macro * 100).toFixed(0)}%, Sentiment ${(weights.sentiment * 100).toFixed(0)}%, Whale ${(weights.whale * 100).toFixed(0)}%` : 'defaults (no sessions yet)'}
- Symbols with strong recent win rate: ${toWatch.join(', ') || 'none yet'}
- Symbols to avoid today: ${toAvoid.join(', ') || 'none'}
- Recent lessons from trade history: ${recentLessons.join(' | ') || 'none yet'}`;

  const result = await askGroqSafe<{ brief: string }>([
    {
      role: 'system',
      content: `You are ARIA — Autonomous Risk Intelligence Advisor. You have 100+ years of compounded quant trading experience across every market regime since the 1920s. You specialize in intraday equity Opening Range Breakout (ORB) strategies.

Every morning before the market opens, you give a sharp, opinionated 3-4 sentence brief. You speak like a seasoned head trader — confident, specific, no hedging. You reference the data given. You state your thesis for the day, which symbols you're watching or avoiding, and one thing you learned from recent history that's relevant today.

Respond ONLY with valid JSON: { "brief": "your 3-4 sentence brief here" }`,
    },
    {
      role: 'user',
      content: prompt,
    },
  ]);

  const brief = result?.result?.brief ?? buildFallbackBrief(regime, vixLevel, spyStr, qqqStr, toWatch, toAvoid);

  log.info(`[ARIA] Morning brief: ${brief}`);
  return brief;
}

function buildFallbackBrief(
  regime:   RegimeName,
  vix:      number,
  spy:      string,
  qqq:      string,
  toWatch:  string[],
  toAvoid:  string[],
): string {
  const tone = regime === 'bull_trend' || regime === 'risk_on_macro'
    ? 'Conditions look favorable for ORB setups today.'
    : regime === 'extreme_fear' || regime === 'risk_off_macro'
    ? 'Risk-off conditions — sizing down and requiring higher confidence.'
    : 'Neutral conditions — standard ORB playbook applies.';

  return [
    `Regime: ${regime}. VIX ${vix.toFixed(1)}, SPY pre-market ${spy}, QQQ ${qqq}. ${tone}`,
    toWatch.length  ? `Watching: ${toWatch.join(', ')}.` : '',
    toAvoid.length  ? `Avoiding: ${toAvoid.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

export function getPreTradeIntelligence(symbol: string, regime: RegimeName, marketLensBias?: Map<string, number>): PreTradeIntelligence {
  const regimeMult = getRegimeSizingMultiplier(regime);
  const coin       = getCoinProfile(symbol);
  const { recentLessons, confidenceAdj: lessonAdj, shouldSkip } = getSymbolLessons(symbol);

  // Combined size multiplier: regime × coin (multiplicative, bounded 0.4–1.2)
  const combinedSizeMult = Math.max(BRAIN_CONFIG.combinedSizeMultMin, Math.min(BRAIN_CONFIG.combinedSizeMultMax,
    Math.round(regimeMult * coin.positionSizeMult * 100) / 100
  ));

  // Market-lens bias for this symbol (from AI daily briefing)
  const mlAdj = marketLensBias?.get(symbol) ?? 0;

  // Combined confidence adjustment: coin history + recent lessons + market-lens AI
  const combinedConfAdj = Math.max(BRAIN_CONFIG.combinedConfAdjMin, Math.min(BRAIN_CONFIG.combinedConfAdjMax,
    Math.round((coin.confidenceAdj + lessonAdj + mlAdj) * 1000) / 1000
  ));

  const parts: string[] = [];
  parts.push(`Regime: ${regime} (size ×${regimeMult})`);
  parts.push(`Coin history: ${coin.totalTrades} trades, ${(coin.winRate * 100).toFixed(0)}% win rate (size ×${coin.positionSizeMult})`);
  if (coin.bestPattern)  parts.push(`Best pattern on ${symbol}: ${coin.bestPattern}`);
  if (recentLessons.length > 0) parts.push(`Recent lesson: "${recentLessons[recentLessons.length - 1]}"`);
  if (mlAdj !== 0) parts.push(`Market-lens adj: ${mlAdj >= 0 ? '+' : ''}${mlAdj}`);
  if (combinedConfAdj !== 0) parts.push(`Confidence adj: ${combinedConfAdj >= 0 ? '+' : ''}${combinedConfAdj}`);

  if (shouldSkip) parts.push(`SKIP FLAG: poor win rate + consistently bad lessons`);

  return {
    positionSizeMult: combinedSizeMult,
    confidenceAdj:    combinedConfAdj,
    shouldSkip,
    summary:          parts.join(' | '),
  };
}

const SIGNALS_DIR = '/opt/nexustrader/signals';

/**
 * Writes orb_brain_export.json to the shared signals bus after each session.
 */
export function exportBrainState(): void {
  try {
    const memory = loadCoinMemory();
    const symbols: Record<string, {
      winRate: number; totalTrades: number; avgPnLPct: number;
      recentBias: string; bestPattern: string | null;
    }> = {};

    for (const [sym, coin] of Object.entries(memory)) {
      let recentBias = 'NEUTRAL';
      if (coin.totalTrades >= 3) {
        if (coin.winRate >= 0.60 && coin.avgPnLPct > 0) recentBias = 'TRENDING_UP';
        else if (coin.winRate < 0.40 || coin.avgPnLPct < -0.005) recentBias = 'TRENDING_DOWN';
      }
      symbols[sym] = {
        winRate:      Math.round(coin.winRate * 1000) / 1000,
        totalTrades:  coin.totalTrades,
        avgPnLPct:    Math.round(coin.avgPnLPct * 10000) / 10000,
        recentBias,
        bestPattern:  coin.bestPattern,
      };
    }

    const export_data = {
      exported_at: new Date().toISOString(),
      date:        new Date().toISOString().slice(0, 10),
      symbols,
    };

    fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(SIGNALS_DIR, 'orb_brain_export.json'),
      JSON.stringify(export_data, null, 2),
      'utf-8'
    );
    log.info(`[Brain] Exported brain state → signals/orb_brain_export.json (${Object.keys(symbols).length} symbols)`);
  } catch (err) {
    log.warn(`[Brain] Brain export failed: ${err instanceof Error ? err.message : err}`);
  }
}

