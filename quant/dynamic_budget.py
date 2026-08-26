"""
dynamic_budget.py — Computes the live brain/mean-rev capital split (the gentle tilt).

Both bots run as separate processes, so they need ONE consistent view of the split.
This module is that single source of truth. It computes each bot's trailing 42-day
return from its strategy on fresh data (the same signal the backtest validated), then
leans the brain's budget up to ±10% toward whichever bot has been performing better.

Validated (validate_allocation.py): vs fixed 70/30, the gentle tilt (lookback=42,
max_tilt=0.10) improved Sharpe 1.10→1.17 and CAGR 6.4%→7.2% with drawdown unchanged,
robust across every parameter combo. Drawdown circuit-breaker was tested and REJECTED
(it cost more return than it saved), so it is deliberately NOT included.

Returns (brain_budget, meanrev_budget) summing to 1.0. Brain clamped to [0.60, 0.80]
so the tilt is gentle and the account is never dominated by one bot.
"""

from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

import numpy as np
import pandas as pd

BASE_BRAIN_BUDGET = 0.70     # neutral split when both bots perform equally
LOOKBACK          = 42       # trading days (~2 months) — validated sweet spot
MAX_TILT          = 0.10     # lean at most ±10% toward the hotter bot
BRAIN_FLOOR       = 0.60     # never below 60% brain
BRAIN_CEIL        = 0.80     # never above 80% brain


def _bot_return_streams() -> tuple[pd.Series, pd.Series]:
    """Compute both bots' daily return streams from fresh data (cached)."""
    from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
    from engine import build_price_panel, run_backtest
    from stock_universe import STOCK_UNIVERSE
    import trend, crypto_trend, flow, allocator, name_meanrev

    ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
    etf = build_price_panel(get_universe(ALL)).ffill()
    stk = build_price_panel(get_universe(STOCK_UNIVERSE)).ffill()
    vix = get_bars("VIX")["close"]; vix3m = get_bars("VIX3M")["close"]

    sw = {"trend": trend.strategy(etf), "crypto": crypto_trend.strategy(etf), "tom": flow.turn_of_month(etf)}
    sr = {k: run_backtest(etf, v)["returns"] for k, v in sw.items()}
    bw = (allocator.combine(sw, sr, allocator.DEFAULT_CAPS) * allocator.DEFAULT_LEVERAGE).clip(upper=0.25)
    bw = allocator.apply_regime_gate(bw, vix.reindex(bw.index).ffill(), vix3m.reindex(bw.index).ffill())
    brain_r = run_backtest(etf, bw)["returns"]

    # Use the SAME params the live runner trades (single source of truth) so the
    # performance-tilt reflects reality and can't drift out of sync.
    from meanrev_runner import PARAMS as mr_params
    mr_r = run_backtest(stk, name_meanrev.strategy(stk, **mr_params))["returns"]
    return brain_r, mr_r


def compute_split() -> tuple[float, float, dict]:
    """Return (brain_budget, meanrev_budget, info). Falls back to the neutral
    70/30 split if anything goes wrong — the tilt is an enhancement, never a
    dependency. `info` carries the trailing returns for logging."""
    try:
        brain_r, mr_r = _bot_return_streams()
        # trailing LOOKBACK-day cumulative return per bot (most recent window)
        b_trail = (1 + brain_r.tail(LOOKBACK)).prod() - 1
        m_trail = (1 + mr_r.tail(LOOKBACK)).prod() - 1
        edge = b_trail - m_trail
        # normalize the edge by its own recent typical size so the tilt is stable
        edge_scale = (brain_r.tail(252) - mr_r.tail(252)).rolling(LOOKBACK).apply(
            lambda x: (1 + pd.Series(x)).prod() - 1, raw=False).abs().mean()
        edge_scale = edge_scale if edge_scale and edge_scale > 1e-6 else abs(edge) + 1e-6
        tilt = MAX_TILT * np.sign(edge) * min(abs(edge) / edge_scale, 1.0)
        brain_budget = float(np.clip(BASE_BRAIN_BUDGET + tilt, BRAIN_FLOOR, BRAIN_CEIL))
        info = {
            "brain_trail_42d": round(float(b_trail) * 100, 2),
            "meanrev_trail_42d": round(float(m_trail) * 100, 2),
            "tilt": round(float(tilt), 3),
            "leaning": "brain" if tilt > 0 else ("mean-rev" if tilt < 0 else "neutral"),
        }
        return brain_budget, round(1.0 - brain_budget, 4), info
    except Exception as e:
        return BASE_BRAIN_BUDGET, 1.0 - BASE_BRAIN_BUDGET, {"error": str(e)[:80], "fallback": True}


# ── 3-way split (brain / mean-rev / low-vol) ─────────────────────────────────
# Low-vol is FIXED at 15% (the validated 60/25/15 blend). We do NOT invent a
# 3-way performance tilt — that's unvalidated. The existing 2-way brain/mrev
# gentle tilt runs UNCHANGED inside the remaining 85%: compute the 2-way split,
# then scale both by 0.85 so brain+mrev+lowvol = 1.0.
LOWVOL_BUDGET = 0.15


def compute_split3() -> tuple[float, float, float, dict]:
    """Return (brain, meanrev, lowvol, info). lowvol fixed at 0.15; the validated
    2-way tilt is applied between brain and mean-rev inside their 0.85 share.
    Falls back to 0.60/0.25/0.15 if anything fails."""
    try:
        brain2, mrev2, info = compute_split()   # 2-way split summing to 1.0
        rest = 1.0 - LOWVOL_BUDGET               # 0.85
        brain = round(brain2 * rest, 4)
        mrev = round(mrev2 * rest, 4)
        info = {**info, "lowvol": LOWVOL_BUDGET, "split": "3-way (lowvol fixed 15%)"}
        return brain, mrev, LOWVOL_BUDGET, info
    except Exception as e:
        return 0.60, 0.25, LOWVOL_BUDGET, {"error": str(e)[:80], "fallback3": True}


if __name__ == "__main__":
    import warnings; warnings.filterwarnings("ignore")
    b, m, info = compute_split()
    print(f"[2-way] Brain: {b*100:.1f}%  |  Mean-rev: {m*100:.1f}%")
    print(f"        Info: {info}")
    b3, m3, l3, info3 = compute_split3()
    print(f"[3-way] Brain: {b3*100:.1f}%  |  Mean-rev: {m3*100:.1f}%  |  Low-vol: {l3*100:.1f}%  (sum {(b3+m3+l3)*100:.1f}%)")
    print(f"        Info: {info3}")
