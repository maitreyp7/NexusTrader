# Findings — leverage overlay on the blend
_2026-07-06 · `validate_leverage.py` · blend = 60 brain / 25 mrev / 15 lowvol_

## VERDICT: **REJECT** (at retail financing costs)

| config | Sharpe | CAGR | MaxDD | $/yr on $3k |
|---|---|---|---|---|
| 1.00x (current) | **1.251** | +7.3% | **-11.3%** | ~$218 |
| 1.25x static | 1.017 | +7.3% | -22.6% | ~$218 |
| 1.50x static | 0.861 | +7.3% | -40.3% | ~$219 |
| 2.00x static | 0.666 | +7.2% | -67.0% | ~$217 |
| vol-target 10% (avg 1.74x) | 0.665 | +5.8% | -64.7% | ~$174 |

## Why it fails — the one-line explanation
The blend earns +7.3%/yr; retail margin costs IRX + 2.5% ≈ **6.9%/yr on average
since 1970**. Borrowing at ~7% to earn ~7.3% nets ~zero — every extra unit of
exposure adds drawdown and financing but no return. The system's Sharpe 1.25 is a
LOW-VOLATILITY Sharpe: its absolute return premium over cash is too thin to lever.

## Nuance (recorded so we don't re-litigate)
- **Era-dependent:** in low-rate eras leverage DID add return (2012-2020: 1.5x added
  +3-4%/yr for ~1.5x the DD). In high-rate eras (1973-1990, financing 8-15%) it was
  a disaster (-4 to -6%/yr). Today's financing (~6.3%) sits near the break-even.
- **Vol-targeting made it WORSE** (Sharpe 0.67, CAGR -1.5pp vs unlevered): it levers
  up in calm regimes and pays financing precisely when the return premium is thinnest.
  The regime gate already does the risk-off job better.
- **Leveraged ETFs (SSO-style, financing ≈ IRX + 0.4%)** would net roughly +1.4%/yr
  at 1.5x-equivalent — but still with ~-40% MaxDD paths on the levered slice. Not
  worth it for a system whose #1 behavioral risk is the user abandoning it in a
  drawdown. Not pursued.

## Conclusion
The system is **already correctly sized**. After PEAD (benched, redundant) and
leverage (rejected, financing-bound), the honest levers for "more dollars" are:
**capital, time, and not blowing up** — exactly what BUILD_PLAN 7.4/7.5 target.
