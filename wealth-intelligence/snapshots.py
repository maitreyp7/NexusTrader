"""
Daily portfolio snapshots — records portfolio value each day.
Used to compute running P&L, drawdown, and benchmark comparison.
"""

import json
import os
import logging
import tempfile
import requests
from datetime import datetime, timezone, date
from pathlib import Path
from config import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY, ALPACA_BASE_URL,
    SNAPSHOT_FILE, BENCHMARK,
)

logger = logging.getLogger(__name__)

_HEADERS = {
    "APCA-API-KEY-ID":     ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
}


def _atomic_write(path: Path, data) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
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


def load_snapshots() -> list[dict]:
    if SNAPSHOT_FILE.exists():
        try:
            return json.loads(SNAPSHOT_FILE.read_text())
        except Exception:
            pass
    return []


def get_portfolio_value() -> float:
    try:
        r = requests.get(f"{ALPACA_BASE_URL}/v2/account", headers=_HEADERS, timeout=10)
        r.raise_for_status()
        return float(r.json().get("portfolio_value", 0))
    except Exception as e:
        logger.error("[Snapshots] Failed to fetch portfolio value: %s", e)
        return 0.0


def get_benchmark_price() -> float:
    """Get latest SPY price as benchmark."""
    try:
        r = requests.get(
            f"https://data.alpaca.markets/v2/stocks/trades/latest?symbols={BENCHMARK}",
            headers=_HEADERS, timeout=10,
        )
        r.raise_for_status()
        return float(r.json()["trades"][BENCHMARK]["p"])
    except Exception as e:
        logger.error("[Snapshots] Failed to fetch benchmark price: %s", e)
        return 0.0


def take_snapshot() -> dict:
    """Record today's portfolio value and benchmark price."""
    today          = date.today().isoformat()
    portfolio_val  = get_portfolio_value()
    benchmark_price = get_benchmark_price()

    snapshots = load_snapshots()

    # Don't duplicate today's snapshot
    existing_dates = {s["date"] for s in snapshots}
    if today in existing_dates:
        logger.info("[Snapshots] Snapshot for %s already exists — updating", today)
        snapshots = [s for s in snapshots if s["date"] != today]

    snapshot = {
        "date":            today,
        "portfolio_value": portfolio_val,
        "benchmark_price": benchmark_price,
        "recorded_at":     datetime.now(timezone.utc).isoformat(),
    }
    snapshots.append(snapshot)
    snapshots.sort(key=lambda x: x["date"])

    os.makedirs(SNAPSHOT_FILE.parent, exist_ok=True)
    _atomic_write(SNAPSHOT_FILE, snapshots)
    logger.info("[Snapshots] Recorded: portfolio=$%.2f, %s=$%.2f", portfolio_val, BENCHMARK, benchmark_price)
    return snapshot


def compute_performance(days: int = 30) -> dict:
    """
    Computes portfolio performance vs benchmark over the last N days.
    Returns P&L, return %, benchmark return %, and alpha.
    """
    snapshots = load_snapshots()
    if len(snapshots) < 2:
        return {"error": "Not enough data yet — need at least 2 daily snapshots"}

    recent = snapshots[-days:] if len(snapshots) >= days else snapshots
    first  = recent[0]
    last   = recent[-1]

    port_start  = first["portfolio_value"]
    port_end    = last["portfolio_value"]
    bench_start = first["benchmark_price"]
    bench_end   = last["benchmark_price"]

    port_return  = (port_end - port_start) / port_start if port_start > 0 else 0
    bench_return = (bench_end - bench_start) / bench_start if bench_start > 0 else 0
    alpha        = port_return - bench_return
    pnl          = port_end - port_start

    # Max drawdown over the period
    peak = port_start
    max_drawdown = 0.0
    for s in recent:
        v = s["portfolio_value"]
        if v > peak:
            peak = v
        dd = (v - peak) / peak if peak > 0 else 0
        if dd < max_drawdown:
            max_drawdown = dd

    return {
        "period_days":    len(recent),
        "start_date":     first["date"],
        "end_date":       last["date"],
        "start_value":    port_start,
        "end_value":      port_end,
        "pnl":            round(pnl, 2),
        "port_return_pct": round(port_return * 100, 3),
        "bench_return_pct": round(bench_return * 100, 3),
        "alpha_pct":      round(alpha * 100, 3),
        "max_drawdown_pct": round(max_drawdown * 100, 3),
        "beating_market": alpha > 0,
    }
