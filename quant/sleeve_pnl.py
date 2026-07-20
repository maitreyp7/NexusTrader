"""
sleeve_pnl.py — Per-sleeve daily P&L logger + rolling live-vs-backtest drift check.

The gap this fills: for 3 months the system had NO per-sleeve accounting, so
"which bot is making money?" was unanswerable. This appends one row per day per
sleeve to live_logs/sleeve_pnl.jsonl (market value, unrealized P&L, today's fills),
then — once enough history accrues — compares each sleeve's rolling live return to
its backtest baseline and flags decay.

Read-only on Alpaca; places no orders. Run it from cron AFTER the bots + health
check (~6:05 PM ET). Free: pure API reads + a local append log.
"""
from __future__ import annotations
import sys, os, json, datetime as dt
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

from meanrev_runner import _env, _alpaca, discord, OUR_NAMES
from live_runner import ALL, to_alpaca
import ownership

BRAIN_SYMBOLS = set(to_alpaca(s) for s in ALL)
LOG_DIR = os.path.join(os.path.dirname(__file__), "live_logs")
PNL_LOG = os.path.join(LOG_DIR, "sleeve_pnl.jsonl")

# Backtest baselines (annualized) from the validation reports — the yardstick for drift.
BACKTEST_SHARPE = {"brain": 0.82, "mrev": 1.06, "lowvol": 1.05}
DRIFT_MIN_DAYS = 20          # don't judge drift on less than ~1 month of live data
DRIFT_ALERT_SHARPE = 0.0     # alert if a sleeve's live rolling Sharpe drops below 0


def classify(sym: str, lowvol_syms: set) -> str:
    if sym in BRAIN_SYMBOLS:
        return "brain"
    if sym in lowvol_syms:
        return "lowvol"
    if sym in OUR_NAMES:
        return "mrev"
    return "other"


def fills_today(env) -> dict:
    today = dt.datetime.now(dt.UTC).date().isoformat()
    orders = _alpaca(env, "GET", f"/v2/orders?status=filled&limit=500&after={today}T00:00:00Z") or []
    lowvol_syms = ownership.owned_symbols("lowvol")
    out = defaultdict(int)
    for o in orders:
        out[classify(o["symbol"], lowvol_syms)] += 1
    return out


def snapshot(env) -> dict:
    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    positions = _alpaca(env, "GET", "/v2/positions") or []
    lowvol_syms = ownership.owned_symbols("lowvol")
    mv, upl = defaultdict(float), defaultdict(float)
    for p in positions:
        s = classify(p["symbol"], lowvol_syms)
        mv[s] += float(p["market_value"])
        upl[s] += float(p["unrealized_pl"])
    f = fills_today(env)
    return {
        "date": dt.datetime.now(dt.UTC).date().isoformat(),
        "equity": round(equity, 2),
        "sleeves": {s: {"mv": round(mv[s], 2), "upl": round(upl[s], 2), "fills": f.get(s, 0)}
                    for s in ("brain", "mrev", "lowvol", "other")},
    }


def append(row: dict):
    os.makedirs(LOG_DIR, exist_ok=True)
    # idempotent: don't double-log the same date
    if os.path.exists(PNL_LOG):
        existing = [json.loads(l) for l in open(PNL_LOG) if l.strip()]
        existing = [r for r in existing if r["date"] != row["date"]]
        with open(PNL_LOG, "w") as fh:
            for r in existing:
                fh.write(json.dumps(r) + "\n")
    with open(PNL_LOG, "a") as fh:
        fh.write(json.dumps(row) + "\n")


def drift_report() -> list[str]:
    """Rolling live-vs-backtest drift, per sleeve. Needs >= DRIFT_MIN_DAYS of history."""
    if not os.path.exists(PNL_LOG):
        return []
    rows = [json.loads(l) for l in open(PNL_LOG) if l.strip()]
    if len(rows) < DRIFT_MIN_DAYS:
        return [f"drift check: {len(rows)}/{DRIFT_MIN_DAYS} days logged — need more history"]
    import statistics as st
    alerts = []
    for s in ("brain", "mrev", "lowvol"):
        # daily sleeve return ≈ change in (mv+cumulative realized) is unavailable here;
        # use daily unrealized-P&L change on a roughly-constant book as a live proxy.
        upls = [r["sleeves"].get(s, {}).get("upl", 0) for r in rows]
        rets = [upls[i] - upls[i - 1] for i in range(1, len(upls))]
        rets = [x for x in rets[-63:] if x is not None]           # ~3-month rolling
        if len(rets) < DRIFT_MIN_DAYS or st.pstdev(rets) == 0:
            continue
        live_sharpe = (st.mean(rets) / st.pstdev(rets)) * (252 ** 0.5)
        base = BACKTEST_SHARPE.get(s, 0)
        if live_sharpe < DRIFT_ALERT_SHARPE:
            alerts.append(f"📉 {s}: live rolling Sharpe {live_sharpe:+.2f} < 0 "
                          f"(backtest {base}) — DECAY, investigate")
        elif live_sharpe < 0.4 * base:
            alerts.append(f"⚠ {s}: live Sharpe {live_sharpe:+.2f} well below backtest {base}")
    return alerts


def main():
    env = _env()
    row = snapshot(env)
    append(row)
    sl = row["sleeves"]
    line = " | ".join(f"{s} mv${sl[s]['mv']:,.0f} upl${sl[s]['upl']:+,.0f} {sl[s]['fills']}f"
                      for s in ("brain", "mrev", "lowvol"))
    print(f"{row['date']}  eq ${row['equity']:,.0f}  |  {line}")
    alerts = drift_report()
    for a in alerts:
        print("  " + a)
    # only ping Discord when something is actually wrong (avoid daily noise)
    real = [a for a in alerts if a.startswith(("📉", "⚠"))]
    if real:
        discord(env, "🔬 **Sleeve drift check**\n" + "\n".join(real))


if __name__ == "__main__":
    main()
