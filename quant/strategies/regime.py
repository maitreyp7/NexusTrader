"""
regime.py — Volatility-regime brain (the PM's "trade the second derivative").

This does NOT predict price. It classifies the market environment as RISK-ON
(benign/calm — mean-reversion and risk-taking work) vs RISK-OFF (stressed —
fast strategies get killed, go to cash). It's the switch that gates the sleeves.

Signals (all free daily data, no options):
  1. VIX term structure: VIX / VIX3M.
       < ~1.0  = contango  = calm/risk-on   (near-term fear below long-term)
       > 1.0   = backwardation = stress/risk-off (acute near-term fear)
     This preceded 21 of 22 S&P drawdowns >5% (2004-2025).
  2. VIX level vs its own recent normal (is vol elevated?).

We combine them into a simple, robust RISK-ON boolean per day. Deliberately NOT
over-tuned — the research says regime *mechanisms* are robust but exact magnitudes
overfit easily.

Usage: regime_on(vix, vix3m) -> boolean Series (True = risk-on / OK to trade fast sleeves).
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def term_structure_ratio(vix: pd.Series, vix3m: pd.Series) -> pd.Series:
    """VIX / VIX3M, aligned. <1 = contango (calm), >1 = backwardation (stress)."""
    df = pd.concat([vix.rename("vix"), vix3m.rename("vix3m")], axis=1).dropna()
    return (df["vix"] / df["vix3m"]).reindex(vix.index)


def regime_on(
    vix: pd.Series,
    vix3m: pd.Series,
    ts_threshold: float = 1.0,      # term-structure switch (contango if below)
    vix_lookback: int = 252,        # 1yr window for "elevated" check
    vix_quantile: float = 0.80,     # vol above its 80th pct = elevated/stress
) -> pd.Series:
    """Return a boolean Series: True = RISK-ON (calm regime, fast sleeves allowed).

    RISK-ON when BOTH:
      - term structure in contango (VIX/VIX3M < threshold), AND
      - VIX is not extreme (below its trailing high-quantile).
    Either condition failing -> RISK-OFF (sit out).
    """
    ts = term_structure_ratio(vix, vix3m)
    contango = ts < ts_threshold

    vix_hi = vix.rolling(vix_lookback, min_periods=60).quantile(vix_quantile)
    not_extreme = vix < vix_hi

    on = (contango & not_extreme)
    # Before VIX3M exists (pre-2006), fall back to the level check alone so we
    # don't blank the whole early history.
    on = on.where(ts.notna(), not_extreme)
    return on.fillna(False).astype(bool)


def diagnostics(vix: pd.Series, vix3m: pd.Series) -> None:
    on = regime_on(vix, vix3m)
    ts = term_structure_ratio(vix, vix3m)
    print(f"  Regime data: {on.index[0].date()} -> {on.index[-1].date()}  ({len(on)} days)")
    print(f"  Risk-ON share of days: {on.mean()*100:.0f}%   (rest = risk-off / sit out)")
    print(f"  Backwardation (VIX>VIX3M) share: {(ts>1).mean()*100:.0f}% of days with data")
