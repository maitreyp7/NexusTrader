"""
stock_universe.py — A broad, liquid single-name universe for the mean-reversion hunt.

~150 large-cap US stocks across sectors. Used ONLY for backtesting/validation (Yahoo
free data). If a sleeve passes, we'd trade it live on Alpaca (which has all these names).

HONESTY NOTES (survivorship bias):
  - This is today's large-cap list. Stocks that existed but died (Lehman, Enron, etc.)
    are NOT here. That biases backtests slightly OPTIMISTIC (we only see survivors).
  - Mitigations: (1) we test mean-REVERSION, which is far less survivorship-sensitive
    than buy-and-hold (we hold each name only days, and a name needs to merely EXIST and
    be oversold-then-bounce, not be a long-run winner). (2) The gatekeeper's per-era test
    catches edges that only worked in one survivor-friendly window. (3) We require the
    edge to hold in the RECENT half (post-2015), where these names were all already public.
  - Names IPO'd late (e.g. ABNB 2020) simply contribute no signal before they exist —
    the engine masks pre-listing rows to zero weight. That's correct, not a bug.
"""

from __future__ import annotations

# Broad large-cap set across sectors. Chosen for liquidity + long Yahoo history.
# Deliberately diverse so the cross-section has dispersion to mean-revert against.
STOCK_UNIVERSE = [
    # Mega-cap tech
    "AAPL","MSFT","GOOGL","AMZN","META","NVDA","AVGO","ORCL","CSCO","ADBE",
    "CRM","INTC","AMD","QCOM","TXN","IBM","NOW","INTU","AMAT","MU",
    # Consumer
    "WMT","HD","MCD","NKE","SBUX","TGT","LOW","COST","DIS","CMCSA",
    "PG","KO","PEP","PM","MO","CL","KMB","GIS","KHC","MDLZ",
    # Financials
    "JPM","BAC","WFC","C","GS","MS","AXP","BLK","SCHW","USB",
    "PNC","TFC","COF","BK","SPGI","CME","ICE","MMC","AIG","MET",
    # Healthcare
    "JNJ","UNH","PFE","MRK","ABBV","TMO","ABT","LLY","BMY","AMGN",
    "GILD","CVS","CI","MDT","ISRG","SYK","BDX","ELV","HUM","DHR",
    # Industrials / energy / materials
    "CAT","BA","HON","GE","MMM","UPS","LMT","RTX","DE","EMR",
    "XOM","CVX","COP","SLB","EOG","PSX","VLO","OXY","KMI","WMB",
    "LIN","APD","SHW","FCX","NEM","DOW","NUE","ECL","DD","PPG",
    # Utilities / staples / telecom / REIT
    "NEE","DUK","SO","D","AEP","EXC","SRE","XEL","ED","WEC",
    "T","VZ","TMUS","CHTR","AMT","PLD","CCI","EQIX","SPG","O",
    # Higher-beta / growth / cyclical (more reversion fuel)
    "TSLA","NFLX","PYPL","SQ","SHOP","UBER","ABNB","COIN","ROKU","SNAP",
    "F","GM","DAL","AAL","CCL","RCL","MGM","WYNN","X","CLF",
]

# De-dup while preserving order
_seen = set()
STOCK_UNIVERSE = [s for s in STOCK_UNIVERSE if not (s in _seen or _seen.add(s))]
