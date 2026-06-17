"""
market-lens — daily pipeline entry point

Commands:
  python main.py              # full pipeline (production — costs API credits)
  python main.py --ingest     # ingest only, save cache, no Claude, no cost
  python main.py --cached     # use cached articles, run Claude + SMS (cheap re-test)
  python main.py --dry-run    # use cached articles, skip SMS (free debug)
"""

import sys
import json
import os
import logging
import logging.handlers
import fcntl
import tempfile
from datetime import datetime, timezone, date

from ingestion.rss import fetch_rss
from ingestion.sec_edgar import fetch_recent_filings, load_ticker_cik_map
from ingestion.reddit import fetch_reddit
from ingestion.insider_trades import fetch_insider_trades
from ingestion.macro_data import fetch_macro_signals
from ingestion.earnings_calendar import fetch_earnings_calendar
from ingestion.price_data import fetch_price_context, enrich_signals_with_price
from processing.extractor import extract_signals
from processing.reasoner import reason_on_signals
from scoring.engine import score_and_rank
# dashboard reads signals/signals.json directly

# --- Paths ---
from config.settings import FRED_API_KEY

_HERE = os.path.dirname(os.path.abspath(__file__))
SEEN_IDS_FILE = os.path.join(_HERE, "seen_ids.json")
CACHE_FILE = os.path.join(_HERE, "cache_articles.json")
SIGNALS_CACHE = os.path.join(_HERE, "cache_signals.json")
LOCK_FILE = os.path.join(_HERE, ".pipeline.lock")
LOG_DIR = os.path.join(_HERE, "logs")
LOG_FILE = os.path.join(LOG_DIR, "pipeline.log")

# Signals shared bus (read by trading-bot, swing-bot, etc.)
_ROOT = os.path.dirname(_HERE)
SIGNALS_DIR = os.path.join(_ROOT, "signals")
SIGNALS_JSON = os.path.join(SIGNALS_DIR, "signals.json")
BLESSED_WATCHLIST_JSON = os.path.join(SIGNALS_DIR, "blessed_watchlist.json")

# Pruning limit: keep only the last N seen IDs to prevent unbounded growth
SEEN_IDS_MAX = 10_000

# --- Logging setup ---
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        # Rotate at 5MB, keep 7 days of logs — prevents unbounded disk growth on VPS
        logging.handlers.RotatingFileHandler(LOG_FILE, maxBytes=5_000_000, backupCount=7),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Atomic file write helper
# ---------------------------------------------------------------------------

def _atomic_write_json(path: str, data) -> None:
    """
    Write JSON atomically: write to a .tmp file, then os.rename() into place.
    os.rename() is atomic on Linux/macOS — a partial write never corrupts the
    destination file. The reader always sees either the old version or the new one.
    """
    dir_ = os.path.dirname(path) or "."
    fd, tmp_path = tempfile.mkstemp(dir=dir_, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
        os.rename(tmp_path, path)
    except Exception:
        # Clean up temp file on failure
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Seen IDs — with pruning
# ---------------------------------------------------------------------------

def load_seen_ids() -> set[str]:
    if os.path.exists(SEEN_IDS_FILE):
        try:
            with open(SEEN_IDS_FILE) as f:
                return set(json.load(f))
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("[Main] seen_ids.json unreadable (%s) — starting fresh", e)
    return set()


def save_seen_ids(seen_ids: set[str]) -> None:
    """
    Merge new IDs with the existing ordered list, then prune oldest from the front.
    Preserves insertion order so pruning always drops the oldest IDs, not random ones.
    """
    existing_list: list[str] = []
    if os.path.exists(SEEN_IDS_FILE):
        try:
            with open(SEEN_IDS_FILE) as f:
                existing_list = json.load(f)
        except (json.JSONDecodeError, OSError):
            existing_list = []

    existing_set = set(existing_list)
    new_ids = [id_ for id_ in seen_ids if id_ not in existing_set]
    merged = existing_list + new_ids

    if len(merged) > SEEN_IDS_MAX:
        merged = merged[-SEEN_IDS_MAX:]  # drop oldest from front
        logger.info("[Main] seen_ids pruned to %d entries", SEEN_IDS_MAX)

    _atomic_write_json(SEEN_IDS_FILE, merged)


# ---------------------------------------------------------------------------
# Cache helpers (atomic writes)
# ---------------------------------------------------------------------------

def save_cache(articles: list[dict]) -> None:
    _atomic_write_json(CACHE_FILE, articles)


def load_cache() -> list[dict]:
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("[Main] cache_articles.json unreadable: %s", e)
    return []


def save_signals_cache(signals: list[dict]) -> None:
    _atomic_write_json(SIGNALS_CACHE, signals)


def load_signals_cache() -> list[dict]:
    if os.path.exists(SIGNALS_CACHE):
        try:
            with open(SIGNALS_CACHE) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning("[Main] cache_signals.json unreadable: %s", e)
    return []


# ---------------------------------------------------------------------------
# Signals bus writers (atomic)
# ---------------------------------------------------------------------------

def _validate_signals_schema(theses: list[dict]) -> bool:
    """Minimal schema check before writing to signals bus."""
    required = {"ticker", "company", "sector", "verdict", "confidence", "thesis"}
    for t in theses:
        if not isinstance(t, dict):
            return False
        if not required.issubset(t.keys()):
            missing = required - t.keys()
            logger.warning("[Main] Signal missing fields %s — schema invalid", missing)
            return False
    return True


def write_signals_bus(ranked: list[dict]) -> None:
    """
    Write ranked theses to signals/signals.json (shared module bus).
    Validates schema, writes atomically, stamps with today's date.
    """
    if not ranked:
        logger.warning("[Main] write_signals_bus called with empty list — skipping")
        return

    if not _validate_signals_schema(ranked):
        logger.error("[Main] Signals failed schema validation — not writing to bus")
        print("[Main] ERROR: Signals failed schema validation. signals.json NOT updated.")
        return

    today = date.today().isoformat()
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "date": today,
        "theses": ranked,
    }
    os.makedirs(SIGNALS_DIR, exist_ok=True)
    _atomic_write_json(SIGNALS_JSON, payload)
    logger.info("[Main] signals.json updated: %d theses for %s", len(ranked), today)
    print(f"[Main] signals.json updated ({len(ranked)} theses for {today})")


