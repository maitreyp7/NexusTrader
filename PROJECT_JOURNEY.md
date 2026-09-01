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

### The strategies I tested (summary — full explanations in the Encyclopedia below)

| Strategy | Result | One-line why |
|---|---|---|
| **ETF trend-following** | ✅ KEPT, Sharpe ~0.94 | Ride established uptrends; sit out downtrends. The most-documented edge in finance. |
| **Crypto Donchian breakout** | ❌ FAILED | The "hyped" breakout version didn't survive honest costs. Popular ≠ profitable. |
| **Crypto trend** (50-day MA) | ✅ KEPT | Same trend logic, uncorrelated market. |
| **Turn-of-month** | ✅ KEPT (weak alone) | Tiny calendar edge; near-zero cost; dampens volatility. |
| **FOMC drift** | ❌ rejected | Didn't clear the bar. |

### The key insight — the allocator
Combining the sleeves into one portfolio produced a **higher Sharpe than any single
sleeve** (~0.82 combined). That's diversification — the one "free lunch" in investing —
made concrete.

---

## STRATEGY ENCYCLOPEDIA — what each one *is*, how it works, and what I found

This is the section to study before an interview. For each strategy: the plain-English
idea, the exact mechanics, why it *should* work in theory, and what my data actually said.

### ✅ KEPT strategies (these are in the live system)

**1. ETF trend-following (time-series momentum)**
- **What it is:** own an asset while it's trending up; go to cash while it's trending down.
- **Mechanics:** for each ETF, I check two conditions — (a) its trailing 12-month return is
  positive, and (b) its price is above its 200-day moving average. If both are true, hold it
  (sized by volatility); otherwise hold cash. Rebalanced monthly.
- **Why it works:** markets trend because information diffuses slowly and investors herd.
  Trend-following is the most-researched anomaly in finance and famously provides
  "crisis alpha" — it exits falling markets, so it's *up* or flat in crashes like 2008.
- **My result:** Sharpe ~0.94, drawdown ~-18%. Passed cleanly. It's the backbone of the brain.

**2. Crypto trend-following**
- **What it is:** the same trend idea applied to crypto (BTC, ETH, SOL, etc.).
- **Mechanics:** hold a coin only while its price is above its 50-day moving average;
  vol-targeted sizing; cash (stablecoin) otherwise. Long-only (Alpaca crypto is spot).
- **Why it works + why I added it:** crypto is a younger, less-efficient market, so trends
  are stronger. Crucially, it's **uncorrelated (~0.03–0.34)** to the stock sleeves — so even
  though it's the same *logic*, it's a different *return stream*, which is what diversifies.
- **My result:** Sharpe ~0.68 but +18%/yr; high standalone drawdown (~-74%), which is why
  it's capped at 15% of the account.

**3. Turn-of-month (a calendar effect)**
- **What it is:** stocks have historically drifted up around the turn of each month.
- **Mechanics:** a small long tilt on SPY in the few days around month-end.
- **Why it works:** structural fund flows — 401(k) contributions, pension rebalancing, and
  fund inflows cluster at month-end, creating mechanical buying pressure.
- **My result:** weak on its own (Sharpe ~0.43) but nearly free to run and it *dampens
  volatility*, so it earns a small slot as a filler, not a driver.

**4. Low-volatility tilt** *(covered in detail in its own Phase section below)* — hold the
calmest stocks; they earn more per unit of risk because investors overpay for exciting ones.

### ❌ REJECTED strategies (and the specific reason each failed — this is the good stuff)

**5. Crypto Donchian breakout**
- **What it is:** a classic "breakout" system — buy when price makes a new N-day *high*
  (breaks above the top of its recent range), sell when it makes a new N-day low. The
  channel of highs/lows is called a *Donchian channel*.
- **Why people love it:** it's the famous "Turtle Traders" strategy; it *looks* great in
  trending markets.
