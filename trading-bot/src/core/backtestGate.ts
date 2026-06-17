import { API } from '../config.js';
import { retry } from '../core/retry.js';
import { log } from '../core/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTIVE BACKTEST GATE
//
// Instead of a hardcoded Sharpe minimum (e.g. always require 0.5), this module
// looks at the current market environment and decides what bar is fair to set.
//
// WHY THIS EXISTS:
//   A Sharpe ratio measures risk-adjusted return. In a brutal bear market,
//   even the best strategies look bad on paper because prices just fall.
//   Holding a fixed minimum of 0.5 in those conditions blocks the bot from
//   running even when its strategy is genuinely working (losing less than
//   the market IS skill). This module corrects for that.
//
// TWO INPUTS COMBINED:
//
//   1. BENCHMARK COMPARISON (Option B)
//      Compare strategy return vs. simply holding BTC over the same period.
//      If the strategy beats buy-and-hold, the minimum Sharpe is relaxed.
//      "You outperformed the market" is real alpha — even in a downturn.
//
//      Example: BTC fell 15%, strategy lost only 4% → outperformed by 11%
//      → Sharpe minimum lowered because the strategy is doing its job.
//
//   2. VOLATILITY SCALING (Option C)
//      VIXY (VIX short-term futures ETF) measures fear in the market.
//      High fear = extreme price swings = every strategy looks worse.
//      We use VIXY's recent % change to automatically lower the bar during
//      high-volatility periods, and raise it back when markets calm down.
//
//      VIXY rising 20%+ → market is in fear → minimum drops significantly
//      VIXY flat/falling → calm market → minimum stays high
//
// FINAL MINIMUM = base minimum × regime multiplier × volatility multiplier
//   Floored at -1.0 (we'll never require a negative Sharpe below -1)
//   Ceilinged at 0.5 (we never raise the bar above the original minimum)
//
// OUTPUT:
//   AdaptiveGateResult — the computed minimum, both multipliers, and a full
//   human-readable explanation of why it landed where it did.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdaptiveGateResult {
  adaptedMinimumSharpe: number;    // The final minimum to use in the backtest
  baseMinimum:          number;    // The original config minimum (0.5)
  regimeMultiplier:     number;    // Adjustment from benchmark comparison (0.4–1.0)
  volatilityMultiplier: number;    // Adjustment from VIXY reading (0.5–1.0)
  btcReturn30d:         number;    // BTC's actual 30-day % return
  vixyChange:           number;    // VIXY recent % change
  marketRegime:         'bull' | 'bear' | 'sideways';
  volatilityRegime:     'calm' | 'elevated' | 'extreme';
  reason:               string;    // Full explanation for logs
}

