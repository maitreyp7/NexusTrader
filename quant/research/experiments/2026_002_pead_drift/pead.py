"""
pead.py — Post-Earnings Announcement Drift strategy (long-only, daily bars).

Signal, per earnings event:
  1. EPS surprise >= min_surprise (company beat estimates), AND
  2. the market's reaction-day return >= min_react (the market confirms the beat).
Entry is the CLOSE of the reaction day (the engine's shift(1) applies it at the
next open) and the position is held for `hold_days` trading days.

No-look-ahead handling of announcement timing (conservative):
  - BMO (timestamp before noon ET): reaction day = the announcement date itself —
    the news is public before that open, so its close-to-close move IS the reaction.
  - AMC (timestamp noon or later): reaction day = the NEXT trading day.
  In both cases we only act on a close that happened strictly after the news was
  public, and we deliberately forfeit the reaction-day jump itself — we are testing
  for pure DRIFT, which is the tradable part.

strategy(panel, earnings=..., ...) -> weights DataFrame for engine.run_backtest.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def _reaction_positions(index: pd.DatetimeIndex, events: pd.DataFrame) -> list[tuple[int, float]]:
    """Map earnings timestamps to (position of reaction day in index, surprise)."""
    out = []
    for ts, row in events.iterrows():
        if pd.isna(row.get("eps_rep")):
            continue  # not reported yet (future event)
        ts = pd.Timestamp(ts)
        if ts.tzinfo is not None:
            ts = ts.tz_convert("America/New_York")
        day = pd.Timestamp(ts.date())
        bmo = ts.hour < 12
        # first trading day >= day (BMO) or > day (AMC)
        pos = index.searchsorted(day, side="left" if bmo else "right")
        if pos >= len(index):
            continue
        out.append((int(pos), float(row["surprise_pct"]) if pd.notna(row["surprise_pct"]) else np.nan))
    return out


def strategy(panel: pd.DataFrame, earnings: dict[str, pd.DataFrame] | None = None,
             hold_days: int = 20, min_surprise: float = 0.0, min_react: float = 0.02,
             max_weight: float = 0.10) -> pd.DataFrame:
    """Target weights: equal-weight all names in their post-earnings drift window,
    capped at max_weight per name, rest cash."""
    assert earnings, "pass earnings={sym: DataFrame} (see fetch_earnings.load_all)"
    idx = panel.index
    active = pd.DataFrame(False, index=idx, columns=panel.columns)

    for sym, ev in earnings.items():
        if sym not in panel.columns:
            continue
        px = panel[sym]
        for pos, surprise in _reaction_positions(idx, ev):
            if pos < 1:
                continue
            if pd.isna(surprise) or surprise < min_surprise:
                continue
            p0, p1 = px.iloc[pos - 1], px.iloc[pos]
            if pd.isna(p0) or pd.isna(p1) or p0 <= 0:
                continue
            react = p1 / p0 - 1.0
            if react < min_react:
                continue
            # signal on reaction-day close; hold for hold_days trading days
            active.iloc[pos: pos + hold_days, active.columns.get_loc(sym)] = True

    n = active.sum(axis=1)
    weights = active.div(n.where(n > 0, 1), axis=0).clip(upper=max_weight)
    return weights.fillna(0.0)
