import feedparser
import hashlib
import socket
import time
import logging
from datetime import datetime, timezone
from config.sources import RSS_FEEDS
from config.settings import MAX_ARTICLES_PER_SOURCE

# feedparser has no native timeout parameter. We set a global socket timeout
# before each parse call so a hung feed never blocks the whole pipeline.
_FEED_TIMEOUT_SECS = 15

logger = logging.getLogger(__name__)

# Prompt injection keywords to strip from content before sending to Claude
_INJECTION_PATTERNS = [
    "ignore previous instructions",
    "ignore all previous",
    "disregard previous",
    "forget your instructions",
    "new instructions:",
    "system prompt:",
    "you are now",
]


def _article_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def _sanitize(text: str) -> str:
    """Strip prompt-injection attempts from scraped content."""
    lowered = text.lower()
    for pattern in _INJECTION_PATTERNS:
        if pattern in lowered:
            idx = lowered.find(pattern)
            text = text[:idx] + "[REDACTED]"
            lowered = text.lower()
    return text


def _normalize_published(entry) -> str:
    """Return a UTC ISO-8601 string regardless of feed timezone format."""
    # feedparser gives parsed_time as a time.struct_time in UTC
    if hasattr(entry, "published_parsed") and entry.published_parsed:
        try:
            dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
            return dt.isoformat()
        except Exception:
            pass
    return datetime.now(timezone.utc).isoformat()


def fetch_rss(seen_ids: set[str]) -> list[dict]:
    """
    Fetches all RSS feeds, deduplicates against seen_ids.
    - Per-feed failures are caught and skipped (never crash all ingestion).
    - feedparser has its own internal timeout; we pass socket_timeout.
    - Empty title/URL/summary articles are skipped (saves Claude tokens).
    - Published dates are normalised to UTC ISO-8601.
    - Content is sanitised against prompt injection before storage.
    Returns list of article dicts.
    """
    articles = []

    for sector, feeds in RSS_FEEDS.items():
        for feed_url in feeds:
            try:
                # feedparser has no native timeout parameter — use socket.setdefaulttimeout()
                # to prevent a hung feed from blocking the entire pipeline.
                prev_timeout = socket.getdefaulttimeout()
                socket.setdefaulttimeout(_FEED_TIMEOUT_SECS)
                try:
                    parsed = feedparser.parse(feed_url, request_headers={"Connection": "close"})
                finally:
                    socket.setdefaulttimeout(prev_timeout)  # always restore previous timeout

                # feedparser returns status 0 on network errors
                if hasattr(parsed, "status") and parsed.status not in (200, 301, 302):
                    logger.warning("[RSS] Non-200 status %s for %s", parsed.status, feed_url)

                count = 0
                for entry in parsed.entries:
                    if count >= MAX_ARTICLES_PER_SOURCE:
                        break

                    url = entry.get("link", "").strip()
                    title = entry.get("title", "").strip()
                    summary = entry.get("summary", "").strip()

                    # Skip empty/useless articles — they waste Claude tokens
                    if not url or not title:
                        continue

                    article_id = _article_id(url)
                    if article_id in seen_ids:
                        continue

                    # Sanitize against prompt injection
                    title = _sanitize(title)
                    summary = _sanitize(summary)

                    articles.append({
                        "id": article_id,
                        "sector": sector,
                        "source": parsed.feed.get("title", feed_url),
                        "title": title,
                        "summary": summary,
                        "url": url,
                        "published": _normalize_published(entry),
                        "ingested_at": datetime.now(timezone.utc).isoformat(),
                    })

                    seen_ids.add(article_id)
                    count += 1

            except Exception as e:
                # One feed failure MUST NOT crash all ingestion
                logger.warning("[RSS] Failed %s: %s", feed_url, e)
                print(f"[RSS] Failed {feed_url}: {e}")

    print(f"[RSS] Fetched {len(articles)} new articles")
    logger.info("[RSS] Fetched %d new articles", len(articles))
    return articles
