# AI Trading Bot

Autonomous multi-agent equity trading bot in Node.js/TypeScript. Paper trades long and short breakout strategies every day via Alpaca. Runs on a DigitalOcean VPS — no laptop required. Trains itself from every trade.

---

## Where the Bot Lives

The bot runs on a **DigitalOcean VPS at `<VPS_IP>`** as a systemd service. It starts automatically every day, trades during market hours, and restarts itself if it crashes. Your laptop does not need to be on.

---

## How to Access the Bot

### Check if it's running
```bash
ssh root@<VPS_IP> 'systemctl status trading-bot'
```

### Watch live logs
```bash
ssh root@<VPS_IP> 'tail -f /opt/nexustrader/orb-bot/logs/bot.log'
```

### Restart it (after a code update)
```bash
ssh root@<VPS_IP> 'systemctl restart trading-bot'
```

### Stop it
```bash
ssh root@<VPS_IP> 'systemctl stop trading-bot'
```

### Start it
```bash
ssh root@<VPS_IP> 'systemctl start trading-bot'
```

---

## How to Deploy Code Changes

Any time you edit the bot on your Mac, you need to push the changes to the server. One command does everything — syncs code, copies .env, restarts the service:

```bash
cd /Users/maitreypatel/Documents/PersonalProjects/My-AI-Trading-Bot
./deploy/deploy.sh
```

The bot on the server will restart automatically with the new code.

---

## Dashboard

The dashboard runs locally on your Mac — it reads logs from the server's session files. To view it:

```bash
cd dashboard && npm run dev
```

Then open **http://localhost:3001** in your browser.

The dashboard does not need to be running for the bot to trade.

---

## Strategy — 5 Entry Signals, 3 Trading Windows

The bot runs three independent windows every trading day (Mon–Fri). Each window is fully independent — if ORB misses, Midday and Power Hour still run.

### Long Strategies
1. **ORB Breakout** — close above ORH with VWAP reclaim + volume surge
2. **VWAP Reclaim** — price pulls back to VWAP after breaking ORH, reclaims with volume
3. **Mean Reversion** — oversold bounce off VWAP support

### Short Strategies
4. **ORB Breakdown** — close below ORL with volume confirmation → short entry
5. **VWAP Rejection Short** — price spikes into VWAP zone, fails, closes below → short entry

All 5 strategies are backtested over 6 months on the full watchlist.

---

### Window 1 — ORB (Opening Range Breakout)

| Phase | Time (ET) | What happens |
|---|---|---|
| Health ping | 8:50 AM | Alpaca connectivity check + Discord heartbeat |
| Pre-market | 9:00 AM | VIX, calendar, SPY/QQQ pre-market bias, earnings filter |
| Range building | 9:30–9:44 | Collect 1m candles to form ORH/ORL |
| Breakout watch | 9:45–10:15 | Enter long or short on confirmed breakout with volume |
| Manage only | 10:15–10:30 | No new entries, trail stops, partial profits |
| Hard close | 10:30 AM | Close ALL ORB positions |

---

### Window 2 — Midday

| Phase | Time (ET) | What happens |
|---|---|---|
| Range | 9:30–10:30 | First full hour becomes the midday range |
| Scan | 11:00 AM–1:00 PM | Enter on breakout or VWAP rejection short |
| Hard close | 1:15 PM | Close ALL midday positions |

---

### Window 3 — Power Hour

| Phase | Time (ET) | What happens |
|---|---|---|
| Range | 1:15–2:30 PM | Consolidation range built from afternoon candles |
| Range lock | 2:30 PM | Consolidation range locked |
| Scan | 3:00–3:55 PM | Enter on breakout of consolidation range |
| Hard close | 3:55 PM | Close ALL positions + run end-of-session analysis |

---

## Watchlist

| Symbol | Backtest WR | Profit Factor | Notes |
|---|---|---|---|
| QQQ | 56% | 1.75 | Core — most reliable |
| IWM | 58% | 1.67 | Core — most reliable |
| GOOGL | 54% | 1.95 | Best profit factor |
| NVDA | 53% | 1.61 | High volatility |
| TSLA | 48% | 1.29 | Weaker but passes |
| META | 52% | 1.22 | Weaker but passes |
| AAPL | 60% | 1.31 | Higher confidence threshold (0.68) |

AMZN was removed — negative expectancy in backtesting (PF 0.96).

---

## Agents

