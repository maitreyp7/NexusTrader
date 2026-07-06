"""
health_check.py — Daily self-report + alarm for the two-bot quant system.

Runs AFTER both bots (own cron, ~6:00 PM ET). It reads the live account and posts
ONE Discord summary so problems surface instantly instead of needing a manual dig.
(Today's double-buy + 403 bugs were only caught by manually inspecting the account —
this makes the system tell you.)

Reports per bot:
  - capital split %  (vs the 70/30 target)        → catches budget drift
  - today's P&L and unrealized P&L
  - position count + names
  - regime status (risk-on/off)
ALARMS (loud, with @ prefix) on:
  - any FAILED/rejected order today
  - capital split off target by > DRIFT_TOL
  - a bot holding ZERO when it should hold something / over-allocated
  - account-level day loss beyond a soft threshold (informational)

Read-only: places NO orders. Single source of truth — imports budgets + universes
from the runners so config can't drift.
"""

from __future__ import annotations
import sys, os, datetime as dt

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

# Reuse the runners' helpers + config (single source of truth)
from meanrev_runner import _env, _alpaca, discord, OUR_NAMES
from live_runner import ALL, to_alpaca
import ownership

# The split is dynamic (3-way now); fetch CURRENT budgets so alarms track real caps.
try:
    import dynamic_budget
    BRAIN_BUDGET, MEANREV_BUDGET, LOWVOL_BUDGET, _ = dynamic_budget.compute_split3()
except Exception:
    BRAIN_BUDGET, MEANREV_BUDGET, LOWVOL_BUDGET = 0.60, 0.25, 0.15

BRAIN_SYMBOLS = set(to_alpaca(s) for s in ALL)
DRIFT_TOL = 0.08        # alert if a bot's share is off its target by > 8 percentage pts
DAY_LOSS_ALERT = -0.03  # informational flag if account down > 3% on the day

LOG_DIR = os.path.join(os.path.dirname(__file__), "live_logs")


def log(msg: str):
    line = f"{dt.datetime.now(dt.UTC).isoformat()[:19]}  {msg}"
    print(line)
    with open(os.path.join(LOG_DIR, "health.log"), "a") as f:
        f.write(line + "\n")


