"""
Kill switch — writes kill_switch.json to signals/ when risk limits are breached.
swing-bot reads this file before entering any new positions.
"""

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from config import KILL_FILE, MAX_DAILY_LOSS_PCT, MAX_TOTAL_LOSS_PCT

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


def is_kill_active() -> bool:
    if not KILL_FILE.exists():
        return False
    try:
        data = json.loads(KILL_FILE.read_text())
        # Kill switch resets daily — only active if set today
        today = datetime.now(timezone.utc).date().isoformat()
        return data.get("active", False) and data.get("date") == today
    except Exception:
        return False


def activate_kill_switch(reason: str) -> None:
    today = datetime.now(timezone.utc).date().isoformat()
    payload = {
        "active":       True,
        "reason":       reason,
        "date":         today,
        "activated_at": datetime.now(timezone.utc).isoformat(),
    }
    os.makedirs(KILL_FILE.parent, exist_ok=True)
    _atomic_write(KILL_FILE, payload)
    logger.error("[KillSwitch] ACTIVATED: %s", reason)
    print(f"[KillSwitch] ACTIVATED — {reason}")


def deactivate_kill_switch() -> None:
    if KILL_FILE.exists():
        payload = json.loads(KILL_FILE.read_text())
        payload["active"] = False
        _atomic_write(KILL_FILE, payload)
    logger.info("[KillSwitch] Deactivated")
    print("[KillSwitch] Deactivated")


def check_risk_limits(daily_pnl: float, portfolio_value: float, total_cost_basis: float) -> bool:
    """
    Returns True if a kill switch was triggered.
    Checks daily loss and total drawdown limits.
    """
    if portfolio_value <= 0:
        return False

    daily_pct = daily_pnl / portfolio_value

    if daily_pct <= -MAX_DAILY_LOSS_PCT:
        activate_kill_switch(
            f"Daily loss {daily_pct*100:.2f}% exceeds limit {MAX_DAILY_LOSS_PCT*100:.0f}%"
        )
        return True

    if total_cost_basis > 0:
        total_drawdown = daily_pnl / total_cost_basis
        if total_drawdown <= -MAX_TOTAL_LOSS_PCT:
            activate_kill_switch(
                f"Total drawdown {total_drawdown*100:.2f}% exceeds emergency limit {MAX_TOTAL_LOSS_PCT*100:.0f}%"
            )
            return True

    return False
