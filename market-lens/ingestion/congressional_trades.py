"""
Congressional trade ingestion via Quiver Quantitative free API.
Congress members are legally required to disclose trades within 45 days (STOCK Act).
Studies show congressional portfolios significantly outperform the market — they often
trade on non-public policy information. This is one of the highest-alpha free signals.
Free tier: https://api.quiverquant.com (no key needed for basic endpoints).
"""

import requests
import time
import logging
from datetime import datetime, timezone, date, timedelta

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.quiverquant.com/beta/live/congresstrading"
_HEADERS = {
    "User-Agent": "market-lens research tool",
    "Accept": "application/json",
}
_RATE_LIMIT_DELAY = 1.0  # Quiver free tier — be polite


def _get_with_retry(url: str, params: dict = None, retries: int = 3) -> requests.Response:
    backoff = [2, 4, 8]
    last_exc = RuntimeError("No attempts made")
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=_HEADERS, params=params, timeout=15)
            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", backoff[min(attempt, len(backoff)-1)]))
                logger.warning("[Congress] 429 rate limited — waiting %ss", wait)
                time.sleep(wait)
                continue
            if resp.status_code == 401:
                logger.warning("[Congress] 401 — Quiver requires auth for this endpoint")
                return None
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            last_exc = e
            if attempt < retries - 1:
                time.sleep(backoff[min(attempt, len(backoff)-1)])
    raise last_exc


def fetch_congressional_trades(seen_ids: set[str], days_back: int = 14) -> list[dict]:
    """
    Fetches recent congressional stock trades from Quiver Quant.
    Filters to trades from the past days_back days.
    Purchases are especially significant — politicians rarely buy unless confident.
    """
    articles = []
    cutoff = (date.today() - timedelta(days=days_back)).isoformat()

    try:
        time.sleep(_RATE_LIMIT_DELAY)
        resp = _get_with_retry(_BASE_URL)

        if resp is None:
            logger.warning("[Congress] Quiver API unavailable — skipping")
            print("[Congress] Quiver API unavailable — skipping congressional trades")
            return []

        trades = resp.json()
        if not isinstance(trades, list):
            logger.warning("[Congress] Unexpected response format from Quiver")
            return []

        for trade in trades:
            ticker = trade.get("Ticker", "").upper().strip()
            traded_date = trade.get("TransactionDate", "")
            filed_date = trade.get("DisclosureDate", "")
            transaction = trade.get("Transaction", "")  # "Purchase" or "Sale (Full)" etc.
            amount = trade.get("Amount", "")
            representative = trade.get("Representative", "Unknown")
            party = trade.get("Party", "")
            district = trade.get("District", "")
            description = trade.get("Description", "")

            # Skip if too old
            if traded_date and traded_date < cutoff:
                continue

            # Build unique ID
            article_id = f"congress_{ticker}_{representative}_{traded_date}_{transaction}"
            if article_id in seen_ids:
                continue

            if not ticker or len(ticker) > 5 or not ticker.isalpha():
                continue

            is_purchase = "purchase" in transaction.lower()
            is_sale = "sale" in transaction.lower()

            if not is_purchase and not is_sale:
                seen_ids.add(article_id)
                continue

            direction = "PURCHASE" if is_purchase else "SALE"
            # Purchases are stronger signals — politicians rarely buy without reason
            credibility = 9 if is_purchase else 6

            party_str = f" ({party})" if party else ""
            location_str = f", {district}" if district else ""

            summary = (
                f"Congress member {representative}{party_str}{location_str} "
                f"made a {direction} of {ticker} worth {amount}. "
                f"Trade date: {traded_date}. Disclosure date: {filed_date}. "
                f"{description[:200] if description else ''} "
                f"Congressional trades historically outperform market — "
                f"{'buying suggests inside knowledge of favorable policy' if is_purchase else 'selling may signal regulatory headwinds'}."
            )

            articles.append({
                "id": article_id,
                "sector": "macro",
                "source": "Congressional Disclosure (STOCK Act)",
                "title": f"[CONGRESS {direction}] {representative}{party_str} — {ticker} ({amount})",
                "summary": summary,
                "url": f"https://efts.sec.gov/LATEST/search-index?q={ticker}&forms=4",
                "published": datetime.now(timezone.utc).isoformat(),
                "ingested_at": datetime.now(timezone.utc).isoformat(),
                "ticker_hint": ticker,
                "is_congressional_trade": True,
                "is_purchase": is_purchase,
                "credibility_hint": credibility,
            })
            seen_ids.add(article_id)

    except Exception as e:
        logger.warning("[Congress] Failed to fetch congressional trades: %s", e)
        print(f"[Congress] Failed: {e} — skipping congressional trades")
        return []

    print(f"[Congress] Fetched {len(articles)} congressional trades")
    logger.info("[Congress] Fetched %d congressional trades", len(articles))
    return articles
