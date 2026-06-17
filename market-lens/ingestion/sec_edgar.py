import requests
import time
import logging
from datetime import datetime, timezone
from config.sources import SEC_WATCHLIST

logger = logging.getLogger(__name__)

EDGAR_BASE = "https://data.sec.gov/submissions"
HEADERS = {"User-Agent": "market-lens research@personal.com"}  # required by SEC

# SEC EDGAR rate limit: 10 requests/sec. We stay well under with a 0.15s delay.
_SEC_REQUEST_DELAY = 0.15  # seconds between requests
_RETRY_ATTEMPTS = 3
_RETRY_BACKOFF = [1, 2, 4]  # seconds


def _get_with_retry(url: str, headers: dict, timeout: int = 10) -> requests.Response:
    """GET with 3x exponential backoff. Raises on final failure."""
    last_exc: Exception = RuntimeError("No attempts made")
    for attempt in range(_RETRY_ATTEMPTS):
        backoff = _RETRY_BACKOFF[attempt]
        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
            if resp.status_code == 429:
                wait = int(resp.headers.get("Retry-After", backoff))
                logger.warning("[SEC] 429 rate limited on %s — waiting %ss", url, wait)
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < _RETRY_ATTEMPTS - 1:
                logger.warning("[SEC] Attempt %d failed for %s: %s — retrying in %ss",
                               attempt + 1, url, exc, backoff)
                time.sleep(backoff)
    raise last_exc


def fetch_recent_filings(ticker_to_cik: dict[str, str], seen_ids: set[str]) -> list[dict]:
    """
    Fetches recent 8-K and 10-Q filings for all tickers in watchlist.
    - Rate-limited to stay under SEC's 10 req/sec cap.
    - Per-ticker failures are caught and skipped.
    - 3x retry with exponential backoff on network errors.
    ticker_to_cik: preloaded mapping of ticker -> CIK number.
    """
    filings = []

    for sector, tickers in SEC_WATCHLIST.items():
        for ticker in tickers:
            cik = ticker_to_cik.get(ticker)
            if not cik:
                logger.warning("[SEC] No CIK found for ticker %s — skipping", ticker)
                continue

            try:
                url = f"{EDGAR_BASE}/CIK{cik.zfill(10)}.json"
                resp = _get_with_retry(url, HEADERS, timeout=10)
                data = resp.json()

                recent = data.get("filings", {}).get("recent", {})
                forms = recent.get("form", [])
                dates = recent.get("filingDate", [])
                accession_numbers = recent.get("accessionNumber", [])

                for i, form in enumerate(forms[:20]):
                    if form not in ("8-K", "10-Q", "10-K", "S-1"):
                        continue

                    filing_id = accession_numbers[i] if i < len(accession_numbers) else f"{ticker}_{i}"

                    if filing_id in seen_ids:
                        continue

                    # Normalise date to UTC ISO-8601
                    raw_date = dates[i] if i < len(dates) else None
                    published = f"{raw_date}T00:00:00+00:00" if raw_date else datetime.now(timezone.utc).isoformat()

                    filings.append({
                        "id": filing_id,
                        "sector": sector,
                        "ticker": ticker,
                        "source": "SEC EDGAR",
                        "form": form,
                        "title": f"{ticker} {form} filing — {raw_date or 'unknown'}",
                        "summary": f"SEC {form} filing for {ticker}",
                        "url": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type={form}",
                        "published": published,
                        "ingested_at": datetime.now(timezone.utc).isoformat(),
                    })

                    seen_ids.add(filing_id)

                # Respect SEC rate limit between tickers
                time.sleep(_SEC_REQUEST_DELAY)

            except Exception as e:
                # Per-ticker failure MUST NOT crash all SEC ingestion
                logger.warning("[SEC] Failed %s: %s", ticker, e)
                print(f"[SEC] Failed {ticker}: {e}")

    print(f"[SEC] Fetched {len(filings)} new filings")
    logger.info("[SEC] Fetched %d new filings", len(filings))
    return filings


def load_ticker_cik_map() -> dict[str, str]:
    """
    Downloads the full ticker->CIK mapping from SEC.
    Called once at startup. Returns empty dict on failure (pipeline degrades gracefully).
    """
    try:
        resp = _get_with_retry(
            "https://www.sec.gov/files/company_tickers.json",
            HEADERS,
            timeout=15,
        )
        data = resp.json()
        mapping = {v["ticker"]: str(v["cik_str"]) for v in data.values()}
        logger.info("[SEC] Loaded CIK map: %d tickers", len(mapping))
        return mapping
    except Exception as e:
        logger.error("[SEC] Failed to load CIK map: %s", e)
        print(f"[SEC] Failed to load CIK map: {e}")
        return {}