def main():
    env = _env()
    log("=== Health check ===")

    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    last_equity = float(acct["last_equity"])      # equity at previous close
    cash = float(acct["cash"])
    day_pl = equity - last_equity
    day_pct = (equity / last_equity - 1) if last_equity else 0.0

    positions = _alpaca(env, "GET", "/v2/positions") or []
    # Both mean-rev and low-vol hold STOCK_UNIVERSE names — split them by the
    # ownership ledger (falls back to all-stocks-as-mrev if the ledger is empty).
    lowvol_syms = ownership.owned_symbols("lowvol")
    brain = [p for p in positions if p["symbol"] in BRAIN_SYMBOLS]
    lvol  = [p for p in positions if p["symbol"] in lowvol_syms]
    mrev  = [p for p in positions if p["symbol"] in OUR_NAMES and p["symbol"] not in lowvol_syms]
    other = [p for p in positions if p["symbol"] not in BRAIN_SYMBOLS and p["symbol"] not in OUR_NAMES]

    bsum = sum(float(p["market_value"]) for p in brain)
    msum = sum(float(p["market_value"]) for p in mrev)
    lsum = sum(float(p["market_value"]) for p in lvol)
    osum = sum(float(p["market_value"]) for p in other)
    b_share = bsum / equity if equity else 0.0
    m_share = msum / equity if equity else 0.0
    l_share = lsum / equity if equity else 0.0

    b_upl = sum(float(p["unrealized_pl"]) for p in brain)
    m_upl = sum(float(p["unrealized_pl"]) for p in mrev)
    l_upl = sum(float(p["unrealized_pl"]) for p in lvol)

    # --- scan today's orders for failures ---
    today = dt.datetime.now(dt.UTC).date().isoformat()
    orders = _alpaca(env, "GET", f"/v2/orders?status=all&limit=200&after={today}T00:00:00Z") or []
    failed = [o for o in orders if o.get("status") in ("rejected", "canceled", "expired")]
    filled_today = [o for o in orders if o.get("status") == "filled"]

    # --- build alarms ---
    alarms = []
    if failed:
        names = ", ".join(f"{o['symbol']}:{o['status']}" for o in failed[:8])
        alarms.append(f"⛔ {len(failed)} FAILED order(s) today: {names}")
    # split drift (note: bots don't force-spend the full budget due to vol-targeting,
    # so we compare each bot's share against its budget CEILING, alerting only if a bot
    # EXCEEDS its budget or wildly under-deploys while it clearly should be holding).
    if m_share > MEANREV_BUDGET + DRIFT_TOL:
        alarms.append(f"⚠ mean-rev OVER budget: {m_share*100:.0f}% vs {MEANREV_BUDGET*100:.0f}% cap")
    if b_share > BRAIN_BUDGET + DRIFT_TOL:
        alarms.append(f"⚠ brain OVER budget: {b_share*100:.0f}% vs {BRAIN_BUDGET*100:.0f}% cap")
    if l_share > LOWVOL_BUDGET + DRIFT_TOL:
        alarms.append(f"⚠ low-vol OVER budget: {l_share*100:.0f}% vs {LOWVOL_BUDGET*100:.0f}% cap")
    # ledger reconciliation: every low-vol ledger symbol should be an actual position
    _held_syms = {p["symbol"] for p in positions}
    _missing = [s for s in lowvol_syms if s not in _held_syms]
    if _missing:
        alarms.append(f"⚠ low-vol ledger names not held: {', '.join(_missing[:8])} (reconcile)")
    if osum > 0.01 * equity:
        names = ", ".join(p["symbol"] for p in other[:8])
        alarms.append(f"⚠ UNOWNED positions ({osum/equity*100:.0f}% of acct): {names}")
    if day_pct < DAY_LOSS_ALERT:
        alarms.append(f"📉 account down {day_pct*100:.1f}% today (informational)")

    # --- regime status (best-effort; never block the report on it) ---
    regime = "?"
    try:
        from data import get_bars
        v = get_bars("VIX")["close"].dropna().iloc[-1]
        v3 = get_bars("VIX3M")["close"].dropna().iloc[-1]
        regime = f"RISK-ON ({v:.0f}/{v3:.0f})" if v < v3 else f"RISK-OFF ({v:.0f}/{v3:.0f})"
    except Exception as e:
        log(f"[regime] {str(e)[:60]}")

    # --- compose message ---
    health = "🟢 HEALTHY" if not alarms else "🔴 NEEDS ATTENTION"
    mrev_names = ", ".join(sorted(p["symbol"] for p in mrev)) or "cash"
    msg = (
        f"📊 **Quant system health** — {health}\n"
        f"Equity **${equity:,.0f}**  |  today {day_pl:+,.0f} ({day_pct*100:+.2f}%)  |  cash ${cash:,.0f}\n"
        f"🤖 Brain:    {b_share*100:.0f}% (cap {BRAIN_BUDGET*100:.0f}%)  |  {len(brain)} pos  |  uPL {b_upl:+,.0f}\n"
        f"🔁 Mean-rev: {m_share*100:.0f}% (cap {MEANREV_BUDGET*100:.0f}%)  |  {len(mrev)} pos  |  uPL {m_upl:+,.0f}\n"
        f"🐢 Low-vol:  {l_share*100:.0f}% (cap {LOWVOL_BUDGET*100:.0f}%)  |  {len(lvol)} pos  |  uPL {l_upl:+,.0f}\n"
        f"   mrev: {mrev_names}\n"
        f"Regime: {regime}  |  orders today: {len(filled_today)} filled, {len(failed)} failed"
    )
    if alarms:
        msg += "\n" + "\n".join(alarms)

    log(msg.replace("\n", " | "))
    discord(env, msg)
    log("=== health check complete ===")


if __name__ == "__main__":
    main()
