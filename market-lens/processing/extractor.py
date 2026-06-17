import anthropic
import json
import logging
import time as _time
from config.settings import ANTHROPIC_API_KEY, MAX_ARTICLES_TO_REASON, SECTORS
from config.sources import SEC_WATCHLIST

logger = logging.getLogger(__name__)

# Build a flat set of all known tickers from SEC watchlist + common additions.
# Claude-fabricated tickers not in this set are nulled out.
_KNOWN_TICKERS: set[str] = set()
for _tickers in SEC_WATCHLIST.values():
    _KNOWN_TICKERS.update(_tickers)
# Add common tickers Claude might legitimately return that aren't in SEC_WATCHLIST
_KNOWN_TICKERS.update({
    "SPY", "QQQ", "IWM", "DIA", "VTI", "GLD", "SLV", "TLT", "HYG",
    "TSLA", "NFLX", "SPOT", "UBER", "LYFT", "SNAP", "TWTR", "PINS",
    "PLTR", "RKLB", "LUNR", "SPCE", "COIN", "HOOD", "SOFI",
    "MP", "LAC", "SGML", "UUUU", "ALTM",
    "DRS", "HII", "L3H", "LDOS", "CACI", "SAIC", "FLIR",
    "ENPH", "SEDG", "BE", "PLUG", "FCEL", "BLDP",
    "MRNA", "BNTX", "REGN", "GILD", "BIIB", "VRTX", "LLY", "BMY",
    # seen in real runs — security software
    "SNPS", "ACMR", "KOPIN", "KOPN", "SEMI", "MKSI", "JACO",
    "POWI", "ON", "TI", "CRWD", "PANW", "ZS", "OKTA",
    "KLAC", "LRCX", "AMAT", "TER", "ENTG", "ONTO", "FORM",
    "CDNS", "SMCI", "ARM", "MRVL", "SWKS", "QRVO", "MPWR",
    # healthcare / biotech pipeline names that appear in news
    "LNZA", "FATE", "CRSP", "BEAM", "EDIT", "NTLA", "IONS",
    "RGEN", "NTRA", "GH", "EXAS", "ILMN", "PACB",
    # finance / trading
    "SCHW", "IBKR", "CME", "ICE", "MSCI", "SPGI", "MCO",
    # consumer
    "NKE", "LULU", "TGT", "WMT", "COST", "HD", "LOW", "MCD", "SBUX",
    # Google share classes
    "GOOG",
    # energy transition
    "CEG", "VST", "NRG", "AES", "ETR", "PEG", "EXC", "D",
    # other common names seen in runs
    "DELL", "HPQ", "HPE", "WDC", "STX", "NTAP",
    "MU", "TSM",
})

_VALID_SECTORS = set(SECTORS) | {"macro"}

_VALID_SIGNAL_TYPES = {
    "earnings", "earnings_event", "guidance", "contract", "regulation", "macro",
    "geopolitical", "management", "product", "legal", "supply_chain", "sentiment",
    "insider_trade",  # SEC Form 4 — executives buying/selling their own stock
}

_VALID_DIRECTIONS = {"positive", "negative", "neutral"}

# Prompt injection patterns — same list used in ingestion but re-checked here
# as a second line of defense before content reaches Claude
_INJECTION_PATTERNS = [
    "ignore previous instructions",
    "ignore all previous",
    "disregard previous",
    "forget your instructions",
    "new instructions:",
    "system prompt:",
    "you are now",
]

try:
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
except Exception as e:
    logger.critical("[Extractor] Failed to init Anthropic client: %s", e)
    client = None

