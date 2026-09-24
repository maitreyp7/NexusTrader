# NexusTrader

A personal, autonomous **quantitative trading system**. It runs an ensemble of small,
uncorrelated, daily-rebalanced strategies — each validated on an honest backtester
before it ever touches money — on a cheap VPS, paper-trading on Alpaca. It manages its
own capital allocation, defends itself against crashes and its own bugs, and reports on
itself. No manual research, no news-reading, no discretionary trades.

**Current state (2026-08-27):** feature-complete. Three live bots, full safety +
monitoring layer, ~$106k paper equity. The remaining work is not code — it's letting it
run through a full market cycle and adding real capital as it proves out.

---

## Table of contents
1. [The core idea](#the-core-idea)
2. [History: why it looks the way it does](#history-why-it-looks-the-way-it-does)
3. [The three bots (strategies)](#the-three-bots-strategies)
4. [How capital is split](#how-capital-is-split)
5. [Safety layer](#safety-layer)
6. [Monitoring & observability](#monitoring--observability)
7. [The backtest engine & research OS](#the-backtest-engine--research-os)
8. [Performance: honest numbers](#performance-honest-numbers)
9. [Infrastructure & deployment](#infrastructure--deployment)
10. [The dashboard](#the-dashboard)
11. [Cost](#cost)
12. [Repository layout](#repository-layout)
13. [What's been rejected (don't re-add)](#whats-been-rejected-dont-re-add)
14. [Operating the system](#operating-the-system)

---

## The core idea

The edge is **not** any single killer strategy — it's combining several *genuinely
different, independently-profitable, low-correlation* return streams. Each one is modest
on its own; together they produce a smoother, higher risk-adjusted return than any could
alone. This is the one "free lunch" in investing (diversification), applied rigorously.

Governing rules (learned the hard way):
- **Daily bars, not minutes.** Intraday trading loses to costs and HFT; daily-bar edges
  survive. Trades happen roughly once a day per bot, at most.
- **Every strategy is validated on an honest backtester** (real costs, no look-ahead,
  tested across decades and market regimes) before it goes live. Nothing graduates on a
  hunch.
- **A portfolio of edges, each vol-targeted and correlation-aware**, never one big bet.
- **Beat the market on *risk*, not on raw return.** The system is designed to sidestep
  crashes, not to outrun bull markets.

---

## History: why it looks the way it does

NexusTrader started as an AI-driven day-trading system: `market-lens` (a Claude-powered
news/SEC/Reddit research pipeline) feeding an **ORB intraday bot** and a **swing bot**.
Those were **retired as proven losers** — honest backtests showed the ORB bot at profit
factor 0.83 (it looked like 1.43 on an optimistic backtester — the exact mirage this
project now guards against) and the swing bot at a 14–28% win rate on an unvalidated
signal source.

The project pivoted to systematic daily-bar quant strategies. The old modules
(`market-lens/`, `trading-bot/`, `swing-bot/`, `options-flow/`, `earnings-predictor/`)
remain in the repo and git history for reference but **do not run**. Everything live is
in `quant/`.

---

## The three bots (strategies)

All three are **long-only** (Alpaca crypto is spot-only; shorting was tested and
rejected). All use vol-targeted position sizing.

### 1. The Brain — `quant/live_runner.py`
A regime-gated ensemble of three sub-strategies on ETFs + crypto:

- **ETF trend-following** (`strategies/trend.py`): long an asset when its 12-month
  momentum is positive **and** price is above its 200-day SMA; cash otherwise. Monthly
  rebalance. Universe: SPY, QQQ, IWM, EFA, EEM (equity), TLT, IEF (bonds), DBC, GLD, USO
  (commodities), UUP (dollar).
- **Crypto trend** (`strategies/crypto_trend.py`): hold each coin only while it's above
  its 50-day MA; vol-targeted; cash otherwise. Universe: BTC, ETH, SOL, LTC, BCH, LINK,
  AVAX, DOGE.
- **Turn-of-month** (`strategies/flow.py`): a small calendar tilt on SPY around
  month-end. Low individual edge, near-zero cost, acts as a volatility dampener.

**The regime gate** (`strategies/regime.py`) is the most important single component:
using the VIX / VIX3M term-structure ratio, when near-term fear spikes above long-term
(ratio > 1.0 = "backwardation" = stress), the brain goes to **cash**. This is why the
system's drawdowns are a fraction of the market's — it's usually already out before the
worst of a crash. It's risk-on ~78% of days historically.

A **hard 15% crypto cap** scales crypto down if the strategy ever asks for more than 15%
of total equity (belt-and-suspenders after a past bug over-bought crypto).

### 2. Mean-reversion — `quant/meanrev_runner.py`
Short-term oversold-bounce on individual large-cap stocks. Rules (`strategies/name_meanrev.py`):
- **Entry:** RSI(2) < 5 (deeply oversold) while price is above its 200-day SMA (uptrend).
- **Exit:** RSI(2) > 70, or a 20-day time stop, or the uptrend breaks.
- Equal-weight up to 8 concurrent names, 10% max each.
- Universe: ~150 liquid large caps across all sectors (`stock_universe.py`).

These "quality-over-quantity" parameters (deeper entry, patient exit, longer hold, fewer
names) replaced churnier settings after live data + backtesting showed the original was
bleeding money to bid-ask spread. The change raised its Sharpe 0.81 → 1.08 and halved its
drawdown.

### 3. Low-volatility — `quant/lowvol_runner.py`
Exploits the decades-old low-volatility anomaly (boring, calm stocks earn more per unit
of risk because investors overpay for exciting ones). Rules (`strategies/lowvol.py`):
- On the **last trading day of each month**, rank the ~150 large caps by 126-day
  (6-month) realized volatility.
- Go long the **15 lowest-vol names, equal-weight** (~6.7% each). Hold until next month.
- In practice: utilities, staples, REITs (Duke, Coca-Cola, Realty Income, etc.).

Correlation to the brain is ~0.13 — a genuine diversifier. Adding it took the combined
system from Sharpe 1.11 → 1.25.

---

## How capital is split

`quant/dynamic_budget.py` (`compute_split3()`) allocates equity across the three bots:

- **Base split: brain ~51% / mean-rev ~34% / low-vol 15%.**
- Low-vol is fixed at 15%. The remaining 85% is split between brain and mean-rev with a
  **gentle performance tilt** — up to ±10% toward whichever has done better over the
  trailing ~42 trading days. This is validated to help; a harsher tilt and a drawdown
  circuit-breaker inside the split were both tested and rejected as net-negative.
- All three runners read the same split, so they can't collectively over-allocate.

Because mean-rev and low-vol trade the *same* stock universe, `quant/ownership.py` keeps
a shared ledger of which bot owns which shares, so neither ever trades or liquidates the
other's positions.

---

## Safety layer

Two independent, layered defenses — because the biggest historical losses came from
*bugs and glitches*, not bad strategy.

### Account-level watchdog — `quant/equity_protector.py`
Runs every 20 minutes during market hours. Watches total equity vs its high-water mark:
- **−8%** → Discord warning.
- **−15%** → liquidate everything + write `KILL_SWITCH.json` (all bots refuse to trade
  until a human clears it). Requires two consecutive bad reads.
- **Data-sanity gate:** rejects any equity reading that (a) doesn't reconcile with
  cash + position values within 10%, or (b) implies a >20% drop since the last good read.
  Both are physically impossible for a daily-bar book, so an API glitch can't false-trip
  the kill switch (this bug once liquidated the whole book on a bad −55% reading).

### Per-sleeve circuit breaker — `quant/sleeve_breaker.py`
Runs daily. Tracks each sleeve's own high-water mark:
- **−20%** from a sleeve's peak → that sleeve's budget is auto-halved (×0.5).
- **−35%** → that sleeve is cut to zero (×0.0).
- Written to `sleeve_overrides.json`, which every runner obeys. Recovers automatically if
  the sleeve climbs back. Absolute thresholds, so it's safe with no historical data.

---

## Monitoring & observability

| Tool | Cadence | What it tells you |
|---|---|---|
| `health_check.py` | daily | One Discord report: per-sleeve capital share, position count, P&L, regime, and alarms (failed orders, budget drift, unowned positions, ledger desync). |
| `sleeve_pnl.py` | daily | Appends per-sleeve market value / unrealized P&L / fills to `sleeve_pnl.jsonl`, and once ≥20 days exist, flags any sleeve whose live rolling Sharpe drifts below its backtest baseline. |
| `slippage_tracker.py` | weekly (Fri) | True execution cost: fill price vs same-day open, per sleeve, vs the bps the backtest assumes. (Found mean-rev fills at ~15bps vs the 3bps assumed — single-stock spreads.) |
| `turnover_audit.py` | on-demand | Fills-per-day per sleeve, to catch churn. (Note: counts fill *fragments*, so judge churn by orders-per-run in the logs.) |

Everything reports to Discord. All are read-only (place no orders).

---

## The backtest engine & research OS

Nothing goes live unvalidated. This is the discipline that separates NexusTrader from the
retired system.

- **`quant/engine.py`** — the honest backtester. Deliberately pessimistic where the old
  one was optimistic: no look-ahead (weights decided on day *t*'s close take effect at
  *t+1*'s open), real per-side costs (3bps ETF / 15bps crypto), total-return prices.
- **`quant/gatekeeper.py`** — robustness statistics: deflated Sharpe, walk-forward by year
  blocks, split-half.
- **`quant/research/`** (local only — never deployed):
  - `lib/validate.py` — one call produces a full performance + robustness report and a
    recommendation tier: `REJECT → NEEDS_MORE_RESEARCH → INTERESTING → PAPER_TRADE →
    PRODUCTION_CANDIDATE`. **Robustness gates dominate raw Sharpe** — a high-Sharpe
    strategy that fails the era/cost/recent-half tests is rejected.
  - `lib/similarity.py` — return-correlation check vs live bots, so you never re-build an
    edge you already have.
  - `lib/stability.py` — parameter sweeps; rewards broad plateaus, warns on fragile spikes.
  - `GRAVEYARD.md` — every rejected idea, permanently. Check before researching anything.

**Data:** backtests use **Yahoo** daily bars (long history including the 2008 and 2020
crashes — the regimes that matter). Live execution is on **Alpaca**. Data source ≠
execution source, by design.

---

## Performance: honest numbers

Backtested, combined 3-bot system (full available history, after costs):

| Metric | System | SPY (buy & hold) |
|---|---|---|
| Sharpe | **1.25** | ~0.47 |
| CAGR | ~+7.3% | ~+5.7% |
| Max drawdown | **−10%** | −55% |

Through actual historical crashes (backtested):

| Period | System | SPY |
|---|---|---|
| 2008 GFC | **−8%** | −46% |
| 2020 COVID | −3% | −13% |
| 2022 bear | −1% | −18% |
| **Full 2000–2026** | **+1,321%** | +708% |

**The honest caveats:**
- The system's advantage is **avoiding crashes**, which compounds enormously over a full
  cycle (a −55% loss needs +122% just to recover). It does *not* beat a raging bull
  market — in strong bull runs it **lags** (it holds bonds/gold/cash and de-risks), and
  that's by design.
- These are **backtests + paper trading.** Live results will be worse than backtests
  (slippage, the ~15bps mean-rev execution cost, real-world frictions). Realistic live
  expectation: low-to-mid single digits per year with shallow drawdowns.
- On a small account, ~7%/yr is modest in dollars. **Capital and time are the real
  levers**, not a cleverer strategy — the research for new free edges is exhausted.

---

## Infrastructure & deployment

- **VPS:** DigitalOcean, `root@<VPS_IP>`, code at `/opt/nexustrader/quant-bot/`.
- **Python:** the VPS runs everything via `/opt/nexustrader/venv/bin/python3` (has
  pandas/numpy; bare `python3` does not).
- **Bots are cron jobs** (not systemd). Only the dashboard is a service.

### Cron schedule (UTC)
```
21:30 M–F  live_runner.py --live      brain (ETF + crypto trend)
21:35 M–F  meanrev_runner.py --live   mean-reversion
21:40 M–F  lowvol_runner.py --live    low-volatility
21:45 M–F  health_check.py            daily health report
21:47 M–F  sleeve_pnl.py              per-sleeve P&L log + drift
21:50 M–F  sleeve_breaker.py          per-sleeve drawdown breaker
21:55 Fri  slippage_tracker.py 30     weekly execution report
*/20 13-20 M–F  equity_protector.py   account watchdog (market hours)
```

### Local state files (in `quant-bot/`, not the old `signals/` bus)
| File | Written by | Read by | Purpose |
|---|---|---|---|
| `KILL_SWITCH.json` | equity_protector | all runners | halts trading (manual clear) |
| `sleeve_overrides.json` | sleeve_breaker | all runners | per-sleeve budget multipliers |
| `ownership.json` | mean-rev + low-vol | both stock bots | collision guard |
| `protector_state.json` | equity_protector | itself | high-water + last-good equity |
| `sleeve_breaker_state.json` | sleeve_breaker | itself | per-sleeve high-water marks |
| `live_logs/sleeve_pnl.jsonl` | sleeve_pnl | itself | per-sleeve daily history |

### Deploy discipline
Edit locally → syntax-check → `scp` to `/opt/nexustrader/quant-bot/` → dry-run on VPS →
let cron run it live. Commit after every change. The VPS is a plain directory, not a git
checkout (deploy = scp of loose files). The research OS (`quant/research/`) is **local
only** — don't deploy it (needs scipy; production doesn't import it).

---

## The dashboard

A Next.js web app (`dashboard/`) showing live equity, all positions, per-sleeve
breakdown, orders, and activity — pulling directly from Alpaca. It's bound to
`localhost:3000` on the VPS and **not exposed to the internet** (it shows your positions).
View it through an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 root@<VPS_IP>   # leave this terminal open
# then open http://localhost:3000 in your browser
```

Its API is token-gated (`DASHBOARD_TOKEN` / `NEXT_PUBLIC_DASHBOARD_TOKEN`).

---

## Cost

| Item | Cost |
|---|---|
| Alpaca paper trading + data | Free |
| Yahoo daily data | Free |
| DigitalOcean VPS | ~$6/month |
| **Total** | **~$6/month** |

No Claude/LLM cost in the live loop — the reasoning-heavy old pipeline was retired.

---

## Repository layout

```
quant/                     ← THE LIVE SYSTEM
  live_runner.py           brain (ETF + crypto trend + turn-of-month, regime-gated)
  meanrev_runner.py        mean-reversion bot
  lowvol_runner.py         low-volatility bot
  dynamic_budget.py        3-way capital split
  ownership.py             collision-guard ledger
  equity_protector.py      account watchdog + kill switch
  sleeve_breaker.py        per-sleeve drawdown breaker
  health_check.py          daily health report
  sleeve_pnl.py            per-sleeve P&L log + drift check
  slippage_tracker.py      weekly execution-cost report
  turnover_audit.py        churn check
  engine.py                honest backtest engine
  allocator.py             sleeve combination + regime gate
  gatekeeper.py            robustness statistics
  data.py                  Yahoo daily-bar fetcher (cached)
  stock_universe.py        ~150 large caps
  strategies/              trend, crypto_trend, flow, name_meanrev, lowvol, regime
  research/                research OS (LOCAL ONLY) + GRAVEYARD.md
  data_cache/              cached Yahoo bars
  live_logs/               logs + sleeve_pnl.jsonl

dashboard/                 Next.js web UI (localhost:3000)

trading-bot/  swing-bot/  market-lens/  options-flow/  earnings-predictor/
                           ← RETIRED. Kept for reference; do not run.

README.md                  this file
ARCHITECTURE.md            authoritative live-vs-dead map
BUILD_PLAN.md              roadmap / build order
SYSTEM_AUDIT_2026-08-26.md sleeve-by-sleeve audit
quant/research/GRAVEYARD.md every rejected idea
SECURITY.md                security posture
```

---

## What's been rejected (don't re-add)

All tested and documented in `quant/research/GRAVEYARD.md`. Do not re-research these:

- **Leverage** (margin, vol-targeted, or leveraged ETFs) — raises return only by raising
  risk equally; Sharpe stays flat. A risk dial, not an edge.
- **Day-trading / intraday** (ORB, intraday momentum, overnight drift) — loses to costs
  and decay; the original ORB bot's honest PF was 0.83.
- **Shorting** and **defensive rotation** (bonds/gold in downturns) — going to cash beats
  both.
- **Sector rotation, residual momentum, spike/breakout prediction** — redundant or noise.
- **PEAD (post-earnings drift)** — real edge, but 0.60-correlated to low-vol; benched as a
  backup, not additive.
- **New free-data edges generally** — multiple sweeps confirm the well is dry.

The conclusion is settled: **more money comes from capital + time + not blowing up**, not
from a new strategy.

---

## Operating the system

**Day to day:** nothing. It runs on cron and reports to Discord. Watch the daily health
report and the weekly slippage report.

**Check performance:** SSH-tunnel to the dashboard, or read `sleeve_pnl.jsonl`.

**If the kill switch trips:** don't just clear it. Read `KILL_SWITCH.json` for the reason,
check `equity_protector.py` logs, confirm it was a real drawdown (not a data glitch — the
sanity gate should prevent those), fix the cause, reset `protector_state.json` if needed,
then remove `KILL_SWITCH.json`.

**Before changing any strategy:** run it through `quant/research/` and beat the current
version on the honest backtester first. Check `GRAVEYARD.md`. Never tune live on intuition.

**The next real step is not code — it's capital.** Let the system run through a full
market cycle (including a downturn, where its design pays off) and fund it with real money
as it proves the crash-protection thesis live.
