import { getOrderBook } from './marketData.js';
import { analyzeMicrostructure } from './microstructure.js';

async function runTests() {
  console.log('\n🔬 Testing Microstructure Layer...\n');
  let passed = 0; let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // Fetch live order books
  const [btcBook, ethBook] = await Promise.all([
    getOrderBook('BTC/USD', 20),
    getOrderBook('ETH/USD', 20),
  ]);

  // ── Test 1: BTC microstructure ─────────────────────────────────────────────
  await test('analyzeMicrostructure — BTC full analysis', () => {
    const result = analyzeMicrostructure(btcBook);

    if (result.spread <= 0) throw new Error('Spread must be positive');
    if (result.spreadPct <= 0) throw new Error('SpreadPct must be positive');
    if (result.normalized < 0 || result.normalized > 1) throw new Error(`Score out of range: ${result.normalized}`);
    if (result.bidSupport <= 0) throw new Error('bidSupport must be positive');
    if (result.askResistance <= 0) throw new Error('askResistance must be positive');
    if (result.bidSupport >= result.askResistance) throw new Error('bidSupport must be below askResistance');

    console.log(`       Price: $${result.currentPrice.toLocaleString()}`);
    console.log(`       Spread: $${result.spread} (${(result.spreadPct * 100).toFixed(3)}% — ${result.spreadSignal})`);
    console.log(`       Imbalance: ${(result.bidAskImbalance * 100).toFixed(1)}% (${result.imbalanceSignal})`);
    console.log(`       Support: $${result.bidSupport.toLocaleString()} | Resistance: $${result.askResistance.toLocaleString()}`);
    console.log(`       Liquidity walls: ${result.liquidityZones.length}`);
    console.log(`       Tradeable: ${result.tradeable} | Score: ${result.normalized}`);
    console.log(`       Reason: ${result.reason}`);
  });

  // ── Test 2: ETH microstructure ─────────────────────────────────────────────
  await test('analyzeMicrostructure — ETH full analysis', () => {
    const result = analyzeMicrostructure(ethBook);
    if (result.normalized < 0 || result.normalized > 1) throw new Error('Score out of range');
    console.log(`       ETH score: ${result.normalized} | ${result.imbalanceSignal} | spread: ${result.spreadSignal}`);
  });

  // ── Test 3: Wide spread returns not-tradeable ─────────────────────────────
  await test('Wide spread marks as not tradeable', () => {
    // Simulate a wide spread by creating a fake book
    const wideBook = {
      ...btcBook,
      bids: [[69000, 1.0]] as [number, number][],
      asks: [[70000, 1.0]] as [number, number][],  // $1000 spread = very wide
      spread: 1000,
      spreadPct: 0.0143,  // 1.43% spread
      bidAskImbalance: 0,
    };
    const result = analyzeMicrostructure(wideBook);
    if (result.tradeable) throw new Error('Wide spread should mark as not tradeable');
    if (result.normalized > 0.45) throw new Error('Wide spread should penalize score below 0.45');
    console.log(`       Wide spread score: ${result.normalized} (correctly penalized)`);
  });

  // ── Test 4: Score reflects buy pressure ───────────────────────────────────
  await test('Buy pressure increases score above 0.5', () => {
    const buyPressureBook = {
      ...btcBook,
      bidAskImbalance: 0.60,           // Strong buy pressure
      spread: 10,
      spreadPct: 0.0001,  // 0.01% spread — tight, so tradeable=true
    };
    const result = analyzeMicrostructure(buyPressureBook);
    if (result.normalized <= 0.50) throw new Error(`Buy pressure should push score above 0.5, got ${result.normalized}`);
    console.log(`       Buy pressure score: ${result.normalized} (correctly bullish)`);
  });

  // ── Test 5: Sell pressure decreases score ─────────────────────────────────
  await test('Sell pressure decreases score below 0.5', () => {
    const sellPressureBook = {
      ...btcBook,
      bidAskImbalance: -0.60,  // Strong sell pressure
    };
    const result = analyzeMicrostructure(sellPressureBook);
    if (result.normalized >= 0.50) throw new Error(`Sell pressure should push score below 0.5, got ${result.normalized}`);
    console.log(`       Sell pressure score: ${result.normalized} (correctly bearish)`);
  });

  // ── Test 6: Empty book throws ────────────────────────────────────────────
  await test('Empty order book throws error', () => {
    try {
      analyzeMicrostructure({ ...btcBook, bids: [], asks: [] });
      throw new Error('Should have thrown for empty book');
    } catch (err) {
      if (err instanceof Error && err.message.includes('empty order book')) return;
      throw err;
    }
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Microstructure Layer is solid. Ready to build Component 4.\n');
  else console.log('❌ Fix the failures above before moving on.\n');
}

runTests().catch(console.error);
