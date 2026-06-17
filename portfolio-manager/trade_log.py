"""
Persistent trade log — records every completed trade from entry to exit.
This is the dataset that the proprietary model will train on later.
"""

import json
import os
import logging
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from config import TRADE_LOG

logger = logging.getLogger(__name__)


def _atomic_write(path: Path, data) -> None:
    dir_ = str(path.parent)
    fd, tmp = tempfile.mkstemp(dir=dir_, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.rename(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_trade_log() -> list[dict]:
    if TRADE_LOG.exists():
        try:
            return json.loads(TRADE_LOG.read_text())
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("[TradeLog] Could not read trade_log.json: %s", e)
    return []


def record_trade(
    ticker: str,
    entry_price: float,
    exit_price: float,
    shares: float,
    entry_time: str,
    exit_time: str,
    stop_loss: float,
    take_profit: float,
    thesis_score: int,
    exit_reason: str,       # "stop_loss" | "take_profit" | "manual" | "signal_reversal"
    thesis: str = "",
    verdict: str = "",
    sector: str = "",
    signals_used: list = None,
) -> dict:
    # Guard: never record TEST/audit rows or non-equity (crypto) symbols — they
    # pollute the outcome dataset that future signal-quality analysis will rely on.
    _t = (ticker or "").upper()
    if _t.startswith("TEST") or "/" in _t or _t in {"BTCUSD", "ETHUSD"}:
        logger.info("[TradeLog] Skipping non-equity/test symbol %s — not recorded", ticker)
        return {"skipped": True, "ticker": ticker}

    # Backfill sector from the shared map if the caller left it blank
    if not sector:
        try:
            import sys as _sys
            if "/opt/nexustrader/swing-bot" not in _sys.path:
                _sys.path.insert(0, "/opt/nexustrader/swing-bot")
            from config import get_sector as _get_sector
            sector = _get_sector(ticker)
        except Exception:
            sector = "other"

    pnl        = (exit_price - entry_price) * shares
    pnl_pct    = (exit_price - entry_price) / entry_price
    outcome    = "WIN" if pnl > 0 else "LOSS"
    held_days  = None
    try:
        entry_dt = datetime.fromisoformat(entry_time)
        exit_dt  = datetime.fromisoformat(exit_time)
        held_days = (exit_dt - entry_dt).days
    except Exception:
        pass

    record = {
        "id":           f"{ticker}_{entry_time[:10]}",
        "ticker":       ticker,
        "entry_price":  entry_price,
        "exit_price":   exit_price,
        "shares":       shares,
        "entry_time":   entry_time,
        "exit_time":    exit_time,
        "held_days":    held_days,
        "stop_loss":    stop_loss,
        "take_profit":  take_profit,
        "thesis_score": thesis_score,
        "exit_reason":  exit_reason,
        "pnl":          round(pnl, 2),
        "pnl_pct":      round(pnl_pct, 4),
        "outcome":      outcome,
        "thesis":       thesis[:500] if thesis else "",
        "verdict":      verdict,
        "sector":       sector,
        "signals_used": signals_used or [],
        "recorded_at":  datetime.now(timezone.utc).isoformat(),
    }

    log = load_trade_log()
    # Avoid duplicate entries for same ticker+entry_time
    existing_ids = {t["id"] for t in log}
    if record["id"] not in existing_ids:
        log.append(record)
        os.makedirs(TRADE_LOG.parent, exist_ok=True)
        _atomic_write(TRADE_LOG, log)
        logger.info("[TradeLog] Recorded %s %s: $%.2f P&L (%s)", outcome, ticker, pnl, exit_reason)
    else:
        logger.warning("[TradeLog] Duplicate trade %s — skipping", record["id"])

    return record


def get_stats() -> dict:
    log = load_trade_log()
    if not log:
        return {"total": 0, "wins": 0, "losses": 0, "win_rate": 0, "total_pnl": 0}

    wins   = [t for t in log if t["outcome"] == "WIN"]
    losses = [t for t in log if t["outcome"] == "LOSS"]
    total_pnl = sum(t["pnl"] for t in log)

    return {
        "total":    len(log),
        "wins":     len(wins),
        "losses":   len(losses),
        "win_rate": len(wins) / len(log) if log else 0,
        "total_pnl": round(total_pnl, 2),
        "avg_win":  round(sum(t["pnl"] for t in wins) / len(wins), 2) if wins else 0,
        "avg_loss": round(sum(t["pnl"] for t in losses) / len(losses), 2) if losses else 0,
        "best_trade":  max((t["pnl"] for t in log), default=0),
        "worst_trade": min((t["pnl"] for t in log), default=0),
    }
