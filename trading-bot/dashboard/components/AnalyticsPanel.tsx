'use client';
import { useEffect, useRef, useState } from 'react';
import { BotState, SessionLog, PatternStats, TradeRecord } from '@/lib/types';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, PieChart, Pie,
} from 'recharts';

interface AnalyticsPanelProps {
  state:        BotState;
  session:      SessionLog | null;
  patternStats: PatternStats[];
  performance:  { date: string; pnl: number; winRate: number }[];
  closedTrades: TradeRecord[];
}

function StatCard({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color: string;
}) {
  return (
    <div className="rounded-lg p-3 flex flex-col gap-0.5"
         style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <p className="text-xs mono" style={{ color: '#4b5563' }}>{label}</p>
      <p className="text-lg font-bold mono" style={{ color }}>{value}</p>
      {sub && <p className="text-xs mono" style={{ color: '#4b5563' }}>{sub}</p>}
    </div>
  );
}

function fmt(v: number | undefined | null, decimals = 2): string {
  const n = typeof v === 'number' && isFinite(v) ? v : 0;
  return n.toFixed(decimals);
}

function PnLTooltip({ active, payload }: { active?: boolean; payload?: { value?: number }[] }) {
  if (!active || !payload?.length) return null;
  const v = typeof payload[0]?.value === 'number' ? payload[0].value : 0;
  return (
    <div className="glass px-2 py-1.5 rounded text-xs mono" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
      <span style={{ color: v >= 0 ? '#00ff9f' : '#ff4d6d' }}>
        {v >= 0 ? '+' : ''}${fmt(v)}
      </span>
    </div>
  );
}

