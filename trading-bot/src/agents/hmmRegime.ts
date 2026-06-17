import * as fs   from 'fs';
import * as path from 'path';
import { log }            from '../core/logger.js';
import { LOGGING }        from '../config.js';
import { getEquityBars }  from '../tools/marketData.js';

// ─────────────────────────────────────────────────────────────────────────────
// HMM REGIME CLASSIFIER
//
// A Hidden Markov Model (HMM) that classifies the current market into one of
// 5 regimes. This is what separates a naive momentum bot from a professional
// quantitative system.
//
// WHY HMM?
//   Price patterns alone are noisy. On any given day, SPY might be up +0.5%
//   and that tells you almost nothing. What matters is the UNDERLYING STATE
//   the market is in — the hidden structure that drives whether a +0.5% day
//   is the start of a rally or a dead-cat bounce.
//
//   HMM works by learning that the market transitions between hidden states
//   (regimes) with measurable probabilities. It then uses current observations
//   (returns, volatility, volume) to infer which hidden state we're in.
//
// THE 5 REGIMES:
//   CRASH    — Sharp decline, very high volatility. VIX > 35. Don't trade.
//   BEAR     — Sustained downtrend. VIX 25-35. Trade very small or skip.
//   NEUTRAL  — Sideways, no clear trend. VIX 15-25. Normal sizing.
//   BULL     — Sustained uptrend, moderate volatility. VIX < 20. Full sizing.
//   EUPHORIA — Parabolic, low VIX, extreme greed. Trade cautiously (mean-rev risk).
//
// IMPLEMENTATION:
//   We implement a Gaussian HMM using the Viterbi algorithm to find the most
//   likely regime sequence. This is a simplified but mathematically sound
//   version that doesn't require external ML libraries.
//
//   Each regime is modeled by:
//     - mean daily return (μ)
//     - return standard deviation (σ)
//     - transition probabilities to each other regime
//
//   The model is initialized with sensible priors from quant research and
//   then adapts its parameters as more data is observed (online learning).
//
// PERSISTENCE:
//   Model parameters are saved to logs/brain/hmm-model.json after each
//   classification. This means the model improves with every trading day.
// ─────────────────────────────────────────────────────────────────────────────

export type RegimeName = 'crash' | 'bear' | 'neutral' | 'bull' | 'euphoria';

export interface RegimeState {
  regime:      RegimeName;
  confidence:  number;      // 0–1: how certain we are about this regime
  probability: number[];    // P(regime[i]) for all 5 regimes
  viterbiPath: RegimeName[]; // Most likely sequence over the observation window
  observations: number[];   // The returns used for classification
  classifiedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// HMM PARAMETERS
//
// These are the starting priors. The model updates them after each session.
// Based on published research on equity market regime detection.
// ─────────────────────────────────────────────────────────────────────────────

interface RegimeParams {
  name:    RegimeName;
  mu:      number;    // mean daily return (%)
  sigma:   number;    // standard deviation of daily return (%)
  // How often this regime persists vs transitions to another (row sums to 1)
  transition: {
    crash:    number;
    bear:     number;
    neutral:  number;
    bull:     number;
    euphoria: number;
  };
}

// Initial parameters from academic literature on US equity regimes
const DEFAULT_PARAMS: RegimeParams[] = [
  {
    name: 'crash',
    mu: -2.5, sigma: 3.5,
    transition: { crash: 0.60, bear: 0.30, neutral: 0.08, bull: 0.01, euphoria: 0.01 },
  },
  {
    name: 'bear',
    mu: -0.8, sigma: 1.8,
    transition: { crash: 0.05, bear: 0.65, neutral: 0.25, bull: 0.04, euphoria: 0.01 },
  },
  {
    name: 'neutral',
    mu: 0.05, sigma: 0.9,
    transition: { crash: 0.02, bear: 0.12, neutral: 0.60, bull: 0.22, euphoria: 0.04 },
  },
  {
    name: 'bull',
    mu: 0.6, sigma: 0.7,
    transition: { crash: 0.01, bear: 0.05, neutral: 0.20, bull: 0.65, euphoria: 0.09 },
  },
  {
    name: 'euphoria',
    mu: 1.2, sigma: 0.5,
    transition: { crash: 0.03, bear: 0.07, neutral: 0.15, bull: 0.30, euphoria: 0.45 },
  },
];

const REGIME_NAMES: RegimeName[] = ['crash', 'bear', 'neutral', 'bull', 'euphoria'];
const N = REGIME_NAMES.length;

// ─────────────────────────────────────────────────────────────────────────────
// FILE PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

const BRAIN_DIR  = path.join(LOGGING.sessionLogDir, '..', 'brain');
const MODEL_PATH = path.join(BRAIN_DIR, 'hmm-model.json');
const CACHE_PATH = path.join(BRAIN_DIR, 'hmm-cache.json');

interface StoredModel {
  params:     RegimeParams[];
  updatedAt:  string;
  sessions:   number;
}

function loadModel(): RegimeParams[] {
  if (!fs.existsSync(MODEL_PATH)) return DEFAULT_PARAMS;
  try {
    const stored = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8')) as StoredModel;
    return stored.params;
  } catch {
    return DEFAULT_PARAMS;
  }
}

function saveModel(params: RegimeParams[], sessions: number): void {
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  const stored: StoredModel = {
    params,
    updatedAt: new Date().toISOString(),
    sessions,
  };
  fs.writeFileSync(MODEL_PATH, JSON.stringify(stored, null, 2), 'utf-8');
}

// Cache the last classification to avoid re-running within the same session
function loadCache(): RegimeState | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as RegimeState & { classifiedAt: string };
    const ageMs = Date.now() - new Date(cached.classifiedAt).getTime();
    // Cache valid for 15 minutes
    if (ageMs < 15 * 60 * 1000) return { ...cached, classifiedAt: new Date(cached.classifiedAt) };
    return null;
  } catch {
    return null;
  }
}

