import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

_ROOT       = Path(__file__).parent.parent
SIGNALS_DIR = _ROOT / "signals"
SIGNALS_JSON = SIGNALS_DIR / "signals.json"
OPTIONS_SIGNALS_JSON = SIGNALS_DIR / "options_signals.json"

_HERE    = Path(__file__).parent
LOG_FILE = _HERE / "logs" / "options-flow.log"

# Unusual activity thresholds
MIN_VOLUME_OI_RATIO = 2.0    # volume must be 2x open interest to flag as unusual
MIN_OPTION_VOLUME   = 500    # ignore thinly traded options
MIN_PREMIUM         = 50_000 # total premium (price * volume * 100) must exceed $50k
TOP_N_TICKERS       = 20     # how many tickers from signals.json to scan
