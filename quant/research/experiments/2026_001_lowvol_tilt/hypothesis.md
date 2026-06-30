# Experiment 2026_001 — lowvol_tilt
_Created 2026-06-30_

## Hypothesis
Owning the lowest-volatility large-cap stocks (monthly rebalance) earns strong
risk-adjusted returns — the "low-volatility anomaly."

## Economic rationale
Behavioral + structural: investors overpay for exciting/high-vol "lottery" stocks
and underprice boring low-vol ones; leverage constraints push funds toward high-beta
names. Result: low-vol stocks are persistently underpriced. One of the most documented
anomalies in finance (Baker-Bradley-Wurgler, Frazzini-Pedersen "Betting Against Beta").

## Expected behavior
- Holding period: ~1 month (monthly rebalance)
- Turnover: low-moderate
- Direction: long-only
- Capacity: high (large-caps)

## Required data
Daily prices for the large-cap universe — FREE (already have it).

## Likely failure modes
- All-equity → deep standalone drawdowns (-48% in 1973-75). Must be a SMALL sleeve.
- Well-known anomaly → some decay (recent-half Sharpe 0.80 vs first-half 1.37).
- 0.42 correlation to mean-rev → partial overlap, not fully independent.

## Result (2026-06-30)
- Standalone: PRODUCTION_CANDIDATE. Sharpe 1.05, +13%/yr, survives 2x cost (1.04),
  positive in 18/19 eras, recent half 0.80. Parameter stability: ROBUST PLATEAU
  (0.95 score, positive across 8-30 names — not overfit).
- BLEND test: at 60 brain / 25 mrev / 15 lowvol, improves the system on ALL axes:
  Sharpe 1.105->1.251, CAGR +6.4%->+7.3%, drawdown -11.8%->-11.3%.

## Status
- [x] hypothesis approved
- [x] implemented
- [x] validated
- [ ] decision recorded (awaiting user: build as 3rd bot, or hold until 2 bots prove out)
