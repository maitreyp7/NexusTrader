"""
tearsheet.py — Generate the README performance tearsheet for the combined 3-sleeve system.

Rebuilds the live blend (brain 51% / mean-rev 34% / low-vol 15%) exactly as deployed,
backtests it against SPY buy-and-hold, and writes a single PNG:

    quant/research/tearsheet.png

Panels:
  1. Log-scale equity curve, system vs SPY (log so a 13x return stays readable)
  2. Drawdown, system vs SPY (the whole point of the system — shallow drawdowns)
  3. Metrics table + crisis-period comparison

Run:  python3 research/tearsheet.py      (from quant/)
"""
from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
_QUANT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, _QUANT)
sys.path.insert(0, os.path.join(_QUANT, "strategies"))

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
from stock_universe import STOCK_UNIVERSE
import trend, crypto_trend, flow, allocator, name_meanrev, lowvol

# Live allocation (dynamic_budget.compute_split3 neutral case)
W_BRAIN, W_MREV, W_LOWVOL = 0.51, 0.34, 0.15

CRISES = [
    ("2008 GFC",   "2007-10-01", "2009-03-31"),
    ("2020 COVID", "2020-02-19", "2020-03-23"),
    ("2022 Bear",  "2022-01-03", "2022-10-12"),
]

BG      = "#0f1116"
FG      = "#e6e8ee"
GRID    = "#2a2f3a"
SYSTEM  = "#4da3ff"
BENCH   = "#8b93a5"
LOSS    = "#ff5c5c"


def stats(r: pd.Series) -> dict:
    r = r.dropna()
    if len(r) < 2:
        return dict(sharpe=0, cagr=0, maxdd=0, vol=0, total=0)
    vol = r.std() * np.sqrt(252)
    eq = (1 + r).cumprod()
    return dict(
        sharpe=(r.mean() * 252 / vol) if vol > 0 else 0.0,
        cagr=eq.iloc[-1] ** (252 / len(r)) - 1,
        maxdd=(eq / eq.cummax() - 1).min(),
        vol=vol,
        total=eq.iloc[-1] - 1,
    )


def period_return(r: pd.Series, start: str, end: str) -> float | None:
    w = r.loc[(r.index >= start) & (r.index <= end)].dropna()
    if len(w) < 2:
        return None
    return (1 + w).prod() - 1


def build_returns() -> tuple[pd.Series, pd.Series]:
    """Return (system_returns, spy_returns) aligned on a common index."""
    print("Fetching universes...")
    all_syms = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
    etf = build_price_panel(get_universe(all_syms)).ffill()
    stk = build_price_panel(get_universe(STOCK_UNIVERSE)).ffill()
    vix = get_bars("VIX")["close"]
    vix3m = get_bars("VIX3M")["close"]

    print("Backtesting brain (trend + crypto + turn-of-month, regime-gated)...")
    sleeves = {
        "trend":  trend.strategy(etf),
        "crypto": crypto_trend.strategy(etf),
        "tom":    flow.turn_of_month(etf),
    }
    sleeve_rets = {k: run_backtest(etf, v)["returns"] for k, v in sleeves.items()}
    bw = (allocator.combine(sleeves, sleeve_rets, allocator.DEFAULT_CAPS)
          * allocator.DEFAULT_LEVERAGE).clip(upper=0.25)
    bw = allocator.apply_regime_gate(
        bw,
        vix.reindex(bw.index).ffill(),
        vix3m.reindex(bw.index).ffill(),
    )
    brain_r = run_backtest(etf, bw)["returns"]

    print("Backtesting mean-reversion (RSI(2) on ~150 large caps)...")
    mrev_r = run_backtest(stk, name_meanrev.strategy(stk))["returns"]

    print("Backtesting low-volatility (15 lowest-vol names, monthly)...")
    lowvol_r = run_backtest(stk, lowvol.strategy(stk))["returns"]

    idx = brain_r.index.union(mrev_r.index).union(lowvol_r.index)
    brain_r  = brain_r.reindex(idx).fillna(0)
    mrev_r   = mrev_r.reindex(idx).fillna(0)
    lowvol_r = lowvol_r.reindex(idx).fillna(0)

    system_r = W_BRAIN * brain_r + W_MREV * mrev_r + W_LOWVOL * lowvol_r

    spy = get_bars("SPY")["adjclose"] if "adjclose" in get_bars("SPY") else get_bars("SPY")["close"]
    spy_r = spy.pct_change().reindex(idx).fillna(0)

    return system_r, spy_r


