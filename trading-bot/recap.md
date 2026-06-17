# My-AI-Trading-Bot

## What We Trade
US equities and ETFs via Alpaca paper trading. No crypto.
Watchlist: QQQ, SPY, IWM, NVDA, AAPL, MSFT, TSLA, AMZN, META, AMD, GOOGL, JPM

## Strategy
Opening Range Breakout (ORB) — intraday, long-only.
- 9:00 AM: pre-market filter (VIX, economic calendar, day bias)
- 9:30–9:44 AM: build opening range from 1-minute candles
- 9:45–10:15 AM: watch for breakout above ORH with volume confirmation (1.3× avg)
- Stop: range midpoint. Target: entry + 1.5× range size. Hard close: 10:30 AM.
- Trading days: Tuesday, Wednesday, Thursday only (avoids Monday reversals, Friday chop)

## Signal Stack
- ORB breakout (30%) — primary trigger
- Technical indicators (35%) — RSI, MACD, MA on 5-minute bars
- Macro (20%) — SPY 5-day trend, VIX level via Alpaca
- Sentiment (10%) — Reddit r/investing, r/stocks, Fear & Greed
- Institutional flow (5%) — order book walls, relative volume, SPY put/call ratio

## Architecture
Multi-agent TypeScript system: orbAnalyst → decisionEngine → riskManager → executionEngine
Brain layer: adaptive weights, HMM regime detection, post-trade lessons, per-symbol memory

## Status
Active — paper trading

## Before Going Live With Real Money
- [ ] Change `vixKillSwitch` back to `30` in `src/config.ts` (currently raised to 60 for paper trading during high-volatility Apr 2026 period)
- [ ] Regenerate Alpaca and Groq API keys (current keys were exposed in a conversation)
- [ ] Minimum 6 weeks of paper trading results showing positive expectancy
