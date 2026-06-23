import { NextResponse } from 'next/server';

const BASE  = process.env.ALPACA_BASE_URL!;
const KEY   = process.env.ALPACA_API_KEY!;
const SECRET = process.env.ALPACA_SECRET_KEY!;

const headers = {
  'APCA-API-KEY-ID':     KEY,
  'APCA-API-SECRET-KEY': SECRET,
};

export async function GET() {
  try {
    const [accountRes, positionsRes] = await Promise.all([
      fetch(`${BASE}/v2/account`, { headers, cache: 'no-store' }),
      fetch(`${BASE}/v2/positions`, { headers, cache: 'no-store' }),
    ]);

    const account   = await accountRes.json();
    const positions = await positionsRes.json();

    const portfolioValue = parseFloat(account.portfolio_value);
    const lastEquity     = parseFloat(account.last_equity);
    const cash           = parseFloat(account.cash);
    const dailyPnL       = portfolioValue - lastEquity;
    const dailyPnLPct    = lastEquity > 0 ? dailyPnL / lastEquity : 0;

    return NextResponse.json({
      portfolioValue,
      cash,
      dailyPnL,
      dailyPnLPct,
      activePositions: Array.isArray(positions) ? positions.length : 0,
      status: account.status === 'ACTIVE' ? 'LIVE' : 'PAUSED',
      positions: Array.isArray(positions) ? positions.map((p: Record<string, string>) => ({
        symbol:       p.symbol,
        qty:          parseFloat(p.qty),
        entryPrice:   parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        marketValue:  parseFloat(p.market_value),
        unrealizedPnL:    parseFloat(p.unrealized_pl),
        unrealizedPnLPct: parseFloat(p.unrealized_plpc),
        side: p.side,
      })) : [],
    });
  } catch (e) {
    console.error('[account] Internal error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
