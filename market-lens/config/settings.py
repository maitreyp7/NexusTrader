import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from market-lens root — works locally and on VPS
load_dotenv(Path(__file__).parent.parent / ".env")

# --- Anthropic ---
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# --- SMS (Verizon gateway — disabled) ---
SMS_EMAIL = os.getenv("SMS_EMAIL", "")
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "")
SENDER_PASSWORD = os.getenv("SENDER_PASSWORD", "")

# --- External Data APIs ---
FRED_API_KEY = os.getenv("FRED_API_KEY", "")   # free at fred.stlouisfed.org

# --- Pipeline ---
MAX_ARTICLES_PER_SOURCE = 20
MAX_ARTICLES_TO_REASON = 80     # increased: more sources now feed in
TOP_N_STOCKS = 7                # increased: dashboard can show more than SMS could
CONFIDENCE_THRESHOLD = 50       # minimum score to include

# --- Scheduling ---
BRIEF_HOUR = 7
BRIEF_MINUTE = 0

# --- Sectors ---
SECTORS = [
    # lowercase (internal / SEC_WATCHLIST keys)
    "technology",
    "defense",
    "energy",
    "finance",
    "rare_earth",
    "healthcare",
    "semiconductors",
    # Title-case aliases Claude Sonnet outputs (base sector names it uses)
    "Technology",
    "Defense",
    "Aerospace",
    "Energy",
    "Finance",
    "Healthcare",
    "Semiconductors",
    "Utilities",
    "Communication Services",
    "Consumer Cyclical",
    "Consumer Defensive",
    "Financial Services",
    "Basic Materials",
    "Industrials",
    "Real Estate",
    # Claude sometimes outputs sub-sector strings — map these via normalizer
    "Healthcare - Biotechnology",
    "Healthcare - Pharmaceuticals",
    "Healthcare - Medical Devices",
    "Healthcare - Life Sciences Tools & Services",
    "Healthcare - Managed Care",
    "Technology - Software",
    "Technology - Hardware",
    "Technology - Semiconductors",
    "Energy - Renewable",
    "Energy - Oil & Gas",
    "Finance - Banking",
    "Finance - Asset Management",
]
