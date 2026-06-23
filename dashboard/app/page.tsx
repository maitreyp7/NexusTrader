'use client';
import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Activity, TrendingUp, Repeat, RefreshCw, ShieldCheck, AlertTriangle, ArrowUpRight, ArrowDownRight } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// HOME — Premium two-bot quant dashboard.
// Live brain (ETFs+crypto, 70%) + mean-rev (stocks, 30%) from /api/quant.
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
  equityHistory: number[];
  regime: { status: string; vix: number | null; vix3m: number | null };
  alerts: string[]; health: string; asOf: string;
};

const money  = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const GREEN = '#00ff9f', RED = '#ff4d6d', BLUE = '#00cfff', PURPLE = '#b794ff', AMBER = '#f59e0b';

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
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id); }, [load]);

  const up = data ? data.dayPnL >= 0 : true;

  return (
    <div className="h-full overflow-auto grid-bg" style={{ background: '#080808' }}>
      <div className="max-w-7xl mx-auto px-8 py-7">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 fade-up">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg" style={{ background: 'rgba(0,207,255,0.1)', border: `1px solid ${BLUE}33` }}>
              <Activity size={18} style={{ color: BLUE }} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight" style={{ color: '#fff', fontFamily: 'Inter' }}>NexusTrader</h1>
              <div className="text-xs mono" style={{ color: '#5b6068' }}>Quant System · 2 bots</div>
            </div>
          </div>
          <button onClick={load} className="hover-glow flex items-center gap-2 text-xs mono px-3 py-2 rounded-lg"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#9ca3af' }}>
            <RefreshCw size={13} /> refresh
          </button>
        </div>

        {loading && !data && <div className="text-sm mono" style={{ color: '#5b6068' }}>loading live account…</div>}
        {err && <Banner kind="error" text={`Error: ${err}`} />}

        {data && (
          <>
            {/* Hero: equity + sparkline */}
            <div className="glass fade-up rounded-2xl p-6 mb-5" style={{ borderColor: up ? `${GREEN}1f` : `${RED}1f` }}>
              <div className="flex items-start justify-between flex-wrap gap-4">
                <div>
                  <div className="text-xs mono uppercase tracking-widest mb-2" style={{ color: '#5b6068' }}>Total Equity</div>
                  <div className="flex items-end gap-3">
                    <div className="text-5xl font-bold tracking-tight num-flip" style={{ color: '#fff', fontFamily: 'Inter' }}>
                      {money(data.equity)}
                    </div>
                    <div className="flex items-center gap-1 text-lg font-semibold mb-1" style={{ color: up ? GREEN : RED }}>
                      {up ? <ArrowUpRight size={20} /> : <ArrowDownRight size={20} />}
                      {signed(data.dayPnL)} ({(data.dayPnLPct * 100).toFixed(2)}%)
                    </div>
                  </div>
                  <div className="text-xs mono mt-1" style={{ color: '#5b6068' }}>today · since prev close</div>
                </div>
                <Sparkline values={data.equityHistory} color={up ? GREEN : RED} />
              </div>

              {/* sub-stats row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-6 pt-5" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <SubStat label="Invested"  value={money(data.invested)} sub={`${(data.invested / data.equity * 100).toFixed(0)}% deployed`} color="#fff" />
                <SubStat label="Cash"      value={money(data.cash)} sub={`${(data.cash / data.equity * 100).toFixed(0)}% reserve`} color="#9ca3af" />
                <SubStat label="Regime"    value={data.regime.status}
                         sub={data.regime.vix !== null ? `VIX ${data.regime.vix.toFixed(1)} / ${data.regime.vix3m?.toFixed(1)}` : '—'}
                         color={data.regime.status === 'RISK-ON' ? GREEN : data.regime.status === 'RISK-OFF' ? AMBER : '#9ca3af'} />
                <SubStat label="Health"    value={data.health === 'HEALTHY' ? 'Healthy' : 'Attention'}
                         sub={data.health === 'HEALTHY' ? 'no failed orders' : `${data.alerts.length} alert(s)`}
                         color={data.health === 'HEALTHY' ? GREEN : AMBER} />
              </div>
            </div>

            {data.health !== 'HEALTHY' && <Banner kind="warn" text={data.alerts.join('  •  ')} />}

            {/* Two bots */}
            <div className="grid md:grid-cols-2 gap-5">
              {data.bots.map((b, i) => <BotCard key={b.name} bot={b} delay={i * 0.05} />)}
            </div>

            {data.other.value > 0 && (
              <div className="mt-5"><Banner kind="warn" text={`Unowned positions (neither bot): ${data.other.symbols.join(', ')} = ${money(data.other.value)}`} /></div>
            )}

            <div className="mt-6 text-xs mono" style={{ color: '#3f444c' }}>
              as of {new Date(data.asOf).toLocaleString()} · auto-refreshes every 20s
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Sparkline (SVG, gradient-filled) ─────────────────────────────────────────
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values || values.length < 2) {
    return <div className="text-xs mono self-end" style={{ color: '#3f444c' }}>building equity history…</div>;
  }
  const W = 320, H = 80, pad = 4;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (W - pad * 2);
    const y = pad + (1 - (v - min) / range) * (H - pad * 2);
    return [x, y];
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
  return (
    <svg width={W} height={H} className="self-end" style={{ maxWidth: '50%' }}>
      <defs>
        <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark)" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" style={{ filter: `drop-shadow(0 0 4px ${color}88)` }} />
    </svg>
  );
}

