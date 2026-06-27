"""
similarity.py — Research Similarity Engine (Module 4).

The biggest research waste is rebuilding a strategy you already have. Before building,
this compares a candidate's RETURN STREAM against the live bots and all past experiments.
The cleanest, most honest similarity measure for trading strategies is RETURN
CORRELATION — two strategies that produce the same daily P&L ARE the same strategy,
no matter how different their code looks.

Output: correlation to each existing strategy + a verdict (redundant / diversifier).
"""

from __future__ import annotations
import sys, os, json, glob
_QUANT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _QUANT); sys.path.insert(0, os.path.join(_QUANT, "strategies"))

import numpy as np
import pandas as pd
from engine import run_backtest


def _corr(a: pd.Series, b: pd.Series) -> float:
    df = pd.concat([a, b], axis=1).dropna()
    if len(df) < 60 or df.iloc[:, 0].std() == 0 or df.iloc[:, 1].std() == 0:
        return 0.0
    return round(float(df.iloc[:, 0].corr(df.iloc[:, 1])), 3)


def live_bot_returns(etf_panel, stock_panel):
    """Return streams of the two production bots, for redundancy checks."""
    import trend, crypto_trend, flow, allocator, name_meanrev
    sw = {"trend": trend.strategy(etf_panel), "crypto": crypto_trend.strategy(etf_panel),
          "tom": flow.turn_of_month(etf_panel)}
    sr = {k: run_backtest(etf_panel, v)["returns"] for k, v in sw.items()}
    brain = run_backtest(etf_panel,
                         (allocator.combine(sw, sr, allocator.DEFAULT_CAPS) * allocator.DEFAULT_LEVERAGE).clip(upper=0.25)
                         )["returns"]
    mr = run_backtest(stock_panel,
                      name_meanrev.strategy(stock_panel, entry_rsi=5, exit_rsi=60, hold_max=10, max_names=10, max_weight=0.10)
                      )["returns"]
    return {"brain": brain, "mean-rev": mr}


def compare(candidate_returns: pd.Series, existing: dict[str, pd.Series],
            redundant_threshold: float = 0.7, diversifier_threshold: float = 0.35) -> dict:
    """Compare a candidate return stream to a dict of existing return streams."""
    corrs = {name: _corr(candidate_returns, r) for name, r in existing.items()}
    max_abs = max((abs(c) for c in corrs.values()), default=0.0)
    most_similar = max(corrs, key=lambda k: abs(corrs[k])) if corrs else None

    if max_abs >= redundant_threshold:
        verdict = "LIKELY REDUNDANT"
        rec = f"Highly correlated ({max_abs}) to '{most_similar}'. Probably the same edge in disguise — don't build."
    elif max_abs <= diversifier_threshold:
        verdict = "POTENTIAL DIVERSIFIER"
        rec = f"Low correlation to everything (max {max_abs}). Genuinely different — worth pursuing."
    else:
        verdict = "PARTIAL OVERLAP"
        rec = f"Moderately correlated ({max_abs} to '{most_similar}'). Some overlap; check if it adds enough."

    return dict(correlations=corrs, max_abs_corr=max_abs,
                most_similar=most_similar, similarity_score=max_abs,
                verdict=verdict, recommendation=rec)
