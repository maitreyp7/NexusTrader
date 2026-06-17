import { TechnicalSignal } from '../tools/signalEngine.js';
import { PatternScanResult } from '../tools/patterns.js';
import { SIGNAL_WEIGHTS, RISK } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// DECISION ENGINE — Component 5
//
// Takes ALL signals (technical, sentiment, whale, macro, microstructure),
// applies weighted scoring, checks pattern context, and outputs a final
// BUY / SELL / HOLD decision with complete reasoning.
//
// This is the last stop before the Risk Manager. If the Decision Engine
// says BUY, the Risk Manager still decides how much to buy and whether
// portfolio conditions allow it.
//
// DESIGN PRINCIPLES:
//
// 1. WEIGHTED SCORING — not voting
//    Each signal contributes a score (0–1). The final score is a weighted
//    sum. This is more nuanced than "3 out of 5 say buy" because it
//    captures HOW strongly each signal is bullish or bearish.
//
// 2. PATTERN-ADJUSTED THRESHOLD
//    The entry threshold changes based on pattern context:
//    - No pattern detected: threshold = 0.72 (be selective)
//    - Pattern detected: threshold = 0.59–0.65 (act on quality setups)
//    This enforces "no trade without a setup" discipline.
//
// 3. GRACEFUL DEGRADATION
//    If sentiment/whale/macro data isn't available yet, we substitute
//    neutral scores (0.50) and note it in the reasoning. The bot
//    continues to function — it just has less information.
//    When those agents are built, plug their scores in directly.
//
// 4. DOUBLE-COUNTING PREVENTION
//    Microstructure is separated from the technical score before combining.
//    We extract the pure technical score (momentum + trend + volume) to
//    avoid counting microstructure twice.
//
// 5. CONFIDENCE GATE
//    Even a perfect score (1.0) won't trigger a trade if confidence < 0.60.
//    Low confidence = signals conflict = don't act.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

export type TradeAction = 'BUY' | 'SELL' | 'HOLD';

export interface SignalInputs {
  technical: TechnicalSignal;      // From Signal Engine (Component 4)
  patterns:  PatternScanResult;    // From Pattern Recognition (Component 4.5)

  // Optional signals — neutral (0.50) until their agents are built
  // Each is 0 (strongly bearish) to 1 (strongly bullish)
  sentimentScore?: number;         // From Sentiment Agent (future)
  whaleScore?:     number;         // From Whale Agent (future)
  macroScore?:     number;         // From Macro Agent (future)
}

export interface ScoreBreakdown {
  technical:      number;          // Pure technical (momentum + trend + volume)
  microstructure: number;          // Order book signal (separated from technical)
  sentiment:      number;          // News + Reddit + Fear & Greed
  whale:          number;          // On-chain + large wallet signals
  macro:          number;          // S&P500 + DXY + Fed events
}

