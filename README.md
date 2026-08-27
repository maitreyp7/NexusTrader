# NexusTrader

A personal, autonomous **quant trading system** — an ensemble of small, uncorrelated,
daily-rebalanced strategies, each validated on an honest backtester before it ever
touches money. Runs itself on a VPS, paper-trades on Alpaca, and defends itself.

> **History:** NexusTrader began as an AI-news/ORB day-trading system (market-lens,
> swing-bot, ORB intraday bot). Those were **retired as proven losers** (honest
> backtests: ORB PF 0.83, swing 14-28% win rate) and the project pivoted to a
> systematic daily-bar quant approach. The old modules live only in git history and
> `quant/research/GRAVEYARD.md`. **This README describes the system that actually runs.**

---

## What runs today

Everything lives in `quant/` and runs on the VPS (`root@146.190.77.207`,
`/opt/nexustrader/quant-bot/`), paper-trading on Alpaca via cron. Times are UTC.

### The three bots (sleeves)

| Bot | File | Edge | Universe | Budget |
|---|---|---|---|---|
| **Brain** | `live_runner.py` | ETF trend + crypto trend + turn-of-month, VIX regime-gated to cash | ETFs + crypto | ~51% |
| **Mean-rev** | `meanrev_runner.py` | RSI(2) oversold-bounce, quality-over-quantity params | ~150 large-cap stocks | ~34% |
| **Low-vol** | `lowvol_runner.py` | Lowest-volatility large caps, monthly rebalance | large-cap stocks | 15% |

The three are genuinely uncorrelated (low-vol↔brain ≈ 0.13), so the ensemble beats any
single sleeve. Combined backtest: **Sharpe 1.25, ~+7.3%/yr, −10% max drawdown**.
Over a full cycle (2000–2026) the system backtests +1,321% vs SPY +708%, with a fifth
of the drawdown — it wins by sidestepping the −46%/−55% crashes, not by beating bull
markets (in a strong bull it lags, by design).

### Capital split & safety

- **`dynamic_budget.py`** — the 3-way split (brain/mean-rev/low-vol), gentle
  performance tilt between brain and mean-rev, low-vol fixed at 15%.
- **`ownership.py`** — shared ledger so mean-rev and low-vol (same stock universe)
  never trade each other's positions.
- **`equity_protector.py`** — account-level kill switch (−15% from peak → liquidate +
  halt), with a data-sanity gate so an API glitch can't false-trip it.
- **`sleeve_breaker.py`** — per-sleeve auto-drawdown breaker (−20% → half budget,
  −35% → cut), written to `sleeve_overrides.json` which the runners obey.
- **Hard crypto cap** (15% of equity) inside `live_runner.py`.

### Monitoring / observability

| Tool | What it does |
|---|---|
| `health_check.py` | Daily Discord health report (per-sleeve share, P&L, alarms) |
| `sleeve_pnl.py` | Daily per-sleeve P&L log + live-vs-backtest drift check |
| `slippage_tracker.py` | Weekly execution-cost report (fill price vs same-day open) |
| `turnover_audit.py` | On-demand fills/day-per-sleeve churn check |

### VPS cron schedule (UTC)

```
21:30  live_runner.py --live      (brain: ETF + crypto trend)
21:35  meanrev_runner.py --live   (mean-rev)
21:40  lowvol_runner.py --live    (low-vol)
21:45  health_check.py            (daily health report)
21:47  sleeve_pnl.py              (per-sleeve P&L log)
21:50  sleeve_breaker.py          (per-sleeve drawdown breaker)
21:55 (Fri) slippage_tracker.py   (weekly execution report)
*/20 13-20  equity_protector.py   (account watchdog during market hours)
```

---

## Research & validation

Nothing goes live until it clears the honest backtester. The research OS lives in
`quant/research/` (local only — never deployed to the VPS):

- **`research/lib/validate.py`** — one call → full perf + robustness report + a
  recommendation tier (`REJECT` → `PRODUCTION_CANDIDATE`). Robustness gates (survives
  2× costs, positive across eras, holds recent half, deflated Sharpe) dominate raw Sharpe.
- **`research/GRAVEYARD.md`** — permanent record of **rejected** ideas. Check here
  before researching anything. Already rejected: leverage (a risk dial, not an edge),
  day-trading/intraday, shorting, defensive rotation, sector rotation, PEAD-as-4th-sleeve,
  and the whole free-data-edge sweep (the well is dry).

Backtests use **Yahoo** daily data (long history incl. 2008/2020 crashes); execution is
on **Alpaca** (data source ≠ execution source).

---

## Dashboard

A Next.js web UI (`dashboard/`) shows live equity, positions, and the per-sleeve view.
It's bound to `localhost:3000` on the VPS (not public — it shows your positions). View it
via an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 root@146.190.77.207   # leave open
# then open http://localhost:3000
```

---

## Cost

| Item | Cost |
|---|---|
| Alpaca paper trading + data | Free |
| Yahoo daily data | Free |
| DigitalOcean VPS | ~$6/month |
| **Total** | **~$6/month** |

No Claude API cost in the live loop — the reasoning-heavy old pipeline was retired.

---

## Status & what's next

- [x] Honest daily-bar backtest harness + research OS
- [x] Trend / crypto-trend / turn-of-month sleeves → the regime-gated brain (live)
- [x] Single-name mean-reversion sleeve (live)
- [x] Low-volatility sleeve — bot #3 (live 2026-08-27)
- [x] Per-sleeve P&L logging, slippage tracking, drawdown circuit breaker, crypto cap
- [ ] Let it run a full cycle; add real capital as the crash-protection thesis proves out

**There are no new strategies to add** — the free-edge research is exhausted (see
GRAVEYARD.md). The remaining levers are **capital, time, and not blowing up.**

See `BUILD_PLAN.md` for the detailed roadmap and `quant/research/` for all validation
evidence.
