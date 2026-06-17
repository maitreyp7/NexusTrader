"""
portfolio-manager — NexusTrader position tracker and risk monitor

Runs after market close each day (or on-demand).
- Detects which swing-bot positions closed during the day
- Records every completed trade to the persistent trade log
- Checks risk limits and activates kill switch if needed
- Prints daily summary

Commands:
  python main.py            # full check: detect closes, record trades, check risk
  python main.py --status   # print current portfolio metrics and trade log stats
  python main.py --reset-kill  # deactivate kill switch (use after reviewing losses)
"""

import sys
import json
import logging
import logging.handlers
import os
from datetime import datetime, timezone
from pathlib import Path

from config import LOG_FILE, PORTFOLIO_JSON, SIGNALS_DIR
from tracker import detect_closed_positions, get_portfolio_metrics, load_portfolio
from trade_log import record_trade, get_stats
from kill_switch import check_risk_limits, is_kill_active, deactivate_kill_switch
from orb_bridge import merge_orb_trades
import sys as _sys
_sys.path.insert(0, "/opt/nexustrader/swing-bot")
from swing_brain import rebuild_brain, log_brain_summary
from ml_confirmations import run as record_confirmations
import importlib
import sys as _sys

_HERE = Path(__file__).parent
os.makedirs(_HERE / "logs", exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.handlers.RotatingFileHandler(LOG_FILE, maxBytes=5_000_000, backupCount=7),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)


def write_risk_budget(portfolio_value: float) -> None:
    """
    Computes ORB + swing exposure separately and writes risk_budget.json.
    Each bot has its own cap so swing multi-day holds don't block ORB intraday entries.
      swing cap: 40% of portfolio  (multi-day holds, turns over slowly)
      orb cap:   20% of portfolio  (intraday only, resets every session)
    """
    from tracker import get_alpaca_positions, load_portfolio
    try:
        positions = get_alpaca_positions()
        swing_portfolio = load_portfolio()
        swing_tickers = {p["ticker"] for p in swing_portfolio.get("positions", [])}

        orb_exposure   = 0.0
        swing_exposure = 0.0
        for sym, pos in positions.items():
            market_val = abs(float(pos.get("market_value", 0)))
            if sym in swing_tickers:
                swing_exposure += market_val
            else:
                orb_exposure   += market_val

        total_exposure = orb_exposure + swing_exposure
        total_pct      = total_exposure / portfolio_value if portfolio_value > 0 else 0.0

        orb_pct            = orb_exposure   / portfolio_value if portfolio_value > 0 else 0.0
        swing_pct          = swing_exposure / portfolio_value if portfolio_value > 0 else 0.0
        orb_remaining_pct  = max(0.0, 0.20 - orb_pct)   # ORB cap: 20%
        swing_remaining_pct = max(0.0, 0.40 - swing_pct) # Swing cap: 40%

        budget = {
            "portfolio_value":    round(portfolio_value, 2),
            "orb_exposure":       round(orb_exposure, 2),
            "swing_exposure":     round(swing_exposure, 2),
            "total_exposure_pct": round(total_pct, 4),
            "orb_remaining_pct":  round(orb_remaining_pct, 4),
            "swing_remaining_pct": round(swing_remaining_pct, 4),
            # kept for backward compat — reflects swing cap since that's the binding constraint
            "remaining_pct":      round(swing_remaining_pct, 4),
            "updated_at":         datetime.now(timezone.utc).isoformat(),
        }
        budget_path = Path('/opt/nexustrader/signals/risk_budget.json')
        _atomic_write_json(budget_path, budget)
        print(f"      Risk budget: ORB {orb_pct*100:.1f}%/20% ({orb_remaining_pct*100:.1f}% left) | Swing {swing_pct*100:.1f}%/40% ({swing_remaining_pct*100:.1f}% left)")
        logger.info("[RiskBudget] ORB %.1f%% (%.1f%% left) | Swing %.1f%% (%.1f%% left) | Total %.1f%%",
                    orb_pct * 100, orb_remaining_pct * 100, swing_pct * 100, swing_remaining_pct * 100, total_pct * 100)
    except Exception as e:
        logger.warning("[RiskBudget] Failed to write risk_budget.json: %s", e)


def _atomic_write_json(path: Path, data) -> None:
    import tempfile
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


def remove_closed_from_portfolio(closed_tickers: list[str]) -> None:
    """Remove closed positions from portfolio.json."""
    portfolio = load_portfolio()
    remaining = [p for p in portfolio.get("positions", []) if p.get("ticker") not in closed_tickers]
    payload = {
        **portfolio,
        "positions":    remaining,
        "updated_at":   datetime.now(timezone.utc).isoformat(),
    }
    os.makedirs(SIGNALS_DIR, exist_ok=True)
    _atomic_write_json(PORTFOLIO_JSON, payload)
    logger.info("[Main] Removed %d closed positions from portfolio.json", len(closed_tickers))


