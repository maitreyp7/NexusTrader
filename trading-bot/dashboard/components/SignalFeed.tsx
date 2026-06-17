'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { TradeRecord } from '@/lib/types';
import { apiFetch } from '@/lib/apiFetch';
import { Zap, TrendingUp, TrendingDown, AlertTriangle, Info } from 'lucide-react';

interface SignalFeedProps {
  trades: TradeRecord[];
}

interface FeedEntry {
  id:        string;
  time:      string;
  type:      'BUY' | 'SELL' | 'INFO' | 'WARN' | 'BLOCK';
  symbol:    string;
  message:   string;
  score?:    number;
  confidence?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL FEED
//
// Live stream of trade signals from the bot. Sources:
//   1. Session log trades (actual entries and exits)
//   2. Bot stdout log (scraped for [Analysis] and [Execution] lines)
// ─────────────────────────────────────────────────────────────────────────────

function EntryIcon({ type }: { type: FeedEntry['type'] }) {
  if (type === 'BUY')  return <TrendingUp  size={13} style={{ color: '#00ff9f' }} />;
  if (type === 'SELL') return <TrendingDown size={13} style={{ color: '#ff4d6d' }} />;
  if (type === 'WARN') return <AlertTriangle size={13} style={{ color: '#f59e0b' }} />;
  return <Info size={13} style={{ color: '#4b5563' }} />;
}

function FeedRow({ entry }: { entry: FeedEntry }) {
  const colorMap: Record<string, string> = {
    BUY:   '#00ff9f',
    SELL:  '#ff4d6d',
    INFO:  '#6b7280',
    WARN:  '#f59e0b',
    BLOCK: '#4b5563',
  };
  const color = colorMap[entry.type] ?? '#6b7280';

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 rounded-lg hover-glow transition-all"
         style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
      <div className="flex-shrink-0 mt-0.5"><EntryIcon type={entry.type} /></div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          {entry.symbol && (
            <span className="text-xs font-bold mono" style={{ color }}>{entry.symbol}</span>
          )}
          <span className="text-xs mono font-semibold" style={{ color }}>{entry.type}</span>
          {entry.score !== undefined && (
            <span className="text-xs mono px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(0,207,255,0.08)', color: '#00cfff', border: '1px solid rgba(0,207,255,0.12)' }}>
              score {entry.score.toFixed(3)}
            </span>
          )}
          {entry.confidence !== undefined && (
            <span className="text-xs mono" style={{ color: '#4b5563' }}>
              conf {entry.confidence.toFixed(2)}
            </span>
          )}
        </div>
        <p className="text-xs mono" style={{ color: '#6b7280' }}>{entry.message}</p>
      </div>
      <span className="text-xs mono flex-shrink-0 mt-0.5" style={{ color: '#2d3748' }}>{entry.time}</span>
    </div>
  );
}

