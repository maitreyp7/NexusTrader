# NexusTrader

Personal autonomous AI wealth system. Multiple connected modules working together to research, execute, manage, and grow a trading portfolio — with no manual news reading, no manual research, and no guesswork.

---

## System Map

All times ET. All modules are LIVE on the VPS (cron times in UTC noted per module).

```
WORLD EVENTS / NEWS / SEC FILINGS / INSIDER / REDDIT / MACRO
                          ↓
              market-lens/          [Python] — 8:00 AM ET (12:00 UTC)
              Research engine. Ingest(6) → Extract(Claude) → Reason(Claude) → Rank
                          ↓
              signals/  [Shared JSON bus — atomic writes, date-stamped]
              ├── signals.json            (full ranked theses)
              ├── blessed_watchlist.json  (BUY_WATCH tickers)
              ├── options_signals.json    (from options-flow)
              ├── earnings_predictions.json (from earnings-predictor)
              ├── orb_brain_export.json   (ORB learning state)
              ├── swing_outcomes.json     (swing trade results)
              ├── risk_budget.json        (per-bot exposure caps)
              ├── kill_switch.json        (emergency halt)
              └── portfolio.json          (swing positions)
                          ↓
   options-flow (9:00) + earnings-predictor (9:30) enrich signals.json
                          ↓
        ┌─────────────────────────────────┐
        ↓                                 ↓
  trading-bot/  [TypeScript]        swing-bot/  [Python] — 9:35 AM ET
  ORB intraday bot. 24/7 systemd.   Multi-day positions. Reads signals.json
  3 windows (ORB/Midday/Power).     + options + earnings + ORB brain.
  Direction-aware scoring.          Kelly sizing, trailing stops, time-stops.
  Reads blessed_watchlist + biases. Holds days to weeks. Alpaca API.
        ↓         ↑ cross-feed ↑           ↓
        │   (ORB brain → swing,            │
        │    swing outcomes → ORB)         │
        └──────────────┬──────────────────┘
                       ↓
            portfolio-manager/    [Python] — 4:30 PM ET (20:30 UTC)
            Records ALL trades from both bots. Writes risk_budget.json
            (ORB 20% / swing 40% caps). Trips kill_switch.json on breach.
                       ↓
            wealth-intelligence/  [Python] — 5:00 PM ET (21:00 UTC)
            Daily snapshot + 7-day return vs SPY. Friday = weekly report.
                       ↓
            [Future] proprietary-model/
            Fine-tuned on YOUR thesis + outcome data.
```

---

## Modules

| Folder | Language | Status | Purpose |
|---|---|---|---|
| `market-lens/` | Python | Live | Research engine — the brain |
| `trading-bot/` | TypeScript | Live (paper) | ORB intraday bot (24/7 systemd) |
| `swing-bot/` | Python | Live | Multi-day position bot |
| `options-flow/` | Python | Live | Unusual options activity scanner |
| `earnings-predictor/` | Python | Live | Alt-data beat/miss prediction |
| `portfolio-manager/` | Python | Live | Risk + trade recorder + kill switch |
| `wealth-intelligence/` | Python | Live | Performance + net worth + SPY benchmark |
| `dashboard/` | Next.js | Live | Web UI (port 3000) |
| `signals/` | JSON | Active | Shared data bus between all modules |

---

## Signals Directory (Shared Data Bus)

All modules communicate through `/signals/`. No message queue needed at this scale.

```
signals/
├── signals.json              # market-lens → swing-bot, options-flow, earnings-predictor, ORB (bias)
├── blessed_watchlist.json    # market-lens → ORB bot + swing-bot
├── options_signals.json      # options-flow → swing-bot (skip bearish, +5 bullish)
├── earnings_predictions.json # earnings-predictor → swing-bot (avoid predicted misses)
├── orb_brain_export.json     # ORB bot → swing-bot (per-ticker confidence boost)
├── swing_outcomes.json       # swing-bot → ORB bot (pre-market bias)
├── risk_budget.json          # portfolio-manager → both bots (ORB 20% / swing 40% caps)
├── kill_switch.json          # portfolio-manager → both bots (emergency halt)
└── portfolio.json            # swing-bot/portfolio-manager → dashboard
```

