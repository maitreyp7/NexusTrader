"""
validate_leverage.py — Does leverage on the proven blend raise CAGR honestly?

Not a new edge — a sizing test on the existing return streams, so this is a custom
analysis (like validate_shorts.py / test_lowvol_blend.py), not a run_experiment().

Honesty rules:
  - Financing is REAL: borrowed fraction (L-1) pays (IRX + 2.5%)/252 daily
    (retail-margin proxy; matches Alpaca's 6.25% non-elite rate today).
  - Trading costs already scale linearly with L (they're inside the sleeve returns).
  - Static L is rebalanced daily (like the live runners).
  - Vol-targeted variant: L_t = clip(target_vol / realized_60d_vol, 0.5, Lmax),
    decided on yesterday's data (shift 1 — no look-ahead).
  - Per-era table, because financing drag concentrates in high-rate eras and
    drawdown blowups concentrate in 2008/2020/2022.

Baseline blend = the planned July-14 system: 60 brain / 25 mean-rev / 15 low-vol.
"""
from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(os.path.dirname(HERE))
_QUANT = os.path.dirname(RESEARCH)
sys.path[:0] = [HERE, RESEARCH, _QUANT, os.path.join(_QUANT, "strategies")]

import numpy as np
import pandas as pd
from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
from stock_universe import STOCK_UNIVERSE
import trend, crypto_trend, flow, allocator, name_meanrev
from experiments.hunt_more_free import low_vol

MARGIN_SPREAD = 0.025  # retail margin ≈ T-bill + 2.5% (Alpaca 6.25% today)


def stats(r):
    r = r.dropna(); v = r.std() * np.sqrt(252)
    eq = (1 + r).cumprod()
    return dict(sharpe=round(r.mean() * 252 / v, 3) if v > 0 else 0,
                cagr=round(eq.iloc[-1] ** (252 / len(r)) - 1, 4),
                maxdd=round((eq / eq.cummax() - 1).min(), 4),
                vol=round(v, 4))


def era_table(r, block=3):
    r = r.dropna(); out = []
    y = r.index[0].year
    while y <= r.index[-1].year:
        b = r[(r.index.year >= y) & (r.index.year < y + block)]
        if len(b) > 60:
            eq = (1 + b).cumprod()
            v = b.std() * np.sqrt(252)
            out.append((f"{y}-{min(y + block - 1, r.index[-1].year)}",
                        round(b.mean() * 252 / v, 2) if v > 0 else 0,
                        round(eq.iloc[-1] ** (252 / len(b)) - 1, 3),
                        round((eq / eq.cummax() - 1).min(), 3)))
        y += block
    return out


def lever(blend_r, margin_daily, L):
    """Static leverage L, daily rebalanced, honest financing on the borrowed part."""
    return L * blend_r - (L - 1) * margin_daily


def vol_target(blend_r, margin_daily, target=0.10, lmax=2.0):
    """Dynamic leverage toward a vol target; L decided on trailing data (no look-ahead)."""
    realized = blend_r.rolling(60).std() * np.sqrt(252)
    L = (target / realized).clip(0.5, lmax).shift(1).fillna(1.0)
    return L * blend_r - (L - 1).clip(lower=0) * margin_daily, L


