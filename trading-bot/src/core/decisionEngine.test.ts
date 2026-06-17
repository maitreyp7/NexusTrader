import { getOHLCV, getOrderBook } from '../tools/marketData.js';
import { computeIndicators } from '../tools/indicators.js';
import { analyzeMicrostructure } from '../tools/microstructure.js';
import { buildTechnicalSignal } from '../tools/signalEngine.js';
import { scanPatterns } from '../tools/patterns.js';
import { decide } from './decisionEngine.js';

async function runTests() {
  console.log('\n🧠 Testing Decision Engine...\n');
  let passed = 0; let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // Fetch live data
  const [btc1h, btc4h, btc1d, btcBook] = await Promise.all([
    getOHLCV('BTC/USD', '1h', 100),
    getOHLCV('BTC/USD', '4h', 60),
    getOHLCV('BTC/USD', '1d', 100),
    getOrderBook('BTC/USD', 20),
  ]);

  const suite1h   = computeIndicators(btc1h.candles, '1h');
  const suite4h   = computeIndicators(btc4h.candles, '4h');
  const suite1d   = computeIndicators(btc1d.candles, '1d');
  const micro     = analyzeMicrostructure(btcBook);
  const technical = buildTechnicalSignal([suite1h, suite4h, suite1d], micro);
  const patterns  = await scanPatterns({ suites: [suite1h, suite4h, suite1d], micro });

  // ── Test 1: Full live decision ────────────────────────────────────────────
  await test('decide — live BTC full decision', () => {
    const result = decide({ technical, patterns });

    if (!['BUY', 'SELL', 'HOLD'].includes(result.action)) throw new Error(`Invalid action: ${result.action}`);
    if (result.finalScore < 0 || result.finalScore > 1) throw new Error('Score out of range');

    console.log(`\n       ┌─ Decision Engine Output ────────────────────────`);
    console.log(`       │  Action:      ${result.action}`);
    console.log(`       │  Final score: ${result.finalScore.toFixed(3)} vs threshold: ${result.threshold.toFixed(3)}`);
    console.log(`       │  Confidence:  ${result.confidence.toFixed(3)}`);
    console.log(`       │  Pattern:     ${result.pattern ?? 'None'}`);
    console.log(`       │  Tradeable:   ${result.tradeable}`);
    console.log(`       │`);
    console.log(`       │  Score breakdown:`);
    console.log(`       │    Technical      : ${result.scores.technical.toFixed(3)} × ${result.weights.technical}`);
    console.log(`       │    Microstructure : ${result.scores.microstructure.toFixed(3)} × ${result.weights.microstructure}`);
    console.log(`       │    Sentiment      : ${result.scores.sentiment.toFixed(3)} × ${result.weights.sentiment} ⚠ neutral`);
    console.log(`       │    Whale          : ${result.scores.whale.toFixed(3)} × ${result.weights.whale} ⚠ neutral`);
    console.log(`       │    Macro          : ${result.scores.macro.toFixed(3)} × ${result.weights.macro} ⚠ neutral`);
    if (result.dataGaps.length > 0) {
      console.log(`       │`);
      console.log(`       │  Data gaps: ${result.dataGaps.length} signals using neutral defaults`);
    }
    console.log(`       └────────────────────────────────────────────────────`);
    console.log('');
    console.log('       Full reasoning:');
    result.reason.split('\n').forEach(line => console.log(`       ${line}`));
  });

  // ── Test 2: Blocked when spread is wide ──────────────────────────────────
  await test('Wide spread → HOLD (blocked)', () => {
    const wideTechnical = { ...technical, tradeable: false, notTradeableReason: 'Spread 0.25% exceeds limit' };
    const result = decide({ technical: wideTechnical, patterns });
    if (result.action !== 'HOLD') throw new Error(`Expected HOLD, got ${result.action}`);
    if (result.tradeable) throw new Error('Should be blocked');
    console.log(`       Correctly blocked: ${result.blockedBy}`);
  });

  // ── Test 3: Blocked when confidence too low ───────────────────────────────
  await test('Low confidence → HOLD (blocked)', () => {
    const lowConfTechnical = { ...technical, confidence: 0.30 };
    const result = decide({ technical: lowConfTechnical, patterns });
    if (result.action !== 'HOLD') throw new Error(`Expected HOLD, got ${result.action}`);
    console.log(`       Correctly blocked: ${result.blockedBy}`);
  });

  // ── Test 4: Strong bullish signals → BUY ─────────────────────────────────
  await test('Strong bullish signals → BUY', async () => {
    const bullishTechnical = {
      ...technical,
      tradeable: true,
      confidence: 0.85,
      components: { momentum: 0.82, trend: 0.78, microstructure: 0.75, volume: 0.70, timeframeAlignment: 0.90 },
    };
    const bullishPatterns = { ...patterns, recommendedThreshold: 0.60, activePattern: { name: 'Trend Pullback', scoreBoost: 0.08, confidence: 0.90, detected: true, type: 'bullish' as const, conditionsMet: 5, totalConditions: 5, conditions: [], thresholdAdjustment: -0.05, description: 'test' } };
    const result = decide({
      technical:      bullishTechnical,
      patterns:       bullishPatterns,
      sentimentScore: 0.75,
      whaleScore:     0.72,
      macroScore:     0.68,
    });

    if (result.action !== 'BUY') throw new Error(`Expected BUY, got ${result.action}. Score: ${result.finalScore}, threshold: ${result.threshold}`);
    console.log(`       BUY triggered — score: ${result.finalScore.toFixed(3)} > threshold: ${result.threshold}`);
  });

  // ── Test 5: Strong bearish signals → SELL ────────────────────────────────
  await test('Strong bearish signals → SELL', () => {
    const bearishTechnical = {
      ...technical,
      tradeable: true,
      confidence: 0.80,
      components: { momentum: 0.22, trend: 0.18, microstructure: 0.20, volume: 0.30, timeframeAlignment: 0.85 },
    };
    const noPattern = { ...patterns, recommendedThreshold: 0.72, activePattern: null, detected: false };
    const result = decide({
      technical:      bearishTechnical,
      patterns:       noPattern,
      sentimentScore: 0.20,
      whaleScore:     0.18,
      macroScore:     0.22,
    });
    if (result.action !== 'SELL') throw new Error(`Expected SELL, got ${result.action}. Score: ${result.finalScore}`);
    console.log(`       SELL triggered — score: ${result.finalScore.toFixed(3)} < ${(1 - result.threshold).toFixed(3)}`);
  });

  // ── Test 6: No pattern raises threshold ───────────────────────────────────
  await test('No pattern → threshold is 0.72 (strict)', () => {
    // Use high confidence so decision isn't blocked before reaching threshold logic
    const highConfTechnical = { ...technical, tradeable: true, confidence: 0.75 };
    const noPattern = { ...patterns, recommendedThreshold: 0.72, activePattern: null, detected: false };
    const result = decide({ technical: highConfTechnical, patterns: noPattern });
    if (result.threshold !== 0.72) throw new Error(`Expected threshold 0.72, got ${result.threshold}`);
    console.log(`       No-pattern threshold: ${result.threshold} ✓`);
  });

  // ── Test 7: Data gaps are tracked ────────────────────────────────────────
  await test('Missing agents tracked in data gaps', () => {
    // Use high confidence so decision reaches data gap tracking logic
    const highConfTechnical = { ...technical, tradeable: true, confidence: 0.75 };
    const result = decide({ technical: highConfTechnical, patterns }); // No sentiment/whale/macro
    if (result.dataGaps.length !== 3) throw new Error(`Expected 3 data gaps, got ${result.dataGaps.length}`);
    console.log(`       Tracked ${result.dataGaps.length} data gaps: ${result.dataGaps.map(g => g.split(' ')[0]).join(', ')}`);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Decision Engine is solid. Ready to build Component 6.\n');
  else console.log('❌ Fix the failures above before moving on.\n');
}

runTests().catch(console.error);
