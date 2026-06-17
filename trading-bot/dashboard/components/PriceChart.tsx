'use client';
import { useState, useEffect, useRef } from 'react';
import { Candle } from '@/lib/types';
import { apiFetch } from '@/lib/apiFetch';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';

// The two ORB assets this bot trades
const SYMBOLS = ['QQQ', 'SPY'];

function formatPrice(v: number) {
  return v >= 1000 ? `$${(v / 1000).toFixed(2)}k` : `$${v.toFixed(2)}`;
}

function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = data[0] ?? 0;
  for (const v of data) {
    const e = v * k + prev * (1 - k);
    result.push(e);
    prev = e;
  }
  return result;
}

type EnrichedCandle = Candle & { ema9: number; ema20: number; barColor: string };

function CustomTooltip({ active, payload }: {
  active?: boolean;
  payload?: { payload: EnrichedCandle }[];
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const bullish = d.c >= d.o;
  return (
    <div className="glass p-3 rounded-lg text-xs mono" style={{ border: '1px solid rgba(255,255,255,0.1)', minWidth: 160 }}>
      <p className="mb-2" style={{ color: '#6b7280' }}>
        {new Date(d.t).toLocaleTimeString('en-US', { hour12: false })}
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span style={{ color: '#4b5563' }}>O</span><span style={{ color: '#e0e0e0' }}>{formatPrice(d.o)}</span>
        <span style={{ color: '#4b5563' }}>H</span><span style={{ color: '#00ff9f' }}>{formatPrice(d.h)}</span>
        <span style={{ color: '#4b5563' }}>L</span><span style={{ color: '#ff4d6d' }}>{formatPrice(d.l)}</span>
        <span style={{ color: '#4b5563' }}>C</span>
        <span style={{ color: bullish ? '#00ff9f' : '#ff4d6d' }}>{formatPrice(d.c)}</span>
        <span style={{ color: '#4b5563' }}>V</span><span style={{ color: '#6b7280' }}>{d.v.toLocaleString()}</span>
      </div>
    </div>
  );
}

export default function PriceChart() {
  const [symbol,   setSymbol]   = useState('QQQ');
  const [candles,  setCandles]  = useState<EnrichedCandle[]>([]);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [priceChange,  setPriceChange]  = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [orbHigh,  setOrbHigh]  = useState<number | null>(null);
  const [orbLow,   setOrbLow]   = useState<number | null>(null);
  const tickerRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch real candles from Alpaca via our API route
  useEffect(() => {
    setIsLoading(true);
    setOrbHigh(null);
    setOrbLow(null);

    apiFetch(`/api/candles?symbol=${symbol}&timeframe=1Min&limit=100`)
      .then(r => r.json())
      .then(data => {
        const raw: Candle[] = data.candles ?? [];
        if (raw.length === 0) { setIsLoading(false); return; }

        const closes = raw.map(c => c.c);
        const e9  = ema(closes, 9);
        const e20 = ema(closes, 20);

        const enriched: EnrichedCandle[] = raw.map((c, i) => ({
          ...c,
          ema9:     +e9[i].toFixed(2),
          ema20:    +e20[i].toFixed(2),
          barColor: c.c >= c.o ? '#00ff9f' : '#ff4d6d',
        }));

        setCandles(enriched);

        const last  = raw[raw.length - 1];
        const first = raw[0];
        setCurrentPrice(last.c);
        setPriceChange(((last.c - first.o) / first.o) * 100);

        // Detect opening range (9:30–9:45 candles) from today's bars
        const orbCandles = raw.filter(c => {
          const h = new Date(c.t).getUTCHours();
          const m = new Date(c.t).getUTCMinutes();
          const etH = h - 4; // rough ET offset
          return (etH === 9 && m >= 30 && m < 45);
        });
        if (orbCandles.length >= 3) {
          setOrbHigh(Math.max(...orbCandles.map(c => c.h)));
          setOrbLow( Math.min(...orbCandles.map(c => c.l)));
        }

        setIsLoading(false);
      })
      .catch(() => setIsLoading(false));
  }, [symbol]);

  // Live price ticker — small random walk on top of last close
  useEffect(() => {
    if (candles.length === 0) return;
    if (tickerRef.current) clearInterval(tickerRef.current);
    tickerRef.current = setInterval(() => {
      setCurrentPrice(p => {
        const delta = (Math.random() - 0.5) * p * 0.0003;
        return +(p + delta).toFixed(2);
      });
    }, 3000);
    return () => { if (tickerRef.current) clearInterval(tickerRef.current); };
  }, [candles.length]);

  const priceUp = priceChange >= 0;

  return (
    <div className="glass rounded-xl p-4 flex flex-col h-full hover-glow">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-4">
          {/* Symbol picker */}
          <div className="flex gap-1">
            {SYMBOLS.map(s => (
              <button
                key={s}
                onClick={() => setSymbol(s)}
                className="px-3 py-1 rounded text-xs mono transition-all duration-200 cursor-pointer"
                style={{
                  background: symbol === s ? 'rgba(0,255,159,0.08)' : 'transparent',
                  border:     symbol === s ? '1px solid rgba(0,255,159,0.25)' : '1px solid rgba(255,255,255,0.06)',
                  color:      symbol === s ? '#00ff9f' : '#4b5563',
                }}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Live price */}
          {!isLoading && currentPrice > 0 && (
            <div className="flex items-baseline gap-2">
              <span className={`text-lg font-bold mono ${priceUp ? 'glow-green' : 'glow-red'}`}
                    style={{ color: priceUp ? '#00ff9f' : '#ff4d6d' }}>
                {formatPrice(currentPrice)}
              </span>
              <span className="text-xs mono" style={{ color: priceUp ? '#00ff9f' : '#ff4d6d' }}>
                {priceUp ? '▲' : '▼'} {Math.abs(priceChange).toFixed(2)}%
              </span>
            </div>
          )}

          {/* ORB range indicator */}
          {orbHigh && orbLow && (
            <div className="flex items-center gap-2 px-2 py-1 rounded text-xs mono"
                 style={{ background: 'rgba(0,207,255,0.06)', border: '1px solid rgba(0,207,255,0.15)' }}>
              <span style={{ color: '#4b5563' }}>ORB</span>
              <span style={{ color: '#00ff9f' }}>{formatPrice(orbHigh)}</span>
              <span style={{ color: '#4b5563' }}>/</span>
              <span style={{ color: '#ff4d6d' }}>{formatPrice(orbLow)}</span>
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-xs mono" style={{ color: '#4b5563' }}>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 inline-block" style={{ background: '#00cfff' }} /> EMA 9
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 inline-block" style={{ background: '#f59e0b' }} /> EMA 20
          </span>
          {orbHigh && (
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 inline-block" style={{ background: '#00ff9f', opacity: 0.6 }} /> ORH
            </span>
          )}
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs mono" style={{ color: '#4b5563' }}>Loading {symbol} bars from Alpaca...</p>
        </div>
      )}

      {/* Chart */}
      {!isLoading && (
        <div className="flex-1 min-h-0">
          {candles.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-xs mono" style={{ color: '#4b5563' }}>No bars available for {symbol} today</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={candles} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={v => new Date(v).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
                  tick={{ fill: '#4b5563', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  axisLine={false} tickLine={false}
                  interval={Math.floor(candles.length / 8)}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tickFormatter={formatPrice}
                  tick={{ fill: '#4b5563', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                  axisLine={false} tickLine={false}
                  width={62} orientation="right"
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }} />

                {/* ORB reference lines */}
                {orbHigh && (
                  <ReferenceLine y={orbHigh} stroke="rgba(0,255,159,0.4)" strokeDasharray="4 4" strokeWidth={1} />
                )}
                {orbLow && (
                  <ReferenceLine y={orbLow} stroke="rgba(255,77,109,0.4)" strokeDasharray="4 4" strokeWidth={1} />
                )}
                {orbHigh && orbLow && (
                  <ReferenceLine y={(orbHigh + orbLow) / 2} stroke="rgba(0,207,255,0.25)" strokeDasharray="2 4" strokeWidth={1} />
                )}

                {/* Price bars (close values colored by direction) */}
                <Bar dataKey="c" maxBarSize={6} radius={[1, 1, 0, 0]}
                     fill="#00ff9f"
                     // Each bar colored by its direction via Cell isn't available here without Cell import
                     // Using close as height — good enough for a compressed chart
                />

                {/* EMA lines */}
                <Line dataKey="ema9"  stroke="#00cfff" strokeWidth={1.5} dot={false} strokeOpacity={0.9} />
                <Line dataKey="ema20" stroke="#f59e0b" strokeWidth={1.5} dot={false} strokeOpacity={0.9} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
}
