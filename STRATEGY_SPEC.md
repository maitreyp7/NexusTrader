# NexusTrader Strategy Spec — Evidence-Backed, Engineer-Ready

**Compiled:** 2026-06-18 from deep dives into the seminal trend-following papers, vol-targeting,
ensembling, and backtest-validation rigor. Every number tagged in-sample vs out-of-sample.
This is what we build, with the EXACT parameters and the gatekeeper that prevents another mirage.

---

## THE HONEST EXPECTATION (read first, internalize)
- **Realistic forward target = Sharpe 0.4-0.6 per sleeve, ~0.6 combined after costs.** ~5-9%/yr at 10% vol.
- In-sample literature Sharpes (TSMOM 1.3, crypto 1.9) are **futures + shorts + no costs** — discount by HALF, minimum.
- **Long-only removes ~half the signal and most equity-crash "crisis alpha."** We accept this (Alpaca constraint).
- **Plan for 1-3 flat-to-negative YEARS.** The trend "lost decade" (2009-2018) was real; it recovered hard in 2022. This is the emotional cost of the strategy.
- **Anything that backtests above ~0.8 net long-only Sharpe is almost certainly overfit** — treat as a RED FLAG, not a win.

---

## STRATEGY #1 — MULTI-ASSET TREND-FOLLOWING (the core)
Most documented edge in finance: positive every decade since 1880 (AQR 137yr), t-stat ~10 over 200yr (Lempérière).

### Universe (~12-13 liquid instruments, diversified across macro buckets)
- Equity: SPY, EFA, EEM, QQQ
- Bonds: TLT, IEF  (where much of the century-long crisis alpha lived)
- Commodities: DBC, GLD, USO/DBO
- FX proxy: UUP (USD bull)
- Crypto (cap sleeve ≤15-20% of risk): BTC, ETH only

### Signal (long/flat only — no shorts)
Hold asset at target weight when BOTH:
1. **12-month (252-day) total return > 0**  (the MOP/AQR core signal — most replicated)
2. **Price > 200-day SMA**  (slow-trend confirmation; Lempérière: slow trends did NOT decay, fast ones did)

Else → cash/BIL. (Optional later: AQR 1-3-12mo blended strength signal → 0/0.5/1 weight; Baltas shows strength-scaling cuts turnover ~35%. Start binary, add only if whipsaw hurts.)

### Position sizing — VOLATILITY TARGETING (where much of the real edge lives — Kim-Tse-Wald)
```
realized_vol_i = EWMA, lambda=0.94 (RiskMetrics), annualize sqrt(252) [crypto sqrt(365)]
raw_weight  = target_vol_per_asset (≈10%) / realized_vol_i
weight_i    = min(raw_weight, cap 25%)
# then scale total to ~10% portfolio vol, gross capped at 100% (long-only, no margin), rest in cash
```

### Rebalance
**Monthly** signal + vol re-estimate. **No-trade band:** only trade a leg if target weight drifted >~15-20% relative OR signal flipped. (Baltas: bands cut turnover ~50% — THE lever that keeps 0.10% cost from compounding into a drag.)

### Realistic expectation (discounted from in-sample)
Sharpe **0.4-0.6** | ~5-9%/yr at 10% vol | max DD **-15-25%** | expect multi-year dry spells.

---

## THE VOL-TARGETING MODULE (Spec — reused by every sleeve)
Harvey et al (Man/AHL) "Impact of Volatility Targeting": improves Sharpe for EQUITIES + CREDIT + crypto
(the leverage-effect assets — exactly our universe), negligible for bonds/commodities/FX. Reduces tail severity everywhere.
```
PARAMS: lambda=0.94, target_vol=0.10-0.15/yr, max_leverage=1.0 (long-only),
        band_rel=0.15, min benefit > round-trip cost before trading
EWMA:   var_t = lambda*var_{t-1} + (1-lambda)*ret_{t-1}^2 ;  vol = sqrt(var_t*ann)
SIZE:   weight = min(target_vol/vol, max_leverage)
GATE:   trade only if |target-current|/current > band_rel
SAFETY: cap de-lever speed (<=30%/day); keep kill_switch.json drawdown stop INDEPENDENT
        — vol targeting is NOT crash protection (it can sell the bottom; correlations →0.7 in crashes)
```

