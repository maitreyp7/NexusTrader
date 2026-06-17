"""
Aggregates alt-data signals into an earnings prediction per ticker.
Produces: beat / miss / neutral prediction with confidence score.
"""

import logging
from datetime import date
from signals import get_trends_signal, get_app_store_signal, get_hiring_signal, get_earnings_date
from config import MIN_SIGNALS_FOR_PREDICTION, EARNINGS_WARN_DAYS

logger = logging.getLogger(__name__)


def predict(ticker: str, company_name: str = "") -> dict:
    """
    Runs all available signal collectors for a ticker and aggregates into
    a single earnings prediction.
    """
    collected = []

    # Google Trends
    sig = get_trends_signal(ticker)
    if sig:
        collected.append(sig)

    # App Store (consumer apps only)
    sig = get_app_store_signal(ticker)
    if sig:
        collected.append(sig)

    # Job postings
    sig = get_hiring_signal(ticker, company_name)
    if sig:
        collected.append(sig)

    # Earnings date
    earnings_date = get_earnings_date(ticker)
    days_to_earnings = None
    if earnings_date:
        days_to_earnings = (earnings_date - date.today()).days

    if not collected:
        return {
            "ticker":           ticker,
            "prediction":       "insufficient_data",
            "confidence":       0,
            "signals_count":    0,
            "earnings_date":    earnings_date.isoformat() if earnings_date else None,
            "days_to_earnings": days_to_earnings,
            "warning":          None,
            "signals":          [],
        }

    # Score: bullish=+1, bearish=-1, neutral=0, weighted by strength
    total_weight = sum(s["strength"] for s in collected)
    score = 0
    for s in collected:
        weight = s["strength"] / total_weight if total_weight > 0 else 0
        if s["direction"] == "bullish":
            score += weight
        elif s["direction"] == "bearish":
            score -= weight

    # Map score to prediction
    if len(collected) < MIN_SIGNALS_FOR_PREDICTION:
        prediction = "insufficient_data"
        confidence = 0
    elif score >= 0.3:
        prediction = "beat"
        confidence = min(85, int(50 + score * 100))
    elif score <= -0.3:
        prediction = "miss"
        confidence = min(85, int(50 + abs(score) * 100))
    else:
        prediction = "neutral"
        confidence = int(40 + abs(score) * 50)

    # Earnings proximity warning
    warning = None
    if days_to_earnings is not None:
        if days_to_earnings <= 1:
            warning = f"EARNINGS TOMORROW — {'expect beat' if prediction == 'beat' else 'expect miss' if prediction == 'miss' else 'uncertain'}"
        elif days_to_earnings <= EARNINGS_WARN_DAYS:
            warning = f"Earnings in {days_to_earnings}d ({earnings_date}) — {prediction.upper()} predicted"

    return {
        "ticker":           ticker,
        "company":          company_name,
        "prediction":       prediction,
        "confidence":       confidence,
        "score":            round(score, 3),
        "signals_count":    len(collected),
        "earnings_date":    earnings_date.isoformat() if earnings_date else None,
        "days_to_earnings": days_to_earnings,
        "warning":          warning,
        "signals":          collected,
    }
