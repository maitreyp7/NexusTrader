"""
lowvol.py — Low-volatility tilt (Bot #3 strategy).

The low-volatility anomaly: investors overpay for lottery-like high-vol stocks and
shun boring ones (leverage constraints + lottery preference), so low-vol names earn
more per unit of risk. Documented since the 1970s; survives because the cause is
behavioral/structural, not a data-mined quirk.

Rules (validated 2026-06-30, DO NOT tune — see 2026_001_lowvol_tilt/report.md):
  1. Universe: STOCK_UNIVERSE (~150 large caps).
  2. Signal: 126-day (6-month) realized volatility of daily returns, per name.
  3. Portfolio: on the LAST trading day of each month, go long the n=15 LOWEST-vol
     names, equal weight (1/15 each). Hold unchanged until next month-end.
  4. No other signals — no stops, no momentum filter, no discretion.

Validated standalone: Sharpe 1.048, CAGR +13.1%, survives 2x costs (1.041),
18/19 eras positive, DSR 1.0, robust plateau n=10..25. Standalone MaxDD -47.8%
(1973-75) — acceptable only because it's ~15% of the account and improves the
SYSTEM's drawdown (blend -11.5% -> -10.1%).

Ported VERBATIM from research/experiments/hunt_more_free.py::low_vol, plus an
`exclude` set: excluded symbols get weight 0 and the next-lowest-vol name takes
the slot (used at runtime to avoid holding a name the mean-rev bot already owns —
see the ownership ledger in lowvol_runner.py). The exclude effect on the backtest
is negligible (mean-rev holds <=10 names for 2-10 days).
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def compute_weights(stock_panel: pd.DataFrame, n: int = 15, exclude: set | None = None) -> pd.DataFrame:
    """Monthly-rebalanced equal-weight long of the n lowest-126d-vol names.
    `exclude` symbols are skipped; the next-lowest-vol names fill the n slots."""
    exclude = exclude or set()
    px = stock_panel
    rets = px.pct_change(fill_method=None)
    vol = rets.rolling(126).std()   # 6-month realized vol
    w = pd.DataFrame(np.nan, index=px.index, columns=px.columns)
    idx = px.index.to_series()
    is_rebal = (idx == idx.groupby([idx.index.year, idx.index.month]).transform("max"))
    for d in px.index[is_rebal.to_numpy()]:
        row = vol.loc[d].dropna()
        if exclude:
            row = row[~row.index.isin(exclude)]   # drop excluded, next-lowest fills in
        if len(row) >= n:
            w.loc[d, :] = 0.0
            for c in row.nsmallest(n).index:      # LOWEST vol names
                w.loc[d, c] = 1.0 / n
    return w.ffill().fillna(0.0)


def strategy(stock_panel: pd.DataFrame, n: int = 15, exclude: set | None = None) -> pd.DataFrame:
    return compute_weights(stock_panel, n=n, exclude=exclude)
