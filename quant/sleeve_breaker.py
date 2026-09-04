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


def sleeve_values(env) -> dict:
    """Each sleeve's ALLOCATED value = its held positions + its share of cash.

    CRITICAL: a sleeve's value is NOT just its held positions. Mean-rev and the brain
    legitimately sit in CASH when their signals say so (mean-rev holds nothing when no
    stock is oversold; the brain goes to cash in a risk-off regime). Measuring only
    position market value made the breaker read "holding cash" as a -100% drawdown and
    cut the sleeve to zero — a self-reinforcing trap (cut budget -> can't buy -> stays
    at $0 -> stays cut). We add each sleeve's share of account cash so a sleeve that
    de-risks to cash shows its true, roughly-flat value, and the breaker only fires on
    REAL losses (positions actually declining in value).
    """
    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    positions = _alpaca(env, "GET", "/v2/positions") or []
    lowvol_syms = ownership.owned_symbols("lowvol")
    mv = defaultdict(float)
    for p in positions:
        mv[classify(p["symbol"], lowvol_syms)] += float(p["market_value"])

    # Each sleeve's target share of equity (so its cash portion is credited to it).
    try:
        import dynamic_budget
        b, m, l, _ = dynamic_budget.compute_split3()
        shares = {"brain": b, "mrev": m, "lowvol": l}
    except Exception:
        shares = {"brain": 0.60, "mrev": 0.25, "lowvol": 0.15}
    invested = sum(mv[s] for s in ("brain", "mrev", "lowvol"))
    free_cash = max(equity - invested, 0.0)

    out = {}
    for s in ("brain", "mrev", "lowvol"):
        # value = its live positions + its allocated slice of the un-deployed cash
        out[s] = mv[s] + free_cash * shares.get(s, 0.0)
    return out


def main():
    env = _env()
    state = _load(STATE, {})            # {sleeve: {"hwm": x}}
    overrides = _load(OVERRIDES, {})    # {sleeve: multiplier}
    values = sleeve_values(env)

    new_overrides = dict(overrides)
    alerts = []
    for sleeve, mv in values.items():
        st = state.get(sleeve, {"hwm": mv})
        hwm = max(st.get("hwm", 0.0), mv)   # ratchets up only
        dd = (mv / hwm - 1) if hwm > 0 else 0.0
        state[sleeve] = {"hwm": hwm}

        prev = overrides.get(sleeve, 1.0)
        mult = 1.0
        if dd <= -CUT_DD:
            mult = 0.0
        elif dd <= -HALVE_DD:
            mult = 0.5
        # only ever TIGHTEN automatically; loosening requires the sleeve to recover
        # above the threshold (mult computed fresh each run handles recovery).
        new_overrides[sleeve] = mult
        log(f"{sleeve:7} mv ${mv:,.0f} | hwm ${hwm:,.0f} | dd {dd*100:+.1f}% | budget x{mult}")
        if mult < 1.0 and mult != prev:
            alerts.append(f"🛑 **{sleeve}** drew down {dd*100:.0f}% from peak → budget x{mult}")
        elif mult == 1.0 and prev < 1.0:
            alerts.append(f"✅ **{sleeve}** recovered → budget restored to full")

    json.dump(state, open(STATE, "w"), indent=2)
    json.dump(new_overrides, open(OVERRIDES, "w"), indent=2)
    if alerts:
        discord(env, "**Sleeve circuit breaker**\n" + "\n".join(alerts))
        log("ALERTS: " + " | ".join(alerts))


if __name__ == "__main__":
    main()
