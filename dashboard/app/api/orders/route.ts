import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

const BASE   = process.env.ALPACA_BASE_URL!;
const KEY    = process.env.ALPACA_API_KEY!;
const SECRET = process.env.ALPACA_SECRET_KEY!;

const headers = {
  'APCA-API-KEY-ID':     KEY,
  'APCA-API-SECRET-KEY': SECRET,
};

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get('date'); // YYYY-MM-DD, defaults to today

    // Get today's date in ET
    const etStr  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = new Date(etStr);
    const today  = date ?? `${etDate.getFullYear()}-${String(etDate.getMonth()+1).padStart(2,'0')}-${String(etDate.getDate()).padStart(2,'0')}`;

    const after  = `${today}T00:00:00-04:00`;
    const until  = `${today}T23:59:59-04:00`;

    // Fetch filled orders for the day
    const params = new URLSearchParams({
      status: 'closed',
      after,
      until,
      limit: '100',
      direction: 'asc',
    });

    const res = await fetch(`${BASE}/v2/orders?${params}`, { headers, cache: 'no-store' });
    if (!res.ok) return NextResponse.json({ error: `Alpaca error: ${res.status}` }, { status: res.status });

    const raw = await res.json() as {
      id:             string;
      symbol:         string;
      side:           'buy' | 'sell';
      qty:            string;
      filled_qty:     string;
      filled_avg_price: string;
      order_type:     string;
      status:         string;
      submitted_at:   string;
      filled_at:      string | null;
      legs?:          unknown[];
    }[];

    if (!Array.isArray(raw)) return NextResponse.json({ orders: [] });

    // Only filled orders
    const filled = raw.filter(o => o.status === 'filled' && parseFloat(o.filled_qty) > 0);

    // Pair buys and sells into round trips
    const bySymbol: Record<string, typeof filled> = {};
    for (const o of filled) {
      if (!bySymbol[o.symbol]) bySymbol[o.symbol] = [];
      bySymbol[o.symbol].push(o);
    }

    const trades: {
      id:         string;
      symbol:     string;
      side:       string;
      qty:        number;
      entryPrice: number;
      exitPrice:  number | null;
      enteredAt:  string;
      exitedAt:   string | null;
      pnl:        number | null;
      pnlPct:     number | null;
      status:     'open' | 'closed';
    }[] = [];

    for (const [symbol, orders] of Object.entries(bySymbol)) {
      // Sort all orders chronologically
      const sorted = [...orders].sort((a, b) =>
        new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime()
      );

      // Walk through orders in time order — detect long vs short by first order side
      const longBuys:  typeof sorted = [];
      const longSells: typeof sorted = [];
      const shortSells: typeof sorted = [];
      const shortBuys:  typeof sorted = [];

      // Simple state machine: track net position
      let net = 0;
      for (const o of sorted) {
        const qty = parseFloat(o.filled_qty);
        if (o.side === 'buy') {
          if (net < 0) {
            shortBuys.push(o);  // covering a short
          } else {
            longBuys.push(o);   // opening a long
          }
          net += qty;
        } else {
          if (net > 0) {
            longSells.push(o);  // closing a long
          } else {
            shortSells.push(o); // opening a short
          }
          net -= qty;
        }
      }

      // Pair long trades (buy→sell)
      const lbq = [...longBuys];
      const lsq = [...longSells];
      while (lbq.length > 0) {
        const buy  = lbq.shift()!;
        const sell = lsq.shift() ?? null;
        const entry = parseFloat(buy.filled_avg_price);
        const qty   = parseFloat(buy.filled_qty);
        const exit  = sell ? parseFloat(sell.filled_avg_price) : null;
        const pnl   = exit !== null ? (exit - entry) * qty : null;
        trades.push({
          id: buy.id, symbol, side: 'long', qty, entryPrice: entry, exitPrice: exit,
          enteredAt: buy.filled_at ?? buy.submitted_at,
          exitedAt:  sell?.filled_at ?? null,
          pnl:    pnl !== null ? Math.round(pnl * 100) / 100 : null,
          pnlPct: pnl !== null ? Math.round((pnl / (entry * qty)) * 10000) / 10000 : null,
          status: exit !== null ? 'closed' : 'open',
        });
      }

      // Pair short trades (sell→buy cover)
      const ssq = [...shortSells];
      const sbq = [...shortBuys];
      while (ssq.length > 0) {
        const sell  = ssq.shift()!;
        const cover = sbq.shift() ?? null;
        const entry = parseFloat(sell.filled_avg_price);
        const qty   = parseFloat(sell.filled_qty);
        const exit  = cover ? parseFloat(cover.filled_avg_price) : null;
        const pnl   = exit !== null ? (entry - exit) * qty : null;
        trades.push({
          id: sell.id, symbol, side: 'short', qty, entryPrice: entry, exitPrice: exit,
          enteredAt: sell.filled_at ?? sell.submitted_at,
          exitedAt:  cover?.filled_at ?? null,
          pnl:    pnl !== null ? Math.round(pnl * 100) / 100 : null,
          pnlPct: pnl !== null ? Math.round((pnl / (entry * qty)) * 10000) / 10000 : null,
          status: exit !== null ? 'closed' : 'open',
        });
      }
    }

    // Sort by entry time
    trades.sort((a, b) => new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime());

    const totalPnl  = trades.filter(t => t.pnl !== null).reduce((s, t) => s + (t.pnl ?? 0), 0);
    const closed    = trades.filter(t => t.status === 'closed');
    const wins      = closed.filter(t => (t.pnl ?? 0) > 0).length;

    return NextResponse.json({
      date:     today,
      trades,
      summary: {
        total:   trades.length,
        closed:  closed.length,
        wins,
        losses:  closed.length - wins,
        winRate: closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
