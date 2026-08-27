"""
slippage_tracker.py — Execution-quality monitor (the quant-desk piece).

The backtest assumes it trades at the daily close it computed signals on. Live, we
fill at the NEXT open plus whatever spread/impact we pay. The gap between the two is
SLIPPAGE — the silent difference between "backtest said +7%" and "we actually got +X".
A real quant desk tracks this obsessively; we had zero visibility into it.

For each filled order it compares filled_avg_price to the fill-DAY OPEN (not the prior
close — that gap is overnight market drift, not slippage), signs it so positive = we
paid worse than the open, and aggregates bps per sleeve. The engine charges 3bps/side
(ETF) / 15bps (crypto) in backtests — this tells us whether reality matches or is worse.

Read-only. Free (Alpaca reads + cached Yahoo closes). Run weekly or after runs.
`python3 slippage_tracker.py [days_back]` (default 30).
"""
from __future__ import annotations
import sys, os, json, datetime as dt
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

from meanrev_runner import _env, _alpaca, discord, OUR_NAMES
from live_runner import ALL, to_alpaca, canon
from data import get_bars
import ownership

BRAIN = set(canon(to_alpaca(s)) for s in ALL)
LOG_DIR = os.path.join(os.path.dirname(__file__), "live_logs")
# The cost the BACKTEST assumes per side — reality should be near this, not far above.
ASSUMED_BPS = {"crypto": 15.0, "equity": 3.0}


def sleeve(sym: str, lowvol_syms: set) -> str:
    if canon(sym) in BRAIN:
        return "crypto" if "USD" in sym else "brain-etf"
    if sym in lowvol_syms:
        return "lowvol"
    if sym in OUR_NAMES:
        return "mrev"
    return "other"


def ref_open(sym: str, filled_date: str) -> float | None:
    """Reference = the fill DAY's OPEN. This isolates true execution cost (spread +
    impact) from the overnight gap: the strategy decides on the prior close, but the
    order executes at the open, and the close->open drift is market movement, NOT
    slippage the broker charged us. Comparing fill vs same-day open measures only how
    much worse than the open we actually transacted. Uses the cached daily panel."""
    ysym = sym.replace("USD", "-USD") if sym.endswith("USD") and "/" not in sym else sym
    ysym = ysym.replace("/USD", "-USD")
    try:
        bars = get_bars(ysym)
    except Exception:
        return None
    fd = dt.date.fromisoformat(filled_date)
    same = bars[bars.index.date == fd]
    if len(same) == 0 or "open" not in same.columns:
        return None
    o = float(same["open"].iloc[0])
    return o if o > 0 else None


def main(days_back: int = 30):
    env = _env()
    lowvol_syms = ownership.owned_symbols("lowvol")
    orders, tok = [], None
    for _ in range(20):
        url = "/v2/orders?status=filled&limit=100&direction=desc" + (f"&page_token={tok}" if tok else "")
        b = _alpaca(env, "GET", url)
        if not b:
            break
        orders += b
        if len(b) < 100:
            break
        tok = b[-1]["id"]

    cutoff = (dt.datetime.now(dt.UTC).date() - dt.timedelta(days=days_back)).isoformat()
    agg = defaultdict(lambda: {"bps": [], "notional": 0.0})
    for o in orders:
        if not o.get("filled_at") or o["filled_at"][:10] < cutoff:
            continue
        px = float(o.get("filled_avg_price") or 0)
        qty = float(o.get("filled_qty") or 0)
        if px <= 0 or qty <= 0:
            continue
        ref = ref_open(o["symbol"], o["filled_at"][:10])
        if not ref or ref <= 0:
            continue
        # signed slippage in bps: buys worse if we paid ABOVE ref; sells worse if BELOW
        raw = (px - ref) / ref
        slip = raw if o["side"] == "buy" else -raw
        s = sleeve(o["symbol"], lowvol_syms)
        agg[s]["bps"].append(slip * 1e4)
        agg[s]["notional"] += px * qty

    print(f"Execution slippage vs same-day OPEN, last {days_back}d "
          f"(+ = filled worse than the open; overnight drift excluded):\n")
    print(f"  {'sleeve':10}{'fills':>6}{'avg bps':>9}{'median':>8}{'assumed':>9}{'verdict':>12}")
    alerts = []
    for s in ("brain-etf", "crypto", "mrev", "lowvol"):
        d = agg.get(s)
        if not d or not d["bps"]:
            continue
        bps = sorted(d["bps"])
        avg = sum(bps) / len(bps)
        med = bps[len(bps) // 2]
        assumed = ASSUMED_BPS["crypto"] if s == "crypto" else ASSUMED_BPS["equity"]
        verdict = "OK" if avg <= assumed * 1.5 else "HIGH"
        if verdict == "HIGH":
            alerts.append(f"{s} slippage {avg:.1f}bps vs assumed {assumed:.0f}bps")
        print(f"  {s:10}{len(bps):>6}{avg:>9.1f}{med:>8.1f}{assumed:>9.0f}{verdict:>12}")

    print("\n  avg bps = average price paid worse than the same-day open (true execution cost).")
    print("  'HIGH' = live execution is materially worse than the backtest assumed (edge leak).")
    if alerts:
        discord(env, "📏 **Execution slippage alert**\n" + "\n".join(alerts) +
                "\nLive fills are worse than the backtest assumes — real edge < backtest edge.")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    main(n)