def render(system_r: pd.Series, spy_r: pd.Series, out_path: str) -> None:
    s_eq = (1 + system_r).cumprod()
    b_eq = (1 + spy_r).cumprod()
    s_dd = s_eq / s_eq.cummax() - 1
    b_dd = b_eq / b_eq.cummax() - 1
    s, b = stats(system_r), stats(spy_r)

    fig = plt.figure(figsize=(12, 11), facecolor=BG)
    gs = fig.add_gridspec(3, 1, height_ratios=[3.0, 1.5, 1.5], hspace=0.38,
                          left=0.09, right=0.96, top=0.90, bottom=0.05)

    start = s_eq.index[0].strftime("%Y")
    end = s_eq.index[-1].strftime("%Y")
    fig.suptitle("NexusTrader — Combined System vs. SPY", x=0.09, y=0.965,
                 ha="left", fontsize=19, fontweight="bold", color=FG)
    fig.text(0.09, 0.935,
             f"Brain 51% / Mean-Reversion 34% / Low-Volatility 15%   ·   "
             f"{start}–{end}   ·   net of transaction costs, no look-ahead",
             ha="left", fontsize=10.5, color=BENCH)

    # ---- Panel 1: equity (log) ----
    ax1 = fig.add_subplot(gs[0])
    ax1.plot(s_eq.index, s_eq.values, color=SYSTEM, lw=1.9, label="NexusTrader", zorder=3)
    ax1.plot(b_eq.index, b_eq.values, color=BENCH, lw=1.4, label="SPY (buy & hold)", zorder=2)
    ax1.set_yscale("log")
    ax1.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:.0f}x" if v >= 1 else f"{v:.1f}x"))
    ax1.set_ylabel("Growth of $1 (log scale)", fontsize=10, color=FG)
    ax1.legend(loc="upper left", frameon=False, fontsize=11, labelcolor=FG)
    _style(ax1)

    # ---- Panel 2: drawdown ----
    ax2 = fig.add_subplot(gs[1], sharex=ax1)
    ax2.fill_between(b_dd.index, b_dd.values * 100, 0, color=BENCH, alpha=0.45, label="SPY")
    ax2.fill_between(s_dd.index, s_dd.values * 100, 0, color=LOSS, alpha=0.85, label="NexusTrader")
    ax2.set_ylabel("Drawdown (%)", fontsize=10, color=FG)
    ax2.legend(loc="lower left", frameon=False, fontsize=10, labelcolor=FG)
    _style(ax2)

    # ---- Panel 3: metrics ----
    ax3 = fig.add_subplot(gs[2])
    ax3.axis("off")

    rows = [
        ["Sharpe ratio",   f"{s['sharpe']:.2f}",        f"{b['sharpe']:.2f}"],
        ["CAGR",           f"{s['cagr']*100:+.1f}%",    f"{b['cagr']*100:+.1f}%"],
        ["Max drawdown",   f"{s['maxdd']*100:.1f}%",    f"{b['maxdd']*100:.1f}%"],
        ["Annualized vol", f"{s['vol']*100:.1f}%",      f"{b['vol']*100:.1f}%"],
        ["Total return",   f"{s['total']*100:+,.0f}%",  f"{b['total']*100:+,.0f}%"],
    ]
    for name, a, bch in CRISES:
        sp, bp = period_return(system_r, a, bch), period_return(spy_r, a, bch)
        if sp is not None and bp is not None:
            rows.append([name, f"{sp*100:+.1f}%", f"{bp*100:+.1f}%"])

    tbl = ax3.table(
        cellText=rows,
        colLabels=["", "NexusTrader", "SPY"],
        cellLoc="right", colLoc="right", loc="upper center",
        colWidths=[0.34, 0.22, 0.22],
    )
    tbl.auto_set_font_size(False)
    tbl.set_fontsize(11)
    tbl.scale(1, 1.55)
    n_metrics = 5
    for (row, col), cell in tbl.get_celld().items():
        cell.set_edgecolor(GRID)
        cell.set_facecolor(BG)
        cell.get_text().set_color(FG)
        if col == 0:
            cell.set_text_props(ha="left")
            cell.get_text().set_color(BENCH if row > 0 else FG)
        if row == 0:
            cell.set_text_props(fontweight="bold")
            cell.get_text().set_color(SYSTEM if col == 1 else FG)
        elif col == 1:
            cell.get_text().set_color(SYSTEM)
        if row == n_metrics:                      # rule above crisis block
            cell.set_edgecolor(FG)
            cell.visible_edges = "B"

    fig.text(0.09, 0.028,
             "Backtested and paper-traded results. Not live capital. "
             "Past performance does not guarantee future results.",
             ha="left", fontsize=8.5, color=BENCH, style="italic")

    fig.savefig(out_path, dpi=160, facecolor=BG, bbox_inches="tight")
    print(f"\nWrote {out_path}")
    print(f"  System : Sharpe {s['sharpe']:.2f} | CAGR {s['cagr']*100:+.1f}% | MaxDD {s['maxdd']*100:.1f}%")
    print(f"  SPY    : Sharpe {b['sharpe']:.2f} | CAGR {b['cagr']*100:+.1f}% | MaxDD {b['maxdd']*100:.1f}%")


def _style(ax) -> None:
    ax.set_facecolor(BG)
    ax.grid(True, color=GRID, lw=0.6, alpha=0.7)
    ax.tick_params(colors=BENCH, labelsize=9.5)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)


if __name__ == "__main__":
    sysr, spyr = build_returns()
    render(sysr, spyr, os.path.join(HERE, "tearsheet.png"))
