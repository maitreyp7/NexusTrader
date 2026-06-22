"""
validate_regime.py — Backtest the combined 3-sleeve portfolio WITH vs WITHOUT
the VIX regime brain. This is the gate that decides whether to wire the brain in.

The regime brain scales TOTAL portfolio exposure down (toward cash) when the VIX
term structure is in backwardation (stress signal). It does NOT pick stocks —
it just says "less gas" in stormy conditions.

If regime-gating improves Sharpe OR meaningfully cuts drawdown without killing
CAGR → wire it in. If it barely moves the numbers → not worth the complexity.
"""

from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

import pandas as pd
import numpy as np
from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest, print_report
import trend, crypto_trend, flow, allocator
from strategies.regime import regime_on

ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))

MAX_PER_ASSET = 0.25
RISK_OFF_SCALE = 0.0   # 0 = go fully to cash in risk-off; 0.5 = half-size; test both


def get_combined_weights(panel: pd.DataFrame) -> pd.DataFrame:
    """Run the 3-sleeve brain and return combined target weights (no regime)."""
    panel = panel.ffill()
    w_t = trend.strategy(panel)
    w_c = crypto_trend.strategy(panel)
    w_m = flow.turn_of_month(panel)
    r_t = run_backtest(panel, w_t)["returns"]
    r_c = run_backtest(panel, w_c)["returns"]
    r_m = run_backtest(panel, w_m)["returns"]
    comb = allocator.combine(
        {"trend": w_t, "crypto": w_c, "tom": w_m},
        {"trend": r_t, "crypto": r_c, "tom": r_m},
        allocator.DEFAULT_CAPS,
    ) * allocator.DEFAULT_LEVERAGE
    comb = comb.clip(upper=MAX_PER_ASSET)
    return comb


def apply_regime_gate(weights: pd.DataFrame, panel: pd.DataFrame,
                      risk_off_scale: float = 0.0) -> pd.DataFrame:
    """Scale portfolio weights by regime signal.
    risk_off_scale=0.0 → fully cash in risk-off; 0.5 → half size in risk-off.
    """
    vix_bars  = get_bars("VIX")
    vix3m_bars = get_bars("VIX3M")

    vix  = vix_bars["close"].rename("VIX")
    vix3m = vix3m_bars["close"].rename("VIX3M")

    # Align to the portfolio's date index
    idx = weights.index
    vix_aligned  = vix.reindex(idx).ffill()
    vix3m_aligned = vix3m.reindex(idx).ffill()

    on = regime_on(vix_aligned, vix3m_aligned)  # True = risk-on, False = risk-off
    scale = on.map({True: 1.0, False: risk_off_scale}).fillna(1.0)

    return weights.mul(scale, axis=0)


def print_side_by_side(res_base, res_regime_0, res_regime_half):
    print("\n" + "=" * 72)
    print("  REGIME BRAIN VALIDATION — Portfolio WITH vs WITHOUT gating")
    print("=" * 72)
    fmt = "  {:<22} {:>10} {:>15} {:>15}"
    print(fmt.format("Metric", "No regime", "Regime (go cash)", "Regime (half-size)"))
    print("  " + "-" * 62)

    def r(res):
        return res

    metrics = [
        ("CAGR %/yr", lambda r: f"{r['cagr']*100:+.2f}%"),
        ("Sharpe",     lambda r: f"{r['sharpe']:.3f}"),
        ("Max Drawdown", lambda r: f"{r['max_dd']*100:.1f}%"),
        ("Volatility", lambda r: f"{r['vol']*100:.1f}%"),
        ("Profit Factor", lambda r: f"{r['profit_factor']:.2f}"),
        ("Avg Exposure", lambda r: f"{r['avg_exposure']*100:.0f}%"),
    ]
    for name, fn in metrics:
        print(fmt.format(name, fn(res_base), fn(res_regime_0), fn(res_regime_half)))
    print()