- **Why it failed for me:** breakouts generate lots of *false* signals in choppy markets —
  you buy the high, it immediately reverses, you eat the loss plus costs. Against honest
  transaction costs it didn't beat the simpler moving-average trend rule. **Lesson: the
  famous, exciting version of a strategy is often worse than the boring version.**

**6. Shorting the market / inverse ETFs in downtrends**
- **What it is:** instead of just going to cash in a downtrend, actively *profit* from it by
  shorting (or buying an inverse ETF).
- **Why it should work:** if trend-following up-moves make money, symmetric down-moves should
  too.
- **Why it failed:** it **lost -14% annualized in down markets.** Downtrends are punctuated
  by violent "V-shaped" bounces (bear-market rallies) that stop out shorts. Adding it
  collapsed the system's Sharpe from 0.72 to 0.30. **Going to cash beats shorting** — you
  keep the safety without paying for the bounces.

**7. Defensive rotation (bonds/gold in downturns)**
- **What it is:** when equities downtrend, rotate into "safe-haven" assets (TLT bonds, GLD
  gold) to profit from the flight-to-safety.
- **Why it should work:** money flees stocks *into* bonds/gold in a panic, so those go up.
- **Why it failed *for me specifically*:** it profits +4% standalone — but my brain **already
  holds** bonds, gold, commodities and a dollar ETF via the trend sleeve, plus it goes to
  cash via the regime gate. So adding a dedicated defensive sleeve was **redundant** — it
  *lowered* the combined Sharpe (0.93 → 0.91) for a trivial drawdown gain. **Lesson: a
  strategy that's good standalone can still hurt if it overlaps what you already own.**

**8. Sector rotation**
- **What it is:** own the 2–3 strongest of the 11 stock-market sectors (tech, energy,
  financials, etc.), rotate monthly into whatever's leading.
- **Why it should work:** leadership persists — hot sectors stay hot for a while.
- **Why it failed:** decent standalone (Sharpe 0.56) but **0.49–0.55 correlated** to my
  existing sleeves. It's just **trend-following in a different wrapper** — same underlying
  bet, so zero diversification benefit. **Lesson: correlation, not standalone return, decides
  whether something earns a slot.**

**9. Residual momentum (beta-stripped cross-sectional momentum)**
- **What it is:** own the top-decile momentum stocks, but first mathematically *remove* their
  market exposure (beta), so you're betting on stock-specific strength, not the market.
- **Why it should work:** it's a sophisticated, academically-respected factor.
- **Why it failed:** great return (Sharpe 0.75, +14%/yr) **but a -64% max drawdown** —
  momentum strategies suffer periodic "momentum crashes" (violent reversals) — *and* it was
  0.44–0.46 correlated to what I had. Too risky and too redundant. **Lesson: a high Sharpe
  can hide a catastrophic tail risk; always look at the drawdown.**

**10. Spike prediction / momentum-ignition**
- **What it is:** try to *predict* which stock will pop in the next few days from a surge in
  volume + price ("something's happening here").
- **Why people want it:** if you could predict pops, it'd be enormously profitable.
- **Why it failed:** I measured it — the "warning sign" preceded an actual pop only **1.7%**
  of the time. The other 98.3% of identical setups did nothing. This is the **survivorship
  trap**: you see the winners in hindsight and assume the signal predicted them, but the same
  signal fires constantly without a pop. Volume-surge follow-through barely beat a coin flip
  (48% win, negative median). **Lesson: "it worked on these examples" is not evidence — you
  have to count *all* the times the signal fired, including the failures.**

**11. 52-week-high breakout**
- **What it is:** buy stocks making new 52-week highs, expecting continuation.
- **Why it should work:** new highs signal strength and attract attention.
- **Why it failed:** +0.96% over 20 days at a 54% win rate — barely better than random, and
  not enough to survive real costs on volatile names.

**12. PEAD (Post-Earnings Announcement Drift)** *(the important one — a strategy that
WORKED and I* still *rejected)*
- **What it is:** after a company beats earnings and the market reacts positively, the stock
  tends to keep *drifting* up for weeks (investors under-react to the news).