function Banner({ kind, text }: { kind: 'ok' | 'warn' | 'error'; text: string }) {
  const c = kind === 'ok' ? GREEN : kind === 'warn' ? AMBER : RED;
  return (
    <div className="fade-up mb-5 px-4 py-3 rounded-xl text-xs mono flex items-center gap-2"
         style={{ background: `${c}10`, border: `1px solid ${c}30`, color: c }}>
      {kind === 'ok' ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />} {text}
    </div>
  );
}

function SubStat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div>
      <div className="text-xs mono uppercase tracking-wider mb-1" style={{ color: '#5b6068' }}>{label}</div>
      <div className="text-lg font-semibold" style={{ color, fontFamily: 'Inter' }}>{value}</div>
      <div className="text-xs mono mt-0.5" style={{ color: '#3f444c' }}>{sub}</div>
    </div>
  );
}

function BotCard({ bot, delay }: { bot: Bot; delay: number }) {
  const isBrain = bot.name === 'Brain';
  const accent  = isBrain ? BLUE : PURPLE;
  const sharePct = bot.share * 100, capPct = bot.budgetCap * 100;
  const fillPct = Math.min(sharePct / capPct * 100, 100);
  const upl = bot.unrealizedPnL >= 0;
  return (
    <div className="glass hover-glow rounded-2xl p-5 fade-up" style={{ animationDelay: `${delay}s`, borderColor: `${accent}1f` }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg" style={{ background: `${accent}14`, border: `1px solid ${accent}33` }}>
            {isBrain ? <TrendingUp size={15} style={{ color: accent }} /> : <Repeat size={15} style={{ color: accent }} />}
          </div>
          <div>
            <div className="font-bold text-sm" style={{ color: '#fff', fontFamily: 'Inter' }}>{bot.name}</div>
            <div className="text-xs mono" style={{ color: '#5b6068' }}>{isBrain ? 'ETF + crypto trend' : 'single-name mean-reversion'}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-bold" style={{ color: upl ? GREEN : RED, fontFamily: 'Inter' }}>{signed(bot.unrealizedPnL)}</div>
          <div className="text-xs mono" style={{ color: '#5b6068' }}>unrealized</div>
        </div>
      </div>

      {/* allocation */}
      <div className="mb-1.5 flex justify-between items-baseline">
        <span className="text-base font-semibold" style={{ color: '#e8e8e8', fontFamily: 'Inter' }}>{money(bot.marketValue)}</span>
        <span className="text-xs mono" style={{ color: '#7b818a' }}>{bot.count} positions · {sharePct.toFixed(0)}% / {capPct.toFixed(0)}% cap</span>
      </div>
      <div className="w-full h-2 rounded-full mb-4 overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
        <div className="h-2 rounded-full transition-all duration-700"
             style={{ width: `${fillPct}%`, background: `linear-gradient(90deg, ${accent}99, ${accent})`, boxShadow: `0 0 10px ${accent}99` }} />
      </div>

      {/* positions */}
      {bot.positions.length === 0
        ? <div className="text-xs mono py-2" style={{ color: '#5b6068' }}>holding cash</div>
        : (
          <div className="space-y-0.5">
            {bot.positions.map(p => {
              const pos = p.unrealizedPnL >= 0;
              return (
                <div key={p.symbol} className="flex items-center justify-between text-xs py-1 px-1 rounded hover:bg-white/5 transition-colors">
                  <span className="mono font-medium" style={{ color: '#d1d5db' }}>{p.symbol}</span>
                  <div className="flex items-center gap-4">
                    <span className="mono" style={{ color: '#6b7280', width: 70, textAlign: 'right' }}>{money(p.marketValue)}</span>
                    <span className="mono font-semibold" style={{ color: pos ? GREEN : RED, width: 56, textAlign: 'right' }}>
                      {pos ? '+' : ''}{p.unrealizedPct.toFixed(1)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
