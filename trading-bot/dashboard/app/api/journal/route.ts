import { NextResponse } from 'next/server';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

interface TradeRow {
  tradeId:    string;
  symbol:     string;
  entryPrice: number;
  exitPrice:  number | null;
  sizeUsd:    number;
  coinsTraded: number;
  realizedPnL: number | null;
  outcome:    string;
  durationMs: number | null;
  enteredAt:  string;
  exitedAt:   string | null;
  pattern?:   string;
  decision?:  { action?: string };
}

function correctedPnL(t: TradeRow): number {
  if (t.exitPrice == null) return 0;
  const isShort = (t.pattern ?? '').includes('SHORT');
  return isShort
    ? (t.entryPrice - t.exitPrice) * t.coinsTraded
    : (t.exitPrice - t.entryPrice) * t.coinsTraded;
}

function correctedOutcome(pnl: number): string {
  return pnl > 0.01 ? 'WIN' : pnl < -0.01 ? 'LOSS' : 'BREAK_EVEN';
}

export async function GET() {
  const logsDir = path.join(process.cwd(), '..', 'logs', 'sessions');
  if (!existsSync(logsDir)) {
    return NextResponse.json({ sessions: [] });
  }

  const files = readdirSync(logsDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const sessions = files.map(f => {
    try {
      const raw  = JSON.parse(readFileSync(path.join(logsDir, f), 'utf8'));
      const date = f.replace('.json', '');

      const closedTrades: TradeRow[] = (raw.trades ?? []).filter(
        (t: TradeRow) => t.outcome === 'WIN' || t.outcome === 'LOSS' || t.outcome === 'BREAK_EVEN'
      );

      const pnls   = closedTrades.map(t => correctedPnL(t));
      const outcomes = closedTrades.map((t, i) => correctedOutcome(pnls[i]));
      const wins   = outcomes.filter(o => o === 'WIN').length;
      const losses = outcomes.filter(o => o === 'LOSS').length;
      const total  = closedTrades.length;
      const grossPnL = pnls.reduce((a, b) => a + b, 0);

      const durations = closedTrades.map(t => t.durationMs ?? 0).filter(d => d > 0);
      const avgDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

      return {
        date,
        pnl:      grossPnL,
        trades:   total,
        wins,
        losses,
        winRate:  total > 0 ? wins / total : 0,
        grossPnL,
        bestTrade:  pnls.length ? Math.max(...pnls) : 0,
        worstTrade: pnls.length ? Math.min(...pnls) : 0,
        avgDurationMs,
        tradeList: closedTrades.map((t, i) => ({
          symbol:     t.symbol,
          entryPrice: t.entryPrice,
          exitPrice:  t.exitPrice,
          sizeUsd:    t.sizeUsd,
          qty:        t.coinsTraded,
          side:       (t.pattern ?? '').includes('SHORT') ? 'Short' : (t.decision?.action ?? 'Long'),
          pnl:        pnls[i],
          outcome:    outcomes[i],
          durationMs: t.durationMs,
          enteredAt:  t.enteredAt,
        })),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  return NextResponse.json({ sessions });
}
