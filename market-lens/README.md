# market-lens

Autonomous AI investment research engine and personal wealth system. Continuously monitors global events, performs deep multi-source research, identifies second and third-order effects, and delivers ranked investment theses to your phone every morning.

**This is Module 1 of a 5-module personal AI wealth system.**

---

## The Master System

```
WORLD EVENTS / NEWS / SEC FILINGS / REDDIT / OPTIONS FLOW
                          ↓
              MODULE 1 — MARKET LENS
              Deep research engine. Runs 6AM daily.
              Ingests → Extracts → Reasons → Ranks → Delivers
                          ↓
          ┌───────────────────────────────┐
          ↓                               ↓
blessed_watchlist.json              signals.json
(ticker, direction, confidence)     (full thesis, evidence, risks)
          ↓                               ↓
MODULE 2B — DAY TRADING BOT      MODULE 2 — SWING TRADING BOT
(existing bot — upgraded)         (new bot — to build)
Reads watchlist at 9:20AM         Reads signals at 9:25AM
Filters trades by direction       Opens multi-day positions
Only longs on bullish tickers     On confidence >= 70 theses
Only shorts on bearish tickers    Holds days to weeks
          ↓                               ↓
          └───────────────┬───────────────┘
                          ↓
              MODULE 3 — PORTFOLIO MANAGER
              Tracks ALL positions from both bots
              Monitors Market Lens for risk to held positions
              Enforces daily loss limits, halts bots if needed
              Auto-closes positions on new negative signals
              Tracks P&L, drawdown, win rate, sector exposure
                          ↓
              MODULE 4 — WEALTH INTELLIGENCE
              Weekly/monthly performance reports via SMS
              Net worth tracking over time
              Tax-loss harvesting suggestions
              Long-term scenario modeling
              S&P 500 benchmark comparison
                          ↓
              MODULE 5 — PROPRIETARY EDGE
              12+ months of logged theses + outcomes
              Fine-tune a model on YOUR data
              Learns what actually predicts wins in your strategy
              A moat no retail investor has
```

---

## Module 1 — Market Lens (Building Now)

### What It Does

Not headline summarization. Deep recursive causal reasoning:

```
Example: Iran uses cheap drones, US intercepts with expensive missiles
  → economic imbalance detected ($0.10 laser vs $80K missile)
  → laser defense systems emerging as logical military adaptation
  → identify companies building directed energy systems
  → identify their suppliers and component manufacturers
  → analyze defense contracts, patents, R&D filings
  → check if market has priced this in yet
  → estimate congressional budget and adoption timeline
  → score companies by exposure and asymmetric upside
  → deliver thesis with confidence score, risks, and all sources
```

Every briefing traces:
**World Event → Affected Sectors → Specific Companies → Evidence → Confidence → Risk**

### Pipeline

```
6:00AM — Ingest RSS feeds, SEC filings, Reddit, options flow, insider filings
6:10AM — Claude extracts investment signals from all articles
6:20AM — Claude runs deep causal reasoning on extracted signals
6:30AM — Scoring engine ranks by confidence, novelty, source count
6:35AM — Write blessed_watchlist.json and signals.json
6:40AM — Format and send multi-part SMS brief to phone
9:20AM — Day bot reads blessed_watchlist.json before market open
9:25AM — Swing bot reads signals.json before market open
```

### Data Sources (all free)

| Source | What we get |
|---|---|
| SEC EDGAR | 8-K, 10-Q, 10-K filings for all watchlist tickers |
| SEC Form 4 | Insider buying/selling in real time |
| RSS feeds | Yahoo Finance, Reuters, MarketWatch, FT, DefenseNews, OilPrice |
| Reddit | r/investing, r/stocks, r/SecurityAnalysis, r/wallstreetbets |
| Federal Reserve | Policy releases, meeting minutes |
| Unusual Whales RSS | Unusual options flow — smart money footprints |
| Google News RSS | Broad macro and geopolitical coverage |
| Company press releases | Direct from IR pages |

### Sectors Monitored

- Technology (AI, cloud, software)
- Defense & Aerospace
- Energy (oil, LNG, renewables)
- Finance & Banking
- Rare Earth & Materials
- Healthcare & Biotech
- Semiconductors (treated separately — cross-sector impact)
- Macro (Fed, inflation, geopolitics — affects everything)

### SMS Delivery Format

Multi-part text to phone via Verizon gateway (number@vtext.com). No app, no login.

