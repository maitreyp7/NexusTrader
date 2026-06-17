"""
Price context ingestion via yfinance.
Fetches current price, volume, 52-week range, P/E, market cap for all watchlist tickers.
This data is attached to signals before Claude sees them — grounds reasoning in real numbers.
No API key required. Free.
"""

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_RETRY_ATTEMPTS = 3


def _safe_round(val, digits=2):
    try:
        return round(float(val), digits) if val is not None else None
    except (TypeError, ValueError):
        return None


def fetch_price_context(tickers: list[str]) -> dict[str, dict]:
    """
    Returns a dict of ticker -> price context dict.
    Falls back gracefully per ticker — one bad ticker never kills the batch.
    Skips yfinance entirely if not installed (returns empty dict).
    """
    try:
        import yfinance as yf
    except ImportError:
        logger.warning("[PriceData] yfinance not installed — skipping price context")
        print("[PriceData] yfinance not installed. Run: pip install yfinance")
        return {}

    if not tickers:
        return {}

    context = {}
    unique = list(set(t.upper() for t in tickers if t and isinstance(t, str)))

    for ticker in unique:
        try:
            tk = yf.Ticker(ticker)
            info = tk.info or {}

            current_price = info.get("currentPrice") or info.get("regularMarketPrice")
            week_high = info.get("fiftyTwoWeekHigh")
            week_low = info.get("fiftyTwoWeekLow")
            avg_volume = info.get("averageVolume")
            volume = info.get("regularMarketVolume") or info.get("volume")
            pe_ratio = info.get("trailingPE") or info.get("forwardPE")
            market_cap = info.get("marketCap")
            sector = info.get("sector", "")
            short_name = info.get("shortName", ticker)

            # Volume spike: today's volume vs 30-day average
            volume_ratio = None
            if volume and avg_volume and avg_volume > 0:
                volume_ratio = _safe_round(volume / avg_volume, 2)

            # % below 52-week high (negative = below, positive impossible)
            pct_from_high = None
            if current_price and week_high and week_high > 0:
                pct_from_high = _safe_round((current_price - week_high) / week_high * 100, 1)

            context[ticker] = {
                "ticker": ticker,
                "name": short_name,
                "price": _safe_round(current_price),
                "week_52_high": _safe_round(week_high),
                "week_52_low": _safe_round(week_low),
                "pct_from_52w_high": pct_from_high,
                "volume_today": volume,
                "volume_30d_avg": avg_volume,
                "volume_ratio": volume_ratio,  # >2.0 = unusual volume spike
                "pe_ratio": _safe_round(pe_ratio, 1),
                "market_cap_b": _safe_round(market_cap / 1e9, 2) if market_cap else None,
                "sector": sector,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }

            price_str = f"${current_price:.2f}" if current_price is not None else "price=N/A"
            high_str = f"{pct_from_high:.1f}% from 52w high" if pct_from_high is not None else "high=N/A"
            vol_str = f"vol {volume_ratio:.1f}x avg" if volume_ratio is not None else "vol=N/A"
            logger.info("[PriceData] %s: %s (%s, %s)", ticker, price_str, high_str, vol_str)

        except Exception as e:
            logger.warning("[PriceData] Failed to fetch %s: %s", ticker, e)

    print(f"[PriceData] Fetched price context for {len(context)}/{len(unique)} tickers")
    logger.info("[PriceData] Fetched %d/%d tickers", len(context), len(unique))
    return context


def enrich_signals_with_price(signals: list[dict], price_ctx: dict[str, dict]) -> list[dict]:
    """
    Attaches price context to each signal that has a known ticker.
    Signals without a ticker or without price data are passed through unchanged.
    """
    enriched = 0
    for sig in signals:
        ticker = sig.get("ticker")
        if ticker and ticker in price_ctx:
            sig["price_context"] = price_ctx[ticker]
            enriched += 1
    logger.info("[PriceData] Enriched %d/%d signals with price context", enriched, len(signals))
    return signals
