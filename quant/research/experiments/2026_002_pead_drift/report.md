# Validation Report — PEAD drift (long-only, surprise beat + positive reaction)
_Generated 2026-07-06T01:25:00_

## VERDICT: **PAPER_TRADE**
> Real but moderate edge: Sharpe 0.698, survives 2x cost (0.648), eras 9/9. Worth paper validation.

## Performance
| metric | value |
|---|---|
| CAGR | +9.80% |
| Sharpe | 0.698 |
| Sortino | 0.808 |
| Calmar | 0.304 |
| Max Drawdown | -32.2% |
| Win Rate | 50% |
| Profit Factor | 1.161 |
| Volatility | 15.0% |

## Robustness
- **2x-cost Sharpe:** 0.648 (must survive)
- **Eras positive:** 9/9
- **First/second half Sharpe:** 0.574 / 0.858
- **Deflated Sharpe prob:** 1.0 (want > 0.90)

## Similarity / Redundancy
- **Verdict:** PARTIAL OVERLAP
- **Correlations:** {'brain': 0.336, 'mean-rev': 0.427}
- Moderately correlated (0.427 to 'mean-rev'). Some overlap; check if it adds enough.

## Parameter Stability
- **Verdict:** ROBUST PLATEAU — edge holds across a wide parameter band
- Stability score: 0.925 | positive across 100% of range

## Era detail
| period | sharpe | cagr | maxdd |
|---|---|---|---|
| 2000-2002 | 0.261 | +2.7% | -17.3% |
| 2003-2005 | 1.989 | +22.2% | -9.1% |
| 2006-2008 | 0.316 | +4.5% | -28.3% |
| 2009-2011 | 0.26 | +3.3% | -26.4% |
| 2012-2014 | 1.636 | +16.2% | -8.1% |
| 2015-2017 | 1.096 | +11.2% | -10.5% |
| 2018-2020 | 0.463 | +6.9% | -32.2% |
| 2021-2023 | 0.819 | +11.3% | -15.5% |
| 2024-2026 | 0.984 | +10.6% | -8.5% |