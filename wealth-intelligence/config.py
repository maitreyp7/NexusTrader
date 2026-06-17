import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

ALPACA_API_KEY    = os.getenv("ALPACA_API_KEY", "")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY", "")
ALPACA_BASE_URL   = os.getenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets")

_ROOT          = Path(__file__).parent.parent
SIGNALS_DIR    = _ROOT / "signals"
TRADE_LOG      = _ROOT / "portfolio-manager" / "logs" / "trade_log.json"

_HERE          = Path(__file__).parent
REPORT_DIR     = _HERE / "reports"
LOG_FILE       = _HERE / "logs" / "wealth-intelligence.log"
SNAPSHOT_FILE  = _HERE / "logs" / "snapshots.json"

# S&P 500 benchmark ticker
BENCHMARK      = "SPY"
