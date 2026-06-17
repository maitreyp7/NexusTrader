// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA — all types now live in lib/types.ts
// This file re-exports them for backwards compatibility, and retains
// mock data constants used in tests or fallback scenarios.
// ─────────────────────────────────────────────────────────────────────────────
export type {
  TradeRecord, SessionLog, PatternStats,
  Candle, BotState, BotStatus,
} from './types';

import type { Candle, TradeRecord, SessionLog, PatternStats, BotState } from './types';

// ── Candle generation (for offline/fallback use) ──────────────────────────────
function generateCandles(base: number, count: number): Candle[] {
  const candles: Candle[] = [];
  let price = base;
  const now = Date.now();
  for (let i = count; i >= 0; i--) {
    const open  = price;
    const move  = (Math.random() - 0.48) * price * 0.012;
    const close = Math.max(price * 0.95, open + move);
    const high  = Math.max(open, close) * (1 + Math.random() * 0.005);
    const low   = Math.min(open, close) * (1 - Math.random() * 0.005);
    candles.push({
      t: new Date(now - i * 15 * 60 * 1000).toISOString(),
      o: +open.toFixed(2), h: +high.toFixed(2),
      l: +low.toFixed(2),  c: +close.toFixed(2),
      v: +(Math.random() * 500 + 100).toFixed(2),
    });
    price = close;
  }
  return candles;
}

export const MOCK_CANDLES: Record<string, Candle[]> = {
  'QQQ': generateCandles(480, 80),
  'SPY': generateCandles(556, 80),
};

// ── Mock trades (used when no session log available) ─────────────────────────
export const MOCK_TRADES: TradeRecord[] = [];

export const MOCK_SESSION: SessionLog = {
  date:              new Date().toISOString().split('T')[0],
  trades:            [],
  dailyPnL:          0,
  dailyPnLPct:       0,
  dailySpentUsd:     0,
  startingValue:     100_000,
  consecutiveLosses: 0,
  circuitBreakered:  false,
  sessionStartedAt:  new Date().toISOString(),
  sessionEndedAt:    null,
  strategyVersion:   'orb-v1',
};

export const MOCK_PATTERN_STATS: PatternStats[] = [];

export const MOCK_PERFORMANCE: { date: string; pnl: number; winRate: number }[] = [];

export interface LogLine {
  id:        number;
  timestamp: string;
  level:     'INFO' | 'WARN' | 'ERROR' | 'TRADE';
  message:   string;
}
export const MOCK_LOGS: LogLine[] = [];

export const MOCK_BOT_STATE: BotState = {
  status:          'PAUSED',
  portfolioValue:  0,
  cash:            0,
  activePositions: 0,
  dailyPnL:        0,
  dailyPnLPct:     0,
  sessionStart:    new Date().toISOString(),
  lastCycle:       new Date().toISOString(),
  nextCycle:       new Date().toISOString(),
  sharpeRatio:     0,
  totalTrades:     0,
  winRate:         0,
};
