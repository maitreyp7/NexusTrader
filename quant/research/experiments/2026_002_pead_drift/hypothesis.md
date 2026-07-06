# Experiment 2026_002 — pead_drift
_Created 2026-07-06_

## Hypothesis
Stocks that beat earnings estimates AND get a positive market reaction continue to
drift upward for ~2-6 weeks after the announcement (Post-Earnings Announcement Drift),
enough to clear costs on large-cap names.

## Economic rationale
PEAD is one of the oldest documented anomalies (Ball & Brown 1968; Bernard & Thomas
1989): investors systematically UNDER-react to earnings news, so prices adjust slowly
over weeks instead of instantly. Behavioral (anchoring, limited attention) + structural
(institutions scale in gradually to limit impact). Our own gap-proxy test
(`quant/spike_research.py`, `quant/validate_drift.py`) showed +3.8% over 20d.
GRAVEYARD listed this as "STILL OPEN — blocked on paid data" — that block is now gone:
yfinance `get_earnings_dates()` returns ~24yr of earnings dates + EPS surprise free
(verified 2026-07-06: AAPL back to 2002, JPM to 2001, incl. BMO/AMC timestamps).

## Expected behavior
- Holding period: 10-30 trading days per position
- Turnover: episodic — clusters in earnings season, flat between
- Expected capacity: fine at our size (large caps only)
- Direction (long/short/both): LONG only (Alpaca constraint; short leg not tradable)

## Required data
- Daily bars: already have (Yahoo, `quant/data_cache/`)
- Earnings dates + surprise: yfinance `get_earnings_dates(limit=100)` — FREE
  (cached to `earnings_cache/` in this folder)

## Assumptions
- Yahoo's earnings timestamps are accurate enough to avoid look-ahead
  (BMO/AMC handled conservatively: signal only acts on the close AFTER the
  reaction is fully public; we forfeit the announcement-day move itself)
- Surprise(%) as reported by Yahoo ≈ what the market saw at the time
  (estimates are point-in-time consensus; some restatement risk)

## Likely failure modes
- DECAY: PEAD is famous → heavily arbitraged in large caps post-2010. The recent-half
  gate is the key test here.
- Survivorship: STOCK_UNIVERSE is today's large caps (same caveat as mean-rev sleeve;
  mitigated by short holds + recent-half gate + era consistency).
- Look-ahead via revised estimates: Yahoo may show final consensus, not the consensus
  at announcement time. Mitigation: require the REACTION-day return to confirm — the
  market's own reaction is point-in-time by construction and carries the signal even
  if Surprise(%) is imperfect.
- Earnings-season clustering → bursty exposure; correlation to mean-rev sleeve must
  stay < 0.35-ish to earn a slot.

## Status
- [x] hypothesis approved
- [x] implemented
- [x] validated
- [x] decision recorded

## Decision (2026-07-06)
**Standalone: PAPER_TRADE** — Sharpe 0.70, +9.8%/yr, 9/9 eras positive, survives 2x
costs (0.65), robust plateau across hold_days 5-30, and the edge is STRONGER in the
recent half (0.86 vs 0.57) — no decay. The free-data unlock worked; the gap-proxy
hunch was right.

**But: NOT added as a sleeve.** Blend test (`test_pead_blend.py`):
- vs current 2-bot system: best 3-way (60/25/15 pead) = Sharpe 1.20→1.216, DD
  -11.5→-9.9% — marginal, below the improvement bar.
- vs the planned July-14 3-bot world (60 br / 25 mr / 15 lowvol, Sharpe 1.256):
  EVERY 4-way config with PEAD is worse. Cause: **PEAD correlates 0.601 to low-vol**
  — both are long quality large-caps drifting upward. Same slot, and low-vol is the
  stronger occupant (Sharpe 1.05 vs 0.70, 50yr sample vs 24yr).

**Disposition: BENCH.** If low-vol disappoints live (fails its 2-3 clean weeks or
decays), PEAD is the validated, ready-to-go replacement — runner would mirror
meanrev_runner.py, earnings dates refresh free via yfinance.
