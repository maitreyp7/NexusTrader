# NexusTrader — The Project Journey (Day 1 → Now)

**Purpose of this document:** a narrative record of how this system was built — every
important decision, backtest, rejected strategy, bug, and lesson — so I can *explain my
own project* in an interview instead of just saying "I used an AI tool." Everything here
is real and traceable to the git history and the research files.

**One-sentence version I can say out loud:**
> "I built a multi-strategy, daily-bar quantitative trading system that trades a portfolio
> of uncorrelated edges, gates itself to cash in market stress using the VIX term
> structure, and validates every strategy on a look-ahead-free backtester before it goes
> live — and the most valuable thing I learned was how to *reject* strategies with data."

---

## The arc in one paragraph

I started with a Node.js/TypeScript **intraday** trading bot (opening-range breakouts on
tech stocks). When I built an honest backtester, it revealed the intraday bot was a
**loser after costs** — it only looked good because the original backtest was optimistic.
That failure forced a full pivot: from discretionary intraday trading to **systematic,
daily-bar, portfolio-of-edges quant** — the way real systematic desks actually work. The
rest of the project was building that system, validating each piece, killing the ideas
that didn't survive honest testing, and hardening the execution against real-world bugs.

---

## PHASE 0 — The failure that started everything (mid-June 2026)

**What I had:** an ORB (opening-range breakout) intraday bot on QQQ/NVDA/AAPL/TSLA/etc.,
long-only, three intraday windows, with MACD/volume/VWAP confirmation and trailing stops.

**The turning point — building an *honest* backtester.** The original backtester was
optimistic (it showed profit factor ~1.43). I rebuilt it to be pessimistic-but-honest:
- **No look-ahead:** a signal computed on day *t*'s close can only execute at *t+1*'s open.
- **Real transaction costs** charged on every trade (≈3bps/side ETFs, 15bps crypto).
- **Total-return prices** (dividends included).

**The result that changed the project:** the ORB strategy's *honest* profit factor was
**0.83** — a loser. The 1.43 was a mirage created by look-ahead and ignored costs.

**Lesson (this is my single most important interview point):**
> Intraday retail trading loses structurally. The edge per trade (~0.1–0.3%) is smaller
> than the costs you pay, and you're competing with HFT firms. An honest backtester is the
> most important tool you can build, because it tells you the truth before the market does.

---

## PHASE 1 — The pivot: build a portfolio of *daily-bar* edges (late June)

I researched what actually works for a solo dev with free tools and concluded: **build a
portfolio of small, uncorrelated, daily/weekly-rebalanced edges — never one killer
strategy.** Each edge had to clear the honest backtester before earning a slot.

### Data decision (important, and a good interview point)
Alpaca's daily history is too short (ETFs ~2016, crypto ~2021) — that's ~one bull regime,
which would repeat the ORB mirage. So I **backtest on Yahoo** (SPY back to 1993, most ETFs
20–33yr including the 2008 crash) and **trade live on Alpaca**.
> **Data source ≠ execution source.** You validate on long history that includes crashes;
> you execute on whatever broker you use.

### The strategies I tested, and what happened

| Strategy | Result | Lesson |
|---|---|---|
| **ETF trend-following** (12-mo momentum + 200-day SMA, monthly) | **PASSED**, Sharpe ~0.94 | The most-documented edge in finance; also gives crisis-alpha. Kept. |
| **Crypto Donchian breakout** (the "hyped" version) | **FAILED** | Popular ≠ profitable. Killed it. |
| **Crypto trend** (hold above 50-day MA) | **PASSED**, uncorrelated to stocks | Same trend logic, different market. Kept. |
| **Turn-of-month** calendar tilt | **PASSED** (weak alone) | Low edge but near-zero cost + acts as a volatility dampener. Kept as a filler. |
| **FOMC drift / defensive rotation** | rejected | Didn't clear the bar. |

### The key insight — the allocator
Combining the sleeves into one portfolio produced a **higher Sharpe than any single
sleeve** (~0.82 combined). That's diversification — the one "free lunch" in investing —
made concrete.

---

## PHASE 7.1 — The regime gate (the most valuable single component)

I added a **VIX / VIX3M term-structure gate**. Normally near-term VIX is *below* 3-month
VIX (calm/"contango"). When near-term spikes *above* 3-month ("backwardation," ratio > 1.0),
that's acute stress — the gate moves the portfolio to **cash**.

**Validated impact:** Sharpe 0.71 → 0.82, and max drawdown cut from ~-27% to ~-17%, for
almost no CAGR cost. It correctly signaled risk-off in 2008/2009.
> This is *why* the system beats the market on risk: it's usually already in cash before
> the worst of a crash. Going to cash beats shorting (which I also tested and rejected —
> shorting loses to V-shaped bounces).

---

## PHASE 7.2 — Second real sleeve: single-name mean-reversion (late June)

Trend + crypto correlate ~0.58 (both are "trend"), so I needed a *different* return
source. **Mean-reversion** is mechanically the opposite of trend, so it's uncorrelated.

