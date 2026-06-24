"""
validate_drift.py — Stress-test the post-earnings-drift (gap-up) edge before trusting it.

The first study found gap-up -> +3.8% over 20d. Before building a tool, confirm it's REAL:
  A. SLIPPAGE — survives 0.1% / 0.5% / 1.0% round-trip costs? (volatile names cost more)
  B. SUB-GROUP — does it hold on the volatile/smaller names (where you'd trade), or only
     on calm large-caps? And does gap SIZE matter?
  C. ERA — is it consistent across decades, or carried by one lucky period?
  D. DOWNSIDE — what's the worst case? distribution, not just the average.

A real edge survives cost, shows up in the recent era, and works on the names you'd use.
"""

from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd
from data import get_bars
from stock_universe import STOCK_UNIVERSE
from spike_research import VOLATILE_EXTRA

LARGE = STOCK_UNIVERSE
VOLATILE = VOLATILE_EXTRA


def load(names):
    out = {}
    for s in names:
        try:
            df = get_bars(s)
            if len(df) > 300: out[s] = df
        except Exception: pass
    return out


def collect_drift(data, gap_min, gap_max, horizon, cost):
    """Return list of (forward_return_net, year) for each gap-up event."""
    rows = []
    for s, df in data.items():
        o = df["open"].reset_index(drop=True)
        c = df["close"].reset_index(drop=True)
        dates = df.index
        prev = c.shift(1)
        for i in range(25, len(c) - horizon):
            if prev.iloc[i] > 0:
                gap = o.iloc[i] / prev.iloc[i] - 1
                if gap_min <= gap <= gap_max and c.iloc[i] > 0:
                    r = (c.iloc[i + horizon] / c.iloc[i] - 1) - cost
                    rows.append((r, dates[i].year))
    return rows


def summary(rows):
    if not rows: return dict(n=0, mean=0, win=0, median=0, p10=0, p90=0)
    a = np.array([r for r, _ in rows])
    return dict(n=len(a), mean=a.mean()*100, win=(a>0).mean()*100,
                median=np.median(a)*100, p10=np.percentile(a,10)*100, p90=np.percentile(a,90)*100)


def main():
    print("Loading universes...")
    large = load(LARGE)
    vol   = load(VOLATILE)
    print(f"  Large-cap: {len(large)} | Volatile/smaller: {len(vol)}\n")

    # ── A. SLIPPAGE STRESS (20-day hold, the best horizon) ──────────────────
    print("=" * 68)
    print("  A. SLIPPAGE STRESS — gap-up 4-10%, 20-day hold, ALL names")
    print("=" * 68)
    alld = {**large, **vol}
    print(f"  {'round-trip cost':>18}{'cases':>8}{'avg ret%':>10}{'win%':>8}")
    for cost in (0.001, 0.005, 0.010, 0.02):
        rows = collect_drift(alld, 0.04, 0.10, 20, cost)
        s = summary(rows)
        flag = "  ✅" if s["mean"] > 0.5 else "  ❌ gone"
        print(f"  {cost*100:>16.1f}% {s['n']:>8}{s['mean']:>+10.2f}{s['win']:>8.0f}{flag}")

    # ── B. SUB-GROUP: large vs volatile, and gap size ───────────────────────
    print("\n" + "=" * 68)
    print("  B. WHERE does it work? (20-day hold, 0.5% cost — realistic)")
    print("=" * 68)
    for label, dset in [("Large-cap (calm)", large), ("Volatile/smaller", vol)]:
        s = summary(collect_drift(dset, 0.04, 0.10, 20, 0.005))
        print(f"  {label:<20} cases {s['n']:>6}  avg {s['mean']:>+6.2f}%  win {s['win']:.0f}%  "
              f"[10th pct {s['p10']:+.1f}% / 90th {s['p90']:+.1f}%]")
    print("\n  Does gap SIZE matter? (volatile names, 20d, 0.5% cost)")
    for lo, hi in [(0.02,0.04),(0.04,0.07),(0.07,0.12),(0.12,0.25)]:
        s = summary(collect_drift(vol, lo, hi, 20, 0.005))
        print(f"    gap {lo*100:>2.0f}-{hi*100:>2.0f}%:  cases {s['n']:>5}  avg {s['mean']:>+6.2f}%  win {s['win']:.0f}%")

    # ── C. ERA CONSISTENCY (all names, 0.5% cost) ───────────────────────────
    print("\n" + "=" * 68)
    print("  C. ERA CONSISTENCY — is it broad or one lucky period? (20d, 0.5% cost)")
    print("=" * 68)
    rows = collect_drift(alld, 0.04, 0.10, 20, 0.005)
    by_era = {}
    for r, y in rows:
        era = f"{(y//5)*5}s"
        by_era.setdefault(era, []).append(r)
    for era in sorted(by_era):
        a = np.array(by_era[era])
        print(f"    {era}:  cases {len(a):>5}  avg {a.mean()*100:>+6.2f}%  win {(a>0).mean()*100:.0f}%")

    # ── D. VERDICT ──────────────────────────────────────────────────────────
    print("\n" + "=" * 68)
    s_real = summary(collect_drift(alld, 0.04, 0.10, 20, 0.005))
    print(f"  REALISTIC EDGE (all names, 0.5% cost, 20d): avg {s_real['mean']:+.2f}%  win {s_real['win']:.0f}%")
    print(f"  Worst-decile outcome: {s_real['p10']:+.1f}%  |  best-decile: {s_real['p90']:+.1f}%")
    print(f"  → For a $50 trade: typical +${50*s_real['mean']/100:.2f}, but a bad one ~${50*s_real['p10']/100:.2f}")
    print("=" * 68)


if __name__ == "__main__":
    main()
