"""
turnover_audit.py — How often is each sleeve ACTUALLY trading vs its backtest rate?

Over-trading is the #1 silent killer (it retired the old ORB bot). This pulls the
real fill history from Alpaca and reports fills/day per sleeve, so churn shows up
loud. Found 2026-07-19: mean-rev was doing ~15 fills/day (8-10x its intended ~1-2)
because the runner re-traded held names on tiny weight drift — a spread leak. The
no-churn band in meanrev_runner.py fixes that; run this after a week to confirm the
fill rate dropped.

Read-only. Free. `python3 turnover_audit.py [days_back]` (default 90).
"""
from __future__ import annotations
import sys, os, datetime as dt
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

from meanrev_runner import _env, _alpaca, OUR_NAMES
from live_runner import ALL, to_alpaca

BRAIN = set(to_alpaca(s) for s in ALL)

# Rough backtest-expected fills/day per sleeve (for the "×over" column).
EXPECTED_PER_DAY = {"brain-etf": 8.0, "crypto": 2.0, "mrev/lowvol": 2.0}


def sleeve(sym: str) -> str:
    if "USD" in sym:
        return "crypto"
    if sym in BRAIN:
        return "brain-etf"
    if sym in OUR_NAMES:
        return "mrev/lowvol"
    return "other"


def main(days_back: int = 90):
    env = _env()
    acts, tok = [], None
    for _ in range(30):
        url = "/v2/account/activities/FILL?page_size=100&direction=asc" + (f"&page_token={tok}" if tok else "")
        b = _alpaca(env, "GET", url)
        if not b:
            break
        acts += b
        tok = b[-1].get("id")
        if len(b) < 100:
            break

    cutoff = (dt.datetime.now(dt.UTC).date() - dt.timedelta(days=days_back)).isoformat()
    acts = [a for a in acts if a["transaction_time"][:10] >= cutoff]
    if not acts:
        print("no fills in window")
        return

    byday = defaultdict(lambda: defaultdict(int))
    for a in acts:
        byday[a["transaction_time"][:10]][sleeve(a.get("symbol", ""))] += 1
    days = sorted(byday)
    tot = defaultdict(int)
    for d in days:
        for s, n in byday[d].items():
            tot[s] += n

    print(f"{len(acts)} fills across {len(days)} trading days ({days[0]} -> {days[-1]})")
    print(f"  {'sleeve':14}{'fills':>7}{'/day':>8}{'expected':>10}{'×over':>7}")
    for s in sorted(tot):
        perday = tot[s] / len(days)
        exp = EXPECTED_PER_DAY.get(s)
        over = f"{perday/exp:.1f}x" if exp else "-"
        print(f"  {s:14}{tot[s]:>7}{perday:>8.1f}{(exp or '-'):>10}{over:>7}")
    print("  (×over > ~2 on mrev/lowvol = churn leak; each extra fill pays the spread)")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    main(n)