def write_blessed_watchlist(ranked: list[dict]) -> None:
    """
    Write top tickers to signals/blessed_watchlist.json (read by trading-bot).
    Only BUY_WATCH signals are included.
    """
    _invalid = {"N/A", "NA", "NULL", "NONE", "", "N/A.", "?"}
    seen_tickers: set[str] = set()
    buy_tickers = []
    for t in ranked:
        ticker = t.get("ticker", "")
        if (
            t.get("verdict") == "BUY_WATCH"
            and ticker
            and ticker.upper() not in _invalid
            and ticker.isalpha()
            and len(ticker) <= 5
            and ticker not in seen_tickers
        ):
            buy_tickers.append(ticker)
            seen_tickers.add(ticker)
    today = date.today().isoformat()
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "date": today,
        "tickers": buy_tickers,
    }
    os.makedirs(SIGNALS_DIR, exist_ok=True)
    _atomic_write_json(BLESSED_WATCHLIST_JSON, payload)
    logger.info("[Main] blessed_watchlist.json updated: %s", buy_tickers)
    print(f"[Main] blessed_watchlist.json updated: {buy_tickers}")


# ---------------------------------------------------------------------------
# Staleness check for signals bus
# ---------------------------------------------------------------------------

def _check_signals_staleness() -> None:
    """Warn if signals.json is from a previous day."""
    if not os.path.exists(SIGNALS_JSON):
        return
    try:
        with open(SIGNALS_JSON) as f:
            data = json.load(f)
        sig_date = data.get("date")
        if sig_date and sig_date != date.today().isoformat():
            logger.warning("[Main] signals.json is stale: dated %s, today is %s",
                           sig_date, date.today().isoformat())
            print(f"[Main] WARNING: signals.json is stale (dated {sig_date})")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Run lock — prevents two simultaneous instances
# ---------------------------------------------------------------------------

