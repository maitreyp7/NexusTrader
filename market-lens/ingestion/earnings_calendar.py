"""
Earnings calendar ingestion via yfinance.
Fetches upcoming earnings dates for all watchlist tickers for the next 7 days.
Knowing earnings are coming = one of the most actionable signals we have.
A stock about to report earnings has binary risk/reward — Claude can reason on
whether to be long or short into the print based on other signals.
Free, no API key. Uses yfinance.
"""

import logging
import time
from datetime import datetime, timezone, date, timedelta

logger = logging.getLogger(__name__)

_RATE_LIMIT_DELAY = 0.3  # yfinance is rate-limited — be polite


def fetch_earnings_calendar(tickers: list[str], seen_ids: set[str], days_ahead: int = 7) -> list[dict]:
    """
    Checks each ticker for upcoming earnings within days_ahead days.
    Returns one article per upcoming earnings event — these become high-priority
    signals for Claude to reason about.
    """
    try:
        import yfinance as yf
    except ImportError:
        logger.warning("[Earnings] yfinance not installed — skipping earnings calendar")
        print("[Earnings] yfinance not installed. Run: pip install yfinance")
        return []

    if not tickers:
        return []

    articles = []
    today = date.today()
    cutoff = today + timedelta(days=days_ahead)
    unique = list(set(t.upper() for t in tickers if t and isinstance(t, str)))

    for ticker in unique:
        try:
            time.sleep(_RATE_LIMIT_DELAY)
            tk = yf.Ticker(ticker)
            info = tk.info or {}

            earnings_date = None

            # yfinance returns earnings date in multiple places depending on ticker
            raw = info.get("earningsTimestamp") or info.get("earningsDate")
            if raw:
                if isinstance(raw, (int, float)):
                    earnings_date = date.fromtimestamp(raw)
                elif isinstance(raw, str):
                    try:
                        earnings_date = date.fromisoformat(raw[:10])
                    except ValueError:
                        pass

            # Also check the calendar object
            if earnings_date is None:
                try:
                    cal = tk.calendar
                    if cal is not None and not cal.empty:
                        # calendar is a DataFrame with dates as columns
                        ed = cal.columns[0] if hasattr(cal, 'columns') and len(cal.columns) > 0 else None
                        if ed is not None:
                            earnings_date = pd_to_date(ed)
                except Exception:
                    pass

            if earnings_date is None:
                continue

            # Only include if within our window
            if not (today <= earnings_date <= cutoff):
                continue

            days_until = (earnings_date - today).days
            article_id = f"earnings_{ticker}_{earnings_date.isoformat()}"

            if article_id in seen_ids:
                continue

            company = info.get("shortName", ticker)
            current_price = info.get("currentPrice") or info.get("regularMarketPrice")
            pe_ratio = info.get("trailingPE")
            eps_estimate = info.get("epsCurrentYear") or info.get("epsForward")
            revenue_estimate = info.get("revenueEstimate") or info.get("totalRevenue")
            analyst_count = info.get("numberOfAnalystOpinions", 0)
            recommendation = info.get("recommendationKey", "")

            # Build urgency label
            if days_until == 0:
                urgency = "TODAY"
            elif days_until == 1:
                urgency = "TOMORROW"
            else:
                urgency = f"IN {days_until} DAYS"

            price_str = f"${current_price:.2f}" if current_price else "N/A"
            pe_str = f"P/E {pe_ratio:.1f}" if pe_ratio else ""
            eps_str = f"EPS estimate: ${eps_estimate:.2f}" if eps_estimate else ""
            analyst_str = f"{analyst_count} analysts, consensus: {recommendation}" if analyst_count else ""

            summary = (
                f"{company} ({ticker}) reports earnings {urgency} on {earnings_date}. "
                f"Current price: {price_str}. {pe_str}. {eps_str}. {analyst_str}. "
                f"Earnings reports are binary events — a beat typically causes +5-15% move, "
                f"a miss causes -5-20% move. Implied volatility is likely elevated. "
                f"Assess whether other signals suggest beat or miss. "
                f"Consider whether to be long, short, or flat into the print."
            )

            articles.append({
                "id": article_id,
                "sector": _ticker_sector(ticker),
                "source": "Earnings Calendar (yfinance)",
                "title": f"[EARNINGS {urgency}] {ticker} — {company} reports {earnings_date}",
                "summary": summary,
                "url": f"https://finance.yahoo.com/quote/{ticker}/",
                "published": datetime.now(timezone.utc).isoformat(),
                "ingested_at": datetime.now(timezone.utc).isoformat(),
                "ticker_hint": ticker,
                "earnings_date": earnings_date.isoformat(),
                "days_until_earnings": days_until,
                "is_earnings_event": True,
                "credibility_hint": 10,  # earnings dates are facts, not opinions
            })
            seen_ids.add(article_id)

            logger.info("[Earnings] %s reports %s (%s)", ticker, earnings_date, urgency)

        except Exception as e:
            logger.warning("[Earnings] Failed %s: %s", ticker, e)

    print(f"[Earnings] Found {len(articles)} upcoming earnings events in next {days_ahead} days")
    logger.info("[Earnings] Found %d upcoming earnings events", len(articles))
    return articles


def pd_to_date(val) -> "date | None":
    """Convert a pandas Timestamp or datetime to a plain date safely."""
    try:
        if hasattr(val, "date"):
            return val.date()
        if hasattr(val, "year"):
            return date(val.year, val.month, val.day)
        return None
    except Exception:
        return None


_SECTOR_MAP: dict[str, str] = {}

def _ticker_sector(ticker: str) -> str:
    if not _SECTOR_MAP:
        try:
            from config.sources import SEC_WATCHLIST
            for sector, tickers in SEC_WATCHLIST.items():
                for t in tickers:
                    _SECTOR_MAP[t] = sector
        except Exception:
            pass
    return _SECTOR_MAP.get(ticker.upper(), "macro")