```
[1/5] MARKET LENS — May 15
━━━━━━━━━━━━━━━━━━━━
TODAY'S SIGNALS
━━━━━━━━━━━━━━━━━━━━
🔴 CRITICAL — Defense Tech
🟡 HIGH — Energy/LNG
🟠 MEDIUM — Semiconductors
🟢 WATCH — Finance

[2/5] 🔴 AXON ($AXON) — 87/100
Thesis: Pentagon $400M directed energy contract.
Laser cost $0.10 vs $80K missile. 3 independent
sources confirm. Not yet priced in.
CATALYST: DoD contract + patent filings surge
RISK: Congressional budget approval pending
VERDICT: BUY_WATCH | Horizon: weeks

[3/5] 🟡 EXXON ($XOM) — 71/100
Thesis: Houthi activity rerouting LNG tankers
+18% freight cost. EU buyers locking in US LNG.
CATALYST: Shipping data + 3 analyst reports
RISK: Ceasefire negotiations could reverse fast
VERDICT: BUY_WATCH | Horizon: days

[4/5] 🟠 NVIDIA ($NVDA) — 63/100
Thesis: Chip export rule draft leaked. H100
restrictions to 6 countries possible. Rule not
finalized — early signal, unconfirmed.
VERDICT: MONITOR | Horizon: weeks

[5/5] ━━━━━━━━━━━━━━━━━━━━
Also watch: KTOS, FSLR, ALB
Sources verified: 22 | Contradicting: 3
Insider buys today: MP, LMT
Options unusual: AXON calls +340%
Next brief: Tomorrow 6AM
━━━━━━━━━━━━━━━━━━━━
```

---

## Module 2 — Swing Trading Bot (To Build)

- Reads `signals.json` from Market Lens at 9:25AM
- Only acts on confidence >= 70 AND market_priced_in = false
- Position size scales with confidence score (within hard risk limits)
- Holds days to weeks until thesis resolves or stop-loss hit
- Executes via Alpaca API (free)
- Logs every trade with the thesis that triggered it
- Sends SMS on entry and exit

---

## Module 2B — Day Trading Bot (Existing — To Upgrade)

Current state: trades on technicals alone, no macro context.

Upgrade plan (minimal change, high impact):
- Add one step at 9:20AM: read `blessed_watchlist.json`
- Only take LONG setups on BULLISH tickers
- Only take SHORT setups on BEARISH tickers
- Skip any ticker not on the blessed list entirely
- Core day trading logic unchanged — just a directional filter on top

This single upgrade eliminates trades where the macro wind is against you.

---

## Module 3 — Portfolio Manager (To Build)

- Runs continuously during market hours
- Tracks all open positions from both bots in PostgreSQL
- Monitors Market Lens signal feed in real time
- If new negative signal appears for a held position → SMS alert immediately
- If negative signal confidence > threshold → auto-close position
- Enforces sector concentration limits (no more than X% in one sector)
- Enforces hard daily loss limit → halts both bots if breached
- Tracks per-bot: P&L, win rate, drawdown, average hold time

---

## Module 4 — Wealth Intelligence (To Build)

- Runs weekly and monthly
- Aggregates all P&L from Portfolio Manager
- Tracks net worth trajectory over time
- Identifies tax-loss harvesting opportunities before year-end
- Models long-term scenarios: "at current win rate, 12-month projected growth = X"
- Compares performance vs S&P 500 benchmark
- Sends weekly SMS performance digest

---

## Module 5 — Proprietary Edge (12+ Months Out)

After the system runs for a year:
- Every thesis logged: signals used, reasoning, confidence score
- Every trade logged: entry, exit, P&L, hold time
- Every outcome recorded: did the thesis play out? how long did it take?

This dataset is unique. No retail investor has it.

Use it to fine-tune a small language model that learns:
- Which signal combinations actually predict wins in YOUR strategy
- Which sources are most predictive
- Which sector patterns repeat
- What confidence score threshold actually means something in practice

---

## Future Modules (Planned)

