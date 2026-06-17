# NexusTrader — Master Roadmap

**Goal:** A robust, mostly-autonomous trading system that generates reliable passive income for a solo operator, with a path to scaling into something genuinely sophisticated ("quant-firm-like" via automation, not headcount).

**Owner constraints (the design drivers):**
- **Hands-off** — must mostly run itself; weekly check-ins, not daily babysitting.
- **Revenue-first, scale-second** — get net-positive fast, then build the scalable machine.
- **Passive income for self** — NOT a firm with clients/employees (skips ~80% of "quant firm" complexity).

**Guiding principle:** Maximize *autonomy and robustness*, even at the cost of some edge. A simpler strategy that runs unattended for months beats a brilliant one that needs daily attention. Edge comes from **volume × small validated advantage × iron discipline** — not from a genius strategy.

**Honest expectation-setting:** Trading is the *hardest* form of passive income. Most automated retail systems lose money. "Passive" here means "weekly check-ins + a system that alerts you when something breaks," NOT "set and forget and get rich." The ORB bot being ~break-even already beats most. Realistic target: a robust system grinding a small steady edge that compounds over years.

---

## Current state (June 10 2026 — UPDATED)

- **ORB bot (day-trading, breakout strategy):** WORKS. ~48% WR, profit factor 1.3–1.4 on backtest, the proven edge. KEEP + improve. THE focus now. Watchlist rebuilt to high-volatility names (COIN/ARKK/SMCI/MARA/RIOT/IWM/MSTR/TSLA/QQQ/AAPL/AMD/DKNG). Adaptive brain seeded from backtest.
- **Swing bot (thesis-driven, multi-day):** ⛔ RETIRED June 10 2026. 14% WR, -$2,906/month — the only loser, AND the most hands-ON piece, AND wrong shape for the new vision (smart-strategies-under-smart-supervisor). DISABLED via crontab (both swing lines commented "DISABLED 2026-06-10", crontab backed up to /opt/nexustrader/.backups/crontab-*.bak). Code FROZEN not deleted — reversible (uncomment to restore). 2 leftover positions (MSFT, MU) left to resolve via their native resting stops (couldn't close — market closed, stops locked until open; they're protected so no urgency).
- **market-lens / options-flow / earnings-predictor:** KEPT RUNNING as a research feed (user choice). No longer feed an active trader. Decide their long-term fate later (research dashboard vs retire).
- **Account:** ~$97.4k paper. With swing retired, the bleed source is removed.

## Vision (refined June 10): SMART STRATEGIES under a SMART SUPERVISOR

User pushed back on "hands-off means dumber" — correctly. The fix: intelligence doesn't make a bot need babysitting; FRAGILITY does. Move the intelligence from the operator's head INTO the system. Architecture = two layers:
- **Strategies (tactical brilliance):** can be as sophisticated as we want — ORB, crypto breakout, mean-reversion, ML signals.
- **The Supervisor / meta-brain (the real quant-defining part):** monitors live-vs-backtest performance, detects edge decay, switches strategies by market regime, allocates capital to what's working, auto-validates new ideas, alerts on breaks. THIS is what makes brilliant strategies run UNATTENDED.
**Critical build order: SUPERVISOR FIRST, strategies second.** Building clever strategies with no supervisor = the classic solo-quant death (deploy, works 2 weeks, breaks, you don't notice, lose money). With the supervisor first, every strategy added is auto-monitored + protected. Seed already exists: the ORB adaptive brain (per-symbol sizing by win rate) = Layer 1 embryo.

Layers: L0 clean data+honest tracking (mostly done — the month of bug fixes) → L1 Supervisor (build next, start with the performance watchdog: live WR vs backtest WR → auto-reduce/alert on divergence) → L2 strategies plug into supervisor → L3 multiple uncorrelated strategies, supervisor self-allocates = quant-firm-like via automation.

---

## Sequenced plan (do in order)

### STEP 1 — Decide the swing bot's fate
The swing bot is both the bleed AND the most hands-on component. Resolving it unblocks everything.
- **Run the clean trial** (already underway): judge the FIXED swing bot on ~15–20 post-fix trades / 2–3 weeks. Criteria: are losers now stopping at ~3% (not 5–6%)? Is WR climbing off 14%? Is it avoiding falling markets (regime filter)?
- **Decision gate:**
  - If it turns net-positive → keep, it earned its place.
  - If still losing → RETIRE it. For a hands-off goal it's the wrong shape regardless. Freeze the code (don't delete), pause its cron, and decide market-lens's fate (research tool vs shut down).