- **Why it works:** it's one of the oldest documented anomalies (since 1968) — behavioral
  under-reaction plus institutions scaling in slowly.
- **My result:** validated as a **real edge** (Sharpe 0.70, positive across all eras, no
  decay). The graveyard even notes the free-data problem that had blocked it got solved.
- **Why I** *still* **benched it:** it was **0.60 correlated to my low-volatility sleeve**
  (both end up holding quality large-caps), so adding it made the blended system *worse*, not
  better. I kept it documented as a *backup* to swap in if low-vol ever decays. **This is my
  best story: I found something profitable and had the discipline NOT to deploy it, because
  additivity matters more than standalone profit.**

**13. Leverage** *(covered in the graveyard section below)* — raises return only by raising
risk equally; the Sharpe never improves. A risk dial, not an edge.

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

### Leverage — the most tempting idea, explained in full (I tested it twice, rejected it twice)
- **What it is:** borrow money (or use 2x/3x leveraged ETFs like SSO/SPXL) to put more than
  100% of your capital into the strategy, multiplying its returns.
- **Why it's tempting:** if my system makes ~7%/yr, 2x leverage "should" make ~14%.
- **Why it fails — the key quant insight:** leverage multiplies **return and risk equally**,
  so the **Sharpe ratio (return per unit of risk) doesn't change** — you just move along the
  same risk/return line. And there are two extra taxes: (1) **financing cost** — borrowing at
  ~IRX+2.5% (~7%) eats most of a ~7%-return strategy; my test showed CAGR stayed *flat* at
  every leverage level while max drawdown exploded from -11% to -67% at 2x. (2) **volatility
  decay** — leveraged ETFs reset daily, so in choppy/sideways markets they bleed value even
  if the index ends flat (a flat-but-choppy market can cost a 2x ETF ~40%).
- **I even tested the "smart" version:** a 2x S&P ETF gated by the 200-day trend (only levered
  in clean uptrends). CAGR rose (+8%→+14%) but **Sharpe stayed flat (0.72→0.68)** and the
  drawdown climbed right back to -40/-52% — the trend filter's whole benefit was erased.
- **Conclusion (a great line):** *"Leverage is a risk dial, not an edge. It can't improve a
  strategy's quality — it can only trade more drawdown for more return along a line you're
  already on. The lever for more money is capital and time, not leverage."*

### The four cross-cutting lessons from everything I rejected
1. **Correlation decides slots, not standalone return.** (Sector rotation, defensive rotation,
   and PEAD were all profitable *alone* but rejected for overlapping what I already had.)
2. **A high Sharpe can hide a catastrophic tail.** (Residual momentum: Sharpe 0.75 but -64%
   drawdown.) Always look at the drawdown.
3. **"It worked on these examples" is a trap.** (Spike prediction fired 98.3% false.) You must
   count every time the signal fired, not just the winners — survivorship bias.
4. **The famous/exciting version is often worse than the boring one.** (Donchian breakout lost
   to a plain moving average; shorting lost to going to cash.)

> **Interview gold:** "I found a genuinely profitable strategy (PEAD) and *still didn't
> deploy it*, because it was too correlated to a sleeve I already had. Additivity matters
> more than standalone profitability."

---

## The THIRD sleeve — low-volatility (validated late June, deployed Aug 27)

The **low-volatility anomaly:** boring, low-volatility stocks have historically delivered
*better risk-adjusted returns* than exciting, high-volatility ones — the opposite of what
finance theory ("more risk = more reward") predicts. **Why it exists:** (1) investors
overpay for lottery-like, high-volatility stocks hoping for a moonshot, leaving the calm
ones underpriced; (2) many big investors can't use leverage, so they chase return by
buying risky stocks instead, bidding them up. **Mechanics:** each month, rank ~150 large
caps by their 126-day (6-month) realized volatility and hold the 15 *lowest*, equal-weight
(these end up being utilities, staples, REITs — Coca-Cola, Duke Energy, Realty Income).

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
