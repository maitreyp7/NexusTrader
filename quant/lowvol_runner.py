"""
lowvol_runner.py — Live (paper) runner for the low-volatility bot (Bot #3).

THIRD independent bot, running alongside the brain and mean-rev on the same paper
account. Holds the 15 lowest-volatility large caps (equal weight), rebalanced monthly.
~15% of equity (fixed). A validated 50-year anomaly (Sharpe 1.05 standalone) that
improves the whole system's Sharpe + drawdown.

═══ COEXISTENCE (capital + collision safety) ═══
Budget: fixed 15% of equity (dynamic_budget.compute_split3 → lowvol slice). Sizes
against its OWN budget, never total equity.
Collision: mean-rev trades the SAME stock universe, so we CANNOT infer "my positions"
by symbol membership alone. We use the shared ownership ledger (ownership.py):
  - count as "current" ONLY symbols in low-vol's ledger section,
  - at rebalance, SKIP any candidate mean-rev currently owns (next-lowest-vol fills in),
  - after fills, write our ledger section so mean-rev knows to leave our shares alone.

Mirrors meanrev_runner.py's hard-won safety rails: --dry-run default, --live required,
kill-switch guard, non-paper endpoint refusal, open-order double-buy guard,
close-position endpoint for fractional full exits, min-order filter, own log + Discord.
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
import lowvol
import ownership

# ── Capital budget (fixed 15%; dynamic_budget provides the live value) ───────
LOWVOL_BUDGET = 0.15        # neutral fallback (15% of equity to the low-vol bot)
MAX_PER_NAME  = 0.08        # 1/15 (~6.7%) + headroom
N_NAMES       = 15

LOG_DIR = os.path.join(os.path.dirname(__file__), "live_logs")
os.makedirs(LOG_DIR, exist_ok=True)

OUR_NAMES = set(STOCK_UNIVERSE)   # candidate universe (shared with mean-rev!)


def log(msg: str):
    line = f"{dt.datetime.now(dt.UTC).isoformat()[:19]}  {msg}"
    print(line)
    with open(os.path.join(LOG_DIR, "lowvol.log"), "a") as f:
        f.write(line + "\n")


def discord(env, msg: str):
    url = env.get("DISCORD_WEBHOOK_URL", "").strip()
    if not url:
        return
    try:
        body = json.dumps({"content": msg[:1900]}).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "User-Agent": "NexusLowVolBot/1.0 (+https://nexustrader.local)",
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


def compute_targets() -> pd.Series:
    """Run low-vol on fresh data (excluding mean-rev-owned names); return today's
    target weight per name as a fraction of THIS bot's budget."""
    log("Pulling fresh daily bars for stock universe...")
    panel = build_price_panel(get_universe(STOCK_UNIVERSE, force=True)).ffill()

    # COLLISION AVOIDANCE: skip any name mean-rev currently owns (per the ledger).
    meanrev_owned = ownership.other_symbols("lowvol")   # = mean-rev's ledger symbols
    if meanrev_owned:
        log(f"Excluding {len(meanrev_owned)} mean-rev-owned names from candidates: {sorted(meanrev_owned)}")

    w = lowvol.strategy(panel, n=N_NAMES, exclude=meanrev_owned)
    valid_rows = panel.dropna(how="all")
    last_valid = valid_rows.index[-1]
    log(f"Last valid market date: {last_valid.date()}")
    today = w.loc[last_valid]
    held = today[today > 0.001].clip(upper=MAX_PER_NAME)
    return held