function saveCache(state: RegimeState): void {
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// GAUSSIAN PDF
// P(observation | regime) — how likely is this return given this regime's params?
// ─────────────────────────────────────────────────────────────────────────────

function gaussianPdf(x: number, mu: number, sigma: number): number {
  const variance = sigma * sigma;
  const coeff    = 1 / Math.sqrt(2 * Math.PI * variance);
  const exponent = -((x - mu) ** 2) / (2 * variance);
  // Add floor to prevent numerical zero (log(0) = -Infinity)
  return Math.max(coeff * Math.exp(exponent), 1e-10);
}

// ─────────────────────────────────────────────────────────────────────────────
// VITERBI ALGORITHM
//
// Finds the most likely sequence of hidden states given the observations.
// This is the core of HMM — instead of just asking "which regime fits today?",
// it asks "which sequence of regimes best explains the last 20 days?".
//
// The final state in the sequence is our current regime.
// ─────────────────────────────────────────────────────────────────────────────

function viterbi(returns: number[], params: RegimeParams[]): {
  path:     RegimeName[];
  probs:    number[];
} {
  const T = returns.length;

  // viterbi[t][i] = log probability of most likely path ending in state i at time t
  const v:    number[][]     = Array.from({ length: T }, () => new Array(N).fill(-Infinity));
  const back: number[][]     = Array.from({ length: T }, () => new Array(N).fill(0));

  // Initialize at t=0: uniform prior (we don't know what state we started in)
  const initProb = Math.log(1 / N);
  for (let i = 0; i < N; i++) {
    const emission = Math.log(gaussianPdf(returns[0], params[i].mu, params[i].sigma));
    v[0][i] = initProb + emission;
  }

  // Forward pass
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < N; j++) {
      let maxProb = -Infinity;
      let maxState = 0;
      for (let i = 0; i < N; i++) {
        const regimeName = REGIME_NAMES[i];
        const transProb  = Math.log(params[i].transition[REGIME_NAMES[j]]);
        const prob       = v[t - 1][i] + transProb;
        if (prob > maxProb) { maxProb = prob; maxState = i; }
      }
      const emission = Math.log(gaussianPdf(returns[t], params[j].mu, params[j].sigma));
      v[t][j] = maxProb + emission;
      back[t][j] = maxState;
    }
  }

  // Backtrack to get the path
  const path: RegimeName[] = new Array(T);
  let state = v[T - 1].indexOf(Math.max(...v[T - 1]));
  path[T - 1] = REGIME_NAMES[state];
  for (let t = T - 1; t > 0; t--) {
    state = back[t][state];
    path[t - 1] = REGIME_NAMES[state];
  }

  // Convert final step log-probs to probabilities via softmax
  const finalLogProbs = v[T - 1];
  const maxLog        = Math.max(...finalLogProbs);
  const exps          = finalLogProbs.map(lp => Math.exp(lp - maxLog));
  const sum           = exps.reduce((a, b) => a + b, 0);
  const probs         = exps.map(e => e / sum);

  return { path, probs };
}

