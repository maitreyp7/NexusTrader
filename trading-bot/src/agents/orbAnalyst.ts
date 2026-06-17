import { log }                               from '../core/logger.js';
import { SCHEDULE, ORB, SIGNAL_WEIGHTS, RISK, QUANT, FADE } from '../config.js';
import { askGroqSafe }                         from './groqClient.js';
import { analyzeMacro, MacroResult }           from './macro.js';
import { analyzeSentiment, SentimentResult }   from './sentiment.js';
import { analyzeWhaleActivity, WhaleResult }   from './whale.js';
import { getEquityBars, getOrderBook }         from '../tools/marketData.js';
import type { Candle }                         from '../tools/marketData.js';
import { getStreamedBars, isStreamReady }     from '../tools/barStream.js';
import { computeEMAValues, computeRVOL, computeMACD } from '../tools/indicators.js';
import { analyzeMicrostructure }              from '../tools/microstructure.js';
import { computeIndicators }                  from '../tools/indicators.js';
import {
  buildOpeningRange,
  detectBreakout,
  detectFade,
  configureFade,
  detectVwapReclaim,
  detectVwapBounce,
  detectVwapRejectionShort,
  detectMeanReversion,
  detectShortMeanReversion,
  detectMomentumContinuation,
  computeRelativeStrength,
  validateRange,
  isRangeTooTight,
  OpeningRange,
  BreakoutSignal,
} from '../strategy/openingRange.js';

// Push FADE config into the strategy module once at import time.
// The strategy module keeps its detector pure (no config import); we feed it from here.
configureFade({
  maxCandlesAfterBreakout: FADE.maxCandlesAfterBreakout,
  reclaimVolumeMultiplier: FADE.reclaimVolumeMultiplier,
  stopBufferPct:           FADE.stopBufferPct,
  maxOvershootPct:         FADE.maxOvershootPct,
  targetMode:              FADE.targetMode,
});
import type { RiskAssessment, PortfolioState } from '../core/riskManager.js';
import type { PreMarketAnalysis }              from './preMarketFilter.js';

// ─────────────────────────────────────────────────────────────────────────────
// ORB ANALYST — The ORB-Specific Analysis Orchestrator
//
// This is called every 10 seconds during the trading window (9:45–10:15).
// It coordinates all agents and manages the state for a single symbol's
// ORB cycle for the day.
//
// STATE MACHINE (per symbol, per day):
//
//   BUILDING_RANGE  (9:30–9:44)
//     Collecting 1-minute candles. Not making decisions yet.
//     Range high/low updates every tick.
//
//   WAITING_BREAKOUT  (9:45–10:15)
//     Range is locked. Watching for a close above ORH or below ORL.
//     On confirmed breakout: run all agents, compute final score, decide.
//
//   ENTERED  (after a trade is placed)
//     Position is open. No new entries for this symbol today.
//     Position manager handles stop/target from here.
//
//   CLOSED  (after position exits)
//     Session over for this symbol. Nothing more to do.
//
//   SKIPPED  (if range invalid, VIX block, or missed entry window)
//     No trade today for this symbol.
// ─────────────────────────────────────────────────────────────────────────────

export type OrbPhase = 'BUILDING_RANGE' | 'WAITING_BREAKOUT' | 'ENTERED' | 'CLOSED' | 'SKIPPED';

export interface OrbCycle {
  symbol:         string;
  phase:          OrbPhase;
  range:          OpeningRange | null;
  breakout:       BreakoutSignal | null;
  riskResult:     RiskAssessment | null;
  narrative:      string;
  macroScore:     number;
  sentimentScore: number;
  whaleScore:     number;
  orbScore:       number;           // 0–1: raw ORB signal strength
  finalScore:     number;           // 0–1: weighted combination of all signals
  shouldEnter:    boolean;          // true = place the buy order
  cycleMs:        number;           // How long this cycle took to run
  analyzedAt:     Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Extract hour and minute directly in ET using Intl.DateTimeFormat.
// Never use new Date(toLocaleString()) — that round-trip is unreliable and
// interprets the locale string as local time, not ET, causing hour drift.
function getEtHourMinute(): { hour: number; minute: number } {
  const now  = new Date();
  const fmt  = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour:     'numeric',
    minute:   'numeric',
    hour12:   false,
  });
  const parts = fmt.formatToParts(now);
  const hour   = parseInt(parts.find(p => p.type === 'hour')!.value,   10);
  const minute = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  return { hour, minute };
}

// Returns UTC ms for 9:30 AM ET today — works in both EST (UTC-5) and EDT (UTC-4).
function getEtSessionStart(): number {
  const now    = new Date();
  const offset = isDaylightSavingTime(now) ? '-04:00' : '-05:00';
  const fmt    = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const month = parts.find(p => p.type === 'month')!.value;
  const day   = parts.find(p => p.type === 'day')!.value;
  const year  = parts.find(p => p.type === 'year')!.value;
  return new Date(`${year}-${month}-${day}T09:30:00${offset}`).getTime();
}

