import { IndicatorSuite, computeMultiTimeframeScore } from './indicators.js';
import { MicrostructureResult } from './microstructure.js';

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL ENGINE — Component 4
//
// Takes raw outputs from the Indicator Engine (Component 2) and Microstructure
// Layer (Component 3) and combines them into a single clean TechnicalSignal.
//
// This is NOT the final trade decision — that's the Decision Engine (Component 5).
// This is purely the "technical" signal that feeds into the Decision Engine's
// weighted model alongside sentiment, whale, and macro signals.
//
// KEY DESIGN DECISIONS:
//
// 1. DE-CORRELATION
//    RSI and MACD both use the same price data — they are mathematically
//    correlated. Treating them as two independent signals would double-count
//    the same underlying information. Instead, we combine them into a single
//    "momentum" component. This is one of the most commonly ignored mistakes
//    in retail trading system design.
//
// 2. TIMEFRAME WEIGHTING
//    Higher timeframes carry more weight because they represent stronger, more
//    reliable trends. A daily bearish trend overrides a 1h bullish signal.
//    Weights: 1d=0.50, 4h=0.30, 1h=0.20
//
// 3. MICROSTRUCTURE AS A GATE
//    If the spread is too wide (not tradeable), we don't just penalize the
//    score — we set tradeable=false so the Decision Engine can hard-reject
//    the trade regardless of how bullish everything else looks.
//
// 4. CONFIDENCE MEASUREMENT
//    We measure how much all timeframes agree. Low agreement = low confidence.
//    A signal with 90% confidence and 0.70 score is far more valuable than
//    a signal with 30% confidence and 0.75 score.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TechnicalSignal {
  score: number;              // 0–1 final technical score
  confidence: number;         // 0–1 how much timeframes agree
  direction: 'bullish' | 'bearish' | 'neutral';

  // Breakdown of what drove the score
  components: {
    momentum: number;         // RSI + MACD de-correlated into one (0–1)
    trend: number;            // Moving average direction (0–1)
    microstructure: number;   // Order book signal (0–1)
    volume: number;           // Volume confirmation (0–1)
    timeframeAlignment: number; // Agreement across timeframes (0–1)
  };

  // Key levels from the order book
  bidSupport: number;
  askResistance: number;

  // Gate: even a perfect score won't trigger a trade if this is false
  tradeable: boolean;
  notTradeableReason?: string;

  // Human-readable explanation for logs and Discord
  reason: string;
  computedAt: Date;
}

