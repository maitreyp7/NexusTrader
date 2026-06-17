'use client';
import { useState, useEffect } from 'react';
import { TradeRecord, SessionLog } from '@/lib/types';
import { apiFetch } from '@/lib/apiFetch';
import { TrendingUp, TrendingDown, Clock, ChevronDown, CheckCircle, XCircle, AlertCircle, RefreshCw } from 'lucide-react';

interface ActiveTradesProps {
  trades:     TradeRecord[];   // live open positions from Alpaca
  session?:   SessionLog | null;
  allTrades?: TradeRecord[];   // full session history (trades page)
}

// ─── Signal score bar ────────────────────────────────────────────────────────
function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 0.58 ? '#00ff9f' : value >= 0.45 ? '#00cfff' : '#ff4d6d';
  return (
    <div className="text-center">
      <div className="text-xs mono mb-1" style={{ color: '#4b5563' }}>{label}</div>
      <div className="relative h-1 rounded-full mb-1" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
             style={{ width: `${value * 100}%`, background: color }} />
      </div>
      <div className="text-xs mono" style={{ color: '#6b7280' }}>{value.toFixed(2)}</div>
    </div>
  );
}

// ─── Live open position row ───────────────────────────────────────────────────
function LiveRow({ trade }: { trade: TradeRecord }) {
  const [expanded, setExpanded] = useState(false);

  const currentPrice = trade._currentPrice ?? trade.entryPrice;
  // pnlUsd from Alpaca already accounts for short direction (negative = losing)
  const pnlUsd = trade._unrealizedPnL ?? (currentPrice - trade.entryPrice) * trade.coinsTraded;
  const pnlPct = trade._unrealizedPnLPct != null
    ? trade._unrealizedPnLPct * 100
    : ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

  // Always color based on actual P&L — for shorts, price up = losing, price down = winning
  const isWinning = pnlUsd >= 0;
  const color     = isWinning ? '#00ff9f' : '#ff4d6d';
  // pnlPct from Alpaca for shorts is already sign-corrected (positive = winning)
  // but raw price % is not — use pnlUsd sign for all directional display
  const displayPct = pnlUsd >= 0 ? Math.abs(pnlPct) : -Math.abs(pnlPct);

  const isShort   = trade.coinsTraded < 0 || Math.abs(trade.sizeUsd) !== trade.sizeUsd;
  const sizeAbs   = Math.abs(trade.sizeUsd);

  const elapsed = Date.now() - new Date(trade.enteredAt).getTime();
  const minutes = Math.floor(elapsed / 60000);
  const timeStr = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

  const scores = trade.decision.scores;

  return (
    <div
      className="rounded-lg cursor-pointer overflow-hidden transition-all duration-200"
      style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${isWinning ? 'rgba(0,255,159,0.15)' : 'rgba(255,77,109,0.15)'}` }}
      onClick={() => setExpanded(e => !e)}
    >
      <div className="flex items-center justify-between px-3 py-2.5" style={{ gap: 8, minWidth: 0 }}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Symbol icon */}
          <div className="flex items-center justify-center rounded-lg flex-shrink-0"
               style={{ width: 36, height: 36, background: isWinning ? 'rgba(0,255,159,0.08)' : 'rgba(255,77,109,0.08)', border: `1px solid ${color}30` }}>
            <span style={{ fontSize: 9, fontWeight: 700, fontFamily: 'monospace', color }}>{trade.symbol.replace('/USD', '')}</span>
          </div>

          <div style={{ minWidth: 0 }}>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-semibold mono" style={{ color: '#e0e0e0' }}>{trade.symbol}</span>
              <span className="text-xs px-1.5 py-0.5 rounded mono flex-shrink-0"
                    style={{ background: 'rgba(0,207,255,0.08)', color: '#00cfff', border: '1px solid rgba(0,207,255,0.15)' }}>
                LIVE
              </span>
              {isShort && (
                <span className="text-xs px-1.5 py-0.5 rounded mono flex-shrink-0"
                      style={{ background: 'rgba(255,77,109,0.08)', color: '#ff4d6d', border: '1px solid rgba(255,77,109,0.2)' }}>
                  SHORT
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <Clock size={10} style={{ color: '#4b5563', flexShrink: 0 }} />
              <span className="text-xs mono" style={{ color: '#4b5563', whiteSpace: 'nowrap' }}>{timeStr}</span>
              <span className="text-xs mono" style={{ color: '#4b5563', whiteSpace: 'nowrap' }}>${sizeAbs.toFixed(0)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="text-right">
            <div className="text-xs mono" style={{ color: '#4b5563', whiteSpace: 'nowrap' }}>
              ${trade.entryPrice.toFixed(2)} → <span style={{ color: '#e0e0e0' }}>${currentPrice.toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-end gap-1 mt-0.5">
              {isWinning ? <TrendingUp size={11} style={{ color }} /> : <TrendingDown size={11} style={{ color }} />}
              <span className="text-sm font-bold mono" style={{ color, whiteSpace: 'nowrap' }}>{displayPct >= 0 ? '+' : ''}{displayPct.toFixed(2)}%</span>
            </div>
            <div className="text-xs mono text-right" style={{ color: `${color}99`, whiteSpace: 'nowrap' }}>{pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)} P&L</div>
          </div>
          <ChevronDown size={14} style={{ color: '#4b5563', flexShrink: 0, transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
          {/* Stop → current → target progress bar */}
          {trade._stopPrice && trade._targetPrice && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span className="mono" style={{ fontSize: 10, color: '#ff4d6d' }}>Stop ${trade._stopPrice.toFixed(2)}</span>
                <span className="mono" style={{ fontSize: 10, color: '#e0e0e0' }}>Now ${currentPrice.toFixed(2)}</span>
                <span className="mono" style={{ fontSize: 10, color: '#00ff9f' }}>Target ${trade._targetPrice.toFixed(2)}</span>
              </div>
              {(() => {
                const range    = trade._targetPrice! - trade._stopPrice!;
                const progress = range > 0 ? Math.max(0, Math.min(1, (currentPrice - trade._stopPrice!) / range)) : 0.5;
                return (
                  <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{
                      width: `${progress * 100}%`, height: '100%', borderRadius: 3,
                      background: 'linear-gradient(90deg, #ff4d6d, #f59e0b, #00ff9f)',
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                );
              })()}
            </div>
          )}
          {/* Only show ORB signal scores for day trades — swing positions don't have these */}
          {trade.botType === "dayTrade" && (
            <>
              <div className="grid grid-cols-5 gap-2 mb-2">
                <ScoreBar label="ORB"   value={scores.technical  ?? 0} />
                <ScoreBar label="TECH"  value={scores.technical  ?? 0} />
                <ScoreBar label="MACRO" value={scores.macro       ?? 0} />
                <ScoreBar label="SENT"  value={scores.sentiment   ?? 0} />
                <ScoreBar label="INST"  value={scores.whale       ?? 0} />
              </div>
              <div className="flex items-center gap-3 text-xs mono" style={{ color: '#4b5563' }}>
                <span>Score: <span style={{ color: '#00cfff' }}>{trade.decision.finalScore.toFixed(3)}</span></span>
                <span>Threshold: <span style={{ color: '#6b7280' }}>{trade.decision.threshold.toFixed(3)}</span></span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Closed trade card (recap) ────────────────────────────────────────────────
function RecapRow({ trade, isRecap = false }: { trade: TradeRecord; isRecap?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  const win   = trade.outcome === 'WIN';
  const loss  = trade.outcome === 'LOSS';
  const color = win ? '#00ff9f' : loss ? '#ff4d6d' : '#6b7280';

  const pnlPct = trade.realizedPnLPct != null ? trade.realizedPnLPct * 100 : null;
  const pnlUsd = trade.realizedPnL;

  const duration = trade.durationMs != null
    ? trade.durationMs < 3600000
      ? `${Math.floor(trade.durationMs / 60000)}m`
      : `${Math.floor(trade.durationMs / 3600000)}h ${Math.floor((trade.durationMs % 3600000) / 60000)}m`
    : null;

  const enteredTime = new Date(trade.enteredAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const exitedTime  = trade.exitedAt
    ? new Date(trade.exitedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    : null;

  const scores = trade.decision?.scores;

  return (
    <div
      className="rounded-lg overflow-hidden transition-all duration-200"
      style={{
        background: win ? 'rgba(0,255,159,0.03)' : loss ? 'rgba(255,77,109,0.03)' : 'rgba(255,255,255,0.01)',
        border: `1px solid ${win ? 'rgba(0,255,159,0.12)' : loss ? 'rgba(255,77,109,0.12)' : 'rgba(255,255,255,0.04)'}`,
        cursor: scores ? 'pointer' : 'default',
      }}
      onClick={() => scores && setExpanded(e => !e)}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-3">
          {/* Outcome icon */}
          <div className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0"
               style={{ background: win ? 'rgba(0,255,159,0.1)' : loss ? 'rgba(255,77,109,0.1)' : 'rgba(255,255,255,0.04)' }}>
            {win  ? <CheckCircle size={14} style={{ color: '#00ff9f' }} /> :
             loss ? <XCircle     size={14} style={{ color: '#ff4d6d' }} /> :
                    <AlertCircle size={14} style={{ color: '#6b7280' }} />}
          </div>

          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold mono" style={{ color: '#e0e0e0' }}>
                {trade.symbol.replace('/USD', '')}
              </span>
              {trade.pattern && (
                <span className="text-xs px-1.5 py-0.5 rounded mono"
                      style={{ background: 'rgba(255,255,255,0.04)', color: '#6b7280', border: '1px solid rgba(255,255,255,0.06)' }}>
                  {trade.pattern}
                </span>
              )}
              {isRecap && (
                <span className="text-xs px-1.5 py-0.5 rounded mono"
                      style={{ background: 'rgba(245,158,11,0.08)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.15)' }}>
                  LAST SESSION
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-xs mono" style={{ color: '#4b5563' }}>
              <span>{enteredTime}{exitedTime ? ` → ${exitedTime}` : ''}</span>
              {duration && <span>· {duration}</span>}
              {trade.exitReason && <span>· {trade.exitReason}</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right text-xs mono" style={{ color: '#6b7280' }}>
            <div>${trade.entryPrice.toFixed(2)}{trade.exitPrice ? ` → $${trade.exitPrice.toFixed(2)}` : ''}</div>
          </div>
          <div className="text-right min-w-[72px]">
            {pnlPct != null ? (
              <>
                <div className="text-sm font-bold mono" style={{ color }}>
                  {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                </div>
                {pnlUsd != null && (
                  <div className="text-xs mono" style={{ color: `${color}99` }}>
                    {pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(2)}
                  </div>
                )}
              </>
            ) : (
              <span className="text-xs mono" style={{ color: '#4b5563' }}>—</span>
            )}
          </div>
          {scores && (
            <ChevronDown size={14} style={{ color: '#4b5563', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
          )}
        </div>
      </div>

      {expanded && scores && (
        <div className="px-3 pb-3 pt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
          <div className="grid grid-cols-5 gap-2 mb-2">
            <ScoreBar label="TECH"  value={scores.technical  ?? 0} />
            <ScoreBar label="MICRO" value={scores.microstructure ?? 0} />
            <ScoreBar label="MACRO" value={scores.macro      ?? 0} />
            <ScoreBar label="SENT"  value={scores.sentiment  ?? 0} />
            <ScoreBar label="INST"  value={scores.whale      ?? 0} />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs mono" style={{ color: '#4b5563' }}>
            <span>Score: <span style={{ color: '#00cfff' }}>{trade.decision.finalScore.toFixed(3)}</span></span>
            <span>Threshold: <span style={{ color: '#6b7280' }}>{trade.decision.threshold.toFixed(3)}</span></span>
            <span>Confidence: <span style={{ color: '#6b7280' }}>{trade.decision.confidence.toFixed(3)}</span></span>
            {trade.decision.pattern && (
              <span>Pattern: <span style={{ color: '#f59e0b' }}>{trade.decision.pattern}</span></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────
function SectionLabel({ text }: { text: string }) {
  return (
    <p className="text-xs mono pt-1 pb-0.5" style={{ color: '#4b5563', letterSpacing: '0.08em' }}>{text}</p>
  );
}

// ─── Section divider ─────────────────────────────────────────────────────────
function SectionHeader({ label, count, pnl }: { label: string; count: number; pnl?: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '4px 0 4px', borderBottom: '1px solid rgba(255,255,255,0.05)',
      marginBottom: 2,
    }}>
      <span className="mono" style={{ fontSize: 10, color: '#4b5563', letterSpacing: '0.1em' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {pnl !== undefined && (
          <span className="mono" style={{ fontSize: 10, color: pnl >= 0 ? '#00ff9f' : '#ff4d6d', fontWeight: 600 }}>
            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
          </span>
        )}
        <span className="mono" style={{
          fontSize: 9, padding: '1px 6px', borderRadius: 10,
          background: 'rgba(255,255,255,0.04)', color: '#6b7280',
        }}>{count}</span>
      </div>
    </div>
  );
}

// ─── Alpaca order row (from /api/orders) ─────────────────────────────────────
interface AlpacaOrder {
  id: string; symbol: string; side: string; qty: number;
  entryPrice: number; exitPrice: number | null;
  enteredAt: string; exitedAt: string | null;
  pnl: number | null; pnlPct: number | null;
  status: 'open' | 'closed';
}

function AlpacaOrderRow({ order }: { order: AlpacaOrder }) {
  const win   = (order.pnl ?? 0) > 0;
  const loss  = (order.pnl ?? 0) < 0;
  const color = win ? '#00ff9f' : loss ? '#ff4d6d' : '#6b7280';

  const entryTime = new Date(order.enteredAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const exitTime  = order.exitedAt
    ? new Date(order.exitedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    : null;

  const durationMs = order.exitedAt
    ? new Date(order.exitedAt).getTime() - new Date(order.enteredAt).getTime()
    : null;
  const duration = durationMs
    ? durationMs < 3600000 ? `${Math.floor(durationMs / 60000)}m` : `${Math.floor(durationMs / 3600000)}h ${Math.floor((durationMs % 3600000) / 60000)}m`
    : null;

  return (
    <div style={{
      borderRadius: 8, padding: '10px 12px',
      background: win ? 'rgba(0,255,159,0.03)' : loss ? 'rgba(255,77,109,0.03)' : 'rgba(255,255,255,0.01)',
      border: `1px solid ${win ? 'rgba(0,255,159,0.12)' : loss ? 'rgba(255,77,109,0.12)' : 'rgba(255,255,255,0.04)'}`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: win ? 'rgba(0,255,159,0.1)' : loss ? 'rgba(255,77,109,0.1)' : 'rgba(255,255,255,0.04)',
        }}>
          {order.status === 'closed'
            ? (win ? <CheckCircle size={13} style={{ color: '#00ff9f' }} /> : <XCircle size={13} style={{ color: '#ff4d6d' }} />)
            : <Clock size={13} style={{ color: '#00cfff' }} />}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: '#e0e0e0' }}>{order.symbol}</span>
            <span className="mono" style={{
              fontSize: 9, padding: '1px 4px', borderRadius: 3, flexShrink: 0,
              background: order.side === 'short' ? 'rgba(255,77,109,0.08)' : 'rgba(0,207,255,0.08)',
              border: order.side === 'short' ? '1px solid rgba(255,77,109,0.2)' : '1px solid rgba(0,207,255,0.2)',
              color: order.side === 'short' ? '#ff4d6d' : '#00cfff',
            }}>{order.side.toUpperCase()}</span>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 1, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 10, color: '#4b5563', whiteSpace: 'nowrap' }}>
              {entryTime}{exitTime ? ` → ${exitTime}` : ''}
            </span>
            {duration && <span className="mono" style={{ fontSize: 10, color: '#4b5563', whiteSpace: 'nowrap' }}>· {duration}</span>}
            <span className="mono" style={{ fontSize: 10, color: '#4b5563', whiteSpace: 'nowrap' }}>· {order.qty} shares</span>
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div className="mono" style={{ fontSize: 10, color: '#6b7280', whiteSpace: 'nowrap' }}>
          ${order.entryPrice.toFixed(2)}{order.exitPrice ? ` → $${order.exitPrice.toFixed(2)}` : ''}
        </div>
        {order.pnl !== null && (
          <div className="mono" style={{ fontSize: 12, fontWeight: 700, color, whiteSpace: 'nowrap' }}>
            {order.pnl >= 0 ? '+' : ''}${order.pnl.toFixed(2)}
            <span style={{ fontSize: 10, fontWeight: 400, marginLeft: 3 }}>
              ({order.pnlPct !== null ? `${(order.pnlPct * 100).toFixed(2)}%` : ''})
            </span>
          </div>
        )}
        {order.status === 'open' && (
          <div className="mono" style={{ fontSize: 10, color: '#00cfff' }}>open</div>
        )}
      </div>
    </div>
  );
}

// ─── Column panel ─────────────────────────────────────────────────────────────
function BotColumn({ title, color, positions, alpacaOrders, emptyMsg }: {
  title: string;
  color: string;
  positions: TradeRecord[];
  alpacaOrders: AlpacaOrder[];
  emptyMsg: string;
}) {
  const unrealizedPnL  = positions.reduce((s, t) => s + (t._unrealizedPnL ?? 0), 0);
  const closedOrders   = alpacaOrders.filter(o => o.status === 'closed');
  const realizedPnL    = closedOrders.reduce((s, o) => s + (o.pnl ?? 0), 0);
  const wins           = closedOrders.filter(o => (o.pnl ?? 0) > 0).length;
  const losses         = closedOrders.filter(o => (o.pnl ?? 0) < 0).length;

  return (
    <div className="glass rounded-xl flex flex-col h-full" style={{ overflow: 'hidden' }}>
      {/* Column header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 3, height: 14, borderRadius: 2, background: color }} />
          <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0', letterSpacing: '0.05em' }}>{title}</span>
          {positions.length > 0 && (
            <span className="mono" style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 10,
              background: `${color}12`, border: `1px solid ${color}30`, color,
            }}>{positions.length} open</span>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          {positions.length > 0 && (
            <span className="mono" style={{ fontSize: 11, color: unrealizedPnL >= 0 ? '#00ff9f' : '#ff4d6d', fontWeight: 600 }}>
              {unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(2)} unrealized
            </span>
          )}
          {closedOrders.length > 0 && (
            <span className="mono" style={{ fontSize: 10, color: realizedPnL >= 0 ? '#00ff9f' : '#ff4d6d' }}>
              {realizedPnL >= 0 ? '+' : ''}${realizedPnL.toFixed(2)} realized · {wins}W {losses}L
            </span>
          )}
        </div>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Open positions */}
        {positions.length > 0 && positions.map(t => <LiveRow key={t.tradeId} trade={t} />)}

        {/* Closed trades from Alpaca */}
        {closedOrders.length > 0 && (
          <>
            {positions.length > 0 && (
              <p className="mono" style={{ fontSize: 10, color: '#4b5563', letterSpacing: '0.08em', paddingTop: 4 }}>CLOSED TODAY</p>
            )}
            {closedOrders.map(o => <AlpacaOrderRow key={o.id} order={o} />)}
          </>
        )}

        {/* Empty */}
        {positions.length === 0 && alpacaOrders.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#4b5563', padding: '40px 0' }}>
            <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>◎</div>
            <p className="mono" style={{ fontSize: 12 }}>{emptyMsg}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function ActiveTrades({ trades, session, allTrades }: ActiveTradesProps) {
  const [orders,      setOrders]      = useState<AlpacaOrder[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchOrders = async () => {
    try {
      const res  = await apiFetch('/api/orders');
      const data = await res.json();
      if (!data.error) { setOrders(data.trades ?? []); setLastRefresh(new Date()); }
    } catch { /* keep last */ }
  };

  useEffect(() => {
    fetchOrders();
    const t = setInterval(fetchOrders, 30_000);
    return () => clearInterval(t);
  }, []);

  const liveOpen          = trades.filter(t => t.outcome === 'OPEN' || t.outcome == null);
  const swingPositions    = liveOpen.filter(t => t.botType === "swing");
  const dayTradePositions = liveOpen.filter(t => t.botType === "dayTrade");

  // ORB bot's watchlist symbols — anything else in orders is swing
  const ORB_SYMBOLS = new Set(['QQQ','IWM','NVDA','GOOGL','TSLA','META','AAPL','SPY']);
  const orbOrders   = orders.filter(o => ORB_SYMBOLS.has(o.symbol));
  const swingOrders = orders.filter(o => !ORB_SYMBOLS.has(o.symbol));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Refresh row */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {lastRefresh && (
          <span className="mono" style={{ fontSize: 10, color: '#374151' }}>
            Alpaca orders · {lastRefresh.toLocaleTimeString()}
          </span>
        )}
        <button onClick={fetchOrders} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#4b5563', display: 'flex' }}>
          <RefreshCw size={12} />
        </button>
      </div>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, minHeight: 0 }}>
        <BotColumn
          title="ORB DAY TRADER"
          color="#00cfff"
          positions={dayTradePositions}
          alpacaOrders={orbOrders}
          emptyMsg="No day trades today"
        />
        <BotColumn
          title="SWING BOT"
          color="#00ff9f"
          positions={swingPositions}
          alpacaOrders={swingOrders}
          emptyMsg="No swing positions open"
        />
      </div>
    </div>
  );
}