function isDaylightSavingTime(date: Date): boolean {
  // Compare Jan (always standard) vs Jul (always daylight) offsets.
  // If today's offset equals the smaller of the two, we're in DST.
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

function isInBuildingRange(): boolean {
  const { hour, minute } = getEtHourMinute();
  // 9:30–9:44 ET
  return hour === 9 && minute >= 30 && minute < 45;
}

function isInTradingWindow(): boolean {
  const { hour, minute } = getEtHourMinute();
  // 9:45–10:15 ET
  if (hour === 9  && minute >= 45) return true;
  if (hour === 10 && minute < 15)  return true;
  return false;
}

// Skip the first 2 minutes of the ORB entry window (9:45–9:46).
// Fakeouts are most common right at open — institutions test levels before committing.
function isInOrbFakeoutZone(): boolean {
  const { hour, minute } = getEtHourMinute();
  return hour === 9 && minute >= 45 && minute < 47;
}

function isInManagingWindow(): boolean {
  const { hour, minute } = getEtHourMinute();
  // 10:15–10:30 ET
  return hour === 10 && minute >= 15 && minute < 30;
}

// Returns the minimum confidence required to enter a trade for this symbol.
// Symbols with weak backtest results have a higher bar via symbolConfidenceOverrides.
function minConfidence(symbol: string): number {
  return RISK.symbolConfidenceOverrides[symbol] ?? RISK.minConfidenceToTrade;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — runOrbCycle
//
// Called every 10 seconds by the session orchestrator (index.ts).
// Returns an OrbCycle that describes what the bot decided and why.
//
// The orchestrator uses cycle.shouldEnter to decide whether to place an order.
// ─────────────────────────────────────────────────────────────────────────────
export async function runOrbCycle(
  symbol:      string,
  portfolio:   PortfolioState,
  currentRange: OpeningRange | null,    // The range built so far (null = not started)
  preMarket:   PreMarketAnalysis | null, // This morning's pre-market analysis
  window:      'ORB' | 'MIDDAY' | 'POWER_HOUR' = 'ORB',
): Promise<OrbCycle> {
  const startMs = Date.now();

  const noCycle = (phase: OrbPhase, narrative: string): OrbCycle => ({
    symbol, phase,
    range:          currentRange,
    breakout:       null,
    riskResult:     null,
    narrative,
    macroScore:     0,
    sentimentScore: 0,
    whaleScore:     0,
    orbScore:       0,
    finalScore:     0,
    shouldEnter:    false,
    cycleMs:        Date.now() - startMs,
    analyzedAt:     new Date(),
  });

  // ── Phase: BUILDING_RANGE (9:30–9:44) ────────────────────────────────────
  if (window === 'ORB' && isInBuildingRange()) {
    // During range building, we just update the range — no analysis yet
    try {
      const candles1m = getStreamedBars(symbol, 30) ?? await getEquityBars(symbol, '1m', 30);

      // Only use candles from today's session (9:30 onwards ET).
      // Compare UTC timestamps directly — candle openTime is UTC from Alpaca.
      // 9:30 AM ET = 13:30 UTC (EST) or 14:30 UTC (EDT). Use getEtHourMinute
      // on the candle time to avoid locale string round-trip bugs.
      const rangeStart = getEtSessionStart(); // UTC ms for 9:30 AM ET today

      const rangeCandles = candles1m.filter(c => c.openTime.getTime() >= rangeStart);

      if (rangeCandles.length === 0) {
        return noCycle('BUILDING_RANGE', `Building opening range for ${symbol} — no candles yet`);
      }

      const priorCandles = candles1m.filter(c => c.openTime.getTime() < rangeStart).slice(-10);

      const range = buildOpeningRange(symbol, rangeCandles, priorCandles);

      return {
        symbol,
        phase:          'BUILDING_RANGE',
        range,
        breakout:       null,
        riskResult:     null,
        narrative:      `Building opening range: $${range.low.toFixed(2)}–$${range.high.toFixed(2)} (${rangeCandles.length} candles)`,
        macroScore:     0,
        sentimentScore: 0,
        whaleScore:     0,
        orbScore:       0,
        finalScore:     0,
        shouldEnter:    false,
        cycleMs:        Date.now() - startMs,
        analyzedAt:     new Date(),
      };

    } catch (err) {
      return noCycle('BUILDING_RANGE', `Range build error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Phase: WAITING_BREAKOUT (9:45–10:15 for ORB; full window for MIDDAY/POWER) ──
  if (window !== 'ORB' || isInTradingWindow()) {
    // If we don't have a range yet, can't trade
    if (!currentRange) {
      return noCycle('SKIPPED', `No opening range built for ${symbol} — skipping`);
    }

    // Validate the range before using it
    const validation = validateRange(currentRange);
    if (!validation.valid) {
      return noCycle('SKIPPED', `Range invalid: ${validation.reason}`);
    }

    if (window === 'ORB' && isRangeTooTight(currentRange)) {
      return noCycle('SKIPPED', `Range too tight/wide for ${symbol}: ${(currentRange.sizePct * 100).toFixed(2)}%`);
    }

    // Skip first 2 minutes of ORB window — highest fakeout rate
    if (window === 'ORB' && isInOrbFakeoutZone()) {
      return noCycle('WAITING_BREAKOUT', `Fakeout zone (9:45–9:47) — waiting for market to settle`);
    }

    // Pre-market says no-go → skip
    if (preMarket && !preMarket.shouldTrade) {
      return noCycle('SKIPPED', `Pre-market blocked: ${preMarket.reason}`);
    }

    // Earnings within ±2 days → skip (ORB is noise on earnings gaps)
    if (preMarket?.earningsSymbols.has(symbol)) {
      return noCycle('SKIPPED', `${symbol} has earnings within 2 days — ORB unreliable, skipping`);
    }

    // ── Fetch all candles in one parallel round-trip ─────────────────────────
    // RVOL history (200 1m bars) and 5m bars are cached for 5 min — they change
    // slowly and fetching them every 10 seconds would hit Alpaca rate limits.
    let recentCandles: Candle[];
    let spyCandles1m:  Candle[];
    let historicalCandles: Candle[] = [];
    let candles5m:     Candle[]     = [];
    let spyCandles5m:  Candle[]     = [];
    try {
      const now          = Date.now();
      const rvolCached   = rvolHistoryCache.get(symbol);
      const macdCached   = candles5mCache.get(symbol);
      const needRvol     = !rvolCached  || now - rvolCached.fetchedAt  > SLOW_CACHE_TTL_MS;
      const needMacd     = !macdCached  || now - macdCached.fetchedAt  > SLOW_CACHE_TTL_MS;

      const [symBars, spyBars, spy5m, histBars, bars5m] = await Promise.all([
        (async () => getStreamedBars(symbol, 15) ?? await getEquityBars(symbol, '1m', 15))(),
        getEquityBars('SPY', '1m', 15),
        getEquityBars('SPY', '5m', 20),
        needRvol ? getEquityBars(symbol, '1m', 200) : Promise.resolve(rvolCached!.bars),
        needMacd ? getEquityBars(symbol, '5m', 40)  : Promise.resolve(macdCached!.bars),
      ]);

      if (needRvol) rvolHistoryCache.set(symbol, { bars: histBars, fetchedAt: now });
      if (needMacd) candles5mCache.set(symbol,   { bars: bars5m,  fetchedAt: now });

      if (symBars.length === 0) {
        return noCycle('WAITING_BREAKOUT', `No 1m candles available for ${symbol}`);
      }
      recentCandles     = symBars;
      spyCandles1m      = spyBars;
      historicalCandles = histBars;
      candles5m         = bars5m;
      spyCandles5m      = spy5m;
    } catch (err) {
      return noCycle('WAITING_BREAKOUT', `Data fetch error: ${err instanceof Error ? err.message : err}`);
    }

    // ── Gate 0: Minimum 5m candle count — block entry if data too thin ───────
    // At 9:45 AM there are only ~3 5m candles — not enough for RSI/MACD/MA.
    // Entering on neutral scores (0.5) means the decision is essentially random.
    // Require 15 candles (~75 min of data) before any entry is allowed.
    if (candles5m.length < 15) {
      return noCycle('WAITING_BREAKOUT', `Only ${candles5m.length} 5m candles — need 15 before entry (reduces neutral-score trades)`);
    }

    // ── Gate 1: SPY trend — soft filter, logs but does NOT block ────────────
    if (spyCandles5m.length >= 9) {
      const spyEma     = computeEMAValues(spyCandles5m.map(c => c.close), 9);
      const spyEmaLast = spyEma[spyEma.length - 1];
      const spyEmaPrev = spyEma[spyEma.length - 4];
      if (spyEmaLast < spyEmaPrev) {
        log.info(`[ORB] ${symbol}: SPY 5m EMA9 sloping down — noting headwind, not blocking`);
      }
    }

    // ── Gate 2: 5m MACD — computed here, applied direction-aware after breakout detection ──
    // Moved below detectBreakout so we can gate per-direction:
    //   LONG  requires histogram > 0 (bullish momentum confirms the breakout)
    //   SHORT requires histogram < 0 (bearish momentum confirms the breakdown)
    // Skipped for MIDDAY/POWER — morning MACD irrelevant at 11 AM+.
    let orbMacdHistogram: number | null = null;
    if (window === 'ORB' && candles5m.length >= 35) {
      try {
        const macd = computeMACD(candles5m.map(c => c.close), 12, 26, 9);
        orbMacdHistogram = macd.histogram;
        log.info(`[ORB] ${symbol}: 5m MACD histogram ${macd.histogram.toFixed(4)} (${macd.trend}) — will gate after direction known`);
      } catch {
        // MACD failed — proceed without blocking
      }
    }

    const latestCandle = recentCandles[recentCandles.length - 1];

    // ── Short squeeze protection ──────────────────────────────────────────────
    // Reject short entries if price is in a parabolic move (RVOL > 4× AND
    // candle body > 2× ATR). Squeezes can spike against shorts violently.
    // This is checked before RVOL gate so it uses the raw candle data.
    const recentBodies = recentCandles.slice(-5).map(c => Math.abs(c.close - c.open));
    const avgBody = recentBodies.reduce((a, b) => a + b, 0) / recentBodies.length;

    // ── RVOL — relative volume vs same time of day ────────────────────────────
    const rvol = computeRVOL(recentCandles, historicalCandles);
    if (rvol >= 1.5) {
      log.info(`[ORB] ${symbol}: RVOL ${rvol.toFixed(2)}× — strong volume confirmation`);
    } else if (rvol < 0.7) {
      log.info(`[ORB] ${symbol}: RVOL ${rvol.toFixed(2)}× — below average volume, lower conviction`);
    }

    // ── Gate: RVOL dead-market block ─────────────────────────────────────────
    // Extremely low volume = trap risk — institutions not participating.
    // Allow mean reversion through (it actually works in thin markets) but
    // block breakout/momentum entries.
    const rvolTooLow = rvol < QUANT.minRvolToEnter;

    // ── Gate: SPY directional commitment ─────────────────────────────────────
    // For breakout/momentum entries: SPY must have made a new 5m high in the
    // last N candles — confirms buyers are actually stepping in market-wide.
    // Skipped for mean reversion (which bets against the current direction).
    let spyMakingHighs = false;
    if (spyCandles5m.length >= QUANT.spyCommitment.lookbackCandles + 1) {
      const recentSpyHighs = spyCandles5m.slice(-QUANT.spyCommitment.lookbackCandles).map(c => c.high);
      const priorSpyHigh   = spyCandles5m.slice(-(QUANT.spyCommitment.lookbackCandles + 3), -QUANT.spyCommitment.lookbackCandles)
        .reduce((max, c) => Math.max(max, c.high), 0);
      spyMakingHighs = recentSpyHighs.some(h => h > priorSpyHigh);
    }

    // ── Intraday trend regime (15m EMA20 slope) ───────────────────────────────
    // Trending up = favour breakout/momentum. Ranging = favour mean reversion.
    let intradayTrend: 'trending' | 'ranging' = 'ranging';
    if (candles5m.length >= QUANT.trendRegime.ema20Period) {
      try {
        const ema20 = computeEMAValues(candles5m.map(c => c.close), QUANT.trendRegime.ema20Period);
        const slope = (ema20[ema20.length - 1] - ema20[ema20.length - 4]) / ema20[ema20.length - 4];
        intradayTrend = slope > QUANT.trendRegime.trendingSlopePct ? 'trending' : 'ranging';
        log.info(`[ORB] ${symbol}: intraday regime ${intradayTrend} (EMA20 slope ${(slope * 100).toFixed(3)}%)`);
      } catch { /* not enough data — default to ranging */ }
    }

    // ── Gate: VWAP reclaim — the new high-conviction entry ───────────────────
    // First check if a raw breakout exists at all (needed for reclaim logic)
    const breakout = detectBreakout(currentRange, latestCandle, recentCandles.slice(-5));

    // ── SHORT BREAKDOWN — mirror of long breakout ─────────────────────────────
    if (breakout.direction === 'SHORT') {
      // Squeeze protection: skip if RVOL > 4× AND large candle body (parabolic)
      const isParabolic = rvol > 4 && avgBody > currentRange.size * 0.5;
      if (isParabolic) {
        return noCycle('WAITING_BREAKOUT', `SHORT breakdown blocked — parabolic move detected (RVOL ${rvol.toFixed(2)}×, avg body $${avgBody.toFixed(2)}) — squeeze risk`);
      }

      if (rvolTooLow) {
        return noCycle('WAITING_BREAKOUT', `SHORT breakdown skipped — RVOL ${rvol.toFixed(2)}× too low (< ${QUANT.minRvolToEnter}×)`);
      }

      // Market-direction gate for shorts: block if SPY is trending UP (EMA9 sloping up + making new highs).
      // Shorting into broad-market strength is the primary cause of short losses on up-days.
      if (spyCandles5m.length >= 9) {
        const spyEma5m   = computeEMAValues(spyCandles5m.map(c => c.close), 9);
        const spyEmaLast = spyEma5m[spyEma5m.length - 1];
        const spyEmaPrev = spyEma5m[spyEma5m.length - 4];
        if (spyEmaLast > spyEmaPrev && spyMakingHighs) {
          return noCycle('WAITING_BREAKOUT', `SHORT breakdown blocked — SPY EMA9 trending up + making new highs — unfavourable for shorts`);
        }
      }

      // MACD direction gate (ORB window only): shorts need bearish momentum (histogram < 0)
      if (orbMacdHistogram !== null && orbMacdHistogram >= 0) {
        return noCycle('WAITING_BREAKOUT', `SHORT breakdown blocked — 5m MACD bullish (histogram +${orbMacdHistogram.toFixed(4)}) — no bearish momentum`);
      }

      log.info(`[ORB] ${symbol}: SHORT breakdown detected! Volume: ${breakout.volumeRatio.toFixed(2)}× | Running full analysis...`);

      const [macroResult, sentimentResult, whaleResult, technicalScore] = await Promise.all([
        runMacroSafe(), runSentimentSafe(symbol), runWhaleSafe(symbol), runTechnicalSafe(symbol),
      ]);

      const orbScore   = breakout.confidence;
      const rvolAdj    = Math.max(-0.05, Math.min(0.05, (rvol - 1.0) * 0.05));
      const finalScore = combineScore('SHORT', orbScore, macroResult.score, sentimentResult.score, whaleResult.score, technicalScore, rvolAdj);

      const shouldEnter = finalScore >= minConfidence(symbol) && !portfolio.circuitBreakerActive;

      let narrative = buildLocalNarrative(symbol, breakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore, shouldEnter);
      if (shouldEnter) narrative = await generateGroqNarrative(symbol, breakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore) ?? narrative;

      return {
        symbol, phase: shouldEnter ? 'ENTERED' : 'WAITING_BREAKOUT',
        range: currentRange, breakout, riskResult: null, narrative,
        macroScore: Math.round(macroResult.score * 1000) / 1000,
        sentimentScore: Math.round(sentimentResult.score * 1000) / 1000,
        whaleScore: Math.round(whaleResult.score * 1000) / 1000,
        orbScore: Math.round(orbScore * 1000) / 1000,
        finalScore, shouldEnter, cycleMs: Date.now() - startMs, analyzedAt: new Date(),
      };
    }

    // Try VWAP reclaim first — highest conviction entry
    const reclaim = detectVwapReclaim(currentRange, recentCandles, spyCandles1m);

    if (!reclaim.valid) {
      // No reclaim — try VWAP bounce (fires in choppy/inside-range markets)
      // Skip if volume is dead (trap risk) or SPY not supporting the move
      const bounce = (!rvolTooLow)
        ? detectVwapBounce(currentRange, recentCandles, spyCandles1m)
        : { valid: false as const, entryPrice: 0, stopPrice: 0, targetPrice: 0, stopDistance: 0, confidence: 0, volumeRatio: 0, vwap: 0, reason: `RVOL ${rvol.toFixed(2)}× too low — skip bounce` };

      if (bounce.valid) {
        log.info(`[ORB] ${symbol}: VWAP bounce detected! Volume: ${bounce.volumeRatio.toFixed(2)}× | Running full analysis...`);

        const [macroResult, sentimentResult, whaleResult, technicalScore] = await Promise.all([
          runMacroSafe(),
          runSentimentSafe(symbol),
          runWhaleSafe(symbol),
          runTechnicalSafe(symbol),
        ]);

        const orbScore  = bounce.confidence;
        const rvolAdj   = Math.max(-0.05, Math.min(0.05, (rvol - 1.0) * 0.05));
        const roundedScore = combineScore('LONG', orbScore, macroResult.score, sentimentResult.score, whaleResult.score, technicalScore, rvolAdj);
        const shouldEnter  = roundedScore >= minConfidence(symbol) && !portfolio.circuitBreakerActive;

        const bounceBreakout: BreakoutSignal = {
          direction:      'LONG',
          breakoutPrice:  bounce.vwap,
          entryPrice:     bounce.entryPrice,
          stopPrice:      bounce.stopPrice,
          targetPrice:    bounce.targetPrice,
          stopDistance:   bounce.stopDistance,
          confidence:     bounce.confidence,
          volumeRatio:    bounce.volumeRatio,
          breakoutCandle: latestCandle,
          reason:         bounce.reason,
        };

        let narrative = buildLocalNarrative(symbol, bounceBreakout, macroResult, sentimentResult, whaleResult, technicalScore, roundedScore, shouldEnter);
        if (shouldEnter) {
          narrative = await generateGroqNarrative(symbol, bounceBreakout, macroResult, sentimentResult, whaleResult, technicalScore, roundedScore) ?? narrative;
        }

        return {
          symbol,
          phase:          shouldEnter ? 'ENTERED' : 'WAITING_BREAKOUT',
          range:          currentRange,
          breakout:       bounceBreakout,
          riskResult:     null,
          narrative,
          macroScore:     Math.round(macroResult.score    * 1000) / 1000,
          sentimentScore: Math.round(sentimentResult.score * 1000) / 1000,
          whaleScore:     Math.round(whaleResult.score    * 1000) / 1000,
          orbScore:       Math.round(orbScore             * 1000) / 1000,
          finalScore:     roundedScore,
          shouldEnter,
          cycleMs:        Date.now() - startMs,
          analyzedAt:     new Date(),
        };
      }

      // ── Strategy 2b: VWAP Rejection Short ────────────────────────────────────
      const vwapReject = (!rvolTooLow)
        ? detectVwapRejectionShort(currentRange, recentCandles, spyCandles1m)
        : { valid: false as const, entryPrice: 0, stopPrice: 0, targetPrice: 0, stopDistance: 0, confidence: 0, volumeRatio: 0, vwap: 0, reason: `RVOL ${rvol.toFixed(2)}× too low — skip rejection short` };

      if (vwapReject.valid) {
        const isParabolic = rvol > 4 && avgBody > vwapReject.stopDistance * 2;
        // Market-direction gate: don't short into a rising SPY
        const spyTrendingUp = spyCandles5m.length >= 9 && (() => {
          const ema = computeEMAValues(spyCandles5m.map(c => c.close), 9);
          return ema[ema.length - 1] > ema[ema.length - 4] && spyMakingHighs;
        })();
        if (spyTrendingUp) {
          log.info(`[ORB] ${symbol}: VWAP rejection short blocked — SPY EMA9 trending up + making new highs`);
        } else if (!isParabolic) {
          log.info(`[ORB] ${symbol}: VWAP rejection short! Vol: ${vwapReject.volumeRatio.toFixed(2)}× | Running full analysis...`);

          const [macroResult, sentimentResult, whaleResult, technicalScore] = await Promise.all([
            runMacroSafe(), runSentimentSafe(symbol), runWhaleSafe(symbol), runTechnicalSafe(symbol),
          ]);

          const orbScore   = vwapReject.confidence;
          const rvolAdj    = Math.max(-0.05, Math.min(0.05, (rvol - 1.0) * 0.05));
          const finalScore = combineScore('SHORT', orbScore, macroResult.score, sentimentResult.score, whaleResult.score, technicalScore, rvolAdj);

          const shouldEnter = finalScore >= minConfidence(symbol) && !portfolio.circuitBreakerActive;

          const vwapRejectBreakout: BreakoutSignal = {
            direction: 'SHORT', breakoutPrice: vwapReject.vwap,
            entryPrice: vwapReject.entryPrice, stopPrice: vwapReject.stopPrice,
            targetPrice: vwapReject.targetPrice, stopDistance: vwapReject.stopDistance,
            confidence: vwapReject.confidence, volumeRatio: vwapReject.volumeRatio,
            breakoutCandle: latestCandle, reason: vwapReject.reason,
          };

          let narrative = buildLocalNarrative(symbol, vwapRejectBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore, shouldEnter);
          if (shouldEnter) narrative = await generateGroqNarrative(symbol, vwapRejectBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore) ?? narrative;

          return {
            symbol, phase: shouldEnter ? 'ENTERED' : 'WAITING_BREAKOUT',
            range: currentRange, breakout: vwapRejectBreakout, riskResult: null, narrative,
            macroScore: Math.round(macroResult.score * 1000) / 1000,
            sentimentScore: Math.round(sentimentResult.score * 1000) / 1000,
            whaleScore: Math.round(whaleResult.score * 1000) / 1000,
            orbScore: Math.round(orbScore * 1000) / 1000,
            finalScore, shouldEnter, cycleMs: Date.now() - startMs, analyzedAt: new Date(),
          };
        }
      }

      // ── Strategy 3: Mean Reversion (runs regardless of breakout state) ───────
      const meanRev = detectMeanReversion(recentCandles);
      if (meanRev.valid) {
        log.info(`[ORB] ${symbol}: Mean reversion detected! RSI ${meanRev.rsi}, ${(meanRev.vwapStretch * 100).toFixed(2)}% below VWAP`);

        const [macroResult, sentimentResult, whaleResult, technicalScore] = await Promise.all([
          runMacroSafe(), runSentimentSafe(symbol), runWhaleSafe(symbol), runTechnicalSafe(symbol),
        ]);

        const orbScore   = meanRev.confidence;
        const rvolAdj    = Math.max(-0.05, Math.min(0.05, (rvol - 1.0) * 0.05));
        const finalScore = combineScore('LONG', orbScore, macroResult.score, sentimentResult.score, whaleResult.score, technicalScore, rvolAdj);

        const shouldEnter = finalScore >= minConfidence(symbol) && !portfolio.circuitBreakerActive;

        const mrBreakout: BreakoutSignal = {
          direction: 'LONG', breakoutPrice: meanRev.entryPrice,
          entryPrice: meanRev.entryPrice, stopPrice: meanRev.stopPrice,
          targetPrice: meanRev.targetPrice, stopDistance: meanRev.stopDistance,
          confidence: meanRev.confidence, volumeRatio: rvol,
          breakoutCandle: latestCandle, reason: meanRev.reason,
        };

        let narrative = buildLocalNarrative(symbol, mrBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore, shouldEnter);
        if (shouldEnter) narrative = await generateGroqNarrative(symbol, mrBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore) ?? narrative;

        return {
          symbol, phase: shouldEnter ? 'ENTERED' : 'WAITING_BREAKOUT',
          range: currentRange, breakout: mrBreakout, riskResult: null, narrative,
          macroScore: Math.round(macroResult.score * 1000) / 1000,
          sentimentScore: Math.round(sentimentResult.score * 1000) / 1000,
          whaleScore: Math.round(whaleResult.score * 1000) / 1000,
          orbScore: Math.round(orbScore * 1000) / 1000,
          finalScore, shouldEnter, cycleMs: Date.now() - startMs, analyzedAt: new Date(),
        };
      }

      // ── Strategy 3b: Short Mean Reversion ────────────────────────────────────
      const shortMR = detectShortMeanReversion(recentCandles);
      if (shortMR.valid) {
        // Squeeze protection: don't short if RVOL is extremely high
        const isParabolic = rvol > 4 && avgBody > shortMR.stopDistance * 2;
        // Market-direction gate: don't short into rising SPY
        const spyTrendingUpMR = spyCandles5m.length >= 9 && (() => {
          const ema = computeEMAValues(spyCandles5m.map(c => c.close), 9);
          return ema[ema.length - 1] > ema[ema.length - 4] && spyMakingHighs;
        })();
        if (!isParabolic && !rvolTooLow && !spyTrendingUpMR) {
          log.info(`[ORB] ${symbol}: Short mean reversion! RSI ${shortMR.rsi}, ${(shortMR.vwapStretch * 100).toFixed(2)}% above VWAP`);

          const [macroResult, sentimentResult, whaleResult, technicalScore] = await Promise.all([
            runMacroSafe(), runSentimentSafe(symbol), runWhaleSafe(symbol), runTechnicalSafe(symbol),
          ]);

          const orbScore   = shortMR.confidence;
          const rvolAdj    = Math.max(-0.05, Math.min(0.05, (rvol - 1.0) * 0.05));
          const finalScore = combineScore('SHORT', orbScore, macroResult.score, sentimentResult.score, whaleResult.score, technicalScore, rvolAdj);

          const shouldEnter = finalScore >= minConfidence(symbol) && !portfolio.circuitBreakerActive;

          const shortMRBreakout: BreakoutSignal = {
            direction: 'SHORT', breakoutPrice: shortMR.entryPrice,
            entryPrice: shortMR.entryPrice, stopPrice: shortMR.stopPrice,
            targetPrice: shortMR.targetPrice, stopDistance: shortMR.stopDistance,
            confidence: shortMR.confidence, volumeRatio: rvol,
            breakoutCandle: latestCandle, reason: shortMR.reason,
          };

          let narrative = buildLocalNarrative(symbol, shortMRBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore, shouldEnter);
          if (shouldEnter) narrative = await generateGroqNarrative(symbol, shortMRBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore) ?? narrative;

          return {
            symbol, phase: shouldEnter ? 'ENTERED' : 'WAITING_BREAKOUT',
            range: currentRange, breakout: shortMRBreakout, riskResult: null, narrative,
            macroScore: Math.round(macroResult.score * 1000) / 1000,
            sentimentScore: Math.round(sentimentResult.score * 1000) / 1000,
            whaleScore: Math.round(whaleResult.score * 1000) / 1000,
            orbScore: Math.round(orbScore * 1000) / 1000,
            finalScore, shouldEnter, cycleMs: Date.now() - startMs, analyzedAt: new Date(),
          };
        }
      }

      // ── Strategy 4: Momentum Continuation (trending regime only) ─────────────
      if (intradayTrend === 'trending' && !rvolTooLow && spyMakingHighs) {
        const momentum = detectMomentumContinuation(recentCandles, candles5m);
        if (momentum.valid) {
          log.info(`[ORB] ${symbol}: Momentum continuation! EMA9 $${momentum.ema9.toFixed(2)}, RSI ${momentum.rsi}`);

          const [macroResult, sentimentResult, whaleResult, technicalScore] = await Promise.all([
            runMacroSafe(), runSentimentSafe(symbol), runWhaleSafe(symbol), runTechnicalSafe(symbol),
          ]);

          const orbScore   = momentum.confidence;
          const rvolAdj    = Math.max(-0.05, Math.min(0.05, (rvol - 1.0) * 0.05));
          const finalScore = combineScore('LONG', orbScore, macroResult.score, sentimentResult.score, whaleResult.score, technicalScore, rvolAdj);

          const shouldEnter = finalScore >= minConfidence(symbol) && !portfolio.circuitBreakerActive;

          const momBreakout: BreakoutSignal = {
            direction: 'LONG', breakoutPrice: momentum.ema9,
            entryPrice: momentum.entryPrice, stopPrice: momentum.stopPrice,
            targetPrice: momentum.targetPrice, stopDistance: momentum.stopDistance,
            confidence: momentum.confidence, volumeRatio: rvol,
            breakoutCandle: latestCandle, reason: momentum.reason,
          };

          let narrative = buildLocalNarrative(symbol, momBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore, shouldEnter);
          if (shouldEnter) narrative = await generateGroqNarrative(symbol, momBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore) ?? narrative;

          return {
            symbol, phase: shouldEnter ? 'ENTERED' : 'WAITING_BREAKOUT',
            range: currentRange, breakout: momBreakout, riskResult: null, narrative,
            macroScore: Math.round(macroResult.score * 1000) / 1000,
            sentimentScore: Math.round(sentimentResult.score * 1000) / 1000,
            whaleScore: Math.round(whaleResult.score * 1000) / 1000,
            orbScore: Math.round(orbScore * 1000) / 1000,
            finalScore, shouldEnter, cycleMs: Date.now() - startMs, analyzedAt: new Date(),
          };
        }
      }

      // ── Strategy 2d: Mean-Reversion Fade ──────────────────────────────────
      // Looks for failed breakouts — price broke out then closed back inside the range.
      // Only checked when no breakout/bounce/rejection fired this candle.
      // Symbol whitelist enforced — backtest showed negative expectancy on
      // trending mega-caps (QQQ, NVDA, GOOGL).
      const fadeAllowedForSymbol = FADE.enabledSymbols.length === 0
        || FADE.enabledSymbols.includes(symbol);
      if (FADE.enabled && fadeAllowedForSymbol) {
        const fade = detectFade(currentRange, latestCandle, recentCandles.slice(-6));
        if (fade.direction !== 'NONE' && fade.confidence >= FADE.minConfidence) {
          // Squeeze guard: do not short-fade into a parabolic move
          const isParabolic = rvol > 4 && avgBody > currentRange.size * 0.5;
          if (fade.direction === 'SHORT' && isParabolic) {
            log.info(`[ORB] ${symbol}: SHORT fade blocked — parabolic move (RVOL ${rvol.toFixed(2)}×)`);
          } else if (rvolTooLow) {
            log.info(`[ORB] ${symbol}: fade skipped — RVOL ${rvol.toFixed(2)}× too low`);
          } else {
            log.info(`[ORB] ${symbol}: ${fade.direction} fade detected! ${fade.reason}`);

            const [macroResult, sentimentResult, whaleResult, technicalScore] = await Promise.all([
              runMacroSafe(), runSentimentSafe(symbol), runWhaleSafe(symbol), runTechnicalSafe(symbol),
            ]);

            const orbScore   = fade.confidence;
            const rvolAdj    = Math.max(-0.05, Math.min(0.05, (rvol - 1.0) * 0.05));
            const finalScore = combineScore(fade.direction, orbScore, macroResult.score, sentimentResult.score, whaleResult.score, technicalScore, rvolAdj);

            const shouldEnter = finalScore >= minConfidence(symbol) && !portfolio.circuitBreakerActive;

            const fadeBreakout: BreakoutSignal = {
              direction:      fade.direction,
              breakoutPrice:  fade.failedExtreme,
              entryPrice:     fade.entryPrice,
              stopPrice:      fade.stopPrice,
              targetPrice:    fade.targetPrice,
              stopDistance:   fade.stopDistance,
              confidence:     fade.confidence,
              volumeRatio:    currentRange.avgVolume > 0 ? latestCandle.volume / currentRange.avgVolume : 1.0,
              breakoutCandle: latestCandle,
              reason:         `[FADE] ${fade.reason}`,
            };

            let narrative = buildLocalNarrative(symbol, fadeBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore, shouldEnter);
            if (shouldEnter) narrative = await generateGroqNarrative(symbol, fadeBreakout, macroResult, sentimentResult, whaleResult, technicalScore, finalScore) ?? narrative;

            return {
              symbol, phase: shouldEnter ? 'ENTERED' : 'WAITING_BREAKOUT',
              range: currentRange, breakout: fadeBreakout, riskResult: null, narrative,
              macroScore: Math.round(macroResult.score * 1000) / 1000,
              sentimentScore: Math.round(sentimentResult.score * 1000) / 1000,
              whaleScore: Math.round(whaleResult.score * 1000) / 1000,
              orbScore: Math.round(orbScore * 1000) / 1000,
              finalScore, shouldEnter,
              cycleMs: Date.now() - startMs, analyzedAt: new Date(),
            };
          }
        }
      }

      // No strategy fired — report why
      if (breakout.direction === 'NONE') {
        return {
          symbol, phase: 'WAITING_BREAKOUT', range: currentRange, breakout,
          riskResult: null, narrative: breakout.reason,
          macroScore: 0, sentimentScore: 0, whaleScore: 0, orbScore: 0,
          finalScore: 0, shouldEnter: false, cycleMs: Date.now() - startMs, analyzedAt: new Date(),
        };
      }
      // Breakout exists but reclaim/bounce/MR/momentum all failed
      return noCycle('WAITING_BREAKOUT', `All strategies checked — waiting: ${reclaim.reason}`);
    }

    // ── Gate 3: RVOL dead-market block on reclaim ────────────────────────────
    if (rvolTooLow) {
      return noCycle('WAITING_BREAKOUT', `Reclaim skipped — RVOL ${rvol.toFixed(2)}× too low (< ${QUANT.minRvolToEnter}×) — trap risk`);
    }

    // ── Gate 4: 5m EMA9 alignment ────────────────────────────────────────────
    if (candles5m.length >= 9) {
      try {
        const ema9 = computeEMAValues(candles5m.map(c => c.close), 9).at(-1)!;
        if (latestCandle.close < ema9) {
          return noCycle('WAITING_BREAKOUT',
            `Reclaim filtered: close $${latestCandle.close.toFixed(2)} below 5m EMA9 $${ema9.toFixed(2)}`
          );
        }
        log.info(`[ORB] ${symbol}: 5m EMA9 confirmed ($${latestCandle.close.toFixed(2)} > $${ema9.toFixed(2)})`);
      } catch {
        // EMA check failed — proceed without it
      }
    }

    // ── MACD direction gate for LONG (ORB window only): require bullish histogram ──
    if (orbMacdHistogram !== null && orbMacdHistogram < 0) {
      return noCycle('WAITING_BREAKOUT',
        `LONG reclaim blocked — 5m MACD bearish (histogram ${orbMacdHistogram.toFixed(4)}) — higher timeframe not confirming`
      );
    }

    // ── ALL GATES PASSED — VWAP reclaim confirmed ─────────────────────────────
    log.info(`[ORB] ${symbol}: VWAP reclaim confirmed! RS: +${(reclaim.relativeStrength * 100).toFixed(2)}% vs SPY. Regime: ${intradayTrend}. Running full analysis...`);

    // Synthesize breakout signal from reclaim data for downstream compatibility
    const syntheticBreakout: BreakoutSignal = {
      direction:      'LONG',
      breakoutPrice:  currentRange.high,
      entryPrice:     reclaim.entryPrice,
      stopPrice:      reclaim.stopPrice,
      targetPrice:    reclaim.targetPrice,
      stopDistance:   reclaim.stopDistance,
      confidence:     reclaim.confidence,
      volumeRatio:    reclaim.volumeRatio,
      breakoutCandle: latestCandle,
      reason:         reclaim.reason,
    };

    // Run macro, sentiment, whale, and technical indicators in parallel
    const [macroResult, sentimentResult, whaleResult, technicalScore] = await Promise.all([
      runMacroSafe(),
      runSentimentSafe(symbol),
      runWhaleSafe(symbol),
      runTechnicalSafe(symbol),
    ]);

    // ORB score: based on reclaim confidence (already includes RS boost)
    const orbScore = reclaim.confidence;

    // RVOL adjustment: scale score up for high-volume setups, down for low-volume
    // Capped at ±0.05 so it nudges the score but never overrides other signals
    const rvolAdj = Math.max(-0.05, Math.min(0.05, (rvol - 1.0) * 0.05));

    // Combine all signals — LONG reclaim, so bullish signals add confidence
    const roundedScore = combineScore('LONG', orbScore, macroResult.score, sentimentResult.score, whaleResult.score, technicalScore, rvolAdj);

    // Decision: should we enter?
    const shouldEnter = roundedScore >= minConfidence(symbol) &&
                        reclaim.valid &&
                        !portfolio.circuitBreakerActive;

    // Generate a narrative from Groq (for Discord alerts on buy decisions)
    let narrative = buildLocalNarrative(symbol, syntheticBreakout, macroResult, sentimentResult, whaleResult, technicalScore, roundedScore, shouldEnter);
    if (shouldEnter) {
      narrative = await generateGroqNarrative(symbol, syntheticBreakout, macroResult, sentimentResult, whaleResult, technicalScore, roundedScore) ?? narrative;
    }

    return {
      symbol,
      phase:          shouldEnter ? 'ENTERED' : 'WAITING_BREAKOUT',
      range:          currentRange,
      breakout:       syntheticBreakout,
      riskResult:     null,   // Populated by orchestrator after risk check
      narrative,
      macroScore:     Math.round(macroResult.score   * 1000) / 1000,
      sentimentScore: Math.round(sentimentResult.score * 1000) / 1000,
      whaleScore:     Math.round(whaleResult.score   * 1000) / 1000,
      orbScore:       Math.round(orbScore            * 1000) / 1000,
      finalScore:     roundedScore,
      shouldEnter,
      cycleMs:        Date.now() - startMs,
      analyzedAt:     new Date(),
    };
  }

  // ── Phase: MANAGING (10:15–10:30, ORB only) ──────────────────────────────
  if (window === 'ORB' && isInManagingWindow()) {
    return noCycle('WAITING_BREAKOUT', `Entry window closed at 10:15 — managing positions only`);
  }

  // Outside all windows (ORB only — MIDDAY/POWER handled above)
  return noCycle('SKIPPED', `Outside trading hours for ${symbol}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DIRECTION-AWARE SCORE COMBINER
//
// All non-ORB signals (macro, sentiment, whale, technical) are LONG-oriented:
// a high score (>0.5) means "bullish". For SHORT entries we flip them so that
// a bullish market REDUCES short confidence, and a bearish market INCREASES it.
// orbScore is already direction-specific and must NOT be flipped.
// ─────────────────────────────────────────────────────────────────────────────

function combineScore(
  direction:     'LONG' | 'SHORT',
  orbScore:      number,
  macroScore:    number,
  sentScore:     number,
  whaleScore:    number,
  techScore:     number,
  rvolAdj:       number,
): number {
  const flip = (s: number) => direction === 'SHORT' ? (1 - s) : s;
  const raw =
    (orbScore        * SIGNAL_WEIGHTS.orb)       +
    (flip(macroScore) * SIGNAL_WEIGHTS.macro)     +
    (flip(sentScore)  * SIGNAL_WEIGHTS.sentiment) +
    (flip(whaleScore) * SIGNAL_WEIGHTS.whale)     +
    (flip(techScore)  * SIGNAL_WEIGHTS.technical) +
    rvolAdj;
  return Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFE WRAPPERS
// If any agent fails, return a neutral result rather than crashing the cycle
// ─────────────────────────────────────────────────────────────────────────────

// Per-session caches — sentiment and macro data doesn't change meaningfully
// on a 10-second tick. Compute once at session start, reuse for the window.
const sentimentCache = new Map<string, SentimentResult>();
let macroCache: MacroResult | null = null;

// Slow-changing bar caches — RVOL history and 5m bars update every 5 minutes max.
// Fetching 200 1m bars every 10 seconds per symbol would burn through rate limits fast.
const rvolHistoryCache  = new Map<string, { bars: Candle[]; fetchedAt: number }>();
const candles5mCache    = new Map<string, { bars: Candle[]; fetchedAt: number }>();
const SLOW_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearOrbSessionCaches(): void {
  sentimentCache.clear();
  macroCache = null;
  rvolHistoryCache.clear();
  candles5mCache.clear();
}

async function runMacroSafe(): Promise<MacroResult> {
  if (macroCache) return macroCache;
  try {
    macroCache = await analyzeMacro();
    return macroCache;
  } catch (err) {
    log.warn(`[ORB] Macro analysis failed: ${err instanceof Error ? err.message : err} — using neutral`);
    return {
      score:       0.50,
      environment: 'neutral',
      spyTrend:    0,
      vixyTrend:   0,
      spyScore:    0.50,
      vixyScore:   0.50,
      vixLevel:    20,
      reason:      'Macro data unavailable — using neutral',
      dataGaps:    ['Macro analysis failed'],
      fetchedAt:   new Date(),
    };
  }
}

async function runSentimentSafe(symbol: string): Promise<SentimentResult> {
  const cached = sentimentCache.get(symbol);
  if (cached) return cached;
  try {
    const result = await analyzeSentiment([symbol, 'SPY']);
    sentimentCache.set(symbol, result);
    return result;
  } catch (err) {
    log.warn(`[ORB] Sentiment analysis failed: ${err instanceof Error ? err.message : err} — using neutral`);
    return {
      score:          0.50,
      label:          'neutral',
      fearGreed:      50,
      newsScore:      0.50,
      redditScore:    0.50,
      trendsScore:    0.50,
      trendsInterest: 50,
      headlines:      [],
      redditPosts:    [],
      groqReason:     'Sentiment data unavailable — using neutral',
      dataGaps:       ['Sentiment analysis failed'],
      fetchedAt:      new Date(),
    };
  }
}

async function runWhaleSafe(symbol: string): Promise<WhaleResult> {
  const neutral: WhaleResult = {
    score:                   0.50,
    signal:                  'neutral',
    orderBookSignal:         0.50,
    relativeVolumeScore:     0.50,
    putCallScore:            0.50,
    putCallRatio:            1.00,
    relativeVolume:          1.00,
    exchangeOutflowDetected: false,
    largeTradeBias:          0.50,
    largeTradeCount:         0,
    fundingRate:             0,
    fundingRateScore:        0.50,
    openInterest:            0,
    liquidationBias:         0.50,
    longLiquidations:        0,
    shortLiquidations:       0,
    reason:                  'Institutional flow data unavailable — using neutral',
    dataGaps:                ['Institutional flow analysis failed'],
    fetchedAt:               new Date(),
  };

  // Whale agent needs microstructure + recent OHLCV volumes/closes
  // For ORB equity symbols (QQQ, SPY), funding/liquidation data won't apply
  // (those are crypto derivatives signals) — the agent handles this gracefully
  // by falling back to order book + large trade signals only.
  try {
    const [orderBook, candles5m] = await Promise.all([
      getOrderBook(symbol).catch(() => null),
      (async () => getStreamedBars(symbol, 25) ?? await getEquityBars(symbol, '5m', 25))().catch(() => [] as Candle[]),
    ]);

    if (!orderBook || candles5m.length < 5) {
      log.warn(`[ORB] ${symbol}: insufficient data for whale analysis — using neutral`);
      return neutral;
    }

    const micro   = analyzeMicrostructure(orderBook);
    const volumes = candles5m.map(c => c.volume);
    const closes  = candles5m.map(c => c.close);

    const result = await analyzeWhaleActivity(symbol, micro, volumes, closes);
    log.info(`[ORB] ${symbol}: whale score=${result.score.toFixed(3)} signal=${result.signal}`);
    return result;
  } catch (err) {
    log.warn(`[ORB] Whale analysis failed: ${err instanceof Error ? err.message : err} — using neutral`);
    return neutral;
  }
}

// Fetch 5m candles and compute RSI/MACD/MA for the technical score.
// We request 60 bars (~5 hours) so we have enough history for all indicators.
// Falls back to neutral 0.5 on any error so it never blocks a trade decision.
async function runTechnicalSafe(symbol: string): Promise<number> {
  try {
    const candles5m = await getEquityBars(symbol, '5m', 60);
    if (candles5m.length < 30) {
      log.warn(`[ORB] ${symbol}: only ${candles5m.length} 5m candles — need 30 for technicals, using neutral`);
      return 0.50;
    }
    const suite = computeIndicators(candles5m, '5m');
    log.info(
      `[ORB] ${symbol}: technical score=${suite.technicalScore.toFixed(3)} ` +
      `RSI=${suite.rsi.value.toFixed(1)} MACD=${suite.macd.trend} MA=${suite.ma.trend}`
    );
    return suite.technicalScore;
  } catch (err) {
    log.warn(`[ORB] ${symbol}: technical analysis failed: ${err instanceof Error ? err.message : err} — using neutral`);
    return 0.50;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NARRATIVE GENERATION
// Produces a human-readable description of the trade decision for Discord
// ─────────────────────────────────────────────────────────────────────────────

function buildLocalNarrative(
  symbol:         string,
  breakout:       BreakoutSignal,
  macro:          MacroResult,
  sentiment:      SentimentResult,
  whale:          WhaleResult,
  technicalScore: number,
  score:          number,
  entering:       boolean,
): string {
  const dir    = breakout.direction === 'SHORT' ? 'SHORT' : 'LONG';
  const action = entering ? `ENTERING ${dir}` : 'MONITORING';
  return [
    `${action} ${symbol}`,
    `Entry: $${breakout.entryPrice.toFixed(2)} | Vol: ${breakout.volumeRatio.toFixed(2)}×`,
    `Stop: $${breakout.stopPrice.toFixed(2)} | Target: $${breakout.targetPrice.toFixed(2)}`,
    `Score: ${(score * 100).toFixed(1)}% | ORB: ${(breakout.confidence * 100).toFixed(0)}% | Tech: ${(technicalScore * 100).toFixed(0)}% | Macro: ${macro.environment} | Sentiment: ${sentiment.label} | Whale: ${whale.signal}`,
  ].join(' | ');
}

async function generateGroqNarrative(
  symbol:         string,
  breakout:       BreakoutSignal,
  macro:          MacroResult,
  sentiment:      SentimentResult,
  whale:          WhaleResult,
  technicalScore: number,
  score:          number,
): Promise<string | null> {
  try {
    const result = await askGroqSafe<{ narrative: string }>([
      {
        role:    'system',
        content: `You are an ORB (Opening Range Breakout) trading analyst.
Write a 2-sentence trading narrative explaining a ${breakout.direction === 'SHORT' ? 'SHORT SELL' : 'BUY'} decision.
Be specific about the breakout direction, volume, and market conditions.
Respond ONLY with valid JSON: { "narrative": "two sentences" }`,
      },
      {
        role:    'user',
        content: JSON.stringify({
          symbol,
          breakoutPrice:    breakout.breakoutPrice,
          entryPrice:       breakout.entryPrice,
          stopPrice:        breakout.stopPrice,
          targetPrice:      breakout.targetPrice,
          volumeRatio:      breakout.volumeRatio,
          orbConfidence:    breakout.confidence,
          technicalScore,
          macroEnvironment: macro.environment,
          macroScore:       macro.score,
          sentimentLabel:   sentiment.label,
          whaleSignal:      whale.signal,
          whaleScore:       whale.score,
          finalScore:       score,
        }),
      },
    ]);

    return result?.result?.narrative ?? null;
  } catch {
    return null;
  }
}
