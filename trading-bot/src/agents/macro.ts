import { API, MACRO_CONFIG } from '../config.js';
import { retry } from '../core/retry.js';
import { getVixLevel as fetchVixFromData, getEquitySnapshot } from '../tools/marketData.js';

// ─────────────────────────────────────────────────────────────────────────────
// MACRO ECONOMIC AGENT
//
// Measures the broader financial environment that BTC/ETH trade within.
// Crypto doesn't exist in a vacuum — when stocks crash, crypto usually follows.
// When the dollar is strong, risk assets (including crypto) tend to weaken.
//
// THREE SIGNALS (all free via Alpaca's data API — already authenticated):
//
//   1. S&P 500 (SPY ETF)
//      Crypto and stocks are positively correlated in risk-off environments.
//      SPY trending up = "risk on" = good for crypto.
//      SPY crashing = investors flee to safety = bad for crypto.
//
//   2. US Dollar Index (UUP ETF as proxy)
//      Strong dollar = bad for crypto. Crypto is priced in USD —
//      a stronger dollar means each BTC is "worth more dollars" less
//      attractive to hold. Inverse relationship.
//
//   3. VIX Proxy (VIXY ETF)
//      The VIX measures expected stock market volatility (the "fear index").
//      High VIX = fear = risk-off = bad for crypto short-term.
//      Low VIX = complacency = risk-on = supports crypto.
//
// WHY 5-DAY TREND INSTEAD OF 1-DAY CHANGE:
//   A single day's movement is mostly noise. SPY up +1% today means nothing
//   on its own — it could reverse tomorrow. What actually matters is whether
//   the market has been trending up or down over the past week.
//   Using a 5-day slope gives a much more reliable read on the macro regime.
//   This also smooths out single-day news events (Fed meeting, jobs report)
//   that cause spikes but don't change the underlying trend.
//
// OUTPUT: macroScore (0–1)
//   > 0.60 = Risk-on environment → macro tailwind for crypto
//   0.40–0.60 = Neutral
//   < 0.40 = Risk-off environment → macro headwind for crypto
//
// NOTE: Alpaca's data API covers US equities during market hours.
//       Outside market hours, we use the last available close.
//       Crypto trades 24/7 but macro context still matters from last close.
// ─────────────────────────────────────────────────────────────────────────────

export interface MacroResult {
  score:       number;      // 0–1 for Decision Engine
  environment: 'risk_on' | 'neutral' | 'risk_off';
  spyTrend:    number;      // SPY 5-day slope (% per day, positive = trending up)
  vixyTrend:   number;      // VIXY 5-day slope
  spyScore:    number;      // 0–1
  vixyScore:   number;      // 0–1 (inverted — high fear = low score)
  vixLevel:    number;      // Raw VIX approximation (for kill switch)
  reason:      string;
  dataGaps:    string[];
  fetchedAt:   Date;
}

