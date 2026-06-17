'use client';
import { SessionLog } from '@/lib/types';
import { ShieldAlert, ShieldCheck, AlertTriangle } from 'lucide-react';

interface RiskPanelProps {
  session: SessionLog | null;
}

function Meter({ label, value, max, color, unit = '' }: {
  label: string; value: number; max: number; color: string; unit?: string;
}) {
  const pct = Math.min((value / max) * 100, 100);
  const warn = pct > 75;
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs mono" style={{ color: '#6b7280' }}>{label}</span>
        <span className="text-xs mono font-semibold" style={{ color: warn ? '#f59e0b' : color }}>
          {value.toFixed(value < 10 ? 2 : 0)}{unit}
          <span className="font-normal ml-1" style={{ color: '#4b5563' }}>/ {max}{unit}</span>
        </span>
      </div>
      <div className="w-full h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div
          className="h-1 rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            background: warn ? '#f59e0b' : color,
            boxShadow: `0 0 6px ${warn ? '#f59e0b' : color}60`,
          }}
        />
      </div>
    </div>
  );
}

function StatusRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs mono">
      <span style={{ color: '#6b7280' }}>{label}</span>
      <span style={{ color: good ? '#00ff9f' : '#ff4d6d' }}>{value}</span>
    </div>
  );
}

export default function RiskPanel({ session }: RiskPanelProps) {
  const trades   = session?.trades ?? [];
  const open     = trades.filter(t => t.outcome === 'OPEN').length;
  const closed   = trades.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');
  const total    = trades.length;
  const wins     = closed.filter(t => t.outcome === 'WIN').length;
  const winRate  = closed.length > 0 ? (wins / closed.length) * 100 : 0;
  const dailyPnL = session?.dailyPnL ?? 0;
  const capital  = session?.dailySpentUsd ?? 0;
  const consLoss = session?.consecutiveLosses ?? 0;
  const circuitBreaker = session?.circuitBreakered ?? false;

  // Risk config (mirrors src/config.ts RISK section)
  const MAX_DAILY_LOSS   = 500;    // $500 hard stop
  const MAX_TRADES_DAY   = 2;
  const MAX_CONSEC_LOSS  = 3;

  const dailyLossSoFar = Math.max(0, -dailyPnL);
  const tradesUsed     = total;

  const allGood = !circuitBreaker && dailyLossSoFar < MAX_DAILY_LOSS * 0.5 && consLoss < MAX_CONSEC_LOSS;

  return (
    <div className="glass rounded-xl p-4 flex flex-col gap-4 hover-glow h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-semibold mono tracking-wide" style={{ color: '#e0e0e0' }}>RISK CONTROLS</h2>
        <div className="flex items-center gap-1.5">
          {circuitBreaker ? (
            <ShieldAlert size={14} style={{ color: '#ff4d6d' }} />
          ) : allGood ? (
            <ShieldCheck size={14} style={{ color: '#00ff9f' }} />
          ) : (
            <AlertTriangle size={14} style={{ color: '#f59e0b' }} />
          )}
          <span className="text-xs mono" style={{ color: circuitBreaker ? '#ff4d6d' : allGood ? '#00ff9f' : '#f59e0b' }}>
            {circuitBreaker ? 'BREAKER TRIPPED' : allGood ? 'ALL CLEAR' : 'WATCH'}
          </span>
        </div>
      </div>

      {/* Circuit breaker warning */}
      {circuitBreaker && (
        <div className="rounded-lg p-2.5 flex-shrink-0"
             style={{ background: 'rgba(255,77,109,0.08)', border: '1px solid rgba(255,77,109,0.25)' }}>
          <p className="text-xs mono" style={{ color: '#ff4d6d' }}>
            Circuit breaker active — trading halted for today
          </p>
        </div>
      )}

      {/* Meters */}
      <div className="flex flex-col gap-3 flex-shrink-0">
        <p className="text-xs mono" style={{ color: '#4b5563' }}>DAILY LIMITS</p>
        <Meter label="Daily Loss Used"  value={dailyLossSoFar} max={MAX_DAILY_LOSS} color="#ff4d6d" unit="$" />
        <Meter label="Trades Today"     value={tradesUsed}     max={MAX_TRADES_DAY}  color="#00cfff" />
        <Meter label="Consecutive Loss" value={consLoss}       max={MAX_CONSEC_LOSS} color="#f59e0b" />
      </div>

      {/* Status rows */}
      <div className="flex flex-col gap-2 flex-shrink-0"
           style={{ background: 'rgba(0,207,255,0.03)', borderRadius: 8, padding: 10, border: '1px solid rgba(0,207,255,0.08)' }}>
        <p className="text-xs mono mb-1" style={{ color: '#4b5563' }}>SESSION SUMMARY</p>
        <StatusRow label="Win rate"          value={`${winRate.toFixed(1)}%`}      good={winRate >= 50} />
        <StatusRow label="Capital deployed"  value={`$${capital.toFixed(0)}`}      good={capital < 5000} />
        <StatusRow label="Open positions"    value={`${open}`}                     good={open <= 1} />
        <StatusRow label="Daily P&L"         value={`${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)}`} good={dailyPnL >= 0} />
      </div>

      {/* Strategy config (read-only, from config.ts) */}
      <div className="flex flex-col gap-1.5 flex-shrink-0">
        <p className="text-xs mono" style={{ color: '#4b5563' }}>STRATEGY CONFIG</p>
        {[
          ['Risk per trade', '1.0%'],
          ['Stop at midpoint', 'ORB midpoint'],
          ['Target', '1.5× range'],
          ['VIX kill switch', '> 30'],
          ['Max trades/day', '2'],
          ['Trading days', 'Tue / Wed / Thu'],
          ['Session window', '9:30 – 10:30 AM ET'],
        ].map(([label, val]) => (
          <div key={label} className="flex items-center justify-between text-xs mono">
            <span style={{ color: '#6b7280' }}>{label}</span>
            <span style={{ color: '#e0e0e0' }}>{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