class RunLock:
    """
    Advisory file lock. Prevents two pipeline instances from running simultaneously
    and double-spending API credits.
    Raises RuntimeError if the lock is already held.
    """
    def __init__(self, path: str):
        self._path = path
        self._fd = None

    def __enter__(self):
        self._fd = open(self._path, "w")
        try:
            fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._fd.close()
            raise RuntimeError(
                "[Main] Another pipeline instance is already running. "
                "Exiting to prevent double API spend."
            )
        self._fd.write(str(os.getpid()))
        self._fd.flush()
        return self

    def __exit__(self, *_):
        if self._fd:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            self._fd.close()
        try:
            os.unlink(self._path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def run_pipeline(ingest_only: bool = False, use_cache: bool = False, dry_run: bool = False) -> None:
    logger.info("=" * 60)
    logger.info("MARKET LENS pipeline started — %s", datetime.now().strftime("%Y-%m-%d %H:%M"))

    print(f"\n{'='*40}")
    print(f"MARKET LENS — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    if use_cache:
        print("MODE: cached articles (no new ingestion)")
    if dry_run:
        print("MODE: dry run (no SMS will be sent)")
    print(f"{'='*40}\n")

    # Warn if signals bus has stale data
    _check_signals_staleness()

    # --- Step 1: Ingest or load cache ---
    if use_cache or dry_run:
        all_articles = load_cache()
        if not all_articles:
            logger.error("[Main] No cache found. Run --ingest first.")
            print("[Cache] No cache found. Run --ingest first.")
            return
        print(f"[Cache] Loaded {len(all_articles)} articles from cache")
        logger.info("[Main] Loaded %d articles from cache", len(all_articles))
    else:
        seen_ids = load_seen_ids()

        print("[Ingest 1/6] Ingesting RSS feeds...")
        rss_articles = fetch_rss(seen_ids)

        print("[Ingest 2/6] Loading SEC CIK map + ingesting 8-K/10-Q filings...")
        cik_map = load_ticker_cik_map()
        sec_filings = fetch_recent_filings(cik_map, seen_ids)

        print("[Ingest 3/6] Ingesting SEC Form 4 insider trades...")
        insider_articles = fetch_insider_trades(cik_map, seen_ids)

        print("[Ingest 4/6] Ingesting Reddit...")
        reddit_posts = fetch_reddit(seen_ids)

        print("[Ingest 5/6] Fetching upcoming earnings calendar...")
        from config.sources import SEC_WATCHLIST
        earnings_tickers = [t for tickers in SEC_WATCHLIST.values() for t in tickers]
        # Earnings use a separate seen_ids so they reappear every daily run —
        # NVDA reports Wednesday means we want that signal every run this week.
        earnings_articles = fetch_earnings_calendar(earnings_tickers, set())

        print("[Ingest 6/6] Fetching FRED macro indicators...")
        macro_articles = fetch_macro_signals(FRED_API_KEY, seen_ids)

        all_articles = (
            rss_articles
            + sec_filings
            + insider_articles
            + reddit_posts
            + earnings_articles
            + macro_articles
        )
        save_seen_ids(seen_ids)
        save_cache(all_articles)

        print(f"\n[Ingest] Total new items: {len(all_articles)}")
        logger.info(
            "[Main] Ingested %d total items (RSS: %d, SEC: %d, Insider: %d, "
            "Reddit: %d, Earnings: %d, Macro: %d)",
            len(all_articles), len(rss_articles), len(sec_filings),
            len(insider_articles), len(reddit_posts), len(earnings_articles),
            len(macro_articles),
        )

        if ingest_only:
            print("[--ingest] Cache saved. Run --cached to process without re-ingesting.")
            logger.info("[Main] Ingest-only mode complete.")
            return

    if not all_articles:
        logger.warning("[Main] No articles after ingestion. Exiting.")
        print("[Pipeline] No articles. Exiting.")
        return

    # --- Processing 1/3: Extract signals ---
    print("\n[Processing 1/3] Extracting investment signals via Claude Haiku...")
    signals = extract_signals(all_articles)
    save_signals_cache(signals)

    if not signals:
        logger.warning("[Main] No signals extracted. Exiting.")
        print("[Pipeline] No signals extracted. Exiting.")
        return

    # --- Processing 2/3: Enrich signals with live price context ---
    print("\n[Processing 2/3] Fetching live price context (yfinance)...")
    tickers_in_signals = list({s["ticker"] for s in signals if s.get("ticker")})
    price_ctx = fetch_price_context(tickers_in_signals)
    signals = enrich_signals_with_price(signals, price_ctx)
    logger.info("[Main] Price context enriched %d signals", len(price_ctx))

    # --- Processing 3/3: Deep reasoning ---
    print("\n[Processing 3/3] Running deep causal reasoning via Claude Sonnet...")
    theses = reason_on_signals(signals)

    if not theses:
        logger.warning("[Main] No theses generated. Exiting.")
        print("[Pipeline] No theses generated. Exiting.")
        return

    # --- Scoring: rank and filter ---
    print("\n[Scoring] Ranking theses by confidence...")
    ranked = score_and_rank(theses)

    if not ranked:
        logger.warning("[Main] No stocks met confidence threshold. Exiting.")
        print("[Pipeline] No stocks met confidence threshold. Exiting.")
        return

    print(f"[Scoring] Top {len(ranked)} stocks selected.")

    # Write to shared signals bus (atomic)
    write_signals_bus(ranked)
    write_blessed_watchlist(ranked)

    # SMS removed — dashboard reads signals.json directly
    # signals.json and blessed_watchlist.json already written above
    logger.info("[Main] signals.json and blessed_watchlist.json ready for dashboard")
    print("\n[Done] Signals written to signals/ — dashboard will display them")

    logger.info("[Main] Pipeline complete — %d theses written to signals bus.", len(ranked))
    print("\n[Done] Pipeline complete.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _validate_config() -> None:
    from config.settings import ANTHROPIC_API_KEY
    if not ANTHROPIC_API_KEY:
        logger.critical("[Config] ANTHROPIC_API_KEY not set in .env — exiting")
        print("[Config] ERROR: ANTHROPIC_API_KEY missing. Check market-lens/.env")
        sys.exit(1)


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--ingest" not in args:  # ingest-only mode doesn't need Anthropic key
        _validate_config()
    try:
        with RunLock(LOCK_FILE):
            run_pipeline(
                ingest_only="--ingest" in args,
                use_cache="--cached" in args,
                dry_run="--dry-run" in args,
            )
    except RuntimeError as e:
        # Run-lock conflict
        logger.error(str(e))
        print(str(e))
        sys.exit(1)
    except KeyboardInterrupt:
        logger.warning("[Main] Pipeline interrupted by user (Ctrl+C).")
        print("\n[Main] Interrupted.")
        sys.exit(0)
    except Exception as e:
        # Top-level catch: log the crash instead of dying silently
        logger.exception("[Main] UNHANDLED EXCEPTION — pipeline crashed: %s", e)
        print(f"\n[Main] FATAL ERROR: {e}")
        print(f"[Main] Full traceback written to {LOG_FILE}")
        sys.exit(1)
