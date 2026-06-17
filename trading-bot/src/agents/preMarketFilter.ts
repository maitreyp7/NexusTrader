import { API, RISK, ASSETS, PREMARKET } from '../config.js';
import * as fs from 'fs';
import { log } from '../core/logger.js';
import { retry } from '../core/retry.js';
import { checkTodayEvents } from '../data/economicCalendar.js';
import { getEquityBars, getEquitySnapshot, getVixLevel } from '../tools/marketData.js';
import { getSymbolsWithNearbyEarnings } from '../data/earningsCalendar.js';

// ─────────────────────────────────────────────────────────────────────────────
// PRE-MARKET FILTER — Runs 9:00–9:29 AM before trading starts
//
// This is the "morning meeting" before the market opens. It checks:
//
//   1. VIX level: Is the market too fearful to trade?
//      VIX > 30 = extreme fear → ORB signals are noise, skip the day
//
//   2. Economic calendar: Is there a Fed meeting or CPI release today?
//      High-impact events distort the opening range → skip the day
//
//   3. SPY and QQQ pre-market price movement: Which direction is the market
//      leaning? This sets a "day bias" that influences our confidence scoring.
//
//   4. Previous day's trend: Did the market close up or down yesterday?
//      Trend-following context — we want to trade WITH the recent momentum.
//
// OUTPUT: PreMarketAnalysis
//   shouldTrade: false → session skips entirely (no trades today)
//   dayBias → influences how aggressively we size positions
//
// TIMING: This runs at 9:00 AM, 30 minutes before market open.
// By 9:29 AM, we have a clear go/no-go decision ready.
// ─────────────────────────────────────────────────────────────────────────────

