import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path('/opt/nexustrader/nexustrader.env'))
load_dotenv(Path(__file__).parent / '.env', override=False)

# --- Alpaca ---
ALPACA_API_KEY    = os.getenv("ALPACA_API_KEY", "")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY", "")
ALPACA_BASE_URL   = os.getenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets")

# --- Paths ---
_ROOT          = Path(__file__).parent.parent
SIGNALS_DIR    = _ROOT / "signals"
PORTFOLIO_JSON = SIGNALS_DIR / "portfolio.json"
SIGNALS_JSON   = SIGNALS_DIR / "signals.json"
KILL_FILE      = SIGNALS_DIR / "kill_switch.json"

_HERE      = Path(__file__).parent
TRADE_LOG  = _HERE / "logs" / "trade_log.json"
LOG_FILE   = _HERE / "logs" / "portfolio-manager.log"

# --- Risk limits ---
MAX_DAILY_LOSS_PCT   = 0.03   # halt new entries if down 3% on the day
MAX_TOTAL_LOSS_PCT   = 0.10   # emergency close all if down 10% total
MAX_POSITION_PCT     = 0.10   # no single position > 10% of portfolio
MAX_POSITIONS        = 5