- Rule: buy a large-cap stock when RSI(2) is deeply oversold *within an uptrend* (above its
  200-day SMA); exit when it bounces or a time-stop hits.
- Universe: ~150 liquid large caps.
- **Validated: Sharpe ~1.06**, positive across eras, stronger in recent data.

**Capital isolation problem I had to solve:** two bots on one account would over-allocate.
So each bot owns a *fixed slice* of equity and only trades its own universe.

---

## The RESEARCH OS — how I made rejecting strategies rigorous (late June)

Instead of ad-hoc testing, I built a small **research framework** so every idea is judged
by the same honest yardstick:
- **Auto-validation:** one call → full performance + robustness report + a recommendation
  tier (`REJECT → NEEDS_MORE_RESEARCH → INTERESTING → PAPER_TRADE → PRODUCTION_CANDIDATE`).
- **Robustness gates dominate raw Sharpe:** must survive 2× costs, be positive across most
  eras, hold up in the recent half (no decay), and clear a **deflated Sharpe** test (which
  penalizes for how many strategies you tried — guards against data-mining).
- **Similarity engine:** checks a candidate's return correlation vs existing bots so I don't
  rebuild an edge I already have.
- **Parameter stability:** sweeps parameters and rewards broad *plateaus* over fragile
  *spikes* (a strategy that only works at one exact setting is overfit).
- **The GRAVEYARD:** a permanent file of every rejected idea + why, so nothing gets
  re-tested.

> **This is my strongest quant-research talking point.** It shows I understand overfitting,
> multiple-testing bias, out-of-sample decay, and the discipline of disproving a thesis.

### What the research proved I *shouldn't* do (all in the graveyard)

| Idea | Why rejected |
|---|---|
| **Leverage** (margin, vol-targeted, or leveraged ETFs) | Raises return only by raising risk equally — Sharpe stays *flat*. A risk dial, not an edge. Even trend-gated 2x-SSO: CAGR +8%→+14% but Sharpe 0.72→0.68, drawdown back to -40/-52%. |
| **Shorting / inverse ETFs in downturns** | Loses to V-shaped bounces; going to cash is strictly better. |
| **Defensive rotation** (bonds/gold in downturns) | Redundant with what the brain already holds; dilutive. |
| **Sector rotation, residual momentum** | Just trend-following in disguise (0.4–0.55 correlated) — no diversification. |
| **PEAD (post-earnings drift)** | *Real* edge (validated Sharpe 0.70) — but 0.60-correlated to low-vol, so it doesn't add. Benched as a backup, not deployed. |
| **Spike/breakout prediction** | The "warning sign" preceded a pop only 1.7% of the time — survivorship trap. |

> **Interview gold:** "I found a genuinely profitable strategy (PEAD) and *still didn't
> deploy it*, because it was too correlated to a sleeve I already had. Additivity matters
> more than standalone profitability."

---

## The THIRD sleeve — low-volatility (validated late June, deployed Aug 27)

The **low-volatility anomaly:** the calmest stocks earn more *per unit of risk*, because
investors overpay for exciting/lottery-like stocks. Rule: each month, hold the 15
lowest-realized-volatility large caps, equal weight.

- **Validated:** standalone Sharpe ~1.05, positive in 18/19 eras (a 50-year anomaly).
- **Correlation to the brain: ~0.13** — a genuine diversifier.
- **Blended impact:** system Sharpe 1.11 → **1.25**, CAGR +6.4% → +7.3%, drawdown -12% → -10%.

I deliberately **waited weeks** to deploy it (only after the first two bots proved stable
live) — adding an unproven third bot into an unproven system just multiplies bugs.

---

## THE BUGS — what running a live system actually taught me

This is where I learned the difference between *a backtest* and *a live system*. Every one
of these was a real production bug I diagnosed and fixed:

1. **False kill-switch (July 7):** my equity-protector liquidated the whole book on a bogus
   **-55%** reading — Alpaca briefly returned equity = cash-only (positions missing from the
   field). The "2 consecutive bad reads" guard failed because the glitch lasted 40+ minutes.
   **Fix:** a *data-sanity gate* — reject any reading that (a) doesn't reconcile with
   cash + positions, or (b) implies a >20% move in 20 minutes (impossible for a daily-bar
   book). *Lesson: a safety system needs to distinguish a real loss from bad data.*
2. **Crypto orders silently failing (422):** Alpaca rejects `time_in_force: "day"` for
   crypto — it needs `gtc`. Crypto had *never actually traded*. *Lesson: check that your
   orders fill, don't assume.*
3. **Crypto double-buy → negative cash:** Alpaca takes crypto orders as `BTC/USD` but
   *reports positions* as `BTCUSD` (no slash). My code matched on the slash form, so it
   never saw the crypto it already held and **re-bought it every day** until crypto was 79%
   of the account and cash went negative. **Fix:** a `canon()` function normalizing both
   forms. *Lesson: identifier mismatches are silent and catastrophic.*
