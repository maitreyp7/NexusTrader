"""
hunt_meanrev.py — Hunt the single-name mean-reversion sleeve.

Tests name_meanrev HONESTLY:
  1. Standalone edge over full history (147 large-caps, ~44yr median).
  2. Gatekeeper: per-era consistency + first/second-half (MUST survive recent data,
     where survivorship bias is weakest) + 2x slippage stress.
  3. Correlation to the live trend sleeves (want LOW / negative).
  4. Portfolio-impact: does adding it to the live brain raise CAGR or Sharpe?

A few param sets are tried (entry/exit/hold) to confirm the edge isn't a single magic
setting — but we do NOT cherry-pick; we report them all and judge robustness.
"""

from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

import pandas as pd
import numpy as np
from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
from stock_universe import STOCK_UNIVERSE
import trend, crypto_trend, flow, allocator
import name_meanrev


def stats(returns: pd.Series) -> dict:
    r = returns.dropna()
    if len(r) < 60:
        return dict(sharpe=0, cagr=0, maxdd=0, vol=0, pf=0)
    vol = r.std() * np.sqrt(252)
    sharpe = (r.mean() * 252) / vol if vol > 0 else 0.0
    eq = (1 + r).cumprod()
    maxdd = (eq / eq.cummax() - 1).min()
    cagr = eq.iloc[-1] ** (252 / len(r)) - 1
    g = r[r > 0].sum(); l = abs(r[r < 0].sum())
    pf = g / l if l > 0 else 0.0
    return dict(sharpe=sharpe, cagr=cagr, maxdd=maxdd, vol=vol, pf=pf)


def eras(returns, block=5):
    r = returns.dropna()
    pos = tot = 0
    y = r.index[0].year
    while y <= r.index[-1].year:
        b = r[(r.index.year >= y) & (r.index.year < y + block)]
        if len(b) > 120:
            tot += 1; pos += (b.mean() > 0)
        y += block
    return pos, tot


