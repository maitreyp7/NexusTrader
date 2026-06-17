import { getOHLCV, getOrderBook } from './marketData.js';
import { computeIndicators, IndicatorSuite } from './indicators.js';
import { analyzeMicrostructure } from './microstructure.js';
import { buildTechnicalSignal } from './signalEngine.js';

async function runTests() {
  console.log('\n⚡ Testing Signal Engine...\n');
  let passed = 0; let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // Fetch all data needed
  const [btc1h, btc4h, btc1d, btcBook] = await Promise.all([
    getOHLCV('BTC/USD', '1h', 100),
    getOHLCV('BTC/USD', '4h', 60),
    getOHLCV('BTC/USD', '1d', 100),
    getOrderBook('BTC/USD', 20),
  ]);

  const suite1h = computeIndicators(btc1h.candles, '1h');
  const suite4h = computeIndicators(btc4h.candles, '4h');
  const suite1d = computeIndicators(btc1d.candles, '1d');
  const micro   = analyzeMicrostructure(btcBook);

  // ── Test 1: Full BTC signal ───────────────────────────────────────────────
  await test('buildTechnicalSignal — BTC full signal', () => {
    const signal = buildTechnicalSignal([suite1h, suite4h, suite1d], micro);

    if (signal.score < 0 || signal.score > 1) throw new Error(`Score out of range: ${signal.score}`);
    if (signal.confidence < 0 || signal.confidence > 1) throw new Error('Confidence out of range');
    if (!['bullish', 'bearish', 'neutral'].includes(signal.direction)) throw new Error('Invalid direction');
    for (const [key, val] of Object.entries(signal.components)) {
      if (val < 0 || val > 1) throw new Error(`Component ${key} out of range: ${val}`);
    }

    console.log(`\n       ┌─ BTC Technical Signal ───────────────────────────`);
    console.log(`       │  Score:      ${signal.score.toFixed(3)} (${signal.direction})`);
    console.log(`       │  Confidence: ${signal.confidence.toFixed(3)}`);
    console.log(`       │  Tradeable:  ${signal.tradeable}`);
    console.log(`       │`);
    console.log(`       │  Components:`);
    console.log(`       │    Momentum:        ${signal.components.momentum.toFixed(3)}`);
    console.log(`       │    Trend:           ${signal.components.trend.toFixed(3)}`);
    console.log(`       │    Microstructure:  ${signal.components.microstructure.toFixed(3)}`);
    console.log(`       │    Volume:          ${signal.components.volume.toFixed(3)}`);
    console.log(`       │    TF Alignment:    ${signal.components.timeframeAlignment.toFixed(3)}`);
    console.log(`       │`);
    console.log(`       │  Support:    $${signal.bidSupport.toLocaleString()}`);
    console.log(`       │  Resistance: $${signal.askResistance.toLocaleString()}`);
    console.log(`       └────────────────────────────────────────────────────`);
  });

  // ── Test 2: Single timeframe still works ─────────────────────────────────
  await test('buildTechnicalSignal — single timeframe (1h only)', () => {
    const signal = buildTechnicalSignal([suite1h], micro);
    if (signal.score < 0 || signal.score > 1) throw new Error('Score out of range');
    console.log(`       1h-only score: ${signal.score.toFixed(3)}`);
  });

  // ── Test 3: Wide spread → not tradeable ──────────────────────────────────
  await test('Wide spread gates the signal as not tradeable', () => {
    const wideMicro = { ...micro, tradeable: false, spreadPct: 0.0015 };
    const signal = buildTechnicalSignal([suite1h, suite4h, suite1d], wideMicro);
    if (signal.tradeable) throw new Error('Should be not tradeable');
    if (signal.score > 0.45) throw new Error('Score should be capped below 0.45');
    console.log(`       Correctly blocked — score: ${signal.score}, tradeable: ${signal.tradeable}`);
  });

  // ── Test 4: Bullish timeframes produce score > 0.5 ────────────────────────
  await test('Bullish indicators push score above 0.5', () => {
    // Simulate all-bullish conditions
    const bullishSuite: IndicatorSuite = {
      ...suite1h,
      rsi:    { ...suite1h.rsi,    normalized: 0.75 },
      macd:   { ...suite1h.macd,   normalized: 0.80 },
      ma:     { ...suite1h.ma,     normalized: 0.70 },
      volume: { ...suite1h.volume, normalized: 0.65 },
      technicalScore: 0.74,
    };
    const bullishMicro = { ...micro, tradeable: true, normalized: 0.72, bidAskImbalance: 0.35 };
    const signal = buildTechnicalSignal([bullishSuite], bullishMicro);
    if (signal.score <= 0.5) throw new Error(`Bullish signal should be > 0.5, got ${signal.score}`);
    console.log(`       Bullish score: ${signal.score.toFixed(3)} ✓`);
  });

  // ── Test 5: Bearish indicators produce score < 0.5 ────────────────────────
  await test('Bearish indicators push score below 0.5', () => {
    const bearishSuite: IndicatorSuite = {
      ...suite1h,
      rsi:    { ...suite1h.rsi,    normalized: 0.25 },
      macd:   { ...suite1h.macd,   normalized: 0.20 },
      ma:     { ...suite1h.ma,     normalized: 0.30 },
      volume: { ...suite1h.volume, normalized: 0.40 },
      technicalScore: 0.28,
    };
    const bearishMicro = { ...micro, tradeable: true, normalized: 0.28, bidAskImbalance: -0.35 };
    const signal = buildTechnicalSignal([bearishSuite], bearishMicro);
    if (signal.score >= 0.5) throw new Error(`Bearish signal should be < 0.5, got ${signal.score}`);
    console.log(`       Bearish score: ${signal.score.toFixed(3)} ✓`);
  });

  // ── Test 6: Low confidence dampens toward neutral ─────────────────────────
  await test('Conflicting timeframes reduce confidence and dampen score', () => {
    // 1h bullish, 1d bearish — conflict
    const bullish1h: IndicatorSuite = { ...suite1h, technicalScore: 0.78, rsi: { ...suite1h.rsi, normalized: 0.78 }, macd: { ...suite1h.macd, normalized: 0.80 }, ma: { ...suite1h.ma, normalized: 0.75 } };
    const bearish1d: IndicatorSuite = { ...suite1d, technicalScore: 0.25, rsi: { ...suite1d.rsi, normalized: 0.22 }, macd: { ...suite1d.macd, normalized: 0.20 }, ma: { ...suite1d.ma, normalized: 0.28 } };

    const conflicted = buildTechnicalSignal([bullish1h, bearish1d], { ...micro, tradeable: true });
    const aligned    = buildTechnicalSignal([bullish1h, bullish1h], { ...micro, tradeable: true });

    if (conflicted.confidence >= aligned.confidence) {
      throw new Error('Conflicting timeframes should have lower confidence than aligned');
    }
    console.log(`       Conflicted confidence: ${conflicted.confidence.toFixed(3)} vs aligned: ${aligned.confidence.toFixed(3)} ✓`);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Signal Engine is solid. Ready to build Component 5.\n');
  else console.log('❌ Fix the failures above before moving on.\n');
}

runTests().catch(console.error);
