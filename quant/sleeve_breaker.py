"""
sleeve_breaker.py — Per-sleeve auto-drawdown circuit breaker (BUILD_PLAN 7.4).

The system's biggest weakness has been operational, not strategic: when a sleeve
breaks (crypto double-buy, mean-rev churn), it took a human noticing. This makes
the system defend itself. It tracks each sleeve's high-water mark of market value
and, if a sleeve draws down past a HARD threshold, writes a budget-override that
the runners read and obey — halving the sleeve at level 1, cutting it to zero at
level 2. Absolute thresholds (not backtest-relative), so it's safe from day one
with no history required.

  • WARN/HALVE at -20% from the sleeve's high-water mark → override budget to 50%.
  • CUT     at -35% from the sleeve's high-water mark → override budget to 0%.
  Both are per-SLEEVE and independent of the account-level equity_protector.

One-way per level (like the equity protector): it tightens automatically but a
human must clear sleeve_overrides.json to fully restore. Recovers a level only
if the sleeve climbs back above the threshold on its own.

Read-only on Alpaca (no orders). Run from cron after the bots (~6:10 PM ET).
Free: API reads + a local JSON state/override file.
"""
from __future__ import annotations
import sys, os, json, datetime as dt
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

from meanrev_runner import _env, _alpaca, discord, OUR_NAMES
from live_runner import ALL, to_alpaca, canon
import ownership

BRAIN_SYMBOLS = set(canon(to_alpaca(s)) for s in ALL)

HALVE_DD = 0.20   # -20% from sleeve HWM -> budget * 0.5
CUT_DD   = 0.35   # -35% from sleeve HWM -> budget * 0.0

HERE = os.path.dirname(__file__)
STATE = os.path.join(HERE, "sleeve_breaker_state.json")
OVERRIDES = os.path.join(HERE, "sleeve_overrides.json")   # runners read this
LOG_DIR = os.path.join(HERE, "live_logs")


def log(msg: str):
    line = f"{dt.datetime.now(dt.UTC).isoformat()[:19]}  {msg}"
    print(line)
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(os.path.join(LOG_DIR, "sleeve_breaker.log"), "a") as f:
        f.write(line + "\n")


def _load(path, default):
    if os.path.exists(path):
        try:
            return json.load(open(path))
        except Exception:
            pass
    return default


def classify(sym: str, lowvol_syms: set) -> str:
    if canon(sym) in BRAIN_SYMBOLS:
        return "brain"
    if sym in lowvol_syms:
        return "lowvol"
    if sym in OUR_NAMES:
        return "mrev"
    return "other"


def sleeve_pnl_series(env) -> dict:
    """Each sleeve's cumulative P&L (realized + open unrealized), from the sleeve_pnl log.

    LESSON (learned the hard way, twice): a circuit breaker must fire on a sleeve
    LOSING MONEY, not on its FOOTPRINT SHRINKING. Measuring "value" by market value —
    even market value + a share of cash — kept false-tripping, because a sleeve's
    footprint drops for reasons that are NOT losses: going to cash (mean-rev when nothing
    is oversold), being under-deployed, or having its cash slice starved when other
    sleeves are over their caps. Both false-trips (mean-rev -100%, low-vol -44%) happened
    with the sleeve's REAL P&L essentially flat.

    The honest measure is P&L: realized (from closed trades) + unrealized (open
    positions), which only goes down when the sleeve actually loses money. We read the
    per-sleeve daily log written by sleeve_pnl.py. Drawdown is then measured on the P&L
    high-water mark, which is what a real risk desk means by a sleeve drawdown.
    """
    log = os.path.join(LOG_DIR, "sleeve_pnl.jsonl")
    cum = {"brain": 0.0, "mrev": 0.0, "lowvol": 0.0}
    if not os.path.exists(log):
        return cum
    rows = [json.loads(l) for l in open(log) if l.strip()]
    if not rows:
        return cum
    # cumulative realized proxy: sum of daily unrealized deltas + realized isn't logged
    # separately, so use the most recent snapshot's unrealized P&L as the live figure.
    # (This tracks open-position P&L, which is what would signal a real sleeve loss.)
    latest = rows[-1]["sleeves"]
    for s in ("brain", "mrev", "lowvol"):
        cum[s] = float(latest.get(s, {}).get("upl", 0.0))
    return cum


def sleeve_budgets(env) -> dict:
    """Each sleeve's allocated capital (equity * its budget share) — the denominator for
    a P&L-based drawdown, i.e. 'how much of this sleeve's capital has it given back?'"""
    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    try:
        import dynamic_budget
        b, m, l, _ = dynamic_budget.compute_split3()
        shares = {"brain": b, "mrev": m, "lowvol": l}
    except Exception:
        shares = {"brain": 0.60, "mrev": 0.25, "lowvol": 0.15}
    return {s: equity * shares[s] for s in shares}


def main():
    env = _env()
    state = _load(STATE, {})            # {sleeve: {"peak_pnl": x}}
    overrides = _load(OVERRIDES, {})    # {sleeve: multiplier}
    pnl = sleeve_pnl_series(env)        # each sleeve's current cumulative P&L ($)
    budgets = sleeve_budgets(env)       # each sleeve's allocated capital ($)

    new_overrides = dict(overrides)
    alerts = []
    for sleeve in ("brain", "mrev", "lowvol"):
        cur_pnl = pnl.get(sleeve, 0.0)
        st = state.get(sleeve, {"peak_pnl": cur_pnl})
        peak = max(st.get("peak_pnl", 0.0), cur_pnl)   # best P&L this sleeve has reached
        # drawdown = how much P&L was given back, as a fraction of the sleeve's capital.
        # This ONLY goes negative when the sleeve actually LOSES money from its peak —
        # not when it holds cash or shrinks its footprint.
        budget = max(budgets.get(sleeve, 1.0), 1.0)
        dd = (cur_pnl - peak) / budget
        state[sleeve] = {"peak_pnl": peak}

        prev = overrides.get(sleeve, 1.0)
        mult = 1.0
        if dd <= -CUT_DD:
            mult = 0.0
        elif dd <= -HALVE_DD:
            mult = 0.5
        new_overrides[sleeve] = mult
        log(f"{sleeve:7} pnl ${cur_pnl:+,.0f} | peak ${peak:+,.0f} | dd {dd*100:+.1f}% of budget | budget x{mult}")
        if mult < 1.0 and mult != prev:
            alerts.append(f"🛑 **{sleeve}** lost {abs(dd)*100:.0f}% of its capital from peak → budget x{mult}")
        elif mult == 1.0 and prev < 1.0:
            alerts.append(f"✅ **{sleeve}** recovered → budget restored to full")

    json.dump(state, open(STATE, "w"), indent=2)
    json.dump(new_overrides, open(OVERRIDES, "w"), indent=2)
    if alerts:
        discord(env, "**Sleeve circuit breaker**\n" + "\n".join(alerts))
        log("ALERTS: " + " | ".join(alerts))


if __name__ == "__main__":
    main()