export default function AnalyticsPanel({
  state, session, patternStats, performance, closedTrades
}: AnalyticsPanelProps) {
  // Defer chart rendering until the container has real dimensions.
  // Recharts crashes when mounted inside a hidden/zero-size container.
  const containerRef = useRef<HTMLDivElement>(null);
  const [chartsReady, setChartsReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.contentRect.width > 10) {
          setChartsReady(true);
          observer.disconnect();
          break;
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const total   = closedTrades.length;
  const wins    = closedTrades.filter(t => t.outcome === 'WIN').length;
  const losses  = closedTrades.filter(t => t.outcome === 'LOSS').length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  const winTrades  = closedTrades.filter(t => t.outcome === 'WIN');
  const lossTrades = closedTrades.filter(t => t.outcome === 'LOSS');
  const avgWin  = winTrades.length  ? winTrades.reduce( (s, t) => s + (t.realizedPnL ?? 0), 0) / winTrades.length  : 0;
  const avgLoss = lossTrades.length ? lossTrades.reduce((s, t) => s + (t.realizedPnL ?? 0), 0) / lossTrades.length : 0;

  const totalPnl    = session?.dailyPnL    ?? 0;
  const capitalUsed = session?.dailySpentUsd ?? 0;

  // Max drawdown from performance history
  let peak = 0, maxDD = 0, running = 0;
  for (const d of performance) {
    running += d.pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }
  const startVal  = session?.startingValue ?? 100_000;
  const maxDDPct  = peak > 0 ? (maxDD / startVal) * 100 : 0;

  // Outcome distribution for pie chart
  const pieData = [
    { name: 'Wins',   value: wins,   color: '#00ff9f' },
    { name: 'Losses', value: losses, color: '#ff4d6d' },
  ].filter(d => d.value > 0);

  // Use real pattern stats, or session-derived if none available
  const statsData = patternStats.length > 0 ? patternStats : (() => {
    const map: Record<string, { wins: number; total: number }> = {};
    for (const t of closedTrades) {
      const p = t.pattern ?? 'No Pattern';
      if (!map[p]) map[p] = { wins: 0, total: 0 };
      map[p].total++;
      if (t.outcome === 'WIN') map[p].wins++;
    }
    return Object.entries(map).map(([pattern, { wins: w, total: tot }]) => ({
      pattern, trades: tot, wins: w, losses: tot - w,
      winRate: tot > 0 ? w / tot : 0, avgPnLPct: 0,
    }));
  })();

  return (
    <div ref={containerRef}
         className="glass rounded-xl p-4 flex flex-col gap-4 h-full hover-glow overflow-y-auto">
      <h2 className="text-sm font-semibold mono tracking-wide flex-shrink-0" style={{ color: '#e0e0e0' }}>
        ANALYTICS
      </h2>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2 flex-shrink-0">
        <StatCard label="WIN RATE"     value={`${fmt(winRate, 1)}%`}                color="#00ff9f" />
        <StatCard label="TOTAL TRADES" value={`${total}`}                          color="#e0e0e0" />
        <StatCard label="MAX DRAWDOWN" value={`${fmt(maxDDPct)}%`}                color="#f59e0b" />
        <StatCard label="AVG WIN"      value={`+$${fmt(avgWin)}`}                 color="#00ff9f" />
        <StatCard label="AVG LOSS"     value={`$${fmt(avgLoss)}`}                 color="#ff4d6d" />
        <StatCard label="NET P&L"      value={`${totalPnl >= 0 ? '+' : ''}$${fmt(totalPnl)}`}
                  color={totalPnl >= 0 ? '#00ff9f' : '#ff4d6d'} />
      </div>

      {/* P&L chart */}
      {chartsReady && performance.length > 0 && (
        <div className="flex-shrink-0">
          <p className="text-xs mono mb-2" style={{ color: '#4b5563' }}>HISTORICAL P&L (per session)</p>
          <div style={{ height: 90 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={performance} margin={{ top: 2, right: 2, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#00ff9f" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#00ff9f" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fill: '#4b5563', fontSize: 9, fontFamily: 'JetBrains Mono' }}
                       axisLine={false} tickLine={false} />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip content={<PnLTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.08)' }} />
                <Area type="monotone" dataKey="pnl" stroke="#00ff9f" strokeWidth={1.5}
                      fill="url(#pnlGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Win/Loss pie */}
      {chartsReady && pieData.length > 0 && (
        <div className="flex-shrink-0 flex items-center gap-4">
          <div style={{ width: 80, height: 80, flexShrink: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" cx="50%" cy="50%" innerRadius={22} outerRadius={36}
                     strokeWidth={0}>
                  {pieData.map((d, i) => (
                    <Cell key={i} fill={d.color} fillOpacity={0.85} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-col gap-1">
            {pieData.map(d => (
              <div key={d.name} className="flex items-center gap-2 text-xs mono">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: d.color }} />
                <span style={{ color: '#6b7280' }}>{d.name}:</span>
                <span style={{ color: d.color }}>{d.value}</span>
              </div>
            ))}
            <div className="text-xs mono mt-1" style={{ color: '#4b5563' }}>
              Capital used: <span style={{ color: '#e0e0e0' }}>${fmt(capitalUsed, 0)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Pattern win rates */}
      {chartsReady && statsData.length > 0 && (
        <div className="flex-shrink-0">
          <p className="text-xs mono mb-2" style={{ color: '#4b5563' }}>PATTERN WIN RATES</p>
          <div style={{ height: 90 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statsData} margin={{ top: 2, right: 2, left: 0, bottom: 0 }} barSize={16}>
                <XAxis dataKey="pattern"
                       tick={{ fill: '#4b5563', fontSize: 8, fontFamily: 'JetBrains Mono' }}
                       axisLine={false} tickLine={false}
                       tickFormatter={v => v.split(' ')[0].slice(0, 6).toUpperCase()} />
                <YAxis hide domain={[0, 1]} />
                <Tooltip
                  formatter={(v) => [`${fmt(typeof v === 'number' ? v * 100 : 0, 1)}%`, 'Win Rate']}
                  contentStyle={{ background: 'rgba(10,10,15,0.95)', border: '1px solid rgba(255,255,255,0.1)',
                                  fontFamily: 'JetBrains Mono', fontSize: 11 }}
                  itemStyle={{ color: '#00cfff' }}
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                />
                <Bar dataKey="winRate" radius={[2, 2, 0, 0]}>
                  {statsData.map((entry, i) => (
                    <Cell key={i}
                          fill={entry.winRate >= 0.6 ? '#00ff9f' : entry.winRate >= 0.45 ? '#00cfff' : '#ff4d6d'}
                          fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* No data state */}
      {total === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center py-8" style={{ color: '#4b5563' }}>
          <p className="text-xs mono">No closed trades yet this session.</p>
          <p className="text-xs mono mt-1">Analytics will populate as trades complete.</p>
        </div>
      )}
    </div>
  );
}
