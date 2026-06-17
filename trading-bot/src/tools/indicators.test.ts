import { getOHLCV } from './marketData.js';
import { computeIndicators, computeMultiTimeframeScore, computeATR } from './indicators.js';

async function runTests() {
  console.log('\n📐 Testing Indicator Engine...\n');
  let passed = 0; let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // Fetch real candle data once and reuse
  const [btc1h, btc4h, btc1d] = await Promise.all([
    getOHLCV('BTC/USD', '1h', 100),
    getOHLCV('BTC/USD', '4h', 60),
    getOHLCV('BTC/USD', '1d', 100),
  ]);

  // ── Test 1: Full indicator suite on 1h ─────────────────────────────────────
  await test('computeIndicators — BTC 1h full suite', async () => {
    const suite = computeIndicators(btc1h.candles, '1h');

    // RSI checks
    if (suite.rsi.value < 0 || suite.rsi.value > 100) throw new Error(`RSI out of range: ${suite.rsi.value}`);
    if (!['overbought', 'oversold', 'neutral'].includes(suite.rsi.signal)) throw new Error('Invalid RSI signal');
    if (suite.rsi.normalized < 0 || suite.rsi.normalized > 1) throw new Error('RSI normalized out of 0-1');

    // MACD checks
    if (suite.macd.normalized < 0 || suite.macd.normalized > 1) throw new Error('MACD normalized out of 0-1');

    // ATR checks
    if (suite.atr.value <= 0) throw new Error('ATR must be positive');
    if (suite.atr.atrPct <= 0) throw new Error('ATR% must be positive');

    // Overall score
    if (suite.technicalScore < 0 || suite.technicalScore > 1) throw new Error(`Score out of range: ${suite.technicalScore}`);

    console.log(`       RSI: ${suite.rsi.value} (${suite.rsi.signal})`);
    console.log(`       MACD: ${suite.macd.trend} | histogram: ${suite.macd.histogram}`);
    console.log(`       MA trend: ${suite.ma.trend} | price vs SMA20: ${suite.ma.priceVsSma20}%`);
    console.log(`       ATR: $${suite.atr.value} (${(suite.atr.atrPct * 100).toFixed(2)}% — ${suite.atr.volatility})`);
    console.log(`       Volume: ${suite.volume.ratio}x avg (${suite.volume.signal})`);
    console.log(`       Technical score: ${suite.technicalScore.toFixed(3)}`);
  });

  // ── Test 2: Full suite on 4h ───────────────────────────────────────────────
  await test('computeIndicators — BTC 4h suite', async () => {
    const suite = computeIndicators(btc4h.candles, '4h');
    if (suite.technicalScore < 0 || suite.technicalScore > 1) throw new Error('Score out of range');
    console.log(`       4h score: ${suite.technicalScore.toFixed(3)} | RSI: ${suite.rsi.value} | trend: ${suite.ma.trend}`);
  });

  // ── Test 3: Full suite on 1d (has SMA50) ──────────────────────────────────
  await test('computeIndicators — BTC 1d suite (with SMA50)', async () => {
    const suite = computeIndicators(btc1d.candles, '1d');
    if (suite.ma.sma50 <= 0) throw new Error('SMA50 should be computed on daily');
    console.log(`       1d score: ${suite.technicalScore.toFixed(3)} | SMA50: $${suite.ma.sma50.toLocaleString()}`);
  });

  // ── Test 4: Multi-timeframe confluence ────────────────────────────────────
  await test('computeMultiTimeframeScore — all 3 timeframes', async () => {
    const suite1h = computeIndicators(btc1h.candles, '1h');
    const suite4h = computeIndicators(btc4h.candles, '4h');
    const suite1d = computeIndicators(btc1d.candles, '1d');
    const mtf = computeMultiTimeframeScore([suite1h, suite4h, suite1d]);

    if (mtf.score < 0 || mtf.score > 1) throw new Error('MTF score out of range');
    if (mtf.confidence < 0 || mtf.confidence > 1) throw new Error('Confidence out of range');

    console.log(`       ${mtf.summary}`);
  });

  // ── Test 5: ATR-based position sizing sanity check ─────────────────────────
  await test('ATR position sizing — makes sense for BTC', async () => {
    const candles = btc1h.candles;
    const atr = computeATR(
      candles.map(c => c.high),
      candles.map(c => c.low),
      candles.map(c => c.close),
      14
    );

    // ATR for BTC should be between $50 and $5,000 (sanity range)
    if (atr.value < 50 || atr.value > 5000) {
      throw new Error(`ATR looks wrong for BTC: $${atr.value}`);
    }

    // Position size demo: risk $100 with stop at 1 ATR
    const riskAmount  = 100;
    const stopDistance = atr.value;
    const positionSize = riskAmount / stopDistance;
    console.log(`       ATR: $${atr.value} | To risk $${riskAmount} with 1-ATR stop: ${positionSize.toFixed(4)} BTC`);
  });

  // ── Test 6: All normalized scores stay in 0–1 range ───────────────────────
  await test('All normalized scores are within 0–1', async () => {
    const suite = computeIndicators(btc1h.candles, '1h');
    const scores = [suite.rsi.normalized, suite.macd.normalized, suite.ma.normalized, suite.volume.normalized, suite.technicalScore];
    for (const score of scores) {
      if (score < 0 || score > 1 || isNaN(score)) {
        throw new Error(`Score out of bounds: ${score}`);
      }
    }
  });

  // ── Test 7: Rejects insufficient data ─────────────────────────────────────
  await test('Rejects candles below minimum threshold', () => {
    try {
      computeIndicators(btc1h.candles.slice(0, 5), '1h'); // Only 5 candles
      throw new Error('Should have thrown for insufficient data');
    } catch (err) {
      if (err instanceof Error && err.message.includes('Not enough candles')) return;
      throw err;
    }
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Indicator Engine is solid. Ready to build Component 3.\n');
  else console.log('❌ Fix the failures above before moving on.\n');
}

runTests().catch(console.error);
