"""
spike_research.py — Honest research into "can we predict a stock about to pop?"

Runs 4 studies over real daily data (147 large-caps, ~44yr, survivorship-clean):

  #4 REALITY CHECK — of all big up-days (>=+7% in a day), how many had a WARNING
     SIGN in the prior days (elevated volume / prior momentum) vs came from nowhere?
     Also: the survivorship trap — how many stocks showed the SAME pre-condition but
     did NOT pop? This sets the honest baseline.

  #1 VOLUME+PRICE SURGE — when a stock has volume >Nx normal AND a price jump, what
     happens over the next 1-5 days, across ALL such cases (winners + losers)?

  #2 POST-EARNINGS DRIFT — proxy: a large 1-day gap up (earnings-like surprise) that
     ISN'T too big; do the next 5-20 days drift up? (We lack an earnings calendar, so
     we use the gap as the event proxy — documented to capture most of the effect.)

  #3 52-WEEK HIGH BREAKOUT — when a stock makes a new 52-week high on volume, does it
     keep running over the next days/weeks, or fade?

Every study reports the result NET of a realistic round-trip cost, and reports the
BASE RATE (what a random day does) so we can see if the setup actually beats noise.
"""

from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
import pandas as pd
from data import get_bars
from stock_universe import STOCK_UNIVERSE

COST = 0.001   # 0.10% round-trip (generous for liquid names; movers cost more)

# Higher-volatility / mid-cap / known-spiky names (verified to have clean recent data).
# These spike FAR more than the large-cap core, so they give a better read on the
# "about to pop" question — though survivorship bias still understates the true picture
# (dead names like NKLA/WISH are missing entirely).
VOLATILE_EXTRA = [
    "SOFI","PLUG","FUBO","WKHS","RIOT","MARA","AMC","CLOV","SNDL","SPCE","LCID","RIVN",
    "CVNA","UPST","AFRM","RBLX","HOOD","DKNG","PLTR","OPEN","CLSK","BYND","DNA","CHPT","QS",
]
RESEARCH_UNIVERSE = sorted(set(STOCK_UNIVERSE) | set(VOLATILE_EXTRA))


def load_all() -> dict[str, pd.DataFrame]:
    out = {}
    for s in RESEARCH_UNIVERSE:
        try:
            df = get_bars(s)
            if len(df) > 300:
                out[s] = df
        except Exception:
            pass
    return out


def fwd_return(close: pd.Series, i: int, horizon: int) -> float | None:
    """Return from close[i] to close[i+horizon], net of round-trip cost."""
    if i + horizon >= len(close):
        return None
    entry = close.iloc[i]
    exit_ = close.iloc[i + horizon]
    if entry <= 0:
        return None
    return (exit_ / entry - 1) - COST


def pct_stats(vals: list[float]) -> dict:
    a = np.array([v for v in vals if v is not None])
    if len(a) == 0:
        return dict(n=0, mean=0, win=0, median=0)
    return dict(n=len(a), mean=a.mean() * 100, win=(a > 0).mean() * 100, median=np.median(a) * 100)


