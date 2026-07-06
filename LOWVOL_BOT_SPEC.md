# LOW-VOL BOT — Full Spec & Build Instructions (Bot #3)

_Written 2026-07-06. This is the complete handoff document: the design rationale,
the exact validated strategy, and step-by-step build instructions. It is intended
to be given to a Claude session to build bot #3._

**Status: READY TO BUILD (dry-run only). GO-LIVE IS GATED — see Part 5.**

---

## Part 1 — Why THIS bot (the design rationale)

Deep research (2026-07-05/06, see `quant/research/GRAVEYARD.md` + experiments
2026_002/2026_003) settled the question of what bot #3 should be:

- **Day-trading strategies: rejected on evidence.** The published ORB paper assumed
  zero slippage/spread at 4x leverage; our own honest ORB replication was PF 0.83
  (the retired bot). Intraday momentum decayed after publication. Overnight drift
  is gone (NY Fed 2026, "The Disappearing Overnight Drift"). Crypto intraday dies
  to 15-25bps taker fees. Structural reason: intraday edge is ~0.1-0.3%/trade vs
  the same costs a daily-bar trade pays for a 1-5% move — signal-to-cost is 10-20x
  worse, against HFT competition.
- **A 4th uncorrelated free-data sleeve: doesn't exist.** Two full sweeps + PEAD
  (validated but 0.60-correlated to low-vol → benched as backup) confirmed it.
- **Leverage: rejected.** Flat CAGR at every level, drawdown explodes (exp 2026_003).

What survives every test is the boring answer: **daily bars, multiple small
uncorrelated edges, regime-gated, honestly validated.** The low-vol tilt is the
one validated sleeve not yet deployed — a 50-year anomaly (Sharpe 1.05 standalone,
18/19 eras positive) that improves the whole system on every axis.

**The blend math (validated 2026-06-30, re-confirmed 2026-07-06):**

| system | Sharpe | CAGR | MaxDD |
|---|---|---|---|
| current 2-bot (70 brain / 30 mrev) | 1.20 | +8.7% | -11.5% |
| **3-bot (60 brain / 25 mrev / 15 lowvol)** | **1.256** | **+8.8%** | **-10.1%** |

Why low-vol works (economic rationale, not data mining): investors systematically
overpay for lottery-like high-vol stocks and shun boring ones (leverage constraints
+ lottery preference), so low-vol names earn more per unit of risk. Documented
since the 1970s; survives because the cause is behavioral/structural.

---

## Part 2 — The exact strategy (already validated; DO NOT "improve" it)

Reference implementation: `low_vol()` in
`quant/research/experiments/hunt_more_free.py` (lines 32-45). Rules:

