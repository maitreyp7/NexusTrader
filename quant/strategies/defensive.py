"""
defensive.py — Anti-trend / defensive sleeves that aim to win when trend LOSES.

Our two strong sleeves are both trend-flavored (corr 0.58). To smooth the portfolio
we need sleeves that profit in the choppy/risk-off conditions where trend bleeds.

Two candidates:
  1. flight_to_safety: rotate into bonds/gold (TLT/GLD) when EQUITIES are in a
     downtrend (SPY below its 200d MA). Risk-off assets rally when stocks fall —
     this should be NEGATIVELY correlated to equity trend.
  2. defensive_rotation: a simple dual-momentum risk-on/off — hold equities when
     SPY uptrending, else hold bonds/gold/cash. (long-only, daily)

Long-only, daily bars.
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def flight_to_safety(price_panel: pd.DataFrame, equity: str = "SPY",
                     safe_assets=("TLT", "GLD"), ma: int = 200,
                     weight_each: float = 0.5) -> pd.DataFrame:
    """Hold safe assets (bonds/gold) ONLY when equities are in a downtrend
    (SPY < 200d MA). Empty (cash) when equities trend up. Designed to be a
    risk-off hedge negatively correlated to equity trend."""
    px = price_panel
    w = pd.DataFrame(0.0, index=px.index, columns=px.columns)
    if equity not in px.columns:
        return w
    spy_sma = px[equity].rolling(ma).mean()
    risk_off = (px[equity] < spy_sma).fillna(False)
    for s in safe_assets:
        if s in px.columns:
            # only hold the safe asset if IT is also holding up (above its own 50d MA)
            safe_ok = (px[s] > px[s].rolling(50).mean()).fillna(False)
            w[s] = (risk_off & safe_ok).astype(float) * weight_each
    return w


def defensive_rotation(price_panel: pd.DataFrame, equity="SPY",
                       safe=("TLT", "GLD"), ma: int = 200) -> pd.DataFrame:
    """Risk-on/off rotation: hold equity when it's uptrending, else rotate to the
    safe asset that's holding up best. Always trying to be in SOMETHING that works."""
    px = price_panel
    w = pd.DataFrame(0.0, index=px.index, columns=px.columns)
    if equity not in px.columns:
        return w
    eq_up = (px[equity] > px[equity].rolling(ma).mean()).fillna(False)
    w[equity] = eq_up.astype(float)
    # when equity is down, split into safe assets that are above their own MA
    risk_off = ~eq_up
    for s in safe:
        if s in px.columns:
            safe_ok = (px[s] > px[s].rolling(50).mean()).fillna(False)
            w[s] = (risk_off & safe_ok).astype(float) * 0.5
    return w


def strategy_fts(price_panel, **kw): return flight_to_safety(price_panel, **kw)
def strategy_rot(price_panel, **kw): return defensive_rotation(price_panel, **kw)
