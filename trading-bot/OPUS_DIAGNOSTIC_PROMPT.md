# NexusTrader ORB Bot — Full Post-Fix Diagnostic (Opus)

You are the final verification gate before this paper-trading bot is trusted to run unattended.
Sonnet just applied 13 fixes (see list below) and deployed. Your job: confirm the fixes are
correct, confirm they didn't break anything, audit the files the prior pass did NOT read, and
verify one clean live paper session. Be skeptical — assume a fix may be incomplete or wrong.

Local repo: /Users/maitreypatel/Documents/PersonalProjects/NexusTrader/trading-bot/
VPS: root@<VPS_IP>, /opt/nexustrader/orb-bot/ (systemd `trading-bot`). Alpaca PAPER.

## What was already fixed (verify each is correct & complete — do not assume)
1. P&L attributed from session journal, not shared-account equity
2. Reconnect records real exit price (not entry price) for offline-closed trades
3. Restart catch-up gated to live entry windows; pattern stamped by fill-time window
4. Per-symbol in-flight EXIT guard (pendingExits) to stop order thrashing
5. Direction-blind scoring fixed: one shared combineScore() flips macro/sentiment/whale/
   technical for SHORTs (NOT orbScore). ← the headline fix
6. Short entries now have SPY-direction gates (mirror of long path)
7. MACD gate moved after direction; long needs histogram>0, short needs <0
8. maxPositionSizePct (0.20) + maxTradeSizeUsd clamps enforced in executeEntry
9. Min stop-distance floor (ORB.minStopDistancePct ≈ 0.0025) before sizing
10. maxTradesPerAsset enforced session-wide (tradedSymbolsToday)
11. stopLossLimitOffsetPct reduced to ~0.002
12. positionManager max-hold made window-aware
13. Bracket child orders (stop + TP) verified resting on Alpaca

---

## Part A — Verify the 13 fixes in code

For EACH fix above, read the actual changed code and confirm:
- It does what's claimed, handles long AND short, and has no off-by-one / inverted-sign error.
- Specifically scrutinize:
  * Fix 5: confirm orbScore is NOT flipped; confirm all 6 strategy blocks now call the shared
    fn (grep for any remaining inline `* SIGNAL_WEIGHTS.` math — there should be none left).
    Trace one LONG and one SHORT example by hand and check the final number moves the right way.
  * Fix 8/9: pick a tight-range case (e.g. range 0.26%, $101k portfolio) and hand-compute the
    resulting position size — confirm it's now ≤ 20% and the stop is ≥ 0.25%.
  * Fix 2: confirm the Alpaca closed-order lookup actually finds the closing fill and parses
    filled_avg_price; confirm the no-fill fallback isn't entry price.
- Report any fix that is incomplete, wrong, or introduced a regression.

---

## Part B — Regression check on the LONG path (fixes 5–7 are the risk)

The direction-aware refactor is the most dangerous change. Confirm:
- Long entries still score the same as before the refactor (flip() is a no-op for longs).
- The long VWAP-reclaim path, momentum, mean-reversion (long), and VWAP-bounce still fire and
  still gate on SPY-EMA/MACD/EMA9 as before.
- No path can now enter a LONG when it previously would not have (and vice versa) except the
  intended short-suppression. Build a small truth table of (direction × bullish/bearish macro)
  and confirm scores move as intended:

  | Direction | Macro (bullish=0.84) | Expected finalScore movement |
  |-----------|---------------------|------------------------------|
  | LONG      | 0.84                | Higher (no flip)             |
  | SHORT     | 0.84                | Lower (flipped to 0.16)      |
  | LONG      | 0.20 (bearish)      | Lower                        |
  | SHORT     | 0.20 (bearish)      | Higher (flipped to 0.80)     |

---

## Part C — Audit the files NOT yet read (fresh eyes)

Read and audit these — they were out of scope in the bug-fix pass. These files handle learning
and P&L recording, so corrupted inputs here silently poison the brain over time.

### src/agents/brain.ts — learning loop
CRITICAL: confirm it is NOT training on corrupted history (Friday's fake break-evens from the
old Fix-2 bug, mislabeled "ORB SHORT" trades at 1:47 PM). Specifically:
- Does it weight lessons by outcome? If so, the fake $0.00 break-evens are being learned as
  "neutral" outcomes when they were actually losses or wins.
- Does it learn from the `pattern` field? If so, trades labeled "ORB SHORT" at 1:47 PM ET
  trained ORB-short pattern memory with midday data.
- Recommend whether to quarantine/reset pre-fix brain state (check the brain export file on VPS
  at /opt/nexustrader/signals/orb_brain_export.json and the journal files in logs/brain/).
- Check that the brain's signal-weight adjustment logic (if any) doesn't conflict with Fix 5 —
  if brain adjusts weights, confirm it can't re-break direction awareness.

