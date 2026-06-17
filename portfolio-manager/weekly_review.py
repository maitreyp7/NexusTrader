"""
weekly_review.py — Cross-session weight analysis for ORB bot.
Runs every Friday after close (21:30 UTC). Reads all session files from
the past 5 trading days, pools all trades, and writes recommended_weights.json
to the signals bus. ORB bot reads this at next session start.

This supplements the per-session learning (which is too noisy for small
sample sizes) with a weekly pooled analysis that has more statistical power.
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
logger = logging.getLogger(__name__)

SESSIONS_DIR   = Path('/opt/nexustrader/orb-bot/logs/sessions')
SIGNALS_DIR    = Path('/opt/nexustrader/signals')
OUTPUT_PATH    = SIGNALS_DIR / 'recommended_weights.json'
BRAIN_DIR      = Path('/opt/nexustrader/orb-bot/logs/brain')
WEIGHTS_PATH   = BRAIN_DIR / 'adaptive-weights.json'

SIGNALS        = ['technical', 'microstructure', 'sentiment', 'whale', 'macro', 'orb']
MIN_WEIGHT     = 0.05
MAX_WEIGHT     = 0.50
MIN_TRADES     = 5       # need at least 5 closed trades to generate recommendations
LOOKBACK_DAYS  = 7       # look at last 7 calendar days (captures full week)


def load_session_trades(path: Path) -> list[dict]:
    try:
        d = json.loads(path.read_text())
        return [t for t in d.get('trades', []) if t.get('outcome') in ('WIN', 'LOSS')]
    except Exception as e:
        logger.warning('Could not load %s: %s', path, e)
        return []


def avg_signal(trades: list[dict], signal: str) -> float:
    vals = [t['decision']['scores'].get(signal, 0.5) for t in trades if t.get('decision', {}).get('scores')]
    return sum(vals) / len(vals) if vals else 0.5


def compute_recommended_weights(all_trades: list[dict]) -> dict[str, float]:
    wins   = [t for t in all_trades if t['outcome'] == 'WIN']
    losses = [t for t in all_trades if t['outcome'] == 'LOSS']

    # Load current weights as baseline
    baseline = {s: 1.0 / len(SIGNALS) for s in SIGNALS}
    if WEIGHTS_PATH.exists():
        try:
            stored = json.loads(WEIGHTS_PATH.read_text())
            for s in SIGNALS:
                if s in stored:
                    baseline[s] = stored[s]
        except Exception:
            pass

    raw = {}
    for signal in SIGNALS:
        avg_win  = avg_signal(wins,   signal) if wins   else 0.5
        avg_loss = avg_signal(losses, signal) if losses else 0.5
        discrimination = avg_win - avg_loss

        # Stronger discrimination = bigger nudge (max ±0.04 per week)
        delta = max(-0.04, min(0.04, discrimination * 0.15))
        raw[signal] = baseline[signal] + delta
        logger.info('  %s: avg_win=%.3f avg_loss=%.3f disc=%.3f delta=%+.3f → %.3f',
                    signal, avg_win, avg_loss, discrimination, delta, raw[signal])

    # Clamp each weight
    for s in SIGNALS:
        raw[s] = round(max(MIN_WEIGHT, min(MAX_WEIGHT, raw[s])), 4)

    # Re-normalize to sum to 1.0
    total = sum(raw.values())
    if total > 0:
        raw = {s: round(v / total, 4) for s, v in raw.items()}

    return raw


def run() -> None:
    logger.info('=== Weekly Review ===')
    cutoff = datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)

    # Collect trades from recent session files
    all_trades: list[dict] = []
    for session_file in sorted(SESSIONS_DIR.glob('*.json')):
        try:
            mtime = datetime.fromtimestamp(session_file.stat().st_mtime, tz=timezone.utc)
            if mtime < cutoff:
                continue
        except Exception:
            continue
        trades = load_session_trades(session_file)
        all_trades.extend(trades)
        logger.info('Loaded %s: %d closed trades', session_file.name, len(trades))

    wins   = [t for t in all_trades if t['outcome'] == 'WIN']
    losses = [t for t in all_trades if t['outcome'] == 'LOSS']
    logger.info('Total: %d trades (%dW / %dL)', len(all_trades), len(wins), len(losses))

    if len(all_trades) < MIN_TRADES:
        logger.warning('Not enough trades (%d < %d) — skipping recommendation', len(all_trades), MIN_TRADES)
        return

    weights = compute_recommended_weights(all_trades)
    logger.info('Recommended weights: %s', weights)

    # Safety check — reject if any weight is out of bounds
    for s, w in weights.items():
        if not (MIN_WEIGHT <= w <= MAX_WEIGHT):
            logger.error('Weight %s=%.3f out of safe range [%.2f, %.2f] — aborting', s, w, MIN_WEIGHT, MAX_WEIGHT)
            return

    output = {
        'generated_at':  datetime.now(timezone.utc).isoformat(),
        'week_ending':   datetime.now(timezone.utc).strftime('%Y-%m-%d'),
        'trades_analyzed': len(all_trades),
        'win_rate':      round(len(wins) / len(all_trades), 3) if all_trades else 0,
        'weights':       weights,
        'safe':          True,
    }

    SIGNALS_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, indent=2))
    logger.info('Wrote recommended_weights.json ✓')


if __name__ == '__main__':
    run()
