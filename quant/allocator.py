"""
allocator.py — The brain. Combines validated sleeves into ONE portfolio.

This is the "smart brain that knows when to run what and never lets them interfere."
The way it guarantees no interference: every sleeve outputs TARGET WEIGHTS into one
shared portfolio. The allocator doesn't run bots that fight over an account — it sums
each sleeve's requested positions, applies risk budgeting + caps, and produces ONE
clean set of target weights. There is structurally nothing to "conflict."

What the brain does (the institutional pod model, solo-adapted):
  1. RISK-BUDGET each sleeve by inverse volatility (equal risk contribution), so a
     wild sleeve (crypto) doesn't dominate a calm one (turn-of-month).
  2. Apply a hard CAP per sleeve (e.g. crypto <= 20%) — the "never blow up on one bet".
  3. Each sleeve is its own capital bucket on its own assets, so by construction they
     don't trade the same position against each other.
  4. VIX REGIME BRAIN: scale total exposure down when VIX term structure flips to
     backwardation (acute stress signal). Validated: +0.12 Sharpe, -10pp drawdown,
     only -0.14%/yr CAGR cost. Go fully to cash in risk-off (22% of days historically).

Returns one combined target-weight DataFrame the engine runs as a single portfolio.
"""

from __future__ import annotations
import numpy as np
import pandas as pd

# ── CHOSEN LIVE CONFIG (locked 2026-06-21, regime added 2026-06-22) ─────────
# Moderate-aggressive + regime gating.
# Backtest (33yr): Sharpe 0.82, CAGR +6.0%/yr, MaxDD -16.9% (vs -26.8% without).
DEFAULT_CAPS = {"trend": 0.80, "crypto": 0.35, "tom": 0.30}
DEFAULT_LEVERAGE = 2.0   # exposure multiplier (applied then clipped to 100%/asset)

# Regime config: RISK-OFF scale factor. 0.0 = fully cash in stress, 0.5 = half-size.
# Backtest says go-cash is superior (Sharpe 0.82 vs 0.80 for half-size).
REGIME_RISK_OFF_SCALE = 0.0


def apply_regime_gate(
    weights: pd.DataFrame,
    vix: pd.Series,
    vix3m: pd.Series,
    risk_off_scale: float = REGIME_RISK_OFF_SCALE,
) -> pd.DataFrame:
    """Scale portfolio weights by the VIX regime signal.

    Risk-ON  (VIX contango + not extreme) → scale = 1.0 (full exposure).
    Risk-OFF (VIX backwardation or extreme) → scale = risk_off_scale (default: cash).

    VIX3M only available from 2006. Before that, falls back to VIX-level-only check
    (already handled inside regime_on). Pass pre-aligned (reindexed + ffilled) series.
    """
    from strategies.regime import regime_on
    on = regime_on(vix, vix3m)
    scale = on.map({True: 1.0, False: risk_off_scale}).fillna(1.0)
    return weights.mul(scale.reindex(weights.index).fillna(1.0), axis=0)


def _sleeve_vol(returns: pd.Series, window: int = 60, ann: int = 252) -> pd.Series:
    """Trailing annualized vol of a sleeve's return stream (for risk budgeting)."""
    return returns.rolling(window, min_periods=20).std() * np.sqrt(ann)


def combine(
    sleeve_weights: dict[str, pd.DataFrame],   # name -> target weights (cols=all assets)
    sleeve_returns: dict[str, pd.Series],      # name -> daily return stream (for risk budget)
    sleeve_caps: dict[str, float],             # name -> max fraction of portfolio
    target_portfolio_vol: float = 0.12,        # 12% annualized portfolio vol target
    index: pd.DatetimeIndex | None = None,
) -> pd.DataFrame:
    """Combine sleeves into one portfolio via inverse-vol risk budgeting + caps.

    Each sleeve gets a capital fraction ~ (1/its_vol), normalized, then clipped to
    its cap. The sleeve's own internal weights are scaled by that fraction. Summing
    across sleeves gives the final per-asset target weights.
    """
    # Master date + asset index
    if index is None:
        index = sorted(set().union(*[w.index for w in sleeve_weights.values()]))
        index = pd.DatetimeIndex(index)
    all_assets = sorted(set().union(*[w.columns for w in sleeve_weights.values()]))

    names = list(sleeve_weights.keys())

    # --- inverse-vol risk budget per sleeve (time-varying) ---
    vols = pd.DataFrame({n: _sleeve_vol(sleeve_returns[n]).reindex(index).ffill()
                         for n in names})
    inv = 1.0 / vols.replace(0, np.nan)
    inv = inv.fillna(0.0)
    budget = inv.div(inv.sum(axis=1).replace(0, np.nan), axis=0).fillna(0.0)

    # apply per-sleeve caps, then renormalize so total <= 1
    for n in names:
        budget[n] = budget[n].clip(upper=sleeve_caps.get(n, 1.0))
    tot = budget.sum(axis=1)
    over = tot > 1.0
    budget.loc[over] = budget.loc[over].div(tot[over], axis=0)

    # --- build combined per-asset weights ---
    combined = pd.DataFrame(0.0, index=index, columns=all_assets)
    for n in names:
        w = sleeve_weights[n].reindex(index).reindex(columns=all_assets).fillna(0.0)
        # scale this sleeve's internal weights by its capital budget
        combined = combined.add(w.mul(budget[n], axis=0), fill_value=0.0)

    return combined
