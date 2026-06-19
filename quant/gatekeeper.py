"""
gatekeeper.py — Validation that decides if a strategy is REAL or a mirage.

The ORB strategy looked great in-sample and lost money live. This module exists
to catch that BEFORE real money. It runs the checks the research prescribed:

  1. WALK-FORWARD by period — does the edge show up consistently across separate
     time windows, or is it carried by one lucky era? We report Sharpe/return per
     non-overlapping period. A real edge is positive in MOST periods.

  2. SUB-PERIOD ROBUSTNESS — split history in half; the edge should appear in BOTH
     halves (especially the recent half — the out-of-sample-ish test).

  3. SLIPPAGE STRESS — already in engine via cost_mult; we report 1x vs 2x.

  4. DEFLATED SHARPE — adjust the Sharpe for short samples and non-normal returns,
     giving a probability the true Sharpe > 0.

Note on parameter optimization: for a low-parameter strategy like trend (we did NOT
search thousands of configs), the multiple-testing penalty is small. The bigger risk
here is "one lucky decade", which the per-period walk-forward directly exposes.
"""

from __future__ import annotations
import numpy as np
import pandas as pd
from scipy import stats as _st

import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from engine import run_backtest


def deflated_sharpe_prob(returns: pd.Series, ann: int = 252) -> float:
    """Probability that the true (annualized) Sharpe > 0, adjusting for sample
    length, skew and kurtosis (Bailey & Lopez de Prado, simplified single-trial
    Probabilistic Sharpe Ratio against benchmark 0)."""
    r = returns.dropna()
    n = len(r)
    if n < 30 or r.std() == 0:
        return float("nan")
    sr = r.mean() / r.std()                 # per-period (daily) Sharpe
    skew = _st.skew(r)
    kurt = _st.kurtosis(r, fisher=False)    # non-excess kurtosis
    # PSR: prob that SR > 0
    denom = np.sqrt(1 - skew * sr + ((kurt - 1) / 4.0) * sr**2)
    psr = _st.norm.cdf((sr * np.sqrt(n - 1)) / denom)
    return float(psr)


def walk_forward_by_year_blocks(price_panel, strategy_fn, block_years: int = 3,
                                cost_mult: float = 1.0, **strat_kwargs) -> pd.DataFrame:
    """Run the strategy once over full history (signals need full lookback), then
    SLICE the resulting return stream into non-overlapping blocks and report stats
    per block. This shows whether the edge is consistent across eras.

    (Weights are computed on full data but each weight only uses PAST data — the
    engine enforces the t->t+1 shift — so slicing the realized returns into eras is
    a fair per-era performance read.)"""
    weights = strategy_fn(price_panel, **strat_kwargs)
    res = run_backtest(price_panel, weights, cost_mult=cost_mult)
    r = res["returns"].dropna()

    rows = []
    start_year = r.index[0].year
    end_year = r.index[-1].year
    y = start_year
    while y <= end_year:
        block = r[(r.index.year >= y) & (r.index.year < y + block_years)]
        if len(block) > 60:  # need ~3 months min
            ann_ret = (1 + block).prod() ** (252 / len(block)) - 1
            vol = block.std() * np.sqrt(252)
            sharpe = (block.mean() * 252) / vol if vol > 0 else 0.0
            eq = (1 + block).cumprod()
            dd = (eq / eq.cummax() - 1).min()
            rows.append({
                "period": f"{y}-{min(y+block_years-1, end_year)}",
                "CAGR%": round(ann_ret * 100, 1),
                "Sharpe": round(sharpe, 2),
                "MaxDD%": round(dd * 100, 1),
                "days": len(block),
            })
        y += block_years
    return pd.DataFrame(rows)


def split_half_test(price_panel, strategy_fn, cost_mult: float = 1.0, **strat_kwargs) -> dict:
    """Compare first-half vs second-half performance. The edge should survive into
    the recent half (the closest thing to out-of-sample without re-fitting)."""
    weights = strategy_fn(price_panel, **strat_kwargs)
    res = run_backtest(price_panel, weights, cost_mult=cost_mult)
    r = res["returns"].dropna()
    mid = r.index[len(r) // 2]

    def stat(x):
        vol = x.std() * np.sqrt(252)
        return {
            "Sharpe": round((x.mean() * 252) / vol, 2) if vol > 0 else 0.0,
            "CAGR%": round(((1 + x).prod() ** (252 / len(x)) - 1) * 100, 1),
            "DSR_prob": round(deflated_sharpe_prob(x), 3),
        }
    first = r[r.index < mid]
    second = r[r.index >= mid]
    return {
        "split_date": str(mid.date()),
        "first_half": stat(first),
        "second_half": stat(second),
        "full_DSR_prob": round(deflated_sharpe_prob(r), 3),
    }


def gate_verdict(price_panel, strategy_fn, **strat_kwargs) -> None:
    """Run the full gatekeeper and print a clear PASS/FAIL-style readout."""
    print("\n" + "=" * 64)
    print("  GATEKEEPER VALIDATION")
    print("=" * 64)

    print("\n  [1] WALK-FORWARD by 3-year blocks (edge must be broad, not one era):")
    wf = walk_forward_by_year_blocks(price_panel, strategy_fn, **strat_kwargs)
    print(wf.to_string(index=False))
    pos = (wf["Sharpe"] > 0).sum()
    print(f"\n      → {pos}/{len(wf)} blocks have positive Sharpe.")

    print("\n  [2] FIRST-HALF vs SECOND-HALF (edge must survive into recent data):")
    sh = split_half_test(price_panel, strategy_fn, **strat_kwargs)
    print(f"      split at {sh['split_date']}")
    print(f"      first half : Sharpe {sh['first_half']['Sharpe']:>5} | CAGR {sh['first_half']['CAGR%']:>5}% | DSR_prob {sh['first_half']['DSR_prob']}")
    print(f"      second half: Sharpe {sh['second_half']['Sharpe']:>5} | CAGR {sh['second_half']['CAGR%']:>5}% | DSR_prob {sh['second_half']['DSR_prob']}")

    print("\n  [3] DEFLATED SHARPE (prob true Sharpe>0, full sample):")
    print(f"      full-sample DSR probability: {sh['full_DSR_prob']}   (want > 0.95)")

    print("\n  [4] SLIPPAGE STRESS (1x vs 2x costs):")
    w = strategy_fn(price_panel, **strat_kwargs)
    r1 = run_backtest(price_panel, w, cost_mult=1.0)
    r2 = run_backtest(price_panel, w, cost_mult=2.0)
    print(f"      1x: Sharpe {r1['sharpe']:.2f} | CAGR {r1['cagr']*100:+.2f}%")
    print(f"      2x: Sharpe {r2['sharpe']:.2f} | CAGR {r2['cagr']*100:+.2f}%   (must stay positive)")

    print("\n  " + "-" * 60)
    verdict_pass = (
        pos >= 0.7 * len(wf)
        and sh["second_half"]["Sharpe"] > 0.3
        and sh["full_DSR_prob"] > 0.95
        and r2["sharpe"] > 0.3
    )
    print(f"  VERDICT: {'PASS ✓ — edge is broad, survives recent data + 2x costs' if verdict_pass else 'NEEDS REVIEW — see which check is weak above'}")
    print("=" * 64)
