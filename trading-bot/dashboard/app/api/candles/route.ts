import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

const DATA_BASE = 'https://data.alpaca.markets';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol    = searchParams.get('symbol') ?? 'QQQ';
  const timeframe = searchParams.get('timeframe') ?? '1Min';
  const limit     = searchParams.get('limit') ?? '78'; // ~78 1-min bars = full trading day

  const KEY    = process.env.ALPACA_API_KEY!;
  const SECRET = process.env.ALPACA_SECRET_KEY!;

  try {
    // Get bars for today (or last trading day if market closed)
    const start = new Date();
    start.setHours(9, 25, 0, 0); // 9:25 AM ET — just before open
    // Convert to UTC ISO (crude — assume ET = UTC-4 in summer)
    const startISO = new Date(start.getTime() + 4 * 3600 * 1000).toISOString().split('T')[0] + 'T13:25:00Z';

    const url = `${DATA_BASE}/v2/stocks/bars?symbols=${symbol}&timeframe=${timeframe}&start=${startISO}&limit=${limit}&sort=asc&feed=iex`;

    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID':     KEY,
        'APCA-API-SECRET-KEY': SECRET,
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      // If today's bars are empty (market closed / weekend), return last 50 daily bars
      const daily = await fetch(
        `${DATA_BASE}/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&limit=50&sort=asc&feed=iex`,
        {
          headers: {
            'APCA-API-KEY-ID':     KEY,
            'APCA-API-SECRET-KEY': SECRET,
          },
          cache: 'no-store',
        }
      );
      const dailyData = await daily.json() as { bars: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> };
      const bars = dailyData.bars?.[symbol] ?? [];
      return NextResponse.json({ symbol, timeframe: '1Day', candles: bars });
    }

    const data = await res.json() as { bars: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> };
    const bars = data.bars?.[symbol] ?? [];

    if (bars.length === 0) {
      // Market closed — return last 50 daily bars as fallback
      const daily = await fetch(
        `${DATA_BASE}/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&limit=50&sort=asc&feed=iex`,
        {
          headers: {
            'APCA-API-KEY-ID':     KEY,
            'APCA-API-SECRET-KEY': SECRET,
          },
          cache: 'no-store',
        }
      );
      const dailyData = await daily.json() as { bars: Record<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]> };
      const dailyBars = dailyData.bars?.[symbol] ?? [];
      return NextResponse.json({ symbol, timeframe: '1Day', candles: dailyBars });
    }

    return NextResponse.json({ symbol, timeframe, candles: bars });
  } catch (e) {
    console.error('[candles] Internal error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
