"""
test_pead_blend.py — Does PEAD IMPROVE the system blend?

Standalone verdict: PAPER_TRADE (Sharpe 0.70, 9/9 eras, robust plateau, edge
STRONGER in recent half). But a sleeve only earns a slot if the BLEND improves
(low-vol precedent: 0.42 corr to mean-rev, still improved the blend on all axes).

Tests:
  A. current 2-bot system (70 brain / 30 mrev) — baseline
  B. 3-way blends carving a PEAD slice
  C. 4-way blends with the queued low-vol sleeve too (the July-14 world)
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
from fetch_earnings import load_all
import pead


def stats(r):
    r = r.dropna(); v = r.std() * np.sqrt(252)
    eq = (1 + r).cumprod()
    return dict(sharpe=round(r.mean() * 252 / v, 3) if v > 0 else 0,
                cagr=round(eq.iloc[-1] ** (252 / len(r)) - 1, 4),
                maxdd=round((eq / eq.cummax() - 1).min(), 4),
                vol=round(v, 4))


def row(label, s, base=None):
    flag = ""
    if base:
        better = (s["sharpe"] > base["sharpe"] + 0.02) or \
                 (s["maxdd"] > base["maxdd"] + 0.02 and s["cagr"] >= base["cagr"])
        flag = "  <-- improves" if better else ""
    print(f"  {label:<40}{s['sharpe']:>7}{s['cagr']*100:>+7.1f}%{s['maxdd']*100:>8.1f}%{s['vol']*100:>6.1f}%{flag}")


def main():
    print("Building all sleeve return streams...")
    earnings = load_all()
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
    pe_r = run_backtest(stk, pead.strategy(stk, earnings=earnings, hold_days=20))["returns"]

    idx = brain_r.index.union(mr_r.index).union(lv_r.index).union(pe_r.index)
    # PEAD signal only exists once earnings history starts (~2001)
    idx = idx[idx >= pd.Timestamp("2001-01-01")]
    brain_r, mr_r, lv_r, pe_r = (x.reindex(idx).fillna(0) for x in (brain_r, mr_r, lv_r, pe_r))

    base = stats(0.70 * brain_r + 0.30 * mr_r)
    print("\n" + "=" * 78)
    print("  DOES PEAD IMPROVE THE BLEND?  (2001+, all sleeves aligned)")
    print("=" * 78)
    print(f"  {'config':<40}{'Sharpe':>7}{'CAGR%':>8}{'MaxDD%':>8}{'Vol%':>6}")
    row("CURRENT (70 brain / 30 mrev)", base)
    print("  " + "-" * 74)
    print("  -- 3-way: current two bots + PEAD --")
    for label, b, m, p in [("60 brain / 25 mrev / 15 pead", .60, .25, .15),
                           ("55 brain / 25 mrev / 20 pead", .55, .25, .20),
                           ("50 brain / 25 mrev / 25 pead", .50, .25, .25),
                           ("60 brain / 20 mrev / 20 pead", .60, .20, .20)]:
        row(label, stats(b * brain_r + m * mr_r + p * pe_r), base)
    print("  -- 4-way: the July-14 world (with low-vol) --")
    lv_base = stats(0.60 * brain_r + 0.25 * mr_r + 0.15 * lv_r)
    row("PLANNED (60 br / 25 mr / 15 lv)", lv_base)
    for label, b, m, l, p in [("50 br / 20 mr / 15 lv / 15 pead", .50, .20, .15, .15),
                              ("45 br / 20 mr / 15 lv / 20 pead", .45, .20, .15, .20),
                              ("50 br / 25 mr / 10 lv / 15 pead", .50, .25, .10, .15),
                              ("55 br / 20 mr / 10 lv / 15 pead", .55, .20, .10, .15)]:
        row(label, stats(b * brain_r + m * mr_r + l * lv_r + p * pe_r), lv_base)

    print("\n  sleeve correlations:")
    df = pd.DataFrame({"brain": brain_r, "mrev": mr_r, "lowvol": lv_r, "pead": pe_r})
    print(df.corr().round(3).to_string())
    print("=" * 78)


if __name__ == "__main__":
    main()