def print_status() -> None:
    print("\n" + "="*55)
    print("PORTFOLIO MANAGER STATUS")
    print("="*55)

    metrics = get_portfolio_metrics()
    print(f"Portfolio Value:  ${metrics['portfolio_value']:>12,.2f}")
    print(f"Cash:             ${metrics['cash']:>12,.2f}")
    print(f"Daily P&L:        ${metrics['daily_pnl']:>+12,.2f}")
    print(f"Open Positions:   {metrics['open_positions']}")
    print(f"Kill Switch:      {'ACTIVE ⚠️' if is_kill_active() else 'Inactive'}")

    print("\nTRADE LOG STATS (all-time):")
    stats = get_stats()
    print(f"  Total trades:   {stats['total']}")
    print(f"  Win rate:       {stats['win_rate']*100:.1f}%  ({stats['wins']}W / {stats['losses']}L)")
    print(f"  Total P&L:      ${stats['total_pnl']:>+,.2f}")
    if stats['total'] > 0:
        print(f"  Avg win:        ${stats.get('avg_win', 0):>+,.2f}")
        print(f"  Avg loss:       ${stats.get('avg_loss', 0):>+,.2f}")
        print(f"  Best trade:     ${stats.get('best_trade', 0):>+,.2f}")
        print(f"  Worst trade:    ${stats.get('worst_trade', 0):>+,.2f}")
    print("="*55)


def run() -> None:
    logger.info("="*60)
    logger.info("PORTFOLIO MANAGER started — %s", datetime.now().strftime("%Y-%m-%d %H:%M"))

    print(f"\n{'='*40}")
    print(f"PORTFOLIO MANAGER — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*40}\n")

    # Step 1: Get current metrics
    print("[1/3] Fetching portfolio metrics...")
    metrics = get_portfolio_metrics()
    print(f"      Portfolio: ${metrics['portfolio_value']:,.2f} | Daily P&L: ${metrics['daily_pnl']:+,.2f} | Positions: {metrics['open_positions']}")

    # Write shared risk budget for both bots to read
    print("\n[1b/3] Writing shared risk budget...")
    write_risk_budget(metrics["portfolio_value"])

    # Step 2: Detect and record closed positions
    print("\n[2/3] Detecting closed positions...")
    closed = detect_closed_positions()

    if closed:
        print(f"      {len(closed)} position(s) closed since last check:")
        closed_tickers = []
        for c in closed:
            trade = record_trade(
                ticker=       c["ticker"],
                entry_price=  c["entry_price"],
                exit_price=   c["exit_price"],
                shares=       c["shares"],
                entry_time=   c["entry_time"],
                exit_time=    c["exit_time"],
                stop_loss=    c["stop_loss"],
                take_profit=  c["take_profit"],
                thesis_score= c["thesis_score"],
                exit_reason=  c["exit_reason"],
                thesis=       c["thesis"],
                verdict=      c["verdict"],
                sector=       c["sector"],
                signals_used= c["signals_used"],
            )
            if trade.get("skipped"):
                continue  # TEST/crypto symbol — not recorded
            pnl_str = f"${trade['pnl']:+.2f} ({trade['pnl_pct']*100:+.1f}%)"
            print(f"      {trade['outcome']:4} {c['ticker']:6} | {pnl_str:>20} | {c['exit_reason']}")
            closed_tickers.append(c["ticker"])

        remove_closed_from_portfolio(closed_tickers)
    else:
        print("      No new closed positions detected.")

    # Step 2b: Merge ORB session trades into trade log
    print("\n[2b/3] Merging ORB session trades...")
    orb_added = merge_orb_trades()
    if orb_added:
        print(f"      {orb_added} new ORB trade(s) recorded")
    else:
        print("      No new ORB trades to merge")

    # Step 3: Risk check
    print("\n[3/3] Checking risk limits...")
    triggered = check_risk_limits(
        daily_pnl=       metrics["daily_pnl"],
        portfolio_value= metrics["portfolio_value"],
        total_cost_basis=metrics["cost_basis"],
    )
    if triggered:
        print("      ⚠️  Kill switch ACTIVATED — swing-bot will not enter new positions today")
    elif is_kill_active():
        print("      ⚠️  Kill switch is still active from earlier today")
    else:
        print("      Risk limits OK — swing-bot clear to trade")

    # Step 4: Rebuild swing brain from outcomes
    print("\n[4/4] Rebuilding swing brain from trade outcomes...")
    try:
        brain = rebuild_brain()
        print(f"      Brain updated — {len(brain)} symbol(s) in memory")
        log_brain_summary()
    except Exception as e:
        logger.warning("[Brain] Swing brain rebuild failed: %s", e)
        print(f"      Brain rebuild failed: {e}")

    # Step 5: Record market-lens signal confirmations (daily)
    print("\n[5/5] Recording market-lens signal confirmations...")
    try:
        record_confirmations()
        print("      Confirmations recorded")
    except Exception as e:
        logger.warning("[Confirmations] Failed: %s", e)
        print(f"      Confirmations failed: {e}")

    print_status()
    logger.info("PORTFOLIO MANAGER complete.")


def _validate_config() -> None:
    from config import ALPACA_API_KEY, ALPACA_SECRET_KEY
    if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
        logger.critical("[Config] ALPACA keys missing — exiting")
        print("[Config] ERROR: Alpaca API keys missing. Check portfolio-manager/.env")
        sys.exit(1)


if __name__ == "__main__":
    _validate_config()
    args = sys.argv[1:]

    if "--reset-kill" in args:
        deactivate_kill_switch()
        print("[KillSwitch] Reset. Swing-bot can trade again.")
        sys.exit(0)

    if "--status" in args:
        print_status()
        sys.exit(0)

    try:
        run()
    except KeyboardInterrupt:
        print("\n[PortfolioManager] Interrupted.")
        sys.exit(0)
    except Exception as e:
        logger.exception("[Main] FATAL: %s", e)
        print(f"\n[Main] FATAL ERROR: {e}")
        sys.exit(1)
