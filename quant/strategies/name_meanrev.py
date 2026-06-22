"""
name_meanrev.py — Single-name short-term mean-reversion sleeve.

The edge that's DEAD on index ETFs (we killed RSI-2 on SPY/QQQ) but historically
alive on INDIVIDUAL stocks: when a stock in a healthy uptrend gets sharply oversold,
it tends to bounce within a few days. Buying many such names spreads the bet.

Rules (Connors-style, long-only, daily bars):
  - UNIVERSE FILTER: only consider a name in a healthy uptrend (price > 200d SMA) —
    we buy dips in winners, never falling knives.
  - ENTRY: RSI(2) < entry_rsi (deeply oversold, e.g. < 5-10).
  - EXIT: RSI(2) > exit_rsi (e.g. > 50-60) OR a hard time stop (hold_max days) OR the
    name loses its uptrend.
  - SIZING: equal-weight across all currently-held names, capped so the sleeve's gross
    exposure <= max_gross and no single name exceeds max_weight. Vol-aware: scale a
    name down if it's unusually volatile.

This is mechanically a REVERSION strategy → should be uncorrelated (even negatively)
to the trend sleeves, which is the whole point. Fast: typical hold 2-8 days.

Long-only (fits Alpaca). Returns target weights for the engine.
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def rsi(series: pd.Series, period: int = 2) -> pd.Series:
    delta = series.diff()
    up = delta.clip(lower=0)
    down = -delta.clip(upper=0)
    roll_up = up.ewm(alpha=1/period, adjust=False).mean()
    roll_down = down.ewm(alpha=1/period, adjust=False).mean()
    rs = roll_up / roll_down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def compute_weights(
    price_panel: pd.DataFrame,
    symbols: list[str] | None = None,
    rsi_period: int = 2,
    entry_rsi: float = 10.0,
    exit_rsi: float = 50.0,
    trend_sma: int = 200,
    hold_max: int = 8,            # time stop (days) — keeps it fast
    target_vol: float = 0.30,     # per-name vol target for sizing
    max_weight: float = 0.10,     # cap any single name
    max_gross: float = 1.00,      # long-only, no leverage
    max_names: int = 10,          # cap concurrent positions (diversify, limit churn)
) -> pd.DataFrame:
    """Cross-sectional single-name RSI(2) mean reversion. Long/flat only."""
    px = price_panel.copy()
    if symbols is None:
        symbols = list(px.columns)
    symbols = [s for s in symbols if s in px.columns]

    rets = px.pct_change(fill_method=None)
    # EWMA vol for per-name sizing
    var = rets.pow(2).ewm(alpha=0.06, adjust=False).mean()
    vol = np.sqrt(var) * np.sqrt(252)

    weights = pd.DataFrame(0.0, index=px.index, columns=px.columns)

    # Precompute signals per name
    signal_pos = pd.DataFrame(0.0, index=px.index, columns=symbols)
    for s in symbols:
        p = px[s]
        if p.notna().sum() < trend_sma + 10:
            continue
        sma = p.rolling(trend_sma).mean()
        r = rsi(p, rsi_period)
        up = (p > sma).to_numpy()
        rvals = r.to_numpy()
        size = (target_vol / vol[s]).clip(upper=max_weight).fillna(0.0).to_numpy()

        pos = np.zeros(len(p))
        holding = False
        held_days = 0
        for i in range(len(p)):
            if np.isnan(rvals[i]):
                continue
            if not holding:
                if up[i] and rvals[i] < entry_rsi:
                    holding = True; held_days = 0
            else:
                held_days += 1
                if rvals[i] > exit_rsi or held_days >= hold_max or not up[i]:
                    holding = False
            pos[i] = size[i] if holding else 0.0
        signal_pos[s] = pos

    # --- Cap concurrent names: if more than max_names are signaled on a day, keep the
    #     most oversold ones (largest intended size as a proxy for conviction). ---
    raw = signal_pos.copy()
    n_active = (raw > 0).sum(axis=1)
    over_days = raw.index[n_active > max_names]
    for d in over_days:
        row = raw.loc[d]
        keep = row[row > 0].nlargest(max_names).index
        drop = [c for c in row[row > 0].index if c not in keep]
        raw.loc[d, drop] = 0.0

    # --- Gross cap (long-only) ---
    gross = raw.sum(axis=1)
    gscale = (max_gross / gross).clip(upper=1.0).replace([np.inf, np.nan], 1.0)
    scaled = raw.mul(gscale, axis=0)

    for s in symbols:
        weights[s] = scaled[s]
    return weights


def strategy(price_panel: pd.DataFrame, **kwargs) -> pd.DataFrame:
    return compute_weights(price_panel, **kwargs)