| Module | What it does | Why powerful |
|---|---|---|
| **Earnings Predictor** | Before earnings: scrapes job postings, app store rankings, web traffic, supplier filings to predict beat/miss | Catches moves before announcement |
| **Insider Signal Tracker** | Monitors SEC Form 4 in real time for unusual insider buying clusters | Insiders know things. Legal to track. |
| **Patent Intelligence** | Scrapes USPTO filings by company to detect R&D activity | Predicts products and pivots 2-3 years out |
| **Options Flow Monitor** | Tracks unusual options activity via Unusual Whales RSS | Smart money leaves footprints before moves |
| **Geopolitical Early Warning** | Monitors government statements, sanctions, troop movements | Defense/energy plays before mainstream media |
| **Supply Chain Tracker** | Monitors shipping data, port congestion, commodity prices | Detects shortages and surpluses early |
| **Sentiment Divergence Detector** | Finds stocks where news is positive but price falling (or vice versa) | Catches mispricings before correction |
| **Macro Calendar Bot** | Pre-models impact of Fed meetings, CPI, jobs reports on held positions | Never caught off-guard by scheduled events |

---

## Inter-Module Communication

Modules talk via JSON files in a shared `/signals/` directory. Simple, reliable, no infrastructure needed.

```
signals/
├── blessed_watchlist.json   # ticker, direction, confidence — read by day bot
├── signals.json             # full theses — read by swing bot
├── portfolio.json           # current positions — read by portfolio manager
└── alerts.json              # risk alerts — triggers SMS immediately
```

Future upgrade path: replace JSON files with Kafka message queue if scale requires it.

---

## Tech Stack (Python Throughout)

| Layer | Tool |
|---|---|
| Language | Python 3.11+ |
| AI Reasoning | Anthropic Claude API (Opus for reasoning, Haiku for extraction) |
| Brokerage | Alpaca API (free paper + live trading) |
| Storage | PostgreSQL (structured), JSON files (inter-module), Qdrant (vectors, later) |
| Scheduler | APScheduler |
| SMS Delivery | SMTP via Gmail → Verizon gateway (number@vtext.com) |
| Data sources | All free (SEC EDGAR, RSS, Reddit JSON API, Fed RSS, Unusual Whales) |

---

## Project Structure

```
market-lens/               ← Module 1 (this repo)
├── ingestion/
│   ├── rss.py             # RSS feed fetcher + deduplication
│   ├── sec_edgar.py       # SEC filings fetcher + CIK mapper
│   ├── reddit.py          # Reddit hot posts fetcher
│   ├── insider.py         # SEC Form 4 insider filings (to build)
│   └── options_flow.py    # Unusual Whales RSS (to build)
├── processing/
│   ├── extractor.py       # Claude call 1: signal extraction
│   └── reasoner.py        # Claude call 2: deep causal reasoning
├── scoring/
│   └── engine.py          # multi-factor scoring + ranking
├── briefing/
│   ├── formatter.py       # SMS message formatter
│   └── sms.py             # Verizon gateway sender
├── storage/
│   └── db.py              # PostgreSQL models (to build)
├── config/
│   ├── settings.py        # API keys, thresholds, schedule
│   └── sources.py         # all RSS feeds, ticker watchlists, subreddits
├── signals/               # shared output directory (read by other bots)
│   ├── blessed_watchlist.json
│   ├── signals.json
│   └── alerts.json
├── main.py                # daily pipeline entry point
├── requirements.txt
└── .env.example
```

---

## Build Order

### Phase 1 — Market Lens (Now)
- [x] Project scaffold + full vision documented
- [x] Config: settings, sources, watchlists
- [x] Ingestion: RSS, SEC EDGAR, Reddit
- [ ] Ingestion: SEC Form 4 insider tracker
- [ ] Ingestion: Unusual Whales options flow
- [ ] Processing: Claude signal extraction
- [ ] Processing: Claude deep causal reasoning
- [ ] Scoring: multi-factor ranking engine
- [ ] Briefing: SMS formatter + Verizon sender
- [ ] Output: blessed_watchlist.json + signals.json
- [ ] Scheduler: APScheduler 6AM daily run
- [ ] Storage: PostgreSQL for history + backtesting

### Phase 2 — Bot Integration
- [ ] Day bot: add blessed_watchlist.json directional filter
- [ ] Swing bot: build new bot reading signals.json via Alpaca

### Phase 3 — Portfolio Manager
- [ ] Track positions from both bots
- [ ] Real-time risk monitoring
- [ ] Auto-close on negative signals
- [ ] Daily loss limit enforcement

### Phase 4 — Wealth Intelligence
- [ ] P&L aggregation + net worth tracking
- [ ] Weekly SMS performance digest
- [ ] S&P 500 benchmark comparison

