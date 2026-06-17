import { getOHLCV, getOrderBook } from './marketData.js';
import { computeIndicators } from './indicators.js';
import { analyzeMicrostructure } from './microstructure.js';
import { scanPatterns, fetchFearGreedIndex, PatternContext } from './patterns.js';

async function runTests() {
  console.log('\n🔍 Testing Pattern Recognition...\n');
  let passed = 0; let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // Fetch real market data
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

  const realCtx: PatternContext = {
    suites: [suite1h, suite4h, suite1d],
    micro,
  };

  // ── Test 1: Fear & Greed index fetches ────────────────────────────────────
  await test('fetchFearGreedIndex — live data', async () => {
    const fg = await fetchFearGreedIndex();
    if (fg < 0 || fg > 100) throw new Error(`Fear & Greed out of range: ${fg}`);
    const label = fg < 25 ? 'Extreme Fear' : fg < 45 ? 'Fear' : fg < 55 ? 'Neutral' : fg < 75 ? 'Greed' : 'Extreme Greed';
    console.log(`       Fear & Greed Index: ${fg} (${label})`);
  });

  // ── Test 2: Full scan on live BTC data ────────────────────────────────────
  await test('scanPatterns — live BTC full scan', async () => {
    const result = await scanPatterns(realCtx);

    if (result.recommendedThreshold < 0.55 || result.recommendedThreshold > 0.80) {
      throw new Error(`Threshold out of range: ${result.recommendedThreshold}`);
    }
    if (result.patterns.length !== 5) throw new Error(`Expected 5 patterns, got ${result.patterns.length}`);

    console.log(`\n       ┌─ Pattern Scan Results ──────────────────────────`);
    for (const p of result.patterns) {
      const status = p.detected ? '🟢 DETECTED' : `⚪ ${p.conditionsMet}/${p.totalConditions} conditions`;
      console.log(`       │  ${p.name.padEnd(28)} ${status}`);
      for (const c of p.conditions) {
        console.log(`       │    ${c.met ? '✓' : '✗'} ${c.name}`);
        console.log(`       │      → ${c.value}`);
      }
    }
    console.log(`       │`);
    console.log(`       │  Active pattern: ${result.activePattern?.name ?? 'None'}`);
    console.log(`       │  Recommended threshold: ${result.recommendedThreshold}`);
    console.log(`       │  Summary: ${result.summary}`);
    console.log(`       └────────────────────────────────────────────────────`);
  });

  // ── Test 3: Trend Pullback detects correctly ──────────────────────────────
  await test('Trend Pullback — detects with correct conditions', async () => {
    const bullishCtx: PatternContext = {
      suites: [
        { ...suite1h, macd: { ...suite1h.macd, trend: 'bullish_crossover' }, volume: { ...suite1h.volume, ratio: 0.75 } },
        { ...suite4h, rsi: { ...suite4h.rsi, value: 45 }, volume: { ...suite4h.volume, ratio: 0.75 } },
        { ...suite1d, ma: { ...suite1d.ma, trend: 'bullish' } },
      ],
      micro: { ...micro, tradeable: true, bidAskImbalance: 0.05 },
      fearGreedIndex: 45,
    };
    const result = await scanPatterns(bullishCtx);
    const tp = result.patterns.find(p => p.name === 'Trend Pullback')!;
    if (!tp.detected) throw new Error(`Trend Pullback not detected. Conditions met: ${tp.conditionsMet}/${tp.totalConditions}`);
    console.log(`       Detected: ${tp.conditionsMet}/${tp.totalConditions} conditions met`);
  });

  // ── Test 4: No pattern → strict threshold ────────────────────────────────
  await test('No pattern detected → threshold raised to 0.72', async () => {
    // Neutral conditions — no pattern should fire
    const neutralCtx: PatternContext = {
      suites: [
        { ...suite1h, macd: { ...suite1h.macd, trend: 'bearish' }, rsi: { ...suite1h.rsi, value: 55 }, volume: { ...suite1h.volume, ratio: 1.0 } },
        { ...suite4h, ma: { ...suite4h.ma, trend: 'neutral' }, rsi: { ...suite4h.rsi, value: 58 } },
        { ...suite1d, ma: { ...suite1d.ma, trend: 'neutral' }, macd: { ...suite1d.macd, trend: 'bearish' } },
      ],
      micro: { ...micro, tradeable: true, bidAskImbalance: 0.02 },
      fearGreedIndex: 52,
    };
    const result = await scanPatterns(neutralCtx);
    if (result.recommendedThreshold < 0.70) {
      throw new Error(`No pattern should raise threshold to ≥0.70, got ${result.recommendedThreshold}`);
    }
    console.log(`       No pattern threshold: ${result.recommendedThreshold} ✓`);
  });

  // ── Test 5: Pattern detected → threshold lowered ─────────────────────────
  await test('Pattern detected → threshold lowered below 0.68', async () => {
    const setupCtx: PatternContext = {
      suites: [
        { ...suite1h, macd: { ...suite1h.macd, trend: 'bullish_crossover' }, volume: { ...suite1h.volume, ratio: 0.75 } },
        { ...suite4h, rsi: { ...suite4h.rsi, value: 44 }, ma: { ...suite4h.ma, trend: 'bullish' }, volume: { ...suite4h.volume, ratio: 0.75 } },
        { ...suite1d, ma: { ...suite1d.ma, trend: 'bullish' }, macd: { ...suite1d.macd, trend: 'bullish' } },
      ],
      micro: { ...micro, tradeable: true, bidAskImbalance: 0.08 },
      fearGreedIndex: 30,
    };
    const result = await scanPatterns(setupCtx);
    if (!result.detected) throw new Error('Expected a pattern to be detected');
    if (result.recommendedThreshold >= 0.68) {
      throw new Error(`Pattern should lower threshold below 0.68, got ${result.recommendedThreshold}`);
    }
    console.log(`       Pattern threshold: ${result.recommendedThreshold} (${result.activePattern?.name}) ✓`);
  });

  // ── Test 6: All scores stay valid ────────────────────────────────────────
  await test('All pattern confidences are within 0–1', async () => {
    const result = await scanPatterns(realCtx);
    for (const p of result.patterns) {
      if (p.confidence < 0 || p.confidence > 1) {
        throw new Error(`${p.name} confidence out of range: ${p.confidence}`);
      }
    }
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Pattern Recognition is solid. Ready to build Component 5.\n');
  else console.log('❌ Fix the failures above before moving on.\n');
}

runTests().catch(console.error);
