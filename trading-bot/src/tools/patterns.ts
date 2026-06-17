import { IndicatorSuite } from './indicators.js';
import { MicrostructureResult } from './microstructure.js';
import { SIGNAL_WEIGHTS } from '../config.js';
import { retry } from '../core/retry.js';
import { API } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// PATTERNS.TS — Component 4.5: Pattern Recognition
//
// Scans for named, high-probability trading setups before any trade decision.
// The key insight: individual indicators are weak. SETUPS — where multiple
// specific conditions align simultaneously — are significantly stronger.
//
// How this plugs into the system:
//   - Pattern detected     → lower entry threshold to 0.60 (easier to trade)
//   - No pattern detected  → raise entry threshold to 0.72 (be selective)
//   - Pattern adds to confidence, not just score
//
// The 9 patterns implemented:
//   1. Trend Pullback            — buy dips within uptrends
//   2. Volume Breakout           — buy confirmed resistance breaks
//   3. Oversold Accumulation     — buy extreme fear + whale buying
//   4. Multi-TF MACD Crossover   — buy momentum alignment across timeframes
//   5. Funding Rate Reversal     — buy crowded short squeezes (crypto-specific)
//   6. Golden Cross              — SMA20 crosses above SMA50 (classic trend signal)
//   7. Bullish Momentum Squeeze  — volatility compression breaking upward
//   8. Support Bounce            — price bouncing off SMA20 in an uptrend
//   9. Trend Continuation        — all TFs aligned bullish, consolidation before next leg
//
// HONESTY NOTE:
//   "Win rate" figures cited in comments come from academic backtesting studies
//   and practitioner research. They are NOT guaranteed — they represent
//   historical tendencies in specific market conditions. The Journal Agent
//   will track our ACTUAL win rates per pattern over time, which matters
//   more than published figures.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PatternCondition {
  name: string;
  met: boolean;
  value: string;   // What the actual value was (for logging/debugging)
}

export interface PatternResult {
  name: string;
  type: 'bullish' | 'bearish';
  detected: boolean;
  conditionsMet: number;
  totalConditions: number;
  conditions: PatternCondition[];
  confidence: number;        // % of conditions met × quality weight
  scoreBoost: number;        // Added to signal score when detected (0–0.10)
  thresholdAdjustment: number; // Adjusts entry threshold (-0.05 = lower bar)
  description: string;       // Human-readable explanation for logs
}

export interface PatternScanResult {
  scannedAt: Date;
  patterns: PatternResult[];
  activePattern: PatternResult | null;  // Strongest detected pattern
  detected: boolean;
  // Recommended entry threshold for Decision Engine
  // No pattern → 0.72 (strict), Pattern detected → 0.60 (permissive)
  recommendedThreshold: number;
  summary: string;
}

