import feedparser
import time
import logging
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from config.sources import REDDIT_SUBS
from config.settings import MAX_ARTICLES_PER_SOURCE

logger = logging.getLogger(__name__)

_INJECTION_PATTERNS = [
    "ignore previous instructions",
    "ignore all previous",
    "disregard previous",
    "forget your instructions",
    "new instructions:",
    "system prompt:",
    "you are now",
]


def _sanitize(text: str) -> str:
    lowered = text.lower()
    for pattern in _INJECTION_PATTERNS:
        if pattern in lowered:
            idx = lowered.find(pattern)
            text = text[:idx] + "[REDACTED]"
            lowered = text.lower()
    return text


def _parse_date(entry) -> str:
    try:
        if hasattr(entry, "published"):
            return parsedate_to_datetime(entry.published).isoformat()
    except Exception:
        pass
    return datetime.now(timezone.utc).isoformat()


def fetch_reddit(seen_ids: set[str]) -> list[dict]:
    """
    Reddit now blocks all unauthenticated requests (both JSON API and RSS) with 500 errors.
    Returns empty list gracefully — other sources (RSS feeds, SEC, FRED) provide sufficient coverage.
    OAuth integration would be needed to restore this; deferred until needed.
    """
    print("[Reddit] Skipped — Reddit blocks unauthenticated requests (OAuth required)")
    logger.info("[Reddit] Skipped — unauthenticated access blocked")
    return []
