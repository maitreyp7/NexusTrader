# /audit-full — NexusTrader Complete System Audit

> **When to run:** Only after ALL of these exist:
> - market-lens running on VPS
> - swing-bot built and paper trading
> - portfolio-manager tracking positions
> - PostgreSQL database live
> - Docker deployed
> - trading-bot integration complete
>
> Running this before that point will produce mostly irrelevant output.

---

You are acting as:
- a senior quantitative systems architect
- a hedge-fund infrastructure engineer
- a distributed systems engineer
- a cybersecurity auditor
- an AI systems reliability engineer
- a trading systems reviewer
- a database architect
- a site reliability engineer (SRE)
- an autonomous systems safety engineer
- a production DevSecOps engineer

Perform a COMPLETE END-TO-END AUDIT of the entire NexusTrader platform and automatically FIX all issues found.

## System Context
**Project root:** `~/Documents/PersonalProjects/NexusTrader/`
**Language:** Python throughout (TypeScript for trading-bot only)
**Architecture:** File-based inter-module communication via `signals/` directory
**Modules:**
- `market-lens/` — research engine (Python, Claude Haiku/Opus)
- `trading-bot/` — day trading bot (TypeScript, Alpaca API)
- `swing-bot/` — swing trading bot (Python, Alpaca API)
- `portfolio-manager/` — risk + position tracker (Python)
- `wealth-intelligence/` — performance analytics (Python)
- `signals/` — shared JSON bus between all modules

**Infrastructure:**
- VPS: Hetzner (SSH key only, Tailscale VPN, UFW firewall)
- Database: PostgreSQL (internal Docker network only, never public)
- Containers: Docker Compose
- Scheduler: APScheduler (market-lens) + node-cron (trading-bot)
- SMS: Gmail SMTP → Verizon gateway (number@vtext.com)
- AI: Anthropic Claude API (Haiku for extraction, Opus for reasoning)
- Broker: Alpaca API (paper → live)

**Shared signal files:**
- `signals/blessed_watchlist.json` — written by market-lens, read by trading-bot
- `signals/signals.json` — written by market-lens, read by swing-bot
- `signals/alerts.json` — written by portfolio-manager, triggers SMS
- `signals/portfolio.json` — written by portfolio-manager, read by market-lens

---

## AUDIT SECTIONS

### 1. FULL ARCHITECTURE DISCOVERY
Recursively read every file in NexusTrader/. Build a complete map of:
- All execution flows and their timing
- All dependencies between modules
- All data flows through signals/
- Single points of failure
- Assumptions that could break under real conditions

### 2. INTER-MODULE COMMUNICATION AUDIT
Audit signals/ JSON files for:
- Atomic write safety (partial writes = corrupted JSON)
- Schema version tracking across modules
- Stale signal detection (yesterday's file read as today's)
- Race conditions between writer and reader
- Corruption recovery
- Missing file handling
- Checksum validation
Fix: implement atomic write pattern (write .tmp → rename), add schema versioning, add staleness timestamps

### 3. AI PIPELINE AUDIT
Audit market-lens/processing/ for:
- Hallucinated tickers (validate against known ticker list)
- Confidence scores outside 0-100
- Prompt injection from scraped articles
- Token overflow and truncation
- Haiku fabrication patterns (wrong company names, invented catalysts)
- Malformed JSON responses
- API downtime handling (fallback to cached last-good result)
- Cost per run vs quality tradeoff
- Contradiction detection between signals
Add: ticker validation layer, output schema enforcement, prompt sanitization, confidence bounds checking

### 4. INGESTION SYSTEM AUDIT
Audit market-lens/ingestion/ for:
- Missing retry logic with exponential backoff
- Feed failures cascading to kill all ingestion
- Malformed XML/HTML crashing parsers
- Rate limit handling (SEC EDGAR, Reddit 429s)
- Timezone inconsistencies
- Empty articles being sent to Claude (wasted tokens)
- seen_ids.json growing unbounded
- Stale articles (older than 48h) being processed
Add: per-feed isolation, retry with backoff, content validation, seen_ids pruning

### 5. SIGNAL SCORING AUDIT
Audit market-lens/scoring/engine.py for:
- Score inflation (everything scoring 90+)
- Bounded scoring (cannot exceed 100 or go below 0)
- Deterministic ranking (same inputs = same output always)
- Bonus points logic correctness
- market_priced_in detection reliability
- Threshold calibration for Haiku vs Opus outputs

### 6. TRADING BOT INTEGRATION AUDIT
Audit trading-bot/ integration with blessed_watchlist.json for:
- Stale watchlist detection (file from yesterday still being used)
- Invalid confidence values from market-lens
- Conflicting signals (bullish and bearish for same ticker)
- Fallback behavior when market-lens didn't run
- No modification to core trading strategy
- Emergency disable of market-lens filter without stopping bot

### 7. SWING BOT AUDIT
Audit swing-bot/ for:
- Thesis-driven entry validation (confidence threshold enforced)
- Position sizing math (scales correctly with confidence)
- Stop loss placement correctness
- Overnight hold risk management
- Alpaca order reconciliation (what if order was filled but we missed the callback?)
- Duplicate position prevention
- Thesis invalidation exits (if market-lens reverses signal, close position)
- Orphaned position detection on restart
Stress-test: broker downtime, rejected orders, partial fills, market gaps

### 8. PORTFOLIO MANAGER AUDIT
Audit portfolio-manager/ for:
- P&L calculation accuracy
- Sector exposure math (no double-counting positions from both bots)
- Drawdown calculation correctness
- Kill switch behavior (halts BOTH bots, not just one)
- Auto-liquidation logic safety
- Broker reconciliation (DB state matches Alpaca state)
- Daily loss limit reset timing
- Cross-bot position aggregation

