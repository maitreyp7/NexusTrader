# NexusTrader Full System Audit — 2026-08-26

Backtested every sleeve individually + the combined system through the honest
engine (real costs, no look-ahead). This is the complete "what's helping, what's
harming, what can go" report.

---

## 1. Scorecard — every sleeve, full history

| Sleeve | Sharpe | CAGR | Max DD | Verdict |
|---|---|---|---|---|
| **mean-rev** (just upgraded) | **1.08** | +12.4% | −30% | ⭐ best sleeve |
| **low-vol** (bot #3, not live yet) | 1.05 | +13.1% | −48% | strong, ready |
| **trend (ETF)** | 0.94 | +9.2% | −18% | solid backbone |
| **crypto trend** | 0.68 | +18.2% | −74% | high return, brutal DD |
| **turn-of-month** | 0.43 | +2.9% | −30% | weak alone, but see §4 |
| _SPY buy-and-hold (benchmark)_ | _0.47_ | _+5.7%_ | _−55%_ | _the thing to beat_ |

**The combined system beats every individual sleeve AND beats SPY on risk:**

| Configuration | Sharpe | CAGR | Max DD |
|---|---|---|---|
| brain only | 0.73 | +4.2% | −14% |
| 2-bot (70 brain / 30 mrev) — LIVE NOW | 1.11 | +6.4% | −12% |
| **3-bot (60/25/15) — planned** | **1.25** | **+7.3%** | **−10%** |
| SPY buy-and-hold | 0.47 | +5.7% | −55% |

The whole point in one line: the 3-bot system earns a bit more than SPY (+7.3 vs
+5.7) with **1/5th the drawdown** (−10% vs −55%) and 2.5× the Sharpe. It is NOT a
get-rich engine; it is a survive-downturns-and-grind engine.

---

## 2. What's HELPING (keep, don't touch)

- **mean-rev** — the strongest sleeve, and the quality-over-quantity upgrade
  (2026-08-26) made it better: Sharpe 0.81→1.08, drawdown −54%→−30%, and it
  survives 2× costs (0.91). This is the engine room.
- **trend (ETF)** — 0.94 Sharpe over 38 years, the low-drama backbone. Its recent
  half is STRONGER than early (0.54→1.29), no decay.
- **The regime gate** (VIX/VIX3M → cash in stress). This is why system drawdown is
  −10% while SPY is −55%. It is the single most valuable component for the
  "beat the market on risk" thesis.
- **Diversification is real.** Sleeve correlations are low (crypto 0.03–0.34 to
  everything; low-vol 0.28 to trend). These are genuinely different bets — the
  ensemble is not one strategy in disguise.

---

## 3. What's HARMING / needs watching

- **crypto trend — the risk hog.** +18%/yr looks great but −74% drawdown is
  savage, and it's had TWO execution bugs live (422 orders, then daily double-buy
  → 79% of the account). It's the most dangerous sleeve operationally.
  **Recommendation:** keep it (it's uncorrelated and additive) but HARD-CAP it at
  ~10% of the account in code, and prioritize the auto-drawdown rule for it first.
- **low-vol shows mild decay** (early Sharpe 1.37 → recent 0.80). Still positive
  and additive, but it's the one sleeve trending the wrong way. Deploy it, but the
  drift monitor should watch it closely.
- **Operational fragility is the real harm, not any strategy.** Every loss of the
  last 4 months traced to PLUMBING bugs (false kill-switch, crypto double-buy,
  mean-rev churn), not bad strategy. The strategies backtest fine; the execution
  keeps breaking. **The highest-value work is hardening execution, not adding edges.**

---

## 4. What can be REMOVED? (tested, answer: nothing — but one surprise)

- **turn-of-month looks removable** (Sharpe 0.43, CAGR +2.9%). Dropping it appears
  to DOUBLE system CAGR (+6.8%→+16.5%)... but that's a TRAP. Removing it just
  raises market exposure 41%→90%. **At equal risk the two are identical (+6.8% vs
  +6.7%).** So tom is a volatility dampener, not dead weight — removing it is just
  hidden leverage, which we already proved (2026-07) doesn't pay. **KEEP it.**
- **No sleeve should be cut.** Each is uncorrelated and either adds return or
  dampens risk. The graveyard already removed the real losers (ORB, swing,
  shorting, defensive rotation, sector rotation, residual momentum, PEAD-as-4th).

---

## 5. Ranked improvement opportunities (highest value first)

1. **Per-sleeve auto-drawdown circuit breaker (7.4).** The system's biggest weakness
   is operational, not strategic. A rule that auto-halves/cuts a sleeve on a hard
   drawdown threshold (crypto first) turns "Claude finds the bug weeks later" into
   "the system defends itself." Absolute thresholds — no history needed to be safe.
2. **Hard crypto exposure cap in code (~10%).** Cheap, prevents the double-buy class
   of disaster from ever reaching 79% again even if a new bug appears.
3. **Ship low-vol (bot #3).** Already validated + dry-running. Takes system Sharpe
   1.11→1.25, CAGR 6.4→7.3%, drawdown −12→−10%. The one remaining validated upgrade.
4. **Let the 2 param upgrades prove out** (mean-rev + brain bands, both deployed
   2026-08-26) and confirm turnover dropped via turnover_audit.py in ~1 week.
5. **Nothing else via new strategies.** The free-edge well is dry (documented in
   GRAVEYARD.md across multiple sweeps). More money = capital + time + not blowing
   up, NOT sleeve #6.

---

## 6. The honest bottom line

- The strategies are sound and beat SPY on a risk-adjusted basis by a wide margin.
- The system has NOT beaten SPY on raw return in this bull run — BY DESIGN. Its
  edge is downside protection (−10% vs −55% drawdown), which is UNTESTED live
  because there's been no downturn yet. That test is the real verdict, still pending.
- The recurring damage has been bugs, not bad strategy. Harden execution (items
  1–2) before chasing any new return.
- Realistic expectation remains ~7%/yr with shallow drawdowns. If that's worth it
  to you, the path is: harden → ship low-vol → fund with real capital. If it isn't,
  a low-cost index fund is a legitimate and honest alternative — the value here is
  purely the downside protection, which only pays off in a bear market.