def half_sharpe(returns):
    r = returns.dropna(); mid = r.index[len(r)//2]
    def sh(x):
        v = x.std()*np.sqrt(252); return (x.mean()*252/v) if v > 0 else 0.0
    return round(sh(r[r.index < mid]), 2), round(sh(r[r.index >= mid]), 2)


def main():
    print("Loading stock universe (147 names) + ETF/crypto panel...")
    stock_bars = get_universe(STOCK_UNIVERSE)
    stock_panel = build_price_panel(stock_bars).ffill()

    print(f"  Stock panel: {stock_panel.shape[1]} names, "
          f"{stock_panel.index[0].date()} → {stock_panel.index[-1].date()}\n")

    # --- Step 1+2: standalone edge across a few param sets (robustness, not cherry-pick) ---
    print("=" * 92)
    print("  SINGLE-NAME MEAN-REVERSION — standalone backtest (147 large-caps, honest costs)")
    print("=" * 92)
    print("  {:<28}{:>7}{:>8}{:>8}{:>6}{:>7}{:>14}".format(
        "params (entry/exit/hold)", "Sharpe", "CAGR%", "MaxDD%", "PF", "eras", "1st/2nd half"))
    print("  " + "-" * 88)

    param_sets = [
        dict(entry_rsi=10, exit_rsi=50, hold_max=8),   # base
        dict(entry_rsi=5,  exit_rsi=60, hold_max=10),  # stricter entry, looser exit
        dict(entry_rsi=15, exit_rsi=50, hold_max=6),   # looser entry, faster stop
        dict(entry_rsi=10, exit_rsi=70, hold_max=5),   # hold for bigger bounce, hard fast stop
    ]
    results = []
    for ps in param_sets:
        w = name_meanrev.strategy(stock_panel, **ps)
        res = run_backtest(stock_panel, w)
        r = res["returns"]
        st = stats(r)
        pos, tot = eras(r)
        h1, h2 = half_sharpe(r)
        # 2x cost stress
        r2 = run_backtest(stock_panel, w, cost_mult=2.0)["returns"]
        st2 = stats(r2)
        results.append((ps, r, st, st2))
        label = f"{ps['entry_rsi']}/{ps['exit_rsi']}/{ps['hold_max']}d"
        print("  {:<28}{:>7.2f}{:>+8.1f}{:>8.1f}{:>6.2f}{:>5}/{:<2}{:>10}".format(
            label, st["sharpe"], st["cagr"]*100, st["maxdd"]*100, st["pf"],
            pos, tot, f"{h1}/{h2}"))
        print("  {:<28}{:>7.2f}  (Sharpe at 2x costs — must stay clearly positive)".format(
            "  └ 2x-cost stress", st2["sharpe"]))

    # pick the most ROBUST (not best) — highest min(1st,2nd half) Sharpe AND survives 2x
    def robustness(item):
        ps, r, st, st2 = item
        h1, h2 = half_sharpe(r)
        return (min(h1, h2), st2["sharpe"])
    best = max(results, key=robustness)
    ps_b, r_b, st_b, st2_b = best
    print(f"\n  → Most ROBUST param set: entry {ps_b['entry_rsi']} / exit {ps_b['exit_rsi']} "
          f"/ hold {ps_b['hold_max']}d  (Sharpe {st_b['sharpe']:.2f}, survives 2x at {st2_b['sharpe']:.2f})")

    # --- Step 3+4: correlation + portfolio impact vs the LIVE brain ---
    print("\n" + "=" * 92)
    print("  CORRELATION + PORTFOLIO-IMPACT vs the live 3-sleeve brain")
    print("=" * 92)

    ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
    etf_panel = build_price_panel(get_universe(ALL)).ffill()
    vix = get_bars("VIX")["close"]; vix3m = get_bars("VIX3M")["close"]

    live_sw = {"trend": trend.strategy(etf_panel), "crypto": crypto_trend.strategy(etf_panel),
               "tom": flow.turn_of_month(etf_panel)}
    live_sr = {k: run_backtest(etf_panel, v)["returns"] for k, v in live_sw.items()}

    def build_brain(extra_panel=None, extra_w=None, extra_name=None, cap=0.25):
        # combine ETF sleeves on the ETF panel; if a stock sleeve is added, we need a
        # JOINED panel so the engine can price both. Build a union panel.
        if extra_panel is not None:
            joined = pd.concat([etf_panel, extra_panel], axis=1)
            joined = joined.loc[:, ~joined.columns.duplicated()].ffill()
        else:
            joined = etf_panel
        sw = {k: v.reindex(columns=joined.columns).fillna(0.0) for k, v in live_sw.items()}
        sr = dict(live_sr)
        caps = dict(allocator.DEFAULT_CAPS)
        if extra_w is not None:
            sw[extra_name] = extra_w.reindex(columns=joined.columns).fillna(0.0)
            sr[extra_name] = run_backtest(joined, sw[extra_name])["returns"]
            caps[extra_name] = cap
        wc = (allocator.combine(sw, sr, caps) * allocator.DEFAULT_LEVERAGE).clip(upper=0.25)
        v = vix.reindex(wc.index).ffill(); v3 = vix3m.reindex(wc.index).ffill()
        wc = allocator.apply_regime_gate(wc, v, v3)
        return run_backtest(joined, wc)["returns"]

    base_r = build_brain()
    base = stats(base_r)

    # correlation of the mean-rev sleeve to each live sleeve
    def corr(a, b):
        df = pd.concat([a, b], axis=1).dropna()
        if len(df) < 60 or df.iloc[:,0].std()==0 or df.iloc[:,1].std()==0: return 0.0
        return df.iloc[:,0].corr(df.iloc[:,1])
    c_trend = corr(r_b, live_sr["trend"])
    c_cryp  = corr(r_b, live_sr["crypto"])
    c_port  = corr(r_b, base_r)
    print(f"  mean-rev correlation →  trend {c_trend:+.2f}   crypto {c_cryp:+.2f}   live-brain {c_port:+.2f}")
    print(f"  (want |corr| < 0.35 — reversion SHOULD be uncorrelated/negative to trend)\n")

    # portfolio impact at a few caps
    print(f"  {'config':<24}{'Sharpe':>9}{'CAGR%':>9}{'MaxDD%':>9}{'Vol%':>8}")
    print(f"  {'live brain (3 sleeves)':<24}{base['sharpe']:>9.3f}{base['cagr']*100:>+8.2f}%{base['maxdd']*100:>8.1f}%{base['vol']*100:>7.1f}%")
    print("  " + "-" * 64)
    for cap in [0.10, 0.15, 0.20, 0.25]:
        nr = build_brain(stock_panel, r_b if False else name_meanrev.strategy(stock_panel, **ps_b),
                         "meanrev", cap=cap)
        s = stats(nr)
        flag = "  ✅" if (s["cagr"] > base["cagr"] + 0.002 or s["sharpe"] > base["sharpe"] + 0.02) else ""
        print(f"  {'+meanrev @ '+str(int(cap*100))+'% cap':<24}{s['sharpe']:>9.3f}{s['cagr']*100:>+8.2f}%{s['maxdd']*100:>8.1f}%{s['vol']*100:>7.1f}%{flag}")
    print("=" * 92)


if __name__ == "__main__":
    main()
