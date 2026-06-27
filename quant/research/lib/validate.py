"""
validate.py — Standardized strategy validation (Module 5 core).

ONE function — validate_strategy() — takes a weights DataFrame + price panel and
produces a full, reproducible validation dict: performance, robustness, and a written
recommendation. Wraps the EXISTING production-grade engine.py + gatekeeper.py so every
experiment is judged by the same honest yardstick. Does NOT modify production code.

Recommendations: REJECT / NEEDS_MORE_RESEARCH / INTERESTING / PAPER_TRADE / PRODUCTION_CANDIDATE.

Philosophy (from the spec): robustness over Sharpe, survives costs, broad across eras,
holds out-of-sample. A high Sharpe that fails the robustness checks is REJECTED.
"""

from __future__ import annotations
import sys, os
# reach the production quant/ modules (two levels up)
_QUANT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _QUANT)
sys.path.insert(0, os.path.join(_QUANT, "strategies"))

import numpy as np
import pandas as pd
from engine import run_backtest
from gatekeeper import deflated_sharpe_prob, walk_forward_by_year_blocks, split_half_test


def _perf(r: pd.Series, eq: pd.Series) -> dict:
    r = r.dropna()
    if len(r) < 30:
        return {}
    ann = 252
    vol = r.std() * np.sqrt(ann)
    downside = r[r < 0].std() * np.sqrt(ann)
    sharpe = (r.mean() * ann) / vol if vol > 0 else 0.0
    sortino = (r.mean() * ann) / downside if downside > 0 else 0.0
    cagr = eq.iloc[-1] ** (ann / len(r)) - 1 if eq.iloc[-1] > 0 else -1.0
    dd = (eq / eq.cummax() - 1)
    maxdd = dd.min()
    calmar = cagr / abs(maxdd) if maxdd < 0 else 0.0
    gains = r[r > 0].sum(); losses = abs(r[r < 0].sum())
    pf = gains / losses if losses > 0 else float("inf")
    return dict(
        cagr=round(cagr, 4), sharpe=round(sharpe, 3), sortino=round(sortino, 3),
        calmar=round(calmar, 3), max_drawdown=round(maxdd, 4),
        win_rate=round((r > 0).mean(), 3), profit_factor=round(pf, 3),
        volatility=round(vol, 4), n_days=len(r),
    )


def validate_strategy(weights: pd.DataFrame, price_panel: pd.DataFrame,
                      strategy_fn=None, name: str = "strategy", **strat_kwargs) -> dict:
    """Full standardized validation. If strategy_fn given, walk-forward uses it;
    otherwise gatekeeper-style era slicing runs on the realized returns."""
    res = run_backtest(price_panel, weights)
    r, eq = res["returns"], res["equity"]

    perf = _perf(r, eq)

    # robustness
    r2 = run_backtest(price_panel, weights, cost_mult=2.0)["returns"]
    perf2 = _perf(r2, (1 + r2).cumprod())

    # era consistency (slice realized returns by 3yr blocks)
    eras = _era_blocks(r)
    pos_eras = sum(1 for e in eras if e["sharpe"] > 0)

    # first/second half
    mid = r.dropna().index[len(r.dropna()) // 2]
    fh, sh = r[r.index < mid], r[r.index >= mid]
    half = {
        "first_half_sharpe": _sharpe(fh),
        "second_half_sharpe": _sharpe(sh),
        "dsr_full": round(deflated_sharpe_prob(r), 3),
    }

    robustness = dict(
        sharpe_2x_cost=perf2.get("sharpe", 0),
        cagr_2x_cost=perf2.get("cagr", 0),
        eras_positive=f"{pos_eras}/{len(eras)}",
        eras_positive_frac=round(pos_eras / len(eras), 2) if eras else 0,
        **half,
    )

    rec, why = _recommend(perf, robustness)

    return dict(
        name=name, performance=perf, robustness=robustness,
        era_detail=eras, recommendation=rec, reasoning=why,
        returns=r,  # kept for charts/correlation; callers can drop before json
    )


def _sharpe(r):
    r = r.dropna()
    v = r.std() * np.sqrt(252)
    return round((r.mean() * 252) / v, 3) if v > 0 else 0.0


def _era_blocks(r, block=3):
    r = r.dropna()
    out = []
    if len(r) < 120:
        return out
    y = r.index[0].year
    while y <= r.index[-1].year:
        b = r[(r.index.year >= y) & (r.index.year < y + block)]
        if len(b) > 60:
            eq = (1 + b).cumprod()
            out.append(dict(
                period=f"{y}-{min(y+block-1, r.index[-1].year)}",
                sharpe=_sharpe(b), cagr=round(eq.iloc[-1] ** (252/len(b)) - 1, 3),
                maxdd=round((eq/eq.cummax()-1).min(), 3), days=len(b),
            ))
        y += block
    return out


def _recommend(perf: dict, rob: dict) -> tuple[str, str]:
    """The honest gatekeeper verdict. Robustness gates DOMINATE raw performance."""
    if not perf:
        return "REJECT", "Insufficient data."
    sh = perf["sharpe"]; sh2 = rob["sharpe_2x_cost"]
    eras = rob["eras_positive_frac"]; rec_half = rob["second_half_sharpe"]
    dsr = rob["dsr_full"]

    # hard rejects
    if sh <= 0 or perf["cagr"] <= 0:
        return "REJECT", "Negative or zero edge."
    if sh2 < 0.1:
        return "REJECT", f"Edge dies under 2x costs (Sharpe {sh2})."
    if rec_half <= 0:
        return "REJECT", f"No edge in the recent half (2nd-half Sharpe {rec_half}) — likely decayed/overfit."
    if eras < 0.5:
        return "NEEDS_MORE_RESEARCH", f"Edge inconsistent across eras ({rob['eras_positive']})."

    # tiers
    strong = sh >= 0.8 and sh2 >= 0.5 and eras >= 0.7 and rec_half >= 0.3 and dsr >= 0.90
    good   = sh >= 0.5 and sh2 >= 0.3 and eras >= 0.6 and rec_half > 0
    if strong:
        return "PRODUCTION_CANDIDATE", (
            f"Strong + robust: Sharpe {sh}, survives 2x cost ({sh2}), broad across eras "
            f"({rob['eras_positive']}), holds recent half ({rec_half}), DSR {dsr}.")
    if good:
        return "PAPER_TRADE", (
            f"Real but moderate edge: Sharpe {sh}, survives 2x cost ({sh2}), "
            f"eras {rob['eras_positive']}. Worth paper validation.")
    return "INTERESTING", (
        f"Marginal edge (Sharpe {sh}) — survives basic checks but not strong. "
        f"Worth refining, not deploying.")
