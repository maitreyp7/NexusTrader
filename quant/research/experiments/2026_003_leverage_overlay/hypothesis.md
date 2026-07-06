# Experiment 2026_003 — leverage_overlay
_Created 2026-07-06_

## Hypothesis
The blended system (Sharpe ~1.25, vol ~7%) is UNDER-levered: modest leverage
(1.25-2.0x) converts excess Sharpe into CAGR faster than financing costs and
drawdown growth take it back.

## Economic rationale
Not an edge — a sizing decision on an already-proven edge. A Sharpe-1.25 / 7%-vol
portfolio is far below the risk most investors accept (SPY: Sharpe ~0.5, vol ~16%).
Textbook result (vol-targeting literature, Man Group / Alpha Architect 2026 reviews):
scaling a high-Sharpe low-vol stream toward normal vol raises CAGR roughly linearly
while Sharpe only pays the financing spread. Alpaca allows 2x overnight margin on
equities (crypto is non-marginable — caps practical leverage below ~2x).

## Expected behavior
- Holding period: unchanged (overlay on existing sleeves)
- Turnover: scales linearly with L (costs already linear in the engine)
- Expected capacity: fine at our size
- Direction (long/short/both): long-only, levered

## Required data
- Sleeve return streams: already have (brain / mean-rev / low-vol)
- Financing rate history: ^IRX (13-week T-bill, Yahoo, 1970+) — FREE
  margin cost modeled as IRX + 2.5% spread (≈ Alpaca's 6.25% today) charged daily
  on borrowed fraction (L-1)

## Assumptions
- Margin rate ≈ IRX + 2.5% holds across history (retail margin has always priced
  as short-rate + spread; today: IRX ~3.8% + 2.5% ≈ Alpaca 6.25% ✓)
- Daily rebalancing to target L (the runners already rebalance daily)
- Regime gate still works levered: brain de-risks to cash in risk-off, so levered
  exposure collapses exactly when it must

## Likely failure modes
- Financing drag eats the uplift in high-rate eras (1970s-80s, 2022+) — per-era test
- Drawdown grows super-linearly (vol drag / compounding) — watch MaxDD vs L
- Vol-targeted variant could whipsaw (lever up into calm, get caught by spikes)
- Behavioral: a -20% levered DD on real money = user abandons system (worst outcome)

## Status
- [x] hypothesis approved
- [x] implemented
- [x] validated
- [x] decision recorded

## Decision (2026-07-06)
**REJECTED.** CAGR is flat (+7.3%) at EVERY leverage level while MaxDD explodes
(-11% → -67% at 2x): the blend's return premium over retail margin (~IRX+2.5% ≈
6.9% avg) is ~zero, so leverage buys pure drawdown. Vol-targeting is worse still.
Full analysis: findings.md. Graveyard entry added.