4. **Mean-rev churn:** it was trading ~12 orders/run when it should do ~4, re-trading held
   positions on tiny price drift and bleeding bid-ask spread. **Fix:** a no-churn band +
   "quality over quantity" parameters. *This raised its Sharpe 0.81 → 1.08 and its
   after-cost Sharpe 0.56 → 0.91 — direct proof the churn was eating the edge.*
5. **Collision bugs on the 3rd bot's go-live:** mean-rev and low-vol share the stock
   universe; a ledger-section mix-up made mean-rev try to *liquidate low-vol's positions*.
   **Fix:** a shared ownership ledger. *Lesson: shared state between agents needs explicit
   ownership.*

> **Interview framing:** "The strategies were the easy part. The hard part — and where I
> learned the most engineering — was that a live trading system fails in ways a backtest
> never shows you: API glitches, identifier mismatches, fill timing, execution costs. Half
> my work was building the safety and monitoring layer to catch those automatically."

---

## THE SAFETY & MONITORING LAYER (what makes it "quant-desk"-like)

- **Account watchdog** (equity protector): -8% warn, -15% liquidate + halt, with the
  data-sanity gate.
- **Per-sleeve circuit breaker:** a sleeve down 20% from its peak → budget halved; 35% →
  cut to zero. The system defends itself instead of waiting for me.
- **Hard crypto cap** (15% of equity).
- **Slippage tracker:** compares fill price to the same-day open, per sleeve, vs what the
  backtest assumes. It found mean-rev fills at **~15bps vs the 3bps** the backtest modeled —
  i.e., its *live* edge is thinner than the backtest promised. *This is the single most
  "real quant" thing in the project — measuring the gap between backtest and reality.*
- **Per-sleeve P&L logging + live-vs-backtest drift detection.**

---

## WHERE IT ENDED UP — the honest scorecard

**Combined 3-bot system (backtested, after costs):** Sharpe **1.25**, CAGR **~+7.3%**, max
drawdown **~-10%**.

**Through real crashes (backtested) vs SPY:**
| | System | SPY |
|---|---|---|
| 2008 GFC | -8% | -46% |
| 2020 COVID | -3% | -13% |
| 2022 bear | -1% | -18% |
| Full 2000–2026 | +1,321% | +708% |

**The honest caveats I must state (and stating them makes me look *better*, not worse):**
- This is **paper trading + backtests.** Live will be worse than backtest (slippage,
  frictions). Realistic live expectation: low-to-mid single digits/year with shallow
  drawdowns.
- The system **beats the market on *risk*, not raw return** — and it *lags* in strong bull
  markets by design (it de-risks and diversifies). Its edge is avoiding the -50% crashes,
  which compounds over a full cycle. That thesis is **still unproven live** (no crash yet).
- The real levers from here are **capital and time**, not a cleverer strategy — the free-edge
  research is exhausted.

---

## WHAT I ACTUALLY LEARNED (the answers to "what did *you* do?")

1. **Honest backtesting** — look-ahead bias, transaction costs, why an optimistic backtest
   lies. (I have a story: it turned my "winning" ORB bot into a proven loser.)
2. **Overfitting discipline** — deflated Sharpe, parameter-plateau vs spike, out-of-sample
   decay, keeping a graveyard.
3. **Portfolio construction** — uncorrelated edges beat one strategy; additivity > standalone
   Sharpe; correlation-aware allocation.
4. **Regime awareness** — using the VIX term structure to de-risk; why cash beats shorting.
5. **The backtest-vs-live gap** — slippage, execution costs, API failure modes, and building
   monitoring to measure it.
6. **Systems engineering** — multi-service deployment, cron, state files, idempotent orders,
   kill switches, self-healing safety layers.
7. **Research process** — form a hypothesis, test it honestly, *reject* it when it fails, and
   document why.

---

## HOW TO TALK ABOUT AI TOOLS (don't dodge this)

I used AI coding tools (Claude Code) to build faster. **That's a strength if framed right,
a weakness if I let it stand alone.** The honest framing:
> "I used AI tooling to accelerate the *implementation*, which let me spend my time on the
> *decisions* — what to test, how to validate it honestly, when to reject a strategy, how to
> diagnose a live bug. The AI wrote a lot of the code; the research judgment, the honest
> backtesting standards, and the decision to kill strategies that didn't survive were mine.
> I can walk you through *why* every component exists and what the alternative was."

If asked something and I don't know it: **say so, then say how I'd find out.** Quant
interviewers reward intellectual honesty and punish bluffing — and this whole project is
*about* intellectual honesty, so it'd be self-defeating to fake it.

---

## THE THINGS I SHOULD BE HONEST I *DON'T* FULLY KNOW YET
(so I'm never caught overclaiming)
- I built the machinery that computes deflated Sharpe / GARCH-style stats, but I don't yet
  derive the underlying statistics from scratch — I understand them conceptually.
- My regime gate is a hand-set *threshold*, not a learned model (an HMM would learn the
  states from data — that's the upgrade path).
- I understand market *mechanics* better than market *microstructure* or deep macro.
- Everything is *paper-traded*; I haven't managed real capital or real slippage at size.

Stating these proactively is what separates a credible applicant from a hype-y one.
