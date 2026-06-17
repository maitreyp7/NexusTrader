'use client';
import { useState, useEffect, useCallback } from 'react';
import Sidebar       from '@/components/Sidebar';
import TopBar        from '@/components/TopBar';
import PriceChart    from '@/components/PriceChart';
import ActiveTrades  from '@/components/ActiveTrades';
import RiskPanel     from '@/components/RiskPanel';
import TerminalLog   from '@/components/TerminalLog';
import JournalPanel  from '@/components/JournalPanel';
import MarketLens   from '@/components/MarketLens';
import { BotState, TradeRecord, SessionLog, PatternStats } from '@/lib/types';
import { apiFetch } from '@/lib/apiFetch';

// ─────────────────────────────────────────────────────────────────────────────
// HOME — Main dashboard page
// All state lives here. Each panel receives only the slice it needs.
// Data is fetched from real API routes that read bot logs and Alpaca.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STATE: BotState = {
  status:           'PAUSED',
  portfolioValue:   0,
  cash:             0,
  activePositions:  0,
  dailyPnL:         0,
  dailyPnLPct:      0,
  orbPnL:           0,
  orbWinRate:       0,
  orbTotalTrades:   0,
  swingPnL:         0,
  swingWinRate:     0,
  swingTotalTrades: 0,
  swingUnrealized:  0,
  sessionStart:     new Date().toISOString(),
  lastCycle:        new Date().toISOString(),
  nextCycle:        new Date().toISOString(),
  sharpeRatio:      0,
  totalTrades:      0,
  winRate:          0,
};

function isMarketOpen(): boolean {
  const now = new Date();
  // Rough ET offset (UTC-4 summer, UTC-5 winter)
  const etOffset = 4;
  const etHour   = now.getUTCHours() - etOffset;
  const etMin    = now.getUTCMinutes();
  const etDay    = now.getUTCDay(); // 0 = Sun, 6 = Sat
  if (etDay === 0 || etDay === 6) return false;
  const minutes = etHour * 60 + etMin;
  return minutes >= 570 && minutes < 960; // 9:30 AM to 4:00 PM ET
}

function getPhaseLabel(): string {
  const now = new Date();
  const etOffset = 4;
  const etHour   = now.getUTCHours() - etOffset;
  const etMin    = now.getUTCMinutes();
  const day      = now.getUTCDay();
  if (day === 0 || day === 6) return 'Weekend';
  if (day === 0 || day === 6) return 'Weekend';

  const m = etHour * 60 + etMin;
  if (m < 540) return 'Pre-session';                       // before 9:00
  if (m < 570) return 'Pre-market filter';                 // 9:00–9:29
  if (m < 585) return 'Building opening range';            // 9:30–9:44
  if (m < 615) return 'Trading window';                    // 9:45–10:14
  if (m < 630) return 'Managing positions';                // 10:15–10:29
  if (m < 960) return 'Session closed';                    // after 10:30
  return 'After hours';
}

