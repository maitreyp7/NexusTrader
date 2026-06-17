import { DecisionResult } from './decisionEngine.js';
import { ATRResult } from '../tools/indicators.js';
import { RISK, POSITION, COINS } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// RISK MANAGER — Component 6
//
// The last line of defense before any order touches the account.
// Takes an approved trade decision and answers two questions:
//   1. Should we trade? (hard limit checks)
//   2. How much should we trade? (position sizing)
//
// NOTHING overrides the Risk Manager. Not the AI, not the pattern,
// not the score. If it says no — the trade does not happen.
//
// POSITION SIZING — ATR-based (the right way):
//   Most retail traders use fixed dollar amounts ("I'll risk $100").
//   The problem: $100 on a calm BTC day is very different from $100 on a
//   volatile BTC day. ATR-based sizing automatically adjusts:
//
//   riskAmount    = portfolio × maxRiskPerTrade%    (e.g. $1,000 × 1% = $10)
//   stopDistance  = ATR × 1.5                       (e.g. $537 × 1.5 = $806)
//   positionSize  = riskAmount / stopDistance        (e.g. $10 / $806 = 0.012 BTC)
//   positionUsd   = positionSize × currentPrice      (e.g. 0.012 × $70k = $840)
//
//   High volatility → larger ATR → smaller position → less risk.
//   This is how professional quant funds do it.
//
// STOP-LOSS PLACEMENT:
//   Stop = entry - (ATR × 1.5)
//   Placed 1.5x ATR below entry — far enough to survive normal noise,
//   close enough to limit losses if the move fails.
//
// TAKE-PROFIT:
//   Partial exit (50%) at 3× the risk distance = 3:1 reward/risk ratio
//   Remainder trails with a 1.5% trailing stop
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioState {
  totalValue:          number;    // Total portfolio value in USD
  cash:                number;    // Available cash
  dailyPnL:            number;    // Today's realized P&L in USD
  dailyPnLPct:         number;    // Today's P&L as % of portfolio
  dailySpentUsd:       number;    // Total USD spent on trades today
  openPositions:       Record<string, OpenPosition>;
  consecutiveLosses:   number;    // Current losing streak
  circuitBreakerActive: boolean;  // Hard stop — no trading when true
}

export interface OpenPosition {
  symbol:       string;
  qty:          number;   // Actual share/unit count from Alpaca (never computed)
  sizeUsd:      number;   // Current USD value of position
  entryPrice:   number;
  currentPrice: number;
  unrealizedPnL: number;
}

export interface TradeParameters {
  positionSizeUsd:   number;   // How much USD to spend
  positionSizeCoins: number;   // How many coins to buy (positionSizeUsd / price)
  entryPrice:        number;   // Expected entry (current market price)
  stopLossPrice:     number;   // Exit immediately if price falls here
  partialProfitPrice: number;  // Sell 50% here (entry + 1× range size) — lock in partial gain
  takeProfitPrice:   number;   // Trail remaining 50% to this full target (entry + 2× range size)
  trailingStopPct:   number;   // Trail remaining position by this %
  breakEvenTriggerPct: number; // Move stop to entry after this % gain
  riskAmount:        number;   // Max $ we lose if stop is hit
  riskPct:           number;   // Max % of portfolio we lose if stop is hit
  stopLossDistance:  number;   // $ from entry to stop
  rewardRiskRatio:   number;   // How much we make vs risk (target: 3:1)
}

export interface RiskAssessment {
  approved:        boolean;
  blockedReason?:  string;        // Why blocked (if applicable)
  trade?:          TradeParameters; // Populated only if approved
  checksPerformed: RiskCheck[];   // Full audit trail of every check
  assessedAt:      Date;
}