export default function SignalFeed({ trades }: SignalFeedProps) {
  const [entries,  setEntries]  = useState<FeedEntry[]>([]);
  const [logLines, setLogLines] = useState<FeedEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [filter,  setFilter]   = useState<'ALL' | 'BUY' | 'SELL' | 'WARN'>('ALL');

  // Convert trade records to feed entries
  useEffect(() => {
    const tradeEntries: FeedEntry[] = [];

    for (const t of trades) {
      const entryTime = new Date(t.enteredAt).toLocaleTimeString('en-US', { hour12: false });

      if (t.outcome === 'OPEN') {
        tradeEntries.push({
          id:         `${t.tradeId}_entry`,
          time:       entryTime,
          type:       'BUY',
          symbol:     t.symbol,
          message:    `Entered at $${t.entryPrice.toFixed(2)} · $${t.sizeUsd.toFixed(0)} deployed · ${t.pattern ?? 'ORB'}`,
          score:      t.decision.finalScore,
          confidence: t.decision.confidence,
        });
      } else {
        const exitTime = t.exitedAt
          ? new Date(t.exitedAt).toLocaleTimeString('en-US', { hour12: false })
          : entryTime;

        tradeEntries.push({
          id:         `${t.tradeId}_entry`,
          time:       entryTime,
          type:       'BUY',
          symbol:     t.symbol,
          message:    `Entered at $${t.entryPrice.toFixed(2)} · ${t.pattern ?? 'ORB'}`,
          score:      t.decision.finalScore,
          confidence: t.decision.confidence,
        });

        tradeEntries.push({
          id:      `${t.tradeId}_exit`,
          time:    exitTime,
          type:    'SELL',
          symbol:  t.symbol,
          message: `Closed at $${(t.exitPrice ?? 0).toFixed(2)} · ${t.outcome} · ${
            t.realizedPnL !== null ? `${t.realizedPnL >= 0 ? '+' : ''}$${t.realizedPnL.toFixed(2)}` : ''
          } · ${t.exitReason ?? ''}`,
        });
      }
    }

    // Sort by time
    tradeEntries.sort((a, b) => a.time.localeCompare(b.time));
    setEntries(tradeEntries);
  }, [trades]);

  // Fetch real log lines from the bot
  const fetchLogs = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/logs');
      const data = await res.json();
      if (!data.logs?.length) return;

      const relevant = (data.logs as { id: string; timestamp: string; level: string; message: string }[])
        .filter(l =>
          l.message.includes('[Analysis]') ||
          l.message.includes('[Execution]') ||
          l.message.includes('[ORB]') ||
          l.message.includes('[PreMarket]') ||
          l.message.includes('[Risk]') ||
          l.level === 'TRADE' ||
          l.level === 'WARN'
        )
        .slice(-50)
        .map(l => {
          const type: FeedEntry['type'] =
            l.level === 'TRADE' || l.message.includes('BUY')  ? 'BUY'  :
            l.message.includes('SELL') || l.message.includes('CLOSE') ? 'SELL' :
            l.level === 'WARN'                                         ? 'WARN' : 'INFO';

          // Extract symbol from message if present
          const symMatch = l.message.match(/\b(QQQ|SPY)\b/);
          return {
            id:      `log-${l.id}`,
            time:    l.timestamp,
            type,
            symbol:  symMatch?.[1] ?? '',
            message: l.message.replace(/^\[.+?\]\s*/, '').slice(0, 120),
          };
        });

      setLogLines(relevant as FeedEntry[]);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    const t = setInterval(fetchLogs, 8_000);
    return () => clearInterval(t);
  }, [fetchLogs]);

  // Merge and deduplicate
  const allEntries = [...entries, ...logLines]
    .filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i)
    .filter(e => filter === 'ALL' || e.type === filter)
    .slice(-100);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [allEntries.length]);

  const filterBtns: Array<{ key: typeof filter; label: string; color: string }> = [
    { key: 'ALL',  label: 'All',      color: '#e0e0e0' },
    { key: 'BUY',  label: 'Entries',  color: '#00ff9f' },
    { key: 'SELL', label: 'Exits',    color: '#ff4d6d' },
    { key: 'WARN', label: 'Warnings', color: '#f59e0b' },
  ];

  return (
    <div className="glass rounded-xl flex flex-col hover-glow" style={{ height: '100%' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
           style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-2">
          <Zap size={14} style={{ color: '#00cfff' }} />
          <h2 className="text-sm font-semibold mono tracking-wide" style={{ color: '#e0e0e0' }}>SIGNAL FEED</h2>
          <span className="text-xs mono px-1.5 py-0.5 rounded-full"
                style={{ background: 'rgba(0,207,255,0.08)', color: '#00cfff', border: '1px solid rgba(0,207,255,0.15)' }}>
            {allEntries.length}
          </span>
        </div>

        {/* Filter buttons */}
        <div className="flex gap-1">
          {filterBtns.map(b => (
            <button key={b.key} onClick={() => setFilter(b.key)}
                    className="text-xs mono px-2 py-1 rounded cursor-pointer transition-all"
                    style={{
                      background: filter === b.key ? `${b.color}15` : 'transparent',
                      border:     filter === b.key ? `1px solid ${b.color}30` : '1px solid rgba(255,255,255,0.06)',
                      color:      filter === b.key ? b.color : '#4b5563',
                    }}>
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2 min-h-0">
        {allEntries.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center" style={{ color: '#4b5563' }}>
            <Zap size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
            <p className="text-xs mono">No signals yet.</p>
            <p className="text-xs mono mt-1">Signals appear when the bot analyzes or trades.</p>
          </div>
        ) : (
          allEntries.map(e => <FeedRow key={e.id} entry={e} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
