# NexusTrader Roadmap — From Swing Removal → ORB-Only or Crypto Bot

**Written:** 2026-06-17
**Where we are:** Swing bot retired & archived. ORB bot is the only live strategy.
ORB is correctly built but **barely trading** (~1 trade in 14 sessions — mostly event-blocked
days + choppy GO days). The #1 problem right now is **not enough trades = no data to learn from.**

This document lays out the full sequence. There are two end-states (Path A: ORB-only, Path B: add
crypto). **Steps 1–4 are shared and must happen regardless of which path you choose.** You only
decide between A and B at Step 5.

---

## GUIDING PRINCIPLE
Don't add a second bot until the first one is *proven* — i.e. it trades regularly AND the trades
are net positive (or at least not net negative) over a real sample. Adding crypto now would just
double the surface area of an unproven system. **Prove ORB first.**

---

# PHASE 0 — STABILIZE (this week) ✅ mostly done
- [x] Swing fully decoupled + archived
- [x] Watchlist fixed (12 backtested names, config is source of truth)
- [x] Entry gates loosened (volume 1.0→0.7, range 3%→5%)
- [x] Correlation-group cap (max 2 per cluster) so loosening can't cause a concentrated blowup
- [x] Dashboard calendar path bug fixed
- [ ] **Reconcile config.ts ↔ orbAnalyst.ts drift** (3 pre-existing typecheck errors: `shortConfidencePremium`, `enabledSymbols`). Bot runs via tsx so it works, but clean this up so the typecheck is trustworthy again.

---

# PHASE 1 — MAKE ORB ACTUALLY TRADE (next 1–2 weeks)
**Goal: go from ~1 trade/2 weeks to a few trades/week of reasonable quality.**

1. **Measure the real rejection reasons.** Add a per-session "why no entry" tally to the Discord
   summary + session JSON: count how many candidates were blocked by volume gate vs range vs
   confidence vs event-block. (We did this manually last week; make it automatic so we stop guessing.)
2. **Tune ONE gate at a time, with data.** Based on the tally, loosen the single biggest blocker by
   a small step, run a week, compare. Likely order: volume gate → confidence threshold → range.
   Never loosen two things at once or you can't attribute the effect.
3. **Re-examine the event-block calendar.** FOMC/CPI days are correctly skipped, but check it's not
   over-blocking (e.g. skipping for minor events). Trading days are precious for data.
4. **Decision gate:** after ~2 weeks, are we getting ≥3–5 trades/week? If no → keep tuning. If yes → Phase 2.

---

# PHASE 2 — PROVE THE EDGE (2–4 weeks of real trades)
**Goal: enough clean trades to judge whether ORB has an edge.**

1. Collect **≥30–50 real (non-synthetic) closed trades.** This is the minimum to say anything.
2. Track the honest scorecard weekly: win rate, profit factor, avg win vs avg loss, max drawdown.
3. Let the brain's per-symbol learning graduate (it needs ~10 real trades/symbol to leave synthetic mode).
4. **Decision gate — THE BIG ONE:**
   - **Profit factor > ~1.2 and not bleeding** → ORB has a real edge. Proceed to Phase 3.
   - **Flat/negative after 50 trades** → ORB edge is unproven. DO NOT add crypto. Either keep
     tuning ORB or accept it's a data-collection sandbox, not an income engine. Be honest here.

---

# PHASE 3 — DECIDE: Path A (ORB-only) or Path B (add crypto)
This is the fork. Only reach it if Phase 2 proved ORB works.

## PATH A — ORB-ONLY (simpler, lower risk)
Keep one bot, make it excellent. Recommended if you want hands-off and low maintenance.
- A1. **Build the supervisor** (the roadmap's real goal): a monitor that compares live performance
      to backtest expectations and alerts when the edge decays. This is what makes it "hands-off."
- A2. **Expand windows/symbols carefully** — only add a symbol after backtest + live both support it.
- A3. **Auto-tune loop:** let the brain adjust per-symbol sizing/confidence from real outcomes
      (already partly built — graduate it from synthetic once data exists).
- A4. **Position sizing discipline:** scale size up only on proven symbols, never on hope.

## PATH B — ADD CRYPTO ORB (more upside, more work)
Extend the WINNER (ORB) to crypto — NOT a new strategy. Only if you want 24/7 trading + more shots.
- B1. **Crypto is long-only on Alpaca** (spot, no shorting). Design for that constraint.
- B2. **Separate process/config** — a `crypto-orb` service, its own watchlist (BTC/ETH/SOL etc.),
      its own risk budget. Do NOT mix it into the stock bot's index.ts.
- B3. **24/7 scheduling** — crypto never closes, so ORB "opening range" must be redefined (e.g. a
      rolling daily range or a fixed UTC anchor). This is the main design problem.
- B4. **Backtest crypto-ORB first** on historical crypto bars — same Sharpe/expectancy bar as stocks.
- B5. **Paper-trade crypto-ORB** for 2–4 weeks before any real capital.
- B6. **Shared kill switch + correlation cap** — crypto names are MORE correlated than the equity
      cluster; the cap matters even more here.
- B7. **Evaluate Freqtrade/FreqAI** for the crypto layer (research showed it's ~80% of this already
      built). Possibly run crypto on Freqtrade while keeping the custom stock ORB. Don't migrate the
      working stock bot.

---

# PHASE 4 — AUTOMATION / SUPERVISOR (the long-term vision, both paths)
The end-state from the vision docs: a "smart supervisor" that:
- monitors each strategy's live-vs-backtest performance,
- allocates more capital to what's working, throttles what's decaying,
- alerts you (Discord) on anomalies,
- so the whole thing runs hands-off as passive income.
Build this AFTER at least one strategy is proven — a supervisor with nothing proven to supervise is
premature.

---

# RECOMMENDED SEQUENCE (TL;DR)
1. Finish Phase 0 (clean up the typecheck drift).
2. Phase 1: make ORB trade ≥3–5×/week by tuning gates with data.
3. Phase 2: collect 30–50 real trades, compute the honest scorecard.
4. **If ORB proves an edge → Phase 3.** If not → keep tuning or accept ORB as a sandbox; don't add crypto.
5. At Phase 3, pick Path A (polish ORB, build supervisor) or Path B (add crypto-ORB as a separate service).
6. Phase 4: build the supervisor for true hands-off operation.

**My recommendation:** Path A until ORB is clearly profitable over 50+ trades, THEN consider crypto.
Crypto doubles complexity; only take it on once the core engine is proven to make money.
