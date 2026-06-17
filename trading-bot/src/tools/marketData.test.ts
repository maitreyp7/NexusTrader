import { getCurrentPrice, getOHLCV, getOrderBook, getHistoricalPrices, checkStaleness } from './marketData.js';

// ─────────────────────────────────────────────────────────────────────────────
// DATA LAYER TESTS
// Run with: npx ts-node --esm src/tools/marketData.test.ts
// ─────────────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n📊 Testing Data Layer...\n');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  // ── Test 1: Live BTC Price ────────────────────────────────────────────────
  await test('getCurrentPrice — BTC live price', async () => {
    const data = await getCurrentPrice('BTC/USD');

    if (data.price <= 0) throw new Error(`Invalid price: ${data.price}`);
    if (isNaN(data.priceChange24h)) throw new Error('priceChange24h is NaN');
    if (data.high24h < data.low24h) throw new Error('high24h < low24h');
    if (!(data.fetchedAt instanceof Date)) throw new Error('fetchedAt is not a Date');

    console.log(`       BTC: $${data.price.toLocaleString()} (${data.priceChange24h > 0 ? '+' : ''}${data.priceChange24h.toFixed(2)}% 24h)`);
  });

  // ── Test 2: Live ETH Price ────────────────────────────────────────────────
  await test('getCurrentPrice — ETH live price', async () => {
    const data = await getCurrentPrice('ETH/USD');
    if (data.price <= 0) throw new Error(`Invalid price: ${data.price}`);
    console.log(`       ETH: $${data.price.toLocaleString()} (${data.priceChange24h > 0 ? '+' : ''}${data.priceChange24h.toFixed(2)}% 24h)`);
  });

  // ── Test 3: Staleness check passes on fresh data ──────────────────────────
  await test('checkStaleness — passes on fresh data', async () => {
    const data = await getCurrentPrice('BTC/USD');
    checkStaleness(data); // Should not throw
  });

  // ── Test 4: OHLCV candles — 1h ───────────────────────────────────────────
  await test('getOHLCV — BTC 1h candles', async () => {
    const data = await getOHLCV('BTC/USD', '1h', 100);

    if (data.candles.length < 50) throw new Error(`Too few candles: ${data.candles.length}`);
    const last = data.candles[data.candles.length - 1];
    if (last.low > last.high) throw new Error('Candle low > high');
    if (last.close <= 0) throw new Error('Candle close price invalid');

    console.log(`       Got ${data.candles.length} candles. Latest close: $${last.close.toLocaleString()}`);
  });

  // ── Test 5: OHLCV candles — 4h ───────────────────────────────────────────
  await test('getOHLCV — BTC 4h candles', async () => {
    const data = await getOHLCV('BTC/USD', '4h', 60);
    if (data.candles.length < 30) throw new Error(`Too few candles: ${data.candles.length}`);
    console.log(`       Got ${data.candles.length} candles (4h timeframe)`);
  });

  // ── Test 6: Order book ────────────────────────────────────────────────────
  await test('getOrderBook — BTC order book', async () => {
    const book = await getOrderBook('BTC/USD');

    if (book.bids.length === 0) throw new Error('Empty bids');
    if (book.asks.length === 0) throw new Error('Empty asks');
    if (book.spread <= 0) throw new Error(`Invalid spread: ${book.spread}`);
    if (book.bidAskImbalance < -1 || book.bidAskImbalance > 1) {
      throw new Error(`Imbalance out of range: ${book.bidAskImbalance}`);
    }

    const imbalanceLabel = book.bidAskImbalance > 0.1 ? 'buy pressure' :
                           book.bidAskImbalance < -0.1 ? 'sell pressure' : 'balanced';

    console.log(`       Spread: $${book.spread.toFixed(2)} (${(book.spreadPct * 100).toFixed(3)}%)`);
    console.log(`       Imbalance: ${book.bidAskImbalance.toFixed(3)} (${imbalanceLabel})`);
  });

  // ── Test 7: Historical prices ─────────────────────────────────────────────
  await test('getHistoricalPrices — BTC 30 days', async () => {
    const prices = await getHistoricalPrices('BTC/USD', 30);

    if (prices.length < 25) throw new Error(`Too few data points: ${prices.length}`);
    if (prices.some(p => isNaN(p.price) || p.price <= 0)) {
      throw new Error('Found invalid prices in historical data');
    }
    if (!(prices[0].timestamp instanceof Date)) throw new Error('Timestamps not parsed correctly');

    const oldest = prices[0];
    const newest = prices[prices.length - 1];
    console.log(`       ${prices.length} days of data`);
    console.log(`       Range: $${Math.min(...prices.map(p => p.price)).toLocaleString()} – $${Math.max(...prices.map(p => p.price)).toLocaleString()}`);
    console.log(`       From: ${oldest.timestamp.toDateString()} → ${newest.timestamp.toDateString()}`);
  });

  // ── Test 8: Unknown symbol throws ────────────────────────────────────────
  await test('getCurrentPrice — rejects unknown symbol', async () => {
    try {
      await getCurrentPrice('FAKE/USD');
      throw new Error('Should have thrown for unknown symbol');
    } catch (err) {
      if (err instanceof Error && err.message.includes('Unknown symbol')) return;
      throw err;
    }
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('✅ Data Layer is solid. Ready to build Component 2.\n');
  } else {
    console.log('❌ Fix the failures above before moving on.\n');
  }
}

runTests().catch(console.error);
