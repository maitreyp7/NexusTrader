"""
meanrev.py — Mean-reversion sleeve (the video's core idea, tested honestly).

The video: "for S&P and NASDAQ run mean reversion." The classic, most-documented
retail mean-reversion rule (Connors RSI-2 style) on index ETFs:

  - Only trade LONG when price is in an uptrend (above 200-day SMA) — buy dips, not falling knives.
  - ENTER long when the asset is oversold: RSI(2) < threshold (e.g. 10).
  - EXIT when it reverts: price closes above its short MA, or RSI recovers.

This is the honest daily-bar version. The video uses 15-min candles, which we can't
validate on 33yr of data (intraday history is short + the regime that fooled ORB).
If the *daily* version has no edge, the 15-min version almost certainly doesn't
either (more trades = more cost, same signal).

Long/flat only. Returns target weights for the engine.
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def rsi(series: pd.Series, period: int = 2) -> pd.Series:
    """Wilder-style RSI over `period` days."""
    delta = series.diff()
    up = delta.clip(lower=0)
    down = -delta.clip(upper=0)
    roll_up = up.ewm(alpha=1/period, adjust=False).mean()
    roll_down = down.ewm(alpha=1/period, adjust=False).mean()
    rs = roll_up / roll_down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def compute_weights(
    price_panel: pd.DataFrame,
    symbols: list[str] | None = None,   # which assets to mean-revert (indices)
    rsi_period: int = 2,
    entry_rsi: float = 10.0,            # oversold entry
    exit_rsi: float = 60.0,            # revert exit
    trend_sma: int = 200,              # only buy dips in uptrends
    weight_each: float = 0.5,          # weight per position when in
) -> pd.DataFrame:
    """Connors-style RSI(2) mean reversion on the chosen index ETFs."""
    px = price_panel.copy()
    if symbols is None:
        symbols = [s for s in ["SPY", "QQQ", "IWM"] if s in px.columns]

    weights = pd.DataFrame(0.0, index=px.index, columns=px.columns)

    for s in symbols:
        p = px[s]
        sma = p.rolling(trend_sma).mean()
        r = rsi(p, rsi_period)

        in_uptrend = p > sma
        # State machine: enter when oversold in uptrend, hold until revert.
        pos = np.zeros(len(p))
        holding = False
        rvals = r.to_numpy()
        up = in_uptrend.to_numpy()
        for i in range(len(p)):
            if not holding:
                if up[i] and rvals[i] < entry_rsi:
                    holding = True
            else:
                if rvals[i] > exit_rsi or not up[i]:
                    holding = False
            pos[i] = weight_each if holding else 0.0
        weights[s] = pos

    return weights


def strategy(price_panel: pd.DataFrame, **kwargs) -> pd.DataFrame:
    return compute_weights(price_panel, **kwargs)
