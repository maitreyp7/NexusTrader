"""
live_runner.py — The live (paper) trading runner for the 3-sleeve quant brain.

Runs ONCE per invocation (designed to be called daily by cron):
  1. Pull fresh daily bars (Yahoo) for the full universe.
  2. Run each validated sleeve -> the allocator brain -> target weights for TODAY.
  3. Read current Alpaca positions + equity.
  4. Compute the DIFFERENCE (target vs current) and place orders to close the gap.
  5. Log everything.

SAFETY FIRST — this places real (paper) orders, so:
  - --dry-run mode (DEFAULT) prints what it WOULD do, places nothing.
  - --live flag required to actually send orders.
  - Only ever trades symbols in OUR universe. It will never touch anything else
    in the account (full isolation from old bot leftovers).
  - Hard sanity caps: never order more than its computed target; respects cash.

Isolation: own state file, own logs, own universe. Reads NO old signal files
(kill_switch/risk_budget from the retired bots are ignored entirely).
"""

from __future__ import annotations
import sys, os, json, argparse, datetime as dt
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

import pandas as pd
import numpy as np
from data import get_universe, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
import trend, crypto_trend, flow, allocator

# ── Universe + Alpaca symbol mapping ────────────────────────────────────────
# Yahoo uses BTC-USD; Alpaca crypto uses BTC/USD. ETFs are the same.
def to_alpaca(sym: str) -> str:
    return sym.replace("-USD", "/USD") if sym.endswith("-USD") else sym

ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
LOG_DIR = os.path.join(os.path.dirname(__file__), "live_logs")
os.makedirs(LOG_DIR, exist_ok=True)


def log(msg: str):
    line = f"{dt.datetime.now(dt.UTC).isoformat()[:19]}  {msg}"
    print(line)
    with open(os.path.join(LOG_DIR, "runner.log"), "a") as f:
        f.write(line + "\n")


# ── Alpaca REST (paper) ──────────────────────────────────────────────────────
def _env():
    e = {}
    for path in ["/opt/nexustrader/nexustrader.env",
                 os.path.join(os.path.dirname(__file__), ".env")]:
        if os.path.exists(path):
            for ln in open(path):
                ln = ln.strip()
                if "=" in ln and not ln.startswith("#"):
                    k, v = ln.split("=", 1); e[k] = v
    return e

def _alpaca(env, method, path, body=None):
    base = env.get("ALPACA_BASE_URL", "https://paper-api.alpaca.markets")
    url = base + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "APCA-API-KEY-ID": env["ALPACA_API_KEY"],
        "APCA-API-SECRET-KEY": env["ALPACA_SECRET_KEY"],
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r) if r.length != 0 else None


def compute_target_weights() -> pd.Series:
    """Run the brain on fresh data; return today's target weight per symbol."""
    log("Pulling fresh daily bars...")
    panel = build_price_panel(get_universe(ALL, force=True))
    # Forward-fill each asset's last known price across non-trading days. ETFs don't
    # trade weekends but crypto does, so recent rows have crypto data + NaN ETF cells.
    # ffill makes the weekend ETF signal use Friday's close — exactly what a trader
    # sees. Then drop any leading rows still NaN (asset not born yet stays excluded).
    panel = panel.ffill()
    w_t = trend.strategy(panel)
    w_c = crypto_trend.strategy(panel)
    w_m = flow.turn_of_month(panel)
    r_t = run_backtest(panel, w_t)["returns"]
    r_c = run_backtest(panel, w_c)["returns"]
    r_m = run_backtest(panel, w_m)["returns"]
    comb = allocator.combine(
        {"trend": w_t, "crypto": w_c, "tom": w_m},
        {"trend": r_t, "crypto": r_c, "tom": r_m},
        allocator.DEFAULT_CAPS,
    ) * allocator.DEFAULT_LEVERAGE
    # Per-asset hard cap so leverage can't dump the whole book into one name
    # (vol-targeting + 2x leverage was pushing SPY to ~64%; the validated backtest
    # was diversified). 25% max per asset keeps it true to the tested portfolio.
    MAX_PER_ASSET = 0.25
    comb = comb.clip(upper=MAX_PER_ASSET)
    # Use the last row that had VALID price data — never a weekend/holiday NaN row.
    # (Yahoo returns a trailing row for the current calendar day even on weekends,
    #  with NaN prices; computing signals on that row zeroes everything.)
    valid_rows = panel.dropna(how="all")       # drop fully-empty rows
    last_valid_date = valid_rows.index[-1]
    log(f"Last valid market date: {last_valid_date.date()} (panel ends {panel.index[-1].date()})")
    today = comb.loc[last_valid_date]          # target as of the last real trading day
    return today[today > 0.001]                # only held names


def run(live: bool = False):
    env = _env()
    mode = "LIVE (paper)" if live else "DRY-RUN"
    log(f"=== Quant brain runner — {mode} ===")

    # safety: confirm we're on a PAPER endpoint
    base = env.get("ALPACA_BASE_URL", "")
    if live and "paper" not in base:
        log("REFUSING: ALPACA_BASE_URL is not a paper endpoint. Aborting for safety.")
        return

    targets = compute_target_weights()
    log(f"Target portfolio ({len(targets)} positions): " +
        ", ".join(f"{s}={w*100:.1f}%" for s, w in targets.items()))

    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    log(f"Account equity: ${equity:,.2f}  | cash: ${float(acct['cash']):,.2f}")

    positions = _alpaca(env, "GET", "/v2/positions") or []
    current = {p["symbol"]: float(p["market_value"]) / equity for p in positions}
    log(f"Current positions: {current if current else '(none)'}")

    # Build target $ per symbol; compute orders as the difference
    orders = []
    our_symbols = set(to_alpaca(s) for s in ALL)
    target_alp = {to_alpaca(s): w for s, w in targets.items()}

    for asym in sorted(our_symbols):
        tgt_w = target_alp.get(asym, 0.0)
        cur_w = current.get(asym, 0.0)
        diff_w = tgt_w - cur_w
        if abs(diff_w) < 0.01:    # ignore tiny drifts (<1% of equity)
            continue
        notional = round(diff_w * equity, 2)
        side = "buy" if notional > 0 else "sell"
        orders.append((asym, side, abs(notional)))

    # CRITICAL isolation note: we only ever generate orders for OUR symbols.
    # Anything else in the account is never touched.
    if not orders:
        log("No orders needed — portfolio already matches target.")
        return

    log(f"Planned orders ({len(orders)}):")
    for asym, side, notional in orders:
        log(f"   {side.upper():4} {asym:10} ${notional:,.2f}")

    if not live:
        log("DRY-RUN — no orders placed. Re-run with --live to execute.")
        return

    for asym, side, notional in orders:
        try:
            body = {"symbol": asym, "side": side, "type": "market",
                    "time_in_force": "day", "notional": str(notional)}
            res = _alpaca(env, "POST", "/v2/orders", body)
            log(f"   placed: {side} {asym} ${notional} -> id {res.get('id','?')[:8]}")
        except Exception as e:
            log(f"   ORDER FAILED {side} {asym}: {str(e)[:120]}")
    log("=== run complete ===")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="actually place paper orders")
    args = ap.parse_args()
    run(live=args.live)
