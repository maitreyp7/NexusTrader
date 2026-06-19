"""
trend.py — Multi-asset trend-following strategy (Strategy #1).

The most documented edge in finance (positive every decade since 1880). Plain idea:
own assets that are trending up, sit in cash on the rest, size by volatility so no
single asset dominates risk. Rebalance monthly.

Signal (long/flat only — no shorts, fits Alpaca crypto spot constraint):
  Hold asset i when BOTH:
    (1) 12-month (252d) total return > 0        [MOP/AQR core signal]
    (2) price > 200-day SMA                       [slow-trend confirmation]
  else weight 0 (cash).

Sizing — volatility targeting (per STRATEGY_SPEC):
  raw_weight_i = target_vol_per_asset / realized_vol_i   (EWMA vol, lambda=0.94)
  cap each weight, then scale so gross <= max_gross (long-only, no leverage).

Returns a target-weight DataFrame the engine consumes. The strategy only ever uses
data up to date t (the engine handles the t->t+1 execution shift), so no look-ahead.
"""

from __future__ import annotations
import numpy as np
import pandas as pd


def ewma_vol(returns: pd.DataFrame, lam: float = 0.94, ann: int = 252) -> pd.DataFrame:
    """Annualized EWMA volatility (RiskMetrics). lambda=0.94 ~ 20-day half-life."""
    var = returns.pow(2).ewm(alpha=(1 - lam), adjust=False).mean()
    return np.sqrt(var) * np.sqrt(ann)


def compute_weights(
    price_panel: pd.DataFrame,
    mom_lookback: int = 252,     # 12 months
    sma_lookback: int = 200,     # 200-day trend filter
    target_vol: float = 0.10,    # 10% annualized vol per asset
    max_weight: float = 0.25,    # cap any single asset at 25%
    max_gross: float = 1.00,     # long-only, no leverage
    crypto_risk_cap: float = 0.20,  # crypto sleeve <= 20% of gross
) -> pd.DataFrame:
    """Return monthly-rebalanced target weights. Long/flat only."""
    px = price_panel.copy()
    rets = px.pct_change(fill_method=None)

    # --- Signal components (all use only past/current data) ---
    mom = px.pct_change(mom_lookback, fill_method=None)  # trailing 12m return
    sma = px.rolling(sma_lookback).mean()
    in_trend = (mom > 0) & (px > sma)                  # both conditions

    # --- Vol targeting ---
    vol = ewma_vol(rets)
    raw_w = (target_vol / vol).clip(upper=max_weight)  # bigger size for calmer assets
    raw_w = raw_w.where(in_trend, 0.0).fillna(0.0)

    # --- Crypto sleeve cap: limit total crypto weight ---
    crypto_cols = [c for c in px.columns if c.endswith("-USD")]
    if crypto_cols:
        crypto_sum = raw_w[crypto_cols].sum(axis=1)
        scale = (crypto_risk_cap / crypto_sum).clip(upper=1.0).replace([np.inf, np.nan], 1.0)
        for c in crypto_cols:
            raw_w[c] = raw_w[c] * scale

    # --- Gross exposure cap (scale down if total > max_gross) ---
    gross = raw_w.sum(axis=1)
    gscale = (max_gross / gross).clip(upper=1.0).replace([np.inf, np.nan], 1.0)
    weights = raw_w.mul(gscale, axis=0)

    # --- Apply only on rebalance dates; hold weights between rebalances ---
    # Rebalance on the last trading day of each month: keep weights on those dates,
    # NaN elsewhere, then forward-fill so positions are held between rebalances.
    idx = weights.index.to_series()
    last_of_month = idx.groupby([idx.index.year, idx.index.month]).transform("max")
    is_rebal = (idx == last_of_month).to_numpy()      # 1D bool per date

    masked = weights.copy()
    masked[~is_rebal] = np.nan                         # broadcasts row-mask across cols
    monthly = masked.ffill().fillna(0.0)
    return monthly


# Strategy registry entry: name -> callable(price_panel) -> weights
def strategy(price_panel: pd.DataFrame, **kwargs) -> pd.DataFrame:
    return compute_weights(price_panel, **kwargs)