// ─────────────────────────────────────────────────────────────────────────────
// BAUM-WELCH PARAMETER UPDATE (simplified M-step)
//
// After seeing a trade outcome, we update the model parameters.
// This is the "learning" part — the model refines its estimate of each
// regime's mean return and volatility based on actual observations.
//
// Full Baum-Welch would need the forward-backward algorithm — we use
// a simpler online update: weighted exponential moving average.
// ─────────────────────────────────────────────────────────────────────────────

function updateRegimeParams(
  params: RegimeParams[],
  regime: RegimeName,
  observedReturns: number[],
  learningRate = 0.05,
): RegimeParams[] {
  const idx = REGIME_NAMES.indexOf(regime);
  if (idx === -1 || observedReturns.length === 0) return params;

  const obsN   = observedReturns.length;
  const obsMu  = observedReturns.reduce((a, b) => a + b, 0) / obsN;
  const obsSig = Math.sqrt(
    observedReturns.reduce((s, r) => s + (r - obsMu) ** 2, 0) / obsN
  );

  if (obsSig === 0) return params;

  const updated = params.map((p, i) => {
    if (i !== idx) return p;
    const newMu    = p.mu    * (1 - learningRate) + obsMu  * learningRate;
    const newSigma = p.sigma * (1 - learningRate) + obsSig * learningRate;
    return { ...p, mu: Math.round(newMu * 1000) / 1000, sigma: Math.max(0.1, Math.round(newSigma * 1000) / 1000) };
  });

  return updated;
}