export interface DecisionResult {
  action:      TradeAction;
  finalScore:  number;             // 0–1 weighted composite score
  threshold:   number;             // What score was needed to trigger this action
  confidence:  number;             // 0–1 signal confidence
  scores:      ScoreBreakdown;     // Per-signal breakdown
  weights:     ScoreBreakdown;     // Weights used for this decision
  pattern:     string | null;      // Which pattern (if any) triggered
  dataGaps:    string[];           // Which signals used neutral defaults
  tradeable:   boolean;            // False if any hard gate blocked the trade
  blockedBy:   string | null;      // Why it was blocked (if applicable)
  reason:      string;             // Full human-readable reasoning chain
  decidedAt:   Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — decide
// ─────────────────────────────────────────────────────────────────────────────
export function decide(inputs: SignalInputs): DecisionResult {
  const { technical, patterns } = inputs;

  // ── Gate 1: Microstructure tradeable check ─────────────────────────────────
  if (!technical.tradeable) {
    return buildBlockedDecision(
      inputs,
      `Spread too wide — ${technical.notTradeableReason}`,
    );
  }

  // ── Gate 2: Minimum confidence ─────────────────────────────────────────────
  if (technical.confidence < RISK.minConfidenceToTrade) {
    return buildBlockedDecision(
      inputs,
      `Confidence too low: ${technical.confidence.toFixed(3)} < ${RISK.minConfidenceToTrade} minimum`,
    );
  }

  // ── Step 1: Separate microstructure from pure technical score ──────────────
  // The technical signal includes micro — we extract it to avoid double-counting
  const { momentum, trend, volume, microstructure } = technical.components;

  // Pure technical = momentum + trend + volume only (no micro)
  const pureTechnicalScore =
    (momentum * 0.40) +
    (trend    * 0.40) +
    (volume   * 0.20);

  // ── Step 2: Collect all scores ─────────────────────────────────────────────
  const dataGaps: string[] = [];

  const sentimentScore = resolveScore(inputs.sentimentScore, 'Sentiment Agent', dataGaps);
  const whaleScore     = resolveScore(inputs.whaleScore,     'Whale Agent',     dataGaps);
  const macroScore     = resolveScore(inputs.macroScore,     'Macro Agent',     dataGaps);

  const scores: ScoreBreakdown = {
    technical:      Math.round(pureTechnicalScore * 1000) / 1000,
    microstructure: Math.round(microstructure     * 1000) / 1000,
    sentiment:      Math.round(sentimentScore     * 1000) / 1000,
    whale:          Math.round(whaleScore         * 1000) / 1000,
    macro:          Math.round(macroScore         * 1000) / 1000,
  };

  // ── Step 3: Apply weights ──────────────────────────────────────────────────
  const weights: ScoreBreakdown = {
    technical:      SIGNAL_WEIGHTS.technical,
    microstructure: SIGNAL_WEIGHTS.microstructure,
    sentiment:      SIGNAL_WEIGHTS.sentiment,
    whale:          SIGNAL_WEIGHTS.whale,
    macro:          SIGNAL_WEIGHTS.macro,
  };

  const rawFinalScore =
    (scores.technical      * weights.technical)      +
    (scores.microstructure * weights.microstructure) +
    (scores.sentiment      * weights.sentiment)      +
    (scores.whale          * weights.whale)          +
    (scores.macro          * weights.macro);

  // ── Step 4: Apply pattern score boost ─────────────────────────────────────
  const patternBoost = patterns.activePattern?.scoreBoost ?? 0;
  const boostedScore = Math.min(1, rawFinalScore + patternBoost);
  const finalScore   = Math.round(boostedScore * 1000) / 1000;

  // ── Step 5: Determine threshold based on pattern context ──────────────────
  const threshold = Math.round(patterns.recommendedThreshold * 1000) / 1000;

  // ── Step 6: Determine action ───────────────────────────────────────────────
  // SELL means "exit an existing position in this asset if we hold one."
  // It does NOT mean "open a short." This system is long-only.
  // The Position Manager (Component 7) is the handler for SELL signals —
  // it checks whether we actually hold a position and closes it if so.
  // If we don't hold the asset, SELL is treated as HOLD by the orchestrator.
  let action: TradeAction;

  if (finalScore >= threshold) {
    action = 'BUY';
  } else if (finalScore <= (1 - threshold)) {
    action = 'SELL';
  } else {
    action = 'HOLD';
  }

  // ── Step 7: Build reasoning ────────────────────────────────────────────────
  const reason = buildReason(
    action, finalScore, threshold, scores, weights,
    patterns, dataGaps, technical.confidence,
  );

  return {
    action,
    finalScore,
    threshold,
    confidence:  technical.confidence,
    scores,
    weights,
    pattern:     patterns.activePattern?.name ?? null,
    dataGaps,
    tradeable:   true,
    blockedBy:   null,
    reason,
    decidedAt:   new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// If a score is not provided, substitute 0.50 (neutral) and log the gap
function resolveScore(score: number | undefined, label: string, gaps: string[]): number {
  if (score !== undefined) return Math.max(0, Math.min(1, score));
  gaps.push(`${label} not available — using neutral (0.50)`);
  return 0.50;
}

function buildBlockedDecision(inputs: SignalInputs, reason: string): DecisionResult {
  const neutral = 0.50;
  const scores: ScoreBreakdown = { technical: neutral, microstructure: neutral, sentiment: neutral, whale: neutral, macro: neutral };
  const weights: ScoreBreakdown = { technical: SIGNAL_WEIGHTS.technical, microstructure: SIGNAL_WEIGHTS.microstructure, sentiment: SIGNAL_WEIGHTS.sentiment, whale: SIGNAL_WEIGHTS.whale, macro: SIGNAL_WEIGHTS.macro };

  return {
    action:      'HOLD',
    finalScore:  neutral,
    threshold:   SIGNAL_WEIGHTS.thresholds.buy,
    confidence:  inputs.technical.confidence,
    scores,
    weights,
    pattern:     null,
    dataGaps:    [],
    tradeable:   false,
    blockedBy:   reason,
    reason:      `HOLD — Blocked: ${reason}`,
    decidedAt:   new Date(),
  };
}

function buildReason(
  action: TradeAction,
  finalScore: number,
  threshold: number,
  scores: ScoreBreakdown,
  weights: ScoreBreakdown,
  patterns: PatternScanResult,
  dataGaps: string[],
  confidence: number,
): string {
  const lines: string[] = [];

  lines.push(`DECISION: ${action}`);
  lines.push(`Final score: ${finalScore.toFixed(3)} vs threshold: ${threshold.toFixed(3)}`);
  lines.push(`Confidence: ${confidence.toFixed(3)}`);
  lines.push('');
  lines.push('Signal breakdown:');
  lines.push(`  Technical      : ${scores.technical.toFixed(3)} × ${weights.technical} = ${(scores.technical * weights.technical).toFixed(3)}`);
  lines.push(`  Microstructure : ${scores.microstructure.toFixed(3)} × ${weights.microstructure} = ${(scores.microstructure * weights.microstructure).toFixed(3)}`);
  lines.push(`  Sentiment      : ${scores.sentiment.toFixed(3)} × ${weights.sentiment} = ${(scores.sentiment * weights.sentiment).toFixed(3)}`);
  lines.push(`  Whale          : ${scores.whale.toFixed(3)} × ${weights.whale} = ${(scores.whale * weights.whale).toFixed(3)}`);
  lines.push(`  Macro          : ${scores.macro.toFixed(3)} × ${weights.macro} = ${(scores.macro * weights.macro).toFixed(3)}`);

  if (patterns.activePattern) {
    lines.push('');
    lines.push(`Pattern: ${patterns.activePattern.name} (+${patterns.activePattern.scoreBoost} score boost, threshold → ${threshold})`);
    lines.push(`  ${patterns.activePattern.description}`);
  } else {
    lines.push('');
    lines.push('Pattern: None detected (threshold raised to 0.72)');
  }

  if (dataGaps.length > 0) {
    lines.push('');
    lines.push('Data gaps (using neutral defaults):');
    dataGaps.forEach(g => lines.push(`  ⚠ ${g}`));
  }

  return lines.join('\n');
}
