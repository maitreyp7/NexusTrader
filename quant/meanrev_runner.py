"""
meanrev_runner.py — Live (paper) runner for the single-name mean-reversion bot.

This is a SECOND, independent bot that runs ALONGSIDE the quant brain on the same
paper account. It trades a different universe (individual large-cap stocks) with a
different edge (short-term oversold-bounce reversion, hold 2-10 days).

Validated standalone: Sharpe 1.06, CAGR +12.4%/yr, survives 2x costs, positive in
11/12 eras, stronger in recent data. Params: RSI(2) entry<5, exit>60, 10-day stop.

═══ HOW THE TWO BOTS COEXIST ON ONE ACCOUNT (capital isolation) ═══
Both bots size positions as a fraction of capital. If each used TOTAL equity they'd
collectively over-allocate. So each bot owns a FIXED SLICE:
  - brain   → 70% of equity (CAPITAL_BUDGET in its runner; implicitly the rest)
  - meanrev → 30% of equity (MEANREV_BUDGET below)
This bot sizes against its OWN budget (equity * MEANREV_BUDGET) and ONLY ever trades
its own stock universe. It never reads or touches the brain's ETF/crypto positions.
The two universes don't overlap (brain = ETFs+crypto; this = single stocks), so even
the position lists are disjoint — by construction they cannot fight over a symbol.

SAFETY: --dry-run by default (prints, places nothing). --live required to send orders.
Refuses any non-paper endpoint. Own state file, own logs, own Discord line.
"""

from __future__ import annotations
import sys, os, json, argparse, datetime as dt
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "strategies"))

import pandas as pd
import numpy as np
from data import get_universe
from engine import build_price_panel
from stock_universe import STOCK_UNIVERSE
import name_meanrev

# ── Capital budget: this bot manages this fraction of total account equity ───
MEANREV_BUDGET = 0.30        # 30% of equity to the mean-rev bot
MAX_PER_NAME   = 0.10        # never more than 10% of equity in one name

# Validated param set (most robust in the hunt)
PARAMS = dict(entry_rsi=5, exit_rsi=60, hold_max=10, max_names=10, max_weight=0.10)

LOG_DIR = os.path.join(os.path.dirname(__file__), "live_logs")
os.makedirs(LOG_DIR, exist_ok=True)


def log(msg: str):
    line = f"{dt.datetime.now(dt.UTC).isoformat()[:19]}  {msg}"
    print(line)
    with open(os.path.join(LOG_DIR, "meanrev.log"), "a") as f:
        f.write(line + "\n")


def discord(env, msg: str):
    url = env.get("DISCORD_WEBHOOK_URL", "").strip()
    if not url:
        return
    try:
        body = json.dumps({"content": msg[:1900]}).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "User-Agent": "NexusMeanRevBot/1.0 (+https://nexustrader.local)",
        })
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        log(f"[discord] notify failed: {str(e)[:80]}")


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


# The set of symbols THIS bot is allowed to touch (its universe). Disjoint from the
# brain's ETF/crypto universe — guarantees the two bots never trade the same name.
OUR_NAMES = set(STOCK_UNIVERSE)


def compute_targets() -> pd.Series:
    """Run the mean-rev strategy on fresh data; return today's target weight per name,
    expressed as a fraction of THIS BOT'S BUDGET (not total equity)."""
    log("Pulling fresh daily bars for stock universe...")
    panel = build_price_panel(get_universe(STOCK_UNIVERSE, force=True)).ffill()
    w = name_meanrev.strategy(panel, **PARAMS)

    valid_rows = panel.dropna(how="all")
    last_valid = valid_rows.index[-1]
    log(f"Last valid market date: {last_valid.date()}")
    today = w.loc[last_valid]
    held = today[today > 0.001]
    # cap per name (already capped in strategy, belt-and-suspenders)
    held = held.clip(upper=MAX_PER_NAME)
    return held


def run(live: bool = False):
    env = _env()
    mode = "LIVE (paper)" if live else "DRY-RUN"
    log(f"=== Mean-rev bot runner — {mode} ===")

    base = env.get("ALPACA_BASE_URL", "")
    if live and "paper" not in base:
        log("REFUSING: ALPACA_BASE_URL is not a paper endpoint. Aborting for safety.")
        return

    targets = compute_targets()   # weights as fraction of THIS bot's budget
    log(f"Target ({len(targets)} names): " +
        (", ".join(f"{s}={w*100:.1f}%" for s, w in targets.items()) or "(none — all in cash)"))

    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    budget = equity * MEANREV_BUDGET
    log(f"Account equity: ${equity:,.2f}  | mean-rev budget ({MEANREV_BUDGET*100:.0f}%): ${budget:,.2f}")

    # Current positions — but ONLY the ones in OUR universe (ignore the brain's).
    positions = _alpaca(env, "GET", "/v2/positions") or []
    current = {p["symbol"]: float(p["market_value"]) for p in positions if p["symbol"] in OUR_NAMES}
    log(f"Current mean-rev positions: {current if current else '(none)'}")

    # Target $ per name = weight * budget. Orders = difference vs current $.
    orders = []
    target_dollars = {s: w * budget for s, w in targets.items()}
    all_names = set(target_dollars) | set(current)
    for sym in sorted(all_names):
        if sym not in OUR_NAMES:
            continue
        tgt = target_dollars.get(sym, 0.0)
        cur = current.get(sym, 0.0)
        diff = round(tgt - cur, 2)
        if abs(diff) < max(25.0, 0.005 * budget):   # ignore tiny drifts
            continue
        side = "buy" if diff > 0 else "sell"
        orders.append((sym, side, abs(diff)))

    tgt_str = ", ".join(f"{s}={w*100:.0f}%" for s, w in targets.items()) or "cash"

    if not orders:
        log("No orders needed — already matches target.")
        discord(env, f"🔁 **Mean-rev bot** ({mode}) — no trades. "
                     f"Holding: {tgt_str} | Budget ${budget:,.0f}")
        return

    log(f"Planned orders ({len(orders)}):")
    for sym, side, notional in orders:
        log(f"   {side.upper():4} {sym:6} ${notional:,.2f}")

    if not live:
        log("DRY-RUN — no orders placed. Re-run with --live to execute.")
        order_lines = "\n".join(f"  {sd.upper()} {s} ${n:,.0f}" for s, sd, n in orders)
        discord(env, f"🧪 **Mean-rev DRY-RUN** — would place {len(orders)} orders:\n"
                     f"{order_lines}\nTarget: {tgt_str} | Budget ${budget:,.0f}")
        return

    placed = []
    for sym, side, notional in orders:
        try:
            body = {"symbol": sym, "side": side, "type": "market",
                    "time_in_force": "day", "notional": str(notional)}
            res = _alpaca(env, "POST", "/v2/orders", body)
            log(f"   placed: {side} {sym} ${notional} -> id {res.get('id','?')[:8]}")
            placed.append(f"  {side.upper()} {sym} ${notional:,.0f}")
        except Exception as e:
            log(f"   ORDER FAILED {side} {sym}: {str(e)[:120]}")
            placed.append(f"  ❌ {side.upper()} {sym} FAILED")
    discord(env, f"🔁 **Mean-rev bot LIVE (paper)** — placed {len(placed)} orders:\n"
                 + "\n".join(placed) + f"\nTarget: {tgt_str} | Budget ${budget:,.0f}")
    log("=== run complete ===")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="actually place paper orders")
    args = ap.parse_args()
    run(live=args.live)
