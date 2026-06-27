# Strategy Graveyard

Permanently documented REJECTED strategies. **Check here before testing anything new** —
if it's in this list, we already tested it and it failed. Re-testing is wasted time.

To add an entry, run `python graveyard.py add` or append below following the format.

---

## Sector Rotation
- **Status:** REJECTED
- **Date:** 2026-06-27
- **What:** Own the strongest 2-3 of 11 sector ETFs, rotate monthly.
- **Why rejected:** Sharpe 0.56 standalone but correlated **0.49 to brain / 0.55 to mean-rev** —
  it's trend-following in a different wrapper. No diversification benefit.
- **Evidence:** `quant/hunt_free_edges.py`

## Residual Momentum (cross-sectional, beta-stripped)
- **Status:** REJECTED
- **Date:** 2026-06-27
- **What:** Own top-decile 6-month momentum stocks after removing market beta.
- **Why rejected:** Great return (Sharpe 0.75, +14%/yr) BUT -64% max drawdown (momentum crash)
  AND correlated **0.44 brain / 0.46 mean-rev**. Risky + redundant.
- **Evidence:** `quant/hunt_free_edges.py`

## Shorting the market (both-ways trend / inverse ETF)
- **Status:** REJECTED
- **Date:** 2026-06-26
- **What:** Go short (or buy inverse ETF) when the market is in a downtrend.
- **Why rejected:** LOSES — **-14% annualized in down markets** (killed by V-bounces). Sharpe
  collapses 0.72→0.30. Going to CASH (what the brain already does) beats shorting outright.
- **Evidence:** `quant/validate_shorts.py`

## Defensive rotation (bonds/gold in downtrends)
- **Status:** REJECTED (as a brain addition)
- **Date:** 2026-06-26
- **What:** Rotate into TLT/GLD when equities downtrend, to profit from flight-to-safety.
- **Why rejected:** Profits +4% in down markets standalone, BUT added to the REAL combined brain
  it HURTS: Sharpe 0.93→0.91, CAGR -1%/yr for a 0.5% drawdown gain. The brain already holds
  TLT/IEF/GLD/DBC/UUP + regime-to-cash, so more is redundant + dilutive.
- **Evidence:** `quant/validate_shorts.py`

## Spike prediction / momentum-ignition (volume+price surge)
- **Status:** REJECTED
- **Date:** 2026-06-24
- **What:** Predict which stock will pop in the next few days from volume/momentum surges.
- **Why rejected:** The "warning sign" precedes a pop only **1.7%** of the time — 98.3% of
  identical setups don't pop (the survivorship trap). Volume-surge follow-through barely beats
  random (48% win, negative median). Not predictable.
- **Evidence:** `quant/spike_research.py`

## 52-week high breakout
- **Status:** REJECTED (too weak)
- **Date:** 2026-06-24
- **What:** Buy new 52-week highs on volume, expecting continuation.
- **Why rejected:** +0.96% over 20d / 54% win — barely beats random, not enough to survive
  real costs on volatile names.
- **Evidence:** `quant/spike_research.py`

## ORB / intraday discretionary (the original bot)
- **Status:** RETIRED (proven loser)
- **Date:** pre-pivot
- **What:** Opening-range breakout + intraday technical patterns on minute bars.
- **Why rejected:** Honest backtest PF 0.83 after costs (looked like 1.43 with the optimistic
  backtester). Intraday minute-bar discretionary trading = highest noise, highest cost, no edge.
  This is the whole reason the project pivoted to daily-bar systematic strategies.

## Swing bot (market-lens / AI-news driven)
- **Status:** RETIRED (proven loser)
- **Date:** pre-pivot
- **What:** Multi-day positions from Claude-scored news/sentiment signals.
- **Why rejected:** 14-28% win rate, the sole consumer of the unvalidated market-lens pipeline.
  Sentiment/news as a primary BUY trigger never validated. Sole net loser of the old system.

---

## STILL OPEN (real edges, blocked on data — NOT rejected)

These passed research interest but need paid data to validate properly. Don't re-research
from scratch — pick up here when data is available.

- **Post-Earnings Announcement Drift (PEAD)** — gap-proxy test showed +3.8% over 20d (stronger
  on volatile names). Real edge, ~70-75% likely still alive. **Needs:** real earnings calendar
  (~$22-30/mo, e.g. Financial Modeling Prep) + delisted-inclusive prices to kill survivorship
  bias (Polygon ~$30/mo). Evidence: `quant/spike_research.py`, `quant/validate_drift.py`.
- **Gamma/dealer-hedging, analyst revisions, order flow** — real institutional edges, all need
  paid data we don't have. Documented, untested.
