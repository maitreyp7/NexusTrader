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
import ownership

# ── Capital budget: this bot manages this fraction of total account equity ───
# The split is DYNAMIC (gentle perf-tilt, shared with the brain via dynamic_budget).
# This constant is the NEUTRAL fallback used if the dynamic computation fails.
MEANREV_BUDGET = 0.30        # neutral fallback (30% of equity to the mean-rev bot)
MAX_PER_NAME   = 0.10        # never more than 10% of equity in one name

# Validated param set (most robust in the hunt)
# QUALITY-OVER-QUANTITY params (validated 2026-08-26, gatekeeper PRODUCTION_CANDIDATE):
# deeper oversold entry + patient exit + longer hold = fewer, higher-conviction trades.
# vs the prior set this raised Sharpe 0.81->1.08, 2x-cost Sharpe 0.56->0.91 (the churn
# was eating the edge), CAGR +10.8->+12.4%, and halved max drawdown (-54->-30%).
# Turnover ~117x->63x/yr. Win rate stays ~50% — the gain is less cost drag, NOT better
# forecasting (we can't pick winners; the edge is win-size asymmetry across many trades).
PARAMS = dict(entry_rsi=5, exit_rsi=70, hold_max=20, max_names=8, max_weight=0.10)

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

    # EQUITY PROTECTOR kill switch: refuse to trade if the protector has halted us.
    if os.path.exists(os.path.join(os.path.dirname(__file__), "KILL_SWITCH.json")):
        log("HALTED: equity protector kill switch is active. Not trading. Clear KILL_SWITCH.json to resume.")
        return

    base = env.get("ALPACA_BASE_URL", "")
    if live and "paper" not in base:
        log("REFUSING: ALPACA_BASE_URL is not a paper endpoint. Aborting for safety.")
        return

    targets = compute_targets()   # weights as fraction of THIS bot's budget
    log(f"Target ({len(targets)} names): " +
        (", ".join(f"{s}={w*100:.1f}%" for s, w in targets.items()) or "(none — all in cash)"))

    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    # Dynamic split (3-way: brain / mean-rev / low-vol). Fails safe to 25%.
    try:
        import dynamic_budget
        _brain_frac, meanrev_frac, _lowvol_frac, _split_info = dynamic_budget.compute_split3()
        log(f"3-way split: mean-rev {meanrev_frac*100:.0f}% / brain {_brain_frac*100:.0f}% / low-vol {_lowvol_frac*100:.0f}%")
    except Exception as e:
        meanrev_frac = 0.25
        log(f"[budget] split3 failed, using 25%: {str(e)[:80]}")
    budget = equity * meanrev_frac
    import ownership as _own
    _mult = _own.budget_multiplier("mrev")
    if _mult < 1.0:
        budget *= _mult
        log(f"CIRCUIT BREAKER: mean-rev budget x{_mult} -> ${budget:,.2f}")
    log(f"Account equity: ${equity:,.2f}  | mean-rev budget ({meanrev_frac*100:.0f}%): ${budget:,.2f}")

    # Current positions — ONLY our universe, AND excluding shares the low-vol bot
    # owns (per the ownership ledger). Without this, mean-rev would count low-vol's
    # shares as its own and could liquidate them on exit (the June 9 collision bug
    # class). Defensive: empty ledger → old behavior, no worse than before.
    lowvol_owned = ownership.owned_symbols("meanrev")   # = low-vol's ledger symbols
    if lowvol_owned:
        log(f"Ignoring {len(lowvol_owned)} low-vol-owned names (ledger): {sorted(lowvol_owned)}")
    tradable = OUR_NAMES - lowvol_owned
    positions = _alpaca(env, "GET", "/v2/positions") or []
    current = {p["symbol"]: float(p["market_value"]) for p in positions if p["symbol"] in tradable}
    held_qty = {p["symbol"]: float(p["qty"]) for p in positions if p["symbol"] in tradable}

    # DOUBLE-BUY GUARD: also count any OPEN (unfilled) orders as already-committed
    # capital. Without this, a second run before the first fills sees "no position"
    # and buys again — exactly the bug that doubled exposure on 2026-06-22. We fold
    # pending buy/sell notional into `current` so we only trade the REMAINING gap.
    open_orders = _alpaca(env, "GET", "/v2/orders?status=open&limit=200") or []
    pending = {}
    for o in open_orders:
        sym = o.get("symbol")
        if sym not in OUR_NAMES:
            continue
        # notional may be set directly, or estimate qty*price if a qty order
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
    log(f"Current mean-rev exposure (filled + pending): {current if current else '(none)'}")

    # Target $ per name = weight * budget. Orders = difference vs current $.
    # Each order is (symbol, side, notional, close_full) — close_full=True means
    # "fully liquidate this position" (use the close-position endpoint, which is the
    # ONLY reliable way to sell a FRACTIONAL position; a notional sell returns 403).
    orders = []
    # Drop any candidate the low-vol bot owns (never trade its shares).
    target_dollars = {s: w * budget for s, w in targets.items() if s not in lowvol_owned}
    all_names = set(target_dollars) | set(current)
    for sym in sorted(all_names):
        if sym not in tradable:
            continue
        tgt = target_dollars.get(sym, 0.0)
        cur = current.get(sym, 0.0)
        diff = round(tgt - cur, 2)
        # NO-CHURN BAND. mean-rev is signal-driven (enter oversold, exit on RSI/time),
        # NOT a continuous weight-rebalancer. If a name is already held AND still wanted
        # (tgt>0 and cur>0), do NOT re-trade it just because its dollar weight drifted a
        # few % on price moves — that churn cost ~15 fills/day (8-10x the backtest rate)
        # and bled spread daily. Only true ENTRIES (cur~0) and EXITS (tgt~0) trade; a
        # held position is left alone unless it drifts absurdly (>25% of its target).
        held_and_wanted = tgt > 1.0 and cur > 1.0
        min_trade = (0.25 * tgt) if held_and_wanted else max(25.0, 0.005 * budget)
        if abs(diff) < min_trade:   # ignore drift on held names; still act on entry/exit
            continue
        # Full exit: target is ~0 but we still hold shares -> liquidate via close endpoint.
        if tgt < 1.0 and held_qty.get(sym, 0.0) > 0:
            orders.append((sym, "sell", cur, True))
        else:
            orders.append((sym, "buy" if diff > 0 else "sell", abs(diff), False))

    tgt_str = ", ".join(f"{s}={w*100:.0f}%" for s, w in targets.items()) or "cash"

    if not orders:
        log("No orders needed — already matches target.")
        discord(env, f"🔁 **Mean-rev bot** ({mode}) — no trades. "
                     f"Holding: {tgt_str} | Budget ${budget:,.0f}")
        return

    log(f"Planned orders ({len(orders)}):")
    for sym, side, notional, close_full in orders:
        tag = " (CLOSE)" if close_full else ""
        log(f"   {side.upper():4} {sym:6} ${notional:,.2f}{tag}")

    if not live:
        log("DRY-RUN — no orders placed. Re-run with --live to execute.")
        order_lines = "\n".join(f"  {sd.upper()} {s} ${n:,.0f}{' (CLOSE)' if cf else ''}"
                                for s, sd, n, cf in orders)
        discord(env, f"🧪 **Mean-rev DRY-RUN** — would place {len(orders)} orders:\n"
                     f"{order_lines}\nTarget: {tgt_str} | Budget ${budget:,.0f}")
        return

    placed = []
    for sym, side, notional, close_full in orders:
        try:
            if close_full:
                # Liquidate the entire position (handles fractional shares correctly;
                # a notional sell on a fractional position returns 403 Forbidden).
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
    discord(env, f"🔁 **Mean-rev bot LIVE (paper)** — placed {len(placed)} orders:\n"
                 + "\n".join(placed) + f"\nTarget: {tgt_str} | Budget ${budget:,.0f}")
    # Record what mean-rev now owns so the low-vol bot leaves its shares alone.
    try:
        positions2 = _alpaca(env, "GET", "/v2/positions") or []
        pos_qty = {p["symbol"]: float(p["qty"]) for p in positions2}
        holdings = {s: pos_qty.get(s, 0.0) for s in targets.index
                    if pos_qty.get(s, 0.0) > 0 and s not in lowvol_owned}
        ownership.write_section("meanrev", holdings)
        log(f"Ledger updated: mean-rev owns {sorted(holdings)}")
    except Exception as e:
        log(f"[ledger] update failed: {str(e)[:80]}")
    log("=== run complete ===")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="actually place paper orders")
    args = ap.parse_args()
    run(live=args.live)
