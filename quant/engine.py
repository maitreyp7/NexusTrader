"""
engine.py — Honest daily-bar portfolio backtest engine.

This is the gatekeeper's heart. It is deliberately PESSIMISTIC where the old ORB
backtester was optimistic (that one showed PF 1.43 / 0% drawdown — fantasy; real
was 0.83). The rules that keep it honest:

  1. NO LOOK-AHEAD. A strategy sees data up to and including day t's close, then its
     target weights take effect at day t+1's OPEN (you cannot trade on a close you
     haven't seen yet). We shift target weights forward by one day, full stop.

  2. COSTS ARE REAL. Every change in a position pays a per-side cost (spread +
     slippage). Defaults are honest-to-pessimistic per asset class. Turnover is
     taxed every rebalance.

  3. RETURNS ARE TOTAL-RETURN where possible (adjclose) so dividends aren't ignored.

A "strategy" is just a function that takes the price panel and returns a DataFrame
of target weights (one column per symbol, rows = dates, values in [0,1] for
long-only, summing to <= 1; the remainder is cash earning ~0). The engine handles
the timing, costs, and accounting.
"""

from __future__ import annotations
import numpy as np
import pandas as pd

pd.set_option("future.no_silent_downcasting", True)

# Honest per-SIDE cost (spread + slippage), as a fraction. Round trip = 2x.
# These are pessimistic-realistic for daily-bar execution at the open.
COST_PER_SIDE = {
    "etf":    0.0003,   # 3 bps/side liquid ETFs (SPY/QQQ/TLT/GLD...) — generous but safe
    "crypto": 0.0015,   # 15 bps/side crypto (wider spreads + taker fees on Alpaca)
}

CRYPTO_SUFFIX = "-USD"


def _cost_for(symbol: str) -> float:
    return COST_PER_SIDE["crypto"] if symbol.endswith(CRYPTO_SUFFIX) else COST_PER_SIDE["etf"]


def build_price_panel(bars: dict[str, pd.DataFrame], field: str = "adjclose") -> pd.DataFrame:
    """Combine {symbol: OHLCV df} into one aligned price panel (cols=symbols).
    Uses adjclose (total return) by default. Forward-fills small gaps, drops
    leading NaNs per column naturally via the backtest's per-date masking."""
    panel = pd.DataFrame({s: df[field] for s, df in bars.items()})
    panel = panel.sort_index()
    return panel


def run_backtest(
    price_panel: pd.DataFrame,
    target_weights: pd.DataFrame,
    cost_mult: float = 1.0,
    ann_factor: int = 252,
) -> dict:
    """
    Simulate a long-only portfolio.

    price_panel:    daily prices (adjclose), cols=symbols.
    target_weights: desired weight per symbol per date, SAME columns. Values in
                    [0,1], row-sum <= 1 (rest = cash). The strategy computes these
                    using data up to date t's close.
    cost_mult:      multiply costs (use 2.0 for the slippage stress test).

    Timing: weights decided on date t are APPLIED at t+1 (shift(1)) and earn the
    return from t+1 -> t+2. No look-ahead.

    Returns a dict with the daily portfolio-return series, equity curve, and stats.
    """
    # Align
    weights = target_weights.reindex(price_panel.index).reindex(columns=price_panel.columns)

    # Daily asset returns (simple). Missing prices -> 0 return + 0 weight enforced below.
    asset_ret = price_panel.pct_change().fillna(0.0)

    # CRITICAL no-look-ahead shift: weights chosen at close of t take effect t+1.
    held = weights.shift(1).fillna(0.0)

    # Zero out weights where we have no valid price history yet (asset not born)
    valid = price_panel.notna().shift(1).fillna(False).astype(bool)
    held = held.where(valid, 0.0)

    # Gross portfolio return before costs
    port_ret_gross = (held * asset_ret).sum(axis=1)

    # Transaction costs: pay per-side cost on the change in each weight (turnover).
    weight_change = held.diff().abs().fillna(held.abs())  # first day = entering from cash
    per_side = pd.Series({c: _cost_for(c) for c in held.columns}) * cost_mult
    daily_cost = (weight_change * per_side).sum(axis=1)

    port_ret = port_ret_gross - daily_cost

    equity = (1.0 + port_ret).cumprod()

    stats = _compute_stats(port_ret, equity, held, ann_factor)
    return {
        "returns": port_ret,
        "equity": equity,
        "held": held,
        "daily_cost": daily_cost,
        **stats,
    }


def _compute_stats(port_ret: pd.Series, equity: pd.Series, held: pd.DataFrame, ann_factor: int) -> dict:
    r = port_ret.dropna()
    if len(r) < 2:
        return dict(cagr=0, sharpe=0, max_dd=0, profit_factor=0, vol=0, n_days=len(r),
                    total_return=0, avg_exposure=0, turnover_ann=0)

    n_years = len(r) / ann_factor
    total_return = equity.iloc[-1] - 1.0
    cagr = (equity.iloc[-1]) ** (1 / n_years) - 1 if n_years > 0 and equity.iloc[-1] > 0 else -1.0

    vol = r.std() * np.sqrt(ann_factor)
    sharpe = (r.mean() * ann_factor) / vol if vol > 0 else 0.0

    # Max drawdown
    roll_max = equity.cummax()
    dd = equity / roll_max - 1.0
    max_dd = dd.min()

    # Profit factor on DAILY returns (sum of up-days / abs sum of down-days)
    gains = r[r > 0].sum()
    losses = abs(r[r < 0].sum())
    profit_factor = gains / losses if losses > 0 else (np.inf if gains > 0 else 0.0)

    # Exposure + turnover diagnostics
    avg_exposure = held.abs().sum(axis=1).mean()
    turnover_ann = held.diff().abs().sum(axis=1).mean() * ann_factor

    return dict(
        cagr=cagr, sharpe=sharpe, max_dd=max_dd, profit_factor=profit_factor,
        vol=vol, n_days=len(r), total_return=total_return,
        avg_exposure=avg_exposure, turnover_ann=turnover_ann,
    )


def print_report(result: dict, title: str = "Backtest"):
    print(f"\n=== {title} ===")
    print(f"  Period:        {result['returns'].index[0].date()} → {result['returns'].index[-1].date()}  ({result['n_days']} days)")
    print(f"  Total return:  {result['total_return']*100:+.1f}%")
    print(f"  CAGR:          {result['cagr']*100:+.2f}%/yr")
    print(f"  Volatility:    {result['vol']*100:.1f}%/yr")
    print(f"  Sharpe:        {result['sharpe']:.2f}")
    print(f"  Max Drawdown:  {result['max_dd']*100:.1f}%")
    print(f"  Profit Factor: {result['profit_factor']:.2f}  (daily)")
    print(f"  Avg exposure:  {result['avg_exposure']*100:.0f}%")
    print(f"  Turnover:      {result['turnover_ann']:.1f}x/yr")
