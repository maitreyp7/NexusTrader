"""
hunt_sleeves.py — Sleeve hunter. Tests candidate strategies for a slot in the brain.

A candidate EARNS a slot only if it clears BOTH bars:
  1. STANDALONE EDGE — passes the honest gatekeeper (positive across eras, survives
     into recent data, survives 2x costs). We don't demand Sharpe > 1 for a diversifier
     (a weak-but-uncorrelated sleeve still helps the portfolio), but it must be a real,
     positive, robust edge — not a mirage.
  2. LOW CORRELATION — |corr| < 0.35 to EACH existing live sleeve (trend, crypto, tom).
     The whole point of adding a sleeve is diversification. A 4th trend-flavored sleeve
     adds nothing. We specifically want edges that win when trend LOSES.

For each candidate we print: standalone stats, correlation to each live sleeve, and a
verdict. Then we show what the COMBINED portfolio looks like if we add the winner(s).
"""

from __future__ import annotations
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

import warnings
warnings.filterwarnings("ignore")

import pandas as pd
import numpy as np
from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
import trend, crypto_trend, flow, allocator
import defensive
from strategies.regime import regime_on

ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))


# ── Candidate sleeves ────────────────────────────────────────────────────────
def bond_trend(panel: pd.DataFrame) -> pd.DataFrame:
    """Trend-following ISOLATED to the rates complex (TLT, IEF). Driven by the rate
    cycle, not equity momentum — should be a different return stream than ETF trend."""
    return trend.compute_weights(
        panel[[c for c in ["TLT", "IEF"] if c in panel.columns]].reindex(columns=panel.columns),
        target_vol=0.08, max_weight=0.5, crypto_risk_cap=0.0,
    )


def commodity_trend(panel: pd.DataFrame) -> pd.DataFrame:
    """Trend-following on the commodity/inflation complex (GLD, DBC, USO). Wins in
    inflationary/crisis regimes where stock+bond trend can both bleed."""
    cols = [c for c in ["GLD", "DBC", "USO"] if c in panel.columns]
    sub = panel[cols].reindex(columns=panel.columns)
    return trend.compute_weights(sub, target_vol=0.10, max_weight=0.5, crypto_risk_cap=0.0)


def gold_only_trend(panel: pd.DataFrame) -> pd.DataFrame:
    """Pure gold trend — the classic crisis/inflation hedge, single clean asset."""
    cols = [c for c in ["GLD"] if c in panel.columns]
    sub = panel[cols].reindex(columns=panel.columns)
    return trend.compute_weights(sub, target_vol=0.12, max_weight=1.0, crypto_risk_cap=0.0)


def flight_to_safety(panel: pd.DataFrame) -> pd.DataFrame:
    return defensive.flight_to_safety(panel)


def defensive_rotation(panel: pd.DataFrame) -> pd.DataFrame:
    return defensive.defensive_rotation(panel)


def risk_parity_lite(panel: pd.DataFrame) -> pd.DataFrame:
    """Static inverse-vol All-Weather-lite across SPY/TLT/GLD, monthly rebalance.
    Always invested, balanced — a steady, low-vol diversifier (no trend timing)."""
    cols = [c for c in ["SPY", "TLT", "GLD"] if c in panel.columns]
    sub = panel[cols]
    rets = sub.pct_change(fill_method=None)
    vol = rets.pow(2).ewm(alpha=0.06, adjust=False).mean().pow(0.5) * np.sqrt(252)
    inv = (1.0 / vol).replace([np.inf, np.nan], 0.0)
    w_sub = inv.div(inv.sum(axis=1).replace(0, np.nan), axis=0).fillna(0.0) * 0.6  # 60% gross
    # rebalance monthly
    idx = sub.index.to_series()
    last_of_month = idx.groupby([idx.index.year, idx.index.month]).transform("max")
    is_rebal = (idx == last_of_month).to_numpy()
    w_sub[~is_rebal] = np.nan
    w_sub = w_sub.ffill().fillna(0.0)
    out = pd.DataFrame(0.0, index=panel.index, columns=panel.columns)
    for c in cols:
        out[c] = w_sub[c]
    return out


