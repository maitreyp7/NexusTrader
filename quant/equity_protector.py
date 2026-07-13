"""
equity_protector.py — Independent emergency brake for the whole account.

This is a WATCHDOG, not a strategy. It shares NO logic with the trading bots — its
only job is to watch ONE number (total account equity) and pull the plug if the
account bleeds past a hard line. Because it has no strategy, no positions, and no
shared state with the bots, a bug in a bot CANNOT corrupt it. That independence is
the whole point: it protects you from your own code malfunctioning.

Two levels (set once; works for paper AND real money since they're % based):
  • WARN  at -8%  from the high-water mark → Discord heads-up, no action.
  • KILL  at -15% from the high-water mark → LIQUIDATE everything + halt the bots.

The strategy's NORMAL worst drawdown is ~14%, so -15% only fires on ABNORMAL losses
(i.e. a likely bug), not on normal rough patches. It cries wolf rarely.

Safety features:
  • Requires TWO consecutive bad readings before killing (guards against a single
    bad data point / transient Alpaca glitch liquidating the account by mistake).
  • Tracks a persistent high-water mark in protector_state.json.
  • On KILL: closes all positions, writes KILL_SWITCH.json (the bots refuse to trade
    while it exists), and screams on Discord. It is a ONE-WAY brake — it never
    re-enables itself. A human must delete KILL_SWITCH.json to resume.

Designed to run every ~20 min during market hours via its own cron.
"""

from __future__ import annotations
import sys, os, json, datetime as dt
sys.path.insert(0, os.path.dirname(__file__))

# Reuse ONLY the low-level account/order helpers (not any strategy logic).
from meanrev_runner import _env, _alpaca, discord

# ── Thresholds (percent from high-water mark; same for paper + real money) ───
WARN_DD = 0.08    # -8%  → warn only
KILL_DD = 0.15    # -15% → liquidate + halt
CONSECUTIVE_BAD_NEEDED = 2   # require 2 bad reads in a row before killing

# Data-sanity gate. A daily-bar portfolio physically cannot move this much between
# two ~20-min reads; a jump larger than this is an Alpaca data glitch (e.g. positions
# briefly dropping out of the equity field), NOT a real loss. We refuse to act on it.
# This is what a -55% false read on 2026-07-07 exposed: the "2 consecutive reads"
# guard failed because the glitch lasted 40 min, spanning both reads.
MAX_PLAUSIBLE_INTERVAL_DROP = 0.20   # >20% drop vs last good read = impossible → ignore
# Equity must roughly reconcile with cash + net position value. If Alpaca's `equity`
# collapses toward cash-only (positions missing) while cash is unchanged, the two
# disagree and we treat the reading as corrupt.
RECONCILE_TOLERANCE = 0.10           # allow 10% slop before calling it inconsistent

HERE        = os.path.dirname(__file__)
STATE_FILE  = os.path.join(HERE, "protector_state.json")
KILL_SWITCH = os.path.join(HERE, "KILL_SWITCH.json")
LOG_DIR     = os.path.join(HERE, "live_logs")


def log(msg: str):
    line = f"{dt.datetime.now(dt.UTC).isoformat()[:19]}  {msg}"
    print(line)
    with open(os.path.join(LOG_DIR, "protector.log"), "a") as f:
        f.write(line + "\n")


def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            return json.load(open(STATE_FILE))
        except Exception:
            pass
    return {"high_water": 0.0, "consecutive_bad": 0, "warned": False, "last_good_equity": 0.0}


def save_state(s: dict):
    json.dump(s, open(STATE_FILE, "w"), indent=2)


def liquidate_all(env) -> list[str]:
    """Close EVERY position in the account (close-position endpoint handles
    fractional shares). Returns a list of what was closed."""
    positions = _alpaca(env, "GET", "/v2/positions") or []
    closed = []
    # cancel any open orders first so they don't re-fill after we liquidate
    try:
        _alpaca(env, "DELETE", "/v2/orders")
    except Exception as e:
        log(f"  (could not cancel open orders: {str(e)[:60]})")
    for p in positions:
        sym = p["symbol"]
        try:
            _alpaca(env, "DELETE", f"/v2/positions/{sym}")
            closed.append(sym)
            log(f"  liquidated {sym}")
        except Exception as e:
            log(f"  FAILED to liquidate {sym}: {str(e)[:80]}")
    return closed


def trip_kill_switch(reason: str):
    json.dump({"tripped_at": dt.datetime.now(dt.UTC).isoformat(), "reason": reason},
              open(KILL_SWITCH, "w"), indent=2)


