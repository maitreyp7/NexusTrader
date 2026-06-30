"""
test_lowvol_blend.py — Does the low-vol sleeve actually IMPROVE the live system?

Standalone it's PRODUCTION_CANDIDATE (Sharpe 1.05). But the only question that matters:
when blended with the existing brain + mean-rev bots, does the COMBINED portfolio get
better (higher Sharpe / CAGR, or lower drawdown)? Or does its 0.42 correlation to
mean-rev + its -48% standalone drawdown drag the system down?

We test the 3-way blend (brain + mean-rev + low-vol) at several allocations and compare
to the current 2-bot system. Honest: a sleeve only earns a slot if the BLEND improves.
"""
from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(HERE)
sys.path.insert(0, RESEARCH)
_QUANT = os.path.dirname(RESEARCH)
sys.path.insert(0, _QUANT); sys.path.insert(0, os.path.join(_QUANT, "strategies"))

import numpy as np
import pandas as pd
from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
from stock_universe import STOCK_UNIVERSE
import trend, crypto_trend, flow, allocator, name_meanrev
from experiments.hunt_more_free import low_vol


def stats(r):
    r = r.dropna(); v = r.std()*np.sqrt(252)
    eq = (1+r).cumprod()
    return dict(sharpe=round((r.mean()*252/v),3) if v>0 else 0,
                cagr=round(eq.iloc[-1]**(252/len(r))-1,4),
                maxdd=round((eq/eq.cummax()-1).min(),4),
                vol=round(v,4))


def main():
    print("Building bot return streams + low-vol sleeve...")
    ALL = sorted(set(ALL_SYMBOLS)|set(CRYPTO_UNIVERSE))
    etf = build_price_panel(get_universe(ALL)).ffill()
    stk = build_price_panel(get_universe(STOCK_UNIVERSE)).ffill()
    vix = get_bars("VIX")["close"]; vix3m = get_bars("VIX3M")["close"]

    # brain (regime-gated, as deployed)
    sw={"trend":trend.strategy(etf),"crypto":crypto_trend.strategy(etf),"tom":flow.turn_of_month(etf)}
    sr={k:run_backtest(etf,v)["returns"] for k,v in sw.items()}
    bw=(allocator.combine(sw,sr,allocator.DEFAULT_CAPS)*allocator.DEFAULT_LEVERAGE).clip(upper=0.25)
    bw=allocator.apply_regime_gate(bw, vix.reindex(bw.index).ffill(), vix3m.reindex(bw.index).ffill())
    brain_r = run_backtest(etf, bw)["returns"]
    mr_r = run_backtest(stk, name_meanrev.strategy(stk,entry_rsi=5,exit_rsi=60,hold_max=10,max_names=10,max_weight=0.10))["returns"]
    lv_r = run_backtest(stk, low_vol(stk))["returns"]

    # align all to common index
    idx = brain_r.index.union(mr_r.index).union(lv_r.index)
    brain_r = brain_r.reindex(idx).fillna(0)
    mr_r    = mr_r.reindex(idx).fillna(0)
    lv_r    = lv_r.reindex(idx).fillna(0)

    # current live system = dynamic ~70/30 (use 70/30 fixed as the fair baseline)
    base = stats(0.70*brain_r + 0.30*mr_r)

    print("\n" + "="*74)
    print("  DOES LOW-VOL IMPROVE THE BLEND? (vs current 2-bot system)")
    print("="*74)
    print(f"  {'config':<34}{'Sharpe':>8}{'CAGR%':>8}{'MaxDD%':>9}{'Vol%':>7}")
    print(f"  {'CURRENT (70 brain / 30 mrev)':<34}{base['sharpe']:>8}{base['cagr']*100:>+7.1f}%{base['maxdd']*100:>8.1f}%{base['vol']*100:>6.1f}%")
    print("  " + "-"*70)
    # try carving a slice for low-vol out of the total, keeping brain dominant
    configs = [
        ("60 brain / 25 mrev / 15 lowvol", 0.60, 0.25, 0.15),
        ("55 brain / 25 mrev / 20 lowvol", 0.55, 0.25, 0.20),
        ("50 brain / 25 mrev / 25 lowvol", 0.50, 0.25, 0.25),
        ("60 brain / 20 mrev / 20 lowvol", 0.60, 0.20, 0.20),
    ]
    best = None
    for label, b, m, l in configs:
        s = stats(b*brain_r + m*mr_r + l*lv_r)
        better = (s["sharpe"] > base["sharpe"] + 0.02) or (s["maxdd"] > base["maxdd"] + 0.02 and s["cagr"] >= base["cagr"])
        flag = "  <-- improves" if better else ""
        print(f"  {label:<34}{s['sharpe']:>8}{s['cagr']*100:>+7.1f}%{s['maxdd']*100:>8.1f}%{s['vol']*100:>6.1f}%{flag}")
        if better and (best is None or s["sharpe"] > best[1]["sharpe"]):
            best = (label, s)

    print("\n" + "="*74)
    if best:
        print(f"  VERDICT: low-vol IMPROVES the blend. Best: {best[0]}")
        print(f"    Sharpe {base['sharpe']} -> {best[1]['sharpe']} | CAGR {base['cagr']*100:+.1f}% -> {best[1]['cagr']*100:+.1f}% | DD {base['maxdd']*100:.1f}% -> {best[1]['maxdd']*100:.1f}%")
    else:
        print("  VERDICT: low-vol does NOT improve the blend (correlation/drawdown drag).")
        print("  Standalone strength doesn't translate — same lesson as defensive rotation.")
    print("="*74)


if __name__ == "__main__":
    main()