// After each session that stays in the same regime, nudge the self-transition
// probability slightly upward (the regime is persisting). Cap alpha at 0.05
// to prevent fast over-fitting to a single streak.
function updateTransitionProbabilities(
  params:   RegimeParams[],
  regime:   RegimeName,
  sessions: number,
): RegimeParams[] {
  const alpha = 0.05;
  const idx   = REGIME_NAMES.indexOf(regime);
  if (idx === -1) return params;

  return params.map((p, i) => {
    if (i !== idx) return p;

    // Nudge self-transition probability up
    const oldSelf = p.transition[regime];
    const newSelf = Math.min(0.95, oldSelf + alpha * (1 - oldSelf));
    const delta   = newSelf - oldSelf;

    // Shrink all other transitions proportionally to keep row sum = 1
    const otherKeys = REGIME_NAMES.filter(r => r !== regime) as RegimeName[];
    const otherSum  = otherKeys.reduce((s, r) => s + p.transition[r], 0);
    const newTransition = { ...p.transition, [regime]: Math.round(newSelf * 1000) / 1000 };
    if (otherSum > 0) {
      for (const r of otherKeys) {
        newTransition[r] = Math.round((p.transition[r] - delta * (p.transition[r] / otherSum)) * 1000) / 1000;
      }
    }

    // Sessions logged for context but not used in calculation
    void sessions;

    return { ...p, transition: newTransition };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — classifyRegime
//
// Fetches recent SPY daily returns and runs the Viterbi algorithm to classify
// the current market regime.
//
// Returns a RegimeState with the current regime, confidence, and the full
// probability distribution across all 5 regimes.
// ─────────────────────────────────────────────────────────────────────────────

export async function classifyRegime(): Promise<RegimeState> {
  // Check cache first (avoid hammering the API during the trading session)
  const cached = loadCache();
  if (cached) {
    log.debug(`[HMM] Using cached regime: ${cached.regime} (${(cached.confidence * 100).toFixed(0)}% confidence)`);
    return cached;
  }

  log.info('[HMM] Running regime classification...');

  const params = loadModel();

  // Fetch 30 daily SPY bars — enough history for Viterbi to work well
  let returns: number[] = [];
  try {
    const bars = await getEquityBars('SPY', '1d', 32);
    if (bars.length < 5) throw new Error('Not enough bars');

    // Compute daily returns as % change
    for (let i = 1; i < bars.length; i++) {
      const ret = ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100;
      returns.push(Math.round(ret * 10000) / 10000);
    }
  } catch (err) {
    log.warn(`[HMM] Could not fetch SPY bars: ${err instanceof Error ? err.message : err} — using neutral fallback`);
    return neutralFallback();
  }

  if (returns.length < 3) return neutralFallback();

  // Run Viterbi on the return sequence
  const { path, probs } = viterbi(returns, params);

  // Current regime = last state in the Viterbi path
  const currentRegime = path[path.length - 1];
  const confidence    = probs[REGIME_NAMES.indexOf(currentRegime)];

  const state: RegimeState = {
    regime:       currentRegime,
    confidence:   Math.round(confidence * 1000) / 1000,
    probability:  probs.map(p => Math.round(p * 1000) / 1000),
    viterbiPath:  path.slice(-10),  // Last 10 states for display
    observations: returns.slice(-10),
    classifiedAt: new Date(),
  };

  saveCache(state);

  log.info(`[HMM] Regime: ${currentRegime.toUpperCase()} (confidence: ${(confidence * 100).toFixed(1)}%)`);
  log.info(`[HMM] Probabilities: ${REGIME_NAMES.map((r, i) => `${r}: ${(probs[i] * 100).toFixed(0)}%`).join(', ')}`);

  return state;
}

function neutralFallback(): RegimeState {
  return {
    regime:       'neutral',
    confidence:   0.5,
    probability:  [0.05, 0.15, 0.5, 0.25, 0.05],
    viterbiPath:  ['neutral'],
    observations: [],
    classifiedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — updateModelAfterSession
//
// Called at end of session by brain.ts.
// Updates the HMM parameters with today's observed returns.
// ─────────────────────────────────────────────────────────────────────────────

export async function updateHmmAfterSession(
  regime:  RegimeName,
  returns: number[],
): Promise<void> {
  if (returns.length < 3) return;

  let params   = loadModel();
  let stored: StoredModel = { params, sessions: 0, updatedAt: '' };
  if (fs.existsSync(MODEL_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf-8')) as StoredModel;
    } catch {
      log.warn('[HMM] Corrupted model file — using in-memory params');
    }
  }

  params = updateRegimeParams(params, regime, returns);
  params = updateTransitionProbabilities(params, regime, stored.sessions);
  saveModel(params, stored.sessions + 1);

  log.info(`[HMM] Model updated for regime ${regime} (${stored.sessions + 1} total sessions)`);

  // Clear cache so next classification uses fresh model
  if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — getRegimeAllocationMultiplier
//
// Returns a multiplier (0.0–1.5) that scales position size based on regime.
// This is the "Dynamic Allocation" piece.
//
//   CRASH    → 0.0  (no trading)
//   BEAR     → 0.4  (very small)
//   NEUTRAL  → 0.8  (slightly reduced)
//   BULL     → 1.0  (full size — baseline)
//   EUPHORIA → 0.6  (careful — mean-reversion risk)
//
// Example: In a BULL regime, a $1,000 position stays $1,000.
//          In a BEAR regime, that same position becomes $400.
//          In a CRASH regime, no trade is placed at all.
// ─────────────────────────────────────────────────────────────────────────────

export function getRegimeAllocationMultiplier(regime: RegimeName): number {
  const multipliers: Record<RegimeName, number> = {
    crash:    0.00,   // Don't trade — capital preservation
    bear:     0.40,   // Very defensive
    neutral:  0.80,   // Slightly cautious
    bull:     1.00,   // Full position size
    euphoria: 0.60,   // Trim back — tops are unpredictable
  };
  return multipliers[regime];
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — getRegimeSummary
// Human-readable description of the current regime for Discord/dashboard
// ─────────────────────────────────────────────────────────────────────────────

export function getRegimeSummary(state: RegimeState): string {
  const desc: Record<RegimeName, string> = {
    crash:    'CRASH — extreme volatility, no trading',
    bear:     'BEAR — sustained downtrend, very small sizing',
    neutral:  'NEUTRAL — sideways market, normal sizing',
    bull:     'BULL — trending up, full sizing',
    euphoria: 'EUPHORIA — parabolic, reduced sizing (reversal risk)',
  };
  const mult = getRegimeAllocationMultiplier(state.regime);
  return `${desc[state.regime]} | Confidence: ${(state.confidence * 100).toFixed(0)}% | Position multiplier: ${mult}×`;
}
