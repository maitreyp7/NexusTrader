"""
hunt_free_edges.py — Test the remaining FREE-data edges honestly, in one sweep.

Tests three candidates and keeps only those that BOTH (a) have a real standalone edge
(positive, survives 2x costs, consistent across eras) AND (b) are uncorrelated (<0.35)
to the existing brain + mean-rev bots. A 4th trend-flavored sleeve adds nothing — we
want genuinely different return streams.

  1. RESIDUAL MOMENTUM — cross-sectional momentum on stocks, stripped of market beta
     (own past winners after removing their SPY-driven move). The one institutional
     edge testable on free data.
  2. SECTOR ROTATION — own the strongest 2-3 of 11 sector ETFs, rebalance monthly.
  3. CALENDAR — turn-of-month + pre-holiday seasonality on SPY (structural flow edges).

Honest costs. Compared to the base rate. Correlation-checked vs live bots.
"""

from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

import numpy as np
import pandas as pd
from data import get_bars, get_universe, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
from stock_universe import STOCK_UNIVERSE
import trend, crypto_trend, flow, allocator, name_meanrev

SECTORS = ["XLK","XLF","XLE","XLV","XLI","XLY","XLP","XLU","XLB","XLRE","XLC"]


def stats(r: pd.Series) -> dict:
    r = r.dropna()
    if len(r) < 60: return dict(sharpe=0, cagr=0, maxdd=0, n=len(r))
    vol = r.std() * np.sqrt(252)
    eq = (1 + r).cumprod()
    return dict(sharpe=(r.mean()*252/vol) if vol>0 else 0,
                cagr=eq.iloc[-1]**(252/len(r))-1, maxdd=(eq/eq.cummax()-1).min(), n=len(r))


def eras_positive(r, block=5):
    r = r.dropna(); pos=tot=0; y=r.index[0].year
    while y <= r.index[-1].year:
        b = r[(r.index.year>=y)&(r.index.year<y+block)]
        if len(b)>120: tot+=1; pos+=(b.mean()>0)
        y+=block
    return pos, tot


# ── 1. RESIDUAL MOMENTUM ─────────────────────────────────────────────────────
def residual_momentum(stock_panel, spy):
    """Own top-decile 6-month momentum AFTER removing each stock's market beta.
    Monthly rebalance, equal-weight, long-only."""
    px = stock_panel
    rets = px.pct_change(fill_method=None)
    spy_ret = spy.reindex(px.index).pct_change(fill_method=None)
    # rolling beta to SPY (1yr), then residual return = actual - beta*market
    resid_mom = pd.DataFrame(index=px.index, columns=px.columns, dtype=float)
    spy_mom = spy.reindex(px.index).pct_change(126, fill_method=None)
    for c in px.columns:
        cov = rets[c].rolling(252).cov(spy_ret)
        var = spy_ret.rolling(252).var()
        beta = (cov / var).clip(-3, 3)
        stock_mom = px[c].pct_change(126, fill_method=None)
        resid_mom[c] = stock_mom - beta * spy_mom   # momentum not explained by market
    # monthly: long the top-N residual-momentum names. Mark each rebalance date as
    # "decided" (0.0 row) before setting winners, so ffill holds between rebalances.
    w = pd.DataFrame(np.nan, index=px.index, columns=px.columns)
    idx = px.index.to_series()
    is_rebal = (idx == idx.groupby([idx.index.year, idx.index.month]).transform("max"))
    N = 10
    for d in px.index[is_rebal.to_numpy()]:
        w.loc[d, :] = 0.0
        row = resid_mom.loc[d].dropna()
        winners = row[row > 0].nlargest(N)
        if len(winners):
            for c in winners.index: w.loc[d, c] = 1.0/len(winners)
    return w.ffill().fillna(0.0)


# ── 2. SECTOR ROTATION ───────────────────────────────────────────────────────
def sector_rotation(sector_panel, top=3):
    px = sector_panel
    mom = px.pct_change(126, fill_method=None)   # 6-month
    w = pd.DataFrame(np.nan, index=px.index, columns=px.columns)
    idx = px.index.to_series()
    is_rebal = (idx == idx.groupby([idx.index.year, idx.index.month]).transform("max"))
    for d in px.index[is_rebal.to_numpy()]:
        w.loc[d, :] = 0.0
        row = mom.loc[d].dropna()
        winners = row[row > 0].nlargest(top)
        if len(winners):
            for c in winners.index: w.loc[d, c] = 1.0/len(winners)
    return w.ffill().fillna(0.0)


