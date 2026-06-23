"""
validate_allocation.py — Does DYNAMIC capital allocation beat the fixed 70/30 split?

We simulate the TWO-BOT system (brain sleeve-portfolio + single-name mean-rev) over
full history under several allocation policies, and compare honestly:

  A. FIXED 70/30                         — what's live now.
  B. DRAWDOWN-PROTECTED                  — cut a bot when IT is in drawdown (halve at
                                            -X%, off at -Y%), restore as it recovers.
  C. PERFORMANCE-TILT                    — shift capital toward the bot with the better
                                            trailing (e.g. 3-month) return.
  D. BOTH (drawdown protect + mild tilt) — the full "pod model".

The honest question: drawdown-protection usually helps; performance-CHASING often
hurts (bot returns mean-revert — last month's loser tends to bounce). The backtest,
not intuition, decides. We report Sharpe / CAGR / MaxDD for each policy.
"""

from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

import numpy as np
import pandas as pd
from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
from stock_universe import STOCK_UNIVERSE
import trend, crypto_trend, flow, allocator, name_meanrev

ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
MEANREV_PARAMS = dict(entry_rsi=5, exit_rsi=60, hold_max=10, max_names=10, max_weight=0.10)


def stats(r: pd.Series) -> dict:
    r = r.dropna()
    if len(r) < 60:
        return dict(sharpe=0, cagr=0, maxdd=0, vol=0)
    vol = r.std() * np.sqrt(252)
    sharpe = (r.mean() * 252) / vol if vol > 0 else 0.0
    eq = (1 + r).cumprod()
    return dict(sharpe=sharpe, cagr=eq.iloc[-1] ** (252 / len(r)) - 1,
                maxdd=(eq / eq.cummax() - 1).min(), vol=vol)


def drawdown_series(r: pd.Series) -> pd.Series:
    eq = (1 + r.fillna(0)).cumprod()
    return eq / eq.cummax() - 1


