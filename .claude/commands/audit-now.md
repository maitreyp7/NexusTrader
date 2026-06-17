# /audit-now — NexusTrader Current State Audit

You are a senior quantitative systems architect, cybersecurity auditor, and AI reliability engineer.

Perform a COMPLETE audit of what is ACTUALLY BUILT in NexusTrader right now. Do not audit placeholder folders or future modules. Fix every issue you find immediately.

## Current System State (what exists and is real)
- `market-lens/` — the only fully built module
- `market-lens/ingestion/` — rss.py, sec_edgar.py, reddit.py (all working)
- `market-lens/processing/` — extractor.py (Claude Haiku pass 1), reasoner.py (Claude Haiku pass 2)
- `market-lens/scoring/engine.py` — ranks theses, picks top 5
- `market-lens/briefing/` — formatter.py, sms.py (Verizon gateway)
- `market-lens/config/` — settings.py, sources.py
- `market-lens/main.py` — pipeline with --ingest, --dry-run, --cached, full run modes
- `signals/` — blessed_watchlist.json, signals.json, alerts.json, portfolio.json (shared bus)
- `.env` — ANTHROPIC_API_KEY set, SMS credentials pending
- `.gitignore` — blocks .env
- `git-secrets` — installed

## What Does NOT Exist Yet (skip these entirely)
- swing-bot, portfolio-manager, wealth-intelligence (empty placeholders)
- Docker, VPS, PostgreSQL, Qdrant (not set up yet)
- trading-bot integration (placeholder only)
- backtesting, vector DB, proprietary model

## Audit Sections — Complete ALL of these

### 1. INGESTION RELIABILITY
Read `market-lens/ingestion/rss.py`, `sec_edgar.py`, `reddit.py`.
Find and fix:
- Missing retry logic on network failures (requests should retry 3x with backoff)
- No timeout handling on hung connections
- RSS feeds that return malformed XML crashing the whole ingestion
- SEC EDGAR rate limiting (they block if you hit too fast)
- Reddit 429 rate limit handling
- Any feed failure taking down ALL feeds instead of just skipping that one
- Missing validation on article fields (empty title, empty URL, etc.)
- Timezone inconsistencies in published dates
- Articles with no content being passed to Claude (wasted tokens)

### 2. CLAUDE PIPELINE VALIDATION
Read `market-lens/processing/extractor.py` and `reasoner.py`.
Find and fix:
- Fabricated ticker symbols (Claude inventing tickers that don't exist)
- Confidence scores outside 0-100 range
- Missing fields in JSON response crashing downstream code
- Prompt injection: scraped articles containing text like "ignore previous instructions"
- Token cost inefficiency — are we sending duplicate/redundant content to Claude?
- No fallback if Claude API is down (should cache last good result)
- Haiku-specific hallucination patterns: fabricating company names, wrong sectors
- Article summaries being truncated mid-sentence causing bad signals
- Claude returning plain text instead of JSON (no code fence stripping edge cases)
- Validate every signal has: ticker OR null, valid sector, valid direction, strength 1-10

### 3. COST AUDIT
Calculate and report:
- Estimated tokens per run (input + output for both Claude calls)
- Estimated cost per run at Haiku pricing ($0.25/M input, $0.80/M output)
- Estimated monthly cost at 1 run/day weekdays only
- Flag any obvious token waste (sending full HTML, duplicate content, etc.)
- Suggest specific optimizations to reduce cost without hurting quality
- Check if MAX_ARTICLES_TO_REASON=40 is the right threshold

### 4. SIGNAL FILE INTEGRITY
Read and audit `signals/blessed_watchlist.json`, `signals.json`, `alerts.json`, `portfolio.json`.
Find and fix:
- No atomic writes (partial write = corrupted JSON that crashes reader)
- No schema validation before writing
- No stale signal detection (yesterday's signals being read as today's)
- No checksums or timestamps to detect corruption
- Race condition if two processes write simultaneously
- Missing file recovery if file is deleted or corrupted
- Implement atomic write pattern: write to .tmp file, then rename

### 5. MAIN PIPELINE ROBUSTNESS
Read `market-lens/main.py`.
Find and fix:
- No logging to file (only prints to terminal — lost on crash)
- Crash in step 2 should not lose step 1 results (cache should always save)
- No timeout on full pipeline run (could hang forever)
- seen_ids.json growing forever with no pruning (will eventually be huge)
- No run lock file (two instances running simultaneously would double-spend API credits)
- Pipeline should send SMS alert if it completely fails to run
- seen_ids.json not pruned — after months it could have 100K+ entries

### 6. SECRET + SECURITY AUDIT
Check:
- `.env` is in `.gitignore` at both root and market-lens level
- No API keys hardcoded anywhere in any .py file
- No keys appearing in any log output
- `settings.py` loads from dotenv correctly
- `.env.example` has no real values
- `seen_ids.json` and cache files are in `.gitignore`
- git-secrets is configured and working
- SMS credentials not logged anywhere

### 7. CONFIGURATION AUDIT
Read `market-lens/config/settings.py` and `sources.py`.
Find and fix:
- Any RSS feed URLs that are dead or returning errors
- Tickers in SEC_WATCHLIST that are invalid or delisted
- CONFIDENCE_THRESHOLD=50 — is this the right floor given Haiku's tendency to over-score?
- MAX_ARTICLES_TO_REASON=40 — validate this is optimal for cost vs quality
- BATCH_SIZE in extractor — validate 15 is right
- Subreddits that are private or banned

### 8. ERROR HANDLING GAPS
Across ALL files, find:
- Bare `except Exception as e: print(...)` with no recovery
- Silent failures that return empty list with no alert
- Missing file handling (what if cache_articles.json is deleted mid-run?)
- What happens if Claude returns an empty response?
- What happens if SEC EDGAR is down for the whole run?
- What happens if ALL RSS feeds fail simultaneously?

---

## Required Output Format

For each issue found:
1. **File + line number** where the issue exists
2. **Why it's dangerous** (specific failure scenario)
3. **The fix** (show actual code changes)

Then produce:
- **Issues Fixed:** count
- **Issues Remaining:** list with priority
- **Cost per run estimate:** $X.XX
- **Monthly cost estimate:** $X.XX  
- **Reliability Score:** X/10 (can it run for 30 days without crashing?)
- **Security Score:** X/10
- **Claude Output Quality Score:** X/10 (how much do we trust the theses?)
- **Top 3 things to fix next**

Fix everything you can. For things that require user input (SMS credentials, dead feed URLs), flag them clearly but don't block on them.