### STEP 2 — Map adding crypto to the ORB bot
Crypto is the highest-leverage *hands-off* expansion: 24/7 trading = ~3x more trades/data with ZERO extra effort from the operator. And early evidence says breakouts work on crypto.
- Quick backtest (30d, real Alpaca data): DOGE +2.8%, LINK +2.8%, SOL +0.7% on a simplified ORB; BTC/ETH weaker (too efficient/choppy). Tiny sample — directional only.
- **The reframe:** don't port the FAILING thesis-swing to crypto. Extend the WINNING ORB breakout strategy to crypto. Crypto's volatility + 24/7 is tailor-made for breakouts.
- Design questions to settle: which coins (volatile alts > BTC for breakouts), 24/7 session handling (no "market hours"), crypto-specific regime filter (BTC trend instead of SPY), fractional sizing (crypto is natively fractional — REMOVES the whole-share/stop-order bugs that plagued the stock swing bot).
- Validate properly (3–6 month backtest, real ORB logic) BEFORE going live even on paper.

### STEP 3 — Design the auto-validation loop ("the robot that manages the robots")
This is THE piece that makes long-term hands-off possible. For a solo operator you don't need a full quant factory — you need one automated loop that:
- Auto-backtests new strategies/symbols on a schedule
- Only PROMOTES ones that pass out-of-sample tests to live paper trading
- ALERTS (Discord) when something breaks, an edge decays, or drawdown exceeds a threshold
- Otherwise leaves you alone
This is what turns "a bot" into "a system" and is the real foundation for scaling.

### STEP 4 — Full multi-month execution (this document, kept live)
Phase 1 (now→~1mo): stop the bleed, lock in autonomy (Steps 1–2).
Phase 2 (mo 2–4): build the auto-validation loop (Step 3) + harden monitoring.
Phase 3 (mo 4+): multiple uncorrelated strategies in parallel (breakout + mean-reversion + e.g. crypto funding-rate arb); system self-allocates more capital to what's working. THIS is the "quant-firm-like" endpoint — achieved via automation.

---

## Data-scraping philosophy (decided)

**Broad price data, surgical everything-else.**
- Collect OHLCV/price data broadly — it's the foundation every strategy tests on.
- Add ANY other source (on-chain, funding rates, sentiment, news) ONLY when a backtested strategy proves it needs it. Data follows strategy, not vice versa.
- Why: every scraper is a thing that breaks at 3am and can silently corrupt the bot (already lived this — RSS feeds, volume-data bug). For a hands-off goal, minimize surface area. "Scrape everything" = maintenance hell + a data hoard you never use = the #1 way solo quant projects die.

---

## Strategy landscape (reference)

Four families, ranked by fit with what NexusTrader already has:
1. **Breakout/momentum** ⭐ = the ORB strategy. Proven on stocks, early-promising on crypto. Path of least resistance.
2. **Thesis/narrative** = swing + market-lens. Currently failing on stocks. Crypto IS narrative-driven so it *could* fit — but don't move a broken strategy to a new asset.
3. **Mean-reversion / range** = fade extremes in choppy markets. Some logic already exists (oversold-bounce). Good complement to breakout (uncorrelated).
4. **Trend-following (longer hold)** = ride multi-day trends. Simple, robust, slow.

Crypto vs stocks cheat-sheet: crypto = 24/7 (no gaps — fixes swing's overnight-stop pain), fully fractional (fixes whole-share/stop bugs), narrative-driven, much higher volatility, BUT no earnings/SEC/stock-options data (kills options-flow + earnings-predictor for crypto use).

---

## Decision log (update as we go)
- 2026-06-10: Roadmap created. User wants: hands-off, revenue-first then scale, passive income for self (not a firm). Doing Steps 1–4 in order. Data philosophy = lean/surgical. Crypto reframe = extend ORB (winner) to crypto, NOT port swing (loser).
- 2026-06-10 (later): Roadmap refined for "smart strategies under smart supervisor" vision. SWING BOT RETIRED (disabled via crontab, frozen not deleted, reversible). market-lens kept running as research feed. 2 orphan positions (MSFT/MU) left to resolve via native stops. NEXT actionable step when ready to build: the Supervisor's performance-watchdog (live-vs-backtest WR monitoring + auto-alert). Build supervisor BEFORE adding new strategies.
