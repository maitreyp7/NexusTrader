import anthropic
import json
import logging
from config.settings import ANTHROPIC_API_KEY, SECTORS

logger = logging.getLogger(__name__)

_VALID_SECTORS = set(SECTORS) | {"macro"}
_VALID_VERDICTS = {"BUY_WATCH", "SELL_WATCH", "MONITOR"}
_VALID_HORIZONS = {"days", "weeks", "months"}

try:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
except Exception as e:
    logger.critical("[Reasoner] Failed to init Anthropic client: %s", e)
    client = None

REASON_PROMPT = """You are the lead investment analyst at a top-tier hedge fund. You have access to insider trade data, congressional disclosures, SEC filings, macro indicators, and news. Your job is to synthesize all of this into actionable investment theses that a portfolio manager can act on tomorrow morning.

You have been given a set of investment signals extracted from today's data sources.

REASONING FRAMEWORK — apply this to every thesis:

1. CONVERGENCE: Do multiple independent sources agree? (insider buy + positive earnings + volume spike = very high confidence)
2. CAUSALITY: What is the specific mechanism by which this signal translates to stock price movement?
3. TIMING: Is this early (before market reaction) or late (already priced in)?
4. SECOND ORDER: Which other companies in the supply chain, sector, or competitive landscape are affected?
5. CONTRADICTIONS: What signals argue against this thesis? Be honest.
6. HISTORICAL PRECEDENT: Has this pattern played out before? What happened?
7. PRICE CONTEXT: If price data is available — is the stock near its 52-week high (less upside) or near its low (more upside)? Is volume spiking (confirms the move)?
8. MACRO OVERLAY: How do current interest rates, yield curve, and inflation affect this thesis?

SPECIAL WEIGHT: Give significantly higher confidence to:
- Insider purchases (executives spending their own money is the strongest signal)
- Multiple independent sources confirming same direction
- Volume spikes confirming price action
- Signals where market has NOT yet reacted (price_already_moved = false)

For each strong opportunity or risk, produce a full investment thesis.

Return a JSON array. Each item must have:
- "ticker": stock ticker (must be a real, valid US ticker)
- "company": company full name
- "sector": sector
- "verdict": "BUY_WATCH", "SELL_WATCH", or "MONITOR"
- "confidence": integer 0-100
- "thesis": 4-6 sentence detailed investment thesis. Explain the causal mechanism, not just the facts.
- "entry_rationale": 1-2 sentences on WHY to enter now vs waiting
- "catalysts": list of specific events/signals supporting this (be specific — name the source, the amount, the date)
- "risks": list of specific risks and contradictions — be honest, not optimistic
- "second_order_beneficiaries": list of other tickers that benefit indirectly, with brief reason
- "time_horizon": "days", "weeks", or "months"
- "market_priced_in": true/false
- "insider_signal": true if backed by Form 4 insider purchase data
- "macro_tailwind": true if current macro environment (rates, inflation, growth) supports this
- "sources_used": list of specific source titles that informed this thesis

Confidence guide:
- 85-100: Insider buy + multiple independent sources + volume spike + not priced in
- 70-84: 2+ independent sources, strong causal logic, clear near-term catalyst
- 55-69: Good signal, some uncertainty, needs 1 more confirming signal
- 40-54: Early/speculative — include only if the asymmetric upside is exceptional
- Below 40: Do not include

Return ONLY valid JSON array. No text outside the array.

Today's signals:
{signals}"""


def _parse_json(raw: str) -> list:
    """
    Robust JSON extraction: handles markdown fences, leading text, trailing text.
    """
    raw = raw.strip()

    # Strategy 1: already clean JSON array
    if raw.startswith("["):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass

    # Strategy 2: strip ```json ... ``` or ``` ... ``` fences
    if "```" in raw:
        parts = raw.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith("["):
                try:
                    return json.loads(part)
                except json.JSONDecodeError:
                    continue

    # Strategy 3: find the first '[' and last ']' and parse between them
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass

    raise json.JSONDecodeError("Could not extract JSON array from response", raw, 0)


def _validate_thesis(t: dict) -> dict | None:
    """
    Validate and sanitize a thesis dict from Claude.
    - Clamps confidence to 0-100.
    - Validates verdict, sector, time_horizon against allowed values.
    - Ensures required fields exist with safe defaults.
    Returns cleaned thesis or None if fundamentally broken.
    """
    if not isinstance(t, dict):
        return None

    # Required: ticker
    if not t.get("ticker") or not isinstance(t.get("ticker"), str):
        return None

    # Clamp confidence to 0-100
    confidence = t.get("confidence", 0)
    if not isinstance(confidence, (int, float)):
        confidence = 0
    t["confidence"] = max(0, min(100, int(confidence)))

    # Validate verdict
    verdict = t.get("verdict", "MONITOR")
    if verdict not in _VALID_VERDICTS:
        t["verdict"] = "MONITOR"

    # Validate sector — normalize Claude sub-sectors like "Healthcare - Biotechnology",
    # "Defense & Aerospace", "Technology / Consumer Electronics" → base sector
    sector = t.get("sector", "macro")
    if sector not in _VALID_SECTORS:
        # Strip sub-category: split on " - ", " / ", or " & " and take first token
        import re as _re
        base = _re.split(r"\s[-/&]\s", sector)[0].strip()
        base_lower = base.lower()
        if base in _VALID_SECTORS:
            t["sector"] = base
        elif base_lower in _VALID_SECTORS:
            t["sector"] = base_lower
        else:
            logger.warning("[Reasoner] Invalid sector '%s' for %s — defaulting to macro",
                           sector, t.get("ticker"))
            t["sector"] = "macro"

    # Validate time_horizon
    horizon = t.get("time_horizon", "weeks")
    if horizon not in _VALID_HORIZONS:
        t["time_horizon"] = "weeks"

    # Ensure list fields are actually lists
    for field in ("catalysts", "risks", "second_order_beneficiaries", "sources_used"):
        if not isinstance(t.get(field), list):
            t[field] = []

    # Ensure boolean fields
    for bool_field in ("market_priced_in", "insider_signal", "congressional_signal", "macro_tailwind"):
        if not isinstance(t.get(bool_field), bool):
            t[bool_field] = False

    # Ensure required string fields
    t.setdefault("thesis", "")
    t.setdefault("entry_rationale", "")
    t.setdefault("company", t.get("ticker", ""))

    return t