// Timeframe weights — higher timeframes have more authority
const TIMEFRAME_WEIGHTS: Record<string, number> = {
  '1d': 0.50,
  '4h': 0.30,
  '1h': 0.20,
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — buildTechnicalSignal
// ─────────────────────────────────────────────────────────────────────────────
export function buildTechnicalSignal(
  suites: IndicatorSuite[],          // One per timeframe (1h, 4h, 1d)
  micro: MicrostructureResult,
): TechnicalSignal {
  if (suites.length === 0) {
    throw new Error('Signal Engine requires at least one indicator suite');
  }

  // ── Gate check: spread too wide ────────────────────────────────────────────
  if (!micro.tradeable) {
    return {
      score: 0.35,
      confidence: 0,
      direction: 'neutral',
      components: { momentum: 0.35, trend: 0.35, microstructure: 0.35, volume: 0.35, timeframeAlignment: 0 },
      bidSupport: micro.bidSupport,
      askResistance: micro.askResistance,
      tradeable: false,
      notTradeableReason: `Spread too wide: ${(micro.spreadPct * 100).toFixed(3)}%`,
      reason: `Not tradeable — spread is ${(micro.spreadPct * 100).toFixed(3)}% (above 0.1% threshold)`,
      computedAt: new Date(),
    };
  }

  // ── Component 1: Momentum (de-correlated RSI + MACD) ─────────────────────
  // RSI and MACD both measure momentum from price data — they are correlated.
  // We combine them as a weighted average rather than treating independently.
  // RSI gets slightly more weight because it's more interpretable at extremes.
  const momentumScore = computeWeightedTimeframeScore(suites, suite =>
    (suite.rsi.normalized * 0.55) + (suite.macd.normalized * 0.45)
  );

  // ── Component 2: Trend (moving averages) ──────────────────────────────────
  const trendScore = computeWeightedTimeframeScore(suites, suite =>
    suite.ma.normalized
  );

  // ── Component 3: Volume confirmation ─────────────────────────────────────
  // Volume is timeframe-independent — use simple average
  const volumeScore = suites.reduce((sum, s) => sum + s.volume.normalized, 0) / suites.length;

  // ── Component 4: Microstructure ───────────────────────────────────────────
  const microScore = micro.normalized;

  // ── Component 5: Timeframe alignment ─────────────────────────────────────
  // How much do the timeframes agree? High agreement = higher confidence.
  const mtf = computeMultiTimeframeScore(suites);
  const timeframeAlignment = mtf.confidence;

  // ── Final score ────────────────────────────────────────────────────────────
  // Weight the components. Momentum and trend are the primary signals.
  // Microstructure and volume are confirmation signals.
  // Note: these are weights WITHIN the technical signal, not the cross-agent weights.
  const rawScore =
    (momentumScore      * 0.35) +
    (trendScore         * 0.30) +
    (microScore         * 0.20) +
    (volumeScore        * 0.15);

  // Confidence adjustment: low timeframe agreement slightly dampens the score
  // toward neutral (0.5). This prevents acting on conflicting signals.
  const confidenceAdjusted = adjustForConfidence(rawScore, timeframeAlignment);
  const finalScore = Math.max(0, Math.min(1, confidenceAdjusted));

  // ── Confidence ────────────────────────────────────────────────────────────
  // Confidence combines timeframe agreement with signal strength
  // (extreme scores = higher confidence than scores near 0.5)
  const signalStrength = Math.abs(finalScore - 0.5) * 2; // 0 = neutral, 1 = extreme
  const confidence = Math.min(1, (timeframeAlignment * 0.6) + (signalStrength * 0.4));

  // ── Direction ─────────────────────────────────────────────────────────────
  const direction: TechnicalSignal['direction'] =
    finalScore >= 0.60 ? 'bullish' :
    finalScore <= 0.40 ? 'bearish' : 'neutral';

  // ── Reason ────────────────────────────────────────────────────────────────
  const reason = buildReason(finalScore, direction, momentumScore, trendScore, microScore, volumeScore, mtf.summary);

  return {
    score:      Math.round(finalScore  * 1000) / 1000,
    confidence: Math.round(confidence  * 1000) / 1000,
    direction,
    components: {
      momentum:           Math.round(momentumScore      * 1000) / 1000,
      trend:              Math.round(trendScore         * 1000) / 1000,
      microstructure:     Math.round(microScore         * 1000) / 1000,
      volume:             Math.round(volumeScore        * 1000) / 1000,
      timeframeAlignment: Math.round(timeframeAlignment * 1000) / 1000,
    },
    bidSupport:    micro.bidSupport,
    askResistance: micro.askResistance,
    tradeable: true,
    reason,
    computedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Compute a weighted average score across timeframes
// Higher timeframes (1d, 4h) get more weight than lower (1h)
function computeWeightedTimeframeScore(
  suites: IndicatorSuite[],
  extractor: (suite: IndicatorSuite) => number,
): number {
  let weightedSum  = 0;
  let totalWeight  = 0;

  for (const suite of suites) {
    const weight = TIMEFRAME_WEIGHTS[suite.timeframe] ?? 0.20;
    weightedSum += extractor(suite) * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
}

// Pull score toward 0.5 when confidence is low, but don't over-dampen.
// Previously this killed strong signals — now only pulls when truly uncertain.
function adjustForConfidence(score: number, confidence: number): number {
  const neutral     = 0.5;
  const blendFactor = Math.max(0, 1 - (1 - confidence) * 0.15); // Max 15% pull toward neutral
  return neutral + (score - neutral) * blendFactor;
}

function buildReason(
  score: number,
  direction: string,
  momentum: number,
  trend: number,
  micro: number,
  volume: number,
  mtfSummary: string,
): string {
  const parts = [
    `Technical signal: ${direction} (score: ${score.toFixed(3)})`,
    `Momentum: ${momentum.toFixed(3)} | Trend: ${trend.toFixed(3)} | Microstructure: ${micro.toFixed(3)} | Volume: ${volume.toFixed(3)}`,
    `Timeframes: ${mtfSummary}`,
  ];
  return parts.join('\n  ');
}