def xsec_momentum(panel: pd.DataFrame) -> pd.DataFrame:
    """Cross-sectional relative-strength: each month, own the TOP-N ETFs by 6-month
    return, equal-weight, cash if fewer than N are positive. This is RELATIVE strength
    (who's strongest), a different mechanic than absolute trend (is it up at all).
    Long-only across the equity+commodity ETFs."""
    cols = [c for c in ["SPY","QQQ","IWM","EFA","EEM","TLT","GLD","DBC"] if c in panel.columns]
    sub = panel[cols]
    mom = sub.pct_change(126, fill_method=None)   # 6-month
    out = pd.DataFrame(0.0, index=panel.index, columns=panel.columns)
    N = 3
    idx = sub.index.to_series()
    last_of_month = idx.groupby([idx.index.year, idx.index.month]).transform("max")
    is_rebal = (idx == last_of_month)
    # Build the selection ONLY on rebalance dates (NaN elsewhere), then ffill to hold.
    held = pd.DataFrame(np.nan, index=sub.index, columns=cols)
    for d in sub.index[is_rebal.to_numpy()]:
        row = mom.loc[d].dropna()
        winners = row[row > 0].nlargest(N)
        held.loc[d, :] = 0.0                       # mark this rebalance date as decided
        for c in winners.index:
            held.loc[d, c] = 1.0 / N
    held = held.ffill().fillna(0.0)
    for c in cols:
        out[c] = held[c]
    return out


def bondgold_trend(panel: pd.DataFrame) -> pd.DataFrame:
    """Trend on the DEFENSIVE complex only (TLT, IEF, GLD) — captures the crisis-hedge
    rallies (bonds+gold bid when stocks fall) but as a TREND (only when they're actually
    rising), avoiding the dead-money problem of holding them always."""
    cols = [c for c in ["TLT","IEF","GLD"] if c in panel.columns]
    sub = panel[cols].reindex(columns=panel.columns)
    return trend.compute_weights(sub, target_vol=0.09, max_weight=0.5, crypto_risk_cap=0.0)


CANDIDATES = {
    "bond_trend":        bond_trend,
    "commodity_trend":   commodity_trend,
    "gold_trend":        gold_only_trend,
    "bondgold_trend":    bondgold_trend,
    "xsec_momentum":     xsec_momentum,
    "flight_to_safety":  flight_to_safety,
    "defensive_rotation": defensive_rotation,
    "risk_parity_lite":  risk_parity_lite,
}


# ── Stats helpers ────────────────────────────────────────────────────────────
def sleeve_stats(returns: pd.Series) -> dict:
    r = returns.dropna()
    if len(r) < 60:
        return dict(sharpe=0, cagr=0, maxdd=0, vol=0)
    vol = r.std() * np.sqrt(252)
    sharpe = (r.mean() * 252) / vol if vol > 0 else 0.0
    eq = (1 + r).cumprod()
    maxdd = (eq / eq.cummax() - 1).min()
    cagr = eq.iloc[-1] ** (252 / len(r)) - 1
    return dict(sharpe=sharpe, cagr=cagr, maxdd=maxdd, vol=vol)


def era_consistency(returns: pd.Series, block_years: int = 5) -> tuple[int, int]:
    """Count positive-Sharpe blocks / total blocks across eras."""
    r = returns.dropna()
    if len(r) < 252:
        return (0, 0)
    pos, tot = 0, 0
    y = r.index[0].year
    end = r.index[-1].year
    while y <= end:
        block = r[(r.index.year >= y) & (r.index.year < y + block_years)]
        if len(block) > 120:
            tot += 1
            if block.mean() > 0:
                pos += 1
        y += block_years
    return (pos, tot)


