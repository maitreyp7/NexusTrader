"""
hunt_more_free.py — Test a few UNTESTED free sleeves through the research OS.

Candidates not yet in the graveyard:
  1. LOW-VOLATILITY tilt — own the lowest-volatility large-caps (the low-vol anomaly:
     boring stocks beat exciting ones risk-adjusted). Monthly rebalance.
  2. DUAL-MOMENTUM — own SPY if its 12m return beats T-bills AND is positive, else bonds
     (Gary Antonacci's GEM). Simple, robust, well-documented.
  3. VOL-MANAGED EQUITY — hold SPY scaled inversely to recent volatility (Moreira-Muir:
     scaling down in high-vol periods improves Sharpe).

Each: validate + check correlation to the live bots. Keep only real + uncorrelated.
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
from lib.validate import validate_strategy
from lib.similarity import live_bot_returns, compare


def low_vol(stock_panel, n=15):
    px = stock_panel
    rets = px.pct_change(fill_method=None)
    vol = rets.rolling(126).std()   # 6-month realized vol
    w = pd.DataFrame(np.nan, index=px.index, columns=px.columns)
    idx = px.index.to_series()
    is_rebal = (idx == idx.groupby([idx.index.year, idx.index.month]).transform("max"))
    for d in px.index[is_rebal.to_numpy()]:
        row = vol.loc[d].dropna()
        if len(row) >= n:
            w.loc[d, :] = 0.0
            for c in row.nsmallest(n).index:   # LOWEST vol names
                w.loc[d, c] = 1.0 / n
    return w.ffill().fillna(0.0)


def dual_momentum(spy, tlt):
    idx = spy.index
    spy_12m = spy.pct_change(252, fill_method=None)
    w = pd.DataFrame(0.0, index=idx, columns=["SPY", "TLT"])
    idxs = pd.Series(idx, index=idx)
    is_rebal = (idxs == idxs.groupby([idx.year, idx.month]).transform("max"))
    state = pd.Series(np.nan, index=idx)
    for d in idx[is_rebal.to_numpy()]:
        state.loc[d] = 1.0 if (spy_12m.loc[d] > 0) else 0.0   # in SPY if 12m positive, else bonds
    state = state.ffill().fillna(0.0)
    w["SPY"] = state
    w["TLT"] = 1.0 - state
    return w


def vol_managed(spy, target_vol=0.12):
    ret = spy.pct_change(fill_method=None)
    realized = ret.rolling(21).std() * np.sqrt(252)
    scale = (target_vol / realized).clip(upper=1.5).fillna(0.0)
    w = pd.DataFrame(0.0, index=spy.index, columns=["SPY"])
    w["SPY"] = scale.shift(1).fillna(0.0)   # use yesterday's vol (no look-ahead)
    return w


def main():
    print("Loading data...")
    ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
    etf = build_price_panel(get_universe(ALL)).ffill()
    stk = build_price_panel(get_universe(STOCK_UNIVERSE)).ffill()
    spy = get_bars("SPY")["adjclose"]
    tlt = get_bars("TLT")["adjclose"].reindex(spy.index).ffill()

    existing = live_bot_returns(etf, stk)

    candidates = {
        "low-volatility tilt": (low_vol(stk), stk),
        "dual-momentum (GEM)": (dual_momentum(spy, tlt),
                                pd.DataFrame({"SPY": spy, "TLT": tlt}).ffill()),
        "vol-managed equity":  (vol_managed(spy), spy.to_frame("SPY")),
    }

    print("\n" + "=" * 84)
    print("  UNTESTED FREE SLEEVES — through the research OS")
    print("=" * 84)
    print("  {:<24}{:>8}{:>8}{:>8}{:>16}{:>14}".format(
        "candidate", "Sharpe", "CAGR%", "MaxDD%", "verdict", "vs-bots"))
    print("  " + "-" * 80)
    for name, (w, panel) in candidates.items():
        val = validate_strategy(w, panel, name=name)
        r = val.pop("returns")
        sim = compare(r, existing)
        p = val["performance"]
        print("  {:<24}{:>8}{:>+7.1f}%{:>7.1f}%{:>16}{:>14}".format(
            name, p.get("sharpe", 0), p.get("cagr", 0)*100, p.get("max_drawdown", 0)*100,
            val["recommendation"], sim["verdict"][:13]))
        print("       └ {} | corr brain {:.2f} mrev {:.2f}".format(
            val["reasoning"][:70], sim["correlations"].get("brain", 0), sim["correlations"].get("mean-rev", 0)))
    print("=" * 84)


if __name__ == "__main__":
    main()
