"""
Options flow scanner — detects unusual options activity on tickers from signals.json.
Uses yfinance (free, no API key) to pull live options chains.

Unusual = volume >> open interest, meaning traders opened large new positions today
rather than closing existing ones. This is how smart money shows up before a move.
"""

import logging
import time
from datetime import datetime, timezone, date
from typing import Optional
import yfinance as yf

from config import (
    MIN_VOLUME_OI_RATIO, MIN_OPTION_VOLUME,
    MIN_PREMIUM, TOP_N_TICKERS,
)

logger = logging.getLogger(__name__)


def _score_contract(row: dict, ticker: str, option_type: str, expiry: str) -> Optional[dict]:
    """
    Score a single options contract for unusual activity.
    Returns a signal dict if it meets thresholds, else None.
    """
    def _safe(val, default=0):
        try:
            v = float(val)
            return default if v != v else v  # NaN check
        except (TypeError, ValueError):
            return default

    volume = _safe(row.get("volume"), 0)
    oi     = _safe(row.get("openInterest"), 0)
    price  = _safe(row.get("lastPrice"), 0)
    strike = _safe(row.get("strike"), 0)
    iv     = _safe(row.get("impliedVolatility"), 0)

    if volume < MIN_OPTION_VOLUME:
        return None

    premium = price * volume * 100  # total dollar premium
    if premium < MIN_PREMIUM:
        return None

    vol_oi_ratio = volume / oi if oi > 0 else volume  # oi=0 means brand-new position

    if oi > 0 and vol_oi_ratio < MIN_VOLUME_OI_RATIO:
        return None

    # Sentiment: calls = bullish, puts = bearish
    sentiment = "bullish" if option_type == "call" else "bearish"

    # Days to expiry
    try:
        exp_date = datetime.strptime(expiry, "%Y-%m-%d").date()
        dte      = (exp_date - date.today()).days
    except Exception:
        dte = None

    return {
        "ticker":        ticker,
        "option_type":   option_type,
        "strike":        strike,
        "expiry":        expiry,
        "dte":           dte,
        "volume":        int(volume),
        "open_interest": int(oi),
        "vol_oi_ratio":  round(vol_oi_ratio, 2),
        "premium":       round(premium, 0),
        "last_price":    price,
        "iv":            round(iv * 100, 1),  # as percentage
        "sentiment":     sentiment,
    }


def scan_ticker(ticker: str) -> list[dict]:
    """
    Scan all options chains for a ticker and return unusual contracts.
    """
    unusual = []
    try:
        tk      = yf.Ticker(ticker)
        expiries = tk.options
        if not expiries:
            logger.warning("[Scanner] No options data for %s", ticker)
            return []

        # Scan next 3 expiries — near-term options carry the most signal
        for expiry in expiries[:3]:
            try:
                chain = tk.option_chain(expiry)
            except Exception as e:
                logger.warning("[Scanner] %s expiry %s failed: %s", ticker, expiry, e)
                continue

            for opt_type, df in [("call", chain.calls), ("put", chain.puts)]:
                for _, row in df.iterrows():
                    sig = _score_contract(row.to_dict(), ticker, opt_type, expiry)
                    if sig:
                        unusual.append(sig)

    except Exception as e:
        logger.error("[Scanner] Error scanning %s: %s", ticker, e)

    return unusual


def scan_tickers(tickers: list[str]) -> list[dict]:
    """
    Scan a list of tickers and return all unusual options activity,
    sorted by total premium descending (biggest bets first).
    """
    all_signals = []
    for i, ticker in enumerate(tickers):
        logger.info("[Scanner] Scanning %s (%d/%d)...", ticker, i + 1, len(tickers))
        signals = scan_ticker(ticker)
        if signals:
            print(f"  {ticker}: {len(signals)} unusual contract(s)")
            all_signals.extend(signals)
        # Brief pause to avoid rate limiting
        if i < len(tickers) - 1:
            time.sleep(0.5)

    all_signals.sort(key=lambda x: x["premium"], reverse=True)
    return all_signals


def summarize_by_ticker(signals: list[dict]) -> list[dict]:
    """
    Collapse per-contract signals into per-ticker summaries.
    Determines overall sentiment (bullish/bearish/mixed) per ticker.
    """
    by_ticker: dict[str, dict] = {}

    for s in signals:
        ticker = s["ticker"]
        if ticker not in by_ticker:
            by_ticker[ticker] = {
                "ticker":         ticker,
                "call_premium":   0,
                "put_premium":    0,
                "call_volume":    0,
                "put_volume":     0,
                "unusual_contracts": 0,
                "top_contracts":  [],
            }
        t = by_ticker[ticker]
        if s["option_type"] == "call":
            t["call_premium"] += s["premium"]
            t["call_volume"]  += s["volume"]
        else:
            t["put_premium"] += s["premium"]
            t["put_volume"]  += s["volume"]
        t["unusual_contracts"] += 1
        if len(t["top_contracts"]) < 3:
            t["top_contracts"].append(s)

    summaries = []
    for ticker, t in by_ticker.items():
        total_premium = t["call_premium"] + t["put_premium"]
        call_ratio    = t["call_premium"] / total_premium if total_premium > 0 else 0.5

        if call_ratio >= 0.65:
            sentiment = "bullish"
        elif call_ratio <= 0.35:
            sentiment = "bearish"
        else:
            sentiment = "mixed"

        summaries.append({
            "ticker":             ticker,
            "sentiment":          sentiment,
            "call_put_ratio":     round(call_ratio, 2),
            "total_premium":      round(total_premium, 0),
            "call_premium":       round(t["call_premium"], 0),
            "put_premium":        round(t["put_premium"], 0),
            "unusual_contracts":  t["unusual_contracts"],
            "top_contracts":      t["top_contracts"],
        })

    summaries.sort(key=lambda x: x["total_premium"], reverse=True)
    return summaries