EXTRACT_PROMPT = """You are an elite financial intelligence analyst at a top hedge fund.

Analyze the following batch of articles, filings, and data. For each one that contains a meaningful investment signal, extract structured data.

Signal priority (highest to lowest):
1. SEC Form 4 insider PURCHASES — insiders buying = strongest signal
2. Upcoming earnings events — binary catalyst, extremely time-sensitive
3. SEC 8-K filings — material events, contracts, management changes
4. Earnings surprises and guidance changes
5. Macro data (FRED) — rate changes, CPI, yield curve inversions
6. News from major outlets (Reuters, FT, Bloomberg, WSJ)
7. Reddit SecurityAnalysis / ValueInvesting — professional-grade only
8. General Reddit sentiment — treat as weak confirmation signal only

Return a JSON array. Each item must have:
- "ticker": stock ticker symbol (e.g. "NVDA") or null if no specific company
- "company": full company name or null
- "sector": one of: technology, defense, energy, finance, rare_earth, healthcare, semiconductors, macro
- "signal_type": one of: earnings, earnings_event, guidance, contract, regulation, macro, geopolitical, management, product, legal, supply_chain, sentiment, insider_trade
- "direction": "positive", "negative", or "neutral"
- "strength": integer 1-10 (10 = extremely significant)
- "summary": 2-3 sentence explanation of the signal and its investment implication
- "second_order": list of 1-3 strings describing indirect effects on OTHER companies/sectors
- "source_title": the article/filing title this came from
- "credibility": integer 1-10 (10 = SEC insider filing or FRED data, 1 = Reddit speculation)
- "price_already_moved": true if you believe the market has already reacted to this

Only include articles with genuine investment relevance. Skip noise, duplicate stories, and opinion without data.
Return ONLY a valid JSON array. No explanation, no markdown, no code fences.

Articles and data:
{articles}"""

BATCH_SIZE = 15  # articles per Claude call — prevents response truncation


def _sanitize_for_claude(text: str) -> str:
    """Second-line defense: strip prompt injection before sending to Claude."""
    lowered = text.lower()
    for pattern in _INJECTION_PATTERNS:
        if pattern in lowered:
            idx = lowered.find(pattern)
            text = text[:idx] + "[CONTENT REDACTED BY SAFETY FILTER]"
            lowered = text.lower()
    return text


def _parse_json(raw: str) -> list:
    """
    Robust JSON extraction: handles markdown fences, leading text, trailing text.
    Tries multiple strategies before giving up.
    """
    raw = raw.strip()

    # Strategy 1: already clean JSON
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

    # All strategies failed
    raise json.JSONDecodeError("Could not extract JSON array from response", raw, 0)


def _validate_signal(sig: dict) -> dict:
    """
    Validate and sanitize a single signal dict from Claude.
    - Nulls out tickers Claude fabricated that aren't in known list.
    - Clamps strength and credibility to 1-10.
    - Normalizes sector and signal_type to allowed values.
    - Ensures required fields exist.
    Returns the cleaned signal, or None if the signal is fundamentally invalid.
    """
    if not isinstance(sig, dict):
        return None

    # Ticker validation — reject fabricated tickers
    ticker = sig.get("ticker")
    if ticker and isinstance(ticker, str):
        ticker = ticker.upper().strip()
        if ticker not in _KNOWN_TICKERS:
            logger.warning("[Extractor] Nulling unknown ticker '%s' — not in known list", ticker)
            ticker = None
    sig["ticker"] = ticker

    # Sector validation
    sector = sig.get("sector", "macro")
    if sector not in _VALID_SECTORS:
        logger.warning("[Extractor] Invalid sector '%s' — defaulting to macro", sector)
        sig["sector"] = "macro"

    # Signal type validation
    signal_type = sig.get("signal_type", "macro")
    if signal_type not in _VALID_SIGNAL_TYPES:
        sig["signal_type"] = "macro"

    # Direction validation
    direction = sig.get("direction", "neutral")
    if direction not in _VALID_DIRECTIONS:
        sig["direction"] = "neutral"

    # Clamp strength 1-10
    strength = sig.get("strength", 5)
    if not isinstance(strength, (int, float)):
        strength = 5
    sig["strength"] = max(1, min(10, int(strength)))

    # Clamp credibility 1-10
    credibility = sig.get("credibility", 5)
    if not isinstance(credibility, (int, float)):
        credibility = 5
    sig["credibility"] = max(1, min(10, int(credibility)))

    # Ensure required string fields exist
    sig.setdefault("summary", "")
    sig.setdefault("source_title", "")
    sig.setdefault("company", None)
    sig.setdefault("second_order", [])

    # Ensure price_already_moved is a boolean (referenced in prompt, must not crash downstream)
    if not isinstance(sig.get("price_already_moved"), bool):
        sig["price_already_moved"] = False

    return sig


