"""
orb_bridge.py — Merges completed ORB session trades into the shared trade_log.json.

Called by portfolio-manager after market close. Reads all session files from
/opt/nexustrader/orb-bot/logs/sessions/, extracts WIN/LOSS trades, and appends any new
ones to trade_log.json using the same schema as swing-bot trades.

Trades are de-duplicated by tradeId so running this multiple times is safe.
"""

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

ORB_SESSIONS_DIR = Path("/opt/nexustrader/orb-bot/logs/sessions")
TRADE_LOG        = Path("/opt/nexustrader/portfolio-manager/logs/trade_log.json")


def _atomic_write(path: Path, data) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.rename(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def load_trade_log() -> list[dict]:
    if TRADE_LOG.exists():
        try: return json.loads(TRADE_LOG.read_text())
        except Exception: pass
    return []


def merge_orb_trades() -> int:
    """Scans all ORB session files and merges completed trades. Returns count added."""
    if not ORB_SESSIONS_DIR.exists():
        logger.warning("[OrbBridge] ORB sessions dir not found: %s", ORB_SESSIONS_DIR)
        return 0

    trade_log = load_trade_log()
    existing_ids = {t.get("id", "") for t in trade_log}
    added = 0

    session_files = sorted(ORB_SESSIONS_DIR.glob("*.json"))
    for session_file in session_files:
        try:
            session = json.loads(session_file.read_text())
        except Exception as e:
            logger.warning("[OrbBridge] Could not read %s: %s", session_file.name, e)
            continue

        for trade in session.get("trades", []):
            outcome = trade.get("outcome")
            if outcome not in ("WIN", "LOSS", "BREAK_EVEN"):
                continue  # skip OPEN/STALE

            trade_id = f"ORB_{trade.get('tradeId', trade.get('symbol', '?') + '_' + session.get('date', ''))}"
            if trade_id in existing_ids:
                continue

            entry_price = trade.get("entryPrice", 0)
            exit_price  = trade.get("exitPrice",  0)
            shares      = trade.get("coinsTraded", 0)
            pattern     = trade.get("pattern", "")
            is_short    = "SHORT" in (pattern or "")

            # Correct P&L sign for shorts
            if is_short:
                pnl     = (entry_price - exit_price) * shares
                pnl_pct = (entry_price - exit_price) / entry_price if entry_price else 0
            else:
                pnl     = (exit_price - entry_price) * shares
                pnl_pct = (exit_price - entry_price) / entry_price if entry_price else 0

            real_outcome = "WIN" if pnl > 0.01 else "LOSS" if pnl < -0.01 else "BREAK_EVEN"

            record = {
                "id":           trade_id,
                "ticker":       trade.get("symbol", ""),
                "bot_type":     "orb",
                "entry_price":  entry_price,
                "exit_price":   exit_price,
                "shares":       shares,
                "entry_time":   trade.get("enteredAt", ""),
                "exit_time":    trade.get("exitedAt", ""),
                "held_days":    0,
                "stop_loss":    None,
                "take_profit":  None,
                "thesis_score": round(trade.get("decision", {}).get("finalScore", 0), 3),
                "exit_reason":  trade.get("exitReason", ""),
                "pnl":          round(pnl, 2),
                "pnl_pct":      round(pnl_pct, 4),
                "outcome":      real_outcome,
                "pattern":      pattern,
                "thesis":       trade.get("decision", {}).get("reason", ""),
                "verdict":      pattern,
                "sector":       "",
                "signals_used": list(trade.get("decision", {}).get("scores", {}).keys()),
                "recorded_at":  datetime.now(timezone.utc).isoformat(),
            }

            trade_log.append(record)
            existing_ids.add(trade_id)
            added += 1
            logger.info("[OrbBridge] Added %s %s: $%.2f (%s)", real_outcome, trade.get("symbol"), pnl, trade.get("exitReason", ""))

    if added > 0:
        os.makedirs(TRADE_LOG.parent, exist_ok=True)
        _atomic_write(TRADE_LOG, trade_log)
        logger.info("[OrbBridge] Merged %d new ORB trades into trade_log.json", added)
    else:
        logger.info("[OrbBridge] No new ORB trades to merge")

    return added


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    n = merge_orb_trades()
    print(f"[OrbBridge] Done — {n} trades merged.")
