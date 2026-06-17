"""
Position tracker — compares portfolio.json (what swing-bot thinks it holds)
against live Alpaca positions (what's actually open).
Detects closes and records them to the trade log.
"""

import json
import logging
import requests
from datetime import datetime, timezone
from config import ALPACA_API_KEY, ALPACA_SECRET_KEY, ALPACA_BASE_URL, PORTFOLIO_JSON, SIGNALS_JSON, MAX_POSITION_PCT
from config import MAX_DAILY_LOSS_PCT  # noqa: F401 — imported for downstream use

STOP_LOSS_PCT   = 0.05
TAKE_PROFIT_PCT = 0.12

logger = logging.getLogger(__name__)

_HEADERS = {
    "APCA-API-KEY-ID":     ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
}


def get_alpaca_positions() -> dict[str, dict]:
    """Returns {ticker: position_dict} for all open Alpaca positions."""
    try:
        r = requests.get(f"{ALPACA_BASE_URL}/v2/positions", headers=_HEADERS, timeout=10)
        r.raise_for_status()
        positions = r.json()
        return {p["symbol"]: p for p in positions} if isinstance(positions, list) else {}
    except Exception as e:
        logger.error("[Tracker] Failed to fetch Alpaca positions: %s", e)
        return {}


def get_alpaca_account() -> dict:
    try:
        r = requests.get(f"{ALPACA_BASE_URL}/v2/account", headers=_HEADERS, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        logger.error("[Tracker] Failed to fetch Alpaca account: %s", e)
        return {}


def get_latest_price(ticker: str) -> float | None:
    try:
        r = requests.get(
            f"https://data.alpaca.markets/v2/stocks/trades/latest?symbols={ticker}",
            headers=_HEADERS, timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        return float(data["trades"][ticker]["p"])
    except Exception:
        # Fallback: use last known price from positions
        positions = get_alpaca_positions()
        if ticker in positions:
            return float(positions[ticker].get("current_price", 0)) or None
        return None


def load_portfolio() -> dict:
    if PORTFOLIO_JSON.exists():
        try:
            return json.loads(PORTFOLIO_JSON.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"positions": []}


def load_original_thesis(ticker: str) -> dict:
    """Pull the original thesis for a ticker from signals.json for trade log enrichment."""
    if not SIGNALS_JSON.exists():
        return {}
    try:
        data = json.loads(SIGNALS_JSON.read_text())
        for t in data.get("theses", []):
            if t.get("ticker") == ticker:
                return t
    except Exception:
        pass
    return {}


def detect_closed_positions() -> list[dict]:
    """
    Compares portfolio.json entries against live Alpaca positions.
    Returns list of positions that were in portfolio.json but are no longer open in Alpaca.
    These are trades that closed (stop-loss, take-profit, or manual).
    """
    portfolio    = load_portfolio()
    tracked      = portfolio.get("positions", [])
    live         = get_alpaca_positions()

    closed = []
    for pos in tracked:
        ticker = pos.get("ticker")
        if not ticker:
            continue
        if pos.get("dry_run"):
            continue  # skip dry-run entries

        if ticker not in live:
            # Position was in our tracker but no longer in Alpaca — it closed
            current_price = get_latest_price(ticker)
            if current_price is None:
                current_price = pos.get("entry_price", 0)

            entry  = pos.get("entry_price", 0)
            stop   = pos.get("stop_loss", round(entry * (1 - STOP_LOSS_PCT), 2))
            target = pos.get("take_profit", round(entry * (1 + TAKE_PROFIT_PCT), 2))

            # Infer exit reason
            if current_price <= stop:
                exit_reason = "stop_loss"
            elif current_price >= target:
                exit_reason = "take_profit"
            else:
                exit_reason = "manual"

            thesis_data = load_original_thesis(ticker)

            closed.append({
                "ticker":       ticker,
                "entry_price":  entry,
                "exit_price":   current_price,
                "shares":       pos.get("shares", 0),
                "entry_time":   pos.get("entered_at", ""),
                "exit_time":    datetime.now(timezone.utc).isoformat(),
                "stop_loss":    stop,
                "take_profit":  target,
                "thesis_score": pos.get("thesis_score", 0),
                "exit_reason":  exit_reason,
                "thesis":       thesis_data.get("thesis", pos.get("thesis", "")),
                "verdict":      thesis_data.get("verdict", pos.get("verdict", "")),
                "sector":       thesis_data.get("sector", ""),
                "signals_used": thesis_data.get("sources_used", []),
            })
            logger.info("[Tracker] Detected closed position: %s (%s)", ticker, exit_reason)

    return closed


def get_portfolio_metrics() -> dict:
    """Returns current portfolio value, daily P&L, and total cost basis."""
    account = get_alpaca_account()
    if not account:
        return {"portfolio_value": 0, "daily_pnl": 0, "cost_basis": 0}

    portfolio_value = float(account.get("portfolio_value", 0))
    last_equity     = float(account.get("last_equity", portfolio_value))
    daily_pnl       = portfolio_value - last_equity

    positions  = get_alpaca_positions()
    cost_basis = sum(
        float(p.get("cost_basis", 0)) for p in positions.values()
    )

    return {
        "portfolio_value": portfolio_value,
        "daily_pnl":       daily_pnl,
        "cost_basis":      cost_basis,
        "cash":            float(account.get("cash", 0)),
        "open_positions":  len(positions),
    }
