# NexusTrader Build Plan — Prioritized, Step by Step

**Created:** 2026-06-18. The single ordered to-do list. We execute top to bottom.
**Goal:** make money via an ENSEMBLE of small, uncorrelated, daily/weekly edges — each
proven on the honest backtester (PF > 1.2 / Sharpe > 1 after 0.10% costs) BEFORE it gets
real money or significant build time.

**Governing rules (from research):**
- Build a PORTFOLIO of edges, never one killer strategy.
- Every strategy: weekly/daily rebalance (NOT minute), vol-targeted, economic rationale.
- Nothing graduates to live money until it clears the honest backtester.
- Realistic target = portfolio Sharpe ~1 after costs. Not more.

---

## PHASE 0 — STOP THE BLEEDING / SET THE STAGE  ← DO FIRST
Quick, low-risk housekeeping so we build clean.

- [ ] **0.1 Decommission the live ORB bot** (proven PF 0.83 loser). Stop the systemd service
      so it's not trading/logging noise. Keep code + backtester. Dashboard can stay up.
- [ ] **0.2 Build a reusable daily-bar backtest harness.** The current backtester is ORB/
      minute-specific. We need one clean harness that: pulls daily bars (stocks + crypto),
      runs ANY strategy's signals, applies the 0.10% cost honestly, and reports
      PF / Sharpe / max DD / trade count / equity curve. This is the gatekeeper for everything.
- [x] **0.3 DONE — data availability verified.** Alpaca daily history TOO SHORT (ETFs 2016+, crypto 2021+ = ~1 bull regime, would mirror the ORB mirage). SOLUTION: backtest/validate on **Yahoo Finance** (free, daily, SPY→1993/33yr, most ETFs 20-26yr incl. 2008 GFC; BTC 11.8yr). Trade LIVE on Alpaca. Data source ≠ execution source. (See STRATEGY_SPEC + memory.)

## PHASE 1 — STRATEGY #1: MULTI-ASSET TREND-FOLLOWING  ← HIGHEST CONVICTION
The most documented edge in finance + crisis-alpha. Weekly rebalance on liquid ETFs.

- [ ] **1.1 Spec the rules:** universe (SPY, QQQ, IWM, TLT, GLD, + a few sectors, BTC, ETH);
      signal = 12-month time-series momentum (sign of trailing return) AND/OR price > 200-day SMA;
      long if up-trend, cash/short-liquid-ETF if down; weekly rebalance; vol-scaled sizing.
- [ ] **1.2 Backtest honestly** over max available history (5+ yrs ideal). Must clear PF>1.2/Sharpe>1.
- [ ] **1.3 Robustness check:** vary lookback (6/9/12mo), vary rebalance (weekly/monthly) —
      edge must survive parameter changes, not just one magic setting.
- [ ] **1.4 GO/NO-GO.** If it clears → build the live module (paper first). If not → drop it, next.

## PHASE 2 — THE OVERLAY: VOLATILITY TARGETING
Not standalone — a multiplier that improves Sharpe of whatever we run. Build once, reuse.

- [ ] **2.1 Build a vol-targeting sizing module** (scale position inversely to recent realized vol,
      target ~10-15% annualized). Plug into Strategy #1.
- [ ] **2.2 Re-backtest #1 with vol-targeting on.** Confirm Sharpe improves.

## PHASE 3 — STRATEGY #2: CRYPTO LONG-ONLY TREND
Fits our exact long-only spot constraint; younger/less-efficient market.

- [ ] **3.1 Spec:** BTC/ETH + a few liquid Alpaca coins; time-series trend (price vs 20/50-day MA
      or sign of 30-day return); long in uptrend, cash (stablecoin) in downtrend; weekly; vol-targeted.
- [ ] **3.2 Backtest honestly** (watch crypto survivorship bias hard). Must clear the bar.
- [ ] **3.3 GO/NO-GO.** Check it's UNCORRELATED to #1 (that's the whole point of the ensemble).

## PHASE 4 — CHEAP DIVERSIFIERS (only if #1/#3 working)
Low individual edge, near-zero cost, good ensemble fillers.

- [ ] **4.1 Calendar effects** (turn-of-month, FOMC drift) on SPY. Backtest.
- [ ] **4.2 Low-volatility tilt** (long lowest-vol names, monthly). Backtest.
- [ ] Add only the ones that clear the bar AND are uncorrelated to existing sleeves.

## PHASE 5 — ASSEMBLE THE PORTFOLIO
The actual edge: combining uncorrelated sleeves.

- [ ] **5.1 Build a portfolio layer** that allocates capital across the proven sleeves,
      each vol-targeted, correlation-aware (cap correlated exposure).
- [ ] **5.2 Backtest the COMBINED portfolio.** Portfolio Sharpe should beat any single sleeve.
- [ ] **5.3 Paper-trade the portfolio** for a meaningful window before any real money.

## PHASE 6 — AUTOMATION / SUPERVISOR (the original vision, built LAST)
Only meaningful once there are proven sleeves to supervise.

- [ ] Monitor live-vs-backtest per sleeve, alert on decay, throttle/allocate. Hands-off operation.

---

## RANK SUMMARY (what we do, in order)
1. Phase 0 — decommission ORB, build daily backtest harness  ← **START HERE**
2. Phase 1 — multi-asset trend-following (highest-conviction edge)
3. Phase 2 — vol-targeting overlay
4. Phase 3 — crypto long-only trend (uncorrelated sleeve #2)
5. Phase 4 — calendar + low-vol diversifiers
6. Phase 5 — combine into a portfolio
7. Phase 6 — supervisor/automation last

## NOT DOING (decided, don't revisit)
Minute-bar strategies · overnight drift · short-term reversal · RSI2-on-names ·
crypto cross-sectional momentum · single-strategy hunting · AI-predicts-direction ·
adding real money to anything before it clears the honest backtester.

See QUANT_RESEARCH_FINDINGS.md for the evidence behind each choice.
