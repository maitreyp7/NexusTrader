"""
calendar.py — Flow/calendar sleeves (structurally durable, fast, uncorrelated to trend).

These edges come from institutional PLUMBING (pension inflows, Fed cycle), not from
statistical anomalies — so they decay slowly and don't get arbitraged away the way
mean-reversion did. They're fast (hold a few days) and should be UNCORRELATED to
trend-following, which is what makes them valuable in a portfolio.

  1. turn_of_month: long SPY from the last trading day of the month through the
     first ~3 trading days (pension/401k inflows reinvested at month-end).
  2. fomc_drift: long SPY in the day(s) before scheduled FOMC announcements
     (documented pre-FOMC drift). [Needs an FOMC date list — approximated below.]

Long-only, daily bars. Returns target weights for the engine.
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def turn_of_month(price_panel: pd.DataFrame, symbol: str = "SPY",
                  days_before: int = 1, days_after: int = 3,
                  weight: float = 1.0) -> pd.DataFrame:
    """Long `symbol` across the turn-of-month window: from `days_before` trading
    days before month-end through `days_after` trading days into the new month."""
    px = price_panel
    w = pd.DataFrame(0.0, index=px.index, columns=px.columns)
    if symbol not in px.columns:
        return w

    idx = px.index
    # group trading days by (year, month); the last rows of each group = month end
    months = pd.Series(idx, index=idx).groupby([idx.year, idx.month])
    on = pd.Series(False, index=idx)

    month_list = [g.index for _, g in months]
    for k, days in enumerate(month_list):
        # last `days_before` days of THIS month
        for d in days[-days_before:]:
            on[d] = True
        # first `days_after` days of NEXT month
        if k + 1 < len(month_list):
            for d in month_list[k + 1][:days_after]:
                on[d] = True

    w[symbol] = on.astype(float) * weight
    return w


# Scheduled FOMC meeting dates (announcement day) 2010-2026. Pre-FOMC drift = hold
# the day BEFORE these. (Public schedule; extend as needed.)
FOMC_DATES = [
    # 2015-2026 announcement days (approx, 2nd day of each 2-day meeting)
    "2015-01-28","2015-03-18","2015-04-29","2015-06-17","2015-07-29","2015-09-17","2015-10-28","2015-12-16",
    "2016-01-27","2016-03-16","2016-04-27","2016-06-15","2016-07-27","2016-09-21","2016-11-02","2016-12-14",
    "2017-02-01","2017-03-15","2017-05-03","2017-06-14","2017-07-26","2017-09-20","2017-11-01","2017-12-13",
    "2018-01-31","2018-03-21","2018-05-02","2018-06-13","2018-08-01","2018-09-26","2018-11-08","2018-12-19",
    "2019-01-30","2019-03-20","2019-05-01","2019-06-19","2019-07-31","2019-09-18","2019-10-30","2019-12-11",
    "2020-01-29","2020-03-18","2020-04-29","2020-06-10","2020-07-29","2020-09-16","2020-11-05","2020-12-16",
    "2021-01-27","2021-03-17","2021-04-28","2021-06-16","2021-07-28","2021-09-22","2021-11-03","2021-12-15",
    "2022-01-26","2022-03-16","2022-05-04","2022-06-15","2022-07-27","2022-09-21","2022-11-02","2022-12-14",
    "2023-02-01","2023-03-22","2023-05-03","2023-06-14","2023-07-26","2023-09-20","2023-11-01","2023-12-13",
    "2024-01-31","2024-03-20","2024-05-01","2024-06-12","2024-07-31","2024-09-18","2024-11-07","2024-12-18",
    "2025-01-29","2025-03-19","2025-05-07","2025-06-18","2025-07-30","2025-09-17","2025-11-05","2025-12-17",
    "2026-01-28","2026-03-18","2026-04-29","2026-06-17",
]


def fomc_drift(price_panel: pd.DataFrame, symbol: str = "SPY",
               days_before: int = 1, weight: float = 1.0) -> pd.DataFrame:
    """Long `symbol` the `days_before` trading days leading into each FOMC announcement."""
    px = price_panel
    w = pd.DataFrame(0.0, index=px.index, columns=px.columns)
    if symbol not in px.columns:
        return w
    idx = px.index
    on = pd.Series(False, index=idx)
    fomc = pd.to_datetime(FOMC_DATES)
    for dt in fomc:
        # find the position of the FOMC day (or the next trading day) and flag the days before
        pos = idx.searchsorted(dt)
        for j in range(1, days_before + 1):
            if 0 <= pos - j < len(idx):
                on[idx[pos - j]] = True
    w[symbol] = on.astype(float) * weight
    return w


def strategy_tom(price_panel, **kw):  return turn_of_month(price_panel, **kw)
def strategy_fomc(price_panel, **kw): return fomc_drift(price_panel, **kw)