### src/agents/journal.ts — P&L math and trade recording
- Confirm the Sharpe/Sortino calculations handle short P&L correctly (short profit =
  entry - exit, not exit - entry).
- Confirm break-even classification: a trade that exits at exactly entry price should be
  classified as BREAK_EVEN, not WIN or LOSS. Verify the threshold.
- Confirm that win-rate/pattern-stats used by the brain are built from correctly-attributed trades.

### src/agents/hmmRegime.ts — regime classification
- Sanity-check the crash/trend/ranging thresholds. Is there a risk that "crash" fires too
  aggressively and silently sets allocation to 0, disabling all trading?
- Confirm the allocation multiplier path in executeEntry (index.ts ~1078) can't accidentally
  leave the bot completely idle.

### src/agents/sentiment.ts + src/agents/whale.ts — score conventions
THIS IS THE MOST IMPORTANT CHECK IN PART C. Fix 5 flips sentiment and whale scores for shorts,
assuming they follow the same "bullish = high score" convention as macro and technical.
- If sentiment or whale do NOT follow that convention, Fix 5 is wrong for those signals.
- Read both files and confirm: does a high score (>0.5) mean bullish/accumulation? Does a low
  score (<0.5) mean bearish/distribution? Document the convention for each.
- If either signal uses the OPPOSITE convention (bearish = high), then Fix 5 should NOT flip
  that signal (it's already short-friendly when high). Flag immediately if so.

### src/core/backtester.ts + orbBacktester.ts
- Confirm nothing in the live trading path imports from the backtester at runtime.
- Confirm the backtester's sizing/P&L math would agree with the fixes (i.e. if you ran a
  backtest now, it would also apply the position-size cap and direction-aware scoring).

---

## Part D — Data integrity check (pull from VPS)

```bash
# Latest session JSON
ssh root@<VPS_IP> "cat /opt/nexustrader/orb-bot/logs/sessions/$(date +%Y-%m-%d).json 2>/dev/null || ls -lt /opt/nexustrader/orb-bot/logs/sessions/ | head -5"

# Brain export
ssh root@<VPS_IP> "cat /opt/nexustrader/signals/orb_brain_export.json | python3 -m json.tool | head -60"

# Latest journal
ssh root@<VPS_IP> "ls -lt /opt/nexustrader/orb-bot/logs/journal/ | head -5"
ssh root@<VPS_IP> "cat /opt/nexustrader/orb-bot/logs/journal/[LATEST].md"

# Monitor/bug report
ssh root@<VPS_IP> "cat /opt/nexustrader/orb-bot/logs/monitor/$(date +%Y-%m-%d).md 2>/dev/null || ls -lt /opt/nexustrader/orb-bot/logs/monitor/ | head -3"
```

Confirm:
- No "Unknown (reconnect)" exit-at-entry break-evens in sessions AFTER the fix date.
- Window labels (ORB/MIDDAY/POWER) match the expected fill time.
- No single trade sizeUsd > 20% of portfolioValue at entry time.
- No symbol appears more than once with outcome != OPEN.
- Brain export JSON is valid and timestamps are fresh.

---

## Part E — One clean live paper session

- Confirm `npx tsc --noEmit` clean locally.
- Confirm `npm test` passes if a test suite exists.
- Confirm the systemd service is running the post-fix build (check the binary timestamp vs
  the deploy time).
- Watch or review one full Mon–Fri session (or the next available session after fixes deployed):
  * On an UP day (SPY gaining), the bot takes LONGs or stands aside — NOT piling into shorts.
  * Each entry while open has a resting stop (stop/stop_limit) AND take-profit (limit) child
    order on Alpaca. (Ask the user to run the open-orders query with `!` if they hold creds.)
  * Stops not hitting within seconds of entry (Fix 9 working).
  * daytrade_count growing proportionally to actual round-trips, not 5–6× (Fix 4 working).
  * No position > 20% of portfolio (Fix 8 working).

---

## Output format

A **go / no-go verdict** for unattended paper running:

1. **Fix verification table** — all 13, each: PASS / INCOMPLETE / REGRESSION + one-line note.
2. **Part C findings** — new issues in unread files, severity-ranked. Specifically call out
   if the sentiment/whale convention check (Part C) means Fix 5 needs adjustment.
3. **Brain quarantine recommendation** — yes/no, with reasoning. Which sessions to exclude.
4. **Blocking issues** — short ranked list of anything that must be fixed before unattended run.
5. **Non-blocking notes** — things worth fixing later but not blocking.

Do NOT fix anything in this pass unless it is a one-line obvious typo blocking the build.
This is a diagnostic — hand all fixes back as a ranked list. The user will route them back
to Sonnet.
