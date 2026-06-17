"""
earnings-predictor — alternative data earnings signal generator

Runs daily. For each ticker in today's signals.json, collects alternative
data signals (Google Trends, App Store, job postings) and predicts whether
the next earnings will beat or miss expectations.

Writes earnings_predictions.json to signals/ bus.
swing-bot reads this to avoid entering positions before predicted misses,
and to size up positions before predicted beats.

Commands:
  python main.py                          # run on today's signals.json tickers
  python main.py --tickers NVDA MSFT      # run on specific tickers
  python main.py --status                 # print last predictions
"""

import sys
import json
import logging
import logging.handlers
import os
import tempfile
from datetime import datetime, timezone, date
from pathlib import Path

from config import LOG_FILE, SIGNALS_JSON, EARNINGS_PREDICTIONS_JSON, SIGNALS_DIR
from predictor import predict

_HERE = Path(__file__).parent
os.makedirs(_HERE / "logs", exist_ok=True)
os.makedirs(_HERE / "cache", exist_ok=True)

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


def load_tickers_from_signals() -> list[tuple[str, str]]:
    """Returns list of (ticker, company_name) from today's signals.json."""
    if not SIGNALS_JSON.exists():
        return []
    try:
        data   = json.loads(SIGNALS_JSON.read_text())
        result = []
        seen   = set()
        for t in data.get("theses", []):
            ticker = t.get("ticker", "")
            if ticker and ticker not in seen:
                result.append((ticker, t.get("company", "")))
                seen.add(ticker)
        return result
    except Exception as e:
        logger.error("[Main] Failed to load signals.json: %s", e)
        return []


def write_predictions(predictions: list[dict]) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "date":         date.today().isoformat(),
        "predictions":  predictions,
        # Convenience: tickers with earnings warnings for swing-bot to check
        "warnings":     [p for p in predictions if p.get("warning")],
        "avoid":        [p["ticker"] for p in predictions
                         if p["prediction"] == "miss" and p.get("days_to_earnings") is not None
                         and p["days_to_earnings"] <= 7],
    }
    os.makedirs(SIGNALS_DIR, exist_ok=True)
    _atomic_write(EARNINGS_PREDICTIONS_JSON, payload)
    logger.info("[Main] earnings_predictions.json written: %d predictions, %d warnings, %d avoid",
                len(predictions), len(payload["warnings"]), len(payload["avoid"]))
    print(f"[Main] earnings_predictions.json updated ({len(predictions)} tickers, {len(payload['avoid'])} to avoid)")


def print_status() -> None:
    path = EARNINGS_PREDICTIONS_JSON
    if not path.exists():
        print("No earnings_predictions.json — run predictor first")
        return
    data = json.loads(path.read_text())
    print(f"\n{'='*60}")
    print(f"EARNINGS PREDICTOR — {data.get('date', '?')}")
    print(f"{'='*60}")
    for p in data.get("predictions", []):
        icon = "🟢" if p["prediction"] == "beat" else "🔴" if p["prediction"] == "miss" else "🟡"
        dte  = f"  ({p['days_to_earnings']}d)" if p.get("days_to_earnings") is not None else ""
        warn = f"  ⚠️  {p['warning']}" if p.get("warning") else ""
        print(f"  {icon} {p['ticker']:<6} {p['prediction']:<20} conf:{p['confidence']:>3}%  signals:{p['signals_count']}{dte}{warn}")
    avoid = data.get("avoid", [])
    if avoid:
        print(f"\n  ⛔ AVOID (miss predicted within 7d): {', '.join(avoid)}")
    print(f"{'='*60}")


def run(tickers: list[tuple[str, str]] = None) -> None:
    logger.info("="*60)
    logger.info("EARNINGS PREDICTOR started — %s", datetime.now().strftime("%Y-%m-%d %H:%M"))

    print(f"\n{'='*40}")
    print(f"EARNINGS PREDICTOR — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*40}\n")

    if not tickers:
        tickers = load_tickers_from_signals()

    if not tickers:
        print("[Main] No tickers to analyze. Run market-lens first.")
        return

    print(f"[Predict] Analyzing {len(tickers)} tickers...")
    predictions = []
    for ticker, company in tickers:
        print(f"  → {ticker} ({company or 'unknown'})...")
        result = predict(ticker, company)
        predictions.append(result)

        icon = "🟢" if result["prediction"] == "beat" else "🔴" if result["prediction"] == "miss" else "🟡"
        dte  = f" | earnings in {result['days_to_earnings']}d" if result.get("days_to_earnings") is not None else ""
        print(f"     {icon} {result['prediction']:<20} conf:{result['confidence']:>3}%  ({result['signals_count']} signals){dte}")
        if result.get("warning"):
            print(f"     ⚠️  {result['warning']}")

    write_predictions(predictions)

    # Print avoid list
    avoid = [p["ticker"] for p in predictions
             if p["prediction"] == "miss" and p.get("days_to_earnings") is not None
             and p["days_to_earnings"] <= 7]
    if avoid:
        print(f"\n⛔ Swing-bot will AVOID these tickers (miss predicted within 7 days): {', '.join(avoid)}")

    logger.info("EARNINGS PREDICTOR complete — %d predictions", len(predictions))
    print("\n[Done] Earnings prediction complete.")


if __name__ == "__main__":
    args = sys.argv[1:]
    try:
        if "--status" in args:
            print_status()
        elif "--tickers" in args:
            idx     = args.index("--tickers")
            raw     = args[idx + 1:]
            tickers = [(t.upper(), "") for t in raw]
            run(tickers)
        else:
            run()
    except KeyboardInterrupt:
        print("\n[EarningsPredictor] Interrupted.")
        sys.exit(0)
    except Exception as e:
        logger.exception("[Main] FATAL: %s", e)
        print(f"\n[Main] FATAL ERROR: {e}")
        sys.exit(1)
