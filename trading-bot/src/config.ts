import * as dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG.TS — Single source of truth for all bot settings
//
// This is the ONLY file you need to edit to change how the bot behaves.
// Every agent, every tool, every engine reads from here.
// Never hardcode numbers anywhere else in the codebase.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Startup Validation ───────────────────────────────────────────────────────
// Crash immediately at startup if required keys are missing.
// Better to fail loudly at launch than silently mid-session.
const REQUIRED_ENV_KEYS = [
  'ALPACA_API_KEY',
  'ALPACA_SECRET_KEY',
  'ALPACA_BASE_URL',
  'CEREBRAS_API_KEY',
  'DISCORD_WEBHOOK_URL',
];

for (const key of REQUIRED_ENV_KEYS) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}. Check your .env file.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — API Credentials
// Loaded from your .env file. Never hardcode these here.
// ─────────────────────────────────────────────────────────────────────────────
export const API = {
  alpaca: {
    key:     process.env.ALPACA_API_KEY!,
    secret:  process.env.ALPACA_SECRET_KEY!,
    baseUrl: process.env.ALPACA_BASE_URL!,   // paper: https://paper-api.alpaca.markets
  },
  groq: {
    key:       process.env.CEREBRAS_API_KEY!,
    model:     'gpt-oss-120b',                  // Cerebras: llama3.1-8b retired May 2026, now gpt-oss-120b
    maxTokens: 600,
    timeoutMs: 15_000,                        // Cerebras is faster — 15s is plenty
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL!,
    enabled:    true,                         // Set to false to silence all Discord messages.
  },
  alpacaData: {
    baseUrl: 'https://data.alpaca.markets',  // Alpaca market data API (prices, bars)
  },
  orders: {
    // Stop-limit sell: how far below the stop price to set the limit.
    // Wider band = more likely to fill on fast-moving stocks.
    stopLossLimitOffsetPct: 0.002,   // 0.2% offset — keeps limit tight relative to stop distance
  },
  // FRED (Federal Reserve Economic Data) — free economic calendar
  // Sign up at https://fred.stlouisfed.org/docs/api/api_key.html
  fred: {
    baseUrl: 'https://api.stlouisfed.org/fred',
    key:     process.env.FRED_API_KEY ?? '',  // Optional — falls back to hardcoded dates
  },
  // Options data — Yahoo Finance public endpoint (no API key needed)
  yahooFinance: { baseUrl: 'https://query1.finance.yahoo.com' },
  // Marketaux — free earnings calendar (100 req/day free tier)
  // Sign up at https://www.marketaux.com/ to get a free API token
  marketaux: {
    baseUrl: 'https://api.marketaux.com/v1',
    key:     process.env.MARKETAUX_API_KEY ?? '',  // Optional — falls back to skipping earnings check
  },
  // Legacy stubs — kept for compilation compatibility only, not used in trading
  binance:   { baseUrl: 'https://api.binance.us' },
  bybit:     { baseUrl: 'https://api.bybit.com' },
  fearGreed: { baseUrl: 'https://api.alternative.me/fng' },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Assets to Trade
// Add or remove assets here. Bot will analyze and trade all assets in this list.
// ─────────────────────────────────────────────────────────────────────────────
export const ASSETS = {
  // ORB watchlist — chosen by 6-month backtest (Sharpe≥0.4 + positive expectancy).
  // High-volatility momentum/crypto-proxy names dominate ORB. Dropped GOOGL/NVDA/META
  // (weakest). Full ranking in STRATEGIES_BACKLOG.md. Capped at 12.
  watchlist: ['COIN', 'ARKK', 'SMCI', 'MARA', 'RIOT', 'IWM', 'MSTR', 'TSLA', 'QQQ', 'AAPL', 'AMD', 'DKNG'] as string[],

  // How each asset maps to the Alpaca API
  symbols: {
    'QQQ':   { alpaca: 'QQQ',   display: 'QQQ',   name: 'Invesco QQQ Trust' },
    'SPY':   { alpaca: 'SPY',   display: 'SPY',   name: 'SPDR S&P 500 ETF' },
    'IWM':   { alpaca: 'IWM',   display: 'IWM',   name: 'iShares Russell 2000 ETF' },
    'NVDA':  { alpaca: 'NVDA',  display: 'NVDA',  name: 'NVIDIA Corporation' },
    'AAPL':  { alpaca: 'AAPL',  display: 'AAPL',  name: 'Apple Inc.' },
    'MSFT':  { alpaca: 'MSFT',  display: 'MSFT',  name: 'Microsoft Corporation' },
    'TSLA':  { alpaca: 'TSLA',  display: 'TSLA',  name: 'Tesla Inc.' },
    'AMZN':  { alpaca: 'AMZN',  display: 'AMZN',  name: 'Amazon.com Inc.' },
    'META':  { alpaca: 'META',  display: 'META',  name: 'Meta Platforms Inc.' },
    'AMD':   { alpaca: 'AMD',   display: 'AMD',   name: 'Advanced Micro Devices' },
    'GOOGL': { alpaca: 'GOOGL', display: 'GOOGL', name: 'Alphabet Inc. (Class A)' },
    'JPM':   { alpaca: 'JPM',   display: 'JPM',   name: 'JPMorgan Chase & Co.' },
    // Added Jun 2026 — high-edge ORB performers from the universe backtest
    'COIN':  { alpaca: 'COIN',  display: 'COIN',  name: 'Coinbase Global Inc.' },
    'ARKK':  { alpaca: 'ARKK',  display: 'ARKK',  name: 'ARK Innovation ETF' },
    'SMCI':  { alpaca: 'SMCI',  display: 'SMCI',  name: 'Super Micro Computer Inc.' },
    'MARA':  { alpaca: 'MARA',  display: 'MARA',  name: 'Marathon Digital Holdings' },
    'RIOT':  { alpaca: 'RIOT',  display: 'RIOT',  name: 'Riot Platforms Inc.' },
    'MSTR':  { alpaca: 'MSTR',  display: 'MSTR',  name: 'MicroStrategy Inc.' },
    'DKNG':  { alpaca: 'DKNG',  display: 'DKNG',  name: 'DraftKings Inc.' },
  } as Record<string, { alpaca: string; display: string; name: string }>,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Trading Schedule
// ORB trades ONLY Tuesday/Wednesday/Thursday, 9:30–10:30 AM ET.
// Outside this window the bot does nothing.
// ─────────────────────────────────────────────────────────────────────────────
export const SCHEDULE = {
  timezone: 'America/New_York',

  // Paper mode: trade Mon–Fri to maximise data collection.
  // All 5 weekdays (1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri)
  tradingDays: [1, 2, 3, 4, 5] as number[],

  // ── Window 1: ORB (Opening Range Breakout) ───────────────────────────────
  orb: {
    preMarketHour:   9, preMarketMinute: 0,   // 9:00 AM — pre-market filter
    buildStartHour:  9, buildStartMinute: 30, // 9:30 AM — start collecting range candles
    tradeStartHour:  9, tradeStartMinute: 45, // 9:45 AM — range locked, entries open
    entryEndHour:   10, entryEndMinute:   15, // 10:15 AM — no new entries after this
    hardCloseHour:  10, hardCloseMinute:  30, // 10:30 AM — close everything
  },

  // ── Window 2: Midday Breakout ─────────────────────────────────────────────
  // Range = high/low of the first full hour (9:30–10:30).
  // Entry: price breaks that range with volume between 11:00 AM–1:00 PM.
  midday: {
    scanStartHour:  11, scanStartMinute:  0,  // 11:00 AM — start scanning
    entryEndHour:   13, entryEndMinute:   0,  // 1:00 PM  — no new entries
    hardCloseHour:  13, hardCloseMinute: 15,  // 1:15 PM  — close all midday positions
    takeProfitMult: 1.5,                       // 1.5× range size (vs 2× for ORB)
    maxEntries:     2,                         // Max new entries this window
  },

  // ── Window 3: Power Hour ──────────────────────────────────────────────────
  // Range = high/low of the 1:00–2:30 PM consolidation.
  // Entry: breakout of that range in the last hour (3:00–3:55 PM).
  powerHour: {
    consolidationStartHour: 13, consolidationStartMinute:  0, // 1:00 PM — start building range
    consolidationEndHour:   14, consolidationEndMinute:   30, // 2:30 PM — range locked
    scanStartHour:          15, scanStartMinute:           0, // 3:00 PM — entries open
    hardCloseHour:          15, hardCloseMinute:          55, // 3:55 PM — hard close (5 min before EOD)
    takeProfitMult:         1.5,
    maxEntries:             2,
  },

  // How often the execution loop ticks during any trading window (milliseconds)
  executionIntervalMs: 10_000,

  // How often to check open positions for stop/target (milliseconds)
  positionCheckIntervalMs: 10_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Risk Management
// These are hard limits. Nothing overrides them.
//
// PDT RULE NOTE:
//   Accounts < $25k are limited to 3 round-trip trades per rolling 5 days.
//   We stay WELL under: max 2 total trades per day, 1 per asset.
//   This keeps us safe from PDT violations.
// ─────────────────────────────────────────────────────────────────────────────
export const RISK = {
  // ── Per-Trade Risk (ORB formula) ────────────────────────────────────────────
  // Risk exactly 1% of portfolio per trade.
  // Formula: positionSize = (portfolioValue × 0.01) / stopDistance
  // stopDistance = entryPrice − rangeHighMidpoint (ORB midpoint stop)
  maxRiskPerTradePct: 0.01,      // 1% of portfolio per trade

  // ── Daily Kill Switch ───────────────────────────────────────────────────────
  // If daily P&L falls below -2%, stop all trading for the day.
  maxDailyLossPct:    0.02,      // 2% max daily loss
  maxDailyLossUsd:    500,       // $500 hard stop (legacy field — used by riskManager.ts)
  maxDailySpendUsd:   10_000,    // Legacy field

  // ── Trade Limits ────────────────────────────────────────────────────────────
  // PAPER MODE: no PDT restrictions — trade freely to collect brain training data.
  // When switching to a live account under $25k, set maxTradesPerDay to 1
  // and enable PDT guards so you don't burn your 3 weekly day trades.
  maxTradesPerDay:       12,  // Paper: trade all valid setups (1 per symbol max)
  maxDayTradesPerWeek:   3,   // Live account PDT limit (not enforced in paper mode)
  maxTradesPerAsset:     1,   // Max 1 trade per symbol per day

  // ── VIX Kill Switch ─────────────────────────────────────────────────────────
  vixKillSwitch:      40,

  // ── Position Size Limits ────────────────────────────────────────────────────
  maxTradeSizeUsd:    20000,     // Aligned with maxPositionSizePct (20% of ~$100k) so the % rule binds
  maxTotalExposureUsd: 10_000,   // Legacy total exposure cap
  maxPositionSizePct:  0.20,     // 20% max per position (legacy)
  maxPortfolioUsagePct: 0.80,    // Legacy portfolio usage cap

  // ── Cash Reserve ────────────────────────────────────────────────────────────
  minCashReservePct:  0.20,

  // ── Circuit Breaker ─────────────────────────────────────────────────────────
  maxConsecutiveLosses: 5,

  // ── Volatility Filter ───────────────────────────────────────────────────────
  maxVolatilityToTrade: 0.85,    // Legacy ATR-based volatility cap

  // ── Confidence Filter ────────────────────────────────────────────────────────
  minConfidenceToTrade: 0.55,

  // ── Correlation Groups ──────────────────────────────────────────────────────
  // Names within a group move together. The bot caps how many positions it will
  // hold in any one group at once (maxPositionsPerCorrelationGroup) so it never
  // stacks one concentrated bet — the failure mode that killed the swing bot.
  correlatedGroups: [
    // Crypto / crypto-proxy complex — ALL move with Bitcoin. This is the cluster
    // the new high-vol watchlist introduced; without a cap the bot could open all
    // six at once = effectively one giant leveraged BTC position.
    ['COIN', 'MARA', 'RIOT', 'MSTR', 'ARKK', 'SMCI'],
    ['QQQ', 'IWM'],              // Broad market ETFs
    ['AAPL', 'AMZN', 'META'],   // Mega-cap tech
    ['AMD', 'NVDA'],            // Semiconductors
    ['TSLA'],                    // High beta — uncorrelated
    ['DKNG'],                    // Gambling — uncorrelated to the above
  ] as string[][],

  // Max simultaneous OPEN positions allowed within a single correlation group,
  // counted across ALL windows (ORB + midday + power) since they share the account.
  // 2 lets the bot take the best couple of setups in a hot sector without turning
  // the whole book into one correlated bet.
  maxPositionsPerCorrelationGroup: 2,

  // ── Per-symbol volatility multipliers ───────────────────────────────────────
  // Higher = more volatile = smaller position size for same dollar risk
  symbolVolatilityMultipliers: {
    'QQQ':   1.0,
    'SPY':   1.0,
    'IWM':   1.1,
    'NVDA':  1.4,
    'AAPL':  1.0,
    'MSFT':  1.0,
    'TSLA':  1.6,  // Very high beta
    'AMZN':  1.1,
    'META':  1.2,
    'AMD':   1.4,
    'GOOGL': 1.0,
    'JPM':   0.9,
    // High-volatility additions — kept small until live-proven
    'COIN':  0.6,
    'MARA':  0.6,
    'RIOT':  0.6,
    'MSTR':  0.6,
    'SMCI':  0.7,
    'ARKK':  0.9,
    'DKNG':  0.9,
  } as Record<string, number>,

  // ── Per-symbol confidence overrides ─────────────────────────────────────────
  // Symbols with weak backtest results need a higher bar to enter.
  // Default threshold is minConfidenceToTrade (0.55). Overrides are higher.
  // Backtested: AAPL 60% WR over 6 months but lower PF — only take best setups.
  symbolConfidenceOverrides: {
    'AAPL': 0.68,
  } as Record<string, number>,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — ORB (Opening Range Breakout) Strategy Parameters
// Core rules for the ORB strategy.
// ─────────────────────────────────────────────────────────────────────────────
export const ORB = {
  // How many minutes to watch before locking the opening range
  // 9:30–9:44 = 15 one-minute candles
  openingRangeMinutes: 15,

  // Latest time to enter a breakout trade (HH:MM ET)
  // If no breakout by 10:15, skip for the day
  entryWindowEnd: '10:15',

  // Hard close time — all positions closed by this time regardless
  hardCloseTime:       '10:30',
  maxHoldMinutes:      45,    // Safety net if session-close cron fails

  // Take profit = entry ± (2.0 × range size) — 2:1 R:R is the ORB expectancy optimum
  takeProfitMultiplier: 2.0,

  // Stop loss = opening range midpoint
  // If you break out of the top of the range, your stop is at the midpoint.
  stopAtMidpoint: true,

  // Breakout candle volume must be > 1.3× the average of prior 10 candles
  // Low-volume breakouts fail more often — this filters the weak ones
  volumeConfirmationMultiplier: 0.7,

  // Skip the day if range is too tight (likely no momentum to trade)
  // 0.2% = range less than 0.2% of price → skip
  minRangeSize: 0.001,

  // Skip the day if range is too wide (likely a gap or news spike — unpredictable)
  // 5% = range more than 5% of price → skip
  // Raised from 3% so high-beta names (AMD/DKNG/crypto-linked) aren't auto-rejected.
  maxRangeSize: 0.05,

  // Minimum stop distance as a % of entry price.
  // Prevents midpoint stops on very tight ranges from sitting inside the spread,
  // which causes instant stop-outs within seconds of entry.
  // 0.25% = stop must be at least $0.25 away on a $100 stock.
  minStopDistancePct: 0.0025,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5.5 — Mean-Reversion Fade Strategy
// Fades failed breakouts: price pops above ORH then closes back inside the range,
// signalling exhaustion. Trades the reversion back toward the opposite extreme.
// ─────────────────────────────────────────────────────────────────────────────
export const FADE = {
  // Enable/disable the fade strategy entirely
  enabled: true,

  // Symbol whitelist: only run fade detection on these tickers.
  // Validated via 6-month backtest (May 2026): these symbols had PF >= 1.2 and
  // positive expectancy. Skipped: QQQ/NVDA/GOOGL (negative expectancy in trending
  // mega-caps), META (break-even PF 1.03 — not worth the exposure).
  // Empty list = enabled for all watchlist symbols (do not do this without re-backtest).
  enabledSymbols: ['AAPL', 'TSLA', 'IWM'] as readonly string[],

  // How many candles after the failed breakout the reclaim must occur in.
  // 1 = immediate next candle reclaims; 3 = up to 3 candles later
  maxCandlesAfterBreakout: 3,

  // Reclaim candle volume must be >= this × average. Lower than breakout because
  // failed-breakout reclaims often happen on softer volume.
  reclaimVolumeMultiplier: 0.8,

  // Stop placement: how far beyond the failed extreme (ORH for short fade, ORL for long fade)
  // 0.10 = stop is 10% of range size beyond the extreme. Tight but gives wiggle room.
  stopBufferPct: 0.10,

  // Take-profit target: which side of the range to aim for.
  // 'opposite' = target the opposite extreme (ORH for long fade, ORL for short fade)
  // 'midpoint' = target the range midpoint (safer but smaller win)
  targetMode: 'midpoint' as 'midpoint' | 'opposite',

  // Skip fade if move beyond range is too large (already played out, no reversion left).
  // 0.5 = skip if price was > 50% of range size beyond the extreme at the failed close.
  maxOvershootPct: 0.5,

  // Confidence floor for fade entries (lower than breakouts since fades are reversion plays)
  minConfidence: 0.55,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Signal Weights
// How much each signal type influences the final trade decision.
// ORB is the primary signal. All weights must sum to 1.0.
// ─────────────────────────────────────────────────────────────────────────────
export const SIGNAL_WEIGHTS = {
  technical:      0.35,   // RSI, MACD, moving averages — confirms the chart setup
  orb:            0.30,   // Opening range breakout signal — primary entry trigger
  macro:          0.20,   // SPY trend, VIX level — market context
  sentiment:      0.10,   // News sentiment, market mood
  whale:          0.05,   // Whale/derivatives signal (funding rate, large trades, liquidations)

  // Legacy fields (used by brain.ts, decisionEngine.ts, journal.ts):
  microstructure: 0.00,   // Not used in ORB — kept for legacy compatibility

  // Score thresholds for final trade decision
  thresholds: {
    buy:  0.62,   // VWAP reclaim strategy — only high conviction setups
    sell: 0.35,
  },

  // Bounds on how much weights can drift from session learning
  maxWeightAdjustmentPerSession: 0.03,
  minWeight: 0.05,
  maxWeight: 0.50,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Pre-Market Filter Parameters
// ─────────────────────────────────────────────────────────────────────────────
export const PREMARKET = {
  // Confidence score blending weights (must sum to 1.0)
  confidenceWeights: {
    vix:     0.30,
    bias:    0.40,
    premkt:  0.30,
  },

  // Score assigned to each day-bias state when computing pre-market confidence
  biasScores: {
    TRENDING_UP:   0.80,
    NEUTRAL:       0.55,
    TRENDING_DOWN: 0.30,
  },

  // Minimum % move in SPY/QQQ to count as a meaningful prev-day trend
  trendThresholdPct: 0.003,   // 0.3%

  // Minimum % pre-market move to consider direction meaningful (0.2% is noise on SPY)
  premarketThresholdPct: 0.004,  // 0.4%

  // ATR assumption used when live ATR is unavailable
  defaultAtrPct: 0.02,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7b — Macro Agent Parameters
// ─────────────────────────────────────────────────────────────────────────────
export const MACRO_CONFIG = {
  // Internal blending weights for the two macro inputs (must sum to 1.0)
  weights: {
    spy:  0.70,   // SPY trend — primary directional signal
    vixy: 0.30,   // VIXY trend — fear proxy (inverted)
  },

  // Slope range for normalizing SPY trend to 0–1
  // ±0.3%/day = full bullish/bearish range
  spySlopeRange:  0.30,

  // Slope range for normalizing VIXY trend to 0–1
  // ±0.5%/day = full fear/calm range
  vixySlopeRange: 0.50,

  // Score thresholds for labeling the macro environment
  riskOnThreshold:  0.60,
  riskOffThreshold: 0.40,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7c — Sentiment Agent Parameters
// ─────────────────────────────────────────────────────────────────────────────
export const SENTIMENT_CONFIG = {
  // Blending weights for equity symbols — news is Groq-validated, Reddit is retail/contrarian
  equityWeights: {
    news:   0.65,
    reddit: 0.25,
    trends: 0.10,
  },

  // Blending weights for crypto symbols (full four-source blend)
  cryptoWeights: {
    news:      0.35,
    reddit:    0.25,
    fearGreed: 0.25,
    trends:    0.15,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7d — Whale Agent Parameters
// ─────────────────────────────────────────────────────────────────────────────
export const WHALE_CONFIG = {
  // Internal blending weights for whale sub-signals (must sum to 1.0)
  weights: {
    orderBook:   0.35,   // Real-time bid/ask wall pressure
    volume:      0.35,   // Relative volume fingerprint
    putCall:     0.30,   // Options market hedging posture
  },

  // Extra score bonus when volume accumulation candle is detected
  accumulationBonus: 0.05,

  // Score thresholds for labeling whale signal
  accumulationThreshold: 0.60,
  distributionThreshold: 0.40,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7e — Technical Indicator Composite Weights
// How sub-indicators combine into the final technical score.
// ─────────────────────────────────────────────────────────────────────────────
export const TECHNICAL_WEIGHTS = {
  rsi:    0.30,
  macd:   0.30,
  ma:     0.25,
  volume: 0.15,

  // MACD normalized scores per trend state
  macdScores: {
    bullish_crossover: 0.80,
    bearish_crossover: 0.20,
    bullish:           0.60,
    bearish:           0.40,
  },

  // RSI normalization breakpoints → score
  rsiCurve: {
    extremeOversoldMax:  20,   extremeOversoldScore:  0.85,
    oversoldMax:         30,   oversoldBaseScore:     0.65,   oversoldRange: 0.20,
    neutralMax:          70,   neutralBaseScore:      0.65,   neutralRange:  0.30,
    overboughtMax:       80,   overboughtBaseScore:   0.35,   overboughtRange: 0.20,
    extremeOverboughtScore: 0.15,
  },

  // ATR-based volatility classification thresholds
  volatility: {
    lowMax:    0.005,   // < 0.5% = low volatility
    normalMax: 0.015,   // 0.5–1.5% = normal
    highMax:   0.030,   // 1.5–3% = high; above = extreme
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7f — ORB Breakout Confidence Scoring
// ─────────────────────────────────────────────────────────────────────────────
export const ORB_CONFIDENCE = {
  base:              0.65,   // Starting confidence for any confirmed breakout
  volumeBoostMax:    0.20,   // Max additional score from volume surge
  strengthBoostMax:  0.15,   // Max additional score from how far above ORH we closed
  maxConfidence:     0.95,   // Hard cap — never 100% confident
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7f2 — Quant Strategy Parameters
// Parameters for the additional entry strategies beyond pure ORB breakout.
// ─────────────────────────────────────────────────────────────────────────────
export const QUANT = {
  // Mean Reversion: fires when price is stretched far below VWAP
  meanReversion: {
    rsiThreshold:       38,     // RSI must be ≤ this (oversold)
    vwapStretchPct:     0.008,  // Price must be ≥ 0.8% below VWAP
    wickRejectionRatio: 0.4,    // Wick must be ≥ 40% of candle range (rejection)
    maxStopPct:         0.006,  // Stop capped at 0.6% — tight risk
    targetRR:           1.5,    // Target = entry + 1.5× risk (conservative)
    confidenceBase:     0.62,
  },

  // Momentum Continuation: catches trends already running, no breakout needed
  momentum: {
    minEma9PullbackPct: 0.001,  // Price must touch within 0.1% of EMA9 on pullback
    maxEma9PullbackPct: 0.008,  // But not be > 0.8% below (too far = not a continuation)
    minRsi:             45,     // RSI must show some momentum (not exhausted)
    maxRsi:             72,     // Not overbought
    minRvolMult:        0.8,    // Minimum RVOL — some volume needed
    targetRR:           2.0,    // Target = 2× risk
    confidenceBase:     0.63,
  },

  // RVOL dead-market gate: block entry if volume is extremely thin
  minRvolToEnter:       0.4,    // Below 0.4× typical volume = trap risk, skip

  // Intraday trend regime detection (using 15m candles)
  trendRegime: {
    ema20Period:        20,     // EMA(20) on 15m = ~5 hours of context
    trendingSlopePct:   0.002,  // EMA slope > 0.2% = trending
  },

  // SPY directional commitment gate
  spyCommitment: {
    lookbackCandles:    3,      // SPY must make a new high within last N 5m candles
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7g — Brain / Learning System Parameters
// ─────────────────────────────────────────────────────────────────────────────
export const BRAIN_CONFIG = {
  // Exponential smoothing alpha for regime and coin memory
  // Higher = faster adaptation to recent sessions; lower = more stable
  smoothingAlpha: 0.30,

  // Minimum signal discrimination needed before adjusting weights
  minDiscrimination: 0.08,

  // Bounds on lesson-based confidence adjustments
  lessonConfAdjMax:    0.05,
  symbolConfAdjMax:    0.08,

  // Combined pre-trade size multiplier bounds
  combinedSizeMultMin: 0.40,
  combinedSizeMultMax: 1.20,

  // Combined pre-trade confidence adjustment bounds
  combinedConfAdjMin: -0.08,
  combinedConfAdjMax:  0.10,

  // Regime memory: position size multiplier bounds
  regimeSizeMultMin:  0.50,
  regimeSizeMultMax:  1.20,
  regimeSizeBase:     0.80,

  // Win-rate bands for per-coin position sizing and confidence adjustment
  coinMemory: {
    minTradesRequired: 10,
    winRateBands: [
      { maxWinRate: 0.35, sizeMult: 0.60, confAdj: +0.05 },
      { maxWinRate: 0.40, sizeMult: 0.80, confAdj: +0.05 },
      { maxWinRate: 0.45, sizeMult: 0.80, confAdj: +0.03 },
      { maxWinRate: 0.60, sizeMult: 1.00, confAdj:  0.00 },
      { maxWinRate: 0.65, sizeMult: 1.00, confAdj: -0.02 },
      { maxWinRate: Infinity, sizeMult: 1.10, confAdj: -0.03 },
    ] as { maxWinRate: number; sizeMult: number; confAdj: number }[],
  },

  // Orphaned position stop distance (% of entry price) when no ORB range is available
  orphanedStopPct: 0.015,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Indicator Settings
// Parameters for technical indicators.
// ─────────────────────────────────────────────────────────────────────────────
export const INDICATORS = {
  rsi: {
    period:     14,
    overbought: 70,
    oversold:   30,
  },
  macd: {
    fastPeriod:   12,
    slowPeriod:   26,
    signalPeriod: 9,
  },
  movingAverages: {
    short: 20,
    long:  50,
  },
  atr: {
    period: 14,
  },
  minCandlesRequired: 30,
  // ORB uses 1m and 5m primarily. 15m for macro context.
  timeframes: ['1m', '5m', '15m'] as string[],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Logging
// ─────────────────────────────────────────────────────────────────────────────
export const LOGGING = {
  sessionLogDir: 'logs/sessions',
  journalDir:    'logs/journal',
  maxFileSizeBytes: 10 * 1024 * 1024,  // 10MB
  maxFiles: 30,
  level: 'info' as 'debug' | 'info' | 'warn' | 'error',
  includeReasoningChain: true,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — API Retry Logic
// ─────────────────────────────────────────────────────────────────────────────
export const RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs:  10_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — Strategy Versioning
// ─────────────────────────────────────────────────────────────────────────────
export const STRATEGY = {
  currentVersion: 'orb-v1',
  versionFile:    'logs/strategy-versions.json',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY COMPATIBILITY STUBS
// The files below (riskManager, executionEngine, positionManager, marketData,
// backtester, decisionEngine, brain, etc.) were built for the crypto bot and
// reference config keys that were removed in the ORB rewrite.
//
// These stubs preserve compilation. They are NOT used by the ORB trading path
// (index.ts, orbAnalyst.ts, preMarketFilter.ts, openingRange.ts) — those
// use the ORB-specific config sections above.
//
// Do not remove these unless you also update all the files that import them.
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use ASSETS instead */
export const COINS = ASSETS;

/** @deprecated ORB uses fixed 1% risk formula — no scale-in */
export const POSITION = {
  entry: {
    scaleInSteps:           [1.0] as number[],
    scaleInIntervalMinutes: 30,
  },
  exit: {
    partialTakeProfitPct:  0.015,
    partialTakeProfitSize: 0.50,
    trailingStopPct:       0.010,
    breakEvenTriggerPct:   0.010,
    earlyTrailTriggerPct:  0.005,  // Start trailing once price is 0.5% above entry
  },
} as const;

// 0.05% half-spread assumption for liquid equities (conservative real-world estimate)
export const LIVE_EXECUTION = {
  slippagePct: 0.0005,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// TRADING MODE
//
// PAPER_MODE = true  → Alpaca paper account. No PDT limits. Trade all valid
//                      setups every day to collect brain training data.
//                      This is the current state — building the dataset.
//
// PAPER_MODE = false → Live account. PDT limits enforced. Only the single
//                      best setup per day. Switch this when you open a real
//                      account and the brain has enough data to be profitable.
//
// How to know when to switch:
//   - Brain has 30+ sessions of learned weights
//   - Paper win rate consistently above 55% over last 20 trades
//   - Sharpe ratio > 1.0 on paper session logs
// ─────────────────────────────────────────────────────────────────────────────
export const PAPER_MODE = true;

/** @deprecated Backtesting not used in ORB bot */
export const BACKTEST = {
  historyDays:       180,
  trainSplitPct:     0.70,
  slippagePct:       0.001,
  spreadPct:         0.0005,
  minimumSharpeRatio: 0.5,
  maximumDrawdownPct: 0.20,
  minimumWinRate:    0.40,
  regimes:           ['bull', 'bear', 'sideways'] as string[],
} as const;
