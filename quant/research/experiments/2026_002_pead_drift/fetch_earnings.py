"""
fetch_earnings.py — Pull ~24yr of earnings dates + EPS surprise for the stock
universe from Yahoo (via yfinance, free) and cache one CSV per ticker.

This is the data that GRAVEYARD.md thought needed a paid feed. Verified 2026-07-06:
get_earnings_dates(limit=100) returns quarterly rows back to ~2001-2002 with
EPS Estimate / Reported EPS / Surprise(%) and a BMO/AMC-resolving timestamp.

Cache: earnings_cache/<SYM>.csv  (columns: ts, eps_est, eps_rep, surprise_pct)
Re-run is incremental — cached tickers are skipped. Delete a file to refetch.
"""
from __future__ import annotations
import os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
_QUANT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, _QUANT)

import pandas as pd
import yfinance as yf
from stock_universe import STOCK_UNIVERSE

CACHE = os.path.join(HERE, "earnings_cache")
os.makedirs(CACHE, exist_ok=True)


def fetch_one(sym: str) -> pd.DataFrame | None:
    t = yf.Ticker(sym)
    df = t.get_earnings_dates(limit=100)  # Yahoo caps at 100 (~25yr of quarters)
    if df is None or df.empty:
        return None
    df = df.rename(columns={
        "EPS Estimate": "eps_est", "Reported EPS": "eps_rep", "Surprise(%)": "surprise_pct",
    })
    df.index.name = "ts"
    return df[["eps_est", "eps_rep", "surprise_pct"]].sort_index()


def main():
    done, failed = 0, []
    for i, sym in enumerate(STOCK_UNIVERSE):
        path = os.path.join(CACHE, f"{sym}.csv")
        if os.path.exists(path):
            done += 1
            continue
        try:
            df = fetch_one(sym)
            if df is None or df.empty:
                failed.append(sym)
                print(f"  [{i+1}/{len(STOCK_UNIVERSE)}] {sym}: EMPTY")
            else:
                df.to_csv(path)
                done += 1
                print(f"  [{i+1}/{len(STOCK_UNIVERSE)}] {sym}: {len(df)} rows "
                      f"({df.index.min().date()} -> {df.index.max().date()})")
        except Exception as e:
            failed.append(sym)
            print(f"  [{i+1}/{len(STOCK_UNIVERSE)}] {sym}: ERR {str(e)[:70]}")
        time.sleep(0.6)  # polite to Yahoo — one full run takes ~2min
    print(f"\nDone: {done} cached, {len(failed)} failed: {failed}")


def load_all() -> dict[str, pd.DataFrame]:
    """Load every cached earnings CSV -> {symbol: DataFrame}."""
    out = {}
    for f in sorted(os.listdir(CACHE)):
        if not f.endswith(".csv"):
            continue
        sym = f[:-4]
        df = pd.read_csv(os.path.join(CACHE, f), index_col="ts", parse_dates=True)
        out[sym] = df
    return out


if __name__ == "__main__":
    main()