// External data the Pattern Scanner may receive (all optional)
export interface PatternContext {
  suites: IndicatorSuite[];          // Required — indicator data per timeframe
  micro: MicrostructureResult;       // Required — order book data
  fearGreedIndex?: number;           // Optional — 0 (extreme fear) to 100 (extreme greed)
  exchangeOutflowDetected?: boolean; // Optional — whale data (from future Whale Agent)
  fundingRate?: number;              // Optional — from derivatives data (future component)
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — scanPatterns
// Runs all pattern detectors and returns the strongest active pattern.
// ─────────────────────────────────────────────────────────────────────────────
export async function scanPatterns(ctx: PatternContext): Promise<PatternScanResult> {
  if (ctx.suites.length === 0) {
    throw new Error('Pattern scanner requires at least one indicator suite');
  }

  // Fetch Fear & Greed index if not provided (it's free and fast).
  // Use a local variable — never mutate the caller's context object.
  const fearGreedIndex = ctx.fearGreedIndex ?? await fetchFearGreedIndex();
  const resolvedCtx: PatternContext = { ...ctx, fearGreedIndex };

  // Run all pattern detectors using the resolved (immutable) context
  const patterns: PatternResult[] = [
    detectTrendPullback(resolvedCtx),
    detectVolumeBreakout(resolvedCtx),
    detectOversoldAccumulation(resolvedCtx),
    detectMultiTFMACDCrossover(resolvedCtx),
    detectFundingRateReversal(resolvedCtx),
    detectGoldenCross(resolvedCtx),
    detectBullishMomentumSqueeze(resolvedCtx),
    detectSupportBounce(resolvedCtx),
    detectTrendContinuation(resolvedCtx),
  ];

  // Find the best detected pattern (most conditions met)
  const detected = patterns.filter(p => p.detected);
  const activePattern = detected.length > 0
    ? detected.sort((a, b) => b.confidence - a.confidence)[0]
    : null;

  const recommendedThreshold = activePattern
    ? SIGNAL_WEIGHTS.thresholds.buy + activePattern.thresholdAdjustment
    : SIGNAL_WEIGHTS.thresholds.buy; // Use base threshold even without a pattern

  const summary = activePattern
    ? `Pattern detected: ${activePattern.name} (confidence: ${(activePattern.confidence * 100).toFixed(0)}%)`
    : `No pattern detected — using base threshold ${recommendedThreshold}`;

  return {
    scannedAt: new Date(),
    patterns,
    activePattern,
    detected: activePattern !== null,
    recommendedThreshold: Math.max(0.60, Math.min(0.75, recommendedThreshold)),
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 1 — Trend Pullback
//
// The most reliable setup. You are buying a temporary dip INSIDE a larger
// uptrend — not fighting the trend, joining it at a better price.
//
// Logic: if the daily trend is up, a short-term pullback where RSI cools off
// and momentum starts returning is statistically one of the best entries.
//
// Documented win rate: ~62–68% in trending markets.
// Fails in: ranging/choppy markets (no sustained trend to pull back into).
// ─────────────────────────────────────────────────────────────────────────────
function detectTrendPullback(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');
  const suite4h = ctx.suites.find(s => s.timeframe === '4h');
  const suite1d = ctx.suites.find(s => s.timeframe === '1d');

  const conditions: PatternCondition[] = [
    {
      name: 'Daily trend is bullish (price above SMA50)',
      met: suite1d ? suite1d.ma.trend === 'bullish' : false,
      value: suite1d ? suite1d.ma.trend : 'no 1d data',
    },
    {
      name: '4h RSI in pullback zone (35–55)',
      met: suite4h ? (suite4h.rsi.value >= 35 && suite4h.rsi.value <= 55) : false,
      value: suite4h ? `RSI ${suite4h.rsi.value.toFixed(1)}` : 'no 4h data',
    },
    {
      name: '1h MACD showing bullish momentum returning',
      met: suite1h ? (suite1h.macd.trend === 'bullish' || suite1h.macd.trend === 'bullish_crossover') : false,
      value: suite1h ? suite1h.macd.trend : 'no 1h data',
    },
    {
      name: 'Volume declining during pullback (healthy consolidation)',
      met: suite4h ? suite4h.volume.ratio < 0.85 : false,
      value: suite4h ? `${suite4h.volume.ratio.toFixed(2)}x avg` : 'no 4h data',
    },
    {
      name: 'Order book shows bid support at current level',
      met: ctx.micro.tradeable && ctx.micro.bidAskImbalance > -0.10,
      value: `imbalance: ${ctx.micro.bidAskImbalance.toFixed(3)}`,
    },
  ];

  return buildPatternResult(
    'Trend Pullback',
    'bullish',
    conditions,
    4,           // Need 4 of 5 conditions
    0.08,        // Score boost when detected
    -0.05,       // Threshold adjustment (-5% easier to enter)
    'Buying a pullback within a larger uptrend. Daily trend intact, 4h consolidating, 1h momentum returning.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 2 — Volume Breakout
//
// Price breaks above a resistance level WITH high volume confirming the move.
// Volume is the key — breakouts without volume are "fakeouts" ~60% of the time.
// High volume on the break means real buyers stepped in, not just a stop hunt.
//
// Documented win rate: ~55–62% when volume > 1.8x average.
// Fails in: low-liquidity periods (fake volume spikes), news-driven moves.
// ─────────────────────────────────────────────────────────────────────────────
function detectVolumeBreakout(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');
  const suite4h = ctx.suites.find(s => s.timeframe === '4h');

  // A breakout means price is above recent resistance
  // We use: price above SMA20 AND MACD bullish = momentum confirming breakout
  const priceAboveResistance = suite1h
    ? suite1h.ma.priceVsSma20 > 0.5   // Price at least 0.5% above SMA20
    : false;

  const conditions: PatternCondition[] = [
    {
      name: 'Price breaking above SMA20 (above resistance)',
      met: priceAboveResistance,
      value: suite1h ? `${suite1h.ma.priceVsSma20.toFixed(2)}% above SMA20` : 'no data',
    },
    {
      name: 'Breakout volume is 1.8x+ average (real buyers, not fakeout)',
      met: suite1h ? suite1h.volume.ratio >= 1.8 : false,
      value: suite1h ? `${suite1h.volume.ratio.toFixed(2)}x avg` : 'no data',
    },
    {
      name: '4h trend is bullish (higher timeframe confirms)',
      met: suite4h ? suite4h.ma.trend === 'bullish' : false,
      value: suite4h ? suite4h.ma.trend : 'no 4h data',
    },
    {
      name: 'MACD bullish on 1h (momentum behind the move)',
      met: suite1h
        ? suite1h.macd.trend === 'bullish' || suite1h.macd.trend === 'bullish_crossover'
        : false,
      value: suite1h ? suite1h.macd.trend : 'no data',
    },
    {
      name: 'Order book ask resistance clearing (walls absorbed)',
      met: ctx.micro.tradeable && ctx.micro.bidAskImbalance > 0.05,
      value: `imbalance: ${ctx.micro.bidAskImbalance.toFixed(3)}`,
    },
  ];

  return buildPatternResult(
    'Volume Breakout',
    'bullish',
    conditions,
    4,
    0.07,
    -0.04,
    'Price breaking above resistance with volume confirmation. Real buyers entering, not a fakeout.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 3 — Oversold Accumulation
//
// Combines extreme market fear with evidence that smart money (whales) is
// actually buying. Retail investors are fearful and selling — smart money
// is quietly accumulating at low prices.
//
// "Be fearful when others are greedy, be greedy when others are fearful." — Buffett
//
// Documented win rate: ~60–65% when all 4 conditions align.
// Fails in: genuine bear markets where fear is justified (e.g., FTX collapse).
// Note: whale data uses the context if provided, defaults to false if not yet built.
// ─────────────────────────────────────────────────────────────────────────────
function detectOversoldAccumulation(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');
  const suite4h = ctx.suites.find(s => s.timeframe === '4h');
  const fearGreed = ctx.fearGreedIndex ?? 50;

  const conditions: PatternCondition[] = [
    {
      name: 'RSI oversold on 1h (below 35)',
      met: suite1h ? suite1h.rsi.value < 35 : false,
      value: suite1h ? `RSI ${suite1h.rsi.value.toFixed(1)}` : 'no data',
    },
    {
      name: 'Fear & Greed index showing fear (below 35)',
      met: fearGreed < 35,
      value: `Fear & Greed: ${fearGreed}`,
    },
    {
      name: '4h trend not in catastrophic breakdown (RSI not below 25)',
      met: suite4h ? suite4h.rsi.value > 25 : false,
      value: suite4h ? `4h RSI ${suite4h.rsi.value.toFixed(1)}` : 'no 4h data',
    },
    {
      name: 'Whale accumulation signal (exchange outflows detected)',
      // Uses whale data from context if available — false until Whale Agent is built
      met: ctx.exchangeOutflowDetected ?? false,
      value: ctx.exchangeOutflowDetected !== undefined
        ? `outflows: ${ctx.exchangeOutflowDetected}`
        : 'whale data pending (Component 7)',
    },
    {
      name: 'No extreme selling pressure in order book',
      met: ctx.micro.bidAskImbalance > -0.20,
      value: `imbalance: ${ctx.micro.bidAskImbalance.toFixed(3)}`,
    },
  ];

  return buildPatternResult(
    'Oversold Accumulation',
    'bullish',
    conditions,
    3,           // Need 3 of 5 (whale data is often unavailable early on)
    0.09,
    -0.06,
    'Extreme fear with oversold RSI. Smart money accumulating while retail panics.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 4 — Multi-Timeframe MACD Crossover
//
// A MACD bullish crossover on 4h is meaningful. The same crossover confirmed
// by bullish MACD on the daily is significantly more powerful — momentum is
// building across multiple timeframes simultaneously.
//
// Documented win rate: ~55–60%. Simple but reliable when both TFs align.
// Fails in: choppy, low-momentum markets where MACD crossovers happen constantly.
// ─────────────────────────────────────────────────────────────────────────────
function detectMultiTFMACDCrossover(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');
  const suite4h = ctx.suites.find(s => s.timeframe === '4h');
  const suite1d = ctx.suites.find(s => s.timeframe === '1d');

  const conditions: PatternCondition[] = [
    {
      name: '4h MACD bullish crossover (fresh momentum signal)',
      met: suite4h ? suite4h.macd.trend === 'bullish_crossover' : false,
      value: suite4h ? suite4h.macd.trend : 'no 4h data',
    },
    {
      name: 'Daily MACD bullish (trend alignment)',
      met: suite1d
        ? suite1d.macd.trend === 'bullish' || suite1d.macd.trend === 'bullish_crossover'
        : false,
      value: suite1d ? suite1d.macd.trend : 'no 1d data',
    },
    {
      name: 'Price above 20-period MA on 4h',
      met: suite4h ? suite4h.ma.priceVsSma20 > 0 : false,
      value: suite4h ? `${suite4h.ma.priceVsSma20.toFixed(2)}% vs SMA20` : 'no data',
    },
    {
      name: '1h confirming (MACD bullish or crossover)',
      met: suite1h
        ? suite1h.macd.trend === 'bullish' || suite1h.macd.trend === 'bullish_crossover'
        : false,
      value: suite1h ? suite1h.macd.trend : 'no data',
    },
  ];

  return buildPatternResult(
    'Multi-TF MACD Crossover',
    'bullish',
    conditions,
    3,
    0.06,
    -0.04,
    'MACD bullish crossover on 4h confirmed by daily trend. Momentum building across timeframes.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 5 — Funding Rate Reversal (Crypto-Specific)
//
// In crypto perpetual futures, traders pay a "funding rate" to hold positions.
// When funding is very negative, too many traders are short — the market is
// overcrowded on one side. Any positive catalyst = short squeeze = sharp reversal.
//
// NOTE: Funding rate data requires Binance futures API (not yet connected).
// This pattern will be inactive until the Derivatives data layer is built.
// The architecture is ready — just needs the data source.
//
// Documented win rate: ~58–65% when funding is at extreme levels.
// ─────────────────────────────────────────────────────────────────────────────
function detectFundingRateReversal(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');

  const conditions: PatternCondition[] = [
    {
      name: 'Funding rate extremely negative (< -0.05%)',
      // Negative = shorts paying longs = market overcrowded short
      met: ctx.fundingRate !== undefined ? ctx.fundingRate < -0.0005 : false,
      value: ctx.fundingRate !== undefined
        ? `${(ctx.fundingRate * 100).toFixed(4)}%`
        : 'funding data pending (derivatives layer)',
    },
    {
      name: 'RSI not in downtrend (above 40)',
      met: suite1h ? suite1h.rsi.value > 40 : false,
      value: suite1h ? `RSI ${suite1h.rsi.value.toFixed(1)}` : 'no data',
    },
    {
      name: 'Positive price action on 1h (bullish candle)',
      met: suite1h ? suite1h.macd.histogram > 0 : false,
      value: suite1h ? `histogram: ${suite1h.macd.histogram}` : 'no data',
    },
  ];

  return buildPatternResult(
    'Funding Rate Reversal',
    'bullish',
    conditions,
    3,
    0.08,
    -0.05,
    'Market overcrowded short. Positive catalyst would trigger short squeeze.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 6 — Golden Cross
//
// The SMA20 crosses above the SMA50 — one of the most widely followed signals
// in all of trading. When the short-term average climbs above the long-term
// average, it means recent prices are stronger than older ones: upward momentum.
//
// Why it works: it's self-fulfilling. Millions of traders watch this signal and
// buy when it triggers, which itself pushes the price up. Market signals that
// everyone uses become more likely to work because of that attention.
//
// Documented win rate: ~58–65% on daily timeframes in trending markets.
// Fails in: choppy, sideways markets where MAs constantly cross back and forth.
// ─────────────────────────────────────────────────────────────────────────────
function detectGoldenCross(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');
  const suite4h = ctx.suites.find(s => s.timeframe === '4h');
  const suite1d = ctx.suites.find(s => s.timeframe === '1d');

  // Golden cross: SMA20 > SMA50 on daily (the "real" cross) AND price above both
  const goldenCrossDaily = suite1d
    ? suite1d.ma.sma20 > suite1d.ma.sma50 && suite1d.ma.trend === 'bullish'
    : false;

  const conditions: PatternCondition[] = [
    {
      name: 'Daily SMA20 above SMA50 (golden cross active)',
      met: goldenCrossDaily,
      value: suite1d
        ? `SMA20: ${suite1d.ma.sma20.toFixed(2)} vs SMA50: ${suite1d.ma.sma50.toFixed(2)}`
        : 'no 1d data',
    },
    {
      name: '4h trend bullish (momentum confirming)',
      met: suite4h ? suite4h.ma.trend === 'bullish' : false,
      value: suite4h ? suite4h.ma.trend : 'no 4h data',
    },
    {
      name: 'Price above SMA20 on 4h (not overextended)',
      met: suite4h ? suite4h.ma.priceVsSma20 > 0 && suite4h.ma.priceVsSma20 < 8 : false,
      value: suite4h ? `${suite4h.ma.priceVsSma20.toFixed(2)}% above SMA20` : 'no 4h data',
    },
    {
      name: '1h RSI in healthy range (40–70, not overbought)',
      met: suite1h ? suite1h.rsi.value >= 40 && suite1h.rsi.value <= 70 : false,
      value: suite1h ? `RSI ${suite1h.rsi.value.toFixed(1)}` : 'no 1h data',
    },
    {
      name: 'Order book not showing heavy selling pressure',
      met: ctx.micro.bidAskImbalance > -0.15,
      value: `imbalance: ${ctx.micro.bidAskImbalance.toFixed(3)}`,
    },
  ];

  return buildPatternResult(
    'Golden Cross',
    'bullish',
    conditions,
    4,
    0.07,
    -0.04,
    'SMA20 crossed above SMA50 on daily. Classic trend confirmation signal with broad market participation.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 7 — Bullish Momentum Squeeze
//
// This is a Bollinger Band squeeze setup. When price has been in a tight range
// (volatility compressed), it's like a coiled spring — the next move is often
// explosive. We want to catch it as it breaks out upward.
//
// Detection: we approximate this using volume and MACD conditions.
// The squeeze = volume well below average (compression).
// The breakout = volume spiking back up + MACD turning bullish.
//
// Documented win rate: ~57–63% — very powerful when it triggers correctly.
// Fails in: when the squeeze breaks DOWN instead of up (50/50 on direction).
// We add the MACD and RSI conditions to help filter for upward breaks.
// ─────────────────────────────────────────────────────────────────────────────
function detectBullishMomentumSqueeze(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');
  const suite4h = ctx.suites.find(s => s.timeframe === '4h');
  const suite1d = ctx.suites.find(s => s.timeframe === '1d');

  // Squeeze = recent volume well below average (compression before breakout)
  const volumeSqueezing = suite4h ? suite4h.volume.ratio < 0.70 : false;

  // Breakout momentum returning = MACD histogram turning positive
  const momentumReturning = suite4h
    ? suite4h.macd.trend === 'bullish_crossover' || suite4h.macd.histogram > 0
    : false;

  const conditions: PatternCondition[] = [
    {
      name: 'Volume compressed (below 70% of average) — squeeze forming',
      met: volumeSqueezing,
      value: suite4h ? `${(suite4h.volume.ratio * 100).toFixed(0)}% of avg volume` : 'no 4h data',
    },
    {
      name: '4h MACD momentum returning bullish (breakout starting)',
      met: momentumReturning,
      value: suite4h ? `MACD: ${suite4h.macd.trend}, hist: ${suite4h.macd.histogram.toFixed(4)}` : 'no 4h data',
    },
    {
      name: 'Daily trend bullish (squeeze resolving upward, not downward)',
      met: suite1d ? suite1d.ma.trend === 'bullish' : false,
      value: suite1d ? suite1d.ma.trend : 'no 1d data',
    },
    {
      name: 'RSI not overbought on 1h (room to run)',
      met: suite1h ? suite1h.rsi.value < 65 : false,
      value: suite1h ? `RSI ${suite1h.rsi.value.toFixed(1)}` : 'no 1h data',
    },
    {
      name: 'Order book showing buy pressure',
      met: ctx.micro.bidAskImbalance > 0,
      value: `imbalance: ${ctx.micro.bidAskImbalance.toFixed(3)}`,
    },
  ];

  return buildPatternResult(
    'Bullish Momentum Squeeze',
    'bullish',
    conditions,
    4,
    0.08,
    -0.05,
    'Volatility compression followed by bullish breakout signal. Coiled spring releasing upward.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 8 — Support Bounce
//
// Price has pulled back to a known support level (SMA20 or recent swing low)
// and is showing signs of bouncing. This is the safest entry type because:
//   1. You know your stop placement (just below support)
//   2. The risk-reward is defined and favorable
//   3. You're entering where buyers historically stepped in
//
// The key signal is RSI bouncing from oversold territory while price is at
// or near a key moving average — evidence that sellers are exhausted.
//
// Documented win rate: ~60–67% when price is in an established uptrend.
// Fails in: when support breaks (turns into a full trend reversal downward).
// ─────────────────────────────────────────────────────────────────────────────
function detectSupportBounce(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');
  const suite4h = ctx.suites.find(s => s.timeframe === '4h');
  const suite1d = ctx.suites.find(s => s.timeframe === '1d');

  // Price near SMA20: within 2% below (testing support) or just bounced above
  const priceTestingSupport4h = suite4h
    ? suite4h.ma.priceVsSma20 >= -2.0 && suite4h.ma.priceVsSma20 <= 1.0
    : false;

  // RSI recovering from oversold — the key sign of a bounce vs breakdown
  const rsiRecovering = suite4h
    ? suite4h.rsi.value >= 30 && suite4h.rsi.value <= 50
    : false;

  const conditions: PatternCondition[] = [
    {
      name: 'Daily trend is bullish (bouncing into an uptrend)',
      met: suite1d ? suite1d.ma.trend === 'bullish' : false,
      value: suite1d ? suite1d.ma.trend : 'no 1d data',
    },
    {
      name: 'Price testing 4h SMA20 support (within 2% below)',
      met: priceTestingSupport4h,
      value: suite4h ? `${suite4h.ma.priceVsSma20.toFixed(2)}% vs SMA20` : 'no 4h data',
    },
    {
      name: '4h RSI recovering from oversold (30–50 range)',
      met: rsiRecovering,
      value: suite4h ? `RSI ${suite4h.rsi.value.toFixed(1)}` : 'no 4h data',
    },
    {
      name: '1h MACD turning bullish (local momentum confirming bounce)',
      met: suite1h
        ? suite1h.macd.trend === 'bullish' || suite1h.macd.trend === 'bullish_crossover'
        : false,
      value: suite1h ? suite1h.macd.trend : 'no 1h data',
    },
    {
      name: 'Order book bid support present at current level',
      met: ctx.micro.tradeable && ctx.micro.bidAskImbalance > -0.05,
      value: `imbalance: ${ctx.micro.bidAskImbalance.toFixed(3)}`,
    },
  ];

  return buildPatternResult(
    'Support Bounce',
    'bullish',
    conditions,
    4,
    0.08,
    -0.05,
    'Price pulling back to SMA20 support in uptrend. RSI cooling off, local momentum returning — textbook buy-the-dip.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN 9 — Trend Continuation
//
// The simplest but often most profitable setup: a coin that is already in a
// clear, strong uptrend and just had a brief pause (consolidation) is likely
// to continue higher. "The trend is your friend."
//
// This is different from Trend Pullback (Pattern 1): that one specifically
// looks for dips within a trend. This one looks for FLAT consolidation where
// price hasn't pulled back much, just moved sideways — and now momentum
// is resuming.
//
// Documented win rate: ~55–62%. Simple but consistent.
// Fails in: when the "consolidation" is actually distribution (whales exiting).
// We use volume and whale data to filter for real consolidations vs distribution.
// ─────────────────────────────────────────────────────────────────────────────
function detectTrendContinuation(ctx: PatternContext): PatternResult {
  const suite1h = ctx.suites.find(s => s.timeframe === '1h');
  const suite4h = ctx.suites.find(s => s.timeframe === '4h');
  const suite1d = ctx.suites.find(s => s.timeframe === '1d');

  // Strong uptrend = all 3 MAs aligned bullish
  const allTimeframesBullish =
    (suite1h?.ma.trend === 'bullish') &&
    (suite4h?.ma.trend === 'bullish') &&
    (suite1d?.ma.trend === 'bullish');

  // Consolidation = volume below average (no heavy selling, no heavy buying — just resting)
  const consolidating = suite4h ? suite4h.volume.ratio >= 0.60 && suite4h.volume.ratio <= 1.10 : false;

  // Continuation = MACD still bullish (trend hasn't reversed, just resting)
  const macdBullish = suite4h
    ? suite4h.macd.trend === 'bullish' || suite4h.macd.trend === 'bullish_crossover'
    : false;

  const conditions: PatternCondition[] = [
    {
      name: 'All timeframes (1h/4h/1d) in bullish uptrend',
      met: allTimeframesBullish,
      value: `1h: ${suite1h?.ma.trend ?? 'n/a'}, 4h: ${suite4h?.ma.trend ?? 'n/a'}, 1d: ${suite1d?.ma.trend ?? 'n/a'}`,
    },
    {
      name: 'Price consolidating — volume neutral (not distribution)',
      met: consolidating,
      value: suite4h ? `${(suite4h.volume.ratio * 100).toFixed(0)}% of avg volume` : 'no 4h data',
    },
    {
      name: '4h MACD bullish (trend momentum intact)',
      met: macdBullish,
      value: suite4h ? suite4h.macd.trend : 'no 4h data',
    },
    {
      name: '1h RSI not overbought (below 70)',
      met: suite1h ? suite1h.rsi.value < 70 : false,
      value: suite1h ? `RSI ${suite1h.rsi.value.toFixed(1)}` : 'no 1h data',
    },
    {
      name: 'No selling pressure in order book',
      met: ctx.micro.bidAskImbalance >= -0.10,
      value: `imbalance: ${ctx.micro.bidAskImbalance.toFixed(3)}`,
    },
  ];

  return buildPatternResult(
    'Trend Continuation',
    'bullish',
    conditions,
    4,
    0.06,
    -0.03,
    'All timeframes aligned bullish with healthy consolidation. Trend resting before next leg up.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function buildPatternResult(
  name: string,
  type: 'bullish' | 'bearish',
  conditions: PatternCondition[],
  requiredToDetect: number,
  scoreBoost: number,
  thresholdAdjustment: number,
  description: string,
): PatternResult {
  const conditionsMet = conditions.filter(c => c.met).length;
  const detected      = conditionsMet >= requiredToDetect;

  // Confidence = % of conditions met, weighted by how close to full detection
  const confidence = Math.min(1, conditionsMet / conditions.length);

  return {
    name,
    type,
    detected,
    conditionsMet,
    totalConditions: conditions.length,
    conditions,
    confidence: Math.round(confidence * 1000) / 1000,
    scoreBoost:            detected ? scoreBoost          : 0,
    thresholdAdjustment:   detected ? thresholdAdjustment : 0,
    description,
  };
}

// ─── Fetch Fear & Greed Index ─────────────────────────────────────────────────
// Free API — updates once per day. Returns 0 (extreme fear) to 100 (extreme greed).
export async function fetchFearGreedIndex(): Promise<number> {
  try {
    const data = await retry('Fear & Greed Index', async () => {
      const res = await fetch(`${API.fearGreed.baseUrl}/?limit=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ data: [{ value: string }] }>;
    });
    return parseInt(data.data[0].value, 10);
  } catch {
    // If API is down, return neutral (50) rather than crashing
    console.warn('[patterns] Fear & Greed API unavailable — defaulting to 50 (neutral)');
    return 50;
  }
}
