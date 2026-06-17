import { checkPosition, openPosition, buildPositionSummary, ManagedPosition } from './positionManager.js';
import { TradeParameters } from './riskManager.js';
import { getOHLCV } from '../tools/marketData.js';
import { computeIndicators, computeATR } from '../tools/indicators.js';

async function runTests() {
  console.log('\n📊 Testing Position Manager...\n');
  let passed = 0; let failed = 0;

  function test(name: string, fn: () => void) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // ── Fetch live BTC data for realistic ATR-based trade parameters ──────────
  const btc1h   = await getOHLCV('BTC/USD', '1h', 100);
  const candles  = btc1h.candles;
  const atr      = computeATR(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close), 14);
  const entryPrice = candles[candles.length - 1].close;

  // Build realistic trade parameters (same math as Risk Manager)
  const stopDistance  = atr.value * 1.5;
  const tradeParams: TradeParameters = {
    positionSizeUsd:      100,
    positionSizeCoins:    100 / entryPrice,
    entryPrice,
    stopLossPrice:        entryPrice - stopDistance,
    partialProfitPrice:   entryPrice + stopDistance * 1,
    takeProfitPrice:      entryPrice + stopDistance * 3,
    trailingStopPct:      0.015,
    breakEvenTriggerPct:  0.02,
    riskAmount:           1.00,
    riskPct:              0.0001,
    stopLossDistance:     stopDistance,
    rewardRiskRatio:      3,
  };

  console.log(`  📊 BTC price: $${entryPrice.toFixed(2)}`);
  console.log(`  📊 ATR: $${atr.value.toFixed(2)} | Stop distance: $${stopDistance.toFixed(2)}`);
  console.log(`  📊 Stop: $${tradeParams.stopLossPrice.toFixed(2)} | Target: $${tradeParams.takeProfitPrice.toFixed(2)}\n`);

  // ── Shared fixture: a freshly opened position ─────────────────────────────
  const freshPosition = openPosition('BTC/USD', entryPrice, 100 / entryPrice, tradeParams);

  // ─────────────────────────────────────────────────────────────────────────
  // openPosition() FACTORY TESTS
  // ─────────────────────────────────────────────────────────────────────────

  test('openPosition — creates OPEN phase with correct initial values', () => {
    const pos = freshPosition;
    if (pos.phase !== 'OPEN')           throw new Error(`Expected OPEN, got ${pos.phase}`);
    if (pos.stopPrice >= pos.entryPrice) throw new Error('Stop must be below entry');
    if (pos.highestPrice !== pos.entryPrice) throw new Error('highestPrice should equal entry on open');
    if (pos.partialExitDone)            throw new Error('partialExitDone should be false on open');
    if (pos.sizeRemaining <= 0)         throw new Error('sizeRemaining must be positive');
    console.log(`       Entry: $${pos.entryPrice.toFixed(2)}, stop: $${pos.stopPrice.toFixed(2)}, phase: ${pos.phase} ✓`);
  });

  test('openPosition — recalculates stop from actual fill price', () => {
    // If fill comes in $50 above the estimated entry, stop should shift up too
    const betterFill = openPosition('BTC/USD', entryPrice + 50, 100 / (entryPrice + 50), tradeParams);
    const expectedStop = (entryPrice + 50) - tradeParams.stopLossDistance;
    if (Math.abs(betterFill.stopPrice - expectedStop) > 0.01) {
      throw new Error(`Stop should recalculate from fill price. Expected ~$${expectedStop.toFixed(2)}, got $${betterFill.stopPrice.toFixed(2)}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // HOLD — no action needed
  // ─────────────────────────────────────────────────────────────────────────

  test('HOLD — price between stop and break-even trigger', () => {
    // Price up 0.5% — not enough to trigger break-even (+2% needed)
    const mildGain = entryPrice * 1.005;
    const result   = checkPosition(freshPosition, mildGain);
    if (result.action.type !== 'HOLD') throw new Error(`Expected HOLD, got ${result.action.type}`);
    if (result.updatedPosition.phase !== 'OPEN') throw new Error('Phase should remain OPEN');
    if (result.updatedPosition.currentPrice !== mildGain) throw new Error('currentPrice not updated');
  });

  test('HOLD — highestPrice updates correctly during OPEN phase', () => {
    const highPrice  = entryPrice * 1.015;
    const result1    = checkPosition(freshPosition, highPrice);
    // Now price pulls back — highestPrice should stay at the high
    const pullback   = entryPrice * 1.005;
    const result2    = checkPosition(result1.updatedPosition, pullback);
    if (result2.updatedPosition.highestPrice !== highPrice) {
      throw new Error(`highestPrice should be $${highPrice.toFixed(2)}, got $${result2.updatedPosition.highestPrice.toFixed(2)}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STOP LOSS
  // ─────────────────────────────────────────────────────────────────────────

  test('FULL_EXIT — stop-loss hit exactly at stop price', () => {
    const result = checkPosition(freshPosition, freshPosition.stopPrice);
    if (result.action.type !== 'FULL_EXIT') throw new Error(`Expected FULL_EXIT, got ${result.action.type}`);
    if (result.updatedPosition.phase !== 'CLOSED') throw new Error('Phase should be CLOSED');
    console.log(`       Stop hit at $${freshPosition.stopPrice.toFixed(2)}: "${result.action.reason.slice(0, 60)}..." ✓`);
  });

  test('FULL_EXIT — stop-loss hit below stop price (gap down)', () => {
    // Price gaps down past the stop — still exits
    const gapDown = freshPosition.stopPrice - 100;
    const result  = checkPosition(freshPosition, gapDown);
    if (result.action.type !== 'FULL_EXIT') throw new Error(`Expected FULL_EXIT, got ${result.action.type}`);
  });

  test('HOLD — price just above stop (not triggered)', () => {
    const justAboveStop = freshPosition.stopPrice + 0.01;
    const result        = checkPosition(freshPosition, justAboveStop);
    if (result.action.type !== 'HOLD') throw new Error(`Expected HOLD above stop, got ${result.action.type}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BREAK-EVEN TRANSITION (OPEN → BREAK_EVEN)
  // ─────────────────────────────────────────────────────────────────────────

  test('MOVE_STOP — break-even triggered at +2%', () => {
    const breakEvenPrice = entryPrice * (1 + tradeParams.breakEvenTriggerPct);
    const result = checkPosition(freshPosition, breakEvenPrice);
    if (result.action.type !== 'MOVE_STOP') throw new Error(`Expected MOVE_STOP, got ${result.action.type}`);
    const action = result.action as { type: 'MOVE_STOP'; newStopPrice: number; reason: string };
    if (Math.abs(action.newStopPrice - entryPrice) > 0.01) {
      throw new Error(`Break-even stop should be at entry $${entryPrice.toFixed(2)}, got $${action.newStopPrice.toFixed(2)}`);
    }
    if (result.updatedPosition.phase !== 'BREAK_EVEN') throw new Error('Phase should advance to BREAK_EVEN');
    console.log(`       Break-even at +2%: stop moved to entry $${action.newStopPrice.toFixed(2)} ✓`);
  });

  test('BREAK_EVEN — price below break-even trigger still HOLDs', () => {
    // +1.9% is not enough to trigger break-even
    const almostBreakEven = entryPrice * 1.019;
    const result          = checkPosition(freshPosition, almostBreakEven);
    if (result.action.type !== 'HOLD') throw new Error(`Expected HOLD, got ${result.action.type}`);
    if (result.updatedPosition.phase !== 'OPEN') throw new Error('Phase should remain OPEN');
  });

  test('BREAK_EVEN phase — stop does not go below entry even if price falls', () => {
    // Simulate: break-even was triggered, stop is now at entry.
    // Price falls back to just above entry — should still HOLD (stop at entry, not hit).
    const breakEvenPos: ManagedPosition = {
      ...freshPosition,
      phase:      'BREAK_EVEN',
      stopPrice:  entryPrice,  // stop already at entry
      highestPrice: entryPrice * 1.025,
    };
    // Price at entry + $1 — above stop, below take-profit
    const result = checkPosition(breakEvenPos, entryPrice + 1);
    if (result.action.type !== 'HOLD') throw new Error(`Expected HOLD, got ${result.action.type}: ${result.action.reason}`);
    if (result.updatedPosition.stopPrice < entryPrice) throw new Error('Stop must never go below entry in BREAK_EVEN phase');
  });

  test('BREAK_EVEN — stop AT entry means price AT entry = stop hit → FULL_EXIT', () => {
    const breakEvenPos: ManagedPosition = {
      ...freshPosition,
      phase:     'BREAK_EVEN',
      stopPrice: entryPrice,
    };
    // Price falls back exactly to entry — stop is hit, exit at breakeven (zero loss)
    const result = checkPosition(breakEvenPos, entryPrice);
    if (result.action.type !== 'FULL_EXIT') throw new Error(`Expected FULL_EXIT at breakeven, got ${result.action.type}`);
    console.log(`       Break-even stop hit: exited at entry (zero loss) ✓`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PARTIAL EXIT (BREAK_EVEN → PARTIAL_EXIT)
  // ─────────────────────────────────────────────────────────────────────────

  test('PARTIAL_EXIT — take-profit level triggers 50% exit', () => {
    const breakEvenPos: ManagedPosition = {
      ...freshPosition,
      phase:      'BREAK_EVEN',
      stopPrice:  entryPrice,
      highestPrice: entryPrice * 1.025,
    };
    const result = checkPosition(breakEvenPos, tradeParams.takeProfitPrice);
    if (result.action.type !== 'PARTIAL_EXIT') throw new Error(`Expected PARTIAL_EXIT, got ${result.action.type}`);
    const action = result.action as { type: 'PARTIAL_EXIT'; coinsToSell: number; reason: string };
    // Should sell 50% of remaining coins
    const expectedSell = freshPosition.sizeRemaining * 0.50;
    if (Math.abs(action.coinsToSell - expectedSell) > 0.000001) {
      throw new Error(`Expected to sell ${expectedSell.toFixed(8)} coins, got ${action.coinsToSell.toFixed(8)}`);
    }
    if (result.updatedPosition.phase !== 'PARTIAL_EXIT') throw new Error('Phase should advance to PARTIAL_EXIT');
    if (result.updatedPosition.partialExitDone !== true) throw new Error('partialExitDone should be true');
    console.log(`       Take-profit at $${tradeParams.takeProfitPrice.toFixed(2)}: sold ${action.coinsToSell.toFixed(8)} BTC ✓`);
  });

  test('PARTIAL_EXIT phase — sizeRemaining halved after partial exit', () => {
    const breakEvenPos: ManagedPosition = {
      ...freshPosition,
      phase:     'BREAK_EVEN',
      stopPrice: entryPrice,
    };
    const result = checkPosition(breakEvenPos, tradeParams.takeProfitPrice);
    const expectedRemaining = freshPosition.sizeRemaining * 0.50;
    if (Math.abs(result.updatedPosition.sizeRemaining - expectedRemaining) > 0.000001) {
      throw new Error(`Expected ${expectedRemaining.toFixed(8)} remaining, got ${result.updatedPosition.sizeRemaining.toFixed(8)}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TRAILING STOP (PARTIAL_EXIT phase)
  // ─────────────────────────────────────────────────────────────────────────

  test('MOVE_STOP — trailing stop ratchets up as price rises', () => {
    const trailingPos: ManagedPosition = {
      ...freshPosition,
      phase:           'PARTIAL_EXIT',
      stopPrice:       tradeParams.takeProfitPrice * (1 - tradeParams.trailingStopPct),
      highestPrice:    tradeParams.takeProfitPrice,
      sizeRemaining:   freshPosition.sizeRemaining * 0.50,
      partialExitDone: true,
    };
    // Price rises above take-profit — trailing stop should ratchet up
    const newHigh  = tradeParams.takeProfitPrice * 1.02;
    const result   = checkPosition(trailingPos, newHigh);
    if (result.action.type !== 'MOVE_STOP') throw new Error(`Expected MOVE_STOP, got ${result.action.type}`);
    const action   = result.action as { type: 'MOVE_STOP'; newStopPrice: number; reason: string };
    const expected = newHigh * (1 - tradeParams.trailingStopPct);
    if (Math.abs(action.newStopPrice - expected) > 0.10) {
      throw new Error(`Trailing stop should be ~$${expected.toFixed(2)}, got $${action.newStopPrice.toFixed(2)}`);
    }
    if (action.newStopPrice <= trailingPos.stopPrice) throw new Error('New trailing stop must be higher than old stop');
    console.log(`       Trailing stop raised: $${trailingPos.stopPrice.toFixed(2)} → $${action.newStopPrice.toFixed(2)} ✓`);
  });

  test('HOLD — trailing stop does NOT move down if price falls', () => {
    const trailingPos: ManagedPosition = {
      ...freshPosition,
      phase:           'PARTIAL_EXIT',
      stopPrice:       tradeParams.takeProfitPrice * (1 - tradeParams.trailingStopPct),
      highestPrice:    tradeParams.takeProfitPrice,
      sizeRemaining:   freshPosition.sizeRemaining * 0.50,
      partialExitDone: true,
    };
    // Price falls back — stop should stay where it is
    const result = checkPosition(trailingPos, tradeParams.takeProfitPrice * 0.99);
    // HOLD because stop not hit yet
    if (result.updatedPosition.stopPrice < trailingPos.stopPrice) {
      throw new Error('Trailing stop must never move DOWN — it only ratchets up');
    }
    console.log(`       Trailing stop held at $${trailingPos.stopPrice.toFixed(2)} on pullback ✓`);
  });

  test('FULL_EXIT — trailing stop hit', () => {
    const trailingStopPrice = tradeParams.takeProfitPrice * (1 - tradeParams.trailingStopPct);
    const trailingPos: ManagedPosition = {
      ...freshPosition,
      phase:           'PARTIAL_EXIT',
      stopPrice:       trailingStopPrice,
      highestPrice:    tradeParams.takeProfitPrice,
      sizeRemaining:   freshPosition.sizeRemaining * 0.50,
      partialExitDone: true,
    };
    const result = checkPosition(trailingPos, trailingStopPrice);
    if (result.action.type !== 'FULL_EXIT') throw new Error(`Expected FULL_EXIT on trailing stop, got ${result.action.type}`);
    if (result.updatedPosition.phase !== 'CLOSED') throw new Error('Phase should be CLOSED');
    console.log(`       Trailing stop hit at $${trailingStopPrice.toFixed(2)}: CLOSED ✓`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SESSION END
  // ─────────────────────────────────────────────────────────────────────────

  test('FULL_EXIT — session end overrides everything', () => {
    // Even if price is above take-profit, close at session end
    const richPrice = tradeParams.takeProfitPrice * 1.50;
    const result    = checkPosition(freshPosition, richPrice, true); // isSessionEnd = true
    if (result.action.type !== 'FULL_EXIT') throw new Error(`Session end should force FULL_EXIT, got ${result.action.type}`);
    if (!result.action.reason.includes('Session end')) throw new Error('Reason should mention session end');
    console.log(`       Session-end close at $${richPrice.toFixed(2)} (even with profit) ✓`);
  });

  test('FULL_EXIT — session end works in BREAK_EVEN phase too', () => {
    const breakEvenPos: ManagedPosition = { ...freshPosition, phase: 'BREAK_EVEN', stopPrice: entryPrice };
    const result = checkPosition(breakEvenPos, entryPrice * 1.015, true);
    if (result.action.type !== 'FULL_EXIT') throw new Error(`Expected FULL_EXIT, got ${result.action.type}`);
  });

  test('FULL_EXIT — session end works in PARTIAL_EXIT phase too', () => {
    const trailingPos: ManagedPosition = {
      ...freshPosition,
      phase: 'PARTIAL_EXIT',
      stopPrice: tradeParams.takeProfitPrice * 0.98,
      highestPrice: tradeParams.takeProfitPrice,
      sizeRemaining: freshPosition.sizeRemaining * 0.50,
      partialExitDone: true,
    };
    const result = checkPosition(trailingPos, tradeParams.takeProfitPrice * 1.01, true);
    if (result.action.type !== 'FULL_EXIT') throw new Error(`Expected FULL_EXIT, got ${result.action.type}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FULL HAPPY PATH — simulate a winning trade end-to-end
  // ─────────────────────────────────────────────────────────────────────────
  test('Full winning trade lifecycle: OPEN → BREAK_EVEN → PARTIAL_EXIT → CLOSED', () => {
    let pos = openPosition('BTC/USD', entryPrice, 100 / entryPrice, tradeParams);
    if (pos.phase !== 'OPEN') throw new Error('Should start OPEN');

    // Step 1: price rises +1% — still OPEN
    let r = checkPosition(pos, entryPrice * 1.01);
    if (r.action.type !== 'HOLD' || r.updatedPosition.phase !== 'OPEN') throw new Error('Should still be OPEN at +1%');
    pos = r.updatedPosition;

    // Step 2: price rises +2% — break-even triggered
    r = checkPosition(pos, entryPrice * 1.02);
    if (r.action.type !== 'MOVE_STOP') throw new Error(`Expected MOVE_STOP at +2%, got ${r.action.type}`);
    if (r.updatedPosition.phase !== 'BREAK_EVEN') throw new Error('Should advance to BREAK_EVEN');
    pos = r.updatedPosition;

    // Step 3: price hits take-profit — partial exit
    r = checkPosition(pos, tradeParams.takeProfitPrice);
    if (r.action.type !== 'PARTIAL_EXIT') throw new Error(`Expected PARTIAL_EXIT, got ${r.action.type}`);
    if (r.updatedPosition.phase !== 'PARTIAL_EXIT') throw new Error('Should advance to PARTIAL_EXIT');
    pos = r.updatedPosition;

    // Step 4: price moves higher — trailing stop ratchets
    const newHigh = tradeParams.takeProfitPrice * 1.02;
    r = checkPosition(pos, newHigh);
    if (r.action.type !== 'MOVE_STOP') throw new Error(`Expected MOVE_STOP as price rises, got ${r.action.type}`);
    pos = r.updatedPosition;

    // Step 5: price drops to trailing stop — full exit
    r = checkPosition(pos, pos.stopPrice);
    if (r.action.type !== 'FULL_EXIT') throw new Error(`Expected FULL_EXIT when trailing stop hit, got ${r.action.type}`);
    if (r.updatedPosition.phase !== 'CLOSED') throw new Error('Should be CLOSED');

    console.log(`\n       ┌─ Full Trade Walkthrough ─────────────────────────`);
    console.log(`       │  Entry:         $${entryPrice.toFixed(2)}`);
    console.log(`       │  Break-even:    $${(entryPrice * 1.02).toFixed(2)} (+2%)`);
    console.log(`       │  Take-profit:   $${tradeParams.takeProfitPrice.toFixed(2)}`);
    console.log(`       │  Trail high:    $${newHigh.toFixed(2)}`);
    console.log(`       │  Final exit:    $${pos.stopPrice.toFixed(2)}`);
    console.log(`       └────────────────────────────────────────────────────\n`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // UTILITY
  // ─────────────────────────────────────────────────────────────────────────

  test('buildPositionSummary — returns a non-empty string', () => {
    const summary = buildPositionSummary(freshPosition);
    if (!summary || summary.length < 20) throw new Error('Summary too short or empty');
    console.log(`       ${summary}`);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Position Manager is solid. Ready to build Component 8.\n');
  else console.log('❌ Fix the failures above before moving on.\n');
}

runTests().catch(console.error);
