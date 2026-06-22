# NexusTrader Build Plan — Prioritized, Step by Step

> ## ⚡ CURRENT STATE (updated 2026-06-21)
> **Phases 0-5 + live paper deployment are DONE.** The validated 3-sleeve quant bot
> (ETF-trend + crypto-trend + turn-of-month) is LIVE ON PAPER and AUTONOMOUS:
> - Runs daily at 5:30 PM ET via cron at `/opt/nexustrader/quant-bot/` (isolated).
> - First 8 ETF orders placed 2026-06-21, filling Monday open. Discord wired up.
> - Backtest: Sharpe 0.82, ~+7%/yr, MaxDD -23%, holds days-to-weeks, trades near-daily.
> - Old bots (ORB/swing) disabled; full isolation confirmed.
>
> **→ NEXT: let it paper-trade ~2-4 weeks, THEN do PHASE 7 (improvements) below.**
> Do NOT add real money or new sleeves until live paper results track the backtest.

---

# PHASE 7 — IMPROVE THE LIVE BOT (after ~2-4 weeks of paper trading)

**Prerequisite: confirm the bot works live first.** Watch Discord + dashboard for a few
weeks. Does live behavior match the backtest (right positions, sensible rebalances,
no errors)? Only proceed to improvements once the bot is proven stable in live execution.
Improving an unproven-live bot is premature — prove it, then enhance.

### 7.0 — Paper-trade watch (DO THIS FIRST, ~2-4 weeks)
- [ ] Confirm Monday fills executed correctly (orphans sold, 8 ETFs bought).
- [ ] Watch daily Discord summaries — positions sensible? rebalances reasonable?
- [ ] Compare live equity curve vs backtest expectation (rough tracking, not exact).
- [ ] Watch for execution bugs: failed orders, weird sizing, crypto symbol issues.
- [ ] **GO/NO-GO:** if it behaves as designed → proceed to improvements. If buggy → fix first.

### 7.1 — ✅ DONE (2026-06-22) — VIX regime brain wired in
Validated and deployed. Results: Sharpe 0.71→0.82 (+0.12), MaxDD -26.8%→-16.9% (-10pp),
CAGR cost only -0.14%/yr. Bot goes fully to cash in risk-off (VIX/VIX3M ratio ≥ 1.0).
Regime is RISK-ON 78% of days historically; correctly signaled RISK-OFF during 2008/2009.
VIX/VIX3M fetched fresh daily before each run. Discord shows regime status on every update.

### 7.2 — Add more uncorrelated sleeves (IN PROGRESS)
PM + research say 4-5 uncorrelated sleeves is the sweet spot; we have 3 (and two of them,
ETF-trend & crypto-trend, correlate 0.58 — so we really have ~2 distinct bets). Need MORE
DIFFERENT edges, especially ones that win when trend LOSES.

**Round 1 (2026-06-22) — ETF-universe hunt: DRY HOLE (correct result).** Built `hunt_sleeves.py`
(tests standalone edge + correlation + portfolio-impact in one pass). Tested bond_trend,
commodity_trend, gold_trend, bondgold_trend, xsec_momentum, flight_to_safety, defensive_rotation,
risk_parity_lite. FINDING: nothing in our 12-ticker ETF/crypto universe is an *accretive*
diversifier. The only candidate that improved Sharpe (bondgold_trend) did so purely by cutting
vol — it costs ~1%/yr CAGR at every cap size, no free lunch. NOT added (user goal = make money,
not smooth). **Lesson: a real return-adding 4th sleeve needs a DIFFERENT return source than
these 12 tickers** — single-name equities, carry, or sector granularity.

**Round 2 (next) — single-name mean-reversion.** Pull ~200 liquid stocks (Yahoo, free) and test
short-term reversion (oversold-in-uptrend, hold 2-10 days). Reversion is mechanically uncorrelated
to trend; fits the ≤2-week hold goal. Killed on ETFs but may live on individual names.
- [ ] Each must clear: positive across eras, survives 2x slippage, corr<0.35 to existing sleeves,
      AND must IMPROVE the portfolio (raise CAGR or Sharpe meaningfully), not just smooth it.

### 7.3 — Test market-lens-style sentiment AS A CANDIDATE SLEEVE (only if curious)
The old AI news pipeline (market-lens) was the sole feeder of the LOSING swing bot and was
NEVER validated. Do NOT bolt it on untested — that's the exact mistake that sank the old bots.
- [ ] IF tested: treat "Claude says bullish on X" as a signal, backtest whether it actually
      predicts X's return after costs, out-of-sample. Passes gatekeeper → use it. Fails → drop it.
- [ ] Lower priority than 7.1/7.2 (sentiment edges are weak/expensive/decay fast).

