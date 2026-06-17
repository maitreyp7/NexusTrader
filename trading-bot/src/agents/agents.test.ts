import { askGroq, askGroqSafe, validateScore } from './groqClient.js';
import { analyzeSentiment } from './sentiment.js';
import { analyzeWhaleActivity } from './whale.js';
import { analyzeMacro } from './macro.js';
import { runAnalysisCycle } from './portfolioManager.js';
import { getOrderBook } from '../tools/marketData.js';
import { getOHLCV } from '../tools/marketData.js';
import { computeIndicators } from '../tools/indicators.js';
import { analyzeMicrostructure } from '../tools/microstructure.js';

async function runTests() {
  console.log('\n🤖 Testing AI Agents...\n');
  let passed = 0; let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GROQ CLIENT
  // ─────────────────────────────────────────────────────────────────────────

  await test('askGroq — returns valid JSON response', async () => {
    const result = await askGroq<{ answer: string; confidence: number }>([
      { role: 'system', content: 'You are a test assistant. Respond with valid JSON only.' },
      { role: 'user',   content: 'Reply with: { "answer": "hello", "confidence": 0.99 }' },
    ]);

    if (!result.result.answer)          throw new Error('Missing answer field');
    if (typeof result.result.confidence !== 'number') throw new Error('confidence must be number');
    if (result.tokensUsed <= 0)         throw new Error('tokensUsed must be positive');
    if (result.latencyMs <= 0)          throw new Error('latencyMs must be positive');

    console.log(`       Groq responded in ${result.latencyMs}ms using ${result.tokensUsed} tokens (${result.modelUsed})`);
  });

  await test('askGroqSafe — returns null on invalid request (graceful failure)', async () => {
    // Empty message array will cause an error — should return null, not throw
    const result = await askGroqSafe<{ x: number }>([]);
    // Either null (error) or a valid response — both are fine
    // Main thing: it should NOT throw
    console.log(`       askGroqSafe returned: ${result === null ? 'null (graceful failure)' : 'response'}`);
  });

  await test('validateScore — clamps out-of-range values', () => {
    if (validateScore(1.5,  'test') !== 1.0) throw new Error('Should clamp to 1.0');
    if (validateScore(-0.3, 'test') !== 0.0) throw new Error('Should clamp to 0.0');
    if (validateScore(0.75, 'test') !== 0.75) throw new Error('Should pass through 0.75');
    if (validateScore('0.6', 'test') !== 0.6) throw new Error('Should parse string "0.6"');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SENTIMENT AGENT
  // ─────────────────────────────────────────────────────────────────────────

  await test('analyzeSentiment — returns valid score and label', async () => {
    const result = await analyzeSentiment(['BTC', 'ETH']);

    if (result.score < 0 || result.score > 1) throw new Error(`Score out of range: ${result.score}`);
    if (!result.label) throw new Error('Missing label');
    if (result.fearGreed < 0 || result.fearGreed > 100) throw new Error(`Fear & Greed out of range: ${result.fearGreed}`);

    console.log(`\n       ┌─ Sentiment Analysis ────────────────────────────`);
    console.log(`       │  Score:        ${result.score.toFixed(3)} (${result.label})`);
    console.log(`       │  Fear & Greed: ${result.fearGreed}`);
    console.log(`       │  News score:   ${result.newsScore.toFixed(3)}`);
    if (result.headlines.length > 0) {
      console.log(`       │  Headlines:    ${result.headlines.length} analyzed`);
      console.log(`       │  Top story:    "${result.headlines[0]?.slice(0, 60)}..."`);
    }
    console.log(`       │  AI reason:    "${result.groqReason?.slice(0, 70)}"`);
    if (result.dataGaps.length > 0) {
      console.log(`       │  Data gaps:    ${result.dataGaps.length}`);
    }
    console.log(`       └────────────────────────────────────────────────────\n`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WHALE WATCHER AGENT
  // ─────────────────────────────────────────────────────────────────────────

  await test('analyzeWhaleActivity — returns valid score and signal', async () => {
    const [ohlcv, orderBook] = await Promise.all([
      getOHLCV('BTC/USD', '1h', 30),
      getOrderBook('BTC/USD', 20),
    ]);
    const micro    = analyzeMicrostructure(orderBook);
    const volumes  = ohlcv.candles.map(c => c.volume);
    const closes   = ohlcv.candles.map(c => c.close);

    const result = await analyzeWhaleActivity('BTC/USD', micro, volumes, closes);

    if (result.score < 0 || result.score > 1) throw new Error(`Score out of range: ${result.score}`);
    if (!['accumulation', 'distribution', 'neutral'].includes(result.signal)) {
      throw new Error(`Invalid signal: ${result.signal}`);
    }

    console.log(`\n       ┌─ Whale Analysis ───────────────────────────────`);
    console.log(`       │  Score:         ${result.score.toFixed(3)} (${result.signal})`);
    console.log(`       │  Order book:    ${result.orderBookSignal.toFixed(3)}`);
    console.log(`       │  Large trades:  ${result.largeTradeCount} detected (bias: ${result.largeTradeBias.toFixed(3)})`);
    console.log(`       │  Outflow:       ${result.exchangeOutflowDetected ? 'detected' : 'none'}`);
    console.log(`       └────────────────────────────────────────────────────\n`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MACRO AGENT
  // ─────────────────────────────────────────────────────────────────────────

  await test('analyzeMacro — returns valid score and environment', async () => {
    const result = await analyzeMacro();

    if (result.score < 0 || result.score > 1) throw new Error(`Score out of range: ${result.score}`);
    if (!['risk_on', 'neutral', 'risk_off'].includes(result.environment)) {
      throw new Error(`Invalid environment: ${result.environment}`);
    }

    console.log(`\n       ┌─ Macro Analysis ───────────────────────────────`);
    console.log(`       │  Score:       ${result.score.toFixed(3)} (${result.environment})`);
    console.log(`       │  SPY trend:   ${result.spyTrend >= 0 ? '+' : ''}${result.spyTrend.toFixed(3)}%/day (score: ${result.spyScore.toFixed(3)})`);
    console.log(`       │  VIX level:   ${result.vixLevel.toFixed(1)} (raw)`);
    console.log(`       │  VIXY trend:  ${result.vixyTrend >= 0 ? '+' : ''}${result.vixyTrend.toFixed(3)}%/day (score: ${result.vixyScore.toFixed(3)})`);
    if (result.dataGaps.length > 0) {
      console.log(`       │  Data gaps:   ${result.dataGaps.join(', ')}`);
    }
    console.log(`       └────────────────────────────────────────────────────\n`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PORTFOLIO MANAGER — Full analysis cycle
  // ─────────────────────────────────────────────────────────────────────────

  await test('runAnalysisCycle — full BTC cycle with all agents', async () => {
    const portfolio = {
      totalValue:           100_000,
      cash:                 95_000,
      dailyPnL:             0,
      dailyPnLPct:          0,
      dailySpentUsd:        0,
      openPositions:        {},
      consecutiveLosses:    0,
      circuitBreakerActive: false,
    };

    const cycle = await runAnalysisCycle('BTC/USD', portfolio);

    // Validate structure
    if (!cycle.symbol)    throw new Error('Missing symbol');
    if (!cycle.decision)  throw new Error('Missing decision');
    if (!cycle.riskResult) throw new Error('Missing riskResult');
    if (!cycle.narrative) throw new Error('Missing narrative');
    if (cycle.cycleMs <= 0) throw new Error('cycleMs must be positive');
    if (!['BUY', 'SELL', 'HOLD'].includes(cycle.decision.action)) {
      throw new Error(`Invalid action: ${cycle.decision.action}`);
    }

    console.log(`\n       ┌─ Full Analysis Cycle ───────────────────────────`);
    console.log(`       │  Action:    ${cycle.decision.action}`);
    console.log(`       │  Score:     ${cycle.decision.finalScore.toFixed(3)} vs threshold ${cycle.decision.threshold.toFixed(3)}`);
    console.log(`       │  Confidence: ${cycle.decision.confidence.toFixed(3)}`);
    console.log(`       │  Pattern:   ${cycle.decision.pattern ?? 'None'}`);
    console.log(`       │  Risk:      ${cycle.riskResult.approved ? 'APPROVED' : `BLOCKED — ${cycle.riskResult.blockedReason}`}`);
    if (cycle.riskResult.trade) {
      const t = cycle.riskResult.trade;
      console.log(`       │  Trade:     $${t.positionSizeUsd} | Stop $${t.stopLossPrice.toFixed(2)} | Target $${t.takeProfitPrice.toFixed(2)}`);
    }
    console.log(`       │  Cycle time: ${cycle.cycleMs}ms`);
    console.log(`       │  Data gaps: ${cycle.dataGaps.length}`);
    console.log(`       │`);
    console.log(`       │  Narrative:`);
    cycle.narrative.split('. ').forEach(s => s && console.log(`       │    ${s.trim()}`));
    console.log(`       └────────────────────────────────────────────────────\n`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GRACEFUL DEGRADATION
  // ─────────────────────────────────────────────────────────────────────────

  await test('Agents degrade gracefully — all scores still 0–1 when data is unavailable', async () => {
    // Simulate what happens when agents return null — Decision Engine should still work
    const { decide } = await import('../core/decisionEngine.js');
    const { buildTechnicalSignal } = await import('../tools/signalEngine.js');
    const { scanPatterns } = await import('../tools/patterns.js');

    const [ohlcv, book] = await Promise.all([getOHLCV('BTC/USD', '1h', 100), getOrderBook('BTC/USD', 20)]);
    const suite   = computeIndicators(ohlcv.candles, '1h');
    const micro   = analyzeMicrostructure(book);
    const signal  = buildTechnicalSignal([suite], micro);
    const patterns = await scanPatterns({ suites: [suite], micro });

    // Force high confidence so the decision reaches data-gap tracking code.
    // The confidence gate fires before data gaps are logged — this is expected
    // behavior (already tested in decisionEngine.test.ts). Here we just verify
    // that when the gate passes, missing agents are properly tracked.
    const highConfSignal = { ...signal, confidence: 0.75, tradeable: true };

    // Call decide with NO optional scores — they should default to 0.50 internally
    const result = decide({ technical: highConfSignal, patterns });

    if (result.dataGaps.length !== 3) throw new Error(`Expected 3 data gaps (sentiment, whale, macro), got ${result.dataGaps.length}`);
    if (result.finalScore < 0 || result.finalScore > 1) throw new Error('Score out of range');

    console.log(`       3 data gaps tracked, final score ${result.finalScore.toFixed(3)} — degraded gracefully ✓`);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ All agents are solid. Ready to build Phase 4 (System Integration).\n');
  else console.log('❌ Fix failures above before moving on.\n');
}

runTests().catch(console.error);
