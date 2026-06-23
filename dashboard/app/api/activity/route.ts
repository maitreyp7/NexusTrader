import { NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// /api/activity — recent filled orders across both bots, tagged by bot.
// A simple chronological feed (newest first) so the Activity page can show what
// was bought/sold and when, per bot. Read-only.
// ─────────────────────────────────────────────────────────────────────────────

const BASE   = process.env.ALPACA_BASE_URL!;
const KEY    = process.env.ALPACA_API_KEY!;
const SECRET = process.env.ALPACA_SECRET_KEY!;

const headers = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };

const BRAIN_SYMBOLS = new Set<string>([
  'SPY','QQQ','IWM','EFA','EEM','TLT','IEF','DBC','GLD','USO','UUP','BTC/USD','ETH/USD',
]);
function botFor(symbol: string): 'Brain' | 'Mean-rev' {
  return BRAIN_SYMBOLS.has(symbol) ? 'Brain' : 'Mean-rev';
}

export async function GET() {
  try {
    const params = new URLSearchParams({ status: 'closed', limit: '200', direction: 'desc' });
    const res = await fetch(`${BASE}/v2/orders?${params}`, { headers, cache: 'no-store' });
    if (!res.ok) return NextResponse.json({ error: `Alpaca error: ${res.status}` }, { status: res.status });

    const raw = await res.json() as {
      id: string; symbol: string; side: 'buy' | 'sell';
      filled_qty: string; filled_avg_price: string | null;
      notional: string | null; status: string; filled_at: string | null; submitted_at: string;
    }[];
    if (!Array.isArray(raw)) return NextResponse.json({ activity: [] });

    const filled = raw
      .filter(o => o.status === 'filled' && parseFloat(o.filled_qty) > 0)
      .map(o => {
        const qty   = parseFloat(o.filled_qty);
        const price = o.filled_avg_price ? parseFloat(o.filled_avg_price) : null;
        const value = price !== null ? qty * price : (o.notional ? parseFloat(o.notional) : null);
        return {
          id:     o.id,
          symbol: o.symbol,
          bot:    botFor(o.symbol),
          side:   o.side,
          qty:    Math.round(qty * 1000) / 1000,
          price,
          value:  value !== null ? Math.round(value * 100) / 100 : null,
          at:     o.filled_at ?? o.submitted_at,
        };
      });

    // group by ET day for the page to render date sections
    const byDay: Record<string, typeof filled> = {};
    for (const a of filled) {
      const day = new Date(a.at).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
      (byDay[day] ??= []).push(a);
    }

    return NextResponse.json({
      activity: filled,
      byDay: Object.entries(byDay).map(([day, items]) => ({ day, items })),
      count: filled.length,
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