| # | Agent | Role |
|---|---|---|
| 1 | ORB Analyst | Orchestrates all 5 entry signals per symbol per window |
| 2 | Brain | 4-layer self-training: adaptive weights, regime memory, post-trade lessons, per-symbol memory |
| 3 | HMM Regime | Hidden Markov Model — classifies market as crash/bear/neutral/bull/euphoria |
| 4 | Pre-market Filter | VIX, economic calendar, SPY/QQQ pre-market % move, earnings proximity |
| 5 | Macro | SPY trend + VIX → market environment score |
| 6 | Sentiment | News + Reddit → directional sentiment score (cached per session) |
| 7 | Whale | Order book imbalance + relative volume + options put/call ratio |
| 8 | Journal | Session logging, direction-aware P&L, Sharpe/Sortino/max drawdown |
| 9 | ARIA (Cerebras LLM) | Morning brief, trade narratives, post-trade lesson generation |

---

## Brain — Self-Training System

The bot gets smarter every day. Four learning layers stored in `logs/brain/`:

| Layer | File | What it learns |
|---|---|---|
| Adaptive weights | `adaptive-weights.json` | Which signals predict wins vs losses |
| Regime memory | `regime-memory.json` | Win rate + position size multiplier per HMM regime |
| Post-trade lessons | `lessons.json` | ARIA writes a lesson after every trade |
| Per-symbol memory | `coin-memory.json` | Win rate, confidence adjustment, size multiplier per symbol |

Re-seed the brain from 6 months of backtest data (run after any major code change):
```bash
npm run backtest -- --train
```

---

## Risk Controls

| Constraint | Value |
|---|---|
| Risk per trade | 1% of portfolio |
| Stop-loss | ORB midpoint (long) / midpoint above entry (short) |
| Take-profit | 2.0× range size (ORB) / 1.5× (Midday + Power Hour) |
| Daily loss kill switch | −2% of portfolio → halt all windows |
| Consecutive loss circuit breaker | 3 losses → halt new entries |
| VIX kill switch | VIX > 40 → no trading |
| Min cash reserve | 20% always held back |
| AAPL confidence override | 0.68 minimum (vs 0.55 default) |

---

## Audit

Run the full 51-check automated audit before any live trading session:
```bash
npm run audit
```

Or use the `/audit-trading-bot` skill in Claude Code for a full deep audit including backtest verification, TypeScript validation, and dashboard consistency checks.

---

## File Layout

```
src/
  index.ts                — Orchestrator: schedules all 3 windows
  config.ts               — Single source of truth for all settings
  agents/
    orbAnalyst.ts         — All 5 signal detectors, scoring, entry logic
    brain.ts              — 4-layer self-training system
    hmmRegime.ts          — Hidden Markov Model regime classifier
    preMarketFilter.ts    — Morning go/no-go decision
    journal.ts            — Direction-aware trade logging + session analysis
    auditAgent.ts         — 51 automated checks
    macro.ts              — SPY/VIXY trend scoring
    sentiment.ts          — News + Reddit sentiment scoring
    whale.ts              — Order book + volume + options scoring
  core/
    executionEngine.ts    — Alpaca order placement (long + short)
    positionManager.ts    — Direction-aware stops, partials, break-even
    riskManager.ts        — Portfolio state, exposure limits
    orbBacktester.ts      — 3-simulation historical replay engine
  strategy/
    openingRange.ts       — Range building, all signal detection functions
  tools/
    marketData.ts         — Alpaca price API calls
    indicators.ts         — RSI, MACD, EMA, ATR, VWAP

deploy/
  deploy.sh               — One-command deploy to VPS
  trading-bot.service     — systemd service definition

dashboard/                — Local Next.js dashboard (run on Mac only)

logs/
  bot-YYYY-MM-DD.log      — Daily bot output
  brain/                  — Adaptive learning files
  journal/                — Per-day Markdown trade journals
  sessions/               — Per-day JSON session data (source of truth for dashboard)
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Language | Node.js + TypeScript (ESM, tsx runner) |
| AI | Cerebras API (Llama 3.1 8B) |
| Broker | Alpaca Markets API (paper trading) |
| Price data | Alpaca Market Data API |
| Hosting | DigitalOcean VPS ($6/month) — systemd service |
| Notifications | Discord Webhook |
| Scheduler | node-cron |
| Dashboard | Next.js (local Mac only) |
