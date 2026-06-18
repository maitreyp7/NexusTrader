# Quant Research Findings — Daily-Bar Strategies for a Solo Dev (Alpaca)

**Compiled:** 2026-06-17 from 3 parallel deep-research dives (momentum/trend, mean-reversion/anomalies, what-retail-actually-profits-from). Constraints applied throughout: Alpaca, daily bars, ~0.10% round-trip cost, US stocks long+short, crypto spot LONG-ONLY, solo dev, no HFT.

---

## THE ONE BIG INSIGHT (all 3 dives agreed independently)
**Stop hunting one killer strategy. Build a PORTFOLIO of 3-5 small, uncorrelated, economically-grounded daily/weekly edges, each vol-targeted and sized small.** This is the only part of the quant-firm playbook a solo dev can actually copy. Five strategies at Sharpe ~0.5 that are genuinely uncorrelated combine to a portfolio Sharpe well above any single one. Running ONE strategy (what we did with ORB/swing) is the wrong *method*, not just the wrong strategy.

## HONEST BASE RATES (tattoo these on the wall)
- Realistic target = **Sharpe ~1 after costs**, from an ensemble. NOT Sharpe 2. Anyone promising more is selling something.
- In-sample backtest Sharpe has **correlation often <0.05 with live results.** Backtest Sharpe barely predicts anything. The honest backtester is necessary but not sufficient.
- Ignoring costs inflates apparent profit by ~30% and turns marginal winners into consistent losers — exactly what killed ORB.
- Need **~2 years of daily data / hundreds of trades** before a Sharpe estimate means anything.
- What separates winners: multiple uncorrelated edges + paranoia about overfitting + vol-sizing + economic rationale (someone structurally forced to take the other side).

## WHAT'S OFF-LIMITS (don't ever chase on Alpaca)
HFT, market-making, latency/order-flow arb, alt-data-at-scale, leverage/prime-broker stat-arb books, "AI predicts direction" black boxes on daily bars (overfitting death). The quant-firm moat is infrastructure + execution, not the ideas. The ideas (trend, factors, mean-reversion, vol-targeting) are public and survive scaled-down.

---

## RANKED CANDIDATES (best fit for daily bars + our constraints)

### TIER 1 — build these
1. **Multi-asset Time-Series Momentum / Trend-Following** (ETFs: SPY/TLT/GLD/sector/BTC, **WEEKLY or MONTHLY rebalance**, signals from daily bars). THE most robustly documented edge in existence (positive every decade since 1880; 67/67 futures markets; crisis-alpha in 8 of 10 worst periods). CRITICAL: momentum is strong monthly, decent weekly, WEAK daily — do NOT run it daily-turnover. Can short liquid ETFs on Alpaca. Expect modest Sharpe (~0.4-0.6) + real crash protection.
2. **Volatility Targeting** — an OVERLAY/multiplier on every other strategy, not standalone. Scale position size inversely to recent realized vol. Documented to improve Sharpe of almost everything. Lowest-effort, highest-ROI add. Mandatory for crypto.
3. **Crypto long-only momentum (time-series preferred; cross-sectional weekly top 3-5)** — best fit for our long-only spot constraint; younger/less-efficient market = more edge alive. Rank by 7d/30d return, hold winners, weekly rebalance, vol-target (mandatory — crypto vol is brutal). NOTE: dive #1 says crypto TIME-SERIES >> cross-sectional (XS lives in illiquid microcaps + short leg = dead after costs). Favor time-series trend on BTC/ETH + a few liquid coins.
4. **Dual Momentum / GEM** (Antonacci) — SPY vs ex-US vs bonds, 12-month lookback, monthly, long-only, ~1-4 trades/yr. Costs negligible. FRAGILE to single-parameter choice → ENSEMBLE lookbacks (avg of 6/9/12mo). Expect S&P-like returns, smaller drawdowns.
5. **200-day trend filter** — not standalone; the gate that turns crash-prone momentum into usable. Apply to every long-only momentum book (in when above 200MA, cash when below).

### TIER 1.5 — cheap diversifiers (low edge but low cost, good ensemble fillers)
6. **Calendar/seasonality**: turn-of-month, FOMC drift, sell-in-May. Durable (structural/behavioral, not arbitraged), long-only, near-zero cost & data. Combined SIM+TOM+FOMC+momentum walk-forward: ~9.6% ann / Sharpe 0.77 since 1975.
7. **Low-volatility tilt** — long lowest-vol decile, monthly rebalance. Replicated globally, long-only by design, price data only, very low turnover.

### TIER 2 — real but friction/effort
8. **PEAD (post-earnings drift)** — long positive-surprise, hold weeks. Low turnover, cost-insensitive. BLOCKER: needs clean earnings-surprise data (Alpaca doesn't give it; need Financial Modeling Prep/Finnhub, or use announcement-day reaction as proxy). Large-cap long-only edge is modest.
9. **Equity/ETF pairs (cointegration)** — can short equities on Alpaca so it works (crypto pairs CANNOT — long-only). High engineering + breakdown monitoring. ETF pairs (SPY/TLT, sectors) > data-mined stock pairs.

### ❌ DO NOT PURSUE (look great in backtest, bleed live)
- **Overnight drift (buy close/sell open)** — the edge needs the OPEN as a fillable price; it isn't. OHLC backtest is a lie; collapses ~30%→~8% at realistic 9:31 fill, then spread eats the rest.
- **Cross-sectional short-term reversal** — classic cost-death; profits live in illiquid microcaps + the short leg.
- **RSI(2)/Connors on single names** — measurably DECAYED (2024-26 SPY backtests ~30% WR, losing). Only maybe as a tiny filtered ETF overlay.
- **Crypto cross-sectional momentum** — edge in illiquid microcaps + short leg, inaccessible on Alpaca spot.
- **Equity cross-sectional 12-1 long/short** — decayed, crash-prone, short leg dead after costs. Just buy MTUM if you want the tilt.
- **VIX short-vol** — "pennies in front of a steamroller" (Feb 2018 wiped out XIV). Tiny sleeve only, strict sizing.

---

## RECOMMENDED BUILD ORDER (if pursuing)
1. **Vol-targeting overlay** — cheapest Sharpe gain, bolt onto everything.
2. **Multi-asset ETF trend-following, weekly rebalance** — highest-conviction documented edge + crisis-alpha diversifier to an equity-long book.
3. **Crypto long-only trend (BTC/ETH + few liquid coins), weekly, vol-targeted** — fits our exact constraint, less-efficient market.
4. **Calendar + low-vol** as cheap ensemble diversifiers.
5. Combine as a portfolio; let portfolio-manager collect clean cross-strategy outcome data.
**HARD RULE: each candidate must pass the honest backtester (PF>1.2 / Sharpe>1 after 0.10% costs over hundreds of trades) BEFORE it gets real money or significant dev time.**

## KEY SOURCES
TSMOM: Moskowitz-Ooi-Pedersen 2012 (SSRN 2089463). AlphaArchitect TSMOM evidence. Vol targeting: Hood & Raughtigan (SSRN 4773781), Man Group. GEM: Antonacci; fragility — Newfound/thinknewfound, SVRN. Mean-reversion/anomalies: Quantpedia (TOM, FOMC, short-term reversal, overnight-drift-GDX warning), Ernie Chan. Retail base rates: QuantStart (Sharpe), Robot Wealth (ensemble thesis, strategy index). Low-vol: Frazzini-Pedersen BAB.
