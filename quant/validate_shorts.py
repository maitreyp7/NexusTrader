"""
validate_shorts.py — Can we profit when the market FALLS? Test honestly.

The brain already goes to CASH in downtrends. The real question: does going SHORT
(or holding an inverse ETF) actually BEAT just sitting in cash? We test 3 approaches
on real SPY history and compare to two benchmarks.

Approaches:
  1. BOTH-WAYS TREND  — long SPY in uptrend, SHORT SPY in downtrend (price vs 200d MA).
  2. INVERSE-ETF      — proxy: hold a -1x SPY return when in downtrend, else cash
                        (mimics buying SH; long-only, no margin).
  3. DEFENSIVE-ROTATE — long SPY in uptrend, rotate to bonds/gold (TLT/GLD) in downtrend.

Benchmarks:
  • LONG/CASH (what the brain does): long SPY in uptrend, CASH in downtrend.
  • BUY & HOLD SPY.

We split results into UP markets vs DOWN markets so we can see exactly where each
approach helps or hurts. Honest costs applied. A short approach only wins if it adds
return in DOWN markets WITHOUT giving most of it back in UP/choppy markets.
"""

from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd
from data import get_bars

COST = 0.0003   # per-side, liquid ETF


def stats(r: pd.Series, label: str) -> dict:
    r = r.dropna()
    vol = r.std() * np.sqrt(252)
    sharpe = (r.mean() * 252) / vol if vol > 0 else 0
    eq = (1 + r).cumprod()
    maxdd = (eq / eq.cummax() - 1).min()
    cagr = eq.iloc[-1] ** (252 / len(r)) - 1
    return dict(label=label, sharpe=sharpe, cagr=cagr, maxdd=maxdd, vol=vol)


def run(signal_weight: pd.Series, ret: pd.Series) -> pd.Series:
    """Apply a daily target weight (can be negative=short) to SPY returns, with cost
    on weight changes. No look-ahead: weight decided at t applies to t+1."""
    held = signal_weight.shift(1).fillna(0)
    turnover = held.diff().abs().fillna(held.abs())
    return held * ret - turnover * COST


def main():
    print("Loading SPY / TLT / GLD...")
    spy = get_bars("SPY")["adjclose"]
    tlt = get_bars("TLT")["adjclose"].reindex(spy.index).ffill()
    gld = get_bars("GLD")["adjclose"].reindex(spy.index).ffill()

    spy_ret = spy.pct_change(fill_method=None).fillna(0)
    tlt_ret = tlt.pct_change(fill_method=None).fillna(0)
    gld_ret = gld.pct_change(fill_method=None).fillna(0)

    sma = spy.rolling(200).mean()
    uptrend = (spy > sma).fillna(False)
    downtrend = (~uptrend) & sma.notna()

    # ── Benchmarks ──────────────────────────────────────────────────────────
    w_longcash = uptrend.astype(float)                       # long in up, cash in down
    r_longcash = run(w_longcash, spy_ret)
    r_buyhold  = spy_ret.copy()

    # ── 1. BOTH-WAYS TREND (short in downtrend) ─────────────────────────────
    w_bothways = uptrend.astype(float) - downtrend.astype(float)   # +1 up, -1 down
    r_bothways = run(w_bothways, spy_ret)

    # ── 2. INVERSE-ETF (long inverse in downtrend = -1x SPY, else cash) ─────
    # buying SH gives ~ -1x daily SPY return (minus a small drag, ignored here)
    inv_ret = -spy_ret
    held_inv = downtrend.shift(1).fillna(False).astype(float)
    held_long = uptrend.shift(1).fillna(False).astype(float)
    turn = (held_inv.diff().abs().fillna(held_inv.abs()) + held_long.diff().abs().fillna(held_long.abs()))
    r_inverse = held_long * spy_ret + held_inv * inv_ret - turn * COST

    # ── 3. DEFENSIVE ROTATION (bonds/gold in downtrend) ─────────────────────
    held_long2 = uptrend.shift(1).fillna(False).astype(float)
    held_def   = downtrend.shift(1).fillna(False).astype(float)
    def_ret    = 0.5 * tlt_ret + 0.5 * gld_ret   # half bonds, half gold
    turn2 = held_long2.diff().abs().fillna(held_long2.abs()) + held_def.diff().abs().fillna(held_def.abs())
    r_defrot = held_long2 * spy_ret + held_def * def_ret - turn2 * COST

    approaches = {
        "Long/Cash (brain does this)": r_longcash,
        "Buy & Hold SPY":              r_buyhold,
        "1. Both-ways (short down)":   r_bothways,
        "2. Inverse-ETF in downtrend": r_inverse,
        "3. Defensive rotation":       r_defrot,
    }

    print("\n" + "=" * 76)
    print("  CAN WE PROFIT WHEN THE MARKET FALLS?  (SPY, full history, honest costs)")
    print("=" * 76)
    print("  {:<30}{:>9}{:>9}{:>9}{:>9}".format("approach", "Sharpe", "CAGR%", "MaxDD%", "Vol%"))
    print("  " + "-" * 72)
    for name, r in approaches.items():
        s = stats(r, name)
        print("  {:<30}{:>9.2f}{:>+8.2f}%{:>8.1f}%{:>8.1f}%".format(name, s["sharpe"], s["cagr"]*100, s["maxdd"]*100, s["vol"]*100))

    # ── Split: how does each do in DOWN markets specifically? ───────────────
    print("\n" + "=" * 76)
    print("  THE KEY TEST — return during DOWNTREND days only (when market bleeds)")
    print("=" * 76)
    dmask = downtrend.shift(1).fillna(False)
    umask = uptrend.shift(1).fillna(False)
    print("  {:<30}{:>16}{:>16}".format("approach", "DOWN-mkt ann%", "UP-mkt ann%"))
    print("  " + "-" * 72)
    for name, r in approaches.items():
        down_ann = r[dmask].mean() * 252 * 100
        up_ann   = r[umask].mean() * 252 * 100
        print("  {:<30}{:>+15.1f}%{:>+15.1f}%".format(name, down_ann, up_ann))

    print("\n" + "=" * 76)
    print("  READ: a short approach is only worth it if its DOWN-market column is")
    print("  clearly positive AND its overall Sharpe beats 'Long/Cash'. If shorting")
    print("  just trades up-market gains for down-market gains at the same Sharpe,")
    print("  it's not adding edge — cash is simpler and safer.")
    print("=" * 76)


if __name__ == "__main__":
    main()