def main():
    print("Building both bots' return streams over full history...")
    etf = build_price_panel(get_universe(ALL)).ffill()
    stk = build_price_panel(get_universe(STOCK_UNIVERSE)).ffill()
    vix = get_bars("VIX")["close"]; vix3m = get_bars("VIX3M")["close"]

    # --- Brain bot return stream (3 sleeves + regime gate, as deployed) ---
    sw = {"trend": trend.strategy(etf), "crypto": crypto_trend.strategy(etf), "tom": flow.turn_of_month(etf)}
    sr = {k: run_backtest(etf, v)["returns"] for k, v in sw.items()}
    brain_w = (allocator.combine(sw, sr, allocator.DEFAULT_CAPS) * allocator.DEFAULT_LEVERAGE).clip(upper=0.25)
    v = vix.reindex(brain_w.index).ffill(); v3 = vix3m.reindex(brain_w.index).ffill()
    brain_w = allocator.apply_regime_gate(brain_w, v, v3)
    brain_r = run_backtest(etf, brain_w)["returns"]

    # --- Mean-rev bot return stream ---
    mr_w = name_meanrev.strategy(stk, **MEANREV_PARAMS)
    mr_r = run_backtest(stk, mr_w)["returns"]

    # align both to a common daily index
    idx = brain_r.index.union(mr_r.index)
    brain_r = brain_r.reindex(idx).fillna(0.0)
    mr_r    = mr_r.reindex(idx).fillna(0.0)

    print(f"  Brain : Sharpe {stats(brain_r)['sharpe']:.2f}  CAGR {stats(brain_r)['cagr']*100:+.1f}%")
    print(f"  Meanrev: Sharpe {stats(mr_r)['sharpe']:.2f}  CAGR {stats(mr_r)['cagr']*100:+.1f}%")
    corr = pd.concat([brain_r, mr_r], axis=1).dropna().corr().iloc[0, 1]
    print(f"  Correlation between the two bots: {corr:+.2f}  (low = good, they diversify)\n")

    # ── Policy A: FIXED 70/30 ────────────────────────────────────────────────
    def fixed(bw=0.70):
        return bw * brain_r + (1 - bw) * mr_r

    # ── Policy B: DRAWDOWN-PROTECTED ─────────────────────────────────────────
    # Each bot's allocation scales by its OWN drawdown (computed from PAST returns
    # only — shift(1) to avoid look-ahead): full size if flat, halve at -halve_dd,
    # off at -off_dd, linear in between.
    def dd_scaler(r, halve_dd=0.08, off_dd=0.15):
        dd = drawdown_series(r).shift(1).fillna(0.0)   # only past info
        # map dd in [0, -halve] -> 1.0..0.5, [-halve,-off] -> 0.5..0.0
        s = pd.Series(1.0, index=r.index)
        mild = (dd <= -1e-9) & (dd > -halve_dd)
        deep = (dd <= -halve_dd) & (dd > -off_dd)
        s[mild] = 1.0 - 0.5 * (-dd[mild] / halve_dd)
        s[deep] = 0.5 - 0.5 * ((-dd[deep] - halve_dd) / (off_dd - halve_dd))
        s[dd <= -off_dd] = 0.0
        return s.clip(0, 1)

    def drawdown_protected(bw=0.70):
        bs = dd_scaler(brain_r); ms = dd_scaler(mr_r)
        return bw * brain_r * bs + (1 - bw) * mr_r * ms

    # ── Policy C: PERFORMANCE TILT (chase the trailing winner) ───────────────
    def perf_tilt(lookback=63, max_tilt=0.20):
        # trailing cumulative return per bot (past only)
        bt = (1 + brain_r).rolling(lookback).apply(np.prod, raw=True).shift(1) - 1
        mt = (1 + mr_r).rolling(lookback).apply(np.prod, raw=True).shift(1) - 1
        edge = (bt - mt).fillna(0.0)
        # tilt brain weight up/down by up to max_tilt based on who's winning
        bw = (0.70 + max_tilt * np.sign(edge) * (edge.abs() / (edge.abs().rolling(252).mean() + 1e-9)).clip(0, 1)).clip(0.5, 0.9)
        return bw * brain_r + (1 - bw) * mr_r

    # ── Policy D: BOTH ───────────────────────────────────────────────────────
    def both(lookback=63, max_tilt=0.15):
        bt = (1 + brain_r).rolling(lookback).apply(np.prod, raw=True).shift(1) - 1
        mt = (1 + mr_r).rolling(lookback).apply(np.prod, raw=True).shift(1) - 1
        edge = (bt - mt).fillna(0.0)
        bw = (0.70 + max_tilt * np.sign(edge) * (edge.abs() / (edge.abs().rolling(252).mean() + 1e-9)).clip(0, 1)).clip(0.55, 0.85)
        bs = dd_scaler(brain_r); ms = dd_scaler(mr_r)
        return bw * brain_r * bs + (1 - bw) * mr_r * ms

    policies = {
        "A. Fixed 70/30 (live now)":   fixed(),
        "B. Drawdown-protected":       drawdown_protected(),
        "C. Performance-tilt":         perf_tilt(),
        "D. Both (pod model)":         both(),
    }

    print("=" * 78)
    print("  ALLOCATION POLICY COMPARISON  (two-bot system, full history, honest costs)")
    print("=" * 78)
    print("  {:<28}{:>9}{:>10}{:>10}{:>9}".format("policy", "Sharpe", "CAGR%", "MaxDD%", "Vol%"))
    print("  " + "-" * 72)
    base = stats(policies["A. Fixed 70/30 (live now)"])
    for name, r in policies.items():
        s = stats(r)
        d_sh = s["sharpe"] - base["sharpe"]
        flag = ""
        if name != "A. Fixed 70/30 (live now)":
            flag = "  ✅ better" if (s["sharpe"] > base["sharpe"] + 0.02 or s["maxdd"] > base["maxdd"] + 0.02) else "  ~ no gain"
        print("  {:<28}{:>9.3f}{:>+9.2f}%{:>9.1f}%{:>8.1f}%{}".format(
            name, s["sharpe"], s["cagr"] * 100, s["maxdd"] * 100, s["vol"] * 100, flag))

    print("\n" + "=" * 78)
    print("  READ: drawdown-protection that lifts Sharpe OR cuts MaxDD meaningfully is")
    print("  worth wiring in. A perf-tilt that doesn't beat fixed = skip it (chasing noise).")
    print("=" * 78)


if __name__ == "__main__":
    main()
