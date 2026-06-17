'use client';
import { useState, useEffect, useRef } from 'react';
import { MOCK_CANDLES, Candle } from '@/lib/mockData';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Area } from 'recharts';

const SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];

function formatPrice(v: number) {
  return v >= 1000 ? `$${(v/1000).toFixed(1)}k` : `$${v.toFixed(2)}`;
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: Candle & { ema: number } }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const bullish = d.c >= d.o;
  return (
    <div className="glass p-3 rounded-lg text-xs mono" style={{ border: '1px solid rgba(255,255,255,0.1)', minWidth: 160 }}>
      <p className="mb-2" style={{ color: '#6b7280' }}>{new Date(d.t).toLocaleTimeString('en-US', { hour12: false })}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span style={{ color: '#4b5563' }}>O</span><span style={{ color: '#e0e0e0' }}>${d.o.toFixed(2)}</span>
        <span style={{ color: '#4b5563' }}>H</span><span style={{ color: '#00ff9f' }}>${d.h.toFixed(2)}</span>
        <span style={{ color: '#4b5563' }}>L</span><span style={{ color: '#ff4d6d' }}>${d.l.toFixed(2)}</span>
        <span style={{ color: '#4b5563' }}>C</span>
        <span style={{ color: bullish ? '#00ff9f' : '#ff4d6d' }}>${d.c.toFixed(2)}</span>
        <span style={{ color: '#4b5563' }}>V</span><span style={{ color: '#6b7280' }}>{d.v.toFixed(0)}</span>
      </div>
    </div>
  );
}

// Compute EMA
function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = data[0];
  for (const v of data) {
    const e = v * k + prev * (1 - k);
    result.push(e);
    prev = e;
  }
  return result;
}

export default function CandlestickChart() {
  const [symbol, setSymbol] = useState('BTC/USD');
  const [candles, setCandles] = useState<(Candle & { ema20: number; ema50: number; barColor: string })[]>([]);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [priceChange, setPriceChange] = useState(0);
  const tickerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const raw = MOCK_CANDLES[symbol].slice(-50);
    const closes = raw.map(c => c.c);
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);

    const enriched = raw.map((c, i) => ({
      ...c,
      ema20: +ema20[i].toFixed(2),
      ema50: +ema50[i].toFixed(2),
      barColor: c.c >= c.o ? '#00ff9f' : '#ff4d6d',
    }));

    setCandles(enriched);
    setCurrentPrice(raw[raw.length - 1].c);
    setPriceChange(((raw[raw.length - 1].c - raw[0].c) / raw[0].c) * 100);
  }, [symbol]);

  // Simulate live price updates
  useEffect(() => {
    if (candles.length === 0) return;
    tickerRef.current = setInterval(() => {
      setCurrentPrice(p => {
        const delta = (Math.random() - 0.49) * p * 0.001;
        return +(p + delta).toFixed(2);
      });
    }, 2000);
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
                className={`px-2.5 py-1 rounded text-xs mono transition-all duration-200 cursor-pointer ${
                  symbol === s ? 'glass-accent' : 'hover:bg-white/5'
                }`}
                style={{ color: symbol === s ? '#00ff9f' : '#4b5563' }}
              >
                {s.replace('/USD', '')}
              </button>
            ))}
          </div>

          {/* Live price */}
          <div className="flex items-baseline gap-2">
            <span className={`text-lg font-bold mono ${priceUp ? 'glow-green' : 'glow-red'}`}
                  style={{ color: priceUp ? '#00ff9f' : '#ff4d6d' }}>
              {formatPrice(currentPrice)}
            </span>
            <span className="text-xs mono" style={{ color: priceUp ? '#00ff9f' : '#ff4d6d' }}>
              {priceUp ? '▲' : '▼'} {Math.abs(priceChange).toFixed(2)}%
            </span>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-xs mono" style={{ color: '#4b5563' }}>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 inline-block" style={{ background: '#00cfff' }} /> EMA 20
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-0.5 inline-block" style={{ background: '#f59e0b' }} /> EMA 50
          </span>
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={candles} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.04)"
              vertical={false}
            />
            <XAxis
              dataKey="t"
              tickFormatter={v => new Date(v).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}
              tick={{ fill: '#4b5563', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              axisLine={false}
              tickLine={false}
              interval={9}
            />
            <YAxis
              domain={['auto', 'auto']}
              tickFormatter={formatPrice}
              tick={{ fill: '#4b5563', fontSize: 10, fontFamily: 'JetBrains Mono' }}
              axisLine={false}
              tickLine={false}
              width={58}
              orientation="right"
            />
            <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }} />

            {/* Candle bodies as bars using low as baseline */}
            <Bar dataKey="c" fill="#00ff9f" radius={[1,1,0,0]} maxBarSize={8}
                 label={false}>
            </Bar>

            {/* EMA lines */}
            <Line dataKey="ema20" stroke="#00cfff" strokeWidth={1.5} dot={false} strokeOpacity={0.8} />
            <Line dataKey="ema50" stroke="#f59e0b" strokeWidth={1.5} dot={false} strokeOpacity={0.8} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