1. **Universe:** `STOCK_UNIVERSE` (the ~150 large caps in `quant/stock_universe.py`).
2. **Signal:** 126-day (6-month) realized volatility of daily returns, per name.
3. **Portfolio:** on the **last trading day of each month**, rank all names with a
   valid 126d vol; go long the **15 lowest-vol names, equal weight (1/15 ≈ 6.67%
   of this bot's budget each)**. Hold unchanged until the next month-end.
4. **No other signals.** No stops, no momentum filter, no discretion. Turnover is
   naturally tiny (a few names rotate per month).
5. Params are a **robust plateau** (stability score 0.953: n=10..25 all work).
   n=15 is the validated center. Do not tune it.

**Validated standalone (49yr, report: `quant/research/experiments/2026_001_lowvol_tilt/report.md`):**
Sharpe 1.048 · CAGR +13.1% · survives 2x costs (1.041) · 18/19 eras positive ·
DSR 1.0. Known wart: standalone MaxDD -47.8% (1973-75 era) — acceptable because
it's only 15% of the account and it improves the SYSTEM drawdown.

**Honest expectations:** at 15% of a $3k account this adds roughly **+$20-40/yr**
in expectation. The value is diversification + system Sharpe, not riches. Capital
is the lever that scales it.

---

## Part 3 — ⚠️ The symbol-collision hazard (MUST solve; lesson of June 9)

Mean-rev **also** trades `STOCK_UNIVERSE`. Both bots infer "my positions" from
the Alpaca account by symbol membership. If low-vol holds KO and mean-rev later
signals KO: mean-rev would count low-vol's KO shares as its own, under-buy, and
on exit **liquidate the FULL position via the close endpoint — selling low-vol's
shares out from under it.** This is exactly the ORB/swing collision class of bug
(June 9) in new clothes.

**Required fix — ownership ledger (small, explicit, testable):**
- New shared file `quant/ownership.json`: `{"lowvol": {"KO": qty, ...}, "meanrev": {...}}`
  written atomically (temp file + rename) by each bot after its fills.
- `lowvol_runner.py` counts as "current" ONLY symbols/qty in its own ledger section.
- At monthly rebalance, low-vol **skips any candidate symbol currently in mean-rev's
  ledger section** (rare — mean-rev holds ≤10 names for 2-10 days; the backtest
  effect of skipping is negligible). Pick the next-lowest-vol name instead.
- `meanrev_runner.py` gets ONE guarded change: exclude symbols in low-vol's ledger
  section from its position/exposure scan and from full-position closes (partial
  qty-aware sell of only its own shares, or simply skip entry on names low-vol owns).
  This is a production change → dry-run + verify before go-live (Part 5).

---

## Part 4 — Build instructions (step by step)

### Step 0 — Read first
`CLAUDE.md`, `BUILD_PLAN.md` (top block), `quant/meanrev_runner.py` (the template
— read it fully; it embodies hard-won fixes: kill-switch guard, paper-endpoint
refusal, double-buy guard for open orders, fractional close via DELETE
/v2/positions), `quant/dynamic_budget.py`, `quant/health_check.py`.

### Step 1 — `quant/strategies/lowvol.py`
Port `low_vol()` from `hunt_more_free.py` verbatim into a production strategy
module: `strategy(panel, n=15) -> weights DataFrame` (dates × symbols, monthly
rebalance, ffill between). Add the skip-list parameter:
`strategy(panel, n=15, exclude=set())` — excluded symbols get weight 0 and the
next-lowest-vol name takes the slot. Unit-sanity: re-run the gatekeeper
(`research/lib/validate.py`) on the ported version and confirm identical metrics
to the experiment report before proceeding.

### Step 2 — `quant/lowvol_runner.py` (mirror meanrev_runner.py exactly)
Same skeleton, with these deltas:
- `LOWVOL_BUDGET = 0.15` neutral fallback; `MAX_PER_NAME = 0.08` (1/15 + headroom).
- `compute_targets()`: fresh panel on `STOCK_UNIVERSE`, `lowvol.strategy(panel,
  n=15, exclude=meanrev_ledger_symbols())`, take last valid row.
- Ownership ledger read/write per Part 3.
- Keep ALL safety rails verbatim: KILL_SWITCH.json guard, refuse non-paper
  endpoint on --live, open-order double-buy guard, close-position endpoint for
  full exits, $25-or-0.5%-of-budget minimum order filter, own log file
  (`live_logs/lowvol.log`), own Discord line (📉 or 🐢 emoji tag).
- `--dry-run` default; `--live` required to place orders.

### Step 3 — 3-way capital split
The blend test validated **FIXED 60/25/15**. Launch with a fixed split:
- `dynamic_budget.py`: add `compute_split3()` returning `(0.60, 0.25, 0.15)`
  with the existing 2-way gentle tilt applied ONLY between brain and mean-rev
  inside their 85% share (i.e., tilt logic unchanged, scaled by 0.85; low-vol
  fixed at 0.15). Do NOT invent a 3-way performance tilt now — it is unvalidated.
  (Backlog: validate a 3-way tilt later via validate_allocation.py pattern.)
- `live_runner.py` + `meanrev_runner.py` switch to `compute_split3()` with
  fallbacks (brain 0.60 / mrev 0.25 / lowvol 0.15). Guarded, minimal diffs.

### Step 4 — Monitoring
- `health_check.py`: add lowvol to the daily self-report (last run time, ledger
  vs Alpaca reconciliation, order failures).
- Dashboard `/api/quant`: 3-bot view (positions, budget, last rebalance date).

### Step 5 — Dry-run protocol (all must pass before asking user for GO)
1. `python3 lowvol_runner.py` (dry) locally ≥3 times across different days:
   targets = 15 sensible defensive names, ~1% each of equity, orders only on
   month-end drift.
2. Simulate collision: hand-edit ownership.json to give meanrev a low-vol
   candidate → confirm low-vol skips it and picks the 16th name.
3. `meanrev_runner.py` dry-run with a fake lowvol ledger entry → confirm it
   ignores those shares.
4. Gatekeeper re-run on the ported strategy (Step 1) matches the experiment.
5. `git commit` each step; deploy to VPS only after user GO.

### Step 6 — Go-live (USER DECISION, not yours)
Cron on VPS at **5:40 PM ET weekdays** (staggered after brain 5:30 / mean-rev).
Same env file, same paper account. First live week: watch Discord daily.

---

## Part 5 — Hard gates & constraints

1. **GATE: VPS health must be verified FIRST.** Local logs show the equity-
   protector kill switch ACTIVE on 2026-06-24 and never verified since. If the
   2 live bots haven't run cleanly for 2-3 weeks, the go-live clock restarts
   (BUILD_PLAN top block). Building + dry-running is fine meanwhile; enabling
   the cron is not.
2. Paper only. No real money anywhere in this build.
3. No new paid services. Everything here uses existing free Yahoo data + Alpaca.
4. Do not tune the validated params (n=15, 126d vol, monthly). Any "improvement"
   goes through `quant/research/` first.
5. Never re-test graveyard ideas. PEAD (benched) is the designated REPLACEMENT
   for this bot if it fails its live trial — that decision is already made.
6. Production changes (meanrev_runner ledger guard, dynamic_budget) = minimal
   diffs + dry-run before deploy. Research never imports into production.
7. Small commits, one logical change each, matching existing history style.