// The original config minimum — we never raise above this
const BASE_MINIMUM_SHARPE = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — computeAdaptiveGate
// ─────────────────────────────────────────────────────────────────────────────
export async function computeAdaptiveGate(
  strategyReturnPct: number,   // The backtest's total return % (e.g. -0.04 = -4%)
): Promise<AdaptiveGateResult> {

  // Fetch both inputs in parallel — neither blocks the other
  const [btcReturn, vixyChange] = await Promise.all([
    fetchBtcReturn30d(),
    fetchVixyChange(),
  ]);

  // ── Input 1: Benchmark comparison → regime multiplier ────────────────────
  //
  // We compare strategy return vs BTC buy-and-hold over the same period.
  // The "outperformance" (alpha) tells us how much credit to give the strategy.
  //
  // strategyReturn = -4%,  btcReturn = -15% → alpha = +11% (strong outperformance)
  // strategyReturn = -10%, btcReturn = -15% → alpha = +5%  (mild outperformance)
  // strategyReturn = -15%, btcReturn = -15% → alpha = 0%   (matched the market)
  // strategyReturn = -20%, btcReturn = -15% → alpha = -5%  (underperformed)
  //
  // We translate alpha into a regime multiplier (how much to relax the minimum):
  //   Alpha > +10%  (strong outperformance) → multiplier = 0.4 (cut minimum by 60%)
  //   Alpha > +5%   (solid outperformance)  → multiplier = 0.6 (cut by 40%)
  //   Alpha > 0%    (any outperformance)    → multiplier = 0.8 (cut by 20%)
  //   Alpha ≤ 0%    (underperformed)        → multiplier = 1.0 (no relaxation)

  const alphaPct = (strategyReturnPct - btcReturn) * 100; // Convert to percentage points

  let regimeMultiplier: number;
  let marketRegime: AdaptiveGateResult['marketRegime'];

  if (btcReturn > 0.05) {
    marketRegime = 'bull';
  } else if (btcReturn < -0.05) {
    marketRegime = 'bear';
  } else {
    marketRegime = 'sideways';
  }

  if (alphaPct > 10) {
    regimeMultiplier = 0.4;   // Strategy crushed the market — be very generous
  } else if (alphaPct > 5) {
    regimeMultiplier = 0.6;   // Strategy meaningfully beat the market
  } else if (alphaPct > 0) {
    regimeMultiplier = 0.8;   // Strategy edged out the market
  } else {
    regimeMultiplier = 1.0;   // Strategy underperformed — no relaxation
  }

  // ── Input 2: VIXY → volatility multiplier ────────────────────────────────
  //
  // VIXY rising = fear spiking = every strategy's Sharpe gets hammered by noise.
  // We account for this by reducing the minimum proportionally to fear level.
  //
  // VIXY up 30%+  (extreme fear)    → multiplier = 0.5 (cut minimum by 50%)
  // VIXY up 15–30% (elevated fear)  → multiplier = 0.7 (cut by 30%)
  // VIXY up 5–15% (mild fear)       → multiplier = 0.85 (cut by 15%)
  // VIXY flat/down (calm)           → multiplier = 1.0  (no relaxation)

  let volatilityMultiplier: number;
  let volatilityRegime: AdaptiveGateResult['volatilityRegime'];

  if (vixyChange >= 30) {
    volatilityRegime     = 'extreme';
    volatilityMultiplier = 0.5;
  } else if (vixyChange >= 15) {
    volatilityRegime     = 'elevated';
    volatilityMultiplier = 0.7;
  } else if (vixyChange >= 5) {
    volatilityRegime     = 'elevated';
    volatilityMultiplier = 0.85;
  } else {
    volatilityRegime     = 'calm';
    volatilityMultiplier = 1.0;
  }

  // ── Combine: base × regime × volatility ──────────────────────────────────
  // Example: 0.5 × 0.6 × 0.7 = 0.21 (meaningful relaxation in a bear+fearful market)
  // Clamp: floor at -1.0, ceiling at BASE_MINIMUM (never raise the bar)
  const raw = BASE_MINIMUM_SHARPE * regimeMultiplier * volatilityMultiplier;
  const adaptedMinimumSharpe = Math.max(-1.0, Math.min(BASE_MINIMUM_SHARPE, raw));

  // ── Build human-readable explanation ─────────────────────────────────────
  const reason = buildReason(
    adaptedMinimumSharpe,
    BASE_MINIMUM_SHARPE,
    btcReturn,
    alphaPct,
    vixyChange,
    marketRegime,
    volatilityRegime,
    regimeMultiplier,
    volatilityMultiplier,
  );

  return {
    adaptedMinimumSharpe: Math.round(adaptedMinimumSharpe * 1000) / 1000,
    baseMinimum:          BASE_MINIMUM_SHARPE,
    regimeMultiplier:     Math.round(regimeMultiplier    * 100) / 100,
    volatilityMultiplier: Math.round(volatilityMultiplier * 100) / 100,
    btcReturn30d:         Math.round(btcReturn           * 10000) / 10000,
    vixyChange:           Math.round(vixyChange          * 100) / 100,
    marketRegime,
    volatilityRegime,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH BTC 30-DAY RETURN
// Uses Alpaca's crypto bars — already authenticated, same source as live trading.
// Grabs 35 daily bars to ensure we always have 30+ trading days.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchBtcReturn30d(): Promise<number> {
  try {
    const start = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const data = await retry('Alpaca BTC 30d bars', async () => {
      const res = await fetch(
        `${API.alpacaData.baseUrl}/v1beta3/crypto/us/bars?symbols=BTC%2FUSD&timeframe=1Day&start=${start}&limit=35&sort=asc`,
        {
          headers: {
            'APCA-API-KEY-ID':     API.alpaca.key,
            'APCA-API-SECRET-KEY': API.alpaca.secret,
          },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json() as Promise<{
        bars: Record<string, { t: string; c: number }[]>;
      }>;
    });

    const bars = data.bars['BTC/USD'];
    if (!bars || bars.length < 2) {
      log.warn('[AdaptiveGate] Not enough BTC bars for 30d return — using 0 (neutral)');
      return 0;
    }

    const oldest = bars[0].c;
    const newest = bars[bars.length - 1].c;
    return oldest > 0 ? (newest - oldest) / oldest : 0;

  } catch (err) {
    log.warn(`[AdaptiveGate] BTC 30d return fetch failed: ${err instanceof Error ? err.message : err} — using 0`);
    return 0;  // Neutral fallback — no relaxation from regime side
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH VIXY CHANGE
// VIXY is the ProShares VIX short-term futures ETF — a liquid proxy for the
// VIX fear index that trades on Alpaca. We fetch the last 5 days and compare
// the most recent close to 5 days ago to measure how much fear has risen.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchVixyChange(): Promise<number> {
  try {
    const start = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const data = await retry('Alpaca VIXY bars', async () => {
      const res = await fetch(
        `${API.alpacaData.baseUrl}/v2/stocks/bars?symbols=VIXY&timeframe=1Day&start=${start}&limit=8&sort=asc`,
        {
          headers: {
            'APCA-API-KEY-ID':     API.alpaca.key,
            'APCA-API-SECRET-KEY': API.alpaca.secret,
          },
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json() as Promise<{
        bars: Record<string, { t: string; c: number }[]>;
      }>;
    });

    const bars = data.bars['VIXY'];
    if (!bars || bars.length < 2) {
      log.warn('[AdaptiveGate] Not enough VIXY bars — using 0 (calm)');
      return 0;
    }

    const oldest = bars[0].c;
    const newest = bars[bars.length - 1].c;
    // Return as % change (e.g. 25 means VIXY rose 25%)
    return oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;

  } catch (err) {
    log.warn(`[AdaptiveGate] VIXY fetch failed: ${err instanceof Error ? err.message : err} — using 0 (calm)`);
    return 0;  // Neutral fallback — no relaxation from volatility side
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REASON BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildReason(
  adapted:    number,
  base:       number,
  btcReturn:  number,
  alphaPct:   number,
  vixyChange: number,
  marketRegime:     AdaptiveGateResult['marketRegime'],
  volatilityRegime: AdaptiveGateResult['volatilityRegime'],
  regimeMult:   number,
  volatilityMult: number,
): string {
  const sign = (n: number) => n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  const pct  = (n: number) => `${(n * 100).toFixed(1)}%`;

  const lines: string[] = [];
  lines.push(`Adaptive Sharpe minimum: ${adapted.toFixed(3)} (base: ${base})`);
  lines.push('');
  lines.push(`Market regime: ${marketRegime.toUpperCase()} — BTC 30d return: ${pct(btcReturn)}`);
  lines.push(`  Strategy alpha vs buy-and-hold: ${sign(alphaPct)}pp`);
  lines.push(`  Regime multiplier: ×${regimeMult} (${regimeMult < 1 ? 'relaxed — strategy outperformed the market' : 'no relaxation — strategy underperformed'})`);
  lines.push('');
  lines.push(`Volatility regime: ${volatilityRegime.toUpperCase()} — VIXY 5d change: ${sign(vixyChange)}%`);
  lines.push(`  Volatility multiplier: ×${volatilityMult} (${volatilityMult < 1 ? 'relaxed — high fear distorts Sharpe' : 'no relaxation — calm market'})`);
  lines.push('');
  lines.push(`Formula: ${base} × ${regimeMult} × ${volatilityMult} = ${adapted.toFixed(3)}`);

  if (adapted < 0) {
    lines.push(`Interpretation: minimum is NEGATIVE — strategy only needs to avoid catastrophic losses`);
  } else if (adapted < base) {
    lines.push(`Interpretation: bar LOWERED from ${base} → ${adapted.toFixed(3)} due to difficult market conditions`);
  } else {
    lines.push(`Interpretation: bar UNCHANGED at ${base} — calm market, full standard applies`);
  }

  return lines.join('\n');
}
