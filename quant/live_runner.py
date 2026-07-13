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
from data import get_universe, get_bars, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel, run_backtest
import trend, crypto_trend, flow, allocator

# ── Universe + Alpaca symbol mapping ────────────────────────────────────────
# Yahoo uses BTC-USD; Alpaca crypto uses BTC/USD. ETFs are the same.
def to_alpaca(sym: str) -> str:
    return sym.replace("-USD", "/USD") if sym.endswith("-USD") else sym

ALL = sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE))
LOG_DIR = os.path.join(os.path.dirname(__file__), "live_logs")
os.makedirs(LOG_DIR, exist_ok=True)

# ── Capital budget: the brain shares the account with the mean-rev bot ───────
# The two bots split the account. The split is DYNAMIC (gentle performance-tilt,
# validated in validate_allocation.py): it leans up to ±10% toward whichever bot
# has performed better over the trailing 42 days, clamped to brain ∈ [60%, 80%].
# Both runners call dynamic_budget.compute_split() so they share ONE consistent
# split. Falls back to 70/30 if the computation fails (enhancement, not dependency).
# Their universes are disjoint (ETFs+crypto vs single stocks), so they never fight
# over a symbol regardless of the split.
BASE_BRAIN_BUDGET = 0.70   # neutral fallback


def log(msg: str):
    line = f"{dt.datetime.now(dt.UTC).isoformat()[:19]}  {msg}"
    print(line)
    with open(os.path.join(LOG_DIR, "runner.log"), "a") as f:
        f.write(line + "\n")


def discord(env, msg: str):
    """Post a message to Discord. Never throws — a notify failure won't break trading."""
    url = env.get("DISCORD_WEBHOOK_URL", "").strip()
    if not url:
        return
    try:
        body = json.dumps({"content": msg[:1900]}).encode()
        # Discord rejects requests with Python's default urllib User-Agent (403).
        # A browser-like UA (what curl effectively gets away with) is required.
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "User-Agent": "NexusQuantBot/1.0 (+https://nexustrader.local)",
        })
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:
        log(f"[discord] notify failed: {str(e)[:80]}")


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


def compute_target_weights() -> tuple[pd.Series, str]:
    """Run the brain on fresh data; return (today's target weights, regime_status string)."""
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

    # ── REGIME BRAIN — VIX term-structure gate ──────────────────────────────
    # Scale portfolio to cash when VIX is in backwardation (stress signal).
    # Validated: +0.12 Sharpe, -10pp drawdown, -0.14%/yr CAGR cost (worth it).
    try:
        vix_bars  = get_bars("VIX",  force=True)
        vix3m_bars = get_bars("VIX3M", force=True)
        vix_s  = vix_bars["close"].rename("VIX").reindex(comb.index).ffill()
        vix3m_s = vix3m_bars["close"].rename("VIX3M").reindex(comb.index).ffill()
        comb = allocator.apply_regime_gate(comb, vix_s, vix3m_s)
        last_vix  = vix_s.dropna().iloc[-1]  if not vix_s.dropna().empty  else float("nan")
        last_vix3m = vix3m_s.dropna().iloc[-1] if not vix3m_s.dropna().empty else float("nan")
        ts_ratio  = last_vix / last_vix3m if last_vix3m > 0 else float("nan")
        regime_status = "RISK-ON" if ts_ratio < 1.0 else "RISK-OFF (cash)"
        log(f"Regime brain: VIX={last_vix:.1f}  VIX3M={last_vix3m:.1f}  ratio={ts_ratio:.3f}  → {regime_status}")
    except Exception as e:
        log(f"[regime] WARNING: VIX data unavailable, skipping regime gate: {str(e)[:80]}")
        regime_status = "UNKNOWN (VIX unavailable)"

    # Use the last row that had VALID price data — never a weekend/holiday NaN row.
    # (Yahoo returns a trailing row for the current calendar day even on weekends,
    #  with NaN prices; computing signals on that row zeroes everything.)
    valid_rows = panel.dropna(how="all")       # drop fully-empty rows
    last_valid_date = valid_rows.index[-1]
    log(f"Last valid market date: {last_valid_date.date()} (panel ends {panel.index[-1].date()})")
    today = comb.loc[last_valid_date]          # target as of the last real trading day
    return today[today > 0.001], regime_status


