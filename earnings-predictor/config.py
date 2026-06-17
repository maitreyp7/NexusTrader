import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

_ROOT        = Path(__file__).parent.parent
SIGNALS_DIR  = _ROOT / "signals"
SIGNALS_JSON = SIGNALS_DIR / "signals.json"
EARNINGS_PREDICTIONS_JSON = SIGNALS_DIR / "earnings_predictions.json"

_HERE    = Path(__file__).parent
LOG_FILE = _HERE / "logs" / "earnings-predictor.log"
CACHE_DIR = _HERE / "cache"

# How many days before earnings to start warning
EARNINGS_WARN_DAYS = 7

# Minimum signals needed before making a prediction
MIN_SIGNALS_FOR_PREDICTION = 1

# App store tracked tickers (consumer-facing companies only)
APP_STORE_TICKERS = {
    "SPOT": "spotify-music",
    "UBER": "uber-request-a-ride",
    "LYFT": "lyft",
    "SNAP": "snapchat",
    "PINS": "pinterest",
    "NFLX": "netflix",
    "COIN": "coinbase-buy-bitcoin-ether",
    "HOOD": "robinhood-investing-for-all",
    "SOFI": "sofi-invest-and-save",
}

# Google Trends keywords per ticker
TRENDS_KEYWORDS = {
    "NVDA": "NVIDIA GPU",
    "MSFT": "Microsoft Azure",
    "AAPL": "Apple iPhone",
    "GOOGL": "Google Search",
    "META": "Facebook",
    "AMZN": "Amazon shopping",
    "TSLA": "Tesla",
    "NFLX": "Netflix",
    "SPOT": "Spotify",
    "UBER": "Uber",
    "COIN": "Coinbase",
}