### 7.4 — Decay monitoring + per-sleeve drawdown rules (the pod model)
The institutional loop the PM described: monitor live-vs-backtest, cut losers automatically.
- [ ] Log each sleeve's live performance; compare rolling live Sharpe vs backtest baseline.
- [ ] Per-sleeve auto drawdown rule (e.g. sleeve down X% → halve its size; Y% → off).
- [ ] Retire any sleeve whose live edge crosses zero (decay detection).

### 7.5 — Only AFTER paper proves out: real money, small
- [ ] If live paper tracks backtest over a meaningful window → fund with SMALL real money.
- [ ] Same config, drawdown rules armed. Scale up only as it proves itself.
- [ ] Remember: returns are a %, so real money matters more than a "better" bot — an ~7%/yr
      edge on a bigger account is how the dollars actually grow.

### Improvement priority order
**7.0 (watch) → 7.1 (regime brain) → 7.2 (more sleeves) → 7.4 (decay/risk rules) → 7.5 (real $).**
7.3 (sentiment) is optional/low-priority. Each change re-validated through the gatekeeper.

---

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

## PHASE 0 — ✅ DONE (decommission ORB, build honest backtest harness)
Quick, low-risk housekeeping so we build clean.

- [ ] **0.1 Decommission the live ORB bot** (proven PF 0.83 loser). Stop the systemd service
      so it's not trading/logging noise. Keep code + backtester. Dashboard can stay up.
- [ ] **0.2 Build a reusable daily-bar backtest harness.** The current backtester is ORB/
      minute-specific. We need one clean harness that: pulls daily bars (stocks + crypto),
      runs ANY strategy's signals, applies the 0.10% cost honestly, and reports
      PF / Sharpe / max DD / trade count / equity curve. This is the gatekeeper for everything.
- [x] **0.3 DONE — data availability verified.** Alpaca daily history TOO SHORT (ETFs 2016+, crypto 2021+ = ~1 bull regime, would mirror the ORB mirage). SOLUTION: backtest/validate on **Yahoo Finance** (free, daily, SPY→1993/33yr, most ETFs 20-26yr incl. 2008 GFC; BTC 11.8yr). Trade LIVE on Alpaca. Data source ≠ execution source. (See STRATEGY_SPEC + memory.)

## PHASE 1 — ✅ DONE (trend-following: PASSED, Sharpe 0.73)
The most documented edge in finance + crisis-alpha. Weekly rebalance on liquid ETFs.

- [ ] **1.1 Spec the rules:** universe (SPY, QQQ, IWM, TLT, GLD, + a few sectors, BTC, ETH);
      signal = 12-month time-series momentum (sign of trailing return) AND/OR price > 200-day SMA;
      long if up-trend, cash/short-liquid-ETF if down; weekly rebalance; vol-scaled sizing.
- [ ] **1.2 Backtest honestly** over max available history (5+ yrs ideal). Must clear PF>1.2/Sharpe>1.
- [ ] **1.3 Robustness check:** vary lookback (6/9/12mo), vary rebalance (weekly/monthly) —
      edge must survive parameter changes, not just one magic setting.
- [ ] **1.4 GO/NO-GO.** If it clears → build the live module (paper first). If not → drop it, next.

## PHASE 2 — ✅ DONE (vol-targeting built into sleeves)
Not standalone — a multiplier that improves Sharpe of whatever we run. Build once, reuse.

- [ ] **2.1 Build a vol-targeting sizing module** (scale position inversely to recent realized vol,
      target ~10-15% annualized). Plug into Strategy #1.
- [ ] **2.2 Re-backtest #1 with vol-targeting on.** Confirm Sharpe improves.

## PHASE 3 — ✅ DONE (crypto trend: PASSED, Sharpe 1.03)
Fits our exact long-only spot constraint; younger/less-efficient market.

- [ ] **3.1 Spec:** BTC/ETH + a few liquid Alpaca coins; time-series trend (price vs 20/50-day MA
      or sign of 30-day return); long in uptrend, cash (stablecoin) in downtrend; weekly; vol-targeted.
- [ ] **3.2 Backtest honestly** (watch crypto survivorship bias hard). Must clear the bar.
- [ ] **3.3 GO/NO-GO.** Check it's UNCORRELATED to #1 (that's the whole point of the ensemble).

## PHASE 4 — ✅ PARTIAL (turn-of-month kept; FOMC/defensive killed)
Low individual edge, near-zero cost, good ensemble fillers.

- [ ] **4.1 Calendar effects** (turn-of-month, FOMC drift) on SPY. Backtest.
- [ ] **4.2 Low-volatility tilt** (long lowest-vol names, monthly). Backtest.
- [ ] Add only the ones that clear the bar AND are uncorrelated to existing sleeves.

## PHASE 5 — ✅ DONE (allocator brain: combined Sharpe 0.82-0.87, LIVE on paper)
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
