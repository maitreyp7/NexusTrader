# NexusTrader — Session Handoff & Re-Apply Runbook

> **STATUS: ✅ APPLIED on 2026-06-12.** PART A (A1–A4) applied to the VPS and verified.
> Bot restarted and loaded the correct 12-symbol watchlist:
> `COIN, ARKK, SMCI, MARA, RIOT, IWM, MSTR, TSLA, QQQ, AAPL, AMD, DKNG`.
> Do NOT re-apply — the find/replace blocks no longer match (expected).
> Backups before edits: `/opt/nexustrader/.backups/20260612-200707-{config,index}-prePARTA.ts`.
>
> ⚠️ NOTE during apply: typecheck showed 3 PRE-EXISTING errors that are NOT the 2 this doc
> predicted (orbAnalyst.ts:167 `shortConfidencePremium`, orbAnalyst.ts:597 `enabledSymbols`,
> orbBacktester.ts:1013 2-arg). These existed in the pre-edit backup too — config.ts is drifted
> out of sync with orbAnalyst.ts from the two-session tug-of-war. Bot runs fine via tsx (no
> runtime crash, fields resolve undefined on optional paths), but this drift should be
> reconciled — flag for PART D coordination.

**For:** the (now single) Claude session working on NexusTrader.
**Generated:** 2026-06-12 by the main session.
**Action required:** Re-apply the changes in PART A below (they were reverted ~19:45 UTC 2026-06-12 — the bot is currently running the OLD 7-symbol watchlist). Everything is exact find/replace on the VPS at `root@<VPS_IP>`. Back up each file before editing (pattern: `cp <file> /opt/nexustrader/.backups/$(date +%Y%m%d-%H%M%S)-<name>`). After all edits: typecheck + restart + verify (PART C).

---

# ✅ FULLY RECONCILED 2026-06-12 ~20:43 UTC — single source of truth

