import { getOHLCV, getOrderBook, getCurrentPrice } from '../tools/marketData.js';
import { computeIndicators, computeATR } from '../tools/indicators.js';
import { analyzeMicrostructure } from '../tools/microstructure.js';
import { buildTechnicalSignal } from '../tools/signalEngine.js';
import { scanPatterns } from '../tools/patterns.js';
import { decide, DecisionResult } from '../core/decisionEngine.js';
import { assessRisk, PortfolioState } from '../core/riskManager.js';
import { analyzeSentiment } from './sentiment.js';
import { analyzeWhaleActivity } from './whale.js';
import { analyzeMacro } from './macro.js';
import { askGroqSafe } from './groqClient.js';
import { log } from '../core/logger.js';
import { COINS } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO MANAGER — The Orchestrator
//
// This is the "brain" of the trading session. It runs the full analysis cycle
// for a single symbol and returns a complete, actionable recommendation.
//
// WHAT IT DOES EVERY 15 MINUTES (per symbol):
//   1. Fetch fresh market data (price, candles, order book)
//   2. Compute all technical indicators + microstructure
//   3. Run all three AI agents in parallel (sentiment, whale, macro)
//   4. Pass everything to the Decision Engine
//   5. If action = BUY, pass to Risk Manager for sizing
//   6. Ask Groq to write a human-readable trade narrative
//   7. Return the full analysis with every number and the narrative
//
// The session orchestrator calls this function for each symbol on the watchlist.
// It doesn't execute orders — it just produces the recommendation.
// The orchestrator decides whether to act on it.
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalysisCycle {
  symbol:     string;
  decision:   DecisionResult;
  riskResult: ReturnType<typeof assessRisk>;
  narrative:  string;       // Groq-written human explanation
  dataGaps:   string[];     // All missing data sources across all agents
  cycleMs:    number;       // How long the full cycle took
  analyzedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — runAnalysisCycle
// ─────────────────────────────────────────────────────────────────────────────
export async function runAnalysisCycle(
  symbol:    string,
  portfolio: PortfolioState,
): Promise<AnalysisCycle> {
  const startMs  = Date.now();
  const dataGaps: string[] = [];

  // ── Step 1: Fetch all market data in parallel ──────────────────────────────
  // All three timeframes + order book fetched simultaneously to minimize latency
  const [btc1h, btc4h, btc1d, orderBook] = await Promise.all([
    getOHLCV(symbol, '1h', 100),
    getOHLCV(symbol, '4h', 60),
    getOHLCV(symbol, '1d', 100),
    getOrderBook(symbol, 20),
  ]);

  const currentPrice = btc1h.candles[btc1h.candles.length - 1].close;

  // ── Step 2: Compute technical indicators for each timeframe ───────────────
  const suite1h = computeIndicators(btc1h.candles, '1h');
  const suite4h = computeIndicators(btc4h.candles, '4h');
  const suite1d = computeIndicators(btc1d.candles, '1d');
  const micro   = analyzeMicrostructure(orderBook);

  // Compute ATR from 1h data for Risk Manager position sizing
  const candles1h    = btc1h.candles;
  const atr          = computeATR(
    candles1h.map(c => c.high),
    candles1h.map(c => c.low),
    candles1h.map(c => c.close),
    14,
  );

  // ── Step 3: Build technical signal + scan patterns ─────────────────────────
  const technical = buildTechnicalSignal([suite1h, suite4h, suite1d], micro);
  const patterns  = await scanPatterns({ suites: [suite1h, suite4h, suite1d], micro });

  // ── Step 4: Run AI agents in parallel ─────────────────────────────────────
  // All three agents fetch data and score independently.
  // If any agent fails, it returns a neutral score — trading continues.
  const [sentimentResult, whaleResult, macroResult] = await Promise.all([
    analyzeSentiment([symbol.replace('/USD', '')]).catch(err => {
      dataGaps.push(`Sentiment agent failed: ${err.message}`);
      return null;
    }),
    analyzeWhaleActivity(
      symbol, micro,
      candles1h.map(c => c.volume),
      candles1h.map(c => c.close),
    ).catch(err => {
      dataGaps.push(`Whale agent failed: ${err.message}`);
      return null;
    }),
    analyzeMacro().catch(err => {
      dataGaps.push(`Macro agent failed: ${err.message}`);
      return null;
    }),
  ]);

  // Collect data gaps from each agent
  if (sentimentResult?.dataGaps) dataGaps.push(...sentimentResult.dataGaps);
  if (whaleResult?.dataGaps)     dataGaps.push(...whaleResult.dataGaps);
  if (macroResult?.dataGaps)     dataGaps.push(...macroResult.dataGaps);

  // ── Agent fallback tracking ────────────────────────────────────────────────
  // Log which agents returned real data vs fell back to neutral (0.50).
  // This tells you over time whether each agent is actually contributing
  // signal or just adding noise at the neutral midpoint.
  const agentStatus = [
    sentimentResult ? `sentiment=${sentimentResult.score.toFixed(2)}(real)` : 'sentiment=0.50(fallback)',
    whaleResult     ? `whale=${whaleResult.score.toFixed(2)}(real)`         : 'whale=0.50(fallback)',
    macroResult     ? `macro=${macroResult.score.toFixed(2)}(real)`         : 'macro=0.50(fallback)',
  ].join(' | ');
  log.debug(`[Agents] ${symbol}: ${agentStatus}`);

  // If all three agents fell back, warn — this means 40% of the decision is dead weight
  const fallbackCount = [sentimentResult, whaleResult, macroResult].filter(r => r === null).length;
  if (fallbackCount === 3) {
    log.warn(`[Agents] ${symbol}: ALL external agents failed — decision based on technical + micro only (60% of normal signal)`);
  } else if (fallbackCount > 0) {
    log.info(`[Agents] ${symbol}: ${fallbackCount}/3 agent(s) using neutral fallback — ${agentStatus}`);
  }

  // ── Step 5: Decision Engine ────────────────────────────────────────────────
  const decision = decide({
    technical,
    patterns,
    sentimentScore: sentimentResult?.score,   // undefined if agent failed → neutral (0.50)
    whaleScore:     whaleResult?.score,
    macroScore:     macroResult?.score,
  });

  // ── Step 6: Risk Manager ───────────────────────────────────────────────────
  const riskResult = assessRisk(decision, atr, currentPrice, portfolio, symbol);

  // ── Step 7: Generate trade narrative via Groq ──────────────────────────────
  // Only run if we have a meaningful decision (BUY or SELL)
  // HOLD decisions get a simpler narrative without burning Groq tokens
  const narrative = await generateNarrative(
    symbol, currentPrice, decision, riskResult,
    sentimentResult, whaleResult, macroResult,
  );

  return {
    symbol,
    decision,
    riskResult,
    narrative,
    dataGaps: [...new Set(dataGaps)],  // Deduplicate
    cycleMs:  Date.now() - startMs,
    analyzedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NARRATIVE GENERATOR
// Asks Groq to write a concise, human-readable explanation of the decision.
// This is what gets posted to Discord and logged in the journal.
// ─────────────────────────────────────────────────────────────────────────────
async function generateNarrative(
  symbol:     string,
  price:      number,
  decision:   DecisionResult,
  risk:       ReturnType<typeof assessRisk>,
  sentiment:  Awaited<ReturnType<typeof analyzeSentiment>> | null,
  whale:      Awaited<ReturnType<typeof analyzeWhaleActivity>> | null,
  macro:      Awaited<ReturnType<typeof analyzeMacro>> | null,
): Promise<string> {
  // For HOLD decisions, don't waste tokens — generate a simple reason
  if (decision.action === 'HOLD') {
    return decision.blockedBy
      ? `HOLD — ${decision.blockedBy}`
      : `HOLD — Score ${decision.finalScore.toFixed(3)} vs threshold ${decision.threshold.toFixed(3)}. No actionable setup.`;
  }

  const tradeContext = risk.trade
    ? `Entry: $${risk.trade.entryPrice.toFixed(2)}, Stop: $${risk.trade.stopLossPrice.toFixed(2)}, Target: $${risk.trade.takeProfitPrice.toFixed(2)}, Size: $${risk.trade.positionSizeUsd.toFixed(2)}`
    : risk.blockedReason ?? 'Blocked by risk manager';

  const groqResult = await askGroqSafe<{ narrative: string }>([
    {
      role:    'system',
      content: `You are a professional crypto trading analyst writing a brief trade report.
Write in clear, direct language. Maximum 3 sentences. No jargon. No emojis.
Focus on WHY the action makes sense given the signals. Always mention the key risk.
Respond with ONLY valid JSON: { "narrative": "your explanation here" }`,
    },
    {
      role: 'user',
      content: `Write a trade narrative for this decision:

Symbol: ${symbol} at $${price.toFixed(2)}
Action: ${decision.action}
Score: ${decision.finalScore.toFixed(3)} (threshold: ${decision.threshold.toFixed(3)})
Confidence: ${decision.confidence.toFixed(3)}
Pattern: ${decision.pattern ?? 'None'}

Signals:
- Technical: ${decision.scores.technical.toFixed(3)} (momentum + trend + volume)
- Microstructure: ${decision.scores.microstructure.toFixed(3)} (order book)
- Sentiment: ${decision.scores.sentiment.toFixed(3)} ${sentiment ? `(${sentiment.label}, F&G: ${sentiment.fearGreed})` : '(neutral default)'}
- Whale: ${decision.scores.whale.toFixed(3)} ${whale ? `(${whale.signal})` : '(neutral default)'}
- Macro: ${decision.scores.macro.toFixed(3)} ${macro ? `(${macro.environment})` : '(neutral default)'}

Trade parameters: ${tradeContext}`,
    },
  ]);

  return groqResult?.result?.narrative
    ?? `${decision.action} — Score: ${decision.finalScore.toFixed(3)}, Pattern: ${decision.pattern ?? 'None'}`;
}
