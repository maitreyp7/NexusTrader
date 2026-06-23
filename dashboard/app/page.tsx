'use client';
import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Activity, TrendingUp, RefreshCw, ShieldCheck, AlertTriangle, CircleDollarSign } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// HOME — Two-bot quant dashboard.
// Renders the live brain (ETFs+crypto, 70%) and mean-rev (stocks, 30%) bots from
// /api/quant, which reads the real Alpaca account. Auto-refreshes every 20s.
// ─────────────────────────────────────────────────────────────────────────────

type Position = { symbol: string; marketValue: number; unrealizedPnL: number; unrealizedPct: number };
type Bot = {
  name: string; marketValue: number; share: number; budgetCap: number;
  count: number; unrealizedPnL: number; positions: Position[];
};
type QuantData = {
  equity: number; cash: number; dayPnL: number; dayPnLPct: number; invested: number;
  bots: Bot[];
  other: { value: number; symbols: string[] };
  regime: { status: string; vix: number | null; vix3m: number | null };
  alerts: string[]; health: string; asOf: string;
};

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct   = (n: number) => `${(n * 100).toFixed(1)}%`;
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export default function Home() {
  const [data, setData] = useState<QuantData | null>(null);
  const [err, setErr]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/quant');
      if (!res.ok) { setErr(`API ${res.status}`); return; }
      const j = await res.json();
      if (j.error) { setErr(j.error); return; }
      setData(j); setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="h-full overflow-auto" style={{ background: '#0a0b0d', color: '#e5e7eb' }}>
      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Activity size={22} style={{ color: '#22d3ee' }} />
            <h1 className="text-lg font-semibold mono">NexusTrader — Quant System</h1>
          </div>
          <button onClick={load} className="flex items-center gap-2 text-xs mono px-3 py-1.5 rounded"
                  style={{ background: 'rgba(255,255,255,0.06)', color: '#9ca3af' }}>
            <RefreshCw size={13} /> refresh
          </button>
        </div>

        {loading && !data && <div className="text-sm mono" style={{ color: '#6b7280' }}>loading live account…</div>}
        {err && <Banner kind="error" text={`Error: ${err}`} />}

        {data && (
          <>
            {/* Health banner */}
            {data.health === 'HEALTHY'
              ? <Banner kind="ok"   text="All systems healthy — no failed orders, splits within budget." />
              : <Banner kind="warn" text={data.alerts.join('  •  ')} />}

            {/* Account summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <Stat label="Equity"       value={money(data.equity)} icon={<CircleDollarSign size={15} />} />
              <Stat label="Today"        value={`${signed(data.dayPnL)} (${data.dayPnLPct >= 0 ? '+' : ''}${(data.dayPnLPct * 100).toFixed(2)}%)`}
                    color={data.dayPnL >= 0 ? '#34d399' : '#f87171'} />
              <Stat label="Invested"     value={`${money(data.invested)} (${pct(data.invested / data.equity)})`} />
              <Stat label="Cash"         value={money(data.cash)} color="#9ca3af" />
            </div>

            {/* Regime */}
            <div className="mb-6 flex items-center gap-2 text-xs mono"
                 style={{ color: data.regime.status === 'RISK-ON' ? '#34d399' : data.regime.status === 'RISK-OFF' ? '#f59e0b' : '#6b7280' }}>
              {data.regime.status === 'RISK-ON' ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
              Regime: <span className="font-semibold">{data.regime.status}</span>
              {data.regime.vix !== null && <span style={{ color: '#6b7280' }}>VIX {data.regime.vix?.toFixed(1)} / VIX3M {data.regime.vix3m?.toFixed(1)}</span>}
            </div>

            {/* Two bots */}
            <div className="grid md:grid-cols-2 gap-5">
              {data.bots.map(b => <BotCard key={b.name} bot={b} />)}
            </div>

            {data.other.value > 0 && (
              <div className="mt-5">
                <Banner kind="warn" text={`Unowned positions (neither bot): ${data.other.symbols.join(', ')} = ${money(data.other.value)}`} />
              </div>
            )}

            <div className="mt-6 text-xs mono" style={{ color: '#4b5563' }}>
              as of {new Date(data.asOf).toLocaleString()} · auto-refreshes every 20s
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Banner({ kind, text }: { kind: 'ok' | 'warn' | 'error'; text: string }) {
  const c = kind === 'ok' ? '#34d399' : kind === 'warn' ? '#f59e0b' : '#f87171';
  return (
    <div className="mb-5 px-4 py-2.5 rounded text-xs mono flex items-center gap-2"
         style={{ background: `${c}12`, border: `1px solid ${c}30`, color: c }}>
      {kind === 'ok' ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />} {text}
    </div>
  );
}

function Stat({ label, value, color = '#e5e7eb', icon }: { label: string; value: string; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="px-4 py-3 rounded" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-1.5 text-xs mono mb-1" style={{ color: '#6b7280' }}>{icon} {label}</div>
      <div className="text-base font-semibold mono" style={{ color }}>{value}</div>
    </div>
  );
}

function BotCard({ bot }: { bot: Bot }) {
  const isBrain = bot.name === 'Brain';
  const accent  = isBrain ? '#22d3ee' : '#a78bfa';
  const sharePct = bot.share * 100;
  const capPct   = bot.budgetCap * 100;
  return (
    <div className="rounded-lg p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isBrain ? <TrendingUp size={16} style={{ color: accent }} /> : <RefreshCw size={16} style={{ color: accent }} />}
          <span className="font-semibold mono" style={{ color: accent }}>{bot.name}</span>
          <span className="text-xs mono" style={{ color: '#6b7280' }}>
            {isBrain ? 'ETF + crypto trend' : 'single-name mean-reversion'}
          </span>
        </div>
        <span className="text-xs mono" style={{ color: bot.unrealizedPnL >= 0 ? '#34d399' : '#f87171' }}>
          uPL {signed(bot.unrealizedPnL)}
        </span>
      </div>

      {/* allocation bar */}
      <div className="mb-1 flex justify-between text-xs mono" style={{ color: '#9ca3af' }}>
        <span>{money(bot.marketValue)} · {bot.count} positions</span>
        <span>{sharePct.toFixed(0)}% / {capPct.toFixed(0)}% cap</span>
      </div>
      <div className="w-full h-1.5 rounded-full mb-4" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-1.5 rounded-full transition-all duration-500"
             style={{ width: `${Math.min(sharePct / capPct * 100, 100)}%`, background: accent, boxShadow: `0 0 6px ${accent}60` }} />
      </div>

      {/* positions */}
      {bot.positions.length === 0
        ? <div className="text-xs mono" style={{ color: '#6b7280' }}>holding cash</div>
        : (
          <div className="space-y-1">
            {bot.positions.map(p => (
              <div key={p.symbol} className="flex items-center justify-between text-xs mono py-0.5">
                <span style={{ color: '#d1d5db' }}>{p.symbol}</span>
                <div className="flex items-center gap-3">
                  <span style={{ color: '#6b7280' }}>{money(p.marketValue)}</span>
                  <span style={{ color: p.unrealizedPnL >= 0 ? '#34d399' : '#f87171', width: 64, textAlign: 'right' }}>
                    {p.unrealizedPnL >= 0 ? '+' : ''}{p.unrealizedPct.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
