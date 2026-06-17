# NexusTrader Strategies Backlog

Strategies that have been designed but **not built yet**. Build only after collecting 2–4 weeks of baseline data from the live strategies so we know what the actual gap is.

---

## Currently live

| Strategy | Bot | Direction | Trigger |
|---|---|---|---|
| ORB Breakout | orb-bot | Long + Short | Close outside 9:30–9:44 range with volume confirmation |
| VWAP Reclaim | orb-bot | Long | Price falls below VWAP, then reclaims with volume + relative strength |
| VWAP Rejection Short | orb-bot | Short | Price tags VWAP from below, rejects with volume |
| Mean-Reversion Fade | orb-bot | Long + Short | Failed breakout — closed outside range, then closed back inside. **Whitelisted to AAPL, TSLA, IWM** based on 6-month backtest. |
| Swing thesis trader | swing-bot | Long | Market-lens BUY_WATCH score ≥ 65, multi-day hold |

---

## Deferred — build when baseline data exists

### 1. VWAP Reclaim (extended)

**Status:** Already partly implemented in orb-bot. May want to extend to mid-session reclaims (after the morning has played out).

**Idea:** Run the reclaim check during the Midday and Power Hour windows too, not just after the opening range. Stocks that lose VWAP into lunch and reclaim mid-afternoon often have strong late-day trends.

**Build cost:** Low (~100 lines). Reuse existing `detectVwapReclaim()` with different time-windowed candles.

**Decision criteria:**
- Build if ORB Midday and Power Hour windows show poor win rates (< 45%) — VWAP reclaim could replace weak breakout signals
- Skip if they already perform well

---

### 2. Gap-Fill

**Idea:** Stock gaps down ≥ 2% at open (vs prior close). Wait for it to grind back up. Enter long when it reclaims yesterday's close. Target = the gap fill (yesterday's high or session VWAP). Stop = the morning low.

**Why it complements ORB:** Trades the FIRST 5–15 minutes that ORB explicitly waits out. Doesn't conflict timing-wise.

**When it shines:** News-driven gap-downs without follow-through (most gap-downs partially fill within 1–2 days).

**Build cost:** Medium (~300 lines). Needs:
- Yesterday's close fetched at pre-market
- Gap detection logic (close vs current price)
- Pre-9:30 candle tracking
- Separate execution path (entries fire before 9:30 ORB starts)

**Decision criteria:**
- Build if we see ≥ 3 gap-down days per week in the watchlist (track this in journal)
- Need a way to backtest before going live — gap-fills can be erratic on earnings days

---

### 3. Momentum Continuation