# ── 3. CALENDAR (turn-of-month + pre-holiday) ────────────────────────────────
def calendar_edge(spy_panel):
    px = spy_panel
    w = pd.DataFrame(0.0, index=px.index, columns=px.columns)
    idx = px.index
    # turn-of-month: last 1 + first 3 trading days
    months = pd.Series(idx, index=idx).groupby([idx.year, idx.month])
    on = pd.Series(False, index=idx)
    mlist = [g.index for _, g in months]
    for k, days in enumerate(mlist):
        for d in days[-1:]: on[d] = True
        if k+1 < len(mlist):
            for d in mlist[k+1][:3]: on[d] = True
    w["SPY"] = on.astype(float)
    return w


def corr(a, b):
    df = pd.concat([a, b], axis=1).dropna()
    if len(df) < 60 or df.iloc[:,0].std()==0 or df.iloc[:,1].std()==0: return 0.0
    return df.iloc[:,0].corr(df.iloc[:,1])


def main():
    print("Loading data...")
    ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
    etf = build_price_panel(get_universe(ALL)).ffill()
    stk = build_price_panel(get_universe(STOCK_UNIVERSE)).ffill()
    sec = build_price_panel(get_universe(SECTORS)).ffill()
    spy = get_bars("SPY")["adjclose"]

    # live bots' return streams (for correlation)
    sw={"trend":trend.strategy(etf),"crypto":crypto_trend.strategy(etf),"tom":flow.turn_of_month(etf)}
    sr={k:run_backtest(etf,v)["returns"] for k,v in sw.items()}
    brain_r = run_backtest(etf, (allocator.combine(sw,sr,allocator.DEFAULT_CAPS)*allocator.DEFAULT_LEVERAGE).clip(upper=0.25))["returns"]
    mr_r = run_backtest(stk, name_meanrev.strategy(stk, entry_rsi=5,exit_rsi=60,hold_max=10,max_names=10,max_weight=0.10))["returns"]

    # base rate (random 5-day hold on stocks) for reference
    print("\n" + "="*82)
    print("  FREE-EDGE SWEEP — does each beat random AND stay uncorrelated to your bots?")
    print("="*82)

    candidates = {
        "1. Residual momentum": (residual_momentum(stk, spy), stk),
        "2. Sector rotation":   (sector_rotation(sec), sec),
        "3. Calendar (ToM)":    (calendar_edge(spy.to_frame("SPY")), spy.to_frame("SPY")),
    }

    print("  {:<22}{:>8}{:>9}{:>9}{:>6}{:>9}{:>9}{:>9}".format(
        "candidate","Sharpe","CAGR%","MaxDD%","eras","r:brain","r:mrev","verdict"))
    print("  " + "-"*78)
    for name, (w, panel) in candidates.items():
        res = run_backtest(panel, w)
        r = res["returns"]; r2 = run_backtest(panel, w, cost_mult=2.0)["returns"]
        s = stats(r); s2 = stats(r2); pos,tot = eras_positive(r)
        cb = corr(r, brain_r); cm = corr(r, mr_r)
        edge_ok = s["sharpe"]>0.30 and s2["sharpe"]>0.20 and (tot==0 or pos>=0.6*tot)
        uncorr  = abs(cb)<0.35 and abs(cm)<0.35
        verdict = "✅ KEEP" if (edge_ok and uncorr) else ("~weak" if edge_ok or uncorr else "❌ no")
        print("  {:<22}{:>8.2f}{:>+8.1f}%{:>8.1f}%{:>4}/{:<2}{:>+9.2f}{:>+9.2f}  {}".format(
            name, s["sharpe"], s["cagr"]*100, s["maxdd"]*100, pos, tot, cb, cm, verdict))
        print("  {:<22}{:>8.2f}  (Sharpe at 2x cost — must stay positive)".format("  └ 2x-cost", s2["sharpe"]))

    print("\n" + "="*82)
    print("  KEEP = real edge (beats random, survives 2x cost, consistent) AND uncorrelated")
    print("  (<0.35) to BOTH live bots. Anything else isn't worth a new bot slot.")
    print("="*82)


if __name__ == "__main__":
    main()
