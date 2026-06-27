"""
stability.py — Parameter Stability Analyzer (Module 9).

Anti-overfitting tool. Instead of finding the ONE best parameter (a peak that's
probably luck), it sweeps a range and asks: is the edge a broad PLATEAU (robust) or
an isolated SPIKE (fragile/overfit)? Rewards plateaus, warns on spikes.

A real edge works across a wide band of parameter values. If a strategy only works at
exactly RSI=5 but dies at 4 and 6, that's a red flag — you've curve-fit to noise.
"""

from __future__ import annotations
import sys, os
_QUANT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _QUANT); sys.path.insert(0, os.path.join(_QUANT, "strategies"))

import numpy as np
import pandas as pd
from engine import run_backtest


def sweep_1d(strategy_fn, price_panel, param_name: str, values: list, **fixed) -> pd.DataFrame:
    """Run a strategy across a range of ONE parameter; report Sharpe/CAGR/MaxDD per value."""
    rows = []
    for v in values:
        kwargs = {**fixed, param_name: v}
        w = strategy_fn(price_panel, **kwargs)
        r = run_backtest(price_panel, w)["returns"].dropna()
        vol = r.std() * np.sqrt(252)
        eq = (1 + r).cumprod()
        rows.append(dict(
            **{param_name: v},
            sharpe=round((r.mean()*252/vol), 3) if vol > 0 else 0.0,
            cagr=round(eq.iloc[-1]**(252/len(r))-1, 3),
            maxdd=round((eq/eq.cummax()-1).min(), 3),
        ))
    return pd.DataFrame(rows)


def stability_score(sweep: pd.DataFrame, metric: str = "sharpe") -> dict:
    """Score how STABLE the edge is across the swept parameter.
    High score = broad plateau (robust). Low = isolated spike (fragile)."""
    vals = sweep[metric].to_numpy()
    if len(vals) < 3:
        return dict(score=0, verdict="too few points")
    peak = vals.max()
    mean = vals.mean()
    # fraction of the range that's "near the peak" (within 25% of it and positive)
    near_peak = np.mean((vals >= 0.75 * peak) & (vals > 0)) if peak > 0 else 0
    # coefficient of variation (lower = more stable)
    cv = vals.std() / (abs(mean) + 1e-9)
    # plateau score: lots of near-peak values + low variation = stable
    score = round(near_peak * (1 / (1 + cv)), 3)
    if score >= 0.5 and (vals > 0).mean() >= 0.7:
        verdict = "ROBUST PLATEAU — edge holds across a wide parameter band"
    elif (vals > 0).mean() < 0.5:
        verdict = "FRAGILE — edge present in less than half the range"
    elif near_peak < 0.3:
        verdict = "SPIKE — only works near one value (overfit risk)"
    else:
        verdict = "MODERATE — some stability, inspect the sweep"
    return dict(
        score=score, near_peak_fraction=round(near_peak, 2),
        positive_fraction=round((vals > 0).mean(), 2), cv=round(cv, 2),
        peak=round(peak, 3), mean=round(mean, 3), verdict=verdict,
    )


def analyze(strategy_fn, price_panel, param_name: str, values: list, **fixed) -> dict:
    sweep = sweep_1d(strategy_fn, price_panel, param_name, values, **fixed)
    stab = stability_score(sweep)
    return dict(param=param_name, sweep=sweep.to_dict("records"), stability=stab)
