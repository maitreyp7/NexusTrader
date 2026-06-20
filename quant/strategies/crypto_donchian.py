"""
crypto_donchian.py — Crypto "Donchian-extremes" combined trend + mean-reversion.

The #1 candidate from the deep-dive search. Both research dives independently ranked
this top for a FAST (days-to-2-week hold), crypto-focused, long-only strategy.

Idea (per QuantPedia BTC study): crypto exhibits BOTH effects at once —
  - MOMENTUM after new highs (trend continues), AND
  - BOUNCE after new lows (mean reversion).
So go long when EITHER happens:
  - close == max(close over last L days)  → breakout long (trend leg)
  - close == min(close over last L days)  → oversold long (reversion leg)
Hold until the position's logic expires (opposite extreme / time stop). Long-only
(fits Alpaca crypto spot). Vol-target sizing so wild coins don't dominate.

We test this HONESTLY: the cited Sharpe ~2 is in-sample on one asset. The gatekeeper
+ a train/test split will tell us if it's real.
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def compute_weights(
    price_panel: pd.DataFrame,
    symbols: list[str] | None = None,
    lookback: int = 10,            # Donchian window (short = matches crypto dynamics)
    hold_max: int = 10,            # max trading days to hold a position (time stop)
    target_vol: float = 0.50,      # crypto runs hot; 50% per-asset vol target
    max_weight: float = 0.34,      # cap any single coin
    max_gross: float = 1.00,       # long-only, no leverage
) -> pd.DataFrame:
    """Long when price hits an L-day high OR L-day low; hold up to hold_max days,
    exit early if opposite extreme. Vol-targeted, long-only."""
    px = price_panel.copy()
    if symbols is None:
        symbols = [c for c in px.columns if c.endswith("-USD")]

    rets = px.pct_change(fill_method=None)
    # EWMA vol for sizing (annualized, crypto uses 365)
    var = rets.pow(2).ewm(alpha=0.06, adjust=False).mean()
    vol = np.sqrt(var) * np.sqrt(365)

    weights = pd.DataFrame(0.0, index=px.index, columns=px.columns)

    for s in symbols:
        p = px[s].to_numpy()
        n = len(p)
        hi = px[s].rolling(lookback).max().to_numpy()
        lo = px[s].rolling(lookback).min().to_numpy()
        sizing = (target_vol / vol[s]).clip(upper=max_weight).fillna(0.0).to_numpy()

        pos = np.zeros(n)
        held = 0          # days held
        active = False
        for i in range(n):
            if np.isnan(hi[i]):
                continue
            new_high = p[i] >= hi[i]
            new_low = p[i] <= lo[i]
            if not active:
                if new_high or new_low:
                    active = True; held = 0
            else:
                held += 1
                # exit: time stop, or it hit the opposite extreme then faded
                if held >= hold_max:
                    active = False
            pos[i] = sizing[i] if active else 0.0
        weights[s] = pos

    # Gross cap (long-only): scale down if total > max_gross
    gross = weights.sum(axis=1)
    gscale = (max_gross / gross).clip(upper=1.0).replace([np.inf, np.nan], 1.0)
    weights = weights.mul(gscale, axis=0)
    return weights


def strategy(price_panel: pd.DataFrame, **kwargs) -> pd.DataFrame:
    return compute_weights(price_panel, **kwargs)
