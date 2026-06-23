// ─────────────────────────────────────────────────────────────────────────────
// SHARED TYPE DEFINITIONS
// These match the exact shapes produced by the bot's journal and session files.
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeRecord {
  tradeId:        string;
  symbol:         string;
  entryPrice:     number;
  exitPrice:      number | null;
  sizeUsd:        number;
  coinsTraded:    number;
  realizedPnL:    number | null;
  realizedPnLPct: number | null;
  outcome:        'WIN' | 'LOSS' | 'BREAK_EVEN' | 'OPEN';
  exitReason:     string | null;
  pattern:        string | null;
  decision: {
    action:     string;
    finalScore: number;
    threshold:  number;
    confidence: number;
    scores: {
      technical:      number;
      microstructure: number;
      sentiment:      number;
      whale:          number;
      macro:          number;
    };
    pattern: string | null;
  };
  enteredAt:          string;
  exitedAt:           string | null;
  durationMs:         number | null;
  // Live Alpaca fields (only present for _live positions)
  _currentPrice?:     number;
  _unrealizedPnL?:    number;
  _unrealizedPnLPct?: number;
  _botType?:          'swing' | 'dayTrade';
  botType?:           'swing' | 'dayTrade';
  _stopPrice?:        number | null;
  _targetPrice?:      number | null;
}

export interface SessionLog {
  date:              string;
  trades:            TradeRecord[];
  dailyPnL:          number;
  dailyPnLPct:       number;
  dailySpentUsd:     number;
  startingValue:     number;
  consecutiveLosses: number;
  circuitBreakered:  boolean;
  sessionStartedAt:  string;
  sessionEndedAt:    string | null;
  strategyVersion:   string;
}

export interface PatternStats {
  pattern:   string;
  trades:    number;
  wins:      number;
  losses:    number;
  winRate:   number;
  avgPnLPct: number;
}

export interface Candle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type BotStatus = 'LIVE' | 'PAUSED' | 'ERROR';

export interface BotState {
  status:          BotStatus;
  portfolioValue:  number;
  cash:            number;
  activePositions: number;
  dailyPnL:        number;
  dailyPnLPct:     number;
  orbPnL:          number;   // today's realized P&L from closed ORB trades
  orbWinRate:      number;   // all-time ORB win rate (0–1)
  orbTotalTrades:  number;   // all-time ORB closed round trips
  swingPnL:        number;   // all-time realized P&L from closed swing trades
  swingRealizedToday?: number; // TODAY's realized P&L from closed swing trades
  swingWinRate:    number;   // all-time swing win rate (0–1)
  swingTotalTrades: number;  // all-time swing closed round trips
  swingUnrealized: number;   // current unrealized P&L from open swing positions
  sessionStart:    string;
  lastCycle:       string;
  nextCycle:       string;
  sharpeRatio:     number;
  totalTrades:     number;
  winRate:         number;
}