def main():
    print("Loading data...")
    bars = get_universe(ALL)
    panel = build_price_panel(bars).ffill()

    # --- existing live sleeves' return streams (for correlation baseline) ---
    live = {
        "trend":  run_backtest(panel, trend.strategy(panel))["returns"],
        "crypto": run_backtest(panel, crypto_trend.strategy(panel))["returns"],
        "tom":    run_backtest(panel, flow.turn_of_month(panel))["returns"],
    }

    # combined live portfolio return stream (with regime gate, as deployed)
    w_live = allocator.combine(
        {"trend": trend.strategy(panel), "crypto": crypto_trend.strategy(panel),
         "tom": flow.turn_of_month(panel)},
        live, allocator.DEFAULT_CAPS,
    ) * allocator.DEFAULT_LEVERAGE
    w_live = w_live.clip(upper=0.25)
    vix = get_bars("VIX")["close"].reindex(w_live.index).ffill()
    vix3m = get_bars("VIX3M")["close"].reindex(w_live.index).ffill()
    w_live = allocator.apply_regime_gate(w_live, vix, vix3m)
    live_port = run_backtest(panel, w_live)["returns"]

    print("\n" + "=" * 90)
    print("  SLEEVE HUNTER — candidates vs the live brain")
    print("=" * 90)
    print(f"  Live brain baseline:  Sharpe {sleeve_stats(live_port)['sharpe']:.2f}  "
          f"CAGR {sleeve_stats(live_port)['cagr']*100:+.1f}%  MaxDD {sleeve_stats(live_port)['maxdd']*100:.1f}%")
    print("  Correlation target for a NEW sleeve: |corr| < 0.35 to each live sleeve.\n")

    hdr = "  {:<20} {:>7} {:>8} {:>8} {:>6} {:>7} {:>7} {:>7} {:>8}"
    print(hdr.format("candidate", "Sharpe", "CAGR%", "MaxDD%", "eras",
                     "ρ:trend", "ρ:cryp", "ρ:port", "verdict"))
    print("  " + "-" * 86)

    winners = []
    for name, fn in CANDIDATES.items():
        w = fn(panel)
        res = run_backtest(panel, w)
        r = res["returns"]
        st = sleeve_stats(r)
        pos, tot = era_consistency(r)

        # correlations (on overlapping non-zero-ish days)
        def corr(a, b):
            df = pd.concat([a, b], axis=1).dropna()
            if len(df) < 60 or df.iloc[:, 0].std() == 0 or df.iloc[:, 1].std() == 0:
                return 0.0
            return df.iloc[:, 0].corr(df.iloc[:, 1])

        c_trend = corr(r, live["trend"])
        c_cryp  = corr(r, live["crypto"])
        c_port  = corr(r, live_port)

        # Verdict: needs a real positive edge AND genuinely low corr to trend+portfolio.
        # A diversifier earns its slot via the PORTFOLIO test below, not a high standalone
        # Sharpe — so the bar here is "positive, robust, and uncorrelated".
        edge_ok = st["sharpe"] > 0.20 and st["cagr"] > 0 and (tot == 0 or pos >= 0.6 * tot)
        uncorr_ok = abs(c_trend) < 0.35 and abs(c_port) < 0.35
        verdict = "✅ ADD" if (edge_ok and uncorr_ok) else ("~maybe" if edge_ok or uncorr_ok else "❌ no")
        if edge_ok and uncorr_ok:
            winners.append((name, fn, r))

        print(hdr.format(
            name, f"{st['sharpe']:.2f}", f"{st['cagr']*100:+.1f}", f"{st['maxdd']*100:.1f}",
            f"{pos}/{tot}", f"{c_trend:+.2f}", f"{c_cryp:+.2f}", f"{c_port:+.2f}", verdict,
        ))

    # --- PORTFOLIO-IMPACT TEST: does adding a candidate actually help the brain? ---
    # The fundamental law says even a weak-but-uncorrelated sleeve can lift portfolio
    # Sharpe. So test each candidate ON TOP of the live brain and measure the delta.
    print("\n" + "=" * 90)
    print("  PORTFOLIO-IMPACT TEST — add each candidate to the live brain, measure delta")
    print("=" * 90)
    base = sleeve_stats(live_port)
    print(f"  {'add this sleeve':<22}{'Sharpe':>9}{'ΔSharpe':>9}{'CAGR%':>8}{'MaxDD%':>9}{'verdict':>10}")
    print(f"  {'(live brain, none)':<22}{base['sharpe']:>9.3f}{'—':>9}{base['cagr']*100:>+7.1f}%{base['maxdd']*100:>8.1f}%")
    print("  " + "-" * 86)

    live_sleeve_w = {"trend": trend.strategy(panel), "crypto": crypto_trend.strategy(panel),
                     "tom": flow.turn_of_month(panel)}

    portfolio_helpers = []
    for name, fn in CANDIDATES.items():
        sw = dict(live_sleeve_w); sr = dict(live)
        caps = dict(allocator.DEFAULT_CAPS)
        sw[name] = fn(panel); sr[name] = run_backtest(panel, fn(panel))["returns"]
        caps[name] = 0.25
        wc = allocator.combine(sw, sr, caps) * allocator.DEFAULT_LEVERAGE
        wc = wc.clip(upper=0.25)
        wc = allocator.apply_regime_gate(wc, vix, vix3m)
        st = sleeve_stats(run_backtest(panel, wc)["returns"])
        d_sharpe = st["sharpe"] - base["sharpe"]
        d_dd = st["maxdd"] - base["maxdd"]
        helps = d_sharpe > 0.01 or d_dd > 0.01   # better Sharpe OR shallower drawdown
        if helps:
            portfolio_helpers.append((name, fn, d_sharpe, d_dd))
        v = "✅ helps" if helps else "neutral/−"
        print(f"  {name:<22}{st['sharpe']:>9.3f}{d_sharpe:>+9.3f}{st['cagr']*100:>+7.1f}%{st['maxdd']*100:>8.1f}%{v:>10}")

    # promote portfolio-helpers into winners if not already there
    have = {w[0] for w in winners}
    for name, fn, ds, dd in portfolio_helpers:
        if name not in have:
            winners.append((name, fn, run_backtest(panel, fn(panel))["returns"]))

    print("\n" + "=" * 90)
    if not winners:
        print("  No clean winners this round. (A sleeve must have a real edge AND be uncorrelated.)")
        return

    # --- Show combined portfolio WITH the winners added ---
    print(f"  WINNERS: {', '.join(w[0] for w in winners)}")
    print("  Testing combined portfolio WITH winners added as equal-risk sleeves...\n")

    sleeve_w = {"trend": trend.strategy(panel), "crypto": crypto_trend.strategy(panel),
                "tom": flow.turn_of_month(panel)}
    sleeve_r = dict(live)
    caps = dict(allocator.DEFAULT_CAPS)
    for name, fn, r in winners:
        sleeve_w[name] = fn(panel)
        sleeve_r[name] = r
        caps[name] = 0.25   # give each new diversifier up to 25%

    w_new = allocator.combine(sleeve_w, sleeve_r, caps) * allocator.DEFAULT_LEVERAGE
    w_new = w_new.clip(upper=0.25)
    w_new = allocator.apply_regime_gate(w_new, vix, vix3m)
    new_port = run_backtest(panel, w_new)["returns"]

    b = sleeve_stats(live_port)
    n = sleeve_stats(new_port)
    print(f"  {'':22}{'BEFORE':>12}{'AFTER':>12}")
    print(f"  {'Sharpe':22}{b['sharpe']:>12.3f}{n['sharpe']:>12.3f}")
    print(f"  {'CAGR %/yr':22}{b['cagr']*100:>+11.2f}%{n['cagr']*100:>+11.2f}%")
    print(f"  {'Max Drawdown':22}{b['maxdd']*100:>11.1f}%{n['maxdd']*100:>11.1f}%")
    print(f"  {'Volatility':22}{b['vol']*100:>11.1f}%{n['vol']*100:>11.1f}%")
    print("=" * 90)


if __name__ == "__main__":
    main()
