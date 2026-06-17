"""
Weekly performance report — reads trade log + snapshots, writes a human-readable
report to reports/YYYY-WW.json that the dashboard can display.
"""

import json
import os
import logging
from datetime import datetime, timezone, date
from pathlib import Path
from config import TRADE_LOG, REPORT_DIR
from snapshots import compute_performance

logger = logging.getLogger(__name__)


def load_trade_log() -> list[dict]:
    if TRADE_LOG.exists():
        try:
            return json.loads(TRADE_LOG.read_text())
        except Exception:
            pass
    return []


def _trades_this_week(trades: list[dict]) -> list[dict]:
    today     = date.today()
    week_start = today.toordinal() - today.weekday()  # Monday
    result = []
    for t in trades:
        try:
            exit_date = datetime.fromisoformat(t["exit_time"]).date()
            if exit_date.toordinal() >= week_start:
                result.append(t)
        except Exception:
            pass
    return result


def generate_weekly_report() -> dict:
    trades     = load_trade_log()
    week_trades = _trades_this_week(trades)
    perf_30d   = compute_performance(30)
    perf_7d    = compute_performance(7)

    wins   = [t for t in week_trades if t["outcome"] == "WIN"]
    losses = [t for t in week_trades if t["outcome"] == "LOSS"]
    week_pnl = sum(t["pnl"] for t in week_trades)
    win_rate = len(wins) / len(week_trades) if week_trades else 0

    # Best and worst trade this week
    best  = max(week_trades, key=lambda t: t["pnl"], default=None)
    worst = min(week_trades, key=lambda t: t["pnl"], default=None)

    # Sector breakdown
    sector_pnl: dict[str, float] = {}
    for t in week_trades:
        sector = t.get("sector", "unknown")
        sector_pnl[sector] = sector_pnl.get(sector, 0) + t["pnl"]

    # Signal type that worked best
    exit_reasons = {}
    for t in week_trades:
        r = t.get("exit_reason", "unknown")
        exit_reasons[r] = exit_reasons.get(r, 0) + 1

    # All-time stats
    all_wins   = [t for t in trades if t["outcome"] == "WIN"]
    all_losses = [t for t in trades if t["outcome"] == "LOSS"]

    report = {
        "generated_at":    datetime.now(timezone.utc).isoformat(),
        "week":            date.today().strftime("%Y-W%W"),
        "weekly": {
            "trades":      len(week_trades),
            "wins":        len(wins),
            "losses":      len(losses),
            "win_rate":    round(win_rate * 100, 1),
            "pnl":         round(week_pnl, 2),
            "best_trade":  {"ticker": best["ticker"], "pnl": best["pnl"]} if best else None,
            "worst_trade": {"ticker": worst["ticker"], "pnl": worst["pnl"]} if worst else None,
            "sector_pnl":  {k: round(v, 2) for k, v in sorted(sector_pnl.items(), key=lambda x: -x[1])},
            "exit_reasons": exit_reasons,
        },
        "performance_7d":  perf_7d,
        "performance_30d": perf_30d,
        "all_time": {
            "trades":    len(trades),
            "wins":      len(all_wins),
            "losses":    len(all_losses),
            "win_rate":  round(len(all_wins) / len(trades) * 100, 1) if trades else 0,
            "total_pnl": round(sum(t["pnl"] for t in trades), 2),
        },
    }

    # Write to reports/
    os.makedirs(REPORT_DIR, exist_ok=True)
    report_path = REPORT_DIR / f"{report['week']}.json"
    report_path.write_text(json.dumps(report, indent=2))
    logger.info("[Reporter] Weekly report written to %s", report_path)
    return report


def print_report(report: dict) -> None:
    w  = report["weekly"]
    p7 = report.get("performance_7d", {})
    p30 = report.get("performance_30d", {})
    at = report["all_time"]

    print(f"\n{'='*55}")
    print(f"WEALTH INTELLIGENCE — Week {report['week']}")
    print(f"{'='*55}")

    print(f"\nTHIS WEEK:")
    print(f"  Trades:    {w['trades']}  ({w['wins']}W / {w['losses']}L)  Win rate: {w['win_rate']}%")
    print(f"  P&L:       ${w['pnl']:>+,.2f}")
    if w["best_trade"]:
        print(f"  Best:      {w['best_trade']['ticker']} ${w['best_trade']['pnl']:>+,.2f}")
    if w["worst_trade"]:
        print(f"  Worst:     {w['worst_trade']['ticker']} ${w['worst_trade']['pnl']:>+,.2f}")

    if not isinstance(p7, dict) or "error" not in p7:
        print(f"\n7-DAY PERFORMANCE:")
        print(f"  Portfolio: {p7.get('port_return_pct', 0):>+.3f}%")
        print(f"  SPY:       {p7.get('bench_return_pct', 0):>+.3f}%")
        print(f"  Alpha:     {p7.get('alpha_pct', 0):>+.3f}%  {'✅ Beating market' if p7.get('beating_market') else '❌ Lagging market'}")
        print(f"  Max DD:    {p7.get('max_drawdown_pct', 0):.2f}%")

    if not isinstance(p30, dict) or "error" not in p30:
        print(f"\n30-DAY PERFORMANCE:")
        print(f"  Portfolio: {p30.get('port_return_pct', 0):>+.3f}%")
        print(f"  SPY:       {p30.get('bench_return_pct', 0):>+.3f}%")
        print(f"  Alpha:     {p30.get('alpha_pct', 0):>+.3f}%  {'✅ Beating market' if p30.get('beating_market') else '❌ Lagging market'}")
        print(f"  Max DD:    {p30.get('max_drawdown_pct', 0):.2f}%")

    print(f"\nALL TIME:")
    print(f"  Trades:    {at['trades']}  ({at['wins']}W / {at['losses']}L)  Win rate: {at['win_rate']}%")
    print(f"  Total P&L: ${at['total_pnl']:>+,.2f}")

    if w.get("sector_pnl"):
        print(f"\nSECTOR P&L (this week):")
        for sector, pnl in w["sector_pnl"].items():
            print(f"  {sector:<20} ${pnl:>+,.2f}")

    print(f"{'='*55}")