The two-session tug-of-war is resolved. The VPS now runs ONE clean version with all of:
1. 12-name backtested watchlist (this doc's PART A)
2. Swing bot fully decoupled from ORB (index.ts/preMarketFilter.ts/brain.ts/auditAgent.ts clean)
3. Volume gate 1.0→0.7 + range cap 3%→5% (loosened to unblock entries)
4. Logger Discord retry-on-429 fix
5. BASE_WATCHLIST config-derived reset (the watchlist-overwrite bug fix)
All stray `*.bak` files moved out of `orb-bot/src/` → `/opt/nexustrader/.backups/strays/` so old
versions can't be resurrected. Bot restarted, active, clean boot, correct watchlist loaded.

⚠️ STILL OPEN: config.ts is drifted from orbAnalyst.ts (missing `shortConfidencePremium`,
`enabledSymbols`) — 3 typecheck errors, pre-existing, runs fine via tsx. Reconcile under PART D.

---

# PART A — ✅ APPLIED 2026-06-12 (do NOT re-apply)

## A1. ORB watchlist → high-volatility backtested names
**File:** `/opt/nexustrader/orb-bot/src/config.ts`

**FIND:**
```
  // The ETFs the bot actively trades (ORB strategy)
  watchlist: ['QQQ', 'IWM', 'NVDA', 'GOOGL', 'TSLA', 'META', 'AAPL'] as string[],
```
**REPLACE:**
```
  // ORB watchlist — chosen by 6-month backtest (Sharpe≥0.4 + positive expectancy).
  // High-volatility momentum/crypto-proxy names dominate ORB. Dropped GOOGL/NVDA/META
  // (weakest). Full ranking in STRATEGIES_BACKLOG.md. Capped at 12.
  watchlist: ['COIN', 'ARKK', 'SMCI', 'MARA', 'RIOT', 'IWM', 'MSTR', 'TSLA', 'QQQ', 'AAPL', 'AMD', 'DKNG'] as string[],
```

## A2. Add Alpaca symbol mappings for the new names
**File:** `/opt/nexustrader/orb-bot/src/config.ts`

**FIND:**
```
    'GOOGL': { alpaca: 'GOOGL', display: 'GOOGL', name: 'Alphabet Inc. (Class A)' },
    'JPM':   { alpaca: 'JPM',   display: 'JPM',   name: 'JPMorgan Chase & Co.' },
  } as Record<string, { alpaca: string; display: string; name: string }>,
```
**REPLACE:**
```
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
```

## A3. Per-symbol volatility multipliers for the new names (keep wild names SMALL)
**File:** `/opt/nexustrader/orb-bot/src/config.ts`
The multiplier scales risk-per-trade (higher = bigger position). New crypto-proxies kept low until live-proven.

**FIND:**
```
    'GOOGL': 1.0,
    'JPM':   0.9,
  } as Record<string, number>,
```
**REPLACE:**
```
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
```

## A4. Fix the watchlist-loading BUG + disconnect market-lens from ORB
**File:** `/opt/nexustrader/orb-bot/src/index.ts`
**Why:** the session-reset hardcodes the OLD watchlist and overwrites config.ts every morning (root cause of "0 trades for 6 days" — it was trading the wrong list, NOT tight params). Also removes the market-lens injection (swing retired → market-lens is research-only → its un-backtested picks must not steer ORB; it also caused a past collision bug).

**EDIT 1 — add a base-watchlist snapshot at module load.**
FIND (line ~19):
```
import { SCHEDULE, ASSETS, RISK, ORB, PREMARKET, BRAIN_CONFIG, LIVE_EXECUTION, PAPER_MODE } from './config.js';
```
REPLACE:
```
import { SCHEDULE, ASSETS, RISK, ORB, PREMARKET, BRAIN_CONFIG, LIVE_EXECUTION, PAPER_MODE } from './config.js';

// Immutable snapshot of the configured watchlist, taken at module load BEFORE any
// session-reset mutates ASSETS.watchlist in place. Each session refills from THIS,
// so the source of truth is config.ts, not a hardcoded list. (Bug fixed Jun 2026:
// a hardcoded ['QQQ','IWM',...] in the reset overwrote config every morning, so the
// new high-vol symbols never traded.)
const BASE_WATCHLIST: readonly string[] = [...ASSETS.watchlist];
```

**EDIT 2 — fix the reset + remove the market-lens injection.**
FIND:
```
    // Expand watchlist with market-lens blessed symbols (reset each session first)
    ASSETS.watchlist.length = 0;
    for (const s of ['QQQ', 'IWM', 'NVDA', 'GOOGL', 'TSLA', 'META', 'AAPL']) ASSETS.watchlist.push(s);
    expandWatchlistFromBlessedList();
```
REPLACE:
```
    // Reset the watchlist to the configured base each session. ORB trades ONLY the
    // backtested watchlist from config.ts. market-lens injection is DISABLED (Jun 2026):
    // swing bot retired, market-lens is research-only, its picks are un-backtested for
    // ORB. To re-enable, call expandWatchlistFromBlessedList() again.
    ASSETS.watchlist.length = 0;
    for (const s of BASE_WATCHLIST) ASSETS.watchlist.push(s);
```
NOTE: `expandWatchlistFromBlessedList()` stays defined (just no longer called) — that's fine, tsx ignores the unused function.

---

# PART B — ALREADY IN PLACE (do NOT redo; verify only)

- **Swing bot RETIRED (Jun 10):** both swing crontab lines commented `# DISABLED 2026-06-10`. market-lens/options-flow/earnings-predictor KEPT running as research feed. crontab backup at `/opt/nexustrader/.backups/crontab-*.bak`. ✅ not reverted.
- **Dashboard P&L fixes (Jun 9):** dailyPnL (Alpaca equity−last_equity) = single source of truth. logServer.ts uses ET date (etToday). /api/journal uses Alpaca fallback when an empty ORB session exists (fixes empty calendar). account/route.ts ORB_SYMBOLS updated + swingRealizedToday added. Header "TODAY'S P&L" + RiskPanel both show dailyPnL. Files: orb-bot/src/core/logServer.ts; dashboard/app/api/{account,session,journal}/route.ts; dashboard/components/TopBar.tsx; dashboard/lib/types.ts; dashboard/app/page.tsx. → If dashboard looks wrong, these may also have been reverted — check.
- **ORB brain seeded** from backtest (`npm run backtest -- --train`, ~976 synthetic-tagged trades, graduates at 10 real/symbol). File: orb-bot/logs/brain/coin-memory.json.

---

# PART C — AFTER EDITING: verify

```bash
# 1. typecheck (2 pre-existing harmless errors are OK: preMarketFilter.ts:69 + index.ts:~1695 log.error 2-arg)
ssh root@<VPS_IP> 'cd /opt/nexustrader/orb-bot && npx tsc --noEmit 2>&1 | grep "error TS"'
# 2. audit should pass (~130 checks)
ssh root@<VPS_IP> 'cd /opt/nexustrader/orb-bot && npm run audit 2>&1 | grep -E "passed|FAILED"'
# 3. restart + confirm the RIGHT watchlist loads
ssh root@<VPS_IP> 'systemctl restart trading-bot && sleep 5 && systemctl is-active trading-bot'
ssh root@<VPS_IP> 'tail -40 /opt/nexustrader/orb-bot/logs/bot.log | sed "s/\x1b\[[0-9;]*m//g" | grep "Watchlist:" | tail -1'
# EXPECT: Watchlist: COIN, ARKK, SMCI, MARA, RIOT, IWM, MSTR, TSLA, QQQ, AAPL, AMD, DKNG
```

---

# PART D — OPEN ITEMS (NOT yet implemented — coordinate before building)

1. ~~**ORB correlation-group cap**~~ ✅ **BUILT + DEPLOYED 2026-06-12.** config.ts `correlatedGroups`
   now defines the crypto cluster [COIN, MARA, RIOT, MSTR, ARKK, SMCI] + `maxPositionsPerCorrelationGroup: 2`.
   Enforced at BOTH the gather-phase check AND the entry loop in index.ts (the entry-loop check is
   essential — paper mode enters all candidates in one pass, so the gather check alone wouldn't stop
   them; the entry check counts open + pendingBuys against the cap). Counts across all 3 windows.
2. **Stale bias into ORB (RESOLVED earlier):** swingOutcomesBias already removed from brain.ts +
   preMarketFilter.ts during the swing decoupling. `getPreTradeIntelligence()` now takes only
   marketLensBias. No dead swing data reaches live trades. (Was undecided in this doc; now done.)
3. **2 leftover swing positions MSFT/MU:** protected by native resting stops, left to resolve. Verify if still open.

---

# PART E — strategic context (so both sessions align)
- Vision: hands-off passive income → scale toward quant-firm-like via AUTOMATION. Build a SMART SUPERVISOR (monitors live-vs-backtest, allocates capital, alerts on decay) FIRST, then strategies. Full plan: `ROADMAP.md`.
- Research: Freqtrade/FreqAI ≈ 80% of the roadmap already built — evaluate for the NEW crypto + supervisor layer; DON'T migrate the working stock ORB bot. See `RESEARCH_FINDINGS.md`.
- Reality: 95% of backtests fail live; ~5-10% of traders profitable; realistic +2-6%/mo. Live data is gold.
- Crypto: extend the WINNER (ORB) to crypto, not the failed swing. Alpaca crypto = spot-only → long-only. Deferred until ORB stock setup validated.
- **Coordination:** two Claude sessions are editing the same VPS files and clobbering each other. Pick ONE session as owner of orb-bot/src/{config.ts,index.ts} to stop the tug-of-war.
