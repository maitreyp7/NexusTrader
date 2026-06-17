'use client';
import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Trophy, Target, Clock, X } from 'lucide-react';

interface DaySession {
  date:    string;
  pnl:     number;
  trades:  number;
  wins:    number;
  losses:  number;
  winRate: number;
  tradeList: TradeRow[];
  grossPnL:  number;
  bestTrade: number;
  worstTrade: number;
  avgDurationMs: number;
}

interface TradeRow {
  symbol:    string;
  entryPrice: number;
  exitPrice:  number | null;
  sizeUsd:   number;
  qty:       number;
  side:      string;
  pnl:       number | null;
  outcome:   string;
  durationMs: number | null;
  enteredAt: string;
}

// ─── greeting ──────────────────────────────────────────────────────────────────
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmtPnl(v: number, showSign = true): string {
  const sign = showSign && v >= 0 ? '+' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtDuration(ms: number | null): string {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ─── stat card ─────────────────────────────────────────────────────────────────
function MiniStat({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: string; color: string;
}) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#4b5563' }}>
        {icon}
        <span style={{ fontSize: 10, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.05em' }}>{label}</span>
      </div>
      <span style={{ fontSize: 20, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color }}>{value}</span>
    </div>
  );
}

// ─── calendar cell ─────────────────────────────────────────────────────────────
function CalCell({
  day, session, isToday, isSelected, onClick,
}: {
  day: number | null;
  session?: DaySession;
  isToday: boolean;
  isSelected: boolean;
  onClick: () => void;
}) {
  if (!day) {
    return <div style={{ minHeight: 72 }} />;
  }

  const hasTrades = session && session.trades > 0;
  const pnl       = session?.pnl ?? 0;
  const positive  = pnl >= 0;

  let bg = 'rgba(255,255,255,0.02)';
  if (hasTrades) bg = positive ? 'rgba(0,255,159,0.07)' : 'rgba(255,77,109,0.07)';
  if (isSelected) bg = positive ? 'rgba(0,255,159,0.14)' : 'rgba(255,77,109,0.14)';

  let border = '1px solid rgba(255,255,255,0.05)';
  if (isToday)    border = '1px solid rgba(0,207,255,0.4)';
  if (isSelected) border = `1px solid ${positive ? 'rgba(0,255,159,0.5)' : 'rgba(255,77,109,0.5)'}`;

  return (
    <div
      onClick={hasTrades ? onClick : undefined}
      style={{
        minHeight: 72, borderRadius: 8, padding: '8px 10px',
        background: bg, border,
        cursor: hasTrades ? 'pointer' : 'default',
        display: 'flex', flexDirection: 'column', gap: 3,
        transition: 'background 0.15s ease',
      }}
    >
      <span style={{
        fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
        color: isToday ? '#00cfff' : '#6b7280',
      }}>{day}</span>

      {hasTrades && (
        <>
          <span style={{
            fontSize: 13, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace',
            color: positive ? '#00ff9f' : '#ff4d6d',
          }}>
            {positive ? '+' : ''}{pnl >= 1000 ? `$${(pnl / 1000).toFixed(1)}K` : `$${Math.abs(pnl).toFixed(0)}`}
          </span>
          <span style={{ fontSize: 9, fontFamily: 'JetBrains Mono, monospace', color: '#4b5563' }}>
            {session.trades} trades
          </span>
        </>
      )}
    </div>
  );
}

// ─── day drill-down modal ──────────────────────────────────────────────────────
function DayDetail({ session, onClose }: { session: DaySession; onClose: () => void }) {
  const [sortBy, setSortBy] = useState<'time' | 'pnl'>('time');
  const pnlColor = session.pnl >= 0 ? '#00ff9f' : '#ff4d6d';

  const sorted = [...session.tradeList].sort((a, b) => {
    if (sortBy === 'pnl') return (b.pnl ?? 0) - (a.pnl ?? 0);
    return new Date(a.enteredAt).getTime() - new Date(b.enteredAt).getTime();
  });

  const [, m, d] = session.date.split('-');
  const dateLabel = new Date(`${session.date}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'long', day: 'numeric',
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: '#0a0b10', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16, padding: 24, width: 720, maxWidth: '95vw',
        maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 16,
      }} onClick={e => e.stopPropagation()}>

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ color: '#4b5563', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>{dateLabel}</p>
            <p style={{ color: pnlColor, fontSize: 26, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
              {fmtPnl(session.pnl)}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4b5563' }}>
            <X size={18} />
          </button>
        </div>

        {/* stat grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <MiniStat icon={<TrendingUp size={11} />}   label="GROSS P&L"    value={fmtPnl(session.grossPnL)}   color={pnlColor} />
          <MiniStat icon={<Trophy size={11} />}       label="WIN RATE"     value={`${(session.winRate * 100).toFixed(0)}%`} color="#00ff9f" />
          <MiniStat icon={<Target size={11} />}       label="WINNERS / LOSERS" value={`${session.wins} / ${session.losses}`} color="#e0e0e0" />
          <MiniStat icon={<Clock size={11} />}        label="AVG DURATION" value={fmtDuration(session.avgDurationMs)} color="#00cfff" />
          <MiniStat icon={<TrendingUp size={11} />}   label="BEST TRADE"   value={fmtPnl(session.bestTrade)}  color="#00ff9f" />
          <MiniStat icon={<TrendingDown size={11} />} label="WORST TRADE"  value={fmtPnl(session.worstTrade)} color="#ff4d6d" />
          <MiniStat icon={<Target size={11} />}       label="TOTAL TRADES" value={`${session.trades}`}        color="#e0e0e0" />
          <MiniStat icon={<TrendingUp size={11} />}   label="NET P&L"      value={fmtPnl(session.pnl)}       color={pnlColor} />
        </div>

        {/* trade table */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: '#4b5563' }}>
              {session.trades} TRADES
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['time', 'pnl'] as const).map(s => (
                <button key={s} onClick={() => setSortBy(s)} style={{
                  fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                  padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                  background: sortBy === s ? 'rgba(0,255,159,0.12)' : 'rgba(255,255,255,0.04)',
                  color: sortBy === s ? '#00ff9f' : '#4b5563',
                }}>
                  Sort: {s === 'time' ? 'By Time' : 'By P&L'}
                </button>
              ))}
            </div>
          </div>

          {/* table header */}
          <div style={{
            display: 'grid', gridTemplateColumns: '80px 70px 80px 80px 70px 60px 80px',
            gap: 8, padding: '6px 8px',
            fontSize: 9, fontFamily: 'JetBrains Mono, monospace', color: '#4b5563',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}>
            <span>SYMBOL</span><span>ENTRY</span><span>EXIT</span>
            <span>DURATION</span><span>SIDE</span><span>QTY</span><span>NET P&L</span>
          </div>

          <div style={{ overflow: 'auto', flex: 1 }}>
            {sorted.map((t, i) => {
              const rowColor = t.pnl !== null ? (t.pnl >= 0 ? '#00ff9f' : '#ff4d6d') : '#6b7280';
              return (
                <div key={i} style={{
                  display: 'grid', gridTemplateColumns: '80px 70px 80px 80px 70px 60px 80px',
                  gap: 8, padding: '7px 8px', alignItems: 'center',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                  fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
                }}>
                  <span style={{ color: '#e0e0e0', fontWeight: 600 }}>{t.symbol}</span>
                  <span style={{ color: '#9ca3af' }}>{t.entryPrice.toFixed(2)}</span>
                  <span style={{ color: '#9ca3af' }}>{t.exitPrice?.toFixed(2) ?? '—'}</span>
                  <span style={{ color: '#6b7280' }}>{fmtDuration(t.durationMs)}</span>
                  <span style={{
                    padding: '2px 6px', borderRadius: 4, fontSize: 9,
                    background: 'rgba(0,207,255,0.1)', color: '#00cfff', textAlign: 'center',
                  }}>{t.side}</span>
                  <span style={{ color: '#6b7280' }}>{t.qty.toFixed(2)}</span>
                  <span style={{ color: rowColor, fontWeight: 600 }}>
                    {t.pnl !== null ? fmtPnl(t.pnl) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── main panel ────────────────────────────────────────────────────────────────
export default function JournalPanel() {
  const now   = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-indexed
  const [sessions, setSessions] = useState<DaySession[]>([]);
  const [selected, setSelected] = useState<DaySession | null>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    setLoading(true);
    apiFetch('/api/journal')
      .then(r => r.json())
      .then(d => { setSessions(d.sessions ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Build session map keyed by date string YYYY-MM-DD
  const sessionMap = new Map<string, DaySession>(sessions.map(s => [s.date, s]));

  // Calendar grid
  const firstDay   = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr    = now.toISOString().split('T')[0];

  const monthLabel = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  // Weekly P&L summary
  const weeks: { label: string; pnl: number }[] = [];
  let weekStart = 1;
  while (weekStart <= daysInMonth) {
    const weekEnd = Math.min(weekStart + 6, daysInMonth);
    let weekPnl   = 0;
    for (let d = weekStart; d <= weekEnd; d++) {
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      weekPnl += sessionMap.get(key)?.pnl ?? 0;
    }
    weeks.push({ label: `Week ${weeks.length + 1}`, pnl: weekPnl });
    weekStart += 7;
  }

  // Monthly summary
  const monthSessions = sessions.filter(s => {
    const [y, m2] = s.date.split('-').map(Number);
    return y === year && m2 === month + 1;
  });
  const monthPnl    = monthSessions.reduce((s, d) => s + d.pnl, 0);
  const monthTrades = monthSessions.reduce((s, d) => s + d.trades, 0);
  const monthWins   = monthSessions.reduce((s, d) => s + d.wins, 0);
  const monthWinRate = monthTrades > 0 ? monthWins / monthTrades : 0;

  // Daily P&L chart data (all sessions in month)
  const dailyData = monthSessions
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => ({
      day:  parseInt(s.date.split('-')[2]),
      pnl:  s.pnl,
    }));

  // P&L by day of week
  const dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowMap: Record<number, number[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const s of sessions) {
    const dow = new Date(`${s.date}T12:00:00`).getDay();
    dowMap[dow].push(s.pnl);
  }
  const dowData = dowLabels.map((label, i) => ({
    label,
    pnl: dowMap[i].length ? dowMap[i].reduce((a, b) => a + b, 0) / dowMap[i].length : 0,
  })).filter((_, i) => i >= 1 && i <= 5); // Mon–Fri only

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 0', height: '100%', overflow: 'auto' }}>

      {/* Greeting */}
      <div>
        <p style={{ fontSize: 22, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>
          <span style={{ color: '#9ca3af' }}>{getGreeting()}, </span>
          <span style={{ color: '#00ff9f' }}>Maitrey</span>
        </p>
        <p style={{ fontSize: 12, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>
          {now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {loading ? (
        <p style={{ color: '#4b5563', fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>Loading journal...</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 20, alignItems: 'start' }}>

          {/* Left: calendar */}
          <div style={{
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 14, padding: 20, display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            {/* month nav */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
                <ChevronLeft size={16} />
              </button>
              <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', color: '#e0e0e0' }}>
                {monthLabel}
              </span>
              <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
                <ChevronRight size={16} />
              </button>
            </div>

            {/* DOW labels */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
              {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map(d => (
                <div key={d} style={{
                  textAlign: 'center', fontSize: 9, fontFamily: 'JetBrains Mono, monospace',
                  color: '#4b5563', paddingBottom: 4,
                }}>{d}</div>
              ))}

              {/* empty leading cells */}
              {Array.from({ length: firstDay }).map((_, i) => (
                <CalCell key={`e${i}`} day={null} isToday={false} isSelected={false} onClick={() => {}} />
              ))}

              {/* day cells */}
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
                const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const s   = sessionMap.get(key);
                return (
                  <CalCell
                    key={day}
                    day={day}
                    session={s}
                    isToday={key === todayStr}
                    isSelected={selected?.date === key}
                    onClick={() => setSelected(s ?? null)}
                  />
                );
              })}
            </div>

            {/* Monthly summary row */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10,
              borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 14,
            }}>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 9, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>MONTHLY P&L</p>
                <p style={{ fontSize: 16, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace',
                  color: monthPnl >= 0 ? '#00ff9f' : '#ff4d6d' }}>
                  {monthPnl >= 0 ? '+' : ''}${Math.abs(monthPnl).toFixed(0)}
                </p>
              </div>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 9, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>TOTAL TRADES</p>
                <p style={{ fontSize: 16, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: '#e0e0e0' }}>
                  {monthTrades}
                </p>
              </div>
              <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: 9, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace' }}>WIN RATE</p>
                <p style={{ fontSize: 16, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', color: '#00ff9f' }}>
                  {(monthWinRate * 100).toFixed(0)}%
                </p>
              </div>
            </div>
          </div>

          {/* Right: weekly summary */}
          <div style={{
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <p style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace', marginBottom: 4 }}>
              WEEKLY P&L
            </p>
            {weeks.map((w, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 8px', borderRadius: 6,
                background: 'rgba(255,255,255,0.02)',
              }}>
                <span style={{ fontSize: 10, color: '#6b7280', fontFamily: 'JetBrains Mono, monospace' }}>
                  {w.label}
                </span>
                <span style={{
                  fontSize: 12, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace',
                  color: w.pnl >= 0 ? '#00ff9f' : '#ff4d6d',
                }}>
                  {w.pnl >= 0 ? '+' : ''}${Math.abs(w.pnl).toFixed(0)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom charts */}
      {!loading && dailyData.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Daily P&L */}
          <div style={{
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 14, padding: 16,
          }}>
            <p style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace', marginBottom: 10 }}>
              DAILY P&L
            </p>
            <div style={{ height: 120 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyData} margin={{ top: 2, right: 2, left: 0, bottom: 0 }} barSize={14}>
                  <XAxis dataKey="day" tick={{ fill: '#4b5563', fontSize: 9, fontFamily: 'JetBrains Mono' }}
                         axisLine={false} tickLine={false} />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip
                    formatter={(v) => [fmtPnl(Number(v)), 'P&L']}
                    contentStyle={{ background: 'rgba(10,10,15,0.95)', border: '1px solid rgba(255,255,255,0.1)',
                                    fontFamily: 'JetBrains Mono', fontSize: 11 }}
                    itemStyle={{ color: '#e0e0e0' }}
                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  />
                  <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                    {dailyData.map((d, i) => (
                      <Cell key={i} fill={d.pnl >= 0 ? '#00ff9f' : '#ff4d6d'} fillOpacity={0.75} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* P&L by day of week */}
          <div style={{
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 14, padding: 16,
          }}>
            <p style={{ fontSize: 10, color: '#4b5563', fontFamily: 'JetBrains Mono, monospace', marginBottom: 10 }}>
              AVG P&L BY DAY OF WEEK
            </p>
            <div style={{ height: 120 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dowData} margin={{ top: 2, right: 2, left: 0, bottom: 0 }} barSize={22}>
                  <XAxis dataKey="label" tick={{ fill: '#4b5563', fontSize: 9, fontFamily: 'JetBrains Mono' }}
                         axisLine={false} tickLine={false} />
                  <YAxis hide domain={['auto', 'auto']} />
                  <Tooltip
                    formatter={(v) => [fmtPnl(Number(v)), 'Avg P&L']}
                    contentStyle={{ background: 'rgba(10,10,15,0.95)', border: '1px solid rgba(255,255,255,0.1)',
                                    fontFamily: 'JetBrains Mono', fontSize: 11 }}
                    itemStyle={{ color: '#e0e0e0' }}
                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                  />
                  <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                    {dowData.map((d, i) => (
                      <Cell key={i} fill={d.pnl >= 0 ? '#00ff9f' : '#ff4d6d'} fillOpacity={0.75} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Day detail modal */}
      {selected && <DayDetail session={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
