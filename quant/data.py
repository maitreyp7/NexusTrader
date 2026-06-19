"""
data.py — Daily-bar data fetcher for the backtest harness.

Source: Yahoo Finance chart API (free, no key). Alpaca's daily history only goes
back to 2016 (ETFs) / 2021 (crypto) — too short to validate trend strategies that
need 15-20+ years across multiple market regimes (2008 GFC, dot-com, COVID).
Yahoo gives us 20-33yr for ETFs and 8-12yr for crypto.

We VALIDATE on this long history; we'd TRADE live on Alpaca (which only needs
recent data). Data source != execution source.

Everything is cached to quant/data_cache/<symbol>.csv so we fetch each symbol
once. Re-fetch by deleting the cache file or passing force=True.
"""

from __future__ import annotations
import os
import time
import json
import urllib.request
import datetime as dt
import pandas as pd

CACHE_DIR = os.path.join(os.path.dirname(__file__), "data_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

# The trend-following universe (ETFs) + crypto, per STRATEGY_SPEC.md.
# Yahoo tickers. Crypto uses the -USD suffix.
UNIVERSE = {
    "equity":      ["SPY", "QQQ", "IWM", "EFA", "EEM"],
    "bonds":       ["TLT", "IEF"],
    "commodities": ["DBC", "GLD", "USO"],
    "fx":          ["UUP"],
    "crypto":      ["BTC-USD", "ETH-USD"],
}
ALL_SYMBOLS = [s for group in UNIVERSE.values() for s in group]


def _yahoo_url(symbol: str) -> str:
    # period1=0 → from epoch (Yahoo clamps to the symbol's actual start).
    return (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1=0&period2=9999999999&interval=1d"
    )


def _fetch_yahoo(symbol: str) -> pd.DataFrame:
    """Fetch full daily history for one symbol from Yahoo. Returns OHLCV DataFrame
    indexed by date (UTC date). Raises on failure."""
    req = urllib.request.Request(_yahoo_url(symbol), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = json.load(resp)

    result = raw["chart"]["result"][0]
    ts = result["timestamp"]
    q = result["indicators"]["quote"][0]
    # adjclose for total-return accuracy (dividends/splits) when available
    adj = result["indicators"].get("adjclose", [{}])[0].get("adjclose")

    df = pd.DataFrame({
        "open":  q["open"],
        "high":  q["high"],
        "low":   q["low"],
        "close": q["close"],
        "volume": q["volume"],
    }, index=pd.to_datetime([dt.datetime.fromtimestamp(t, dt.UTC).date() for t in ts]))
    if adj is not None:
        df["adjclose"] = adj
    else:
        df["adjclose"] = df["close"]

    # Drop rows where close is missing (Yahoo sometimes returns null gaps)
    df = df.dropna(subset=["close"]).copy()
    df.index.name = "date"
    return df


def get_bars(symbol: str, force: bool = False) -> pd.DataFrame:
    """Get daily bars for a symbol, using disk cache. Fetches from Yahoo if not
    cached (or force=True)."""
    path = os.path.join(CACHE_DIR, f"{symbol.replace('/', '-')}.csv")
    if os.path.exists(path) and not force:
        df = pd.read_csv(path, index_col="date", parse_dates=True)
        return df
    df = _fetch_yahoo(symbol)
    df.to_csv(path)
    return df


def get_universe(symbols: list[str] | None = None, force: bool = False) -> dict[str, pd.DataFrame]:
    """Fetch (cached) bars for the whole universe. Returns {symbol: DataFrame}."""
    symbols = symbols or ALL_SYMBOLS
    out = {}
    for s in symbols:
        try:
            out[s] = get_bars(s, force=force)
        except Exception as e:
            print(f"  [data] WARN: failed to fetch {s}: {str(e)[:80]}")
        # be polite to Yahoo when fetching fresh
        if force or not os.path.exists(os.path.join(CACHE_DIR, f"{s.replace('/', '-')}.csv")):
            time.sleep(0.3)
    return out


if __name__ == "__main__":
    # Self-test: fetch the universe and print depth per symbol.
    print("Fetching universe from Yahoo (cached after first run)...\n")
    bars = get_universe(force=True)
    print(f"{'symbol':10} {'first':12} {'last':12} {'bars':>7}  {'years':>6}")
    print("-" * 50)
    for s in ALL_SYMBOLS:
        if s not in bars:
            print(f"{s:10} MISSING")
            continue
        df = bars[s]
        first, last = df.index[0].date(), df.index[-1].date()
        yrs = round((df.index[-1] - df.index[0]).days / 365.25, 1)
        print(f"{s:10} {str(first):12} {str(last):12} {len(df):7}  {yrs:6}")
