# Validation Report — low-volatility tilt
_Generated 2026-06-30T17:56:33_

## VERDICT: **PRODUCTION_CANDIDATE**
> Strong + robust: Sharpe 1.048, survives 2x cost (1.041), broad across eras (18/19), holds recent half (0.796), DSR 1.0.

## Performance
| metric | value |
|---|---|
| CAGR | +13.10% |
| Sharpe | 1.048 |
| Sortino | 1.393 |
| Calmar | 0.274 |
| Max Drawdown | -47.8% |
| Win Rate | 54% |
| Profit Factor | 1.213 |
| Volatility | 12.5% |

## Robustness
- **2x-cost Sharpe:** 1.041 (must survive)
- **Eras positive:** 18/19
- **First/second half Sharpe:** 1.372 / 0.796
- **Deflated Sharpe prob:** 1.0 (want > 0.90)

## Similarity / Redundancy
- **Verdict:** PARTIAL OVERLAP
- **Correlations:** {'brain': 0.27, 'mean-rev': 0.416}
- Moderately correlated (0.416 to 'mean-rev'). Some overlap; check if it adds enough.

## Parameter Stability
- **Verdict:** ROBUST PLATEAU — edge holds across a wide parameter band
- Stability score: 0.953 | positive across 100% of range

## Era detail
| period | sharpe | cagr | maxdd |
|---|---|---|---|
| 1970-1972 | 2.839 | +29.6% | -8.6% |
| 1973-1975 | -0.294 | -5.6% | -47.8% |
| 1976-1978 | 0.963 | +7.7% | -9.2% |
| 1979-1981 | 1.145 | +11.8% | -19.7% |
| 1982-1984 | 2.465 | +24.3% | -7.3% |
| 1985-1987 | 1.357 | +22.3% | -19.8% |
| 1988-1990 | 1.232 | +14.6% | -13.7% |
| 1991-1993 | 2.081 | +19.8% | -6.9% |
| 1994-1996 | 1.733 | +16.3% | -9.0% |
| 1997-1999 | 0.738 | +8.3% | -19.0% |
| 2000-2002 | 1.066 | +16.4% | -21.9% |
| 2003-2005 | 1.218 | +11.8% | -7.5% |
| 2006-2008 | 0.161 | +1.3% | -26.3% |
| 2009-2011 | 1.161 | +15.4% | -18.1% |
| 2012-2014 | 1.558 | +14.9% | -8.3% |
| 2015-2017 | 1.113 | +12.0% | -9.9% |
| 2018-2020 | 0.737 | +13.6% | -30.2% |
| 2021-2023 | 0.46 | +5.2% | -16.7% |
| 2024-2026 | 1.21 | +14.5% | -9.2% |