def run(live: bool = False):
    env = _env()
    mode = "LIVE (paper)" if live else "DRY-RUN"
    log(f"=== Low-vol bot runner — {mode} ===")

    # EQUITY PROTECTOR kill switch.
    if os.path.exists(os.path.join(os.path.dirname(__file__), "KILL_SWITCH.json")):
        log("HALTED: equity protector kill switch is active. Not trading. Clear KILL_SWITCH.json to resume.")
        return

    base = env.get("ALPACA_BASE_URL", "")
    if live and "paper" not in base:
        log("REFUSING: ALPACA_BASE_URL is not a paper endpoint. Aborting for safety.")
        return

    targets = compute_targets()
    log(f"Target ({len(targets)} names): " +
        (", ".join(f"{s}={w*100:.1f}%" for s, w in targets.items()) or "(none — all in cash)"))

    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    # Fixed 15% (3-way split). Fails safe to 15%.
    try:
        import dynamic_budget
        _b, _m, lowvol_frac, _info = dynamic_budget.compute_split3()
        log(f"3-way split: brain {_b*100:.0f}% / mean-rev {_m*100:.0f}% / low-vol {lowvol_frac*100:.0f}%")
    except Exception as e:
        lowvol_frac = LOWVOL_BUDGET
        log(f"[budget] split3 failed, using {LOWVOL_BUDGET*100:.0f}%: {str(e)[:80]}")
    budget = equity * lowvol_frac
    log(f"Account equity: ${equity:,.2f}  | low-vol budget ({lowvol_frac*100:.0f}%): ${budget:,.2f}")

    # CURRENT = only symbols in OUR ledger section (NOT symbol-membership — mean-rev
    # trades the same universe). Match ledger qty to live Alpaca positions.
    ledger_syms = ownership.owned_symbols("lowvol")
    positions = _alpaca(env, "GET", "/v2/positions") or []
    pos_by_sym = {p["symbol"]: p for p in positions}
    current, held_qty = {}, {}
    for sym in ledger_syms:
        p = pos_by_sym.get(sym)
        if p:
            current[sym] = float(p["market_value"])
            held_qty[sym] = float(p["qty"])

    # DOUBLE-BUY GUARD: fold open (unfilled) orders for OUR ledger symbols + today's
    # target symbols into current, so a second run before fills doesn't re-order.
    relevant = ledger_syms | set(targets.index)
    open_orders = _alpaca(env, "GET", "/v2/orders?status=open&limit=200") or []
    pending = {}
    for o in open_orders:
        sym = o.get("symbol")
        if sym not in relevant:
            continue
        notion = o.get("notional")
        if notion is None:
            qty = float(o.get("qty") or 0)
            px = float(o.get("limit_price") or o.get("filled_avg_price") or 0)
            notion = qty * px
        notion = float(notion or 0)
        signed = notion if o.get("side") == "buy" else -notion
        pending[sym] = pending.get(sym, 0.0) + signed
        current[sym] = current.get(sym, 0.0) + signed
    if pending:
        log(f"Pending (unfilled) orders folded in: {pending}")
    log(f"Current low-vol exposure (ledger + pending): {current if current else '(none)'}")

    # Build orders = target$ - current$. Full exit uses the close endpoint.
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
        if tgt < 1.0 and held_qty.get(sym, 0.0) > 0:
            orders.append((sym, "sell", cur, True))
        else:
            orders.append((sym, "buy" if diff > 0 else "sell", abs(diff), False))

    tgt_str = ", ".join(f"{s}={w*100:.0f}%" for s, w in targets.items()) or "cash"

    if not orders:
        log("No orders needed — already matches target.")
        discord(env, f"🐢 **Low-vol bot** ({mode}) — no trades. "
                     f"Holding: {tgt_str} | Budget ${budget:,.0f}")
        _sync_ledger(env, targets, held_qty, live)
        return

    log(f"Planned orders ({len(orders)}):")
    for sym, side, notional, close_full in orders:
        log(f"   {side.upper():4} {sym:6} ${notional:,.2f}{' (CLOSE)' if close_full else ''}")

    if not live:
        log("DRY-RUN — no orders placed. Re-run with --live to execute.")
        order_lines = "\n".join(f"  {sd.upper()} {s} ${n:,.0f}{' (CLOSE)' if cf else ''}"
                                for s, sd, n, cf in orders)
        discord(env, f"🧪 **Low-vol DRY-RUN** — would place {len(orders)} orders:\n"
                     f"{order_lines}\nTarget: {tgt_str} | Budget ${budget:,.0f}")
        return

    placed = []
    for sym, side, notional, close_full in orders:
        try:
            if close_full:
                res = _alpaca(env, "DELETE", f"/v2/positions/{sym}")
                log(f"   closed: {sym} (full) -> id {(res or {}).get('id','?')[:8]}")
                placed.append(f"  CLOSE {sym}")
            else:
                body = {"symbol": sym, "side": side, "type": "market",
                        "time_in_force": "day", "notional": str(notional)}
                res = _alpaca(env, "POST", "/v2/orders", body)
                log(f"   placed: {side} {sym} ${notional} -> id {res.get('id','?')[:8]}")
                placed.append(f"  {side.upper()} {sym} ${notional:,.0f}")
        except Exception as e:
            log(f"   ORDER FAILED {side} {sym}: {str(e)[:120]}")
            placed.append(f"  ❌ {side.upper()} {sym} FAILED")

    discord(env, f"🐢 **Low-vol bot LIVE (paper)** — placed {len(placed)} orders:\n"
                 + "\n".join(placed) + f"\nTarget: {tgt_str} | Budget ${budget:,.0f}")
    _sync_ledger(env, targets, held_qty, live)
    log("=== run complete ===")


def _sync_ledger(env, targets, held_qty, live: bool):
    """After trading, record what low-vol now owns so mean-rev leaves it alone.
    Re-reads live positions for the target names to capture actual filled qty."""
    if not live:
        return
    try:
        positions = _alpaca(env, "GET", "/v2/positions") or []
        pos_by_sym = {p["symbol"]: float(p["qty"]) for p in positions}
        holdings = {s: pos_by_sym.get(s, 0.0) for s in targets.index if pos_by_sym.get(s, 0.0) > 0}
        ownership.write_section("lowvol", holdings)
        log(f"Ledger updated: low-vol owns {sorted(holdings)}")
    except Exception as e:
        log(f"[ledger] update failed: {str(e)[:80]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="actually place paper orders")
    args = ap.parse_args()
    run(live=args.live)