_BATCH_SIZE = 15   # max signals per Sonnet call — keeps output well under 16k tokens
_MAX_TOKENS = 16000  # raised from 8000; prevents mid-JSON truncation that caused retries


def _call_sonnet(signals_batch: list[dict], max_retries: int = 3) -> list[dict]:
    """Single Sonnet call for one batch of signals. Returns validated theses."""
    import time as _time

    formatted = json.dumps(signals_batch, indent=2)
    estimated_chars = len(REASON_PROMPT) + len(formatted)
    estimated_tokens = estimated_chars // 4
    logger.info(
        "[Reasoner] Batch input: ~%d tokens (~$%.4f Sonnet input)",
        estimated_tokens, (estimated_tokens / 1_000_000) * 3.0,
    )

    for attempt in range(1, max_retries + 1):
        try:
            if attempt > 1:
                wait = 2 ** (attempt - 1)
                logger.info("[Reasoner] Retry %d/%d after %ds", attempt, max_retries, wait)
                print(f"[Reasoner] Retry {attempt}/{max_retries}...")
                _time.sleep(wait)

            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=_MAX_TOKENS,
                messages=[{
                    "role": "user",
                    "content": REASON_PROMPT.format(signals=formatted)
                }]
            )

            if not response.content:
                logger.warning("[Reasoner] Empty response on attempt %d", attempt)
                continue

            raw = response.content[0].text
            if not raw or not raw.strip():
                logger.warning("[Reasoner] Blank text on attempt %d", attempt)
                continue

            if hasattr(response, "usage") and response.usage:
                in_tok = response.usage.input_tokens
                out_tok = response.usage.output_tokens
                actual_cost = (in_tok / 1_000_000 * 3.0) + (out_tok / 1_000_000 * 15.0)
                logger.info(
                    "[Reasoner] Actual tokens: %d in / %d out — est. cost $%.4f (Sonnet)",
                    in_tok, out_tok, actual_cost,
                )
                print(f"[Reasoner] Tokens: {in_tok} in / {out_tok} out — est. ${actual_cost:.4f}")

            # Warn if output hit the token cap — response may be truncated
            if hasattr(response, "stop_reason") and response.stop_reason == "max_tokens":
                logger.warning("[Reasoner] Output hit max_tokens cap — response may be truncated")
                print("[Reasoner] WARNING: response hit token cap, may be truncated")

            theses_raw = _parse_json(raw)
            if not isinstance(theses_raw, list):
                logger.warning("[Reasoner] Non-list response on attempt %d", attempt)
                continue

            return [
                cleaned for t in theses_raw
                if (cleaned := _validate_thesis(t)) is not None
            ]

        except json.JSONDecodeError as e:
            logger.warning("[Reasoner] JSON parse failed on attempt %d: %s", attempt, e)
            continue
        except anthropic.APIConnectionError as e:
            logger.error("[Reasoner] Claude API unreachable: %s", e)
            print(f"[Reasoner] Claude API unreachable: {e}")
            return []
        except anthropic.RateLimitError as e:
            logger.error("[Reasoner] Claude rate limit hit: %s", e)
            print(f"[Reasoner] Claude rate limit: {e}.")
            return []
        except anthropic.APIStatusError as e:
            logger.error("[Reasoner] Claude API error %d: %s", e.status_code, e.message)
            print(f"[Reasoner] Claude API error {e.status_code}: {e.message}.")
            return []
        except Exception as e:
            logger.error("[Reasoner] Unexpected error: %s", e)
            print(f"[Reasoner] Failed: {e}")
            return []

    logger.error("[Reasoner] All %d attempts failed for this batch", max_retries)
    print(f"[Reasoner] All {max_retries} attempts failed for batch.")
    return []


def reason_on_signals(signals: list[dict]) -> list[dict]:
    """
    Takes extracted signals, runs deep causal reasoning via Claude Sonnet.
    Splits into batches of _BATCH_SIZE to keep output tokens well under the cap,
    preventing the mid-JSON truncation that was causing expensive retries.
    """
    if not signals:
        return []

    if client is None:
        logger.error("[Reasoner] Claude client not initialized — API key missing?")
        print("[Reasoner] ERROR: Claude client not initialized. Check ANTHROPIC_API_KEY.")
        return []

    batches = [signals[i:i + _BATCH_SIZE] for i in range(0, len(signals), _BATCH_SIZE)]
    all_theses: list[dict] = []

    for i, batch in enumerate(batches, 1):
        print(f"[Reasoner] Batch {i}/{len(batches)}: reasoning on {len(batch)} signals...")
        theses = _call_sonnet(batch)
        all_theses.extend(theses)
        logger.info("[Reasoner] Batch %d/%d: %d theses", i, len(batches), len(theses))

    print(f"[Reasoner] Generated {len(all_theses)} investment theses total")
    logger.info("[Reasoner] Generated %d theses total", len(all_theses))
    return all_theses
