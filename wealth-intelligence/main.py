"""
wealth-intelligence — NexusTrader performance tracker

Runs daily after market close to snapshot portfolio value.
Generates weekly reports every Friday.

Commands:
  python main.py              # take snapshot + generate report if Friday
  python main.py --snapshot   # take snapshot only
  python main.py --report     # generate weekly report now
  python main.py --status     # print current performance summary
"""

import sys
import logging
import logging.handlers
import os
from datetime import date
from pathlib import Path

from config import LOG_FILE
from snapshots import take_snapshot, compute_performance
from reporter import generate_weekly_report, print_report

_HERE = Path(__file__).parent
os.makedirs(_HERE / "logs", exist_ok=True)
os.makedirs(_HERE / "reports", exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.handlers.RotatingFileHandler(LOG_FILE, maxBytes=5_000_000, backupCount=7),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)


def run() -> None:
    from datetime import datetime
    logger.info("="*60)
    logger.info("WEALTH INTELLIGENCE started — %s", datetime.now().strftime("%Y-%m-%d %H:%M"))

    print(f"\n{'='*40}")
    print(f"WEALTH INTELLIGENCE — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*40}\n")

    # Always take a daily snapshot
    print("[1/2] Taking portfolio snapshot...")
    snapshot = take_snapshot()
    print(f"      Portfolio: ${snapshot['portfolio_value']:,.2f} | {snapshot['date']}")

    # Generate report on Fridays (weekday 4) or when forced
    today = date.today()
    if today.weekday() == 4:
        print("\n[2/2] It's Friday — generating weekly report...")
        report = generate_weekly_report()
        print_report(report)
    else:
        print(f"\n[2/2] Weekly report generates on Fridays (today is {today.strftime('%A')})")
        perf = compute_performance(7)
        if "error" not in perf:
            print(f"      7-day return: {perf['port_return_pct']:+.3f}% vs SPY {perf['bench_return_pct']:+.3f}% (alpha: {perf['alpha_pct']:+.3f}%)")

    logger.info("WEALTH INTELLIGENCE complete.")


if __name__ == "__main__":
    args = sys.argv[1:]

    try:
        if "--snapshot" in args:
            s = take_snapshot()
            print(f"Snapshot recorded: ${s['portfolio_value']:,.2f} on {s['date']}")

        elif "--report" in args:
            report = generate_weekly_report()
            print_report(report)

        elif "--status" in args:
            perf7  = compute_performance(7)
            perf30 = compute_performance(30)
            print("\n7-DAY:")
            if "error" in perf7:
                print(f"  {perf7['error']}")
            else:
                print(f"  Portfolio: {perf7['port_return_pct']:+.3f}% | SPY: {perf7['bench_return_pct']:+.3f}% | Alpha: {perf7['alpha_pct']:+.3f}%")
                print(f"  Max drawdown: {perf7['max_drawdown_pct']:.2f}%")
            print("\n30-DAY:")
            if "error" in perf30:
                print(f"  {perf30['error']}")
            else:
                print(f"  Portfolio: {perf30['port_return_pct']:+.3f}% | SPY: {perf30['bench_return_pct']:+.3f}% | Alpha: {perf30['alpha_pct']:+.3f}%")
                print(f"  Max drawdown: {perf30['max_drawdown_pct']:.2f}%")
        else:
            run()

    except KeyboardInterrupt:
        print("\n[WealthIntelligence] Interrupted.")
        sys.exit(0)
    except Exception as e:
        logger.exception("[Main] FATAL: %s", e)
        print(f"\n[Main] FATAL ERROR: {e}")
        sys.exit(1)