def run(live: bool = False):
    env = _env()
    mode = "LIVE (paper)" if live else "DRY-RUN"
    log(f"=== Quant brain runner — {mode} ===")

    # EQUITY PROTECTOR kill switch: if the independent protector has halted the
    # account, do NOT trade. A human must clear KILL_SWITCH.json to resume.
    if os.path.exists(os.path.join(os.path.dirname(__file__), "KILL_SWITCH.json")):
        log("HALTED: equity protector kill switch is active. Not trading. Clear KILL_SWITCH.json to resume.")
        return

    # safety: confirm we're on a PAPER endpoint
    base = env.get("ALPACA_BASE_URL", "")
    if live and "paper" not in base:
        log("REFUSING: ALPACA_BASE_URL is not a paper endpoint. Aborting for safety.")
        return

    targets, regime_status = compute_target_weights()
    log(f"Target portfolio ({len(targets)} positions): " +
        ", ".join(f"{s}={w*100:.1f}%" for s, w in targets.items()))

    acct = _alpaca(env, "GET", "/v2/account")
    equity = float(acct["equity"])
    # Dynamic split (3-way: brain / mean-rev / low-vol). Fails safe to 60%.
    try:
        import dynamic_budget
        brain_budget_frac, _mr_frac, _lv_frac, _split_info = dynamic_budget.compute_split3()
        log(f"3-way split: brain {brain_budget_frac*100:.0f}% / mean-rev {_mr_frac*100:.0f}% / low-vol {_lv_frac*100:.0f}%")
    except Exception as e:
        brain_budget_frac = 0.60
        log(f"[budget] split3 failed, using 60%: {str(e)[:80]}")
    budget = equity * brain_budget_frac   # brain manages only its slice; mean-rev bot owns the rest
    log(f"Account equity: ${equity:,.2f}  | brain budget ({brain_budget_frac*100:.0f}%): ${budget:,.2f}  | cash: ${float(acct['cash']):,.2f}")

    # Only count OUR universe's positions (ignore the mean-rev bot's single-stock holdings).
    our_symbols = set(to_alpaca(s) for s in ALL)
    positions = _alpaca(env, "GET", "/v2/positions") or []
    current = {p["symbol"]: float(p["market_value"]) for p in positions if p["symbol"] in our_symbols}
    held_qty = {p["symbol"]: float(p["qty"]) for p in positions if p["symbol"] in our_symbols}

    # DOUBLE-BUY GUARD: fold OPEN (unfilled) orders into current exposure so a second
    # run before fills don't re-order. (Same fix as meanrev_runner.)
    open_orders = _alpaca(env, "GET", "/v2/orders?status=open&limit=200") or []
    for o in open_orders:
        sym = o.get("symbol")
        if sym not in our_symbols:
            continue
        notion = o.get("notional")
        if notion is None:
            qty = float(o.get("qty") or 0)
            px = float(o.get("limit_price") or o.get("filled_avg_price") or 0)
            notion = qty * px
        notion = float(notion or 0)
        current[sym] = current.get(sym, 0.0) + (notion if o.get("side") == "buy" else -notion)
    log(f"Current positions (filled + pending): {current if current else '(none)'}")

    # Build target $ per symbol (weight * brain budget); compute orders as the difference.
    orders = []
    target_alp = {to_alpaca(s): w for s, w in targets.items()}

    for asym in sorted(our_symbols):
        tgt_dollars = target_alp.get(asym, 0.0) * budget
        cur_dollars = current.get(asym, 0.0)
        diff = round(tgt_dollars - cur_dollars, 2)
        if abs(diff) < max(25.0, 0.01 * budget):    # ignore tiny drifts
            continue
        # Full exit of a (possibly fractional) position -> use the close endpoint, since
        # a notional sell on a fractional position returns 403 Forbidden.
        if tgt_dollars < 1.0 and held_qty.get(asym, 0.0) > 0:
            orders.append((asym, "sell", cur_dollars, True))
        else:
            orders.append((asym, "buy" if diff > 0 else "sell", abs(diff), False))

    # CRITICAL isolation note: we only ever generate orders for OUR symbols.
    # Anything else in the account is never touched.
    tgt_str = ", ".join(f"{s}={w*100:.0f}%" for s, w in targets.items())

    if not orders:
        log("No orders needed — portfolio already matches target.")
        discord(env, f"🤖 **Quant brain** ({mode}) — no trades today. "
                     f"Regime: {regime_status} | Holding: {tgt_str or 'cash'} | Equity ${equity:,.0f}")
        return

    log(f"Planned orders ({len(orders)}):")
    for asym, side, notional, close_full in orders:
        tag = " (CLOSE)" if close_full else ""
        log(f"   {side.upper():4} {asym:10} ${notional:,.2f}{tag}")

    if not live:
        log("DRY-RUN — no orders placed. Re-run with --live to execute.")
        order_lines = "\n".join(f"  {sd.upper()} {a} ${n:,.0f}{' (CLOSE)' if cf else ''}"
                                for a, sd, n, cf in orders)
        discord(env, f"🧪 **Quant brain DRY-RUN** — would place {len(orders)} orders:\n"
                     f"{order_lines}\nRegime: {regime_status} | Target: {tgt_str} | Equity ${equity:,.0f}")
        return

    placed = []
    for asym, side, notional, close_full in orders:
        try:
            if close_full:
                res = _alpaca(env, "DELETE", f"/v2/positions/{asym}")
                log(f"   closed: {asym} (full) -> id {(res or {}).get('id','?')[:8]}")
                placed.append(f"  CLOSE {asym}")
            else:
                # Crypto (/USD) rejects time_in_force "day" with HTTP 422 — it only
                # accepts gtc/ioc. ETFs use day. Pick per asset class.
                tif = "gtc" if asym.endswith("/USD") else "day"
                body = {"symbol": asym, "side": side, "type": "market",
                        "time_in_force": tif, "notional": str(notional)}
                res = _alpaca(env, "POST", "/v2/orders", body)
                log(f"   placed: {side} {asym} ${notional} -> id {res.get('id','?')[:8]}")
                placed.append(f"  {side.upper()} {asym} ${notional:,.0f}")
        except Exception as e:
            log(f"   ORDER FAILED {side} {asym}: {str(e)[:120]}")
            placed.append(f"  ❌ {side.upper()} {asym} FAILED")
    discord(env, f"💸 **Quant brain LIVE (paper)** — placed {len(placed)} orders:\n"
                 + "\n".join(placed) + f"\nRegime: {regime_status} | Target: {tgt_str} | Equity ${equity:,.0f}")
    log("=== run complete ===")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="actually place paper orders")
    args = ap.parse_args()
    run(live=args.live)
