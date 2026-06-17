"""
Alternative data signal collectors for earnings prediction.
Each collector returns a signal dict with direction, strength, and source.
"""

import logging
import time
import json
import os
import requests
from datetime import datetime, date, timedelta
from pathlib import Path
from config import CACHE_DIR, APP_STORE_TICKERS, TRENDS_KEYWORDS

logger = logging.getLogger(__name__)
os.makedirs(CACHE_DIR, exist_ok=True)


# ─────────────────────────────────────────────────────────────
# Google Trends — search interest as demand proxy
# ─────────────────────────────────────────────────────────────

def get_trends_signal(ticker: str) -> dict | None:
    """
    Uses pytrends to get 90-day Google Trends data.
    Compares last 2 weeks vs prior 4 weeks — rising = bullish.
    """
    keyword = TRENDS_KEYWORDS.get(ticker)
    if not keyword:
        return None

    try:
        from pytrends.request import TrendReq
        pt = TrendReq(hl="en-US", tz=360, timeout=(10, 30))
        pt.build_payload([keyword], timeframe="today 3-m")
        df = pt.interest_over_time()

        if df.empty or keyword not in df.columns:
            return None

        values   = df[keyword].tolist()
        recent   = values[-14:]   # last 2 weeks
        baseline = values[-42:-14] # prior 4 weeks

        if not recent or not baseline:
            return None

        avg_recent   = sum(recent)   / len(recent)
        avg_baseline = sum(baseline) / len(baseline)

        if avg_baseline == 0:
            return None

        change_pct = (avg_recent - avg_baseline) / avg_baseline * 100
        strength   = min(10, max(1, int(abs(change_pct) / 10)))
        direction  = "bullish" if change_pct > 5 else "bearish" if change_pct < -5 else "neutral"

        return {
            "source":     "google_trends",
            "keyword":    keyword,
            "direction":  direction,
            "strength":   strength,
            "change_pct": round(change_pct, 1),
            "detail":     f"Search interest {change_pct:+.1f}% vs prior 4 weeks",
        }

    except Exception as e:
        logger.warning("[Trends] %s failed: %s", ticker, e)
        return None


# ─────────────────────────────────────────────────────────────
# App Store rankings — consumer engagement proxy
# ─────────────────────────────────────────────────────────────

def get_app_store_signal(ticker: str) -> dict | None:
    """
    Scrapes current App Store rank for consumer apps.
    Compares against cached rank from last week.
    """
    app_id = APP_STORE_TICKERS.get(ticker)
    if not app_id:
        return None

    cache_file = CACHE_DIR / f"appstore_{ticker}.json"

    try:
        # iTunes Search API — free, no key needed
        url = f"https://itunes.apple.com/search?term={app_id}&entity=software&limit=1&country=us"
        r   = requests.get(url, timeout=10)
        r.raise_for_status()
        results = r.json().get("results", [])
        if not results:
            return None

        app       = results[0]
        rating    = float(app.get("averageUserRating", 0))
        rating_ct = int(app.get("userRatingCount", 0))

        # Load cached data
        cached_rating = None
        if cache_file.exists():
            try:
                cached = json.loads(cache_file.read_text())
                cached_rating = cached.get("rating")
                cached_date   = cached.get("date", "")
                days_old = (date.today() - date.fromisoformat(cached_date)).days if cached_date else 99
            except Exception:
                days_old = 99
        else:
            days_old = 99

        # Save current rating
        cache_file.write_text(json.dumps({
            "rating": rating,
            "rating_count": rating_ct,
            "date": date.today().isoformat(),
        }))

        if cached_rating is None or days_old > 30:
            return {
                "source":    "app_store",
                "direction": "neutral",
                "strength":  3,
                "detail":    f"App rating: {rating:.1f} ({rating_ct:,} reviews) — no prior data to compare",
            }

        change = rating - cached_rating
        direction = "bullish" if change > 0.1 else "bearish" if change < -0.1 else "neutral"
        strength  = min(10, max(1, int(abs(change) * 20)))

        return {
            "source":    "app_store",
            "direction": direction,
            "strength":  strength,
            "change":    round(change, 2),
            "detail":    f"App rating {cached_rating:.1f} → {rating:.1f} ({change:+.2f}) over {days_old}d",
        }

    except Exception as e:
        logger.warning("[AppStore] %s failed: %s", ticker, e)
        return None


# ─────────────────────────────────────────────────────────────
# Analyst recommendations — upgrade/downgrade momentum via yfinance
# ─────────────────────────────────────────────────────────────

def get_hiring_signal(ticker: str, company_name: str) -> dict | None:
    """
    Uses yfinance analyst recommendations to gauge Wall Street sentiment.
    Reads the current-month aggregate buy/hold/sell counts.
    Replaces the Indeed RSS scraper (which is now blocked).
    """
    try:
        import yfinance as yf
        tk   = yf.Ticker(ticker)
        recs = tk.recommendations

        if recs is None or recs.empty:
            return None

        # Current month row (period == '0m')
        row = recs[recs["period"] == "0m"]
        if row.empty:
            row = recs.iloc[[0]]  # fall back to most recent

        r = row.iloc[0]
        strong_buy  = int(r.get("strongBuy",  0))
        buy         = int(r.get("buy",        0))
        hold        = int(r.get("hold",       0))
        sell        = int(r.get("sell",       0))
        strong_sell = int(r.get("strongSell", 0))

        bull  = strong_buy + buy
        bear  = sell + strong_sell
        total = bull + hold + bear

        if total == 0:
            return None

        bull_pct = bull / total
        bear_pct = bear / total

        if bull_pct >= 0.6:
            direction = "bullish"
            strength  = min(10, max(3, int(bull_pct * 10)))
        elif bear_pct >= 0.4:
            direction = "bearish"
            strength  = min(10, max(3, int(bear_pct * 10)))
        else:
            direction = "neutral"
            strength  = 3

        return {
            "source":    "analyst_recommendations",
            "direction": direction,
            "strength":  strength,
            "detail":    f"Analysts: {bull} buy / {hold} hold / {bear} sell (this month)",
        }

    except Exception as e:
        logger.warning("[Analyst] %s failed: %s", ticker, e)
        return None


# ─────────────────────────────────────────────────────────────
# Earnings date — via yfinance calendar
# ─────────────────────────────────────────────────────────────

def get_earnings_date(ticker: str) -> date | None:
    """Returns next earnings date for a ticker, or None if unknown."""
    try:
        import yfinance as yf
        tk   = yf.Ticker(ticker)
        cal  = tk.calendar
        if cal is None:
            return None
        # calendar is a dict with 'Earnings Date' as a list
        dates = cal.get("Earnings Date", [])
        if not dates:
            return None
        # Return the nearest future date
        today = date.today()
        future = [d.date() if hasattr(d, 'date') else d for d in dates if (d.date() if hasattr(d, 'date') else d) >= today]
        return min(future) if future else None
    except Exception as e:
        logger.warning("[EarningsDate] %s failed: %s", ticker, e)
        return None