**Idea:** After a successful ORB breakout that hits 1× target, if price retests the breakout level and holds (doesn't break back inside the range), add a second entry. Position size half of the first. Same stop.

**Why it complements ORB:** Compounds winners on trend days. ORB only captures the initial move; continuation captures the follow-through.

**When it shines:** Strong directional trend days (~15% of days, but they make 60% of the year's P&L).

**Risk:** Doubles exposure on a single trend. If the trend reverses, both positions lose together.

**Build cost:** Medium (~250 lines). Needs:
- Track "post-1×-target" positions separately
- New entry trigger: retest of breakout level + hold for N candles
- Position-size logic that respects total risk budget (combined position must still be ≤ riskPerTrade × 1.5)

**Decision criteria:**
- Build if ORB's average winner > 2× the average loser (positive expectancy — worth pressing winners)
- Build if we see ≥ 2 days/month where ORB hits 1× target but then runs much further without us adding

---

### 4. Earnings Drift

**Idea:** Companies that BEAT earnings tend to drift up for 5–20 trading days post-announcement (well-documented post-earnings drift anomaly). Enter the day after earnings if (a) the company beat AND (b) didn't gap > 5% (most of the move already priced in). Hold 5–20 days.

**Why it complements existing bots:** Uncorrelated to intraday or thesis-based signals. Pure event-driven trade.

**Blocker:** We currently have `earnings_predictions.json` (predictions PRE-earnings) but NO `earnings_actuals.json` (was the prediction correct?). Need to build an actuals fetcher first.

**Build cost:**
- Actuals fetcher: ~150 lines + yfinance dependency (~30 min)
- Strategy bot: ~400 lines (new directory `/opt/nexustrader/earnings-drift/`)

**Decision criteria:**
- Build the actuals fetcher when we have a free evening — unlocks future work
- Build the strategy when ≥ 5 of our watchlist symbols have upcoming earnings within 30 days
- Currently NO companies in watchlist report earnings for ~2 months — defer

---

### 5. Pairs / Sector Relative-Strength

**Idea:** Long the strongest sector ETF, short the weakest sector ETF. Rebalance daily. Market-neutral by construction.

**Why it complements existing bots:** Uncorrelated to ORB (directional) and swing (single-name thesis). Profits from sector rotation, not market direction.

**When it shines:** Sideways markets where individual stock picks fail but sector rotation continues.

**Build cost:** High (~600 lines). Needs:
- Daily relative-strength calculation across 11 sector ETFs (XLE, XLF, XLK, XLV, XLU, etc.)
- Rebalancing logic (target dollar-neutral, not share-neutral)
- Higher minimum capital — at our $100k paper account, sector-pair positions would each be too small to trade efficiently

**Decision criteria:**
- Defer until paper account scales to ≥ $250k OR we switch to live with real capital
- Or build if VIX > 25 for sustained periods (sideways/choppy market regime where pairs shine)

---

### 6. Mean-Reversion Intraday (broader than the fade we built)

**Idea:** The fade we built is a specific case: failed breakout → reverse. A more general mean-reversion would fade ANY excursion from VWAP — not just failed breakouts. E.g., price ≥ 2 standard deviations above VWAP with declining volume → short toward VWAP.

**Why this is different from the fade:** Fade requires a breakout-then-reclaim pattern. This one trades pure overextension regardless of whether a breakout happened.

**When it shines:** Range-bound days (~60% of days) where ORB breakouts fail and stocks oscillate.

**Build cost:** Medium (~250 lines). Needs:
- Rolling VWAP standard deviation
- Decline-in-volume detection (exhaustion signal)
- Tighter stops than directional strategies

**Decision criteria:**
- Build AFTER 4 weeks of fade data. If the fade is profitable but only fires 1–2x/week, this broader mean-rev would fire more often.
- Skip if the fade alone captures most of the choppy-day opportunity

---

## Decision framework — when to add the next strategy

Don't add strategies because they sound smart. Add them because the data says they fill a gap. Before building any of the above, look at:

1. **What is ORB's win rate by window?**
   - If ORB < 40%, the right move is to FIX ORB, not add new strategies
   - If ORB > 55%, add strategies that don't compete for the same setup

2. **What % of trading days currently produce zero trades?**
   - If > 50%, we need strategies that fire on quiet days (Mean-Rev, VWAP)
   - If < 20%, we're already trading enough — adding more = overtrading

3. **What's our average correlation between open positions?**
   - If correlation > 0.5, swing + ORB are too aligned (sector-cap not enough)
   - Add a market-neutral strategy (Pairs) to reduce portfolio variance

4. **Capital utilization**
   - If `risk_budget.json` `remaining_pct` is regularly < 20%, we're already at capacity
   - Don't add strategies — they'll just compete for the same risk dollars
   - Instead, improve sizing/exit on what we have

---

## Anti-patterns — strategies NOT to build

- **Anything overfit to recent market regime.** "It would have worked last week" is selection bias.
- **Anything that requires real-time options data.** Out of scope; too expensive for paper.
- **Anything that trades crypto on the same Alpaca account.** Different risk profile; would corrupt swing brain stats.
- **Sentiment-driven scalps (e.g., reddit-mention triggers).** Signal-to-noise too low; we already use sentiment as a confirming signal, not a trigger.

---

## Review schedule

- **Every Sunday night**: pull the week's session logs, update the win-rate-by-strategy table
- **Every month**: revisit this doc, decide if any deferred strategy is ready
- **Don't build before that review** — discipline matters more than activity

---

## Backtest results — Mean-Reversion Fade (2026-05-26, 6 months)

| Symbol | Fades | Long/Short | Win Rate | Expectancy | Profit Factor | Verdict |
|--------|-------|-----------|----------|-----------|---------------|---------|
| AAPL | 100 | 51/49 | 40% | +0.03% | 1.32 | ✅ Enabled |
| TSLA | 96 | 53/43 | 34% | +0.04% | 1.25 | ✅ Enabled |
| IWM | 102 | 60/42 | 40% | +0.02% | 1.21 | ✅ Enabled |
| META | 95 | 52/43 | 32% | 0.00% | 1.03 | ❌ Break-even — disabled |
| NVDA | 90 | 46/44 | 31% | -0.01% | 0.93 | ❌ Negative — disabled |
| QQQ | 111 | 51/60 | 32% | -0.01% | 0.86 | ❌ Negative — disabled |
| GOOGL | 85 | 40/45 | 28% | -0.05% | 0.63 | ❌ Worst — disabled |

**Pattern:** Mean-reversion works on stocks with clear ranges (AAPL, TSLA, IWM). Fails on highly liquid mega-caps that trend hard (QQQ, NVDA, GOOGL) — failed breakouts in trending names often resolve back into the trend, not the range.

**Action taken:** `FADE.enabledSymbols = ['AAPL', 'TSLA', 'IWM']` — strategy only runs on validated tickers.

**Re-validate:** Re-run the backtest monthly. If regime shifts (e.g., NVDA stops trending), GOOGL/NVDA/QQQ may become eligible.

Last updated: 2026-05-26

---

# Swing-bot improvements (from June 7 2026 diagnostic)

Context: honest per-strategy scorecard (see `honest_pnl.py`) showed the **ORB day-bot is profitable** (48% WR, PF 1.38) but the **swing-bot is the loser** (28% WR, −$1,115). Root causes found + fixed June 7: oversized losses from once-daily stop checks (now native Alpaca stops), no market-regime gate (now added), low confidence bar (raised 65→72).

These are the NEXT improvements, not yet built. User wants to keep total trade count up while raising win rate — the resolution is **ORB carries volume, swing goes selective.**

## ⭐ 1. Entry timing — stop buying blind at the open (HIGH PRIORITY, do next)

**The problem:** `enter_positions()` in `swing-bot/main.py` takes the price from `alpaca.get_latest_price()` at the 9:35 AM cron and fires a **market buy immediately**. The first 5–15 minutes of the session are the most volatile and gap-prone part of the day. We're paying the worst spread and chasing any gap-up — and entry price is half of P&L, so this directly drags win rate.

**Two options (can do either or both):**

- **(a) Limit order instead of market.** Place a limit at ~current price (or slightly below, e.g. −0.3%) instead of a market order. Better fills; the tradeoff is some entries won't fill if price runs away. Need to handle the "didn't fill within N minutes" case — either cancel-and-skip or cancel-and-retry-at-market.
- **(b) Wait for the opening range to settle.** Delay swing entries from 9:35 to ~9:45–10:00. Let the open's noise clear, then buy. Cleanest: add a second cron at ~9:50 that runs a `enter_positions()`-only pass, and move entries out of the 9:35 run (keep exits at 9:35 so stops are checked early). The ORB bot already proves this works — it explicitly waits out the first 2 minutes (`isInOrbFakeoutZone`).

**Where:** `swing-bot/main.py` `enter_positions()` (entry order placement ~line 267), `swing-bot/alpaca_client.py` (add `place_limit_buy`), cron schedule on VPS.

**Build cost:** Medium. (b) is lower-risk than (a). Recommend starting with (b): just shift the entry time.

**Decision criteria:** Compare fill prices vs the day's VWAP over 2–3 weeks. If entries are consistently worse than VWAP, this is confirmed worth it.

## 2. Make options-flow confirmation MANDATORY (not just a +5 boost)

**Current:** `signals_reader.py` `get_actionable_buys()` *skips* bearish-options tickers and *adds 5 points* if options are bullish — but a thesis with NO options confirmation still trades. **Idea:** require at least neutral/bullish smart-money positioning to enter (i.e., "smart money must not disagree"). Higher conviction, fewer trades. Pairs with the "win rate first" choice.

**Build cost:** Low (~10 lines in `get_actionable_buys`). Risk: cuts trade count — measure first.

## 3. Weekly drawdown circuit-breaker for swing entries

**Idea:** "No new swing longs if the account is down > X% week-to-date." Stops the bot adding risk during a losing streak (the late-May behavior — it kept buying as positions bled). The kill-switch covers daily + cumulative; this is a softer week-level governor on *new entries* only.

**Where:** `swing-bot/main.py` `enter_positions()`, read week-start equity from `wealth-intelligence` snapshots or Alpaca portfolio history.

**Build cost:** Low–medium.

## 4. Diversify thesis SOURCES (reduce correlated idea generation)

**The deeper issue:** the cluster cap (deployed) limits correlated *exposure*, but `market-lens` still over-produces correlated *ideas* (the late-May book was all AI/utilities because that's what the news cycle was about). Improving signal diversity is a `market-lens` scoring change, not a swing-bot change. Lower priority, bigger scope.

## Done June 7 2026 (for reference, do NOT redo)
- ✅ Native Alpaca stop orders on swing entries (24/7 protection vs once-daily check) — `place_stop_order`, whole-share sizing.
- ✅ Market-regime filter — skip new longs when SPY > 1% below 50-day SMA. `get_market_regime()`.
- ✅ MIN_CONFIDENCE 65 → 72.
- ✅ Combined exposure ceiling 40%, correlation-cluster cap, kill-switch cumulative-drawdown fix, double-count dedup, orphan-adoption guard, ORB fractional-qty close fix, short confidence premium (+0.08).

Last updated: 2026-06-08

---

## ORB Symbol Universe Backtest (2026-06-09, 6-month)

Goal: find all symbols with a real ORB edge to expand the watchlist (data-driven, not market-lens — market-lens is multi-day trend, ORB is intraday breakout; they don't mix).

Pass criterion: Sharpe ≥ 0.4 AND positive expectancy AND ≥5 trades.

**Full ranking (by Sharpe):**

| Symbol | Sharpe | PF | WR | In watchlist? |
|--------|--------|-----|-----|---------------|
| COIN | 4.87 | 2.29 | 52% | ✅ added |
| ARKK | 3.53 | 1.80 | 50% | ✅ added |
| SMCI | 2.93 | 1.69 | 46% | ✅ added |
| MARA | 2.87 | 1.62 | 45% | ✅ added |
| RIOT | 2.59 | 1.56 | 51% | ✅ added |
| IWM | 2.43 | 1.45 | 48% | ✅ kept |
| MSTR | 2.17 | 1.47 | 43% | ✅ added |
| TSLA | 2.00 | 1.37 | 41% | ✅ kept |
| QQQ | 1.95 | 1.37 | 44% | ✅ kept |
| AAPL | 1.82 | 1.34 | 48% | ✅ kept |
| AMD | 1.63 | 1.31 | 42% | ✅ added |
| DKNG | 1.51 | 1.27 | 42% | ✅ added |
| AVGO | 1.40 | 1.26 | 46% | ⏳ bench (next if a slot frees) |
| GOOGL | 1.40 | 1.27 | 42% | ❌ dropped (weak) |
| NVDA | 1.28 | 1.23 | 42% | ❌ dropped (weak) |
| PLTR | 1.06 | 1.20 | 43% | ⏳ bench |
| SPY | 1.03 | 1.18 | 42% | ⏳ bench |
| TQQQ | 0.81 | 1.15 | 38% | ⏳ bench |
| NFLX, ABNB, MSFT, MU, SOXL, CRM | 0.56–0.68 | ~1.1 | — | ⏳ bench (marginal) |
| META | 0.58 | 1.10 | 40% | ❌ dropped (weakest) |
| AMZN, HOOD, SHOP, UBER | <0.4 or neg | — | — | ❌ FAILED |

**Key insight:** high-volatility momentum/crypto-proxy names (COIN, ARKK, SMCI, MARA, RIOT, MSTR) dominate — they actually break out and trend intraday, which is exactly what the ORB strategy needs. Calm mega-caps (GOOGL, NVDA, META) barely trade and underperform.

**Watchlist capped at 12.** Bench list (AVGO, PLTR, SPY, TQQQ…) is ready if a current symbol degrades. Re-backtest monthly; swap underperformers for bench names.

**Risk note:** 6 of 12 are now high-beta/crypto-correlated (COIN, MARA, RIOT, MSTR, ARKK, SMCI). These move together on crypto/risk sentiment. Watch for correlated drawdowns; ORB's per-session reset + the brain's per-symbol sizing partially mitigate.