def main():
    print("Building blend return stream (60 brain / 25 mrev / 15 lowvol)...")
    ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
    etf = build_price_panel(get_universe(ALL)).ffill()
    stk = build_price_panel(get_universe(STOCK_UNIVERSE)).ffill()
    vix = get_bars("VIX")["close"]; vix3m = get_bars("VIX3M")["close"]

    sw = {"trend": trend.strategy(etf), "crypto": crypto_trend.strategy(etf),
          "tom": flow.turn_of_month(etf)}
    sr = {k: run_backtest(etf, v)["returns"] for k, v in sw.items()}
    bw = (allocator.combine(sw, sr, allocator.DEFAULT_CAPS) * allocator.DEFAULT_LEVERAGE).clip(upper=0.25)
    bw = allocator.apply_regime_gate(bw, vix.reindex(bw.index).ffill(), vix3m.reindex(bw.index).ffill())
    brain_r = run_backtest(etf, bw)["returns"]
    mr_r = run_backtest(stk, name_meanrev.strategy(stk, entry_rsi=5, exit_rsi=60, hold_max=10, max_names=10, max_weight=0.10))["returns"]
    lv_r = run_backtest(stk, low_vol(stk))["returns"]

    idx = brain_r.index.union(mr_r.index).union(lv_r.index)
    brain_r, mr_r, lv_r = (x.reindex(idx).fillna(0) for x in (brain_r, mr_r, lv_r))
    blend = 0.60 * brain_r + 0.25 * mr_r + 0.15 * lv_r

    # financing: 13-week T-bill (annualized %) + spread, daily
    irx = get_bars("^IRX")["close"].reindex(idx).ffill().fillna(5.0) / 100.0
    margin_daily = (irx + MARGIN_SPREAD) / 252.0

    base = stats(blend)
    print("\n" + "=" * 78)
    print("  LEVERAGE ON THE BLEND — honest financing (IRX + 2.5%)")
    print("=" * 78)
    print(f"  {'config':<34}{'Sharpe':>7}{'CAGR%':>8}{'MaxDD%':>8}{'Vol%':>6}")
    print(f"  {'1.00x (current, unlevered)':<34}{base['sharpe']:>7}{base['cagr']*100:>+7.1f}%{base['maxdd']*100:>7.1f}%{base['vol']*100:>5.1f}%")
    print("  " + "-" * 74)
    results = {"1.00x": (blend, base)}
    for L in [1.25, 1.50, 1.75, 2.00]:
        r = lever(blend, margin_daily, L)
        s = stats(r)
        results[f"{L:.2f}x"] = (r, s)
        print(f"  {f'{L:.2f}x static':<34}{s['sharpe']:>7}{s['cagr']*100:>+7.1f}%{s['maxdd']*100:>7.1f}%{s['vol']*100:>5.1f}%")
    for tgt in [0.10, 0.12]:
        r, Ls = vol_target(blend, margin_daily, target=tgt, lmax=2.0)
        s = stats(r)
        results[f"vt{int(tgt*100)}"] = (r, s)
        print(f"  {f'vol-target {int(tgt*100)}% (cap 2x, avg {Ls.mean():.2f}x)':<34}{s['sharpe']:>7}{s['cagr']*100:>+7.1f}%{s['maxdd']*100:>7.1f}%{s['vol']*100:>5.1f}%")

    print("\n  Per-era: unlevered vs 1.5x static vs vol-target 10%")
    print(f"  {'era':<12}{'base shp/cagr/dd':>24}{'1.5x shp/cagr/dd':>26}{'vt10 shp/cagr/dd':>26}")
    e0 = era_table(blend); e1 = era_table(results["1.50x"][0]); e2 = era_table(results["vt10"][0])
    for a, b, c in zip(e0, e1, e2):
        print(f"  {a[0]:<12}{a[1]:>8}{a[2]*100:>+8.1f}%{a[3]*100:>7.1f}%"
              f"{b[1]:>10}{b[2]*100:>+8.1f}%{b[3]*100:>7.1f}%"
              f"{c[1]:>10}{c[2]*100:>+8.1f}%{c[3]*100:>7.1f}%")

    print("\n  Dollar view on $3,000 (CAGR x capital):")
    for k in ["1.00x", "1.50x", "2.00x", "vt10"]:
        s = results[k][1]
        print(f"    {k:<8} ~${3000 * s['cagr']:,.0f}/yr   (maxDD dollar pain: ${3000 * abs(s['maxdd']):,.0f})")
    print("=" * 78)


if __name__ == "__main__":
    main()