---

## THE ENSEMBLE (the actual edge — why this works where single strategies didn't)
Portfolio Sharpe ≈ S·√N / √(1+(N-1)ρ). Five Sharpe-0.5 sleeves at ρ=0.3 → combined ~0.71 gross / ~0.6 net.
Grinold's Fundamental Law: IR = IC·√Breadth — many small independent bets beat one big bet.
AQR Style Premia (the pro example): sleeves of Sharpe 0.29-0.87 individually → combined 0.7 at 8% vol.

- **3-5 sleeves, structurally DIFFERENT drivers** (trend, mean-reversion [neg-corr to trend!], crypto momentum, seasonality)
- **Correlation discipline:** pairwise |ρ| < 0.3 target; REJECT/merge anything > 0.6 (it's leverage, not a new sleeve)
- **Allocate by inverse-vol / equal-risk.** NEVER a max-Sharpe optimizer (in-sample overfit, unstable weights).
- Each sleeve internally vol-targeted first → sleeve vols ~equal → near equal-weight in practice.

---

## THE GATEKEEPER PROTOCOL (run on EVERY strategy before any real money)
This is what would have caught the ORB mirage. Any single FAIL = does NOT go live.

**Stage 0 — before optimizing:** Pre-declare N (every param × range tested). Confirm data ≥ MinBTL = 2·ln(N)/SR². Survivorship-free dataset (crypto: include dead coins).
**Stage 1 — realistic mechanics:** Decide on bar t close → execute bar t+1 OPEN (never same bar). Cross the spread (no midpoint). Survives 2× slippage stress (PF>1.0 at double cost).
**Stage 2 — walk-forward:** Rolling, ≥5-6 windows, params on in-sample only. **WFE ≥ 50%** (target 60%). OOS PF > 1.25, not driven by 1-2 lucky trades.
**Stage 3 — statistical honesty:** ≥100 OOS trades (200 ideal). **Deflated Sharpe > 0.95** (use `pypbo`). **PBO < 0.50** (target <0.20).
**Stage 4 — sniff tests:** Few params. No freak trade carrying the curve. WFE>80%/Sharpe>3 = RED FLAG (leakage), re-audit. Must make economic sense.

**FINAL GATE — goes live only if:** OOS PF>1.25 AND WFE≥50% AND DSR>0.95 AND PBO<0.50 AND ≥100 OOS trades AND backtest≥MinBTL AND survives 2× slippage.

Honest cost table (per side): liquid ETF 1-3bps · large-cap stock 3-5bps · high-vol (COIN/MARA/etc) 10-25bps · crypto BTC/ETH model 2×spread+taker fees. Commission ~0 on Alpaca but spread/slippage IS the cost.

---

## ⚠️ THE HARD TRUTH THIS RESEARCH SURFACED (must confront before building)
**Trend-following needs 10-20+ YEARS of data to validate** (enough independent trend/chop regimes), and our backtest
must be ≥ MinBTL for the N we test. **Alpaca's daily-bar history may NOT go back far enough** (esp. for crypto, which
barely has 10yr and is survivorship-poisoned). If we can't get 10-20yr of clean daily data, we CANNOT properly validate
trend-following — and shipping it on a 3-5yr backtest would be repeating the ORB mistake (statistically empty).
**FIRST BUILD STEP must verify data availability/length before writing any strategy.** This is Phase 0.

## SOURCES
Moskowitz-Ooi-Pedersen 2012; Kim-Tse-Wald 2016 (vol-scaling caveat); Hurst-Ooi-Pedersen "Century of Evidence";
Baltas-Kosowski (turnover); Lempérière "Two Centuries"; Clenow "Following the Trend"; AQR "You Can't Always Trend";
Harvey et al "Impact of Vol Targeting"; Grinold Fundamental Law; AQR Style Premia; Bailey-López de Prado (Deflated Sharpe,
PBO, MinBTL); White's Reality Check. Full URLs in git history / agent reports.
