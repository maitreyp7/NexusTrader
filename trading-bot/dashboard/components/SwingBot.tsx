'use client';
import { useEffect, useState, useCallback } from 'react';
import { TrendingUp, TrendingDown, RefreshCw, AlertTriangle, Clock, Activity } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface SwingPosition {
  ticker:        string;
  shares:        number;
  entry_price:   number;
  current_price?: number;
  stop_loss:     number;
  take_profit:   number;
  entered_at:    string;
  thesis_score:  number;
  verdict:       string;
  thesis?:       string;
  time_horizon?: string;
}

interface Portfolio {
  date:       string | null;
  positions:  SwingPosition[];
  generated_at?: string;
}

function pnlColor(pct: number) {
  if (pct > 0)  return '#00ff9f';
  if (pct < 0)  return '#ff4d6d';
  return '#6b7280';
}

function PositionRow({ p }: { p: SwingPosition }) {
  const current  = p.current_price ?? p.entry_price;
  const pnlPct   = ((current - p.entry_price) / p.entry_price) * 100;
  const pnlUsd   = (current - p.entry_price) * p.shares;
  const color    = pnlColor(pnlPct);

  // Progress bar toward take profit (green) or stop (red)
  const range    = p.take_profit - p.stop_loss;
  const progress = range > 0 ? Math.max(0, Math.min(1, (current - p.stop_loss) / range)) : 0.5;

  return (
    <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <TrendingUp size={12} style={{ color: '#00ff9f' }} />
          <span className="mono font-bold" style={{ fontSize: 13, color: '#e0e0e0' }}>{p.ticker}</span>
          <span className="mono" style={{ fontSize: 10, color: '#4b5563' }}>{p.shares} shares</span>
          {p.time_horizon && (
            <span className="mono" style={{
              fontSize: 10, padding: '1px 5px', borderRadius: 3,
              background: 'rgba(0,207,255,0.08)', border: '1px solid rgba(0,207,255,0.15)', color: '#00cfff',
            }}>{p.time_horizon}</span>
          )}
        </div>
        <span className="mono font-semibold" style={{ fontSize: 12, color }}>
          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}% (${pnlUsd >= 0 ? '+' : ''}{pnlUsd.toFixed(2)})
        </span>
      </div>

      {/* Price levels */}
      <div className="flex items-center justify-between mb-2">
        <span className="mono" style={{ fontSize: 10, color: '#ff4d6d' }}>Stop ${p.stop_loss.toFixed(2)}</span>
        <span className="mono" style={{ fontSize: 11, color: '#e0e0e0' }}>Now ${current.toFixed(2)}</span>
        <span className="mono" style={{ fontSize: 10, color: '#00ff9f' }}>Target ${p.take_profit.toFixed(2)}</span>
      </div>

      {/* Progress bar: stop → current → target */}
      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          width: `${progress * 100}%`, height: '100%', borderRadius: 2,
          background: `linear-gradient(90deg, #ff4d6d, #f59e0b, #00ff9f)`,
          transition: 'width 0.4s ease',
        }} />
      </div>

      {/* Entry info */}
      <div className="flex items-center justify-between mt-2">
        <span className="mono" style={{ fontSize: 10, color: '#4b5563' }}>
          Entry ${p.entry_price.toFixed(2)} · Score {p.thesis_score}
        </span>
        <span className="mono" style={{ fontSize: 10, color: '#2d3748' }}>
          {new Date(p.entered_at).toLocaleDateString()}
        </span>
      </div>

      {p.thesis && (
        <p className="mono mt-1" style={{ fontSize: 10, color: '#374151', lineHeight: 1.5 }}>
          {p.thesis.slice(0, 120)}...
        </p>
      )}
    </div>
  );
}

export default function SwingBot() {
  const [portfolio,  setPortfolio]  = useState<Portfolio | null>(null);
  const [logLines,   setLogLines]   = useState<string[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [lastFetch,  setLastFetch]  = useState<Date | null>(null);
  const [showLog,    setShowLog]    = useState(false);

  const fetch_ = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/swing-bot');
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setPortfolio(data.portfolio);
      setLogLines(data.logLines ?? []);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const t = setInterval(fetch_, 60_000);
    return () => clearInterval(t);
  }, [fetch_]);

  const positions    = portfolio?.positions ?? [];
  const isStale      = portfolio?.date ? portfolio.date !== new Date().toISOString().slice(0, 10) : false;
  const totalPnl     = positions.reduce((sum, p) => {
    const curr = p.current_price ?? p.entry_price;
    return sum + (curr - p.entry_price) * p.shares;
  }, 0);

  return (
    <div className="glass rounded-xl flex flex-col" style={{ height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
           style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Activity size={14} style={{ color: '#00ff9f' }} />
          <h2 className="mono" style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0', letterSpacing: '0.05em' }}>
            SWING BOT
          </h2>
          <span className="mono" style={{
            fontSize: 10, padding: '2px 7px', borderRadius: 10,
            background: 'rgba(0,255,159,0.08)', border: '1px solid rgba(0,255,159,0.2)', color: '#00ff9f',
          }}>
            {positions.length} positions
          </span>
          {isStale && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <AlertTriangle size={11} style={{ color: '#f59e0b' }} />
              <span className="mono" style={{ fontSize: 10, color: '#f59e0b' }}>stale</span>
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {positions.length > 0 && (
            <span className="mono" style={{ fontSize: 12, color: pnlColor(totalPnl), fontWeight: 600 }}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} total
            </span>
          )}
          {portfolio?.date && (
            <span className="mono" style={{ fontSize: 10, color: '#4b5563', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Clock size={10} />{portfolio.date}
            </span>
          )}
          <button onClick={() => setShowLog(l => !l)}
                  className="mono" style={{ fontSize: 10, color: '#4b5563', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            {showLog ? 'Hide log' : 'Log'}
          </button>
          <button onClick={fetch_}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#4b5563', display: 'flex' }}>
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="mono" style={{ fontSize: 12, color: '#4b5563' }}>Loading...</span>
          </div>
        )}

        {error && !loading && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={20} style={{ color: '#f59e0b', opacity: 0.5, marginBottom: 8 }} />
            <p className="mono" style={{ fontSize: 11, color: '#f59e0b' }}>{error}</p>
          </div>
        )}

        {!loading && !error && positions.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#4b5563' }}>
            <TrendingUp size={22} style={{ opacity: 0.2, marginBottom: 8 }} />
            <p className="mono" style={{ fontSize: 12 }}>No open swing positions.</p>
            <p className="mono" style={{ fontSize: 11, marginTop: 4 }}>
              Runs at 9:35 AM ET on weekdays.
            </p>
          </div>
        )}

        {!loading && !error && positions.map(p => (
          <PositionRow key={p.ticker} p={p} />
        ))}

        {/* Log viewer */}
        {showLog && logLines.length > 0 && (
          <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: 8 }}>
            <p className="mono" style={{ fontSize: 10, color: '#4b5563', marginBottom: 4 }}>RECENT LOG</p>
            {logLines.map((line, i) => (
              <p key={i} className="mono" style={{
                fontSize: 10, color: line.includes('ERROR') ? '#ff4d6d' : line.includes('WARNING') ? '#f59e0b' : '#374151',
                lineHeight: 1.6,
              }}>{line}</p>
            ))}
          </div>
        )}

        {lastFetch && (
          <p className="mono" style={{ fontSize: 10, color: '#1f2937', textAlign: 'center', marginTop: 4 }}>
            Last fetched {lastFetch.toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  );
}
