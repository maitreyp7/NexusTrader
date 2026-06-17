import { assessRisk, checkCircuitBreaker, PortfolioState } from './riskManager.js';
import { getOHLCV } from '../tools/marketData.js';
import { computeIndicators, computeATR } from '../tools/indicators.js';
import { DecisionResult } from './decisionEngine.js';
import { RISK } from '../config.js';

async function runTests() {
  console.log('\n🛡️  Testing Risk Manager...\n');
  let passed = 0; let failed = 0;

  function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // ── Fetch live data to get a real ATR value ───────────────────────────────
  const btc1h = await getOHLCV('BTC/USD', '1h', 100);
  const suite  = computeIndicators(btc1h.candles, '1h');
  const candles = btc1h.candles;
  const atr = computeATR(
    candles.map(c => c.high),
    candles.map(c => c.low),
    candles.map(c => c.close),
    14,
  );
  const currentPrice = candles[candles.length - 1].close;

  console.log(`  📊 Live BTC price: $${currentPrice.toFixed(2)}`);
  console.log(`  📊 ATR: $${atr.value.toFixed(2)} (${(atr.atrPct * 100).toFixed(3)}%)\n`);

  // ── Shared test fixtures ───────────────────────────────────────────────────

  const buyDecision: DecisionResult = {
    action: 'BUY',
    finalScore: 0.75,
    threshold: 0.65,
    confidence: 0.80,
    scores: { technical: 0.75, microstructure: 0.72, sentiment: 0.70, whale: 0.65, macro: 0.68 },
    weights: { technical: 0.30, microstructure: 0.15, sentiment: 0.20, whale: 0.20, macro: 0.15 },
    pattern: 'Trend Pullback',
    dataGaps: [],
    tradeable: true,
    blockedBy: null,
    reason: 'Test BUY decision',
    decidedAt: new Date(),
  };

  const holdDecision: DecisionResult = { ...buyDecision, action: 'HOLD' };
  const sellDecision: DecisionResult = { ...buyDecision, action: 'SELL' };

  // A healthy portfolio: $10,000 total, $9,500 cash, no open positions.
  // Cash must be >90% of total to pass the 10% portfolio usage cap gate.
  // (used = $10k - $9.5k = $500, cap = $10k × 10% = $1,000 → passes)
  const healthyPortfolio: PortfolioState = {
    totalValue:           10_000,
    cash:                 9_500,
    dailyPnL:             0,
    dailyPnLPct:          0,
    dailySpentUsd:        0,
    openPositions:        {},
    consecutiveLosses:    0,
    circuitBreakerActive: false,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // GATE TESTS: Each gate should block the trade when triggered
  // ─────────────────────────────────────────────────────────────────────────

  // ── Gate 0: Only BUY decisions pass through ───────────────────────────────
  test('HOLD decision → not processed', () => {
    const result = assessRisk(holdDecision, atr, currentPrice, healthyPortfolio, 'BTC/USD');
    if (result.approved) throw new Error('HOLD should never be approved');
    if (!result.blockedReason?.includes('HOLD')) throw new Error(`Wrong reason: ${result.blockedReason}`);
  });

  test('SELL decision → not processed', () => {
    const result = assessRisk(sellDecision, atr, currentPrice, healthyPortfolio, 'BTC/USD');
    if (result.approved) throw new Error('SELL should never be approved');
  });

  // ── Gate 1: Circuit breaker ───────────────────────────────────────────────
  test('Circuit breaker active → blocked', () => {
    const portfolio: PortfolioState = { ...healthyPortfolio, circuitBreakerActive: true };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (result.approved) throw new Error('Should be blocked by circuit breaker');
    const check = result.checksPerformed.find(c => c.name === 'Circuit breaker inactive');
    if (!check || check.passed) throw new Error('Circuit breaker check should have failed');
  });

  // ── Gate 2: Daily loss limit ───────────────────────────────────────────────
  test('Daily loss exceeded ($) → blocked', () => {
    const portfolio: PortfolioState = { ...healthyPortfolio, dailyPnL: -(RISK.maxDailyLossUsd + 1) };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (result.approved) throw new Error('Should be blocked by daily $ loss');
  });

  test('Daily loss exceeded (%) → blocked', () => {
    const portfolio: PortfolioState = { ...healthyPortfolio, dailyPnLPct: -(RISK.maxDailyLossPct + 0.01) };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (result.approved) throw new Error('Should be blocked by daily % loss');
  });

  // ── Gate 3: Consecutive losses ────────────────────────────────────────────
  test('Max consecutive losses hit → blocked', () => {
    const portfolio: PortfolioState = { ...healthyPortfolio, consecutiveLosses: RISK.maxConsecutiveLosses };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (result.approved) throw new Error('Should be blocked by consecutive losses');
    console.log(`       Blocked after ${RISK.maxConsecutiveLosses} consecutive losses ✓`);
  });

  // ── Gate 4: Daily spend cap ───────────────────────────────────────────────
  test('Daily budget exhausted → blocked', () => {
    const portfolio: PortfolioState = { ...healthyPortfolio, dailySpentUsd: RISK.maxDailySpendUsd };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (result.approved) throw new Error('Should be blocked by daily spend cap');
  });

  // ── Gate 5: Total exposure limit ──────────────────────────────────────────
  test('Total exposure at limit → blocked', () => {
    const portfolio: PortfolioState = {
      ...healthyPortfolio,
      openPositions: {
        'BTC/USD': { symbol: 'BTC/USD', qty: 1, sizeUsd: RISK.maxTotalExposureUsd, entryPrice: currentPrice, currentPrice, unrealizedPnL: 0 },
      },
    };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'ETH/USD');
    if (result.approved) throw new Error('Should be blocked by total exposure');
  });

  // ── Gate 6: Cash reserve ─────────────────────────────────────────────────
  test('Cash below minimum reserve → blocked', () => {
    // Gate 6 is evaluated before Gate 7, so even though used=$8,000 also
    // exceeds the usage cap, Gate 6 (cash reserve) fires first and returns.
    // $2,000 cash < $3,000 required (30% of $10,000 portfolio).
    const portfolio: PortfolioState = { ...healthyPortfolio, cash: 2_000 };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (result.approved) throw new Error('Should be blocked by cash reserve');
    console.log(`       Cash reserve: $2,000 < $${(10_000 * RISK.minCashReservePct).toFixed(0)} required ✓`);
  });

  // ── Gate 7: Portfolio usage cap ────────────────────────────────────────────
  test('Portfolio usage cap exceeded → blocked', () => {
    // maxPortfolioUsagePct=10% → cap is $900 for $9,000 portfolio
    // Cash=$8,000: used = $9,000 - $8,000 = $1,000 > $900 cap
    // Cash ($8,000) > minCashReserve ($2,700) → Gate 6 passes, Gate 7 fires
    const portfolio: PortfolioState = { ...healthyPortfolio, totalValue: 9_000, cash: 8_000 };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (result.approved) throw new Error('Should be blocked by portfolio usage cap');
    console.log(`       Portfolio usage: $${9_000 - 8_000} > $${9_000 * RISK.maxPortfolioUsagePct} cap ✓`);
  });

  // ── Gate 9: Volatility limit ─────────────────────────────────────────────
  test('Extreme volatility → blocked', () => {
    const extremeAtr = { ...atr, atrPct: RISK.maxVolatilityToTrade + 0.01 };
    const result = assessRisk(buyDecision, extremeAtr, currentPrice, healthyPortfolio, 'BTC/USD');
    if (result.approved) throw new Error('Should be blocked by volatility');
    console.log(`       Blocked at ATR ${((RISK.maxVolatilityToTrade + 0.01) * 100).toFixed(0)}% > ${(RISK.maxVolatilityToTrade * 100).toFixed(0)}% limit ✓`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // APPROVAL TEST: Happy path — everything green
  // ─────────────────────────────────────────────────────────────────────────
  test('Healthy portfolio → approved with trade parameters', () => {
    const result = assessRisk(buyDecision, atr, currentPrice, healthyPortfolio, 'BTC/USD');

    if (!result.approved) throw new Error(`Should be approved. Blocked: ${result.blockedReason}`);
    if (!result.trade)    throw new Error('Missing trade parameters');

    const t = result.trade;

    // Validate trade structure
    if (t.positionSizeUsd <= 0)   throw new Error(`Invalid position size: $${t.positionSizeUsd}`);
    if (t.positionSizeCoins <= 0) throw new Error(`Invalid coin amount: ${t.positionSizeCoins}`);
    if (t.stopLossPrice >= t.entryPrice) throw new Error('Stop loss must be below entry');
    if (t.takeProfitPrice <= t.entryPrice) throw new Error('Take profit must be above entry');
    if (t.rewardRiskRatio < 2.9) throw new Error(`Reward/risk ratio too low: ${t.rewardRiskRatio}`);

    // Validate hard caps are respected
    if (t.positionSizeUsd > RISK.maxTradeSizeUsd)   throw new Error(`Position $${t.positionSizeUsd} exceeds max $${RISK.maxTradeSizeUsd}`);
    if (t.positionSizeUsd > RISK.maxTotalExposureUsd) throw new Error('Position exceeds total exposure limit');

    console.log(`\n       ┌─ Risk Assessment Output ────────────────────────`);
    console.log(`       │  Entry:       $${t.entryPrice.toFixed(2)}`);
    console.log(`       │  Stop loss:   $${t.stopLossPrice.toFixed(2)} (-$${t.stopLossDistance.toFixed(2)})`);
    console.log(`       │  Take profit: $${t.takeProfitPrice.toFixed(2)}`);
    console.log(`       │  Position:    $${t.positionSizeUsd.toFixed(2)} (${t.positionSizeCoins.toFixed(8)} BTC)`);
    console.log(`       │  Risk:        $${t.riskAmount.toFixed(2)} (${(t.riskPct * 100).toFixed(3)}%)`);
    console.log(`       │  R/R Ratio:   ${t.rewardRiskRatio}:1`);
    console.log(`       │  Trailing:    ${(t.trailingStopPct * 100).toFixed(1)}%`);
    console.log(`       └────────────────────────────────────────────────────\n`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POSITION SIZING TESTS
  // ─────────────────────────────────────────────────────────────────────────
  test('Position size respects maxTradeSizeUsd ($100 cap)', () => {
    // Even with a large portfolio, max single trade is $100.
    // Cash=95% of total so portfolio usage gate passes (used=5% < 10% cap).
    const bigPortfolio: PortfolioState = { ...healthyPortfolio, totalValue: 1_000_000, cash: 950_000 };
    const result = assessRisk(buyDecision, atr, currentPrice, bigPortfolio, 'BTC/USD');
    if (!result.trade) throw new Error(`Expected trade parameters. Blocked: ${result.blockedReason}`);
    if (result.trade.positionSizeUsd > RISK.maxTradeSizeUsd) {
      throw new Error(`Cap not enforced: $${result.trade.positionSizeUsd} > $${RISK.maxTradeSizeUsd}`);
    }
    console.log(`       Capped at $${result.trade.positionSizeUsd.toFixed(2)} ✓`);
  });

  test('Position size respects remaining daily budget', () => {
    // Already spent $250, only $50 budget remains.
    // healthyPortfolio already has cash=9,500 (used=500 < 1,000 cap) — passes Gate 7.
    const portfolio: PortfolioState = { ...healthyPortfolio, dailySpentUsd: 250 };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (!result.trade) throw new Error(`Expected trade parameters. Blocked: ${result.blockedReason}`);
    if (result.trade.positionSizeUsd > 50) {
      throw new Error(`Should be capped at $50 remaining budget, got $${result.trade.positionSizeUsd}`);
    }
    console.log(`       Budget cap: $${result.trade.positionSizeUsd.toFixed(2)} ≤ $50 remaining ✓`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CIRCUIT BREAKER FUNCTION TESTS
  // ─────────────────────────────────────────────────────────────────────────
  test('checkCircuitBreaker — healthy portfolio → inactive', () => {
    const cb = checkCircuitBreaker(healthyPortfolio, atr);
    if (cb.active) throw new Error(`Circuit breaker should be inactive: ${cb.reason}`);
  });

  test('checkCircuitBreaker — daily $ loss → active', () => {
    const portfolio: PortfolioState = { ...healthyPortfolio, dailyPnL: -(RISK.maxDailyLossUsd + 1) };
    const cb = checkCircuitBreaker(portfolio, atr);
    if (!cb.active) throw new Error('Circuit breaker should be active');
    console.log(`       Triggered: ${cb.reason}`);
  });

  test('checkCircuitBreaker — consecutive losses → active', () => {
    const portfolio: PortfolioState = { ...healthyPortfolio, consecutiveLosses: RISK.maxConsecutiveLosses };
    const cb = checkCircuitBreaker(portfolio, atr);
    if (!cb.active) throw new Error('Circuit breaker should be active');
    console.log(`       Triggered: ${cb.reason}`);
  });

  test('checkCircuitBreaker — extreme volatility → active', () => {
    const extremeAtr = { ...atr, atrPct: RISK.maxVolatilityToTrade + 0.01 };
    const cb = checkCircuitBreaker(healthyPortfolio, extremeAtr);
    if (!cb.active) throw new Error('Circuit breaker should be active on extreme volatility');
    console.log(`       Triggered: ${cb.reason}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AUDIT TRAIL TEST
  // ─────────────────────────────────────────────────────────────────────────
  test('All checks appear in checksPerformed audit trail', () => {
    const result = assessRisk(buyDecision, atr, currentPrice, healthyPortfolio, 'BTC/USD');
    // When approved, should have 10 checks (gates 1-9 + size validation)
    if (result.checksPerformed.length < 10) {
      throw new Error(`Expected ≥10 checks, got ${result.checksPerformed.length}`);
    }
    const allHaveNames = result.checksPerformed.every(c => c.name && c.detail);
    if (!allHaveNames) throw new Error('All checks must have name and detail');
    console.log(`       ${result.checksPerformed.length} checks logged in audit trail ✓`);
  });

  test('Blocked result has no trade parameters', () => {
    const portfolio: PortfolioState = { ...healthyPortfolio, circuitBreakerActive: true };
    const result = assessRisk(buyDecision, atr, currentPrice, portfolio, 'BTC/USD');
    if (result.trade) throw new Error('Blocked results should not contain trade parameters');
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Risk Manager is solid. Ready to build Component 7.\n');
  else console.log('❌ Fix the failures above before moving on.\n');
}

runTests().catch(console.error);
