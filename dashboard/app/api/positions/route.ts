import { NextResponse } from 'next/server';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// /api/positions
//
// Returns enriched position data by combining:
//   1. Live Alpaca positions (current price, unrealized P&L)
//   2. Today's session log (entry decision, scores, pattern, narrative)
//
// This gives the dashboard the full picture — not just "we hold X shares"
// but WHY we entered, what the signal scores were, and how it's tracking.
// ─────────────────────────────────────────────────────────────────────────────

const BASE   = process.env.ALPACA_BASE_URL!;
const KEY    = process.env.ALPACA_API_KEY!;
const SECRET = process.env.ALPACA_SECRET_KEY!;

const alpacaHeaders = {
  'APCA-API-KEY-ID':     KEY,
  'APCA-API-SECRET-KEY': SECRET,
};

// Reads today's session log to find matching open trade records
function getTodayOpenTrades(): Record<string, {
  finalScore:    number;
  orbScore:      number;
  macroScore:    number;
  sentimentScore: number;
  whaleScore:    number;
  technicalScore: number;
  pattern:       string | null;
  enteredAt:     string;
  stopPrice:     number | null;
  targetPrice:   number | null;
}> {
  const logsDir = path.join(process.cwd(), '..', 'logs', 'sessions');
  if (!existsSync(logsDir)) return {};

  // Try today first, then most recent
  const today = new Date().toISOString().split('T')[0];
  const todayPath = path.join(logsDir, `${today}.json`);

  let sessionData: { trades?: {
    symbol: string; outcome: string; enteredAt: string;
    decision?: { finalScore: number; confidence: number; scores: Record<string, number>; pattern: string | null };
    stopPrice?: number; targetPrice?: number;
  }[] } | null = null;

  if (existsSync(todayPath)) {
    try { sessionData = JSON.parse(readFileSync(todayPath, 'utf8')); } catch { /* skip */ }
  } else {
    const files = readdirSync(logsDir).filter(f => f.endsWith('.json')).sort().reverse();
    if (files.length > 0) {
      try { sessionData = JSON.parse(readFileSync(path.join(logsDir, files[0]), 'utf8')); } catch { /* skip */ }
    }
  }

  if (!sessionData?.trades) return {};

  const result: ReturnType<typeof getTodayOpenTrades> = {};
  for (const trade of sessionData.trades) {
    if (trade.outcome !== 'OPEN') continue;
    result[trade.symbol] = {
      finalScore:     trade.decision?.finalScore     ?? 0,
      orbScore:       trade.decision?.confidence     ?? 0,
      macroScore:     trade.decision?.scores?.macro       ?? 0,
      sentimentScore: trade.decision?.scores?.sentiment   ?? 0,
      whaleScore:     trade.decision?.scores?.whale       ?? 0,
      technicalScore: trade.decision?.scores?.technical   ?? 0,
      pattern:        trade.decision?.pattern ?? null,
      enteredAt:      trade.enteredAt,
      stopPrice:      trade.stopPrice   ?? null,
      targetPrice:    trade.targetPrice ?? null,
    };
  }
  return result;
}

export async function GET() {
  try {
    // Fetch live positions from Alpaca
    const res = await fetch(`${BASE}/v2/positions`, {
      headers: alpacaHeaders,
      cache:   'no-store',
    });

    if (!res.ok) {
      return NextResponse.json({ error: `Alpaca error: ${res.status}` }, { status: res.status });
    }

    const raw = await res.json() as {
      symbol:          string;
      qty:             string;
      avg_entry_price: string;
      current_price:   string;
      market_value:    string;
      unrealized_pl:   string;
      unrealized_plpc: string;
      side:            string;
    }[];

    if (!Array.isArray(raw)) {
      return NextResponse.json({ positions: [] });
    }

    // Enrich with session log data
    const sessionTrades = getTodayOpenTrades();

    const positions = raw.map(p => {
      const session = sessionTrades[p.symbol] ?? null;
      const entryPrice    = parseFloat(p.avg_entry_price);
      const currentPrice  = parseFloat(p.current_price);
      const marketValue   = parseFloat(p.market_value);
      const unrealizedPnL = parseFloat(p.unrealized_pl);
      const unrealizedPct = parseFloat(p.unrealized_plpc);

      // Calculate distance to stop/target if available
      const stopDistance = session?.stopPrice
        ? ((session.stopPrice - currentPrice) / currentPrice) * 100
        : null;
      const targetDistance = session?.targetPrice
        ? ((session.targetPrice - currentPrice) / currentPrice) * 100
        : null;

      return {
        symbol:          p.symbol,
        qty:             parseFloat(p.qty),
        entryPrice,
        currentPrice,
        marketValue,
        unrealizedPnL:   Math.round(unrealizedPnL  * 100) / 100,
        unrealizedPct:   Math.round(unrealizedPct  * 10000) / 10000,
        side:            p.side,
        // Session intelligence
        finalScore:      session?.finalScore      ?? null,
        orbScore:        session?.orbScore         ?? null,
        macroScore:      session?.macroScore       ?? null,
        sentimentScore:  session?.sentimentScore   ?? null,
        whaleScore:      session?.whaleScore       ?? null,
        technicalScore:  session?.technicalScore   ?? null,
        pattern:         session?.pattern          ?? 'ORB',
        enteredAt:       session?.enteredAt        ?? null,
        stopPrice:       session?.stopPrice        ?? null,
        targetPrice:     session?.targetPrice      ?? null,
        stopDistancePct:   stopDistance   !== null ? Math.round(stopDistance   * 100) / 100 : null,
        targetDistancePct: targetDistance !== null ? Math.round(targetDistance * 100) / 100 : null,
      };
    });

    return NextResponse.json({ positions });
  } catch (e) {
    console.error('[positions] Internal error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