export default function Home() {
  const [page, setPage]         = useState('dashboard');
  const [state, setState]       = useState<BotState>(DEFAULT_STATE);
  const [positions, setPositions] = useState<TradeRecord[]>([]);
  const [session, setSession]   = useState<SessionLog | null>(null);
  const [patternStats, setPatternStats]   = useState<PatternStats[]>([]);
  const [performance, setPerformance]     = useState<{ date: string; pnl: number; winRate: number }[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate]   = useState<string>('');
  const [marketOpen, setMarketOpen]       = useState(false);
  const [phase, setPhase]                 = useState('');

  // Update market status every minute
  useEffect(() => {
    const tick = () => {
      setMarketOpen(isMarketOpen());
      setPhase(getPhaseLabel());
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  // Fetch Alpaca account data
  const fetchAccount = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/account');
      const data = await res.json();
      if (data.error) return;

      setState(s => ({
        ...s,
        portfolioValue:   data.portfolioValue,
        cash:             data.cash,
        dailyPnL:         data.dailyPnL,
        dailyPnLPct:      data.dailyPnLPct,
        activePositions:  data.activePositions,
        status:           data.status,
        orbPnL:           data.orbPnL           ?? s.orbPnL,
        orbWinRate:       data.orbWinRate        ?? s.orbWinRate,
        orbTotalTrades:   data.orbTotalTrades    ?? s.orbTotalTrades,
        swingPnL:         data.swingPnL          ?? s.swingPnL,
        swingWinRate:     data.swingWinRate       ?? s.swingWinRate,
        swingTotalTrades: data.swingTotalTrades   ?? s.swingTotalTrades,
        swingUnrealized:  data.swingUnrealized    ?? s.swingUnrealized,
      }));

      // Convert Alpaca positions to TradeRecord shape
      if (Array.isArray(data.positions) && data.positions.length > 0) {
        const records: TradeRecord[] = data.positions.map((p: {
          symbol: string; qty: number; entryPrice: number; currentPrice: number;
          marketValue: number; unrealizedPnL: number; unrealizedPnLPct: number; side: string;
          botType?: 'swing' | 'dayTrade';
        }) => ({
          tradeId:        `${p.symbol}_live`,
          symbol:         p.symbol,
          entryPrice:     p.entryPrice,
          exitPrice:      null,
          sizeUsd:        p.marketValue,
          coinsTraded:    p.qty,
          realizedPnL:    null,
          realizedPnLPct: null,
          outcome:        'OPEN' as const,
          exitReason:     null,
          pattern:        'ORB',
          decision: {
            action: 'BUY', finalScore: 0, threshold: 0.55, confidence: 0,
            scores: { technical: 0, microstructure: 0, sentiment: 0, whale: 0, macro: 0 },
            pattern: 'ORB',
          },
          enteredAt:         new Date().toISOString(),
          exitedAt:          null,
          durationMs:        null,
          _currentPrice:     p.currentPrice,
          _unrealizedPnL:    p.unrealizedPnL,
          _unrealizedPnLPct: p.unrealizedPnLPct,
          botType:           p.botType ?? 'swing',
        }));
        setPositions(records);
      } else {
        setPositions([]);
      }
    } catch {
      // keep last state on network error
    }
  }, []);

  // Fetch session log data
  const fetchSession = useCallback(async (date?: string) => {
    try {
      const url  = date ? `/api/session?date=${encodeURIComponent(date)}` : '/api/session';
      const res  = await apiFetch(url);
      const data = await res.json();
      if (data.availableDates) setAvailableDates(data.availableDates);
      if (data.error) return;

      if (data.session) {
        setSession(data.session);
        // Never populate positions from session log — Alpaca is the source of truth.
        // Session log OPEN trades may be stale (bot restarted without closing them).
        // Alpaca positions are always fetched directly and set by fetchAccount().

        setState(s => ({
          ...s,
          totalTrades: (data.session.trades ?? []).length,
          winRate: (() => {
            const closed = (data.session.trades ?? []).filter(
              (t: TradeRecord) => t.outcome === 'WIN' || t.outcome === 'LOSS'
            );
            if (closed.length === 0) return s.winRate;
            return closed.filter((t: TradeRecord) => t.outcome === 'WIN').length / closed.length;
          })(),
        }));
      }

      if (data.patternStats) setPatternStats(data.patternStats);
      if (data.performance)  setPerformance(data.performance);
    } catch {
      // keep last state
    }
  }, []);

  // Poll every 10s for account, every 30s for session
  useEffect(() => {
    fetchAccount();
    fetchSession();
    const t1 = setInterval(fetchAccount, 10_000);
    const t2 = setInterval(fetchSession, 30_000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [fetchAccount, fetchSession]);

  const closedTrades = (session?.trades ?? []).filter(
    t => t.outcome === 'WIN' || t.outcome === 'LOSS'
  );

  return (
    <div
      className="flex w-full grid-bg"
      style={{ background: '#05060a', height: '100dvh', overflow: 'hidden', position: 'relative' }}
    >
      {/* Sidebar */}
      <div style={{ flexShrink: 0, zIndex: 40, position: 'relative', pointerEvents: 'auto' }}>
        <Sidebar active={page} onChange={setPage} />
      </div>

      {/* Main column */}
      <div className="flex flex-col flex-1 min-w-0" style={{ height: '100dvh', overflow: 'hidden', zIndex: 1, minHeight: 0 }}>
        <TopBar state={state} marketOpen={marketOpen} phase={phase} />

        {/* ── DASHBOARD ── */}
        {page === 'dashboard' && (
          <div
            className="flex-1 p-3 flex flex-col gap-3"
            style={{ minHeight: 0, overflow: 'auto' }}
          >
            <div style={{ height: 340, flexShrink: 0 }}><PriceChart /></div>
            <div style={{ flex: '1 1 auto' }}><RiskPanel state={state} /></div>
          </div>
        )}

        {/* ── LIVE TRADES ── */}
        {page === 'trades' && (
          <div className="flex-1 overflow-auto p-3 flex flex-col gap-3">
            {/* History browser */}
            {availableDates.length > 1 && (
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-xs mono" style={{ color: '#4b5563' }}>HISTORY:</span>
                <select
                  value={selectedDate}
                  onChange={e => {
                    const d = e.target.value;
                    setSelectedDate(d);
                    fetchSession(d || undefined);
                  }}
                  style={{
                    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 6, padding: '4px 10px', color: '#e0e0e0',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 12, cursor: 'pointer',
                  }}
                >
                  <option value="">Today (live)</option>
                  {availableDates.map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
                {selectedDate && (
                  <button
                    onClick={() => { setSelectedDate(''); fetchSession(); }}
                    style={{
                      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
                      padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                      background: 'rgba(255,255,255,0.05)', color: '#6b7280',
                    }}
                  >
                    Back to live
                  </button>
                )}
              </div>
            )}
            <ActiveTrades trades={positions} session={session} allTrades={session?.trades ?? []} />
          </div>
        )}

        {/* ── JOURNAL ── */}
        {page === 'journal' && (
          <div className="flex-1 overflow-auto p-4">
            <JournalPanel />
          </div>
        )}

        {/* ── MARKET LENS ── */}
        {page === 'market-lens' && (
          <div className="flex-1 p-3 min-h-0" style={{ overflow: 'hidden' }}>
            <MarketLens />
          </div>
        )}

        {/* ── TERMINAL ── */}
        {page === 'terminal' && (
          <div className="flex-1 p-3 min-h-0" style={{ overflow: 'hidden' }}>
            <TerminalLog fullHeight />
          </div>
        )}
      </div>
    </div>
  );
}
