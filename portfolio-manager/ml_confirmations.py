"""
ml_confirmations.py — Market-lens signal confirmation tracker.
Called by portfolio-manager after each swing position closes.
Records whether the market-lens BUY_WATCH call was confirmed (WIN) or missed (LOSS).
market-lens reads this history and includes it in Claude's next briefing prompt.
"""

import json
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
logger = logging.getLogger(__name__)

SIGNALS_DIR    = Path('/opt/nexustrader/signals')
OUTCOMES_PATH  = SIGNALS_DIR / 'swing_outcomes.json'
SIGNALS_JSON   = SIGNALS_DIR / 'signals.json'
OUTPUT_PATH    = SIGNALS_DIR / 'ml_confirmations.json'
LOOKBACK_DAYS  = 90


def load_json(path: Path, fallback=None):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text())
    except Exception:
        return fallback


def get_signal_date_for_ticker(ticker: str, entry_date: str) -> str | None:
    """Check if market-lens issued a BUY_WATCH signal near the entry date."""
    signals = load_json(SIGNALS_JSON, {})
    theses = signals.get('theses', [])
    for t in theses:
        if t.get('ticker') == ticker and t.get('verdict') == 'BUY_WATCH':
            return signals.get('date', '')
    return None


def run() -> None:
    logger.info('=== ML Confirmations ===')

    outcomes = load_json(OUTCOMES_PATH, [])
    existing = load_json(OUTPUT_PATH, [])

    # Build set of already-recorded (ticker, closed_at) to avoid duplicates
    recorded = {(r['ticker'], r['closed_at']) for r in existing}

    cutoff = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    new_entries = 0

    for o in outcomes:
        key = (o.get('ticker', ''), o.get('closed_at', ''))
        if key in recorded:
            continue

        try:
            closed_dt = datetime.fromisoformat(o['closed_at'].replace('Z', '+00:00'))
        except Exception:
            continue

        if closed_dt < cutoff:
            continue

        ticker  = o.get('ticker', '')
        outcome = o.get('outcome', '')
        pattern = o.get('pattern', '')

        # Only record trades driven by market-lens BUY_WATCH signals
        if pattern not in ('BUY_WATCH', 'MONITOR'):
            continue

        entry = {
            'ticker':    ticker,
            'closed_at': o['closed_at'],
            'verdict':   pattern,
            'outcome':   'CONFIRMED' if outcome == 'WIN' else 'MISSED',
            'pnl_pct':   o.get('pnl_pct', 0),
        }
        existing.append(entry)
        recorded.add(key)
        new_entries += 1
        logger.info('  %s %s → %s (%.1f%%)', ticker, pattern, entry['outcome'], o.get('pnl_pct', 0))

    if new_entries == 0:
        logger.info('No new confirmations to record')
        return

    # Keep last 200 entries (well beyond what fits in a Claude prompt)
    existing = existing[-200:]

    SIGNALS_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(existing, indent=2))
    logger.info('Wrote ml_confirmations.json (%d new, %d total) ✓', new_entries, len(existing))


def get_confirmation_summary() -> str:
    """
    Returns a compact summary string for inclusion in the market-lens Claude prompt.
    Example: 'NVDA: 3C/1M | GOOGL: 1C/2M | AAPL: 2C/0M'
    """
    data = load_json(OUTPUT_PATH, [])
    cutoff = datetime.now(timezone.utc) - timedelta(days=60)
    recent = [
        e for e in data
        if datetime.fromisoformat(e.get('closed_at', '1970-01-01Z').replace('Z', '+00:00')) >= cutoff
    ]

    by_ticker: dict[str, dict] = {}
    for e in recent:
        t = e['ticker']
        if t not in by_ticker:
            by_ticker[t] = {'confirmed': 0, 'missed': 0}
        if e['outcome'] == 'CONFIRMED':
            by_ticker[t]['confirmed'] += 1
        else:
            by_ticker[t]['missed'] += 1

    if not by_ticker:
        return 'No signal history yet.'

    parts = []
    for ticker, counts in sorted(by_ticker.items()):
        parts.append(f"{ticker}: {counts['confirmed']}C/{counts['missed']}M")
    return ' | '.join(parts)


if __name__ == '__main__':
    run()
    print('\nConfirmation summary:')
    print(get_confirmation_summary())
