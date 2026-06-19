# Quant Edge Playbook — Synthesized from a Hedge Fund PM + Deep Research

**Compiled 2026-06-19.** A real hedge fund PM gave direct advice; three deep research dives
(volatility-regime trading, how quant firms operate, less-arbitraged academic signals) confirmed
and extended it. This is the strategic core of the project from here.

---

## THE PM's GIFT (verbatim takeaways)
1. **Nothing good is public.** Stop hunting copyable bots. The edge is TRANSLATING academic findings into thresholds — that's the skill.
2. **White papers describe a DISTRIBUTION, not a trade.** "XYZ predicts higher returns over horizon T" = a statistical edge over time; day-to-day you get smoked/hit stops. Turning the phenomenon into buy/sell/exit rules is the job.
3. **Signals DECAY as market relationships shift** (his oil-polarity example: rising oil = good at low-price/demand regimes, bad at high-price/inflation regimes; same input, opposite meaning). Static models die.
4. **What the best actually do:** (a) update models w/ ML as data arrives, (b) MONITOR live performance vs backtested expectation = decay detection, (c) DIVERSIFY across many signals, allocate $ to winners, cut losers.
5. **★ THE SPECIAL SAUCE ★:** the best signals DON'T predict price/direction. They predict the **VOLATILITY ENVIRONMENT** — benign vs volatile, when upside vol > downside vol. **"Way easier to trade the second derivative of markets than the first."**

This is confirmed by us empirically: the video's price-prediction mean-reversion DECAYED (dead since 2014); trend-following (a vol/regime-aware, diversified, low-turnover approach) PASSED.

---

## WHY VOL-REGIME > PRICE PREDICTION (the core pivot)
Returns are ~random walk (barely forecastable). **Volatility is highly forecastable** — it clusters and persists (slow-decaying autocorrelation over months). Predicting the *second moment* (variance/regime) is structurally easier than the *first moment* (direction). This is the single most important strategic reorientation in the project.

---

## HIGHEST-VALUE BUILDABLE SIGNALS (free daily data + free VIX/FRED, no options/HFT)

### TIER 1 — build & backtest first (durable, low-turnover, survive 0.10% cost)
1. **VIX/VIX3M term-structure ratio** = the master risk-on/off switch. <1 contango (calm), >1 backwardation (stress). Preceded 21/22 S&P drawdowns >5%. One division, free CBOE data. ★ best evidence-to-effort.
2. **Variance Risk Premium (VRP)** = VIX² − trailing realized variance (or simply VIX − 20d realized vol). High VRP predicts HIGH forward equity returns (Bollerslev-Tauchen-Zhou 2009). Use as a state filter: long when VRP elevated, cash when negative/bottom-quartile. Free.
3. **HY credit-spread regime gate** (FRED `BAMLH0A0HYM2`). Credit leads equities. Widening spreads → risk-off; tightening → risk-on. Low-turnover filter, structurally durable (info-diffusion + flow). Free.
4. **Regime-conditional strategy allocation** — use a vol-regime classifier to decide WHICH sleeve trades + size inverse to realized vol (Moreira-Muir vol-targeting). HIGHEST VALUE for us: trend works in high-vol/trending regimes, mean-reversion in low-vol/ranging. Match strategy to regime.

### TIER 1.5 — flow/calendar signals (structural, hard to arbitrage)
5. **FOMC cycle** — equity premium concentrates in EVEN weeks of FOMC-cycle time + the 24h pre-announcement drift (Cieslak-Morse-Vissing-Jorgensen 2019, persisted through 2024). ~8-16 trades/yr. Stronger when VIX high → combine with #1/#2.
6. **Turn-of-month** — most index return falls in last-trading-day → +3 days (pension flows). ~12 trades/yr. Robustness-check the exact days (they drift).

### TIER 2 — vol-forecasting machinery (feeds the above)
7. **HAR realized-vol forecast** (Corsi 2009): OLS on 1/5/22-day realized vol (+VIX, +downside semivariance). Best simplicity:accuracy. Forecasts next-period vol from daily bars.
8. **Realized SEMIvariance** (Patton-Sheppard 2015, "Good Vol/Bad Vol"): future vol driven almost entirely by DOWNSIDE semivariance; positive vol has ~zero predictive power. Downside-share ratio = regime deterioration feature.
9. **Crypto vol-scaled time-series momentum** — BTC/ETH long when 30-90d return>0, size ∝ target_vol/realized_vol (cap 1.0, spot long-only). Separate sleeve; verify Alpaca crypto fills beat 0.10%.