// Auth headers — same Alpaca credentials used for crypto trading
const alpacaHeaders = {
  'APCA-API-KEY-ID':     API.alpaca.key,
  'APCA-API-SECRET-KEY': API.alpaca.secret,
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — analyzeMacro
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeMacro(): Promise<MacroResult> {
  const dataGaps: string[] = [];

  // Fetch SPY trend, VIXY trend, and today's SPY pre-market change in parallel
  const [spy, vixy, spySnapshot] = await Promise.all([
    fetchETFTrend('SPY',  dataGaps),
    fetchETFTrend('VIXY', dataGaps),
    getEquitySnapshot('SPY').catch(() => null),
  ]);

  // Fetch raw VIX level for the kill switch check
  let vixLevel = 20; // Neutral fallback
  try {
    vixLevel = await fetchVixFromData();
  } catch {
    dataGaps.push('VIX level unavailable — using 20 (neutral)');
  }

  // Convert 5-day trend slopes to 0–1 scores.
  const spyTrendScore  = trendToScore(spy.slope,  MACRO_CONFIG.spySlopeRange,  true);
  const vixyScore      = trendToScore(vixy.slope, MACRO_CONFIG.vixySlopeRange, false);

  // Blend in today's pre-market SPY change (30% weight) to make the signal current.
  // The 5-day slope tells us the trend; today's move tells us the momentum right now.
  let spyScore = spyTrendScore;
  if (spySnapshot?.latestPrice && spy.price > 0) {
    const todayChangePct = (spySnapshot.latestPrice - spy.price) / spy.price;
    const todayScore     = trendToScore(todayChangePct * 100, MACRO_CONFIG.spySlopeRange, true);
    spyScore = Math.round((spyTrendScore * 0.70 + todayScore * 0.30) * 1000) / 1000;
  }

  // Combine using configured weights
  const rawScore = (spyScore * MACRO_CONFIG.weights.spy) + (vixyScore * MACRO_CONFIG.weights.vixy);
  const score    = Math.round(Math.max(0, Math.min(1, rawScore)) * 1000) / 1000;

  const environment: MacroResult['environment'] =
    score >= MACRO_CONFIG.riskOnThreshold  ? 'risk_on'  :
    score <= MACRO_CONFIG.riskOffThreshold ? 'risk_off' : 'neutral';

  const reason = buildReason(environment, spy, vixy, spyScore, vixyScore);

  return {
    score,
    environment,
    spyTrend:   spy.slope,
    vixyTrend:  vixy.slope,
    spyScore:   Math.round(spyScore  * 1000) / 1000,
    vixyScore:  Math.round(vixyScore * 1000) / 1000,
    vixLevel:   Math.round(vixLevel  * 100)  / 100,
    reason,
    dataGaps,
    fetchedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — getVixLevel
// Allows other modules (preMarketFilter) to get the current VIX level
// without running the full macro analysis.
// ─────────────────────────────────────────────────────────────────────────────
export async function getVixLevel(): Promise<number> {
  return fetchVixFromData();
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH ETF TREND
// Gets the last 10 daily bars and fits a linear slope to measure the trend.
// The slope (% change per day) is more reliable than a single day's change.
//
// Example: SPY was 500, 498, 502, 505, 508, 510 over 6 days
//   → slope ≈ +0.40% per day → clearly trending up → bullish for crypto
//
// Example: SPY was 510, 506, 503, 500, 497, 495 over 6 days
//   → slope ≈ -0.60% per day → clearly falling → bearish for crypto
// ─────────────────────────────────────────────────────────────────────────────

interface ETFData {
  symbol: string;
  slope:  number;   // Linear regression slope as % per day
  price:  number;   // Latest close price
  bars:   number;   // How many bars were used
}

async function fetchETFTrend(ticker: string, dataGaps: string[]): Promise<ETFData> {
  try {
    const data = await retry(`Alpaca ETF bars (${ticker})`, async () => {
      // Fetch last 14 calendar days — guarantees at least 10 trading day bars
      const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const res   = await fetch(
        `${API.alpacaData.baseUrl}/v2/stocks/bars?symbols=${ticker}&timeframe=1Day&start=${start}&limit=10&sort=asc`,
        { headers: alpacaHeaders }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json() as Promise<{
        bars: Record<string, { t: string; c: number }[]>;
      }>;
    });

    const bars = data.bars[ticker];
    if (!bars || bars.length < 3) {
      throw new Error(`Not enough bars for ${ticker}: got ${bars?.length ?? 0}`);
    }

    const prices = bars.map(b => b.c);
    const slope  = computeLinearSlope(prices);

    return {
      symbol: ticker,
      slope:  Math.round(slope * 10000) / 10000,  // 4 decimal places
      price:  prices[prices.length - 1],
      bars:   prices.length,
    };

  } catch (err) {
    dataGaps.push(`${ticker} data unavailable: ${err instanceof Error ? err.message : 'unknown'}`);
    return { symbol: ticker, slope: 0, price: 0, bars: 0 };  // Neutral fallback
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LINEAR SLOPE CALCULATION
//
// Fits a straight line through price data and returns the slope as % per day.
// This is called "linear regression" — it finds the line that best describes
// the price trend, ignoring day-to-day noise.
//
// Returns % daily change — e.g. 0.30 = price trending up 0.30% per day.
// ─────────────────────────────────────────────────────────────────────────────
function computeLinearSlope(prices: number[]): number {
  const n = prices.length;
  if (n < 2) return 0;

  // x values are just 0, 1, 2, ... n-1 (day index)
  // y values are the prices
  const xMean = (n - 1) / 2;
  const yMean = prices.reduce((a, b) => a + b, 0) / n;

  let numerator   = 0;
  let denominator = 0;

  for (let i = 0; i < n; i++) {
    numerator   += (i - xMean) * (prices[i] - yMean);
    denominator += (i - xMean) ** 2;
  }

  if (denominator === 0) return 0;

  // Raw slope in price units per day → convert to % per day relative to mean price
  const rawSlope = numerator / denominator;
  return yMean > 0 ? (rawSlope / yMean) * 100 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Convert a trend slope (% per day) to a 0–1 score.
// range: the slope value that maps to the extreme (±0.45 from neutral 0.50)
// positive: if true, positive slope → higher score (SPY trending up = good)
//           if false, positive slope → lower score (UUP/VIXY trending up = bad)
function trendToScore(slope: number, range: number, positive: boolean): number {
  const direction  = positive ? 1 : -1;
  const normalized = (slope * direction) / range;  // -1 to +1 roughly
  const score      = 0.50 + (normalized * 0.40);   // 0.10 to 0.90 range
  return Math.max(0.05, Math.min(0.95, score));
}

function buildReason(
  env:       MacroResult['environment'],
  spy:       ETFData,
  vixy:      ETFData,
  spyScore:  number,
  vixyScore: number,
): string {
  const slopeSign = (n: number) => n >= 0 ? `+${n.toFixed(3)}%/day` : `${n.toFixed(3)}%/day`;

  return [
    `Macro: ${env} (${spy.bars}-day trend)`,
    `SPY trend ${slopeSign(spy.slope)} (score: ${(spyScore * 100).toFixed(0)}%)`,
    `VIX/VIXY trend ${slopeSign(vixy.slope)} (score: ${(vixyScore * 100).toFixed(0)}%)`,
  ].join(' | ');
}
