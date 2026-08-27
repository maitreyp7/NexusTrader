# NexusTrader — Architecture (Single Source of Truth)

**Last verified:** 2026-08-27 by auditing the live VPS + local repo (not from memory).
**Read this first.** It is the authoritative map of what is wired, live, and dead.

---

## THE ONE-LINE SUMMARY
There are **three trading bots** (a regime-gated ETF/crypto "brain", a single-name
mean-reversion bot, and a low-volatility bot), all in `quant/`, running on the VPS as
cron jobs, plus a **dashboard** and a **safety/monitoring layer**. The old ORB day-bot,
swing bot, and the market-lens/options/earnings pipeline are **RETIRED** (see bottom).

---

## LIVE SYSTEM (what actually runs)

```
┌──────────────────────────────────────────────────────────────────────┐
│  VPS: root@146.190.77.207   /opt/nexustrader/quant-bot/               │
│  All bots paper-trade on Alpaca. Cron-driven (no systemd for the bots).│
│                                                                        │
│  live_runner.py     ← BRAIN: ETF trend + crypto trend + turn-of-month, │
│                        VIX/VIX3M regime-gated to cash. ~51% of equity. │
│  meanrev_runner.py  ← MEAN-REV: RSI(2) oversold-bounce on ~150 large   │
│                        caps. Quality params. ~34%.                     │
│  lowvol_runner.py   ← LOW-VOL: 15 lowest-vol large caps, monthly. 15%. │
│                                                                        │
│  dynamic_budget.py  ← the 3-way split (compute_split3).                │
│  equity_protector.py← account watchdog (−15% peak → liquidate+halt),   │
│                        with data-sanity gate. Runs every 20 min.       │
│  sleeve_breaker.py  ← per-sleeve drawdown breaker → sleeve_overrides.  │
│  health_check.py / sleeve_pnl.py / slippage_tracker.py / turnover_audit│
│                        ← monitoring (no orders).                       │
│                                                                        │
│  dashboard/         ← nexus-dashboard.service (Next.js, localhost:3000)│
│  nexustrader.env    ← all secrets (gitignored, never committed)        │
└──────────────────────────────────────────────────────────────────────┘
```

### Services (systemctl)
| Service | State | Notes |
|---------|-------|-------|
| `nexus-dashboard.service` | 🟢 active | the web dashboard, localhost:3000 (SSH-tunnel to view) |
| `trading-bot.service` | 🔴 failed/dead | the RETIRED ORB bot — not used; safe to remove |

The trading bots are **cron jobs**, not systemd services.

### Active cron (UTC, verified 2026-08-27)
| Time | Job | Role |
|------|-----|------|
| 21:30 M–F | `live_runner.py --live` | brain (ETF + crypto trend) |
| 21:35 M–F | `meanrev_runner.py --live` | mean-reversion |
| 21:40 M–F | `lowvol_runner.py --live` | low-volatility |
| 21:45 M–F | `health_check.py` | daily Discord health report |
| 21:47 M–F | `sleeve_pnl.py` | per-sleeve P&L log + drift check |
| 21:50 M–F | `sleeve_breaker.py` | per-sleeve drawdown breaker |
| 21:55 Fri | `slippage_tracker.py 30` | weekly execution-cost report |
| */20, 13–20 M–F | `equity_protector.py` | account watchdog during market hours |

---

## STATE FILES (in `quant-bot/`, not the old `signals/` bus)

The quant system does NOT use the old `signals/` JSON bus. Its state is local JSON:

| File | Written by | Read by | Critical? |
|------|-----------|---------|-----------|
| `KILL_SWITCH.json` | equity_protector | all 3 runners | YES — halts trading (manual clear) |
| `sleeve_overrides.json` | sleeve_breaker | all 3 runners | YES — per-sleeve budget multipliers |
| `ownership.json` | mean-rev + low-vol | both stock bots | YES — collision guard (who owns which name) |
| `protector_state.json` | equity_protector | equity_protector | high-water mark + last-good equity |
| `sleeve_breaker_state.json` | sleeve_breaker | sleeve_breaker | per-sleeve high-water marks |
| `live_logs/sleeve_pnl.jsonl` | sleeve_pnl | sleeve_pnl (drift) | per-sleeve daily history |

---

## KEY MODULES (`quant/`)
- `engine.py` — honest daily-bar backtest engine (no look-ahead, real costs). The gatekeeper's heart.
- `allocator.py` — combines sleeves, applies caps + the VIX regime gate.
- `strategies/` — `trend.py`, `crypto_trend.py`, `flow.py` (turn-of-month), `name_meanrev.py`, `lowvol.py`.
- `data.py` — Yahoo daily-bar fetcher (cached). Backtest data source (execution is Alpaca).
- `gatekeeper.py` — deflated Sharpe, walk-forward, split-half robustness stats.
- `research/` — the research OS (validate/similarity/stability) + `GRAVEYARD.md`. **Local only, never deployed.**

### Canonical config that matters
- **3-way split:** `dynamic_budget.compute_split3()` → brain ~51 / mean-rev ~34 / low-vol 15.
- **Mean-rev params:** `meanrev_runner.PARAMS` (entry_rsi 5, exit_rsi 70, hold 20, 8 names) — single source of truth, imported by dynamic_budget.
- **Crypto cap:** 15% of equity, in `live_runner.py`.
- **Breaker thresholds:** −20% → ×0.5 budget, −35% → ×0.0 (`sleeve_breaker.py`).

---

## DEPLOY DISCIPLINE
1. Edit locally → syntax-check (`python3 -c "import ast; ast.parse(...)"`) → `scp` to
   `/opt/nexustrader/quant-bot/` → dry-run on VPS → then let cron run it live.
2. The VPS runs via `/opt/nexustrader/venv/bin/python3` (NOT bare `python3` — no pandas there).
3. The research OS (`quant/research/`) is **local only** — do not deploy it (needs scipy;
   production doesn't import it).
4. Commit after every change. Deploy = scp of loose files (VPS is not a git checkout).

---

## RETIRED (do not resurrect without re-validating)
| Thing | Why | Where it went |
|-------|-----|---------------|
| ORB intraday bot (`trading-bot/`) | honest backtest PF 0.83 | code in repo; `trading-bot.service` dead on VPS |
| swing bot | 14–28% win rate, unvalidated news pipeline | archived; GRAVEYARD.md |
| market-lens / options-flow / earnings-predictor | fed the retired swing bot | crons paused; code kept for reference |
| Also rejected: leverage, day-trading, shorting, defensive rotation, sector rotation, residual momentum, PEAD-as-4th-sleeve, spike prediction | see `quant/research/GRAVEYARD.md` (check before researching anything) |

---

## WHERE TO LOOK
- **What runs + how to use it:** `README.md`
- **Roadmap / build order:** `BUILD_PLAN.md`
- **All validation evidence + rejected ideas:** `quant/research/` + `GRAVEYARD.md`
- **Full system audit (sleeve-by-sleeve):** `SYSTEM_AUDIT_2026-08-26.md`
- **Security posture:** `SECURITY.md`
