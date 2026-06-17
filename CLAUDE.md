# NexusTrader — AI Wealth System

## What This Is
5-module autonomous financial intelligence + trading platform. Python throughout.
Solo developer. Private. Never public.

## Module Map
```
market-lens/        → Python. Research engine. Runs 7AM ET. Writes to signals/. ✅ LIVE
trading-bot/        → TypeScript. Day trading bot. Runs 24/7 as systemd service. ✅ LIVE
swing-bot/          → Python. Multi-day position bot. Runs 9:35AM ET. ✅ LIVE
portfolio-manager/  → Python. Trade recorder + kill switch. Runs 4:30PM ET. ✅ LIVE
wealth-intelligence/→ Python. Daily snapshots + weekly P&L vs SPY. Runs 5PM ET. ✅ LIVE
options-flow/       → Python. Unusual options activity monitor. Runs 8AM ET. ✅ LIVE
earnings-predictor/ → Python. Predicts beats/misses via alt data. Runs 8:30AM ET. ✅ LIVE
proprietary-model/  → Python. Fine-tuned on trade outcome data. ⏳ AFTER DATA
dashboard/          → Next.js web app. Shows everything. ✅ LIVE
signals/            → Shared JSON bus between all modules. ✅ ACTIVE
```

## VPS Cron Schedule (all times ET)
```
7:00 AM  → market-lens          (ingest + Claude reasoning → signals.json)
8:00 AM  → options-flow         (scan top tickers for unusual options activity → options_signals.json)
8:30 AM  → earnings-predictor   (alt data: trends, app store, jobs → earnings_predictions.json)
9:35 AM  → swing-bot            (enter positions from signals.json)
4:30 PM  → portfolio-manager (detect closes, record trades, kill switch)
5:00 PM  → wealth-intelligence (snapshot portfolio value, Friday = weekly report)
24/7     → trading-bot       (systemd service, always running)
```

## Signals Directory (full)
```
signals/
├── signals.json                → written by market-lens, read by swing-bot + dashboard
├── blessed_watchlist.json      → written by market-lens, read by trading-bot
├── options_signals.json        → written by options-flow, read by swing-bot
├── earnings_predictions.json   → written by earnings-predictor, read by swing-bot
├── portfolio.json              → written by swing-bot, read by portfolio-manager + dashboard
└── kill_switch.json            → written by portfolio-manager, read by swing-bot
```

## DONE — Options confirmation wired into swing-bot (swing-bot/signals_reader.py)
`get_actionable_buys()` applies, in order:
- earnings-predictor: skip tickers on the `avoid` list (predicted miss within 7 days)
- options-flow: skip bearish options sentiment; +5 score if bullish; no data = no penalty
- ORB brain: +5 if ORB has >60% WR & trending on that ticker, -5 if <40% WR

## Current Focus (as of June 2 2026)
**Data-collection phase — proving the edge, not chasing profit.**
All modules are LIVE (dashboard included). Clean equity record is ~36% WR over 14 trades,
roughly flat — too few to judge. Posture: stay selective, do NOT increase trade volume while
unprofitable, collect clean outcome data. Next real lever is a market-lens signal-quality
feedback loop, but it can't be built until ~50+ clean trades exist (building on thin data =
confident nonsense). See memory: data-quality-and-edge, orb-may30-fix-pass, orb-brain-quarantine.
Recorder now guards out TEST/crypto rows + backfills sector so future data is trustworthy.

## Architecture Decision Log
- SMS removed — Verizon drops messages, costs money, user won't act on texts
- Dashboard replaces SMS — one URL shows everything visually
- No cron job on Mac — will run on VPS only (DigitalOcean, ~$6/mo)
- Anthropic key disabled when not in active use — re-enable for runs only

## Key Files
- `market-lens/main.py` — pipeline: ingest → extract → reason → score → write signals/
- `market-lens/config/settings.py` — all settings, API keys via .env
- `market-lens/config/sources.py` — RSS feeds, tickers, subreddits
- `market-lens/ingestion/` — rss.py, sec_edgar.py, reddit.py
- `market-lens/processing/` — extractor.py (Claude pass 1), reasoner.py (Claude pass 2)
- `market-lens/scoring/engine.py` — ranks theses, picks top 5
- `signals/` — signals.json, blessed_watchlist.json, alerts.json, portfolio.json

## Credentials (market-lens/.env — never commit)
- ANTHROPIC_API_KEY — set (disable when not running)
- SMS creds — kept in .env but SMS is disabled in code

## Stack
- AI: Claude Haiku (both passes, ~$0.01/run)
- Broker: Alpaca API (free paper trading)
- Storage: JSON files now → PostgreSQL on VPS later
- Output: Next.js dashboard (replaces SMS)
- Hosting: DigitalOcean VPS (~$6/mo) — not yet set up
- VPN: Tailscale (free) — not yet set up

## Run Commands (only run manually — no cron on Mac)
```bash
cd market-lens && source .venv/bin/activate
python main.py --ingest    # ingest only, $0 cost
python main.py --dry-run   # full Claude pipeline, ~$0.01, no output
python main.py             # full pipeline, writes to signals/
```

## Module Communication
- signals.json → read by dashboard + swing-bot
- blessed_watchlist.json → read by trading-bot (direction filter)
- alerts.json → read by portfolio-manager
- portfolio.json → written by portfolio-manager

## Cost Budget
- Haiku API: ~$0.21/mo (1 run/weekday)
- DigitalOcean VPS: ~$6/mo
- Everything else: free
- Target: under $10/mo total

## Build Order Remaining
1. Build Next.js dashboard (reads signals.json, shows thesis + bot status) ✅
2. Set up DigitalOcean VPS ✅
3. Deploy market-lens to VPS with 7AM cron ✅
4. Connect trading-bot blessed_watchlist filter ✅
5. Build swing-bot ✅
6. Build portfolio-manager ✅
7. Build wealth-intelligence ✅
8. Build options-flow ← NEXT
9. Build earnings-predictor ← NEXT
10. Build proprietary-model ← AFTER DATA ACCUMULATES

## Swing Bot — Ideal Version (target: after this week)
Current: trades purely from market-lens signals (news, SEC, insider, macro).
Ideal: market-lens identifies opportunity → options-flow confirms smart money agrees
→ technical levels give clean entry → swing-bot executes.
Do NOT go live with real money until confirmation layer is added.

## Proprietary Model Plan
- portfolio-manager records every trade outcome against original thesis
- After 3-6 months of data, fine-tune a model on thesis → outcome pairs
- Model learns what signal combinations actually predict wins for this strategy
- Nobody can replicate it — dataset is unique to NexusTrader's trade history
