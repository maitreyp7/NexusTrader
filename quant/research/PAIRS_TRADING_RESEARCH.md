# Pairs Trading / Statistical Arbitrage — Research Brief (pre-build)

_Collected 2026-09-23, before building anything. Purpose: understand how it works, what
the real-world evidence says, and what to watch for — so the eventual experiment is
designed right and we know what "good" looks like._

---

## 1. What it is (the concept)

Two related stocks (classic example: Coca-Cola KO / PepsiCo PEP) are driven by the same
forces, so their prices tend to move together. **Pairs trading bets on their SPREAD, not
their direction.** When the spread stretches unusually wide, you short the expensive leg
and long the cheap leg, betting the relationship snaps back to normal. Profit comes from
the *relationship correcting* — you're roughly market-neutral (a market-wide move hits
both legs and cancels).

## 2. The critical distinction: correlation ≠ cointegration

- **Correlation** = the two stocks move up/down together day-to-day. NOT enough — two
  correlated stocks can both trend up forever and never give you a reversion to trade.
- **Cointegration** = a specific linear combination of the two prices (the *spread*) is
  **stationary** — it wanders but reverts to a stable mean. THIS is what pairs trading
  needs. A pair can be highly correlated but NOT cointegrated (spurious), which is the
  #1 beginner trap.

## 3. How it actually works (the mechanics)

1. **Find candidate pairs** — same sector / economically linked is a starting filter, not
   proof.
2. **Test cointegration** — Engle-Granger two-step / CADF: regress one stock on the other
   to get the **hedge ratio** (how many units of B per unit of A), then run an **ADF test**
   on the residual spread. Accept if p-value < 0.05 (ideally < 0.01). Optionally confirm
   with the Hurst exponent (H < 0.5 = mean-reverting).
3. **Build the spread:** `spread = log(A) − hedge_ratio × log(B)`.
4. **Z-score it:** compute the spread's rolling mean + std, then `z = (spread − mean)/std`.
5. **Trade the z-score (typical thresholds):**
   - `z < −2` → LONG the spread (buy A, short B)
   - `z > +2` → SHORT the spread (short A, buy B)
   - `|z| < 0.5` → EXIT (it reverted — take profit)
   - `|z| > 3.0–3.5` → STOP OUT (the relationship may have broken — cut the loss)
6. **Re-test continuously:** on a rolling window, keep checking the pair is still
   cointegrated. If the spread stops testing stationary, stand the pair down. Cointegration
   is not permanent.

## 4. The real-world evidence (this is the sobering part)

The foundational study — **Gatev, Goetzmann & Rouwenhorst (2006), "Pairs Trading:
Performance of a Relative-Value Arbitrage Rule"** — tested 1962–2002 and found ~11%/yr
excess returns. BUT the profitability has **decayed hard since**, and the decay is
well-documented:

| Period | Mean monthly excess return (top pairs) |
|---|---|
| 1962–1988 | 0.86%/mo |
| 1989–2002 | 0.37%/mo |
| 2003–2009 | 0.24%/mo |
| post-2002 (refined studies) | ~0.30%/mo pre-cost, "largely unprofitable after costs" |

**Why it decayed:** *crowding.* Once the strategy was published (2006), everyone ran it,
and the mispricings got arbitraged away faster. This is the exact pattern we've seen with
every published edge (overnight drift, ORB, etc.) — **publication kills the edge.**

## 5. Why it fails / what to watch for

- **Cointegration breaks (the main blow-up mode).** A pair cointegrated for years can
  decouple *permanently* — a merger, a business-model shift, one company's fortunes
  diverge. Then the spread never reverts and you lose on BOTH legs. The `|z| > 3` stop
  exists precisely for this. Continuous re-testing is not optional.
- **In-sample overfitting.** Scan enough pairs and some will look cointegrated by pure
  chance. MUST validate out-of-sample: find pairs on an early period, confirm they still
  cointegrate + still profit on later data.
- **Transaction costs roughly DOUBLE** vs single-stock trades (two legs, both traded) —
  and pairs profits are thin (~0.2–0.3%/mo), so costs can erase the entire edge. This is
  where most backtested pairs edge dies.
- **Short costs + hard-to-borrow.** One leg is always short → borrow fees, and some names
  aren't shortable. Restrict to Alpaca easy-to-borrow names.
- **Regime sensitivity.** Pairs profits vary a lot with market conditions — often *better*
  in turbulent markets, worse in calm ones.

## 6. What still works (per 2024–2026 sources)

The consensus: **simple mechanical pairs trading (the 2006 distance method) is essentially
dead after costs.** What survives is *more sophisticated, adaptive* stat-arb run by quant
funds — adjusting for changing volatility/correlation/liquidity, sometimes ML-augmented.
The edge "moved up the complexity curve." Caveat worth remembering: even the ML-augmented
versions may face the same crowding decay once *they're* widely known.

## 7. What this means for OUR go/no-go (honest prior)

- It IS worth testing because it's the only **market-neutral** idea we have — it could make
  money in flat/falling markets and be uncorrelated to our long-only sleeves (the two
  things the user keeps asking for).
- BUT the evidence says the *simple* version is probably dead after costs. Realistic prior:
  **~30-40% it clears our gatekeeper**, and if it does, likely marginally.
- **The gates that will most likely kill it:** the recent-half test (decay), the 2×-cost
  test (thin edge + double costs + short fees), and out-of-sample pair stability.
- **Design implications for the experiment:**
  1. Test cointegration on an EARLY window, trade only on a LATER window (out-of-sample).
  2. Model costs honestly for BOTH legs + short borrow.
  3. Include the `|z|>3` break-stop and rolling re-test.
  4. Judge on Sharpe + drawdown + recent-half, not raw return.
  5. If it clears: check correlation to existing sleeves (additivity, per the PEAD lesson).

## Sources
- Gatev, Goetzmann, Rouwenhorst (2006), *Review of Financial Studies* — the foundational study
- Zhu (2024, Yale), "Examining Pairs Trading Profitability" — decay analysis
- Harbourfront Quant (2024–2026), "Modern Pairs Trading: What Still Works" — crowding/decay
- QuantInsti, Hudson & Thames — mechanics (cointegration, hedge ratio, z-score, stops)
