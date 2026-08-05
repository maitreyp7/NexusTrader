"""
test_protector_sanity.py — Prove the equity-protector false-kill fix works.

The July 7 incident: Alpaca served a corrupt equity ($44k) while the account really
held ~$98k. The protector fired and liquidated. The fix added a DATA-SANITY GATE that
must reject such reads. This test proves it — WITHOUT touching the live account:

  - It monkeypatches `_alpaca` (so no real API call) and `liquidate_all` /
    `trip_kill_switch` (so it can NEVER place an order or write a real kill switch).
  - It feeds the protector's REAL main() a series of synthetic account dicts:
      1. the exact July-7 corrupt read (equity collapsed to cash, positions missing)
      2. a normal healthy read
      3. a REAL -16% crash (equity, cash, positions all consistent) → SHOULD still kill
  - Asserts: corrupt reads are IGNORED (no liquidation); a real crash still triggers.

If (1) and (2) never liquidate and (3) does, the safety net is proven.
"""

from __future__ import annotations
import sys, os, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import equity_protector as ep

# ── capture whether a liquidation / kill was (would be) triggered ────────────
_events = {"liquidated": False, "killed": False, "kill_reason": None, "discord": []}


def _fake_liquidate(env):
    _events["liquidated"] = True
    return ["FAKE_SYMBOL"]   # pretend we closed something


def _fake_trip(reason):
    _events["killed"] = True
    _events["kill_reason"] = reason
    # do NOT write a real KILL_SWITCH.json


def _fake_discord(env, msg):
    _events["discord"].append(msg[:60])


def run_case(name, acct_dict, prior_state, expect_liquidate):
    """Run the real main() logic against a synthetic account + state, safely."""
    _events["liquidated"] = False; _events["killed"] = False; _events["discord"] = []

    # isolate state to a temp file so we don't touch the live protector_state.json
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(prior_state, tmp); tmp.close()

    orig = {
        "_alpaca": ep._alpaca, "liquidate_all": ep.liquidate_all,
        "trip_kill_switch": ep.trip_kill_switch, "discord": ep.discord,
        "STATE_FILE": ep.STATE_FILE, "KILL_SWITCH": ep.KILL_SWITCH,
    }
    try:
        ep._alpaca = lambda env, method, path, body=None: acct_dict if path == "/v2/account" else []
        ep.liquidate_all = _fake_liquidate
        ep.trip_kill_switch = _fake_trip
        ep.discord = _fake_discord
        ep.STATE_FILE = tmp.name
        ep.KILL_SWITCH = tmp.name + ".KILL"   # sandbox; never the real one
        ep._env = lambda: {"ALPACA_BASE_URL": "https://paper-api.alpaca.markets"}
        ep.main()
    finally:
        for k, v in orig.items():
            setattr(ep, k, v)
        os.unlink(tmp.name)
        if os.path.exists(ep.KILL_SWITCH if False else tmp.name + ".KILL"):
            os.unlink(tmp.name + ".KILL")

    liq = _events["liquidated"]
    ok = (liq == expect_liquidate)
    verdict = "✅ PASS" if ok else "❌ FAIL"
    print(f"  {verdict}  {name}")
    print(f"         liquidated={liq} (expected {expect_liquidate}) | killed={_events['killed']}")
    return ok


def main():
    print("=" * 72)
    print("  EQUITY PROTECTOR — false-kill fix verification (no live account touched)")
    print("=" * 72)
    HW = 98920.0
    all_ok = True

    # CASE 1 — the exact July-7 corrupt read: equity collapsed to cash, positions gone.
    # Real value ~$98k (cash 44k + long 54k) but `equity` field shows only 44k.
    # Must be IGNORED (reconciliation mismatch + impossible drop). Run TWICE to prove
    # the old "2 consecutive reads" path can't be reached through the gate.
    corrupt = {"equity": "44026.95", "cash": "44026.95", "long_market_value": "54000.0",
               "short_market_value": "0", "balance_asof": "2026-07-02"}
    st = {"high_water": HW, "consecutive_bad": 0, "warned": False, "last_good_equity": 98500.0}
    all_ok &= run_case("July-7 corrupt read (#1) → must IGNORE", corrupt, st, expect_liquidate=False)
    st2 = {"high_water": HW, "consecutive_bad": 1, "warned": False, "last_good_equity": 98500.0}
    all_ok &= run_case("July-7 corrupt read (#2, prior bad=1) → must STILL ignore", corrupt, st2, expect_liquidate=False)

    # CASE 2 — a normal healthy read: everything consistent, tiny drawdown. No action.
    healthy = {"equity": "98500.0", "cash": "20000.0", "long_market_value": "78500.0",
               "short_market_value": "0"}
    all_ok &= run_case("Healthy read → no action", healthy,
                       {"high_water": HW, "consecutive_bad": 0, "warned": False, "last_good_equity": 98500.0},
                       expect_liquidate=False)

    # CASE 3 — a REAL crash: equity down 16%, but cash+positions RECONCILE and the drop
    # is plausible vs last good. This is a genuine malfunction/crash → SHOULD kill
    # (after 2 reads). Proves the gate doesn't neuter the actual protection.
    crash_eq = HW * 0.84   # -16%
    crash = {"equity": f"{crash_eq}", "cash": "10000.0", "long_market_value": f"{crash_eq-10000}",
             "short_market_value": "0"}
    # first read: breaches kill, consecutive 1/2 → no liquidation yet
    all_ok &= run_case("Real -16% crash (read 1/2) → arm, no kill yet", crash,
                       {"high_water": HW, "consecutive_bad": 0, "warned": True, "last_good_equity": crash_eq*1.001},
                       expect_liquidate=False)
    # second consecutive read → SHOULD kill
    all_ok &= run_case("Real -16% crash (read 2/2) → SHOULD kill", crash,
                       {"high_water": HW, "consecutive_bad": 1, "warned": True, "last_good_equity": crash_eq*1.001},
                       expect_liquidate=True)

    print("=" * 72)
    print("  RESULT:", "✅ ALL PASS — false-kill fixed, real protection intact" if all_ok
          else "❌ SOMETHING FAILED — do not trust the protector yet")
    print("=" * 72)


if __name__ == "__main__":
    main()
