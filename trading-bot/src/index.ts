// NOTE: The Alpaca paper account is SHARED with other bots/manual trades (AMZN, MSFT, GOOG etc).
// ORB strategy P&L must always come from sessionLog (the journal), NEVER from account.todayPnL.
// A dedicated paper account for the ORB bot is the permanent fix — not yet implemented.
import * as cron from 'node-cron';
import { readFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { log }                                            from './core/logger.js';
import { getAccountInfo, buildPortfolioState,
         placeMarketBuy, placeMarketSell,
         placeMarketShort, coverShort,
         placeStopLoss, placeTakeProfit,
         cancelAllOrdersForSymbol,
         waitForFill }                                    from './core/executionEngine.js';
import { checkPosition, openPosition, buildPositionSummary,
         ManagedPosition }                                from './core/positionManager.js';
import { loadTodaySession, recordTradeEntry, recordTradeExit,
         buildPortfolioStateFromJournal, markCircuitBreaker,
         runEndOfSessionAnalysis, SessionLog }            from './agents/journal.js';
import { TradeParameters }                               from './core/riskManager.js';
import { SCHEDULE, ASSETS, RISK, ORB, PREMARKET, BRAIN_CONFIG, LIVE_EXECUTION, PAPER_MODE } from './config.js';

// Immutable snapshot of the configured watchlist, taken at module load BEFORE any
// session-reset mutates ASSETS.watchlist in place. Each session refills from THIS,
// so the source of truth is config.ts, not a hardcoded list. (Bug fixed Jun 2026:
// a hardcoded ['QQQ','IWM',...] in the reset overwrote config every morning, so the
// new high-vol symbols never traded.)
const BASE_WATCHLIST: readonly string[] = [...ASSETS.watchlist];
import { brainSessionStart, brainSessionEnd, morningBrief,
         getPreTradeIntelligence, exportBrainState, RegimeName } from './agents/brain.js';
import { classifyRegime, getRegimeAllocationMultiplier,
         getRegimeSummary, updateHmmAfterSession,
         RegimeState }                                    from './agents/hmmRegime.js';
import { runPreMarketFilter, PreMarketAnalysis }         from './agents/preMarketFilter.js';
import { runOrbCycle, clearOrbSessionCaches, OrbCycle, OrbPhase } from './agents/orbAnalyst.js';
import {
  buildOpeningRange,
  validateRange,
  isRangeTooTight,
  OpeningRange,
} from './strategy/openingRange.js';
import { getEquityBars }                                  from './tools/marketData.js';
import { computeATR }                                     from './tools/indicators.js';
import { startBarStream, stopBarStream }                  from './tools/barStream.js';
import { analyzeSentiment }                               from './agents/sentiment.js';
import { startLogServer }                                 from './core/logServer.js';

// ─────────────────────────────────────────────────────────────────────────────
// INDEX.TS — ORB System Orchestrator
//
// Three independent trading windows per day (Mon–Fri):
//
//   WINDOW 1 — ORB (Opening Range Breakout)  9:00 AM – 10:30 AM
//     9:00 AM  Pre-market filter (VIX, calendar, bias)
//     9:30 AM  Build opening range (15-min candles)
//     9:45 AM  Lock range, watch for breakout
//     10:15 AM Entry window closes
//     10:30 AM Hard close ALL ORB positions
//
//   WINDOW 2 — Midday Breakout  11:00 AM – 1:15 PM
//     10:30 AM ORB hard close also locks the first-hour range (9:30–10:30)
//     11:00 AM Scan for breakout of first-hour range
//     1:00 PM  Entry window closes
//     1:15 PM  Hard close all midday positions
//
//   WINDOW 3 — Power Hour  3:00 PM – 3:55 PM
//     1:00 PM  Start building consolidation range
//     2:30 PM  Lock consolidation range
//     3:00 PM  Scan for power-hour breakout
//     3:55 PM  Hard close all power-hour positions
//
// All three windows are INDEPENDENT — each runs regardless of whether
// the other windows traded. This maximises training data collection.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Session State ────────────────────────────────────────────────────────────

type SessionPhase = 'IDLE' | 'PRE_MARKET' | 'BUILDING_RANGE' | 'TRADING' | 'MANAGING' | 'CLOSING' | 'DONE';
type TradingWindow = 'ORB' | 'MIDDAY' | 'POWER_HOUR';

interface TrackedPosition {
  position:    ManagedPosition;
  stopOrderId: string | null;
  tpOrderId:   string | null;
  _tradeId?:   string;
  window:      TradingWindow;
}

let sessionPhase:       SessionPhase         = 'IDLE';
let sessionLog:         SessionLog | null    = null;
let preMarketAnalysis:  PreMarketAnalysis | null = null;

// ORB positions (window 1)
let orbPositions:       Map<string, TrackedPosition> = new Map();
// Midday positions (window 2)
let middayPositions:    Map<string, TrackedPosition> = new Map();
// Power hour positions (window 3)
let powerPositions:     Map<string, TrackedPosition> = new Map();

let openingRanges:      Map<string, OpeningRange>    = new Map();  // ORB + midday range
let middayRanges:       Map<string, OpeningRange>    = new Map();  // locked at 10:30 AM
let powerRanges:        Map<string, OpeningRange>    = new Map();  // locked at 2:30 PM
const pendingBuys:      Set<string>                  = new Set();
const pendingExits:     Set<string>                  = new Set(); // guard: one exit in-flight per symbol
let isDryRun            = false;
let currentRegime:      RegimeName = 'unknown';
let hmmRegime:          RegimeState | null = null;
let orbTradesOpenedToday     = 0;
let middayTradesOpenedToday  = 0;
let powerTradesOpenedToday   = 0;
let positionTimerHandle:  ReturnType<typeof setInterval> | null = null;
let executionTimerHandle: ReturnType<typeof setInterval> | null = null;

// Per-window active-execution flags
let middayExecutionActive  = false;
let powerExecutionActive   = false;

// Concurrency guard — prevents overlapping execution cycles
let executionCycleRunning  = false;

// Tracks which symbols already had a trade attempt per window
const orbTradedSymbols:    Set<string> = new Set();
const middayTradedSymbols: Set<string> = new Set();
const powerTradedSymbols:  Set<string> = new Set();
// Session-wide cap: once a symbol trades in ANY window, block it for the rest of the day.
// Prevents IWM trading 6× across ORB + midday + power (RISK.maxTradesPerAsset = 1).
const tradedSymbolsToday:  Set<string> = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args    = process.argv.slice(2);
  isDryRun      = args.includes('--dry-run');
  const runOnce = args.includes('--once');

  log.info('');
  log.info('[Bot] ══════════════════════════════════════════════════════════');
  log.info('[Bot]  ORB Trading Bot — Starting up');
  startLogServer();
  log.info(`[Bot]  Mode: ${isDryRun ? 'DRY RUN (no orders will be placed)' : 'LIVE (paper trading)'}`);
  log.info('[Bot]  Strategy: 3-Window Breakout (ORB + Midday + Power Hour)');
  log.info('[Bot]  Watchlist: ' + ASSETS.watchlist.join(', '));
  log.info('[Bot]  Schedule: Mon–Fri | ORB 9:30–10:30 | Midday 11–1:15 | Power 3–3:55 ET');
  log.info('[Bot] ══════════════════════════════════════════════════════════');
  log.info('');

  let portfolioValue = 0;
  let cashAvailable  = 0;
  // Clear bar caches on every startup so a mid-day restart never uses yesterday's bars
  clearOrbSessionCaches();

  let bootAccount: Awaited<ReturnType<typeof getAccountInfo>>;
  try {
    bootAccount    = await getAccountInfo();
    portfolioValue = bootAccount.portfolioValue;
    cashAvailable  = bootAccount.cash;
    log.info(`[Bot] Connected to Alpaca. Portfolio: $${bootAccount.portfolioValue.toLocaleString()} | Cash: $${bootAccount.cash.toLocaleString()}`);
  } catch (err) {
    log.error(`[Bot] FATAL: Cannot connect to Alpaca — ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const mode = isDryRun ? 'DRY RUN' : 'PAPER TRADING';
  await log.discord(
    `**ORB Bot Online** [${mode}]\n` +
    formatPnL(bootAccount) + `\n` +
    `Windows: ORB (9:30–10:30) | Midday (11–1:15) | Power Hour (3–3:55) ET\n` +
    `Watchlist: ${ASSETS.watchlist.join(', ')}`
  );

  // Close any orphaned ORB-symbol positions from a previous crashed session
  // that have no stop order protecting them.
  await closeOrphanedPositions();

  if (runOnce) {
    log.info('[Bot] --once: running pre-market filter then exiting');
    await startPreMarket();
    return;
  }

  scheduleSession();
  catchUpIfMidSession();

  // Keep the event loop alive 24/7 — without this, Node exits on weekends
  // when node-cron has no imminent Mon–Fri jobs scheduled.
  setInterval(() => {}, 60_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// CATCH-UP ON MID-SESSION RESTART
// If the bot starts after a window has already opened, fire the appropriate
// function immediately so the remaining time in the window isn't wasted.
// ─────────────────────────────────────────────────────────────────────────────

function catchUpIfMidSession(): void {
  const now = new Date();
  const etFmt    = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'America/New_York' }).format(now);
  const etHour   = Number(etFmt({ hour: 'numeric', hour12: false }));
  const etMinute = Number(etFmt({ minute: 'numeric' }));
  const etWeekday = etFmt({ weekday: 'short' });
  const totalMinutes = etHour * 60 + etMinute;

  // Only catch up on weekdays
  if (etWeekday === 'Sat' || etWeekday === 'Sun') return;

  // Midday entry window: 11:00 AM–1:00 PM (660–780 min).
  // Only fire if we're still inside the entry window — past 1:00 PM no new midday entries allowed.
  if (totalMinutes >= 660 && totalMinutes < 780) {
    log.info(`[Bot] Mid-session restart at ${etHour}:${String(etMinute).padStart(2,'0')} ET — catching up: firing midday scan (${780 - totalMinutes} min of entry window left)`);
    void startMiddayTrading();
    return;
  }

  // Midday managing-only window: 1:00 PM–1:15 PM (780–795 min) — past entry deadline, reconnect only
  if (totalMinutes >= 780 && totalMinutes < 795) {
    log.info(`[Bot] Mid-session restart at ${etHour}:${String(etMinute).padStart(2,'0')} ET — midday entry closed, reconnecting positions only`);
    void reconnectOrphanedPositions('MIDDAY');
    return;
  }

  // Power consolidation range: 1:15 PM–2:30 PM (795–870 min) — collect range candles
  if (totalMinutes >= 795 && totalMinutes < 870) {
    log.info(`[Bot] Mid-session restart at ${etHour}:${String(etMinute).padStart(2,'0')} ET — in power consolidation window, will lock range at 2:30 PM`);
    return;
  }

  // Power hour entry window: 3:00 PM–3:55 PM (900–955 min) — range already locked at 2:30
  if (totalMinutes >= 900 && totalMinutes < 955) {
    log.info(`[Bot] Mid-session restart at ${etHour}:${String(etMinute).padStart(2,'0')} ET — catching up: firing power hour scan (${955 - totalMinutes} min of entry window left)`);
    void lockPowerRange().then(() => startPowerTrading());
    return;
  }

  // ORB window: 9:45 AM–10:15 AM (585–615 min) — too late to backfill range, skip
  if (totalMinutes >= 585 && totalMinutes < 630) {
    log.info(`[Bot] Mid-session restart during ORB window — ORB range not available, skipping ORB`);
    return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION SCHEDULER
// All times ET. Runs Mon–Fri. Three independent trading windows.
// ─────────────────────────────────────────────────────────────────────────────

function scheduleSession(): void {
  const tz   = SCHEDULE.timezone;
  const days = '1,2,3,4,5';   // Mon–Fri

  log.info('[Bot] Scheduling 3-window session (all times ET, Mon–Fri):');
  log.info('[Bot]   8:50 AM  → Health check');
  log.info('[Bot]   9:00 AM  → Pre-market filter');
  log.info('[Bot]   9:30 AM  → Start building ORB range');
  log.info('[Bot]   9:45 AM  → Lock ORB range, start entries');
  log.info('[Bot]  10:15 AM  → ORB entry window closes');
  log.info('[Bot]  10:30 AM  → ORB hard close + lock first-hour range (midday)');
  log.info('[Bot]  11:00 AM  → Midday scan starts');
  log.info('[Bot]   1:00 PM  → Midday entry window closes');
  log.info('[Bot]   1:15 PM  → Midday hard close + start consolidation range (power)');
  log.info('[Bot]   2:30 PM  → Lock power-hour consolidation range');
  log.info('[Bot]   3:00 PM  → Power hour scan starts');
  log.info('[Bot]   3:55 PM  → Power hour hard close + end-of-session analysis');

  startBarStream(ASSETS.watchlist);

  // ── Health check ───────────────────────────────────────────────────────────
  cron.schedule(`50 8 * * ${days}`, async () => {
    try {
      const account = await getAccountInfo();
      await log.discord(
        `🟢 **Bot Health Check** — ${new Date().toLocaleString('en-US', { timeZone: tz })}\n` +
        formatPnL(account)
      );
    } catch {
      await log.discord(`🟢 **Bot Health Check** — ${new Date().toLocaleString('en-US', { timeZone: tz })} | Alpaca connection issue`);
    }
  }, { timezone: tz });

  // ── Window 1: ORB ──────────────────────────────────────────────────────────
  cron.schedule(`0 9 * * ${days}`,  () => void startPreMarket(),     { timezone: tz });
  cron.schedule(`30 9 * * ${days}`, () => void startRangeBuilding(), { timezone: tz });
  cron.schedule(`45 9 * * ${days}`, () => void startOrbTrading(),    { timezone: tz });
  cron.schedule(`15 10 * * ${days}`,() => void stopOrbEntries(),     { timezone: tz });
  cron.schedule(`30 10 * * ${days}`,() => void hardCloseOrb(),       { timezone: tz });  // also locks midday range

  // ── Window 2: Midday ──────────────────────────────────────────────────────
  cron.schedule(`0 11 * * ${days}`, () => void startMiddayTrading(), { timezone: tz });
  cron.schedule(`0 13 * * ${days}`, () => void stopMiddayEntries(),  { timezone: tz });
  cron.schedule(`15 13 * * ${days}`,() => void hardCloseMidday(),    { timezone: tz });  // also starts power consolidation

  // ── Window 3: Power Hour ───────────────────────────────────────────────────
  cron.schedule(`30 14 * * ${days}`,() => void lockPowerRange(),     { timezone: tz });
  cron.schedule(`0 15 * * ${days}`, () => void startPowerTrading(),  { timezone: tz });
  cron.schedule(`55 15 * * ${days}`,() => void hardClosePower(),     { timezone: tz });  // also runs end-of-session

  log.info('[Bot] All crons scheduled. Waiting for next session...');

  // Export brain state on startup so the dashboard / signals bus always has
  // a fresh snapshot, even if the bot was restarted mid-day and missed the
  // 3:55pm end-of-session export.
  try {
    exportBrainState();
    log.info('[Bot] Brain state exported on startup.');
  } catch (err) {
    log.warn(`[Bot] Brain export on startup failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-MARKET (9:00 AM)
// Run once per day: VIX check, calendar check, HMM regime, brain setup.
// ─────────────────────────────────────────────────────────────────────────────

async function startPreMarket(): Promise<void> {
  const today = new Date().getDay();
  if (!SCHEDULE.tradingDays.includes(today)) {
    log.info(`[PreMarket] Not a trading day — skipping`);
    return;
  }

  log.info('');
  log.info('[PreMarket] ── PRE-MARKET STARTING ──────────────────────────────');

  // Reset all session state
  sessionPhase     = 'PRE_MARKET';
  sessionLog       = null;
  preMarketAnalysis = null;
  orbPositions.clear();
  middayPositions.clear();
  powerPositions.clear();
  openingRanges.clear();
  middayRanges.clear();
  powerRanges.clear();
  pendingBuys.clear();
  orbTradedSymbols.clear();
  middayTradedSymbols.clear();
  powerTradedSymbols.clear();
  tradedSymbolsToday.clear();
  orbTradesOpenedToday     = 0;
  middayTradesOpenedToday  = 0;
  powerTradesOpenedToday   = 0;
  middayExecutionActive    = false;
  powerExecutionActive     = false;
  executionCycleRunning    = false;
  clearOrbSessionCaches();

  try {
    const account = await getAccountInfo();
    sessionLog    = loadTodaySession(account.portfolioValue);

    preMarketAnalysis = await runPreMarketFilter();

    // Reset the watchlist to the configured base each session. ORB trades ONLY the
    // backtested watchlist from config.ts. market-lens injection is DISABLED (Jun 2026):
    // swing bot retired, market-lens is research-only, its picks are un-backtested for
    // ORB. To re-enable, call expandWatchlistFromBlessedList() again.
    ASSETS.watchlist.length = 0;
    for (const s of BASE_WATCHLIST) ASSETS.watchlist.push(s);

    if (!preMarketAnalysis.shouldTrade) {
      await log.important(
        `**ORB Session Skipped** — ${new Date().toLocaleString()}\n` +
        `Reason: ${preMarketAnalysis.reason}`
      );
      sessionPhase = 'DONE';
      return;
    }

    // HMM regime classification
    try {
      hmmRegime = await classifyRegime();
      log.info(`[HMM] ${getRegimeSummary(hmmRegime)}`);

      if (hmmRegime.regime === 'crash') {
        await log.important(
          `**Session Blocked — CRASH REGIME** — ${new Date().toLocaleString()}\n` +
          `HMM confidence: ${(hmmRegime.confidence * 100).toFixed(0)}% — capital preservation mode.`
        );
        sessionPhase = 'DONE';
        return;
      }

      log.info(`[HMM] Allocation: ${(getRegimeAllocationMultiplier(hmmRegime.regime) * 100).toFixed(0)}% (${hmmRegime.regime})`);
    } catch (err) {
      log.warn(`[HMM] Regime classification failed: ${err instanceof Error ? err.message : err} — using full allocation`);
      hmmRegime = null;
    }

    // Brain session start
    try {
      let equitySentimentScore = 50;
      try {
        const sentiment = await analyzeSentiment(ASSETS.watchlist);
        equitySentimentScore = Math.round(sentiment.score * 100);
        log.info(`[Sentiment] Score: ${equitySentimentScore}/100 (${sentiment.label})`);
      } catch (sentErr) {
        log.warn(`[Sentiment] Failed — using 50: ${sentErr instanceof Error ? sentErr.message : sentErr}`);
      }

      const { regime, regimeContext } = await brainSessionStart({
        macroScore: preMarketAnalysis.confidence,
        fearGreed:  equitySentimentScore,
        spyTrend:   preMarketAnalysis.dayBias === 'TRENDING_UP'   ? 'bullish'
                  : preMarketAnalysis.dayBias === 'TRENDING_DOWN' ? 'bearish'
                  : 'neutral',
        atrPct:     PREMARKET.defaultAtrPct,
      });
      currentRegime = regime;
      log.info(`[Brain] Regime: ${regimeContext}`);
    } catch (err) {
      log.warn(`[Brain] Session start failed: ${err instanceof Error ? err.message : err}`);
    }

    const hmmLine = hmmRegime
      ? `Regime: ${hmmRegime.regime.toUpperCase()} (${(hmmRegime.confidence * 100).toFixed(0)}% conf) | Alloc: ${(getRegimeAllocationMultiplier(hmmRegime.regime) * 100).toFixed(0)}%`
      : 'Regime: unknown (HMM unavailable)';

    await log.important(
      `**Pre-Market Ready** — ${new Date().toLocaleString()}\n` +
      formatPnL(account) + `\n` +
      `${hmmLine}\n` +
      `Bias: ${preMarketAnalysis.dayBias} | VIX: ${preMarketAnalysis.vixLevel.toFixed(1)} | ` +
      `Confidence: ${(preMarketAnalysis.confidence * 100).toFixed(0)}%\n` +
      `Windows: ORB 9:45–10:30 | Midday 11:00–1:15 | Power 3:00–3:55 ET\n` +
      `Watchlist: ${ASSETS.watchlist.join(', ')}`
    );

    // ARIA morning brief
    try {
      const brief = await morningBrief({
        regime:          currentRegime,
        regimeContext:   hmmRegime ? `${hmmRegime.regime} (${(hmmRegime.confidence * 100).toFixed(0)}% conf)` : 'unknown',
        vixLevel:        preMarketAnalysis.vixLevel,
        spyPremkt:       preMarketAnalysis.spyPremarket,
        qqqPremkt:       preMarketAnalysis.qqqPremarket,
        watchlist:       ASSETS.watchlist,
        earningsSymbols: preMarketAnalysis.earningsSymbols,
      });
      await log.discord(`**ARIA Morning Brief**\n${brief}`);
    } catch (err) {
      log.warn(`[Brain] Morning brief failed: ${err instanceof Error ? err.message : err}`);
    }

    log.info('[PreMarket] Go for today. Range building starts at 9:30 AM ET.');

  } catch (err) {
    log.error(`[PreMarket] Failed: ${err instanceof Error ? err.message : err}`);
    sessionPhase = 'DONE';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORB WINDOW — RANGE BUILDING (9:30 AM)
// ─────────────────────────────────────────────────────────────────────────────

async function startRangeBuilding(): Promise<void> {
  if (sessionPhase === 'DONE') {
    log.info('[Range] Session was skipped — not starting range building');
    return;
  }

  log.info('[Range] ── BUILDING ORB RANGE (9:30–9:44 ET) ─────────────────');
  sessionPhase = 'BUILDING_RANGE';

  await reconnectOrphanedPositions('ORB');

  startPositionMonitor();

  for (const symbol of ASSETS.watchlist) {
    try {
      const candles = await getEquityBars(symbol, '1m', 20);
      if (candles.length > 0) log.info(`[Range] ${symbol}: ${candles.length} initial candles fetched`);
    } catch (err) {
      log.warn(`[Range] ${symbol}: initial fetch failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  log.info('[Range] ORB range locks at 9:45 AM ET.');
}

// ─────────────────────────────────────────────────────────────────────────────
// ORB WINDOW — TRADING (9:45 AM)
// ─────────────────────────────────────────────────────────────────────────────

async function startOrbTrading(): Promise<void> {
  if (sessionPhase === 'DONE') return;

  log.info('[ORB] ── ORB TRADING (9:45–10:15 ET) ───────────────────────────');
  sessionPhase = 'TRADING';

  await lockRanges('ORB');

  for (const [symbol, range] of openingRanges.entries()) {
    const v = validateRange(range);
    if (!v.valid) {
      log.warn(`[ORB] ${symbol}: range invalid — ${v.reason}`);
    } else if (isRangeTooTight(range)) {
      log.warn(`[ORB] ${symbol}: range too tight (${(range.sizePct * 100).toFixed(2)}%)`);
    } else {
      log.info(`[ORB] ${symbol}: range $${range.low.toFixed(2)}–$${range.high.toFixed(2)} (${(range.sizePct * 100).toFixed(2)}%)`);
      await log.discord(
        `**${symbol} ORB Range Locked** — $${range.low.toFixed(2)}–$${range.high.toFixed(2)} (${(range.sizePct * 100).toFixed(2)}%)`
      );
    }
  }

  startExecutionLoop('ORB');

  log.info('[ORB] Entry window closes 10:15 AM ET.');
}

// ─────────────────────────────────────────────────────────────────────────────
// ORB WINDOW — STOP ENTRIES (10:15 AM)
// ─────────────────────────────────────────────────────────────────────────────

async function stopOrbEntries(): Promise<void> {
  if (sessionPhase === 'DONE') return;

  log.info('[ORB] ── MANAGING ONLY (10:15–10:30 ET) ────────────────────────');
  sessionPhase = 'MANAGING';

  if (executionTimerHandle) {
    clearInterval(executionTimerHandle);
    executionTimerHandle = null;
  }

  const count = orbPositions.size;
  let pnlLine = '';
  try {
    const acct = await getAccountInfo();
    pnlLine = `\n${formatPnL(acct)}`;
  } catch { /* skip P&L on fetch failure */ }
  if (count > 0) {
    await log.discord(`**ORB entry closed** — managing ${count} position(s) to 10:30 AM${pnlLine}`);
  } else {
    await log.discord(`**ORB entry closed** — no open positions${pnlLine}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORB WINDOW — HARD CLOSE (10:30 AM) + lock midday range
// ─────────────────────────────────────────────────────────────────────────────

async function hardCloseOrb(): Promise<void> {
  log.info('[ORB] ── HARD CLOSE 10:30 AM ET ─────────────────────────────────');

  if (executionTimerHandle) { clearInterval(executionTimerHandle); executionTimerHandle = null; }

  const positions = [...orbPositions.entries()];
  if (positions.length > 0) {
    log.info(`[ORB] Closing ${positions.length} position(s)...`);
    await Promise.all(positions.map(([sym, tracked]) => closePosition(sym, tracked, 'ORB hard close 10:30 AM')));
  } else {
    log.info('[ORB] No ORB positions to close');
  }
  orbPositions.clear();

  // Lock the first-hour range (9:30–10:30) for midday window
  await lockRanges('MIDDAY_SOURCE');
  log.info('[ORB] First-hour range locked for midday window.');
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDAY WINDOW — TRADING (11:00 AM)
// Breakout of the first full hour's range (9:30–10:30 AM)
// ─────────────────────────────────────────────────────────────────────────────

async function startMiddayTrading(): Promise<void> {
  if (sessionPhase === 'DONE') return;

  log.info('[Midday] ── MIDDAY BREAKOUT (11:00 AM – 1:00 PM ET) ─────────────');

  if (middayRanges.size === 0) {
    log.warn('[Midday] No midday ranges available — window skipped');
    return;
  }

  for (const [symbol, range] of middayRanges.entries()) {
    const v = validateRange(range);
    if (!v.valid) {
      log.warn(`[Midday] ${symbol}: range invalid — ${v.reason}`);
    } else {
      log.info(`[Midday] ${symbol}: first-hour range $${range.low.toFixed(2)}–$${range.high.toFixed(2)} (${(range.sizePct * 100).toFixed(2)}%)`);
    }
  }

  await reconnectOrphanedPositions('MIDDAY');

  middayExecutionActive = true;
  startExecutionLoop('MIDDAY');

  let middayPnl = '';
  try {
    const acct = await getAccountInfo();
    middayPnl = `\n${formatPnL(acct)}`;
  } catch { /* skip P&L on fetch failure */ }
  await log.discord(`**Midday window open** — scanning first-hour range breakouts until 1:00 PM${middayPnl}`);
  log.info('[Midday] Entry window closes 1:00 PM ET.');
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDAY WINDOW — STOP ENTRIES (1:00 PM)
// ─────────────────────────────────────────────────────────────────────────────

async function stopMiddayEntries(): Promise<void> {
  log.info('[Midday] Entry window closing — managing only until 1:15 PM');
  middayExecutionActive = false;

  if (executionTimerHandle) { clearInterval(executionTimerHandle); executionTimerHandle = null; }

  const count = middayPositions.size;
  if (count > 0) {
    await log.discord(`**Midday entry closed** — managing ${count} position(s) to 1:15 PM`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MIDDAY WINDOW — HARD CLOSE (1:15 PM) + start consolidation range for power
// ─────────────────────────────────────────────────────────────────────────────

async function hardCloseMidday(): Promise<void> {
  log.info('[Midday] ── HARD CLOSE 1:15 PM ET ──────────────────────────────');

  middayExecutionActive = false;
  if (executionTimerHandle) { clearInterval(executionTimerHandle); executionTimerHandle = null; }

  const positions = [...middayPositions.entries()];
  if (positions.length > 0) {
    log.info(`[Midday] Closing ${positions.length} position(s)...`);
    await Promise.all(positions.map(([sym, tracked]) => closePosition(sym, tracked, 'Midday hard close 1:15 PM')));
  } else {
    log.info('[Midday] No midday positions to close');
  }
  middayPositions.clear();

  // Log midday window stats
  const middayWins = sessionLog?.trades.filter(t => t.outcome === 'WIN' && (t as any).window === 'MIDDAY').length ?? 0;
  log.info(`[Midday] Window complete. Trades: ${middayTradesOpenedToday} | Wins: ${middayWins}`);

  // Start collecting consolidation range (1:00–2:30 PM) for power hour
  log.info('[Power] Consolidation range collection started (1:15–2:30 PM ET)');
}

// ─────────────────────────────────────────────────────────────────────────────
// POWER HOUR — LOCK CONSOLIDATION RANGE (2:30 PM)
// ─────────────────────────────────────────────────────────────────────────────

async function lockPowerRange(): Promise<void> {
  log.info('[Power] ── LOCKING CONSOLIDATION RANGE (1:15–2:30 PM) ──────────');
  await lockRanges('POWER_SOURCE');
  log.info(`[Power] ${powerRanges.size} symbol range(s) locked for power hour.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// POWER HOUR — TRADING (3:00 PM)
// ─────────────────────────────────────────────────────────────────────────────

async function startPowerTrading(): Promise<void> {
  if (sessionPhase === 'DONE') return;

  log.info('[Power] ── POWER HOUR BREAKOUT (3:00–3:55 PM ET) ────────────────');

  if (powerRanges.size === 0) {
    log.warn('[Power] No power-hour ranges available — window skipped');
    return;
  }

  for (const [symbol, range] of powerRanges.entries()) {
    const v = validateRange(range);
    if (!v.valid) {
      log.warn(`[Power] ${symbol}: range invalid — ${v.reason}`);
    } else {
      log.info(`[Power] ${symbol}: consolidation range $${range.low.toFixed(2)}–$${range.high.toFixed(2)} (${(range.sizePct * 100).toFixed(2)}%)`);
    }
  }

  await reconnectOrphanedPositions('POWER_HOUR');

  powerExecutionActive = true;
  startExecutionLoop('POWER_HOUR');

  let powerPnl = '';
  try {
    const acct = await getAccountInfo();
    powerPnl = `\n${formatPnL(acct)}`;
  } catch { /* skip P&L on fetch failure */ }
  await log.discord(`**Power Hour window open** — scanning consolidation breakouts until 3:55 PM${powerPnl}`);
  log.info('[Power] Hard close at 3:55 PM ET.');
}

// ─────────────────────────────────────────────────────────────────────────────
// POWER HOUR — HARD CLOSE + END OF SESSION (3:55 PM)
// ─────────────────────────────────────────────────────────────────────────────

async function hardClosePower(): Promise<void> {
  log.info('[Power] ── HARD CLOSE 3:55 PM ET ────────────────────────────────');

  powerExecutionActive = false;
  if (executionTimerHandle)   { clearInterval(executionTimerHandle);  executionTimerHandle  = null; }
  if (positionTimerHandle)    { clearInterval(positionTimerHandle);   positionTimerHandle   = null; }

  const positions = [...powerPositions.entries()];
  if (positions.length > 0) {
    log.info(`[Power] Closing ${positions.length} position(s)...`);
    await Promise.all(positions.map(([sym, tracked]) => closePosition(sym, tracked, 'Power hour hard close 3:55 PM')));
  } else {
    log.info('[Power] No power-hour positions to close');
  }
  powerPositions.clear();

  sessionPhase = 'DONE';

  await endSession();
}

// ─────────────────────────────────────────────────────────────────────────────
// END OF SESSION — journal analysis, brain learning, Discord summary
// ─────────────────────────────────────────────────────────────────────────────

async function endSession(): Promise<void> {
  log.info('[Session] Running end-of-session analysis...');

  // Lazy-init session log if the bot started after pre-market never fired
  // (restart mid-day, etc.). This guarantees we always write a daily journal
  // even on no-trade days so we have a record of what happened.
  if (!sessionLog) {
    try {
      const account = await getAccountInfo();
      sessionLog    = loadTodaySession(account.portfolioValue);
      log.info('[Session] Lazy-initialized session log for end-of-session analysis.');
    } catch (err) {
      log.warn(`[Session] Could not init session log: ${err instanceof Error ? err.message : err} — skipping`);
      return;
    }
  }

  try {
    const { patternStats, adjustments } = await runEndOfSessionAnalysis(sessionLog);

    await brainSessionEnd(sessionLog, currentRegime, patternStats).catch(err =>
      log.warn(`[Brain] End-of-session learning failed: ${err instanceof Error ? err.message : err}`)
    );

    exportBrainState();

    if (hmmRegime) {
      try {
        if (hmmRegime.observations.length >= 3) {
          await updateHmmAfterSession(hmmRegime.regime, hmmRegime.observations);
          log.info(`[HMM] Model updated for ${hmmRegime.regime} regime`);
        }
      } catch (err) {
        log.warn(`[HMM] Model update failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const closedTrades = sessionLog.trades.filter(t => t.outcome !== 'OPEN');
    const wins         = closedTrades.filter(t => t.outcome === 'WIN').length;
    const pnlSign      = sessionLog.dailyPnL >= 0 ? '+' : '';
    const winRatePct   = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(0) : '0';

    const totalTrades = orbTradesOpenedToday + middayTradesOpenedToday + powerTradesOpenedToday;
    const metrics = sessionLog.sharpeRatio != null
      ? `Sharpe: ${sessionLog.sharpeRatio.toFixed(2)} | Sortino: ${sessionLog.sortinoRatio?.toFixed(2) ?? '—'} | Max DD: ${sessionLog.maxDrawdownPct != null ? (sessionLog.maxDrawdownPct * 100).toFixed(2) + '%' : '—'}`
      : '';

    let noTradeReason = '';
    if (closedTrades.length === 0) {
      const reasons: string[] = [];
      if (preMarketAnalysis?.vixBlocked)    reasons.push(`VIX too high (${preMarketAnalysis.vixLevel.toFixed(1)})`);
      if (preMarketAnalysis?.calendarBlock) reasons.push(`Calendar block`);
      if (hmmRegime?.regime === 'crash')    reasons.push(`HMM CRASH regime`);
      if (reasons.length === 0)             reasons.push(`No breakouts cleared threshold (${RISK.minConfidenceToTrade})`);
      noTradeReason = `\n⚠️ No trades — ${reasons.join('; ')}`;
    }

    const allSymbols = new Set([...orbTradedSymbols, ...middayTradedSymbols, ...powerTradedSymbols]);

    const dayEmoji    = sessionLog.dailyPnL >= 0 ? '📈' : '📉';
    const winTrades   = closedTrades.filter(t => t.outcome === 'WIN');
    const lossTrades  = closedTrades.filter(t => t.outcome === 'LOSS');
    const avgWin      = winTrades.length  ? (winTrades.reduce( (s, t) => s + (t.realizedPnL ?? 0), 0) / winTrades.length).toFixed(2)  : '—';
    const avgLoss     = lossTrades.length ? (lossTrades.reduce((s, t) => s + (t.realizedPnL ?? 0), 0) / lossTrades.length).toFixed(2) : '—';
    const bestTrade   = closedTrades.length ? Math.max(...closedTrades.map(t => t.realizedPnL ?? 0)).toFixed(2) : '—';
    const worstTrade  = closedTrades.length ? Math.min(...closedTrades.map(t => t.realizedPnL ?? 0)).toFixed(2) : '—';

    const summary = [
      `${dayEmoji} **Daily Session Summary** — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`,
      ``,
      `💰 **P&L: ${pnlSign}$${sessionLog.dailyPnL.toFixed(2)}** (${pnlSign}${(sessionLog.dailyPnLPct * 100).toFixed(2)}%)`,
      `🏆 Win Rate: ${winRatePct}%  |  Trades: ${closedTrades.length} (${wins}W / ${closedTrades.length - wins}L)`,
      `📊 Avg Win: +$${avgWin}  |  Avg Loss: $${avgLoss}`,
      `🥇 Best: +$${bestTrade}  |  🥴 Worst: $${worstTrade}`,
      ``,
      `⚡ Windows — ORB: ${orbTradesOpenedToday} | Midday: ${middayTradesOpenedToday} | Power: ${powerTradesOpenedToday}`,
      `🎯 Symbols: ${[...allSymbols].join(', ') || 'none'}`,
      metrics ? `📐 ${metrics}` : '',
      noTradeReason,
    ].filter(Boolean).join('\n');

    await log.important(summary);

    if (adjustments.length > 0) {
      log.info('[Session] Signal weight adjustments:');
      for (const adj of adjustments) {
        log.info(`[Session]   ${adj.signal}: ${(adj.currentWeight * 100).toFixed(0)}% → ${(adj.suggestedWeight * 100).toFixed(0)}% — ${adj.reason}`);
      }
    }

  } catch (err) {
    log.error(`[Session] Journal analysis failed: ${err instanceof Error ? err.message : err}`);
  }

  log.info('[Session] Complete. Waiting for next session...');
  log.info('');
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCK RANGES
// Builds and stores the opening range for each symbol.
// mode = 'ORB'           → 9:30–9:44 candles → openingRanges
// mode = 'MIDDAY_SOURCE' → 9:30–10:30 candles → middayRanges
// mode = 'POWER_SOURCE'  → 13:00–14:30 candles → powerRanges
// ─────────────────────────────────────────────────────────────────────────────

async function lockRanges(mode: 'ORB' | 'MIDDAY_SOURCE' | 'POWER_SOURCE'): Promise<void> {
  const now = new Date();

  // Build 9:30 ET as a UTC ms anchor (handles both EDT and EST)
  const dateFmt   = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateParts = dateFmt.formatToParts(now);
  const y = dateParts.find(p => p.type === 'year')!.value;
  const m = dateParts.find(p => p.type === 'month')!.value;
  const d = dateParts.find(p => p.type === 'day')!.value;
  const probe    = new Date(`${y}-${m}-${d}T13:30:00Z`);
  const nyHour   = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(probe), 10);
  const utcBase  = nyHour === 9 ? 13 : 14;   // EDT → UTC-4, EST → UTC-5

  // Compute range start/end in UTC ms based on mode
  let rangeStartMs: number;
  let rangeEndMs:   number;
  let fetchBars:    number;  // how many 1m bars to request

  if (mode === 'ORB') {
    // 9:30 – 9:44 ET
    rangeStartMs = new Date(`${y}-${m}-${d}T${String(utcBase).padStart(2,'0')}:30:00Z`).getTime();
    rangeEndMs   = new Date(`${y}-${m}-${d}T${String(utcBase).padStart(2,'0')}:45:00Z`).getTime();
    fetchBars    = 30;
  } else if (mode === 'MIDDAY_SOURCE') {
    // 9:30 – 10:30 ET (full first hour)
    rangeStartMs = new Date(`${y}-${m}-${d}T${String(utcBase).padStart(2,'0')}:30:00Z`).getTime();
    rangeEndMs   = new Date(`${y}-${m}-${d}T${String(utcBase + 1).padStart(2,'0')}:30:00Z`).getTime();
    fetchBars    = 80;
  } else {
    // POWER_SOURCE: 13:00 – 14:30 ET
    const utcPm = utcBase + 4;  // 13:00 ET = utcBase+4
    rangeStartMs = new Date(`${y}-${m}-${d}T${String(utcPm).padStart(2,'0')}:00:00Z`).getTime();
    rangeEndMs   = new Date(`${y}-${m}-${d}T${String(utcPm + 1).padStart(2,'0')}:30:00Z`).getTime();
    fetchBars    = 120;
  }

  // Pass today's ET date so Alpaca only returns today's bars — no stale-day bleed
  const todayEt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'); // MM/DD/YYYY → YYYY-MM-DD

  for (const symbol of ASSETS.watchlist) {
    try {
      const allCandles = await getEquityBars(symbol, '1m', fetchBars, false, todayEt);
      if (allCandles.length === 0) {
        log.warn(`[Range/${mode}] ${symbol}: no candles for today — skipping`);
        continue;
      }

      const rangeCandles = allCandles.filter(c => {
        const t = c.openTime.getTime();
        return t >= rangeStartMs && t < rangeEndMs;
      });

      const priorCandles = allCandles.filter(c => c.openTime.getTime() < rangeStartMs).slice(-10);

      if (rangeCandles.length === 0) {
        // Fallback: use last N candles from today if time filter produces nothing
        const useCount = Math.min(15, allCandles.length);
        const lastN    = allCandles.slice(-useCount);
        const prior    = allCandles.length > useCount ? allCandles.slice(0, allCandles.length - useCount).slice(-10) : [];
        const range    = buildOpeningRange(symbol, lastN, prior);
        storeRange(mode, symbol, range);
        log.info(`[Range/${mode}] ${symbol}: locked via fallback (${useCount} today candles)`);
      } else {
        const range = buildOpeningRange(symbol, rangeCandles, priorCandles);
        storeRange(mode, symbol, range);
        log.info(`[Range/${mode}] ${symbol}: locked $${range.low.toFixed(2)}–$${range.high.toFixed(2)} (${rangeCandles.length} candles)`);
      }
    } catch (err) {
      log.error(`[Range/${mode}] ${symbol}: failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function storeRange(mode: 'ORB' | 'MIDDAY_SOURCE' | 'POWER_SOURCE', symbol: string, range: OpeningRange): void {
  if (mode === 'ORB')          openingRanges.set(symbol, range);
  else if (mode === 'MIDDAY_SOURCE') middayRanges.set(symbol, range);
  else                          powerRanges.set(symbol, range);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION LOOP
// Ticks every 10 s. Runs for ORB, Midday, or Power window.
// ─────────────────────────────────────────────────────────────────────────────

function startExecutionLoop(window: TradingWindow): void {
  // Run immediately
  void runExecutionCycle(window);

  executionTimerHandle = setInterval(() => {
    // Stop if the flag for this window was cleared
    if (window === 'ORB'        && sessionPhase !== 'TRADING')  { clearInterval(executionTimerHandle!); executionTimerHandle = null; return; }
    if (window === 'MIDDAY'     && !middayExecutionActive)       { clearInterval(executionTimerHandle!); executionTimerHandle = null; return; }
    if (window === 'POWER_HOUR' && !powerExecutionActive)        { clearInterval(executionTimerHandle!); executionTimerHandle = null; return; }
    void runExecutionCycle(window);
  }, SCHEDULE.executionIntervalMs);
}

async function runExecutionCycle(window: TradingWindow): Promise<void> {
  if (!sessionLog) return;

  // Gate: make sure this window is still active
  if (window === 'ORB'        && sessionPhase !== 'TRADING')  return;
  if (window === 'MIDDAY'     && !middayExecutionActive)       return;
  if (window === 'POWER_HOUR' && !powerExecutionActive)        return;

  // Concurrency guard — if a cycle is already running (slow Alpaca calls), skip this tick
  if (executionCycleRunning) {
    log.info(`[${window}] Cycle skipped — previous cycle still running`);
    return;
  }
  executionCycleRunning = true;
  try {

  // Intra-session NexusTrader kill switch — portfolio-manager can halt us mid-session.
  // Checked every cycle (~10s) so a risk trip stops new entries within seconds, not next day.
  if (isNexusKillActive()) {
    log.warn('[Execution] NexusTrader kill switch ACTIVE — halting entries this session');
    if (window === 'ORB') sessionPhase = 'MANAGING';
    middayExecutionActive = powerExecutionActive = false;
    return;
  }

  const portfolio = await getPortfolioStateForRisk();
  if (portfolio.circuitBreakerActive) {
    log.warn('[Execution] Circuit breaker active — halting entries');
    return;
  }
  if (portfolio.dailyPnLPct <= -RISK.maxDailyLossPct) {
    log.warn(`[Execution] Daily loss kill switch: ${(portfolio.dailyPnLPct * 100).toFixed(2)}%`);
    sessionLog = markCircuitBreaker(sessionLog);
    await log.discord(`**CIRCUIT BREAKER** — daily loss ${(portfolio.dailyPnLPct * 100).toFixed(2)}% hit limit.`);
    if (window === 'ORB') sessionPhase = 'MANAGING';
    middayExecutionActive = powerExecutionActive = false;
    return;
  }
  if (sessionLog && portfolio.consecutiveLosses >= RISK.maxConsecutiveLosses) {
    log.warn(`[Execution] ${portfolio.consecutiveLosses} consecutive losses — halting entries`);
    if (window === 'ORB') sessionPhase = 'MANAGING';
    middayExecutionActive = powerExecutionActive = false;
    return;
  }

  // Resolve per-window state
  const windowPositions  = window === 'ORB' ? orbPositions      : window === 'MIDDAY' ? middayPositions      : powerPositions;
  const windowRanges     = window === 'ORB' ? openingRanges     : window === 'MIDDAY' ? middayRanges         : powerRanges;
  const windowTraded     = window === 'ORB' ? orbTradedSymbols  : window === 'MIDDAY' ? middayTradedSymbols  : powerTradedSymbols;
  const windowMaxEntries = window === 'ORB' ? RISK.maxTradesPerDay : window === 'MIDDAY' ? SCHEDULE.midday.maxEntries : SCHEDULE.powerHour.maxEntries;
  const windowTradesOpen = window === 'ORB' ? orbTradesOpenedToday : window === 'MIDDAY' ? middayTradesOpenedToday : powerTradesOpenedToday;
  const tpMult           = window === 'ORB' ? ORB.takeProfitMultiplier : window === 'MIDDAY' ? SCHEDULE.midday.takeProfitMult : SCHEDULE.powerHour.takeProfitMult;

  type Candidate = { symbol: string; cycle: OrbCycle; adjustedScore: number };
  const candidates: Candidate[] = [];

  for (const symbol of ASSETS.watchlist) {
    if (windowTraded.has(symbol))                              continue;
    if (tradedSymbolsToday.has(symbol))                        { log.info(`[${window}] ${symbol}: already traded today (session cap) — skipping`); continue; }
    if (windowTradesOpen >= windowMaxEntries)                  { log.info(`[${window}] Max entries reached`); break; }
    if (pendingBuys.has(symbol))                              continue;
    if (windowPositions.has(symbol))                          continue;

    // Correlation-group cap — across ALL windows (they share one account).
    // Skip if the symbol's group already holds the max allowed open positions.
    // Prevents stacking one concentrated bet (e.g. all 6 crypto-proxies at once).
    const symbolGroup = RISK.correlatedGroups.find(g => g.includes(symbol));
    if (symbolGroup) {
      const openInGroup = symbolGroup.filter(s =>
        orbPositions.has(s) || middayPositions.has(s) || powerPositions.has(s),
      ).length;
      if (openInGroup >= RISK.maxPositionsPerCorrelationGroup) {
        log.info(
          `[${window}] ${symbol}: skipping — correlation group at cap ` +
          `(${openInGroup}/${RISK.maxPositionsPerCorrelationGroup} open in [${symbolGroup.join(', ')}])`,
        );
        continue;
      }
    }

    const currentRange = windowRanges.get(symbol) ?? null;

    let cycle: OrbCycle;
    try {
      cycle = await runOrbCycle(symbol, portfolio, currentRange, preMarketAnalysis, window);
    } catch (err) {
      log.error(`[${window}] ORB cycle failed for ${symbol}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    if (cycle.range && window === 'ORB') openingRanges.set(symbol, cycle.range);

    if (cycle.phase === 'SKIPPED' || (cycle.finalScore === 0 && cycle.phase !== 'BUILDING_RANGE')) {
      log.info(`[${window}] ${symbol}: SKIPPED — ${cycle.narrative}`);
    } else {
      log.info(`[${window}] ${symbol}: phase=${cycle.phase} score=${cycle.finalScore.toFixed(3)} orb=${cycle.orbScore.toFixed(3)}`);
    }

    if (!cycle.shouldEnter) continue;

    const brainIntel = getPreTradeIntelligence(symbol, currentRegime, preMarketAnalysis?.marketLensBias);
    if (brainIntel.shouldSkip) {
      log.warn(`[Brain] ${symbol}: skipped — poor historical performance`);
      continue;
    }

    const adjustedThreshold = RISK.minConfidenceToTrade + brainIntel.confidenceAdj;
    if (cycle.finalScore < adjustedThreshold) {
      log.info(`[Brain] ${symbol}: score ${cycle.finalScore.toFixed(3)} < threshold ${adjustedThreshold.toFixed(3)}`);
      continue;
    }

    candidates.push({ symbol, cycle, adjustedScore: cycle.finalScore - brainIntel.confidenceAdj });
  }

  if (candidates.length === 0) return;

  candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);

  // Paper mode: enter all valid setups for data collection
  const toEnter = PAPER_MODE ? candidates : [candidates[0]];

  for (const { symbol, cycle } of toEnter) {
    if (pendingBuys.has(symbol)) continue;

    // Re-check the correlation cap AT ENTRY TIME. The gather-phase check above runs
    // before any fills, so without this a single paper-mode pass could enter every
    // crypto name at once. Count already-open positions PLUS ones committed earlier
    // in this same loop (pendingBuys) against the group cap.
    const symbolGroup = RISK.correlatedGroups.find(g => g.includes(symbol));
    if (symbolGroup) {
      const openOrPending = symbolGroup.filter(s =>
        orbPositions.has(s) || middayPositions.has(s) || powerPositions.has(s) || pendingBuys.has(s),
      ).length;
      if (openOrPending >= RISK.maxPositionsPerCorrelationGroup) {
        log.info(
          `[${window}] ${symbol}: entry skipped — correlation group at cap ` +
          `(${openOrPending}/${RISK.maxPositionsPerCorrelationGroup} in [${symbolGroup.join(', ')}])`,
        );
        continue;
      }
    }

    pendingBuys.add(symbol);
    markWindowTrade(window, symbol); // mark before fill so re-entry is blocked during waitForFill
    try {
      await executeEntry(symbol, cycle, portfolio, window, tpMult);
    } finally {
      pendingBuys.delete(symbol);
    }
  }
  } finally {
    executionCycleRunning = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY EXECUTION
// ─────────────────────────────────────────────────────────────────────────────

async function executeEntry(
  symbol:    string,
  cycle:     OrbCycle,
  portfolio: Awaited<ReturnType<typeof getPortfolioStateForRisk>>,
  window:    TradingWindow,
  tpMult:    number,
): Promise<void> {
  if (!sessionLog || !cycle.breakout) return;

  const { breakout } = cycle;
  const stopDistance = breakout.stopDistance;

  if (stopDistance <= 0) {
    log.warn(`[${window}] ${symbol}: invalid stop distance — skipping`);
    return;
  }

  const isShort = breakout.direction === 'SHORT';

  // ATR-based stop cap — direction-aware
  let effectiveStopPrice    = breakout.stopPrice;
  let effectiveStopDistance = stopDistance;
  try {
    const candles5m = await getEquityBars(symbol, '5m', 20);
    if (candles5m.length >= 15) {
      const atr = computeATR(
        candles5m.map(c => c.high),
        candles5m.map(c => c.low),
        candles5m.map(c => c.close),
        14,
      );
      if (stopDistance > atr.value) {
        effectiveStopDistance = atr.value;
        effectiveStopPrice    = isShort
          ? Math.round((breakout.entryPrice + atr.value) * 100) / 100
          : Math.round((breakout.entryPrice - atr.value) * 100) / 100;
        log.info(`[${window}] ${symbol}: stop tightened to ATR $${atr.value.toFixed(2)}`);
      }
    }
  } catch { /* safe fallback */ }

  // Minimum stop-distance floor — prevents midpoint stops on tight ranges from sitting
  // inside the bid/ask spread, which causes instant stop-outs within seconds of entry.
  const minStopDistance = breakout.entryPrice * ORB.minStopDistancePct;
  if (effectiveStopDistance < minStopDistance) {
    log.info(`[${window}] ${symbol}: stop distance $${effectiveStopDistance.toFixed(4)} below floor $${minStopDistance.toFixed(4)} — widening`);
    effectiveStopDistance = minStopDistance;
    effectiveStopPrice = isShort
      ? Math.round((breakout.entryPrice + minStopDistance) * 100) / 100
      : Math.round((breakout.entryPrice - minStopDistance) * 100) / 100;
  }

  // HMM dynamic allocation
  const allocationMultiplier = hmmRegime ? getRegimeAllocationMultiplier(hmmRegime.regime) : 1.0;
  if (allocationMultiplier === 0) {
    log.warn(`[${window}] ${symbol}: CRASH regime allocation = 0 — skipping`);
    return;
  }

  const volMult            = RISK.symbolVolatilityMultipliers[symbol as keyof typeof RISK.symbolVolatilityMultipliers] ?? 1.0;
  const positionSizeShares = ((portfolio.totalValue * RISK.maxRiskPerTradePct) / effectiveStopDistance) * allocationMultiplier / volMult;
  const positionSizeUsd    = positionSizeShares * breakout.entryPrice;

  if (positionSizeUsd < 50) {
    log.warn(`[${window}] ${symbol}: position too small ($${positionSizeUsd.toFixed(2)}) — skipping`);
    return;
  }

  // Hard position-size caps — applied before share calculation.
  // Note: riskManager.assessRisk has identical caps but is not called by the ORB path (flagged for Opus review).
  const maxByPortfolioPct = portfolio.totalValue * RISK.maxPositionSizePct;
  const maxByConfigUsd    = RISK.maxTradeSizeUsd;
  const maxByCash         = portfolio.cash * (1 - RISK.minCashReservePct);
  const cappedSizeUsd     = Math.min(positionSizeUsd, maxByPortfolioPct, maxByConfigUsd, maxByCash);

  if (cappedSizeUsd < positionSizeUsd) {
    const capName = cappedSizeUsd === maxByPortfolioPct ? 'maxPositionSizePct'
                  : cappedSizeUsd === maxByConfigUsd    ? 'maxTradeSizeUsd'
                  : 'cash reserve';
    log.info(`[${window}] ${symbol}: size capped by ${capName}: $${positionSizeUsd.toFixed(0)} → $${cappedSizeUsd.toFixed(0)}`);
  }

  const finalSizeUsd     = cappedSizeUsd;
  const finalSizeShares  = Math.floor(finalSizeUsd / breakout.entryPrice);

  if (finalSizeShares < 1) {
    log.warn(`[${window}] ${symbol}: < 1 share — skipping`);
    return;
  }

  const intel = getPreTradeIntelligence(symbol, currentRegime);
  const brainSizeShares = Math.max(1, Math.floor(finalSizeShares * intel.positionSizeMult));
  if (intel.positionSizeMult !== 1.0) {
    log.info(`[Brain] ${symbol}: size mult ${(intel.positionSizeMult * 100).toFixed(0)}% → ${brainSizeShares} shares`);
  }

  const correlatedShares = brainSizeShares;

  // Risk budget check — skip if portfolio exposure already near limit
  const riskBudget = readRiskBudget();
  if (riskBudget.remainingPct < 0.02) {
    log.warn(`[Risk] ${symbol}: portfolio at capacity (remaining: ${(riskBudget.remainingPct * 100).toFixed(1)}%) — skipping entry`);
    return;
  }

  const partialTarget = isShort
    ? breakout.entryPrice - cycle.range!.size
    : breakout.entryPrice + cycle.range!.size;
  const fullTarget = isShort
    ? breakout.entryPrice - (cycle.range!.size * tpMult)
    : breakout.entryPrice + (cycle.range!.size * tpMult);

  const tradeParams: TradeParameters = {
    positionSizeUsd:     Math.round(correlatedShares * breakout.entryPrice * 100) / 100,
    positionSizeCoins:   correlatedShares,
    entryPrice:          breakout.entryPrice,
    stopLossPrice:       effectiveStopPrice,
    partialProfitPrice:  Math.round(partialTarget * 100) / 100,
    takeProfitPrice:     Math.round(fullTarget    * 100) / 100,
    trailingStopPct:     0.01,
    breakEvenTriggerPct: 0.01,
    riskAmount:          brainSizeShares * effectiveStopDistance,
    riskPct:             RISK.maxRiskPerTradePct,
    stopLossDistance:    effectiveStopDistance,
    rewardRiskRatio:     tpMult,
  };

  const dirLabel = isShort ? 'SHORT' : 'LONG';
  log.info(`[${window}] ${symbol}: ENTERING ${dirLabel} — ${brainSizeShares} shares at ~$${breakout.entryPrice.toFixed(2)}`);
  log.info(`[${window}]   Stop: $${effectiveStopPrice.toFixed(2)} | Target: $${fullTarget.toFixed(2)} | Narrative: ${cycle.narrative}`);

  if (isDryRun) {
    log.warn(`[${window}] DRY RUN — would ${isShort ? 'short' : 'buy'} ${brainSizeShares} shares of ${symbol}`);
    await log.discord(`**[DRY RUN] ${window} ${dirLabel} ${symbol}** — ${brainSizeShares} shares | Stop: $${effectiveStopPrice.toFixed(2)} | Target: $${fullTarget.toFixed(2)}`);
    return;
  }

  try {
    // Always attempt a bracket order first. If Alpaca rejects it, fall back to a
    // plain entry + immediately place standalone stop and TP. Never enter naked.
    let bracketSucceeded = false;
    let entryOrder: Awaited<ReturnType<typeof placeMarketShort>>;

    try {
      entryOrder = isShort
        ? await placeMarketShort(symbol, brainSizeShares, effectiveStopPrice, fullTarget)
        : await placeMarketBuy(symbol, brainSizeShares, effectiveStopPrice, fullTarget);
      bracketSucceeded = true;
    } catch (bracketErr) {
      log.warn(`[${window}] ${symbol}: bracket rejected (${bracketErr instanceof Error ? bracketErr.message : bracketErr}) — falling back to plain entry + standalone orders`);
      entryOrder = isShort
        ? await placeMarketShort(symbol, brainSizeShares)
        : await placeMarketBuy(symbol, brainSizeShares);
    }

    const filled     = await waitForFill(entryOrder.orderId, 30_000);
    const fillPrice  = filled.filledAvgPrice ?? breakout.entryPrice;
    const fillShares = Math.round(filled.filledQty);

    if (fillShares <= 0) {
      log.error(`[${window}] ${symbol}: fill returned 0 shares`);
      return;
    }

    log.info(`[${window}] ${symbol}: filled ${fillShares} shares at $${fillPrice.toFixed(2)} (${bracketSucceeded ? 'bracket' : `plain ${isShort ? 'short' : 'buy'}`})`);

    const actualStop   = effectiveStopPrice;
    const actualTarget = isShort
      ? fillPrice - (cycle.range!.size * tpMult)
      : fillPrice + (cycle.range!.size * tpMult);

    const fakeDecision = {
      action:     'BUY' as const,
      finalScore: cycle.finalScore,
      threshold:  RISK.minConfidenceToTrade,
      confidence: cycle.orbScore,
      scores: {
        technical:      cycle.orbScore,
        microstructure: 0.5,
        sentiment:      cycle.sentimentScore,
        whale:          cycle.whaleScore,
        macro:          cycle.macroScore,
      },
      weights: {
        technical:      0.35,
        microstructure: 0,
        sentiment:      0.10,
        whale:          0.05,
        macro:          0.20,
      },
      pattern:   `${window} ${dirLabel}`,
      dataGaps:  [] as string[],
      tradeable: true,
      blockedBy: null,
      reason:    `${window} ${dirLabel} — score ${cycle.finalScore.toFixed(3)}`,
      decidedAt: new Date(),
    };

    const { log: updatedLog, tradeId } = recordTradeEntry(
      sessionLog,
      symbol,
      fillPrice,
      fillPrice * fillShares,
      fillShares,
      fakeDecision,
    );
    sessionLog = updatedLog;

    const managed = openPosition(symbol, fillPrice, fillShares, tradeParams, isShort ? 'short' : 'long');

    let stopOrderId: string | null = null;
    let tpOrderId:   string | null = null;

    if (!bracketSucceeded) {
      // Bracket was rejected — place standalone stop and TP immediately.
      // For shorts: stop is a buy-stop ABOVE entry; TP is a limit cover BELOW entry.
      // For longs:  stop is a sell-stop BELOW entry; TP is a limit sell ABOVE entry.
      try {
        const stopOrder = await placeStopLoss(symbol, fillShares, actualStop, isShort);
        stopOrderId = stopOrder.orderId;
        log.info(`[${window}] Standalone stop placed at $${actualStop.toFixed(2)}`);
      } catch (err) {
        log.error(`[${window}] ${symbol}: STOP PLACEMENT FAILED — position is unprotected! ${err instanceof Error ? err.message : err}`);
        await log.discord(`🚨 **UNPROTECTED POSITION** — ${symbol} ${dirLabel} entered but stop order failed. Manual intervention required.`);
      }
      try {
        const tpOrder = await placeTakeProfit(symbol, fillShares, actualTarget, isShort);
        tpOrderId = tpOrder.orderId;
        log.info(`[${window}] Standalone TP placed at $${actualTarget.toFixed(2)}`);
      } catch (err) {
        log.warn(`[${window}] TP placement failed: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // Verify bracket child orders actually landed on Alpaca before trusting bracketSucceeded.
      // Alpaca can accept a bracket order at the API level but fail to create child orders.
      try {
        const openOrders = await fetch(
          `${process.env.ALPACA_BASE_URL}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&limit=10`,
          { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY! } }
        ).then(r => r.json()) as { type: string; side: string; id: string }[];

        const hasStop = openOrders.some(o => o.type === 'stop' || o.type === 'stop_limit');
        const hasTP   = openOrders.some(o => o.type === 'limit');

        if (!hasStop || !hasTP) {
          log.warn(`[${window}] ${symbol}: bracket accepted but child orders missing (stop=${hasStop}, tp=${hasTP}) — placing standalone orders`);
          if (!hasStop) {
            try {
              const stopOrder = await placeStopLoss(symbol, fillShares, actualStop, isShort);
              stopOrderId = stopOrder.orderId;
              log.info(`[${window}] Recovery stop placed at $${actualStop.toFixed(2)}`);
            } catch (err) {
              log.error(`[${window}] ${symbol}: RECOVERY STOP FAILED — position is unprotected! ${err instanceof Error ? err.message : err}`);
              await log.discord(`🚨 **UNPROTECTED POSITION** — ${symbol} ${dirLabel} bracket + recovery stop both failed. Manual intervention required.`);
            }
          }
          if (!hasTP) {
            try {
              const tpOrder = await placeTakeProfit(symbol, fillShares, actualTarget, isShort);
              tpOrderId = tpOrder.orderId;
              log.info(`[${window}] Recovery TP placed at $${actualTarget.toFixed(2)}`);
            } catch (err) {
              log.warn(`[${window}] Recovery TP failed: ${err instanceof Error ? err.message : err}`);
            }
          }
        } else {
          log.info(`[${window}] Bracket verified — stop $${actualStop.toFixed(2)}, target $${actualTarget.toFixed(2)}`);
        }
      } catch (verifyErr) {
        log.warn(`[${window}] ${symbol}: bracket verification fetch failed — assuming bracket is live: ${verifyErr instanceof Error ? verifyErr.message : verifyErr}`);
        log.info(`[${window}] Bracket active (unverified) — stop $${actualStop.toFixed(2)}, target $${actualTarget.toFixed(2)}`);
      }
    }

    const tracked: TrackedPosition = { position: managed, stopOrderId, tpOrderId, _tradeId: tradeId, window };

    if (window === 'ORB')        orbPositions.set(symbol, tracked);
    else if (window === 'MIDDAY') middayPositions.set(symbol, tracked);
    else                          powerPositions.set(symbol, tracked);

    const rrNum   = Math.abs(actualTarget - fillPrice);
    const rrDenom = Math.abs(fillPrice - actualStop);
    const rr      = rrDenom > 0 ? (rrNum / rrDenom).toFixed(1) : '?';
    const entryEmoji = isShort ? '🔴' : '🟢';
    await log.important(
      `${entryEmoji} **ENTER ${window} ${dirLabel} — ${symbol}**\n` +
      `💵 Entry: $${fillPrice.toFixed(2)} × ${fillShares} shares ($${(fillPrice * fillShares).toFixed(0)})\n` +
      `🛑 Stop: $${actualStop.toFixed(2)}  🎯 Target: $${actualTarget.toFixed(2)}  📐 R:R ${rr}×\n` +
      `📊 Score: ${(cycle.finalScore * 100).toFixed(1)}%  |  ORB: ${(cycle.orbScore * 100).toFixed(0)}%  |  Macro: ${(cycle.macroScore * 100).toFixed(0)}%\n` +
      `💬 ${cycle.narrative}`
    );

  } catch (err) {
    log.error(`[${window}] ${symbol}: ${isShort ? 'short' : 'buy'} failed: ${err instanceof Error ? err.message : err}`);
  }
}

function markWindowTrade(window: TradingWindow, symbol: string): void {
  tradedSymbolsToday.add(symbol); // session-wide cap (RISK.maxTradesPerAsset = 1)
  if (window === 'ORB')        { orbTradedSymbols.add(symbol);    orbTradesOpenedToday++;    }
  else if (window === 'MIDDAY') { middayTradedSymbols.add(symbol); middayTradesOpenedToday++; }
  else                          { powerTradedSymbols.add(symbol);  powerTradesOpenedToday++;  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITION MONITOR
// Runs every 10 s. Checks all windows' open positions.
// ─────────────────────────────────────────────────────────────────────────────

function startPositionMonitor(): void {
  positionTimerHandle = setInterval(() => {
    void checkAllPositions();
  }, SCHEDULE.positionCheckIntervalMs);
}

async function checkAllPositions(): Promise<void> {
  // Max hold minutes per window — hard-close crons are the real backstop; these are safety nets.
  // ORB: 45 min (9:45–10:30). Midday: 135 min (11:00–1:15). Power: 55 min (3:00–3:55).
  const allMaps = [
    { map: orbPositions,    label: 'ORB',    maxHold: 45  },
    { map: middayPositions, label: 'MIDDAY', maxHold: 135 },
    { map: powerPositions,  label: 'POWER',  maxHold: 55  },
  ];

  for (const { map, maxHold } of allMaps) {
    for (const [symbol, tracked] of map.entries()) {
      try {
        const bars = await getEquityBars(symbol, '1m', 1);
        if (bars.length === 0) continue;

        const currentPrice = bars[bars.length - 1].close;
        const result       = checkPosition(tracked.position, currentPrice, false, maxHold);
        const { action, updatedPosition } = result;

        map.set(symbol, { ...tracked, position: updatedPosition });

        if (action.type === 'HOLD') continue;

        // Skip any action if an exit is already being processed for this symbol
        if (pendingExits.has(symbol)) {
          log.info(`[Monitor] ${symbol}: exit in-flight — deferring action`);
          continue;
        }

        if (action.type === 'MOVE_STOP') {
          if (tracked.stopOrderId) await cancelAllOrdersForSymbol(symbol).catch(() => {});
          try {
            const newStop = await placeStopLoss(symbol, Math.round(updatedPosition.sizeRemaining), action.newStopPrice, updatedPosition.direction === 'short');
            map.set(symbol, { ...tracked, position: updatedPosition, stopOrderId: newStop.orderId });
            log.info(`[Monitor] ${symbol}: stop moved to $${action.newStopPrice.toFixed(2)}`);
          } catch (err) {
            log.warn(`[Monitor] ${symbol}: stop update failed: ${err instanceof Error ? err.message : err}`);
          }
          continue;
        }

        if (action.type === 'PARTIAL_EXIT') {
          await closePartial(symbol, tracked, Math.round(action.coinsToSell), action.reason);
          map.set(symbol, { ...tracked, position: updatedPosition });
          continue;
        }

        if (action.type === 'FULL_EXIT') {
          await closePosition(symbol, tracked, action.reason);
          map.delete(symbol);
          continue;
        }

      } catch (err) {
        log.warn(`[Monitor] ${symbol}: check failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOSE POSITION (full exit)
// ─────────────────────────────────────────────────────────────────────────────

async function closePosition(
  symbol:  string,
  tracked: TrackedPosition,
  reason:  string,
): Promise<void> {
  if (!sessionLog) return;

  // Guard: only one exit in-flight per symbol at a time
  if (pendingExits.has(symbol)) {
    log.info(`[Close] ${symbol}: exit already in-flight — skipping duplicate close`);
    return;
  }
  pendingExits.add(symbol);

  try {
  log.info(`[Close] ${symbol}: closing — ${reason}`);

  await cancelAllOrdersForSymbol(symbol).catch(() => {});

  if (isDryRun) {
    log.warn(`[Close] DRY RUN — would close ${symbol}`);
    return;
  }

  const isShort = tracked.position.direction === 'short';

  // Always use Alpaca's actual position qty — bracket orders may have partially
  // filled between monitor cycles, making sizeRemaining stale.
  let sharesToSell: number;
  try {
    const livePortfolio = await buildPortfolioState();
    const livePos = livePortfolio.openPositions[symbol];
    if (!livePos) {
      log.warn(`[Close] ${symbol}: no Alpaca position found — already closed`);
      return;
    }
    sharesToSell = livePos.qty;
  } catch {
    // Fallback to tracked size if portfolio fetch fails
    sharesToSell = Math.round(tracked.position.sizeRemaining);
  }

  if (sharesToSell <= 0) {
    log.warn(`[Close] ${symbol}: no shares to sell`);
    return;
  }

  // Inner helper — place the market close, retrying once on 403 wash-trade errors.
  // Alpaca returns 403 when a bracket's TP/SL limit order is still open on their
  // side milliseconds after we cancelled it. Cancelling again + waiting 500ms clears it.
  const attemptClose = async (): Promise<Awaited<ReturnType<typeof coverShort>>> => {
    try {
      return isShort
        ? await coverShort(symbol, sharesToSell)
        : await placeMarketSell(symbol, sharesToSell);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403')) {
        log.warn("[Close] " + symbol + ": 403 wash-trade block — re-cancelling orders and retrying");
        await cancelAllOrdersForSymbol(symbol).catch(() => {});
        await new Promise(r => setTimeout(r, 500));
        return isShort
          ? await coverShort(symbol, sharesToSell)
          : await placeMarketSell(symbol, sharesToSell);
      }
      throw err;
    }
  };

  try {
    const exitOrder  = await attemptClose();
    const filled     = await waitForFill(exitOrder.orderId, 30_000);
    const exitPrice  = filled.filledAvgPrice ?? tracked.position.currentPrice;
    const slippage   = exitPrice * LIVE_EXECUTION.slippagePct * sharesToSell;
    const rawPnL     = isShort
      ? (tracked.position.entryPrice - exitPrice) * sharesToSell
      : (exitPrice - tracked.position.entryPrice) * sharesToSell;
    const realizedPnL = rawPnL - slippage;

    log.info(`[Close] ${symbol} [${isShort ? 'SHORT' : 'LONG'}]: ${isShort ? 'covered' : 'sold'} ${sharesToSell} @ $${exitPrice.toFixed(2)} | P&L: $${realizedPnL.toFixed(2)}`);

    if (tracked._tradeId) {
      sessionLog = recordTradeExit(sessionLog!, tracked._tradeId, exitPrice, reason);
    }

    const exitEmoji = realizedPnL >= 0 ? '✅' : '❌';
    const pnlSign   = realizedPnL >= 0 ? '+' : '';
    const movePct   = (Math.abs(exitPrice - tracked.position.entryPrice) / tracked.position.entryPrice * 100).toFixed(2);
    const dirLabel  = isShort ? 'SHORT' : 'LONG';
    await log.important(
      `${exitEmoji} **EXIT ${tracked.window} ${dirLabel} — ${symbol}**\n` +
      `📤 Exit: $${exitPrice.toFixed(2)}  📥 Entry: $${tracked.position.entryPrice.toFixed(2)}  📈 Move: ${movePct}%\n` +
      `💰 P&L: ${pnlSign}$${realizedPnL.toFixed(2)}  |  ${sharesToSell} shares\n` +
      `📝 ${reason}`
    );
  } catch (err) {
    log.error(`[Close] ${symbol}: ${isShort ? 'cover' : 'sell'} failed: ${err instanceof Error ? err.message : err}`);
  }
  } finally {
    pendingExits.delete(symbol);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOSE PARTIAL
// ─────────────────────────────────────────────────────────────────────────────

async function closePartial(
  symbol:       string,
  tracked:      TrackedPosition,
  sharesToSell: number,
  reason:       string,
): Promise<void> {
  if (sharesToSell <= 0 || isDryRun) return;

  if (pendingExits.has(symbol)) {
    log.info(`[Close] ${symbol}: partial exit already in-flight — skipping`);
    return;
  }
  pendingExits.add(symbol);

  const isShort = tracked.position.direction === 'short';

  try {
    await cancelAllOrdersForSymbol(symbol).catch(() => {});

    let exitOrder = isShort
      ? await coverShort(symbol, sharesToSell)
      : await placeTakeProfit(symbol, sharesToSell, tracked.position.currentPrice);
    let filled = await waitForFill(exitOrder.orderId, 15_000).catch(() => null);
    if (!filled || filled.filledQty <= 0) {
      await cancelAllOrdersForSymbol(symbol).catch(() => {});
      exitOrder = isShort
        ? await coverShort(symbol, sharesToSell)
        : await placeMarketSell(symbol, sharesToSell);
      filled = await waitForFill(exitOrder.orderId, 30_000);
    }
    const exitPrice = filled.filledAvgPrice ?? tracked.position.currentPrice;
    const profit    = isShort
      ? (tracked.position.entryPrice - exitPrice) * sharesToSell
      : (exitPrice - tracked.position.entryPrice) * sharesToSell;

    const dirLabel = isShort ? 'SHORT' : 'LONG';
    log.info(`[Close] ${symbol} [${dirLabel}]: partial — ${sharesToSell} shares @ $${exitPrice.toFixed(2)} | +$${profit.toFixed(2)}`);
    await log.discord(`**${tracked.window} PARTIAL ${dirLabel} ${symbol}** — ${sharesToSell} shares @ $${exitPrice.toFixed(2)} | +$${profit.toFixed(2)} | ${reason}`);
  } catch (err) {
    log.error(`[Close] ${symbol}: partial exit failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    pendingExits.delete(symbol);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOSE ORPHANED POSITIONS ON STARTUP
// Any ORB-symbol position with no open stop order is unprotected — close it.
// ─────────────────────────────────────────────────────────────────────────────

function expandWatchlistFromBlessedList(): void {
  try {
    const blessedPath = '/opt/nexustrader/signals/blessed_watchlist.json';
    if (!existsSync(blessedPath)) return;
    const ageHours = (Date.now() - statSync(blessedPath).mtimeMs) / 3_600_000;
    if (ageHours > 48) {
      log.warn('[Session] blessed_watchlist.json is stale (>48h) — using hardcoded watchlist only');
      return;
    }
    const data = JSON.parse(readFileSync(blessedPath, 'utf8'));
    const candidates: string[] = data.tickers ?? [];
    const added: string[] = [];
    for (const sym of candidates) {
      if (ASSETS.watchlist.includes(sym)) continue;  // already in list
      if (ASSETS.watchlist.length >= 12) break;       // cap at 12 total
      ASSETS.watchlist.push(sym);
      added.push(sym);
    }
    if (added.length > 0) {
      log.info(`[Session] Watchlist expanded by market-lens: +${added.join(', ')} → ${ASSETS.watchlist.join(', ')}`);
    }
  } catch (err) {
    log.warn(`[Session] Blessed watchlist read failed: ${err instanceof Error ? err.message : err}`);
  }
}



function readRiskBudget(): { remainingPct: number } {
  try {
    const budgetPath = '/opt/nexustrader/signals/risk_budget.json';
    if (!existsSync(budgetPath)) return { remainingPct: 1.0 }; // no file = full budget
    const ageMin = (Date.now() - statSync(budgetPath).mtimeMs) / 60_000;
    if (ageMin > 120) return { remainingPct: 1.0 }; // stale >2h = assume safe
    const data = JSON.parse(readFileSync(budgetPath, 'utf8'));
    return { remainingPct: data.orb_remaining_pct ?? data.remaining_pct ?? 1.0 };
  } catch { return { remainingPct: 1.0 }; }
}

// NexusTrader kill switch — written by portfolio-manager. Checked at the top of every
// execution cycle (every ~10s) so a risk halt takes effect intra-session, not next morning.
// Fail-closed on corrupt/unreadable file: a damaged kill file halts trading rather than
// silently allowing it. A missing file (normal case: no halt triggered) returns false.
function isNexusKillActive(): boolean {
  const killPath = '/opt/nexustrader/signals/kill_switch.json';
  if (!existsSync(killPath)) return false;
  try {
    const data = JSON.parse(readFileSync(killPath, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    return data.active === true && data.date === today;
  } catch (err) {
    log.error(`[KillSwitch] kill_switch.json is unreadable/corrupt — halting entries as a precaution: ${err instanceof Error ? err.message : err}`);
    return true;
  }
}

function formatPnL(account: { equity: number; lastEquity: number; todayPnL: number; todayPnLPct: number; portfolioValue: number; cash: number }): string {
  const emoji = account.todayPnL >= 0 ? '🟢' : '🔴';
  const sign  = account.todayPnL >= 0 ? '+' : '';
  // WARNING: account.todayPnL reflects the WHOLE shared paper account (including non-ORB positions).
  // This is for account-level health checks only. ORB strategy P&L comes from sessionLog.
  return (
    `💰 Equity: $${account.equity.toLocaleString()} | Cash: $${account.cash.toLocaleString()}\n` +
    `${emoji} Account today (shared): ${sign}$${account.todayPnL.toFixed(2)} (${sign}${(account.todayPnLPct * 100).toFixed(2)}%) — see session summary for ORB P&L`
  );
}

async function closeOrphanedPositions(): Promise<void> {
  if (isDryRun) return;
  try {
    const portfolio  = await buildPortfolioState();
    const openOrders = await fetch(
      `${process.env.ALPACA_BASE_URL}/v2/orders?status=open&limit=100`,
      { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY! } }
    ).then(r => r.json()) as { symbol: string; type: string; side: string }[];

    const symbolsWithStops = new Set(
      openOrders.filter(o => o.type === 'stop' || o.type === 'stop_limit').map(o => o.symbol)
    );
    // Also treat any pending buy (cover) or sell (close) as already-being-closed
    const symbolsWithPendingClose = new Set(
      openOrders.filter(o => o.side === 'buy' || o.side === 'sell').map(o => o.symbol)
    );

    for (const [symbol, pos] of Object.entries(portfolio.openPositions)) {
      if (!ASSETS.watchlist.includes(symbol)) continue; // only ORB symbols
      if (symbolsWithStops.has(symbol)) continue;       // protected by stop order
      if (symbolsWithPendingClose.has(symbol)) {        // already being closed
        log.info(`[Startup] ${symbol}: pending close order already exists — skipping orphan close`);
        continue;
      }
      if (orbPositions.has(symbol) || middayPositions.has(symbol) || powerPositions.has(symbol)) continue; // tracked

      const qty = pos.qty;
      if (qty < 0.5) {
        log.warn(`[Startup] ${symbol}: fractional position (${qty.toFixed(4)} shares) — skipping`);
        continue;
      }

      const isShort = pos.sizeUsd < 0;
      log.warn(`[Startup] ${symbol}: orphaned ${isShort ? 'SHORT' : 'LONG'} position (${qty} shares, no stop) — closing`);
      await log.discord(`⚠️ **Orphaned position detected at startup: ${symbol}** — ${qty} shares ${isShort ? 'short' : 'long'} with no stop. Closing now.`);
      try {
        const order = isShort
          ? await coverShort(symbol, qty)
          : await placeMarketSell(symbol, qty);
        await waitForFill(order.orderId, 30_000);
        log.info(`[Startup] ${symbol}: orphaned position closed`);
      } catch (err) {
        log.error(`[Startup] ${symbol}: failed to close orphan: ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    log.warn(`[Startup] orphan check failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH OFFLINE EXIT PRICE
// When a position closed while the bot was down, find the real fill price from
// Alpaca's closed-order history rather than recording entry price as the exit.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOfflineExitPrice(symbol: string, entryPrice: number): Promise<number> {
  try {
    // Search Alpaca closed orders for a sell/cover that closed this symbol
    const res = await fetch(
      `${process.env.ALPACA_BASE_URL}/v2/orders?status=closed&symbols=${encodeURIComponent(symbol)}&direction=desc&limit=10`,
      { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY! } }
    );
    if (res.ok) {
      const orders = await res.json() as { side: string; filled_avg_price: string | null; status: string }[];
      const closing = orders.find(o =>
        (o.side === 'sell' || o.side === 'buy') &&
        o.status === 'filled' &&
        o.filled_avg_price != null
      );
      if (closing?.filled_avg_price) {
        return parseFloat(closing.filled_avg_price);
      }
    }
  } catch (err) {
    log.warn(`[Reconnect] ${symbol}: order history fetch failed: ${err instanceof Error ? err.message : err}`);
  }

  // Fallback: use last known market price (1m bar), not entry price
  try {
    const bars = await getEquityBars(symbol, '1m', 1);
    if (bars.length > 0) return bars[bars.length - 1].close;
  } catch { /* ignore */ }

  return entryPrice; // last resort only
}

// ─────────────────────────────────────────────────────────────────────────────
// RECONNECT ORPHANED POSITIONS
// ─────────────────────────────────────────────────────────────────────────────

async function reconnectOrphanedPositions(window: TradingWindow): Promise<void> {
  if (!sessionLog) return;

  try {
    const livePortfolio = await buildPortfolioState();
    const windowPositions = window === 'ORB' ? orbPositions : window === 'MIDDAY' ? middayPositions : powerPositions;
    const windowTraded    = window === 'ORB' ? orbTradedSymbols : window === 'MIDDAY' ? middayTradedSymbols : powerTradedSymbols;

    const openTrades = sessionLog.trades.filter(t => t.outcome === 'OPEN');
    for (const trade of openTrades) {
      const { symbol, entryPrice, coinsTraded, tradeId } = trade;
      const livePos = livePortfolio.openPositions[symbol];

      if (!livePos) {
        // Position closed while bot was offline — find the real fill price from Alpaca.
        log.warn(`[Reconnect] ${symbol}: not on Alpaca — fetching real exit price`);
        const realExitPrice = await fetchOfflineExitPrice(symbol, entryPrice);
        const reason = realExitPrice !== entryPrice
          ? 'Closed while offline — price reconstructed from Alpaca order history'
          : 'Closed while offline — exit price unavailable, using last market price';
        sessionLog = recordTradeExit(sessionLog!, tradeId, realExitPrice, reason);
        log.info(`[Reconnect] ${symbol}: recorded exit at $${realExitPrice.toFixed(2)} (was entry $${entryPrice.toFixed(2)})`);
        continue;
      }

      windowPositions.set(symbol, reconnectPosition(symbol, coinsTraded, livePos, tradeId, new Date(trade.enteredAt), window));
      markWindowTrade(window, symbol);
      log.info(`[Reconnect] ${symbol}: reconnected at $${livePos.entryPrice.toFixed(2)}`);
    }

    for (const [symbol, livePos] of Object.entries(livePortfolio.openPositions)) {
      if (windowPositions.has(symbol)) continue;
      if (!ASSETS.watchlist.includes(symbol)) continue;
      const shares = livePos.qty;
      log.warn(`[Reconnect] ${symbol}: untracked Alpaca position — monitoring`);
      windowPositions.set(symbol, reconnectPosition(symbol, shares, livePos, undefined, new Date(), window));
      windowTraded.add(symbol);
    }
  } catch (err) {
    log.warn(`[Reconnect] Failed: ${err instanceof Error ? err.message : err}`);
  }
}

function reconnectPosition(
  symbol:    string,
  shares:    number,
  livePos:   import('./core/riskManager.js').OpenPosition,
  tradeId:   string | undefined,
  openedAt:  Date,
  window:    TradingWindow,
): TrackedPosition {
  // Alpaca returns negative qty for short positions — detect direction from sign.
  const isShort      = livePos.sizeUsd < 0 || parseFloat(String(livePos.qty)) < 0;
  const direction    = isShort ? 'short' : 'long' as const;
  const absShares    = Math.abs(shares);
  const stopDistance = livePos.entryPrice * BRAIN_CONFIG.orphanedStopPct;

  // Stop and targets must be on the correct side of entry for the direction.
  const stopPrice        = isShort
    ? Math.round((livePos.entryPrice + stopDistance) * 100) / 100   // above entry for shorts
    : Math.round((livePos.entryPrice - stopDistance) * 100) / 100;  // below entry for longs
  const partialTarget    = isShort
    ? Math.round((livePos.entryPrice - stopDistance) * 100) / 100
    : Math.round((livePos.entryPrice + stopDistance) * 100) / 100;
  const fullTarget       = isShort
    ? Math.round((livePos.entryPrice - stopDistance * ORB.takeProfitMultiplier) * 100) / 100
    : Math.round((livePos.entryPrice + stopDistance * ORB.takeProfitMultiplier) * 100) / 100;

  const position: ManagedPosition = {
    symbol,
    direction,
    qty:             absShares,
    sizeUsd:         livePos.sizeUsd,
    entryPrice:      livePos.entryPrice,
    currentPrice:    livePos.currentPrice,
    unrealizedPnL:   livePos.unrealizedPnL,
    phase:           'OPEN',
    tradeParams: {
      entryPrice:          livePos.entryPrice,
      stopLossPrice:       stopPrice,
      stopLossDistance:    stopDistance,
      partialProfitPrice:  partialTarget,
      takeProfitPrice:     fullTarget,
      positionSizeUsd:     livePos.sizeUsd,
      positionSizeCoins:   absShares,
      trailingStopPct:     0.01,
      breakEvenTriggerPct: 0.01,
      riskAmount:          stopDistance * absShares,
      riskPct:             RISK.maxRiskPerTradePct,
      rewardRiskRatio:     ORB.takeProfitMultiplier,
    },
    stopPrice,
    highestPrice:     livePos.currentPrice,
    sizeRemaining:    absShares,
    partialExitDone:  false,
    openedAt,
  };
  return { position, stopOrderId: null, tpOrderId: null, _tradeId: tradeId, window };
}

// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO STATE HELPER
// ─────────────────────────────────────────────────────────────────────────────

async function getPortfolioStateForRisk() {
  const liveState = await buildPortfolioState();
  if (!sessionLog) return liveState;
  return buildPortfolioStateFromJournal(sessionLog, liveState.totalValue, liveState.cash, liveState.openPositions);
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('[Bot] Fatal error in main():', err);
  process.exit(1);
});