def regime_stats(weights_base, weights_regime, panel):
    """Show how often the regime gates us out and impact on trade frequency."""
    # days regime is on vs off
    vix = get_bars("VIX")["close"].reindex(weights_base.index).ffill()
    vix3m = get_bars("VIX3M")["close"].reindex(weights_base.index).ffill()
    on = regime_on(vix, vix3m)
    total = len(on.dropna())
    risk_on_pct = on.mean() * 100
    print(f"\n  Regime brain stats (over full backtest history):")
    print(f"    Risk-ON  : {risk_on_pct:.0f}% of trading days → full exposure")
    print(f"    Risk-OFF : {100-risk_on_pct:.0f}% of trading days → scaled down/cash")
    print(f"    (VIX data from {vix.dropna().index[0].date()} to {vix.dropna().index[-1].date()})")
    print(f"    (VIX3M from  {vix3m.dropna().index[0].date()} to {vix3m.dropna().index[-1].date()})")

    # Show worst drawdown periods and whether regime was warning
    print(f"\n  Checking regime signal around 5 worst historical drawdowns...")
    panel_ffill = panel.ffill()
    spy = panel_ffill.get("SPY", pd.Series(dtype=float))
    if len(spy) > 0:
        spy_dd = (spy / spy.cummax() - 1)
        # find 5 worst monthly drawdown points
        monthly_min = spy_dd.resample("ME").min().nsmallest(5)
        for dt_, dd in monthly_min.items():
            if pd.isna(dt_): continue
            window = on.loc[dt_ - pd.Timedelta(days=30): dt_]
            off_pct = (~window).mean() * 100 if len(window) > 0 else float("nan")
            print(f"    {str(dt_.date())[:7]}  SPY DD {dd*100:.1f}%  |  regime said RISK-OFF {off_pct:.0f}% of prior 30d")


if __name__ == "__main__":
    print("Loading data and running backtest...")
    bars = get_universe(ALL)
    vix_bars  = get_bars("VIX")
    vix3m_bars = get_bars("VIX3M")
    bars["VIX"]   = vix_bars
    bars["VIX3M"] = vix3m_bars
    panel = build_price_panel(bars)

    print("Computing combined weights (no regime)...")
    weights_base = get_combined_weights(panel)

    print("Applying regime gate (fully cash in risk-off)...")
    weights_regime_0    = apply_regime_gate(weights_base, panel, risk_off_scale=0.0)

    print("Applying regime gate (half-size in risk-off)...")
    weights_regime_half = apply_regime_gate(weights_base, panel, risk_off_scale=0.5)

    print("Running backtests...")
    res_base        = run_backtest(panel, weights_base)
    res_regime_0    = run_backtest(panel, weights_regime_0)
    res_regime_half = run_backtest(panel, weights_regime_half)

    print_side_by_side(res_base, res_regime_0, res_regime_half)
    regime_stats(weights_base, weights_regime_0, panel)

    print("\n  Detailed: NO REGIME")
    print_report(res_base, "Combined portfolio (no regime)")

    print("\n  Detailed: REGIME — FULLY CASH in risk-off")
    print_report(res_regime_0, "Combined portfolio + regime (cash in risk-off)")

    print("\n  Detailed: REGIME — HALF-SIZE in risk-off")
    print_report(res_regime_half, "Combined portfolio + regime (half-size in risk-off)")

    print("\n" + "=" * 72)
    # Decision logic
    sharpe_gain_0    = res_regime_0["sharpe"]    - res_base["sharpe"]
    sharpe_gain_half = res_regime_half["sharpe"] - res_base["sharpe"]
    dd_cut_0         = res_regime_0["max_dd"]    - res_base["max_dd"]   # negative = better
    dd_cut_half      = res_regime_half["max_dd"] - res_base["max_dd"]

    print("  VERDICT:")
    print(f"    Go-cash version : Sharpe {'+' if sharpe_gain_0>=0 else ''}{sharpe_gain_0:.3f}  |  DD change {dd_cut_0*100:+.1f}%")
    print(f"    Half-size version: Sharpe {'+' if sharpe_gain_half>=0 else ''}{sharpe_gain_half:.3f}  |  DD change {dd_cut_half*100:+.1f}%")
    best = "go-cash" if res_regime_0["sharpe"] >= res_regime_half["sharpe"] else "half-size"
    cagr_cost = (res_regime_0 if best == "go-cash" else res_regime_half)["cagr"] - res_base["cagr"]
    print(f"    Best config: {best}  |  CAGR cost: {cagr_cost*100:+.2f}%/yr")

    verdict = (
        (sharpe_gain_0 > 0.05 or dd_cut_0 < -0.03) and
        res_regime_0["cagr"] > res_base["cagr"] * 0.80
    )
    print(f"\n  → WIRE IN REGIME BRAIN? {'YES — clear improvement' if verdict else 'MARGINAL — inspect the numbers'}")
    print("=" * 72)
