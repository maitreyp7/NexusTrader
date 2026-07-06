"""
run_pead.py — Validate the PEAD strategy end-to-end through the gatekeeper.

Standard research-OS flow (same as low-vol): build panels, get live-bot return
streams for the redundancy check, run_experiment() with a hold_days stability
sweep. Writes report.md + results.json into this folder.
"""
from __future__ import annotations
import sys, os, warnings
warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(os.path.dirname(HERE))
_QUANT = os.path.dirname(RESEARCH)
sys.path.insert(0, RESEARCH)
sys.path.insert(0, _QUANT)
sys.path.insert(0, os.path.join(_QUANT, "strategies"))
sys.path.insert(0, HERE)

from data import get_universe, ALL_SYMBOLS, CRYPTO_UNIVERSE
from engine import build_price_panel
from stock_universe import STOCK_UNIVERSE
import research_manager as rm
from lib.similarity import live_bot_returns
import pead
from fetch_earnings import load_all


def main():
    print("Loading earnings cache...")
    earnings = load_all()
    print(f"  {len(earnings)} tickers with earnings history")

    print("Building price panels...")
    stk = build_price_panel(get_universe(STOCK_UNIVERSE)).ffill()
    etf = build_price_panel(get_universe(sorted(set(ALL_SYMBOLS) | set(CRYPTO_UNIVERSE)))).ffill()

    # Earnings coverage starts ~2001-2002; trim so empty early years don't dilute stats.
    start = min(df.index.min() for df in earnings.values()).tz_localize(None).normalize()
    stk = stk[stk.index >= start]
    etf = etf[etf.index >= start]
    print(f"  panel trimmed to {stk.index[0].date()} -> {stk.index[-1].date()}")

    print("Building live-bot return streams (redundancy check)...")
    existing = live_bot_returns(etf, stk)

    print("Running gatekeeper validation...")
    rm.run_experiment(
        HERE, pead.strategy, stk,
        existing_returns=existing,
        stability_param=("hold_days", [5, 10, 15, 20, 25, 30],
                         dict(earnings=earnings, min_surprise=0.0, min_react=0.02,
                              max_weight=0.10)),
        name="PEAD drift (long-only, surprise beat + positive reaction)",
        earnings=earnings, hold_days=20, min_surprise=0.0, min_react=0.02,
        max_weight=0.10,
    )


if __name__ == "__main__":
    main()