### Phase 5 — Proprietary Edge
- [ ] Thesis + outcome logging
- [ ] Model fine-tuning pipeline

### Phase 6 — Future Modules
- [ ] Earnings predictor
- [ ] Patent intelligence
- [ ] Geopolitical early warning
- [ ] Supply chain tracker
- [ ] Macro calendar bot

---

## Cost Strategy

Designed to run cheap now, scale up later when budget allows.

| Item | Now (cheap) | Later (powerful) |
|---|---|---|
| AI model | Claude Haiku (extraction) + Haiku (reasoning) | Haiku + Opus |
| Storage | SQLite flat files | PostgreSQL on VPS |
| Hosting | Runs locally on your Mac | $5/mo VPS (DigitalOcean) |
| Data | 100% free sources | Add premium feeds |
| Broker | Alpaca paper trading (free) | Alpaca live |
| Vector DB | Skip for now | Qdrant later |
| **Monthly total** | **~$3-5/mo** | **~$20-30/mo** |

**Current cost target: under $5/month.**
- Use Claude Haiku for BOTH extraction and reasoning passes (10x cheaper than Opus)
- Upgrade extraction pass to Opus only once system is proven
- SQLite instead of PostgreSQL until data volume requires upgrade
- Run on your Mac via cron job — no server needed yet

---

## Key Constraints

- **Never claims certainty.** Always confidence scores + evidence + contradicting signals.
- **Free data only.** No paid subscriptions beyond Claude API (~$3-5/month).
- **Explainable by default.** Every conclusion traces to source articles.
- **Resistant to misinformation.** Cross-verifies across independent sources.
- **Built to connect.** Clean JSON output format for all downstream bots.
- **Python throughout.** Every module, every bot, same language.
- **Cost-first now, power later.** Architecture supports upgrades without rewrites.

---

## Setup Instructions (Do This Once)

### 1. Get Your Anthropic API Key
1. Go to **console.anthropic.com**
2. Sign up → API Keys → Create Key → name it `nexustrader`
3. Copy the key (starts with `sk-ant-...`) — shown only once
4. New accounts get $5 free credit (~1-2 months of Haiku usage)

### 2. Add Your Key to .env
Open `market-lens/.env` and replace the placeholder:
```
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
SMS_EMAIL=your10digits@vtext.com
SENDER_EMAIL=yourgmail@gmail.com
SENDER_PASSWORD=your_gmail_app_password
```
**This file is blocked by `.gitignore` — it will never be committed or exposed.**

### 3. Create and Activate the Virtual Environment
Every time you open a new terminal to work on this project, run:
```bash
cd ~/Documents/PersonalProjects/NexusTrader/market-lens
source .venv/bin/activate
```
You'll see `(.venv)` at the start of your terminal prompt — that means it's active.

**Create it (first time only):**
```bash
cd ~/Documents/PersonalProjects/NexusTrader/market-lens
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**In VS Code:** It will auto-detect `.venv` and ask you to select it as the Python interpreter. Click yes. If it doesn't ask: `Cmd+Shift+P` → "Python: Select Interpreter" → pick the one that says `.venv`.

### 4. Run the First Test (Ingestion Only — No API Cost)
```bash
python main.py --ingest
```
This pulls articles from RSS, SEC, and Reddit and prints them to the terminal.
No Claude calls, no SMS, no cost. Just confirms the data pipeline works.

### 5. Run the Full Pipeline
```bash
python main.py
```
This runs everything: ingest → extract signals → reason → score → send SMS.
**Only run this after your `.env` is filled in.**

### 6. Schedule Daily 6AM Run (Mac)
```bash
crontab -e
```
Add this line:
```
0 6 * * 1-5 cd ~/Documents/PersonalProjects/NexusTrader/market-lens && source .venv/bin/activate && python main.py >> logs/cron.log 2>&1
```
This runs automatically Monday–Friday at 6AM. Your Mac needs to be on (or on VPS — see below).

---

## Virtual Environment Rules

| Rule | Why |
|---|---|
| Always activate `.venv` before running anything | Ensures you're using project dependencies, not system Python |
| Never install packages without `.venv` active | Pollutes system Python and breaks isolation |
| After adding a new package, run `pip freeze > requirements.txt` | Keeps requirements in sync |
| Each module (swing-bot, portfolio-manager) gets its own `.venv` | Keeps dependencies fully isolated per project |
