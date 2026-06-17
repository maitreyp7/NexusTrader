"""
SEC Form 4 insider trade ingestion.
Form 4 = insiders (executives, directors, >10% shareholders) reporting trades within 2 days.
Insider buying is one of the strongest leading indicators — insiders only buy when they believe
the stock is undervalued. Insider selling is weaker (many reasons to sell).
Free, no API key. Uses SEC EDGAR full-text search.
"""

import requests
import time
import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, date, timedelta
from config.sources import SEC_WATCHLIST

logger = logging.getLogger(__name__)

_FILING_URL = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=4&dateb=&owner=include&count=40&search_text=&CIK={cik}&output=atom"
_HEADERS = {
    "User-Agent": "market-lens research tool maitrey2007p@gmail.com",
    "Accept-Encoding": "gzip, deflate",
}
_RATE_LIMIT_DELAY = 0.15  # SEC asks for max 10 req/sec

# Build watchlist ticker set once at module load — only fetch Form 4s for tickers we care about.
# The full cik_map from load_ticker_cik_map() has ~10,000 tickers; iterating all of them
# would make thousands of SEC requests, violate rate limits, and take hours.
_WATCHLIST_TICKERS: set[str] = set()
for _tickers in SEC_WATCHLIST.values():
    _WATCHLIST_TICKERS.update(_tickers)


def _get_with_retry(url: str, retries: int = 3, backoff: list = None) -> requests.Response:
    if backoff is None:
        backoff = [1, 2, 4]
    last_exc = RuntimeError("No attempts made")
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=_HEADERS, timeout=15)
            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", backoff[min(attempt, len(backoff)-1)]))
                logger.warning("[InsiderTrades] 429 — waiting %ss", wait)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp
        except requests.RequestException as e:
            last_exc = e
            if attempt < retries - 1:
                time.sleep(backoff[min(attempt, len(backoff)-1)])
    raise last_exc


def fetch_insider_trades(cik_map: dict[str, str], seen_ids: set[str], days_back: int = 3) -> list[dict]:
    """
    Fetches recent Form 4 filings for tickers in SEC_WATCHLIST only.
    Only surfaces NET BUYING transactions (transaction_type P = Purchase).
    Selling is captured but flagged lower credibility.
    days_back: how many calendar days back to look (default 3 to catch weekends).

    IMPORTANT: Only iterates SEC_WATCHLIST tickers (~70 tickers), NOT the full
    cik_map (~10,000 tickers). Iterating all would make thousands of SEC requests.
    """
    articles = []
    start_date = (date.today() - timedelta(days=days_back)).isoformat()
    ns = {"atom": "http://www.w3.org/2005/Atom"}

    for ticker in _WATCHLIST_TICKERS:
        cik = cik_map.get(ticker)
        if not cik:
            logger.debug("[InsiderTrades] No CIK for %s — skipping", ticker)
            continue

        try:
            time.sleep(_RATE_LIMIT_DELAY)
            url = _FILING_URL.format(cik=cik)
            resp = _get_with_retry(url)

            # Parse Atom feed entries
            try:
                root = ET.fromstring(resp.text)
            except ET.ParseError as e:
                logger.warning("[InsiderTrades] XML parse error for %s: %s", ticker, e)
                continue

            entries = root.findall("atom:entry", ns)

            for entry in entries:
                filing_id_el = entry.find("atom:id", ns)
                updated_el = entry.find("atom:updated", ns)
                title_el = entry.find("atom:title", ns)
                summary_el = entry.find("atom:summary", ns)

                if filing_id_el is None or not filing_id_el.text:
                    continue

                filing_id = f"form4_{ticker}_{filing_id_el.text}"
                if filing_id in seen_ids:
                    continue

                # Filter to recent filings only
                updated_str = (updated_el.text or "") if updated_el is not None else ""
                if updated_str:
                    try:
                        filing_date = updated_str[:10]
                        if filing_date < start_date:
                            continue
                    except Exception:
                        pass

                title = title_el.text if title_el is not None else f"Form 4 — {ticker}"
                summary_raw = (summary_el.text or "") if summary_el is not None else ""

                # Determine buy vs sell from summary text
                summary_lower = summary_raw.lower()
                is_purchase = "purchase" in summary_lower or "acqui" in summary_lower
                is_sale = "sale" in summary_lower or "dispos" in summary_lower

                if not is_purchase and not is_sale:
                    seen_ids.add(filing_id)
                    continue

                direction_label = "BUY (insider purchase)" if is_purchase else "SELL (insider disposal)"
                # Insider buying = strong signal; selling = weak/noisy signal
                credibility = 9 if is_purchase else 5

                articles.append({
                    "id": filing_id,
                    "sector": _ticker_sector(ticker),
                    "source": "SEC Form 4 (Insider Trade)",
                    "title": f"[INSIDER {direction_label.upper()}] {ticker}: {title}",
                    "summary": (
                        f"Insider transaction for {ticker}. {direction_label}. "
                        f"Filed: {updated_str[:10]}. Detail: {summary_raw[:300]}"
                    ),
                    "url": filing_id_el.text or "",
                    "published": updated_str or datetime.now(timezone.utc).isoformat(),
                    "ingested_at": datetime.now(timezone.utc).isoformat(),
                    "ticker_hint": ticker,
                    "is_insider_buy": is_purchase,
                    "credibility_hint": credibility,
                })
                seen_ids.add(filing_id)

        except Exception as e:
            logger.warning("[InsiderTrades] Failed %s: %s", ticker, e)

    print(f"[InsiderTrades] Fetched {len(articles)} Form 4 filings")
    logger.info("[InsiderTrades] Fetched %d Form 4 filings", len(articles))
    return articles


# Map tickers to their sector from SEC_WATCHLIST
_SECTOR_MAP: dict[str, str] = {}

def _ticker_sector(ticker: str) -> str:
    if not _SECTOR_MAP:
        for sector, tickers in SEC_WATCHLIST.items():
            for t in tickers:
                _SECTOR_MAP[t] = sector
    return _SECTOR_MAP.get(ticker.upper(), "macro")
