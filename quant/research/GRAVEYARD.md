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

## Leverage overlay (margin or vol-targeted, on the blend)
- **Status:** REJECTED (financing-bound)
- **Date:** 2026-07-06
- **What:** Lever the proven blend 1.25-2x (static or vol-targeted, cap 2x) to convert
  its Sharpe ~1.25 into higher CAGR, paying honest retail margin (IRX + 2.5%).
- **Why rejected:** CAGR is FLAT (+7.3%) at every leverage level while MaxDD explodes
  -11% → -67% at 2x. The blend's return premium over the borrow rate is ~zero — its
  high Sharpe is a low-vol Sharpe, not a high-return one. Vol-targeting was even worse
  (levers up when the premium is thinnest). Leveraged ETFs (cheaper financing) net
  ~+1.4%/yr for ~-40% DD paths — not taken. **Capital, not leverage, is the lever.**
- **Re-test 2026-08-26 (trend-gated leveraged ETF):** After research suggested a
  200-day-trend-gated 2x-SSO sleeve could beat SPY, tested it: CAGR rises nicely
  (+8.2% → +14.1%) BUT Sharpe is FLAT (0.72 → 0.68) and drawdown climbs back to
  −40 to −52% (the trend filter's whole benefit was the −29% DD). Confirms: leverage
  even in its smartest (trend-gated) form is a pure RISK dial, not an edge — Sharpe
  doesn't budge. Same verdict, now closed for the ETF form too.
- **Evidence:** `quant/research/experiments/2026_003_leverage_overlay/` (findings.md).

## PEAD as a 4th sleeve (Post-Earnings Announcement Drift)
- **Status:** BENCHED (real edge, redundant slot) — NOT a dead idea
- **Date:** 2026-07-06
- **What:** Long stocks that beat earnings + got a positive reaction day; hold ~20d.
- **Why benched:** The "needs paid data" block was WRONG — yfinance `get_earnings_dates()`
  gives ~24yr of dates + surprise free. Validated standalone: **PAPER_TRADE** (Sharpe 0.70,
  9/9 eras, no decay — recent half is STRONGER). But it correlates **0.601 to low-vol** and
  every blend including both is worse than the planned 60/25/15-lowvol system. Same slot,
  weaker occupant. **If low-vol fails live, deploy PEAD in its place — it's ready.**
- **Evidence:** `quant/research/experiments/2026_002_pead_drift/` (report, blend test,
  cached earnings data, runnable strategy).

---

## STILL OPEN (real edges, blocked on data — NOT rejected)

These passed research interest but need paid data to validate properly. Don't re-research
from scratch — pick up here when data is available.
- **Gamma/dealer-hedging, analyst revisions, order flow** — real institutional edges, all need
  paid data we don't have. Documented, untested.
