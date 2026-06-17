"""
options-flow — unusual options activity scanner

Runs after market-lens each morning. Scans tickers from signals.json for
unusual options activity (high volume vs open interest = smart money entering).
Writes options_signals.json to signals/ bus for swing-bot and dashboard to read.

Commands:
  python main.py              # scan tickers from today's signals.json
  python main.py --tickers NVDA MSFT AAPL  # scan specific tickers
  python main.py --status     # print last options_signals.json
"""

import sys
import json
import logging
import logging.handlers
import os
import tempfile
from datetime import datetime, timezone, date
from pathlib import Path

from config import (
    LOG_FILE, SIGNALS_JSON, OPTIONS_SIGNALS_JSON,
    SIGNALS_DIR, TOP_N_TICKERS,
)
from scanner import scan_tickers, summarize_by_ticker

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


def load_tickers_from_signals() -> list[str]:
    """Pull the top N tickers from today's signals.json."""
    if not SIGNALS_JSON.exists():
        logger.warning("[Main] signals.json not found — no tickers to scan")
        return []
    try:
        data    = json.loads(SIGNALS_JSON.read_text())
        today   = date.today().isoformat()
        if data.get("date") != today:
            logger.warning("[Main] signals.json is stale (%s) — scanning anyway", data.get("date"))
        theses  = data.get("theses", [])
        tickers = [t["ticker"] for t in theses if t.get("ticker")]
        return list(dict.fromkeys(tickers))[:TOP_N_TICKERS]  # dedupe, preserve order
    except Exception as e:
        logger.error("[Main] Failed to load signals.json: %s", e)
        return []


def write_options_signals(summaries: list[dict]) -> None:
    today   = date.today().isoformat()
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "date":         today,
        "signals":      summaries,
    }
    os.makedirs(SIGNALS_DIR, exist_ok=True)
    _atomic_write(OPTIONS_SIGNALS_JSON, payload)
    logger.info("[Main] options_signals.json written: %d tickers with unusual activity", len(summaries))
    print(f"[Main] options_signals.json updated ({len(summaries)} tickers)")


def print_status() -> None:
    if not OPTIONS_SIGNALS_JSON.exists():
        print("No options_signals.json found — run scanner first")
        return
    data = json.loads(OPTIONS_SIGNALS_JSON.read_text())
    print(f"\n{'='*55}")
    print(f"OPTIONS FLOW — {data.get('date', '?')}")
    print(f"{'='*55}")
    for s in data.get("signals", []):
        sentiment_icon = "🟢" if s["sentiment"] == "bullish" else "🔴" if s["sentiment"] == "bearish" else "🟡"
        print(f"  {sentiment_icon} {s['ticker']:<6} | {s['sentiment']:<8} | "
              f"C/P: {s['call_put_ratio']:.0%}/{1-s['call_put_ratio']:.0%} | "
              f"Premium: ${s['total_premium']:>10,.0f} | "
              f"{s['unusual_contracts']} unusual contracts")
    print(f"{'='*55}")


def run(tickers: list[str] = None) -> None:
    logger.info("="*60)
    logger.info("OPTIONS FLOW started — %s", datetime.now().strftime("%Y-%m-%d %H:%M"))

    print(f"\n{'='*40}")
    print(f"OPTIONS FLOW — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*40}\n")

    if not tickers:
        tickers = load_tickers_from_signals()

    if not tickers:
        print("[Main] No tickers to scan. Run market-lens first.")
        return

    print(f"[Scan] Scanning {len(tickers)} tickers: {', '.join(tickers)}")
    all_contracts = scan_tickers(tickers)

    if not all_contracts:
        print("[Scan] No unusual options activity detected today.")
        write_options_signals([])
        return

    summaries = summarize_by_ticker(all_contracts)
    print(f"\n[Results] {len(summaries)} tickers with unusual activity:")
    for s in summaries:
        icon = "🟢" if s["sentiment"] == "bullish" else "🔴" if s["sentiment"] == "bearish" else "🟡"
        print(f"  {icon} {s['ticker']:<6} {s['sentiment']:<8} — ${s['total_premium']:>10,.0f} premium | {s['unusual_contracts']} contracts")

    write_options_signals(summaries)
    logger.info("OPTIONS FLOW complete — %d unusual signals", len(summaries))
    print("\n[Done] Options flow scan complete.")


if __name__ == "__main__":
    args = sys.argv[1:]

    try:
        if "--status" in args:
            print_status()

        elif "--tickers" in args:
            idx     = args.index("--tickers")
            tickers = args[idx + 1:]
            if not tickers:
                print("Usage: python main.py --tickers NVDA MSFT AAPL")
                sys.exit(1)
            run(tickers=[t.upper() for t in tickers])

        else:
            run()

    except KeyboardInterrupt:
        print("\n[OptionsFlow] Interrupted.")
        sys.exit(0)
    except Exception as e:
        logger.exception("[Main] FATAL: %s", e)
        print(f"\n[Main] FATAL ERROR: {e}")
        sys.exit(1)