# ─── BASE RATE: what does a RANDOM day's forward return look like? ────────────
def base_rate(data, horizon=5):
    vals = []
    for s, df in data.items():
        c = df["close"].reset_index(drop=True)
        step = max(1, len(c) // 200)  # sample to keep it fast
        for i in range(200, len(c) - horizon, step):
            r = fwd_return(c, i, horizon)
            if r is not None:
                vals.append(r)
    return pct_stats(vals)


# ─── #4 REALITY CHECK ────────────────────────────────────────────────────────
def reality_check(data, spike=0.07):
    """Find big up-days; measure how many had a warning sign in the prior 5 days."""
    n_spikes = 0
    had_vol_warning = 0     # volume building before the pop
    had_mom_warning = 0     # price already drifting up before the pop
    came_from_nowhere = 0
    # survivorship trap: count days WITH the warning condition that did NOT pop
    warning_days = 0
    warning_then_pop = 0

    for s, df in data.items():
        c = df["close"].reset_index(drop=True)
        v = df["volume"].reset_index(drop=True)
        ret = c.pct_change()
        vol_avg = v.rolling(20).mean()
        mom5 = c.pct_change(5)

        for i in range(25, len(c) - 1):
            # warning condition present on day i?
            vol_hot = v.iloc[i] > 1.5 * vol_avg.iloc[i] if vol_avg.iloc[i] > 0 else False
            mom_up  = mom5.iloc[i] > 0.03
            warned  = bool(vol_hot or mom_up)
            popped_next = ret.iloc[i + 1] >= spike  # big up-day tomorrow
            if warned:
                warning_days += 1
                if popped_next:
                    warning_then_pop += 1
            # classify the spike itself
            if ret.iloc[i] >= spike:
                n_spikes += 1
                # look at the 5 days BEFORE the spike
                pre_vol = (v.iloc[i-5:i] > 1.5 * vol_avg.iloc[i-5:i]).any() if vol_avg.iloc[i-1] > 0 else False
                pre_mom = mom5.iloc[i-1] > 0.03
                if pre_vol: had_vol_warning += 1
                if pre_mom: had_mom_warning += 1
                if not pre_vol and not pre_mom: came_from_nowhere += 1

    print("\n" + "=" * 70)
    print("  #4  REALITY CHECK — are big up-days (>=+7% in a day) predictable?")
    print("=" * 70)
    print(f"  Total big up-days found: {n_spikes:,}")
    if n_spikes:
        print(f"    had VOLUME warning in prior 5d:   {had_vol_warning:,} ({had_vol_warning/n_spikes*100:.0f}%)")
        print(f"    had MOMENTUM warning in prior 5d: {had_mom_warning:,} ({had_mom_warning/n_spikes*100:.0f}%)")
        print(f"    came from NOWHERE (no warning):   {came_from_nowhere:,} ({came_from_nowhere/n_spikes*100:.0f}%)")
    print(f"\n  THE SURVIVORSHIP TRAP (the part Cash App hides):")
    print(f"    Days that showed the 'warning' signal:     {warning_days:,}")
    print(f"    ...of those, how many ACTUALLY popped next: {warning_then_pop:,} "
          f"({warning_then_pop/max(warning_days,1)*100:.1f}%)")
    print(f"    → So when you see the 'warning' sign, the pop happens only "
          f"{warning_then_pop/max(warning_days,1)*100:.1f}% of the time.")
    print(f"    The other {100-warning_then_pop/max(warning_days,1)*100:.1f}% look identical and DON'T pop.")


# ─── #1 VOLUME + PRICE SURGE ─────────────────────────────────────────────────
def volume_surge(data, vol_mult=3.0, price_jump=0.04, horizons=(1, 3, 5)):
    results = {h: [] for h in horizons}
    for s, df in data.items():
        c = df["close"].reset_index(drop=True)
        v = df["volume"].reset_index(drop=True)
        ret = c.pct_change()
        vol_avg = v.rolling(20).mean()
        for i in range(25, len(c) - max(horizons)):
            if vol_avg.iloc[i] > 0 and v.iloc[i] > vol_mult * vol_avg.iloc[i] and ret.iloc[i] >= price_jump:
                for h in horizons:
                    r = fwd_return(c, i, h)
                    if r is not None: results[h].append(r)
    print("\n" + "=" * 70)
    print(f"  #1  VOLUME SURGE — vol >{vol_mult}x avg AND price up >{price_jump*100:.0f}% in a day")
    print("=" * 70)
    print(f"  {'hold':>6}{'cases':>8}{'avg ret%':>10}{'win%':>8}{'median%':>10}")
    for h in horizons:
        st = pct_stats(results[h])
        print(f"  {h:>4}d {st['n']:>8}{st['mean']:>+10.2f}{st['win']:>8.0f}{st['median']:>+10.2f}")
    return results


# ─── #2 POST-EARNINGS-DRIFT proxy (gap-up event) ─────────────────────────────
def earnings_drift(data, gap_min=0.04, gap_max=0.10, horizons=(5, 10, 20)):
    results = {h: [] for h in horizons}
    for s, df in data.items():
        o = df["open"].reset_index(drop=True)
        c = df["close"].reset_index(drop=True)
        prev_close = c.shift(1)
        for i in range(25, len(c) - max(horizons)):
            if prev_close.iloc[i] > 0:
                gap = o.iloc[i] / prev_close.iloc[i] - 1   # overnight gap (earnings-like surprise)
                if gap_min <= gap <= gap_max:
                    for h in horizons:
                        r = fwd_return(c, i, h)
                        if r is not None: results[h].append(r)
    print("\n" + "=" * 70)
    print(f"  #2  EARNINGS-DRIFT PROXY — overnight gap up {gap_min*100:.0f}-{gap_max*100:.0f}% (surprise, not too big)")
    print("=" * 70)
    print(f"  {'hold':>6}{'cases':>8}{'avg ret%':>10}{'win%':>8}{'median%':>10}")
    for h in horizons:
        st = pct_stats(results[h])
        print(f"  {h:>4}d {st['n']:>8}{st['mean']:>+10.2f}{st['win']:>8.0f}{st['median']:>+10.2f}")
    return results


# ─── #3 52-WEEK HIGH BREAKOUT ────────────────────────────────────────────────
def high_breakout(data, horizons=(5, 10, 20)):
    results = {h: [] for h in horizons}
    for s, df in data.items():
        c = df["close"].reset_index(drop=True)
        v = df["volume"].reset_index(drop=True)
        hi_252 = c.rolling(252).max()
        vol_avg = v.rolling(20).mean()
        for i in range(255, len(c) - max(horizons)):
            # new 52w high today, on above-avg volume, and wasn't a high yesterday
            if (c.iloc[i] >= hi_252.iloc[i] and c.iloc[i-1] < hi_252.iloc[i-1]
                    and vol_avg.iloc[i] > 0 and v.iloc[i] > vol_avg.iloc[i]):
                for h in horizons:
                    r = fwd_return(c, i, h)
                    if r is not None: results[h].append(r)
    print("\n" + "=" * 70)
    print("  #3  52-WEEK HIGH BREAKOUT — new 1-year high on above-average volume")
    print("=" * 70)
    print(f"  {'hold':>6}{'cases':>8}{'avg ret%':>10}{'win%':>8}{'median%':>10}")
    for h in horizons:
        st = pct_stats(results[h])
        print(f"  {h:>4}d {st['n']:>8}{st['mean']:>+10.2f}{st['win']:>8.0f}{st['median']:>+10.2f}")
    return results


if __name__ == "__main__":
    print("Loading 147 large-caps (~44yr history)...")
    data = load_all()
    print(f"Loaded {len(data)} stocks.")

    for h in (5,):
        b = base_rate(data, h)
        print(f"\n  BASE RATE (random {h}-day hold): avg {b['mean']:+.2f}%  win {b['win']:.0f}%  "
              f"(this is what ANY setup must BEAT to be real)")

    reality_check(data)
    volume_surge(data)
    earnings_drift(data)
    high_breakout(data)

    print("\n" + "=" * 70)
    print("  Each pattern is REAL only if it clearly beats the base rate above,")
    print("  AFTER the 0.10% cost already subtracted. Read the avg-return column.")
    print("=" * 70)
