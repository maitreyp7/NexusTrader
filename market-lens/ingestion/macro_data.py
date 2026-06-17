"""
Macro economic data ingestion via FRED (Federal Reserve Economic Data).
Fetches key macro indicators: Fed Funds Rate, CPI, unemployment, yield curve, GDP.
Free API — requires FRED_API_KEY in .env (free registration at fred.stlouisfed.org).
Falls back gracefully if key missing — just skips macro data enrichment.
"""

import requests
import logging
import time
from datetime import datetime, timezone, date, timedelta

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.stlouisfed.org/fred/series/observations"
_HEADERS = {"User-Agent": "market-lens research tool"}
_RATE_LIMIT_DELAY = 0.5

# FRED series IDs for key macro indicators
_SERIES = {
    "fed_funds_rate":       ("FEDFUNDS",    "Fed Funds Rate (%)", "finance"),
    "cpi_yoy":              ("CPIAUCSL",    "CPI Year-over-Year Inflation", "macro"),
    "unemployment_rate":    ("UNRATE",      "US Unemployment Rate (%)", "macro"),
    "10yr_treasury":        ("GS10",        "10-Year Treasury Yield (%)", "finance"),
    "2yr_treasury":         ("GS2",         "2-Year Treasury Yield (%)", "finance"),
    "gdp_growth":           ("A191RL1Q225SBEA", "US Real GDP Growth Rate (%)", "macro"),
    "consumer_sentiment":   ("UMCSENT",     "U Michigan Consumer Sentiment", "macro"),
    "credit_spread":        ("BAMLH0A0HYM2", "High Yield Credit Spread (%)", "finance"),
}


def _get_latest_value(series_id: str, api_key: str) -> tuple[float | None, str | None]:
    """Fetch the most recent observation for a FRED series."""
    try:
        resp = requests.get(
            _BASE_URL,
            params={
                "series_id": series_id,
                "api_key": api_key,
                "file_type": "json",
                "sort_order": "desc",
                "limit": 2,  # get 2 so we can show change
            },
            headers=_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        observations = data.get("observations", [])
        if not observations:
            return None, None
        latest = observations[0]
        val_str = latest.get("value", ".")
        val = float(val_str) if val_str != "." else None
        return val, latest.get("date")
    except Exception as e:
        logger.warning("[MacroData] Failed series %s: %s", series_id, e)
        return None, None


def fetch_macro_signals(api_key: str, seen_ids: set[str]) -> list[dict]:
    """
    Fetches current macro indicator values from FRED and converts them to
    articles/signals for the pipeline. Each indicator becomes one article
    that Claude can reason about in context with stock signals.
    """
    if not api_key:
        logger.warning("[MacroData] FRED_API_KEY not set — skipping macro data")
        print("[MacroData] No FRED_API_KEY — skipping. Add to .env for macro context.")
        return []

    articles = []
    today = date.today().isoformat()

    # Yield curve inversion check (2s10s spread)
    values = {}

    for key, (series_id, label, sector) in _SERIES.items():
        time.sleep(_RATE_LIMIT_DELAY)
        val, obs_date = _get_latest_value(series_id, api_key)
        if val is not None:
            values[key] = (val, obs_date)

        article_id = f"fred_{series_id}_{obs_date or today}"
        if article_id in seen_ids:
            continue
        if val is None:
            continue

        # Build a human-readable summary for Claude
        summary = f"Latest {label}: {val:.2f}. As of {obs_date}."

        if key == "cpi_yoy" and val > 3.0:
            summary += f" CPI above 3% signals persistent inflation — Fed unlikely to cut rates soon."
        elif key == "cpi_yoy" and val < 2.0:
            summary += f" CPI below 2% — deflationary pressure, rate cuts more likely."

        if key == "fed_funds_rate":
            summary += " Higher rates = headwind for growth stocks, REITs, and leveraged companies."

        if key == "unemployment_rate" and val > 5.0:
            summary += " Rising unemployment typically signals slowing consumer spending."

        if key == "credit_spread" and val > 5.0:
            summary += " Wide credit spreads signal stress in high-yield / junk bond market — risk-off signal."

        articles.append({
            "id": article_id,
            "sector": sector,
            "source": f"FRED ({series_id})",
            "title": f"[MACRO] {label}: {val:.2f} (as of {obs_date})",
            "summary": summary,
            "url": f"https://fred.stlouisfed.org/series/{series_id}",
            "published": datetime.now(timezone.utc).isoformat(),
            "ingested_at": datetime.now(timezone.utc).isoformat(),
            "is_macro": True,
        })
        seen_ids.add(article_id)

    # Yield curve inversion — computed after loop so both 2yr and 10yr are available
    if "10yr_treasury" in values and "2yr_treasury" in values:
        ten_yr, ten_date = values["10yr_treasury"]
        two_yr, _        = values["2yr_treasury"]
        spread = ten_yr - two_yr
        inversion = "INVERTED" if spread < 0 else "normal"
        logger.info("[MacroData] 2s10s spread: %.2f%% (%s)", spread, inversion)
        article_id = f"fred_yield_curve_{ten_date or today}"
        if article_id not in seen_ids:
            summary = (
                f"2s10s yield curve spread: {spread:.2f}% ({inversion}). "
                f"10yr={ten_yr:.2f}%, 2yr={two_yr:.2f}%."
            )
            if spread < 0:
                summary += " Inverted yield curve historically predicts recession within 12-18 months. Risk-off signal for equities."
            else:
                summary += " Normal yield curve — no recession signal from rates."
            articles.append({
                "id": article_id,
                "sector": "finance",
                "source": "FRED (yield curve)",
                "title": f"[MACRO] 2s10s Yield Curve: {spread:.2f}% ({inversion})",
                "summary": summary,
                "url": "https://fred.stlouisfed.org/series/T10Y2Y",
                "published": datetime.now(timezone.utc).isoformat(),
                "ingested_at": datetime.now(timezone.utc).isoformat(),
                "is_macro": True,
            })
            seen_ids.add(article_id)

    print(f"[MacroData] Fetched {len(articles)} macro indicators from FRED")
    logger.info("[MacroData] Fetched %d macro indicators", len(articles))
    return articles
