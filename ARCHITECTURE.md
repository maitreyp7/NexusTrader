# NexusTrader — Architecture (Single Source of Truth)

**Last verified:** 2026-06-17 by auditing the live VPS + local repo (not from memory).
**Read this first.** It is the authoritative map of what is wired, live, and dead.

---

## THE ONE-LINE SUMMARY
There is **one trading bot** (ORB, in `trading-bot/`), a **dashboard**, and **one support
service** (portfolio-manager) that the bot depends on. Everything else is idle or retired.

---

## LIVE SYSTEM (what actually runs)

```
┌─────────────────────────────────────────────────────────────────┐
│  VPS: root@146.190.77.207  /opt/nexustrader/                     │
│                                                                   │
│  orb-bot/         ← trading-bot/ in repo. THE bot. systemd:       │
│                     trading-bot.service (24/7). Trades ORB +      │
│                     midday + power-hour breakouts, Mon–Fri.       │
│                                                                   │
│  dashboard/       ← nexus-dashboard.service. Next.js. Reads       │
│                     signals.json + portfolio.json + session logs. │
│                                                                   │
│  portfolio-manager/ ← cron 4:30pm + Fri weekly review. Writes     │
│                     kill_switch.json + risk_budget.json which     │
│                     THE ORB BOT READS. Keep it running.           │
│                                                                   │
│  signals/         ← shared JSON bus (see below)                   │
│  nexustrader.env  ← all secrets (gitignored, never committed)     │
└─────────────────────────────────────────────────────────────────┘
```

### Services (systemctl)
| Service | State | Notes |
|---------|-------|-------|
| `trading-bot.service` | 🟢 running 24/7 | the ORB bot |
| `nexus-dashboard.service` | 🟢 running | the web dashboard, port 3000 |

### Active cron (as of 2026-06-17)
| Time (ET) | Job | Why it's kept |
|-----------|-----|---------------|
| 4:30pm M–F | portfolio-manager/main.py | writes kill_switch + risk_budget (ORB reads these) |
| Fri 5:30pm | portfolio-manager/weekly_review.py | weekly summary |

---

## THE SIGNALS BUS (`signals/`)

Live files only (orphaned swing/ml files archived 2026-06-17 to `.backups/archive-*`):

| File | Written by | Read by | Critical? |
|------|-----------|---------|-----------|
| `kill_switch.json` | portfolio-manager | **ORB bot** | YES — halts trading |
| `risk_budget.json` | portfolio-manager | **ORB bot** | YES — caps exposure |
| `portfolio.json` | portfolio-manager | dashboard | display |
| `signals.json` | market-lens (PAUSED) | ORB (optional bias), dashboard | no — fail-safe |
| `orb_brain_export.json` | ORB bot | (self/reference) | no |
| `blessed_watchlist.json` | market-lens (PAUSED) | ORB (injection DISABLED) | no — not used |
| `options_signals.json` | options-flow (PAUSED) | nothing live | no |
| `earnings_predictions.json` | earnings-predictor (PAUSED) | nothing live | no |

**Rule:** the only signal files that affect live trading are `kill_switch.json` and
`risk_budget.json`. Everything else is optional/fail-safe.

---

## IDLE / IDLE MODULES (code kept, crons PAUSED)
These were built to feed the retired swing bot. Crons disabled 2026-06-17. Code stays for
possible repurposing. They make NO API calls while paused.

| Module | Was for | Status |
|--------|---------|--------|
| `market-lens/` | research → swing | cron paused 2026-06-12 (stops Anthropic/FRED/Quiver spend) |
| `options-flow/` | swing confirmation | cron paused 2026-06-17 |
| `earnings-predictor/` | swing avoid-list | cron paused 2026-06-17 |
| `wealth-intelligence/` | reporting | cron paused 2026-06-17 |

## RETIRED
| Thing | Where it went |
|-------|--------------|
| `swing-bot/` | archived to `~/PersonalProjects/disabled-swing-bot/` (local) + `.backups/archive-*` (VPS). Fully decoupled from ORB. |

---

## THE ORB BOT INTERNALS (trading-bot/src/)
- `config.ts` — **single source of truth** for settings. 12-symbol watchlist, gates, correlation groups.
- `index.ts` — main loop, session scheduling, entry execution, the 3 windows.
- `agents/preMarketFilter.ts` — GO/NO-GO decision (VIX, economic calendar, kill switch).
- `agents/brain.ts` — per-symbol adaptive sizing/confidence (graduates from synthetic at ~10 real trades).
- `agents/auditAgent.ts` — ~130 self-checks before trading.
- `core/logger.ts` — logging + Discord (retry-on-429).
- `strategy/openingRange.ts` — the breakout logic + volume/range gates.
- `dashboard/` — Next.js app (its own README/AGENTS.md note: modified Next.js, read node_modules docs before editing).

### Key tunable gates (config.ts)
- `volumeConfirmationMultiplier: 0.7` — breakout volume vs avg (lowered from 1.0)
- `maxRangeSize: 0.05` — skip days with range > 5% (raised from 3%)
- `minConfidenceToTrade: 0.55`
- `maxPositionsPerCorrelationGroup: 2` — caps the crypto cluster

---

## DEPLOY DISCIPLINE (how to avoid the past tug-of-war)
1. **One owner of `orb-bot/src/{config.ts,index.ts}` at a time.**
2. Edit locally → `npx tsc --noEmit` → backup VPS file → scp → restart → verify watchlist loads.
3. Local repo and VPS were confirmed IN SYNC on 2026-06-17. Keep them that way: commit after every change.
4. Backups live in `/opt/nexustrader/.backups/`.

---

## KNOWN OPEN ITEMS
- **ORB barely trades** (~1 trade/14 sessions) — the real priority. See `ROADMAP.md`.
  Instrumentation added 2026-06-17: a per-session **rejection tally** (volume / range /
  no_breakout / confidence / brain_skip / correlation) now appears in the daily Discord
  summary and the session JSON. Use the biggest bucket to decide which gate to tune next.

## RESOLVED
- ~~config.ts ↔ orbAnalyst.ts drift~~ — confirmed FIXED (tsc exit 0 as of 2026-06-17).
  `enabledSymbols` lives in config FADE section; `shortConfidencePremium` no longer referenced.

---

## WHERE TO LOOK
- **What to build next / strategy plan:** `ROADMAP.md`
- **Strategy ideas backlog:** `STRATEGIES_BACKLOG.md`
- **Crypto vs ORB-only research:** `RESEARCH_FINDINGS.md`
- **Security posture:** `SECURITY.md`
