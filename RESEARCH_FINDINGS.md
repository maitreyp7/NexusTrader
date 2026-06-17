# NexusTrader — Research Findings (June 11 2026)

External research to inform the roadmap before building more custom code.

## Key tools found

### Freqtrade (github.com/freqtrade/freqtrade) — 40k stars, active
~80% of NexusTrader's roadmap, already built + community-hardened: crypto bot, backtesting, walk-forward, multi-strategy, money mgmt, Telegram/Discord alerts.

### FreqAI (freqtrade.io/en/stable/freqai/) — = the "supervisor" concept, built
- Self-adaptive ML retraining on a BACKGROUND THREAD while trading continues (exactly the meta-brain idea).
- Model persistence (crash recovery), data cleaning/normalization, dimensionality reduction.
- FLEET DEPLOYMENT: one bot trains, many "consumer" bots use predictions.
- Predicts whatever you define as labels (future price move, regime, etc.).
- CATCHES: can't use dynamic pairlists (pairs fixed); needs extra deps; "example strategy is NOT for production" — ML trading is still hard even with the framework.

### Other: Jesse (jesse.trade, no look-ahead bias), hftbacktest (realistic latency/fills), asavinov/intelligent-trading-bot (ML signals + feature engineering).

## Crypto ORB specifics (github.com/yulz008/orb_cryptoBot)
- Crypto has no "market open" → use a daily anchor time; that repo uses the FIRST 15-min candle as the opening range.
- Range high/low updates on subsequent candles; breakout = signal.
- **Alpaca crypto = SPOT ONLY, no shorting → crypto-ORB must be LONG-ONLY** (real limitation vs stock ORB which does both directions).
- Stop/take-profit = user % (their example 2% stop / 10% TP), one position at a time.

## Walk-forward analysis = the formal method for Step 3 (validation loop)
Recipe: optimize params on a 2-4yr in-sample window → test on the NEXT unseen 3-6 months (no adjustment) → roll both windows forward → repeat → aggregate out-of-sample results into one equity curve.
- **Walk-Forward Efficiency (WFE) = out-of-sample return / in-sample return. >50-60% = real edge; below = overfit.**
- Detects decay: WFE dropping across windows = edge deteriorating. Reserve final 10-20% of data untouched until the end.
- This is EXACTLY what the auto-validator should compute before promoting any strategy live.

## ⚠️ REALITY CHECK (the most important finding — set expectations)
- ~5-10% of day traders are consistently profitable; only ~1% over 5 years; even among 400+ day-experienced traders only 9% profitable.
- **95% of backtested strategies fail in live markets** (90%+ of academic ones too).
- Realistic returns for the profitable minority: **+2% to +6% / month** (NOT the online fantasies). On $100k = $2-5k/mo — real but compounds slowly.
IMPLICATIONS: (1) Live data is GOLD — a break-even LIVE record beats a 300% backtest because backtests lie 95% of the time. Don't trade away the ORB live history. (2) The supervisor/monitoring layer is literally what puts you in the surviving 5% — not optional. (3) Target +2-5%/mo, not riches.

## Strategic recommendation (from research)
DON'T migrate the working stock ORB bot — it works, it's on Alpaca, leave it.
DO seriously evaluate Freqtrade/FreqAI for the NEW crypto expansion + the supervisor/validation layer (could save months, more robust than one person can build). = the HYBRID path. Catch: adopting FreqAI = save months of infra work BUT spend weeks learning a big framework, and ML trading is still hard.

Sources: freqtrade.io/en/stable/freqai/, github.com/yulz008/orb_cryptoBot, surmount.ai walk-forward guide, quantifiedstrategies.com day-trading-statistics.
