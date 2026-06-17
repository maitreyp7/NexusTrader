import logging
from config.settings import CONFIDENCE_THRESHOLD, TOP_N_STOCKS

logger = logging.getLogger(__name__)

PRIORITY_EMOJI = {
    "CRITICAL": "🔴",
    "HIGH":     "🟡",
    "MEDIUM":   "🟠",
    "WATCH":    "🟢",
}


def _priority_label(confidence: int) -> str:
    if confidence >= 80:
        return "CRITICAL"
    elif confidence >= 65:
        return "HIGH"
    elif confidence >= 50:
        return "MEDIUM"
    return "WATCH"


def score_and_rank(theses: list[dict]) -> list[dict]:
    """
    Filters theses below confidence threshold, scores each one,
    and returns top N ranked by final score.
    - Confidence is clamped to 0-100 as a safety net even after reasoner validates.
    - Gracefully skips malformed entries.
    """
    scored = []

    for t in theses:
        # Clamp confidence — defense-in-depth even though reasoner already validates
        raw_confidence = t.get("confidence", 0)
        try:
            confidence = max(0, min(100, int(raw_confidence)))
        except (TypeError, ValueError):
            logger.warning("[Scoring] Invalid confidence value '%s' for %s — skipping",
                           raw_confidence, t.get("ticker", "?"))
            continue

        if confidence < CONFIDENCE_THRESHOLD:
            continue

        # Bonus points for signal quality and source strength
        bonus = 0
        if not t.get("market_priced_in", True):
            bonus += 10  # early = more upside
        if t.get("insider_signal"):
            bonus += 15  # executives spending their own money
        if t.get("macro_tailwind"):
            bonus += 5   # macro environment supports thesis
        if len(t.get("catalysts", [])) >= 3:
            bonus += 5   # multiple independent catalysts
        if len(t.get("second_order_beneficiaries", [])) >= 2:
            bonus += 5   # broad impact = stronger thesis

        final_score = min(confidence + bonus, 100)
        priority = _priority_label(final_score)

        scored.append({
            **t,
            "confidence": confidence,   # store clamped value
            "final_score": final_score,
            "priority": priority,
            "priority_emoji": PRIORITY_EMOJI[priority],
        })

    # Rank by final score descending
    scored.sort(key=lambda x: x["final_score"], reverse=True)
    top = scored[:TOP_N_STOCKS]
    logger.info("[Scoring] %d/%d theses passed threshold. Top %d selected.",
                len(scored), len(theses), len(top))
    return top