def main():
    env = _env()

    # If already killed, do nothing but remind (a human must clear it).
    if os.path.exists(KILL_SWITCH):
        log("KILL_SWITCH already active — bots are halted. Awaiting manual clear.")
        return

    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])

    state = load_state()

    # ── DATA-SANITY GATE (runs BEFORE any drawdown/kill logic) ──────────────
    # Reject readings that are physically impossible or internally inconsistent.
    # A false -55% read (positions briefly missing from `equity`) tripped the kill
    # on 2026-07-07 and liquidated the book. Never act on a corrupt number.
    cash = float(acct.get("cash", 0) or 0)
    long_mv = float(acct.get("long_market_value", 0) or 0)
    short_mv = float(acct.get("short_market_value", 0) or 0)
    reconciled = cash + long_mv + short_mv   # what equity SHOULD be
    last_good = state.get("last_good_equity", 0.0)

    bad_reasons = []
    # (a) equity disagrees with cash + positions → positions dropped out of the field
    if reconciled > 0 and abs(equity - reconciled) / reconciled > RECONCILE_TOLERANCE:
        bad_reasons.append(f"equity ${equity:,.0f} != cash+positions ${reconciled:,.0f}")
    # (b) impossibly large drop vs the last good read (not a market move, a glitch)
    if last_good > 0 and (equity / last_good - 1) < -MAX_PLAUSIBLE_INTERVAL_DROP:
        bad_reasons.append(f"dropped {(equity/last_good-1)*100:.0f}% vs last good ${last_good:,.0f}")

    if bad_reasons:
        log(f"⚠ IGNORING corrupt equity read ${equity:,.2f}: {'; '.join(bad_reasons)}. "
            f"No action taken (this is the false-kill guard).")
        # Do NOT update high_water/last_good from a bad read; do NOT touch consecutive_bad.
        save_state(state)
        return

    # Reading passed the sanity gate — it's trustworthy.
    state["last_good_equity"] = equity

    hw = max(state.get("high_water", 0.0), equity)   # high-water mark only ratchets up
    dd = (equity / hw - 1) if hw > 0 else 0.0         # current drawdown from peak (<= 0)

    log(f"Equity ${equity:,.2f} | peak ${hw:,.2f} | drawdown {dd*100:+.2f}% "
        f"(warn -{WARN_DD*100:.0f}% / kill -{KILL_DD*100:.0f}%)")

    # ── KILL check (with two-consecutive-reads safety) ──────────────────────
    if dd <= -KILL_DD:
        state["consecutive_bad"] = state.get("consecutive_bad", 0) + 1
        log(f"⚠ Drawdown breached KILL line. Consecutive bad reads: "
            f"{state['consecutive_bad']}/{CONSECUTIVE_BAD_NEEDED}")
        if state["consecutive_bad"] >= CONSECUTIVE_BAD_NEEDED:
            log("🚨 KILL TRIGGERED — liquidating everything and halting bots.")
            closed = liquidate_all(env)
            trip_kill_switch(f"drawdown {dd*100:.1f}% from peak ${hw:,.0f}")
            discord(env,
                f"🚨🚨 **EQUITY PROTECTOR — KILL TRIGGERED** 🚨🚨\n"
                f"Account fell **{dd*100:.1f}%** from peak (${hw:,.0f} → ${equity:,.0f}).\n"
                f"This is worse than the strategy should ever do — likely a malfunction.\n"
                f"**Liquidated {len(closed)} positions. All bots HALTED.**\n"
                f"Bots will NOT trade until you investigate and clear the kill switch.")
            state["high_water"] = hw
            save_state(state)
            return
    else:
        state["consecutive_bad"] = 0   # reset if we recovered above the kill line

    # ── WARN check (once per breach, resets when recovered) ─────────────────
    if dd <= -WARN_DD and not state.get("warned", False):
        state["warned"] = True
        discord(env,
            f"⚠️ **Equity protector — WARNING**\n"
            f"Account is down **{dd*100:.1f}%** from its peak (${hw:,.0f} → ${equity:,.0f}).\n"
            f"Still within normal range, just a heads-up. Auto-kill triggers at -{KILL_DD*100:.0f}%.")
        log("Sent WARN-level Discord alert.")
    elif dd > -WARN_DD and state.get("warned", False):
        state["warned"] = False   # recovered above warn line; re-arm the warning

    state["high_water"] = hw
    save_state(state)


if __name__ == "__main__":
    main()