def extract_signals(articles: list[dict]) -> list[dict]:
    """
    Sends articles to Claude Haiku in batches of BATCH_SIZE.
    - Validates ticker symbols against known list (prevents hallucinated tickers).
    - Clamps all numeric fields to valid ranges.
    - Validates sector and signal_type against allowed values.
    - Sanitizes content for prompt injection before sending.
    - Falls back gracefully if Claude API is down.
    """
    if not articles:
        return []

    if client is None:
        logger.error("[Extractor] Claude client not initialized — API key missing?")
        print("[Extractor] ERROR: Claude client not initialized. Check ANTHROPIC_API_KEY.")
        return []

    all_signals = []
    batch_input = articles[:MAX_ARTICLES_TO_REASON]

    batches = [
        batch_input[i:i + BATCH_SIZE]
        for i in range(0, len(batch_input), BATCH_SIZE)
    ]

    for batch_num, batch in enumerate(batches):
        # Truncate summaries and sanitize for prompt injection
        formatted = "\n\n".join(
            f"[{i+1}] SOURCE: {_sanitize_for_claude(a.get('source', ''))}\n"
            f"TITLE: {_sanitize_for_claude(a.get('title', ''))}\n"
            f"SUMMARY: {_sanitize_for_claude(a.get('summary', '')[:300])}"
            for i, a in enumerate(batch)
        )

        try:
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=4096,
                messages=[{
                    "role": "user",
                    "content": EXTRACT_PROMPT.format(articles=formatted)
                }]
            )

            if not response.content:
                logger.warning("[Extractor] Batch %d: empty response from Claude", batch_num + 1)
                print(f"[Extractor] Batch {batch_num+1} returned empty response from Claude")
                continue

            # Log actual token usage for cost tracking
            if hasattr(response, "usage") and response.usage:
                in_tok = response.usage.input_tokens
                out_tok = response.usage.output_tokens
                batch_cost = (in_tok / 1_000_000 * 0.25) + (out_tok / 1_000_000 * 0.80)
                logger.info(
                    "[Extractor] Batch %d tokens: %d in / %d out — est. $%.5f (Haiku)",
                    batch_num + 1, in_tok, out_tok, batch_cost,
                )

            raw = response.content[0].text
            if not raw or not raw.strip():
                logger.warning("[Extractor] Batch %d: blank text from Claude", batch_num + 1)
                continue

            signals_raw = _parse_json(raw)

            if not isinstance(signals_raw, list):
                logger.warning("[Extractor] Batch %d: Claude returned non-list", batch_num + 1)
                continue

            # Validate every signal
            validated = []
            for sig in signals_raw:
                cleaned = _validate_signal(sig)
                if cleaned is not None:
                    validated.append(cleaned)

            all_signals.extend(validated)
            print(f"[Extractor] Batch {batch_num+1}/{len(batches)}: {len(validated)} signals")
            logger.info("[Extractor] Batch %d/%d: %d signals", batch_num + 1, len(batches), len(validated))

            # Brief pause between batches to avoid Anthropic rate limits
            if batch_num < len(batches) - 1:
                _time.sleep(1)

        except json.JSONDecodeError as e:
            logger.error("[Extractor] Batch %d JSON parse failed: %s", batch_num + 1, e)
            print(f"[Extractor] Batch {batch_num+1} JSON parse failed: {e}")
        except anthropic.APIConnectionError as e:
            logger.error("[Extractor] Claude API connection failed: %s", e)
            print(f"[Extractor] Claude API is unreachable: {e}. Skipping batch {batch_num+1}.")
        except anthropic.RateLimitError as e:
            logger.error("[Extractor] Claude rate limit hit: %s", e)
            print(f"[Extractor] Claude rate limit: {e}. Skipping batch {batch_num+1}.")
        except anthropic.APIStatusError as e:
            logger.error("[Extractor] Claude API error %d: %s", e.status_code, e.message)
            print(f"[Extractor] Claude API error {e.status_code}: {e.message}. Skipping batch {batch_num+1}.")
        except Exception as e:
            logger.error("[Extractor] Batch %d unexpected error: %s", batch_num + 1, e)
            print(f"[Extractor] Batch {batch_num+1} failed: {e}")

    print(f"[Extractor] Total: {len(all_signals)} signals from {len(batch_input)} articles")
    logger.info("[Extractor] Total: %d signals from %d articles", len(all_signals), len(batch_input))
    return all_signals