export interface PreMarketAnalysis {
  shouldTrade:      boolean;
  dayBias:          'TRENDING_UP' | 'TRENDING_DOWN' | 'NEUTRAL' | 'SKIP';
  vixLevel:         number;
  vixBlocked:       boolean;
  calendarBlock:    boolean;
  calendarReason:   string;
  spyPremarket:     number;   // SPY premarket % change
  qqqPremarket:     number;   // QQQ premarket % change
  prevDayTrend:     'UP' | 'DOWN' | 'FLAT';  // Prior day's direction
  confidence:       number;   // 0–1 overall confidence in today's setup
  earningsSymbols:  Set<string>;  // Symbols to skip due to nearby earnings
  marketLensBias:   Map<string, number>;  // Per-symbol confidence adj from AI briefing
  reason:           string;
  analyzedAt:       Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — runPreMarketFilter
//
// Runs all checks in parallel (calendar + VIX + price data) for speed.
// Returns a complete PreMarketAnalysis within a few seconds.
// ─────────────────────────────────────────────────────────────────────────────

// ── NexusTrader kill switch — written by portfolio-manager ────────────────────
// Fail-closed: corrupt/unreadable file halts trading rather than silently allowing it.
function isNexusKillActive(): boolean {
  const killPath = '/opt/nexustrader/signals/kill_switch.json';
  if (!fs.existsSync(killPath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(killPath, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    return data.active === true && data.date === today;
  } catch (err) {
    log.error(`[PreMarket] kill_switch.json is unreadable/corrupt — halting as a precaution: ${err instanceof Error ? err.message : err}`);
    return true;
  }
}

export async function runPreMarketFilter(): Promise<PreMarketAnalysis> {
  log.info('[PreMarket] Running pre-market filter...');

  // Run all data fetches in parallel — no point waiting for one before starting another
  const [calendarResult, vixLevel, spyData, qqqData, earningsSymbols, marketLensBias] = await Promise.all([
    checkTodayEvents(),
    fetchVixSafe(),
    fetchPremarketData('SPY'),
    fetchPremarketData('QQQ'),
    getSymbolsWithNearbyEarnings(ASSETS.watchlist).catch(() => new Set<string>()),
    Promise.resolve(readMarketLensBias()),
  ]);

  // ── Check 1: VIX Kill Switch ────────────────────────────────────────────────
  const vixBlocked = vixLevel > RISK.vixKillSwitch;
  if (vixBlocked) {
    log.warn(`[PreMarket] VIX KILL SWITCH: VIX=${vixLevel.toFixed(1)} > ${RISK.vixKillSwitch} — blocking today`);
  }

  // ── Check 2: Economic Calendar ───────────────────────────────────────────────
  const calendarBlock = calendarResult.shouldSkipTrading;
  if (calendarBlock) {
    log.warn(`[PreMarket] CALENDAR BLOCK: ${calendarResult.reason}`);
  }

  // ── Check 3: NexusTrader kill switch ───────────────────────────────────────
  const nexusKill = isNexusKillActive();
  if (nexusKill) {
    log.warn('[PreMarket] NEXUS KILL SWITCH active — portfolio-manager halted trading today');
  }

  // ── Determine Day Bias ───────────────────────────────────────────────────────
  // Uses both the previous day's trend and the pre-market price movement
  const prevDayTrend = determinePrevDayTrend(spyData.prevDayChange, qqqData.prevDayChange);
  const dayBias      = determineDayBias(prevDayTrend, spyData.premktChange, qqqData.premktChange);

  // ── Determine if we should trade ─────────────────────────────────────────────
  const hardBlocked = vixBlocked || calendarBlock || dayBias === 'SKIP' || nexusKill;

  // Calculate confidence (0–1)
  let confidence = 0;
  if (!hardBlocked) {
    const vixScore    = Math.max(0, Math.min(1, 1 - (vixLevel / RISK.vixKillSwitch)));
    const biasScore   = PREMARKET.biasScores[dayBias as keyof typeof PREMARKET.biasScores] ?? 0.30;
    const premktScore = Math.max(0, Math.min(1, 0.5 + (spyData.premktChange + qqqData.premktChange) / 2));
    const w           = PREMARKET.confidenceWeights;
    confidence = Math.round((vixScore * w.vix + biasScore * w.bias + premktScore * w.premkt) * 1000) / 1000;
  }

  // ── Build Reason String ───────────────────────────────────────────────────────
  const reasons: string[] = [];
  if (nexusKill)     reasons.push('NexusTrader kill switch active');
  if (vixBlocked)    reasons.push(`VIX ${vixLevel.toFixed(1)} > ${RISK.vixKillSwitch} (blocked)`);
  if (calendarBlock) reasons.push(calendarResult.reason);
  if (!hardBlocked)  {
    reasons.push(`VIX: ${vixLevel.toFixed(1)}`);
    reasons.push(`SPY pre: ${spyData.premktChange >= 0 ? '+' : ''}${(spyData.premktChange * 100).toFixed(2)}%`);
    reasons.push(`QQQ pre: ${qqqData.premktChange >= 0 ? '+' : ''}${(qqqData.premktChange * 100).toFixed(2)}%`);
    reasons.push(`Prev day: ${prevDayTrend}`);
    reasons.push(`Bias: ${dayBias}`);
  }
  const reason = reasons.join(' | ');

  const analysis: PreMarketAnalysis = {
    shouldTrade:      !hardBlocked,
    dayBias:          hardBlocked ? 'SKIP' : dayBias,
    vixLevel:         Math.round(vixLevel * 100) / 100,
    vixBlocked,
    calendarBlock,
    calendarReason:   calendarResult.reason,
    spyPremarket:     Math.round(spyData.premktChange * 10000) / 10000,
    qqqPremarket:     Math.round(qqqData.premktChange * 10000) / 10000,
    prevDayTrend,
    confidence,
    earningsSymbols,
    marketLensBias,
    reason,
    analyzedAt:       new Date(),
  };

  const statusLine = analysis.shouldTrade
    ? `GO — Trading today (bias: ${analysis.dayBias}, confidence: ${(confidence * 100).toFixed(0)}%)`
    : `NO-GO — Skipping today (${reason})`;

  log.info(`[PreMarket] ${statusLine}`);
  if (marketLensBias.size > 0) {
    const biasStr = Array.from(marketLensBias.entries())
      .map(([s, adj]) => `${s}:${adj >= 0 ? '+' : ''}${adj}`).join(' ');
    log.info(`[PreMarket] Market-lens bias: ${biasStr}`);
  }

  return analysis;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

interface PriceData {
  premktChange:  number;   // Pre-market % change from yesterday's close
  prevDayChange: number;   // Previous day's % change (open to close)
}

// Fetch VIX level safely — if it fails, return a conservative value
async function fetchVixSafe(): Promise<number> {
  try {
    return await getVixLevel();
  } catch (err) {
    log.warn(`[PreMarket] VIX fetch failed: ${err instanceof Error ? err.message : err} — using 20 (neutral)`);
    return 20; // Safe neutral value — not high enough to block
  }
}

// Fetch pre-market price data for an equity symbol.
// Uses the Alpaca snapshot endpoint which returns the live latest trade price
// and the previous daily close — giving a true real-time pre-market change.
async function fetchPremarketData(symbol: string): Promise<PriceData> {
  const neutral: PriceData = { premktChange: 0, prevDayChange: 0 };

  try {
    // Snapshot: latestTrade.p = current price (pre-market quote if before 9:30)
    //           prevDailyBar.c = yesterday's regular-session close
    // changePct = (latestPrice - prevClose) / prevClose — this IS the pre-market move
    const snap = await getEquitySnapshot(symbol);
    const premktChange = snap.changePct;

    // Previous day % change: need yesterday's open to compute open-to-close
    const dailyBars = await getEquityBars(symbol, '1Day', 3);
    const prevDay   = dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2] : null;
    const prevDayChange = prevDay && prevDay.open > 0
      ? (prevDay.close - prevDay.open) / prevDay.open
      : 0;

    return {
      premktChange:  Math.round(premktChange  * 10000) / 10000,
      prevDayChange: Math.round(prevDayChange * 10000) / 10000,
    };

  } catch (err) {
    log.warn(`[PreMarket] ${symbol} price data unavailable: ${err instanceof Error ? err.message : err}`);
    return neutral;
  }
}

// Determine if the previous day trended up or down
// We use both SPY and QQQ — they should agree. If they disagree, call it FLAT.
function determinePrevDayTrend(spyChange: number, qqqChange: number): 'UP' | 'DOWN' | 'FLAT' {
  const threshold = PREMARKET.trendThresholdPct;

  const spyUp   = spyChange  >  threshold;
  const spyDown = spyChange  < -threshold;
  const qqqUp   = qqqChange  >  threshold;
  const qqqDown = qqqChange  < -threshold;

  if (spyUp   && qqqUp)   return 'UP';
  if (spyDown && qqqDown) return 'DOWN';
  return 'FLAT';
}

// Read market-lens signals.json — returns per-symbol confidence adjustments.
// BUY_WATCH high score -> lower threshold (AI bullish on this symbol)
// Low score -> raise threshold (AI bearish or unimpressed)
// Missing/stale file -> empty map (never blocks trading)
function readMarketLensBias(): Map<string, number> {
  const result = new Map<string, number>();
  try {
    const signalsPath = '/opt/nexustrader/signals/signals.json';
    if (!fs.existsSync(signalsPath)) return result;
    const ageHours = (Date.now() - fs.statSync(signalsPath).mtimeMs) / 3_600_000;
    if (ageHours > 24) return result;
    const raw = JSON.parse(fs.readFileSync(signalsPath, 'utf8'));
    const theses: { ticker: string; verdict: string; final_score: number }[] = raw.theses ?? [];
    for (const thesis of theses) {
      if (!ASSETS.watchlist.includes(thesis.ticker)) continue;
      const score = thesis.final_score ?? 0;
      const verdict = (thesis.verdict ?? '').toUpperCase();
      let adj = 0;
      if (verdict === 'BUY_WATCH' && score >= 90) adj = -0.03;
      else if (verdict === 'BUY_WATCH' && score >= 75) adj = -0.02;
      else if (score <= 40) adj = +0.05;
      else if (score <= 55) adj = +0.03;
      if (adj !== 0) result.set(thesis.ticker, adj);
    }
  } catch { /* fail safe */ }
  return result;
}

// Determine the day bias based on prev day trend + pre-market action
function determineDayBias(
  prevDayTrend: 'UP' | 'DOWN' | 'FLAT',
  spyPremkt:   number,
  qqqPremkt:   number,
): 'TRENDING_UP' | 'TRENDING_DOWN' | 'NEUTRAL' | 'SKIP' {
  const premktThreshold = PREMARKET.premarketThresholdPct;

  const premktPositive = spyPremkt > premktThreshold && qqqPremkt > premktThreshold;
  const premktNegative = spyPremkt < -premktThreshold && qqqPremkt < -premktThreshold;

  // Strong trending up: previous day closed up AND pre-market is positive
  if (prevDayTrend === 'UP'   && premktPositive) return 'TRENDING_UP';

  // Trending down: previous day closed down AND pre-market is negative
  // Long-only bot: we don't trade shorts, so this day is low-probability
  if (prevDayTrend === 'DOWN' && premktNegative) return 'TRENDING_DOWN';

  // Mixed signals: still trade but with lower confidence
  return 'NEUTRAL';
}