### ❌ OFF-LIMITS / DO NOT TRADE
Selling vol/straddles (needs options + Volmageddon tail risk — XIV lost >90% in a day Feb 2018), VIX-futures roll, GEX/gamma flow (options/futures). Overnight drift (can't capture on daily bars, decayed post-2012, negative after costs). Copper/gold-yield link (BROKE post-2022 — live proof of decay). Naive price-direction prediction.

---

## HOW QUANT FIRMS ACTUALLY OPERATE (replicable mechanics, not secret sauce)
- **Alpha decay is real & measurable:** McLean-Pontiff — published anomalies' returns drop 26% out-of-sample, 58% post-publication; Sharpe ~halves after publication. Faster signals decay faster (HFT in hrs, equity factors ~12mo). → DEFLATE every backtest; assume the public edge is half.
- **The pod model (Millennium/Citadel) = the copyable structure:** each strategy is a "pod" with its own capital sleeve + HARD automatic drawdown rules (Millennium: −5% → cut size 50%; −7.5% → shut it off; NO discretion). Capital reallocated DAILY toward winners, away from losers (fixed risk budget, zero-sum). → Build per-strategy auto drawdown sizing/cutting, not one global kill switch.
- **Weak-alpha combination (WorldQuant "101 Alphas"):** many individually-weak signals at LOW mutual correlation (avg 15.9%) aggregate into a strong "mega-alpha." Low MUTUAL correlation is the edge, not standalone Sharpe.
- **Meta-labeling (de Prado):** a 2nd ML model predicts WHETHER to trust/size the primary signal (not direction). Sizes & filters bets.
- **Risk management IS the edge** (strongest consensus): position sizing ~as important as signal quality. Fractional Kelly (never full), vol-targeting, risk parity across sleeves, per-strategy drawdown stops.
- **Renaissance (known via Zuckerman):** thousands of tiny short-hold both-direction positions, painstakingly clean data, Kelly-style sizing, ~12.5x leverage. The STRUCTURE (many tiny edges + disciplined sizing + diversification) is the lesson; the signals are unknowable.
- **Process:** reserve 20-30% as untouched holdout; walk-forward not single OOS; favor boring stable-PF strategies over flashy high-Sharpe (>90% of academic strategies fail live); count every variant tried (multiple-testing tax).

---

## THE OPERATING LOOP TO BUILD (solo-adapted institutional process)
1. Run several LOW-MUTUAL-CORRELATION sleeves as separate capital "pods."
2. Log live performance per sleeve; compare rolling live Sharpe/PF vs backtest baseline (30/90/all). Persistent live-below-backtest = decay, not bad luck.
3. Pre-commit HARD automatic per-sleeve drawdown rules (−X% → halve, −Y% → off).
4. Reallocate fixed risk budget toward winners, away from losers.
5. Vol-target + fractional-Kelly size within each sleeve.
6. Gate sleeves by VOL REGIME (the VIX/VIX3M + realized-vol classifier).
7. Walk-forward retrain triggered by detected regime shift; permanent holdout; deflated-Sharpe honesty.

**This loop — not any single strategy — is "the thing no one has made" that's actually achievable.** A solo-run, vol-regime-gated, decay-monitored, auto-allocating multi-sleeve system. Each piece is proven; the integration is the project.

---

## KEY SOURCES
Vol regime: Bollerslev-Tauchen-Zhou 2009 (VRP); Patton-Sheppard 2015 (good/bad vol); Moreira-Muir 2017 (vol-managed); CBOE VIX/VIX3M; Corsi 2009 (HAR). Firms: McLean-Pontiff (decay); Kakushadze-Tulchinsky "101 Formulaic Alphas"; Bailey-de Prado (Deflated Sharpe, meta-labeling, "10 Reasons ML Funds Fail"); Zuckerman "The Man Who Solved the Market"; Millennium/Citadel pod docs. Signals: Cieslak-Morse-Vissing-Jorgensen 2019 (FOMC); McConnell-Xu (turn-of-month); Gilchrist-Zakrajšek 2012 (credit). Full URLs in git history.