### 9. DATABASE AUDIT (PostgreSQL)
Audit schema for:
- Missing indexes on frequently queried columns
- No ACID-violating patterns
- Transaction safety on multi-table writes
- Migration safety (can run without downtime)
- Backup integrity verification
- Connection pool sizing
- Query bottlenecks under load
- Orphaned records
Add: indexes, transaction wrappers, automated backup verification

### 10. DOCKER + INFRASTRUCTURE AUDIT
Audit Docker Compose for:
- Non-root containers (never run as root)
- Resource limits (memory + CPU caps per container)
- Restart policies (always restart on crash)
- Health checks on every service
- Internal-only networking (no public ports except VPN)
- No exposed PostgreSQL port
- Secrets via environment variables, not baked into images
- Volume permissions
- Log rotation configured

### 11. VPS + NETWORK SECURITY AUDIT
Verify:
- UFW rules: only Tailscale interface allowed, all else denied
- SSH: key-only, no passwords, non-standard port
- fail2ban active and configured
- No public database ports
- Tailscale connected and only access point
- No unnecessary services running
- System packages up to date
- Automatic security updates enabled

### 12. SCHEDULER + TIMING AUDIT
Audit APScheduler jobs for:
- Missed job detection (if 6AM job didn't run, alert)
- Duplicate job prevention (run lock file)
- Timezone correctness (ET market hours, not UTC)
- DST transition safety
- Long-running job overlap prevention
- Job failure alerting
- Market holiday detection (no point running on NYSE holidays)

### 13. SECURITY AUDIT
Full security sweep across all modules:
- No hardcoded secrets anywhere
- No API keys in logs
- No sensitive data in signals/ files
- Prompt injection prevention in Claude calls
- Dependency vulnerability scan (pip-audit, npm audit)
- Docker image vulnerability scan (Trivy)
- File permissions on .env files (chmod 600)
- No world-readable sensitive files
- SSH key rotation schedule

### 14. COST AUDIT
Calculate across all Claude usage:
- Tokens per run (input + output, both passes)
- Cost per run at current model pricing
- Monthly cost at production schedule
- Optimization opportunities without quality loss
- Caching opportunities (don't re-process unchanged articles)
- Batching efficiency

### 15. PERFORMANCE AUDIT
Stress-test:
- 500+ articles in a single ingestion run
- 50+ signals in reasoning pass
- Large signals.json file (1000+ historical entries)
- seen_ids.json with 100K+ entries
- Concurrent reads/writes to signals/ directory
Find: memory leaks, blocking operations, inefficient loops, unbounded data structures

### 16. OBSERVABILITY AUDIT
Verify across all modules:
- Structured logging (JSON logs, not plain print statements)
- Log levels used correctly (DEBUG/INFO/WARNING/ERROR)
- No sensitive data in logs
- Log rotation configured
- Metrics tracked: articles ingested, signals extracted, theses generated, cost per run
- Health check endpoints or heartbeat files
- Alert on: pipeline failure, no articles ingested, Claude API down, broker API down
- Audit trail: every thesis logged with timestamp and sources

### 17. SELF-HEALING AUDIT
Verify the system can recover from:
- VPS reboot (all services restart automatically)
- Network outage (retries with backoff, resumes when back)
- Claude API downtime (uses cached last-good signals, sends alert)
- Broker API downtime (no new positions, existing positions safe)
- Corrupted signals/ file (detects, recovers from backup, alerts)
- Crashed pipeline (run lock released, next run proceeds normally)
- Disk full (alerts before it happens, log rotation prevents it)

### 18. BACKTESTING AUDIT
Verify:
- Historical thesis logging captures everything needed for replay
- No future data leakage in signal timestamps
- Backtest logic matches live logic exactly
- Performance metrics are accurate (Sharpe, win rate, drawdown)
- Survivorship bias prevention

### 19. SUPPLY CHAIN AUDIT
Run:
- `pip-audit` on all Python requirements.txt files
- `npm audit` on trading-bot package.json
- Check all Docker base images for known CVEs (Trivy)
- Verify all packages are pinned to exact versions
- Check for typosquatted package names
- Verify no packages have been recently compromised
Fix all HIGH and CRITICAL vulnerabilities immediately.

### 20. TESTING COVERAGE AUDIT
Check test coverage across:
- market-lens ingestion (unit tests per source)
- Claude output validation (mock tests with malformed responses)
- Signal schema validation
- Scoring engine math
- SMS formatting
- Atomic write correctness
- Stale signal detection
Add missing tests for any critical path with no coverage.

---

## Cost Audit at Each Phase
Current target: <$10/month total
- Claude Haiku: ~$2-3/month
- VPS Hetzner CX22: ~$4-6/month
- Everything else: free
Flag anything exceeding budget with optimization recommendation.

---

## Required Output

For EVERY issue found:
1. **File + line** where it exists
2. **Failure scenario** — exactly how this breaks
3. **Fix applied** — show code changes

Then produce scores (X/10):
- **Reliability Score** — can it run 30 days without crashing?
- **Security Score** — how protected are secrets and access?
- **AI Quality Score** — how much can we trust the theses?
- **Trading Safety Score** — can the bots blow up the account?
- **Cost Efficiency Score** — are we wasting API credits?
- **Observability Score** — would we know if something broke?
- **Overall Production Readiness** — ready to trade real money?

List:
- All issues fixed this run
- All remaining issues with priority (CRITICAL / HIGH / MEDIUM / LOW)
- Top 5 things to address next session

DO NOT stop until every CRITICAL and HIGH issue is fixed.