Note: SMS was removed — the dashboard (port 3000) is the output layer. `alerts.json` no longer exists.

### blessed_watchlist.json — example
```json
{
  "generated_at": "2026-05-15T06:35:00",
  "date": "2026-05-15",
  "tickers": [
    {
      "ticker": "NVDA",
      "direction": "bullish",
      "confidence": 87,
      "time_horizon": "days",
      "thesis_summary": "Datacenter demand surge confirmed across 3 sources. Export rule concern overblown."
    },
    {
      "ticker": "XOM",
      "direction": "bullish",
      "confidence": 71,
      "time_horizon": "days",
      "thesis_summary": "LNG rerouting driving freight cost surge. EU contracts accelerating."
    }
  ]
}
```

### signals.json — example
```json
{
  "generated_at": "2026-05-15T06:35:00",
  "date": "2026-05-15",
  "theses": [
    {
      "ticker": "AXON",
      "company": "Axon Enterprise",
      "sector": "defense",
      "verdict": "BUY_WATCH",
      "confidence": 87,
      "market_priced_in": false,
      "time_horizon": "weeks",
      "thesis": "Pentagon awarded $400M directed energy contract...",
      "catalysts": ["DoD contract filing", "Patent surge in Q1", "3 analyst upgrades"],
      "risks": ["Congressional budget approval pending"],
      "sources": ["SEC 8-K 2026-05-14", "DefenseNews RSS", "r/SecurityAnalysis"],
      "second_order_beneficiaries": ["KTOS", "MRCY"]
    }
  ]
}
```

---

## How the Two Bots Work Together

```
Market Lens says: NVDA bullish, confidence 87
        ↓
trading-bot reads blessed_watchlist.json at 9:20AM
  → only takes LONG setups on NVDA today
  → skips all short signals on NVDA
  → core strategy unchanged — just directional filter added
        ↓
swing-bot reads signals.json at 9:25AM
  → confidence 87 >= 70 threshold AND not priced in
  → opens a multi-day long position on NVDA
  → holds until thesis resolves or stop-loss hit
        ↓
portfolio-manager sees both bots hold NVDA
  → tracks combined exposure, writes risk_budget.json (ORB 20% / swing 40% caps)
  → if daily loss limit breached → trips kill_switch.json (both bots halt new entries)
  → records every closed trade to the permanent trade log
```

---

## Cost Budget

| Item | Cost |
|---|---|
| Claude Haiku API | ~$2-3/month |
| Everything else | Free |
| **Total** | **~$3/month now** |

Upgrade path when ready:
- Claude Opus for reasoning pass → +$10/month, significantly better theses
- Alpaca Unlimited → $9/month, 6× better volume data for trading-bot
- VPS hosting → $5-10/month, run 24/7 without your Mac staying on

---

## Build Order

- [x] NexusTrader folder structure
- [x] market-lens — full ingest/extract/reason/rank pipeline, live
- [x] trading-bot (ORB) — live on paper, blessed_watchlist filter + direction-aware scoring
- [x] swing-bot — live, reads signals + options + earnings + ORB brain
- [x] options-flow — live
- [x] earnings-predictor — live
- [x] portfolio-manager — live (risk budget + kill switch + trade log)
- [x] wealth-intelligence — live (snapshots + weekly SPY benchmark)
- [x] dashboard — live (port 3000)
- [ ] proprietary-model — after 3–6 months of trade-outcome data

---

## Future Modules (all go inside NexusTrader/)

| Module | Purpose |
|---|---|
| `earnings-predictor/` | Predict beats/misses from job posts, app rankings, web traffic |
| `insider-tracker/` | Real-time SEC Form 4 monitoring |
| `patent-intelligence/` | USPTO scraping for early R&D signals |
| `options-flow/` | Unusual options activity monitor |
| `geo-warning/` | Geopolitical early warning for defense/energy plays |
| `macro-calendar/` | Pre-model Fed/CPI/jobs impact on held positions |
| `proprietary-model/` | Fine-tuned model on your thesis + outcome data |