export interface RiskCheck {
  name:   string;
  passed: boolean;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — assessRisk
// ─────────────────────────────────────────────────────────────────────────────
export function assessRisk(
  decision:     DecisionResult,
  atr:          ATRResult,
  currentPrice: number,
  portfolio:    PortfolioState,
  symbol:       string,
): RiskAssessment {
  const checks: RiskCheck[] = [];

  // ── Gate 0: Decision must be BUY ──────────────────────────────────────────
  // Risk Manager only sizes positions for BUY decisions.
  // SELL decisions have their own logic (closing existing positions).
  if (decision.action !== 'BUY') {
    return {
      approved: false,
      blockedReason: `Decision is ${decision.action} — Risk Manager only processes BUY decisions`,
      checksPerformed: [],
      assessedAt: new Date(),
    };
  }

  // ── Gate 1: Circuit breaker ────────────────────────────────────────────────
  checks.push(check(
    'Circuit breaker inactive',
    !portfolio.circuitBreakerActive,
    portfolio.circuitBreakerActive
      ? 'CIRCUIT BREAKER ACTIVE — all trading halted'
      : 'Circuit breaker not triggered',
  ));

  // ── Gate 2: Daily loss limit ───────────────────────────────────────────────
  const dailyLossOk = portfolio.dailyPnL >= -RISK.maxDailyLossUsd &&
                      portfolio.dailyPnLPct >= -RISK.maxDailyLossPct;
  checks.push(check(
    'Daily loss limit not hit',
    dailyLossOk,
    `Daily P&L: $${portfolio.dailyPnL.toFixed(2)} (${(portfolio.dailyPnLPct * 100).toFixed(2)}%) | Limit: -$${RISK.maxDailyLossUsd} / -${(RISK.maxDailyLossPct * 100).toFixed(0)}%`,
  ));

  // ── Gate 3: Consecutive losses ─────────────────────────────────────────────
  checks.push(check(
    'Consecutive loss limit not hit',
    portfolio.consecutiveLosses < RISK.maxConsecutiveLosses,
    `${portfolio.consecutiveLosses} consecutive losses | Limit: ${RISK.maxConsecutiveLosses}`,
  ));

  // ── Gate 4: Daily spend cap ────────────────────────────────────────────────
  const remainingDailyBudget = RISK.maxDailySpendUsd - portfolio.dailySpentUsd;
  checks.push(check(
    'Daily spend budget available',
    remainingDailyBudget > 0,
    `Spent today: $${portfolio.dailySpentUsd.toFixed(2)} | Budget: $${RISK.maxDailySpendUsd} | Remaining: $${remainingDailyBudget.toFixed(2)}`,
  ));

  // ── Gate 5: Total exposure limit ──────────────────────────────────────────
  const currentExposure = Object.values(portfolio.openPositions)
    .reduce((sum, pos) => sum + pos.sizeUsd, 0);
  checks.push(check(
    'Total exposure under limit',
    currentExposure < RISK.maxTotalExposureUsd,
    `Current exposure: $${currentExposure.toFixed(2)} | Limit: $${RISK.maxTotalExposureUsd}`,
  ));

  // ── Gate 6: Cash reserve ───────────────────────────────────────────────────
  const minCashRequired = portfolio.totalValue * RISK.minCashReservePct;
  checks.push(check(
    'Minimum cash reserve maintained',
    portfolio.cash >= minCashRequired,
    `Cash: $${portfolio.cash.toFixed(2)} | Minimum required: $${minCashRequired.toFixed(2)} (${(RISK.minCashReservePct * 100).toFixed(0)}%)`,
  ));

  // ── Gate 7: Portfolio usage cap ────────────────────────────────────────────
  const maxUsablePortfolio = portfolio.totalValue * RISK.maxPortfolioUsagePct;
  const usedPortfolio      = portfolio.totalValue - portfolio.cash;
  checks.push(check(
    'Portfolio usage cap not exceeded',
    usedPortfolio < maxUsablePortfolio,
    `Used: $${usedPortfolio.toFixed(2)} | Cap: $${maxUsablePortfolio.toFixed(2)} (${(RISK.maxPortfolioUsagePct * 100).toFixed(0)}% of portfolio)`,
  ));

  // ── Gate 8: Correlation check ──────────────────────────────────────────────
  // Find the correlation group this symbol belongs to (e.g. BTC+ETH move together)
  const correlationGroup = RISK.correlatedGroups.find(g => (g as readonly string[]).includes(symbol)) ?? [];
  const correlationExposure = correlationGroup.reduce((sum, correlated) => {
    return sum + (portfolio.openPositions[correlated]?.sizeUsd ?? 0);
  }, 0);
  const maxGroupExposure = portfolio.totalValue * RISK.maxPositionSizePct * 2; // 2x single limit for group
  checks.push(check(
    'Correlated asset exposure within limits',
    correlationExposure < maxGroupExposure,
    `Group exposure: $${correlationExposure.toFixed(2)} | Limit: $${maxGroupExposure.toFixed(2)}`,
  ));

  // ── Gate 9: ATR volatility check ──────────────────────────────────────────
  checks.push(check(
    'Volatility within tradeable range',
    atr.atrPct <= RISK.maxVolatilityToTrade,
    `ATR: ${(atr.atrPct * 100).toFixed(2)}% | Limit: ${(RISK.maxVolatilityToTrade * 100).toFixed(0)}%`,
  ));

  // ── Block if any gate failed ───────────────────────────────────────────────
  const failedCheck = checks.find(c => !c.passed);
  if (failedCheck) {
    return {
      approved: false,
      blockedReason: `${failedCheck.name}: ${failedCheck.detail}`,
      checksPerformed: checks,
      assessedAt: new Date(),
    };
  }

  // ── Calculate position size ────────────────────────────────────────────────
  const trade = calculateTradeParameters(atr, currentPrice, portfolio, remainingDailyBudget, currentExposure, symbol);

  // ── Gate 10: Final size validation ────────────────────────────────────────
  // After calculating position size, make sure it's still meaningful
  const volMult = RISK.symbolVolatilityMultipliers[symbol] ?? 0.70;
  checks.push(check(
    'Position size is meaningful (> $10)',
    trade.positionSizeUsd >= 10,
    `Calculated size: $${trade.positionSizeUsd.toFixed(2)} (volatility multiplier: ${volMult}× for ${symbol})`,
  ));

  if (trade.positionSizeUsd < 10) {
    return {
      approved: false,
      blockedReason: `Position size too small after limits applied: $${trade.positionSizeUsd.toFixed(2)}`,
      checksPerformed: checks,
      assessedAt: new Date(),
    };
  }

  return {
    approved: true,
    trade,
    checksPerformed: checks,
    assessedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CIRCUIT BREAKER — checkCircuitBreaker
// Call this at the start of every session to decide if trading should begin.
// ─────────────────────────────────────────────────────────────────────────────
export function checkCircuitBreaker(portfolio: PortfolioState, atr: ATRResult): {
  active: boolean;
  reason?: string;
} {
  if (portfolio.dailyPnL <= -RISK.maxDailyLossUsd) {
    return { active: true, reason: `Daily loss limit hit: $${portfolio.dailyPnL.toFixed(2)}` };
  }
  if (portfolio.dailyPnLPct <= -RISK.maxDailyLossPct) {
    return { active: true, reason: `Daily loss % limit hit: ${(portfolio.dailyPnLPct * 100).toFixed(2)}%` };
  }
  if (portfolio.consecutiveLosses >= RISK.maxConsecutiveLosses) {
    return { active: true, reason: `${portfolio.consecutiveLosses} consecutive losses — cooling off` };
  }
  if (atr.atrPct > RISK.maxVolatilityToTrade) {
    return { active: true, reason: `Extreme volatility: ATR ${(atr.atrPct * 100).toFixed(2)}% > ${(RISK.maxVolatilityToTrade * 100).toFixed(0)}% limit` };
  }
  return { active: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITION SIZE CALCULATOR — ATR-based
// ─────────────────────────────────────────────────────────────────────────────
function calculateTradeParameters(
  atr: ATRResult,
  currentPrice: number,
  portfolio: PortfolioState,
  remainingDailyBudget: number,
  currentExposure: number,
  symbol: string,
): TradeParameters {
  // Step 1: Calculate risk amount (1% of portfolio value)
  // Apply per-coin volatility multiplier: more volatile coins get smaller positions
  // so that the ACTUAL dollar risk is consistent across all coins.
  // e.g. DOGE (0.40) → risk only 40% as much per trade as BTC (1.0)
  const volatilityMultiplier = RISK.symbolVolatilityMultipliers[symbol] ?? 0.70; // Default to 0.70 for unknown coins
  const riskAmount = portfolio.totalValue * RISK.maxRiskPerTradePct * volatilityMultiplier;

  // Step 2: Stop distance = 1.5× ATR
  // 1.5× gives enough room for normal price noise while limiting loss
  const stopLossDistance = atr.value * 1.5;
  const stopLossPrice    = currentPrice - stopLossDistance;
  const stopLossPct      = stopLossDistance / currentPrice;

  // Step 3: Position size in coins = risk / stop distance
  const positionSizeCoinsRaw = riskAmount / stopLossDistance;
  const positionSizeUsdRaw   = positionSizeCoinsRaw * currentPrice;

  // Step 4: Apply hard caps (take the smallest of all limits).
  // Each cap is clamped to 0 so a negative headroom never makes position size negative.
  const maxByPortfolio = Math.max(0, portfolio.totalValue * RISK.maxPositionSizePct);
  const maxByExposure  = Math.max(0, RISK.maxTotalExposureUsd - currentExposure);
  const maxByCash      = Math.max(0, portfolio.cash - (portfolio.totalValue * RISK.minCashReservePct));
  const maxByDaily     = Math.max(0, remainingDailyBudget);
  const maxByConfig    = RISK.maxTradeSizeUsd;

  const positionSizeUsd = Math.min(
    positionSizeUsdRaw,
    maxByPortfolio,
    maxByExposure,
    maxByCash,
    maxByDaily,
    maxByConfig,
  );

  // Recalculate coins after capping
  const positionSizeCoins = positionSizeUsd / currentPrice;

  // Step 5: Partial profit at 1× risk distance, full target at 3×
  // Sell 50% at partialProfitPrice to lock in a guaranteed gain,
  // then trail the remaining 50% to takeProfitPrice.
  const takeProfitDistance    = stopLossDistance * 3;
  const partialProfitDistance = stopLossDistance * 1;
  const takeProfitPrice       = currentPrice + takeProfitDistance;
  const partialProfitPrice    = currentPrice + partialProfitDistance;
  const rewardRiskRatio       = takeProfitDistance / stopLossDistance;

  // Actual risk after capping (may be less than original riskAmount)
  const actualRiskAmount = positionSizeCoins * stopLossDistance;
  const actualRiskPct    = actualRiskAmount / portfolio.totalValue;

  return {
    positionSizeUsd:     Math.round(positionSizeUsd        * 100) / 100,
    positionSizeCoins:   Math.round(positionSizeCoins      * 1e8) / 1e8,
    entryPrice:          currentPrice,
    stopLossPrice:       Math.round(stopLossPrice           * 100) / 100,
    partialProfitPrice:  Math.round(partialProfitPrice      * 100) / 100,
    takeProfitPrice:     Math.round(takeProfitPrice         * 100) / 100,
    trailingStopPct:     POSITION.exit.trailingStopPct,
    breakEvenTriggerPct: POSITION.exit.breakEvenTriggerPct,
    riskAmount:          Math.round(actualRiskAmount        * 100) / 100,
    riskPct:             Math.round(actualRiskPct           * 10000) / 10000,
    stopLossDistance:    Math.round(stopLossDistance        * 100) / 100,
    rewardRiskRatio:     Math.round(rewardRiskRatio         * 100) / 100,
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function check(name: string, passed: boolean, detail: string): RiskCheck {
  return { name, passed, detail };
}
