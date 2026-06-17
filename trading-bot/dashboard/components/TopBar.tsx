'use client';
import { useEffect, useState } from 'react';
import { BotState } from '@/lib/types';
import { Wifi, WifiOff, AlertTriangle, Clock, TrendingUp } from 'lucide-react';

interface TopBarProps {
  state:      BotState;
  marketOpen: boolean;
  phase:      string;
}

function AnimatedNumber({ value, prefix = '', suffix = '', decimals = 2 }: {
  value: number; prefix?: string; suffix?: string; decimals?: number;
}) {
  const [display, setDisplay] = useState(value);
  const [key, setKey] = useState(0);
  useEffect(() => { setDisplay(value); setKey(k => k + 1); }, [value]);
  return (
    <span key={key} className="num-flip inline-block">
      {prefix}{display.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}
    </span>
  );
}

function StatusBadge({ status }: { status: 'LIVE' | 'PAUSED' | 'ERROR' }) {
  const config = {
    LIVE:   { dot: 'pulse-green', color: '#00ff9f', bg: 'rgba(0,255,159,0.08)',  border: 'rgba(0,255,159,0.25)',  Icon: Wifi },
    PAUSED: { dot: 'pulse-amber', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', Icon: WifiOff },
    ERROR:  { dot: 'pulse-red',   color: '#ff4d6d', bg: 'rgba(255,77,109,0.08)', border: 'rgba(255,77,109,0.25)', Icon: AlertTriangle },
  }[status];

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg mono"
         style={{ background: config.bg, border: `1px solid ${config.border}` }}>
      <div className={`w-2 h-2 rounded-full ${config.dot}`} style={{ background: config.color }} />
      <span className="text-xs font-semibold tracking-widest" style={{ color: config.color }}>{status}</span>
    </div>
  );
}

function MarketBadge({ open, phase }: { open: boolean; phase: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg mono"
         style={{
           background: open ? 'rgba(0,207,255,0.06)' : 'rgba(255,255,255,0.03)',
           border:     open ? '1px solid rgba(0,207,255,0.2)' : '1px solid rgba(255,255,255,0.08)',
         }}>
      <TrendingUp size={11} style={{ color: open ? '#00cfff' : '#4b5563' }} />
      <span className="text-xs font-semibold" style={{ color: open ? '#00cfff' : '#4b5563' }}>
        {open ? 'MARKET OPEN' : 'MARKET CLOSED'}
      </span>
      {phase && (
        <span className="text-xs" style={{ color: '#6b7280' }}>· {phase}</span>
      )}
    </div>
  );
}

export default function TopBar({ state, marketOpen, phase }: TopBarProps) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const pnlPositive = state.dailyPnL >= 0;
  const pnlColor    = pnlPositive ? '#00ff9f' : '#ff4d6d';
  const pnlGlow     = pnlPositive ? 'glow-green' : 'glow-red';

  return (
    <header className="flex items-center justify-between px-6 py-3 glass border-b border-white/5 flex-shrink-0 flex-wrap gap-2">
      {/* Left: financial stats */}
      <div className="flex items-baseline gap-3 flex-wrap">
        {/* Portfolio */}
        <div>
          <p className="text-xs mono mb-0.5" style={{ color: '#4b5563' }}>PORTFOLIO VALUE</p>
          <p className="text-2xl font-bold mono glow-blue" style={{ color: '#00cfff' }}>
            $<AnimatedNumber value={state.portfolioValue} decimals={2} />
          </p>
        </div>

        <div className="w-px h-10 mx-2" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {/* Daily P&L */}
        <div>
          <p className="text-xs mono mb-0.5" style={{ color: '#4b5563' }}>DAILY P&L</p>
          <p className={`text-xl font-bold mono ${pnlGlow}`} style={{ color: pnlColor }}>
            {pnlPositive ? '+' : ''}<AnimatedNumber value={state.dailyPnL} prefix="$" decimals={2} />
            <span className="text-sm ml-1.5 font-normal" style={{ color: pnlColor, opacity: 0.8 }}>
              ({pnlPositive ? '+' : ''}{(state.dailyPnLPct * 100).toFixed(3)}%)
            </span>
          </p>
        </div>

        <div className="w-px h-10 mx-2" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {/* Cash / Buying Power */}
        <div>
          <p className="text-xs mono mb-0.5" style={{ color: '#4b5563' }}>BUYING POWER</p>
          <p className="text-xl font-bold mono" style={{ color: '#e0e0e0' }}>
            $<AnimatedNumber value={state.cash} decimals={2} />
          </p>
        </div>

        <div className="w-px h-10 mx-2" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {/* Positions */}
        <div>
          <p className="text-xs mono mb-0.5" style={{ color: '#4b5563' }}>POSITIONS</p>
          <p className="text-xl font-bold mono" style={{ color: '#e0e0e0' }}>
            {state.activePositions}
            <span className="text-xs ml-1 font-normal" style={{ color: '#4b5563' }}>active</span>
          </p>
        </div>
      </div>

      {/* Right */}
      <div className="flex items-center gap-3 flex-wrap">
        <MarketBadge open={marketOpen} phase={phase} />

        <div className="flex items-center gap-1.5 mono text-xs" style={{ color: '#4b5563' }}>
          <Clock size={12} />
          <span suppressHydrationWarning>
            {now ? now.toLocaleTimeString('en-US', { hour12: false }) : '--:--:--'}
          </span>
          <span className="ml-1" suppressHydrationWarning>
            {now ? now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '---'}
          </span>
        </div>

        <StatusBadge status={state.status} />
      </div>
    </header>
  );
}
