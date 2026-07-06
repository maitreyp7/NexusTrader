'use client';
import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import {
  Activity as ActivityIcon, TrendingUp, Repeat, ShieldCheck, AlertTriangle,
  ArrowUpRight, ArrowDownRight, LayoutDashboard, ListOrdered, GraduationCap, Info,
} from 'lucide-react';

// ═════════════════════════════════════════════════════════════════════════════
//  NexusTrader Quant Dashboard — multi-view SPA (Overview / Brain / Mean-rev /
//  Activity / Learn). All data is LIVE from Alpaca via /api/quant + /api/activity.
// ═════════════════════════════════════════════════════════════════════════════

type Position = { symbol: string; marketValue: number; unrealizedPnL: number; unrealizedPct: number };
type Bot = { name: string; marketValue: number; share: number; budgetCap: number; count: number; unrealizedPnL: number; positions: Position[] };
type QuantData = {
  equity: number; cash: number; dayPnL: number; dayPnLPct: number; invested: number;
  bots: Bot[]; other: { value: number; symbols: string[] }; equityHistory: number[];
  regime: { status: string; vix: number | null; vix3m: number | null };
  alerts: string[]; health: string; asOf: string;
};
type ActivityItem = { id: string; symbol: string; bot: string; side: string; qty: number; price: number | null; value: number | null; at: string };

const money  = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const GREEN = '#00ff9f', RED = '#ff4d6d', BLUE = '#00cfff', PURPLE = '#b794ff', AMBER = '#f59e0b', DIM = '#5b6068';

type View = 'overview' | 'Brain' | 'Mean-rev' | 'activity' | 'learn';

export default function Home() {
  const [data, setData]       = useState<QuantData | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [view, setView]       = useState<View>('overview');
  const [err, setErr]         = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [qr, ar] = await Promise.all([apiFetch('/api/quant'), apiFetch('/api/activity')]);
      if (qr.ok) { const j = await qr.json(); if (!j.error) { setData(j); setErr(null); } else setErr(j.error); }
      else setErr(`API ${qr.status}`);
      if (ar.ok) { const a = await ar.json(); if (!a.error) setActivity(a.activity ?? []); }
    } catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 20000); return () => clearInterval(id); }, [load]);

  return (
    <div className="flex h-full" style={{ background: '#080808' }}>
      <Sidebar view={view} setView={setView} health={data?.health} />
      <main className="flex-1 overflow-auto grid-bg">
        <div className="max-w-6xl mx-auto px-8 py-8">
          {loading && !data && <div className="text-sm mono" style={{ color: DIM }}>loading live account…</div>}
          {err && <Banner kind="error" text={`Error: ${err}`} />}
          {data && (
            <>
              {view === 'overview'  && <Overview data={data} go={setView} />}
              {view === 'Brain'     && <BotDetail bot={data.bots[0]} activity={activity} />}
              {view === 'Mean-rev'  && <BotDetail bot={data.bots[1]} activity={activity} />}
              {view === 'activity'  && <ActivityView activity={activity} />}
              {view === 'learn'     && <Learn />}
              <div className="mt-8 text-xs mono" style={{ color: '#3f444c' }}>
                live from Alpaca · as of {new Date(data.asOf).toLocaleTimeString()} · auto-refreshes every 20s
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// ── Sidebar nav ──────────────────────────────────────────────────────────────
function Sidebar({ view, setView, health }: { view: View; setView: (v: View) => void; health?: string }) {
  const items: { id: View; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview',  icon: <LayoutDashboard size={17} /> },
    { id: 'Brain',    label: 'Brain bot', icon: <TrendingUp size={17} /> },
    { id: 'Mean-rev', label: 'Mean-rev',  icon: <Repeat size={17} /> },
    { id: 'activity', label: 'Activity',  icon: <ListOrdered size={17} /> },
    { id: 'learn',    label: 'Learn',     icon: <GraduationCap size={17} /> },
  ];
  return (
    <aside className="flex flex-col w-56 shrink-0 px-3 py-6" style={{ background: '#0b0b0d', borderRight: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center gap-2.5 px-3 mb-8">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg" style={{ background: 'rgba(0,207,255,0.1)', border: `1px solid ${BLUE}33` }}>
          <ActivityIcon size={18} style={{ color: BLUE }} />
        </div>
        <div>
          <div className="text-sm font-bold text-white" style={{ fontFamily: 'Inter' }}>NexusTrader</div>
          <div className="text-xs mono" style={{ color: DIM }}>quant system</div>
        </div>
      </div>
      <nav className="flex flex-col gap-1">
        {items.map(it => {
          const active = view === it.id;
          return (
            <button key={it.id} onClick={() => setView(it.id)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all"
              style={{
                background: active ? 'rgba(0,207,255,0.1)' : 'transparent',
                border: `1px solid ${active ? BLUE + '33' : 'transparent'}`,
                color: active ? BLUE : '#9ca3af', fontFamily: 'Inter', fontWeight: active ? 600 : 400,
              }}>
              {it.icon} {it.label}
            </button>
          );
        })}
      </nav>
      <div className="mt-auto px-3">
        <div className="flex items-center gap-2 text-xs mono" style={{ color: health === 'HEALTHY' ? GREEN : AMBER }}>
          {health === 'HEALTHY' ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
          {health === 'HEALTHY' ? 'all systems healthy' : 'needs attention'}
        </div>
      </div>
    </aside>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────
function Overview({ data, go }: { data: QuantData; go: (v: View) => void }) {
  const up = data.dayPnL >= 0;
  return (
    <>
      <h2 className="text-2xl font-bold text-white mb-1" style={{ fontFamily: 'Inter' }}>Overview</h2>
      <p className="text-sm mb-6" style={{ color: DIM }}>Your trading bots, live. Brain follows trends in ETFs &amp; crypto; Mean-rev buys oversold stocks for a quick bounce; Low-vol holds the calmest defensive names.</p>

      {/* Hero */}
      <div className="glass rounded-2xl p-7 mb-5" style={{ borderColor: up ? `${GREEN}1f` : `${RED}1f` }}>
        <div className="flex items-start justify-between flex-wrap gap-6">
          <div>
            <Label tip="Total value of the account right now (positions + cash).">Total Equity</Label>
            <div className="flex items-end gap-3 mt-2">
              <div className="text-5xl font-bold tracking-tight text-white" style={{ fontFamily: 'Inter' }}>{money(data.equity)}</div>
              <div className="flex items-center gap-1 text-lg font-semibold mb-1" style={{ color: up ? GREEN : RED }}>
                {up ? <ArrowUpRight size={20} /> : <ArrowDownRight size={20} />}
                {signed(data.dayPnL)} ({(data.dayPnLPct * 100).toFixed(2)}%)
              </div>
            </div>
            <div className="text-xs mono mt-1" style={{ color: DIM }}>change since yesterday&apos;s close</div>
          </div>
          <Sparkline values={data.equityHistory} color={up ? GREEN : RED} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mt-7 pt-6" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <SubStat label="Invested" tip="How much is currently in positions (the rest is cash)." value={money(data.invested)} sub={`${(data.invested / data.equity * 100).toFixed(0)}% of account`} color="#fff" />
          <SubStat label="Cash" tip="Uninvested money. The bots keep a cash buffer on purpose — it's a safety cushion, not a mistake." value={money(data.cash)} sub={`${(data.cash / data.equity * 100).toFixed(0)}% reserve`} color="#9ca3af" />
          <SubStat label="Market Regime" tip="Calm market (RISK-ON) = bots trade normally. Stressed market (RISK-OFF) = the Brain goes to cash. Read from the VIX volatility index." value={data.regime.status} sub={data.regime.vix !== null ? `VIX ${data.regime.vix.toFixed(1)} vs ${data.regime.vix3m?.toFixed(1)}` : '—'} color={data.regime.status === 'RISK-ON' ? GREEN : AMBER} />
          <SubStat label="System Health" tip="Green = no failed orders and both bots within their budget. Flags problems automatically." value={data.health === 'HEALTHY' ? 'Healthy' : 'Attention'} sub={data.health === 'HEALTHY' ? 'no failed orders' : `${data.alerts.length} alert(s)`} color={data.health === 'HEALTHY' ? GREEN : AMBER} />
        </div>
      </div>

      {data.health !== 'HEALTHY' && <Banner kind="warn" text={data.alerts.join('  •  ')} />}

      <div className="grid md:grid-cols-2 gap-5">
        {data.bots.map(b => <BotSummaryCard key={b.name} bot={b} onClick={() => go(b.name as View)} />)}
      </div>
    </>
  );
}

// ── Bot summary card (clickable → detail) ────────────────────────────────────
function BotSummaryCard({ bot, onClick }: { bot: Bot; onClick: () => void }) {
  const isBrain = bot.name === 'Brain';
  const isLowvol = bot.name === 'Low-vol';
  const accent = isBrain ? BLUE : isLowvol ? GREEN : PURPLE;
  const desc = isBrain ? 'ETF + crypto trend' : isLowvol ? 'low-volatility defensive' : 'oversold-stock bounce';
  const sharePct = bot.share * 100, capPct = bot.budgetCap * 100;
  const upl = bot.unrealizedPnL >= 0;
  return (
    <button onClick={onClick} className="glass hover-glow rounded-2xl p-5 text-left transition-all" style={{ borderColor: `${accent}1f` }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg" style={{ background: `${accent}14`, border: `1px solid ${accent}33` }}>
            {isBrain ? <TrendingUp size={16} style={{ color: accent }} /> : <Repeat size={16} style={{ color: accent }} />}
          </div>
          <div>
            <div className="font-bold text-white" style={{ fontFamily: 'Inter' }}>{bot.name}</div>
            <div className="text-xs mono" style={{ color: DIM }}>{desc}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="font-bold" style={{ color: upl ? GREEN : RED, fontFamily: 'Inter' }}>{signed(bot.unrealizedPnL)}</div>
          <div className="text-xs mono" style={{ color: DIM }}>unrealized P&amp;L</div>
        </div>
      </div>
      <div className="flex justify-between items-baseline mb-1.5">
        <span className="text-lg font-semibold text-white" style={{ fontFamily: 'Inter' }}>{money(bot.marketValue)}</span>
        <span className="text-xs mono" style={{ color: '#7b818a' }}>{bot.count} positions · {sharePct.toFixed(0)}% / {capPct.toFixed(0)}% cap</span>
      </div>
      <Bar pct={Math.min(sharePct / capPct * 100, 100)} accent={accent} />
      <div className="text-xs mono mt-3" style={{ color: accent }}>view positions →</div>
    </button>
  );
}

// ── Bot detail page ──────────────────────────────────────────────────────────
function BotDetail({ bot, activity }: { bot: Bot; activity: ActivityItem[] }) {
  const isBrain = bot.name === 'Brain';
  const accent = isBrain ? BLUE : PURPLE;
  const mine = activity.filter(a => a.bot === bot.name).slice(0, 15);
  return (
    <>
      <div className="flex items-center gap-3 mb-1">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg" style={{ background: `${accent}14`, border: `1px solid ${accent}33` }}>
          {isBrain ? <TrendingUp size={20} style={{ color: accent }} /> : <Repeat size={20} style={{ color: accent }} />}
        </div>
        <h2 className="text-2xl font-bold text-white" style={{ fontFamily: 'Inter' }}>{bot.name} bot</h2>
      </div>
      <p className="text-sm mb-6" style={{ color: DIM }}>
        {isBrain
          ? 'Owns ETFs and crypto that are trending up (above their long-term average), sized by how calm each is. Goes to cash in stressed markets. Manages up to 70% of the account.'
          : 'Each day it buys large-cap stocks that are in a long-term uptrend but just got sharply oversold, betting on a bounce. Holds 2–10 days, then sells. Manages up to 30% of the account.'}
      </p>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <MiniStat label="Allocation"  value={`${(bot.share * 100).toFixed(0)}%`} sub={`of ${(bot.budgetCap * 100).toFixed(0)}% cap`} accent={accent} />
        <MiniStat label="Market value" value={money(bot.marketValue)} sub={`${bot.count} positions`} accent={accent} />
        <MiniStat label="Unrealized P&L" value={signed(bot.unrealizedPnL)} sub="open positions" accent={bot.unrealizedPnL >= 0 ? GREEN : RED} />
      </div>

      <SectionTitle>Current positions</SectionTitle>
      <div className="glass rounded-xl p-4 mb-6">
        {bot.positions.length === 0 ? <div className="text-sm mono py-2" style={{ color: DIM }}>holding cash — no positions right now</div>
          : (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs mono pb-2 mb-1" style={{ color: DIM, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <span>Symbol</span><div className="flex gap-8"><span className="w-20 text-right">Value</span><span className="w-16 text-right">P&amp;L %</span></div>
              </div>
              {bot.positions.map(p => {
                const pos = p.unrealizedPnL >= 0;
                return (
                  <div key={p.symbol} className="flex items-center justify-between text-sm py-1.5">
                    <span className="mono font-medium text-white">{p.symbol}</span>
                    <div className="flex gap-8 items-center">
                      <span className="mono w-20 text-right" style={{ color: '#9ca3af' }}>{money(p.marketValue)}</span>
                      <span className="mono font-semibold w-16 text-right" style={{ color: pos ? GREEN : RED }}>{pos ? '+' : ''}{p.unrealizedPct.toFixed(1)}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
      </div>

      <SectionTitle>Recent activity</SectionTitle>
      <div className="glass rounded-xl p-4">
        {mine.length === 0 ? <div className="text-sm mono py-2" style={{ color: DIM }}>no recent orders</div>
          : <div className="space-y-1">{mine.map(a => <ActivityRow key={a.id} a={a} />)}</div>}
      </div>
    </>
  );
}

// ── Activity view ────────────────────────────────────────────────────────────
function ActivityView({ activity }: { activity: ActivityItem[] }) {
  const [filter, setFilter] = useState<'all' | 'Brain' | 'Mean-rev'>('all');
  const shown = activity.filter(a => filter === 'all' || a.bot === filter).slice(0, 60);
  return (
    <>
      <h2 className="text-2xl font-bold text-white mb-1" style={{ fontFamily: 'Inter' }}>Activity</h2>
      <p className="text-sm mb-5" style={{ color: DIM }}>Every order both bots have placed recently (newest first).</p>
      <div className="flex gap-2 mb-5">
        {(['all', 'Brain', 'Mean-rev'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} className="px-3 py-1.5 rounded-lg text-xs mono transition-all"
            style={{ background: filter === f ? 'rgba(0,207,255,0.1)' : 'rgba(255,255,255,0.04)', border: `1px solid ${filter === f ? BLUE + '33' : 'rgba(255,255,255,0.08)'}`, color: filter === f ? BLUE : '#9ca3af' }}>
            {f === 'all' ? 'All bots' : f}
          </button>
        ))}
      </div>
      <div className="glass rounded-xl p-4">
        {shown.length === 0 ? <div className="text-sm mono py-2" style={{ color: DIM }}>no orders yet</div>
          : <div className="space-y-1">{shown.map(a => <ActivityRow key={a.id} a={a} showBot />)}</div>}
      </div>
    </>
  );
}

function ActivityRow({ a, showBot }: { a: ActivityItem; showBot?: boolean }) {
  const buy = a.side === 'buy';
  const accent = a.bot === 'Brain' ? BLUE : PURPLE;
  return (
    <div className="flex items-center justify-between text-sm py-1.5">
      <div className="flex items-center gap-3">
        <span className="mono text-xs px-1.5 py-0.5 rounded font-semibold" style={{ background: buy ? `${GREEN}18` : `${RED}18`, color: buy ? GREEN : RED }}>{buy ? 'BUY' : 'SELL'}</span>
        <span className="mono font-medium text-white">{a.symbol}</span>
        {showBot && <span className="text-xs mono px-1.5 py-0.5 rounded" style={{ background: `${accent}14`, color: accent }}>{a.bot}</span>}
      </div>
      <div className="flex items-center gap-5">
        <span className="mono text-xs" style={{ color: '#9ca3af' }}>{a.value !== null ? money2(a.value) : '—'}</span>
        <span className="mono text-xs w-24 text-right" style={{ color: DIM }}>{new Date(a.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} {new Date(a.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
      </div>
    </div>
  );
}

// ── Learn ────────────────────────────────────────────────────────────────────
function Learn() {
  const items = [
    { q: 'What is the Brain bot?', a: 'It owns ETFs (like SPY, QQQ, gold, bonds) and crypto that are trending UP — specifically above their long-term average. It sizes calm assets bigger and jumpy ones smaller. When the market gets stressed, it sells everything and sits in cash. It manages up to 70% of the account.' },
    { q: 'What is the Mean-rev bot?', a: 'It scans 147 large-cap stocks daily for ones in a healthy uptrend that just got sharply OVERSOLD (a rare 2-day selloff), and buys them betting on a quick bounce. It holds each 2–10 days then sells. It manages up to 30% of the account.' },
    { q: 'What does RISK-ON / RISK-OFF mean?', a: 'It reads the VIX (the market’s "fear gauge"). RISK-ON = calm market, bots invest normally. RISK-OFF = the VIX signals stress, so the Brain goes to cash to protect the account. This single switch cut the historical worst-case loss roughly in half.' },
    { q: 'Why is so much in cash?', a: 'The bots size positions by RISK, not by spending every dollar. A big cash buffer is intentional — it’s the safety cushion that keeps drawdowns shallow. It’s a feature, not idle money.' },
    { q: 'What does "70% / 30% cap" mean?', a: 'The account is split: the Brain can use up to 70%, Mean-rev up to 30%. They never trade the same symbols, so they can’t fight. Each bot sizes against its own slice.' },
    { q: 'What is "unrealized P&L"?', a: 'The paper profit/loss on positions you still hold. It becomes "realized" only when the bot sells. Green = up, red = down.' },
    { q: 'Do the bots use stop-losses?', a: 'No fixed stop-loss. The Brain exits when an asset falls below its trend line; Mean-rev exits on a bounce or after 10 days max. The real risk control is position SIZING — no single name can hurt much.' },
    { q: 'Is this real money?', a: 'No — this is a paper (simulated) Alpaca account. It’s proving the system works before any real money goes in.' },
  ];
  return (
    <>
      <h2 className="text-2xl font-bold text-white mb-1" style={{ fontFamily: 'Inter' }}>Learn</h2>
      <p className="text-sm mb-6" style={{ color: DIM }}>Plain-English answers to what everything on this dashboard means.</p>
      <div className="space-y-3">
        {items.map((it, i) => (
          <div key={i} className="glass rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2"><Info size={15} style={{ color: BLUE }} /><span className="font-semibold text-white" style={{ fontFamily: 'Inter' }}>{it.q}</span></div>
            <p className="text-sm leading-relaxed" style={{ color: '#b4bac2' }}>{it.a}</p>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────
function Bar({ pct, accent }: { pct: number; accent: string }) {
  return (
    <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
      <div className="h-2 rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${accent}99, ${accent})`, boxShadow: `0 0 10px ${accent}99` }} />
    </div>
  );
}
function Label({ children, tip }: { children: React.ReactNode; tip?: string }) {
  return <div className="flex items-center gap-1 text-xs mono uppercase tracking-widest" style={{ color: DIM }} title={tip}>{children}{tip && <Info size={11} style={{ opacity: 0.5 }} />}</div>;
}
function SubStat({ label, value, sub, color, tip }: { label: string; value: string; sub: string; color: string; tip?: string }) {
  return (
    <div>
      <Label tip={tip}>{label}</Label>
      <div className="text-xl font-semibold mt-1" style={{ color, fontFamily: 'Inter' }}>{value}</div>
      <div className="text-xs mono mt-0.5" style={{ color: '#3f444c' }}>{sub}</div>
    </div>
  );
}
function MiniStat({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div className="glass rounded-xl p-4">
      <div className="text-xs mono uppercase tracking-wider mb-1" style={{ color: DIM }}>{label}</div>
      <div className="text-2xl font-bold" style={{ color: accent, fontFamily: 'Inter' }}>{value}</div>
      <div className="text-xs mono mt-0.5" style={{ color: '#3f444c' }}>{sub}</div>
    </div>
  );
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-sm font-semibold mb-2 mt-1" style={{ color: '#d1d5db', fontFamily: 'Inter' }}>{children}</div>;
}
function Banner({ kind, text }: { kind: 'ok' | 'warn' | 'error'; text: string }) {
  const c = kind === 'ok' ? GREEN : kind === 'warn' ? AMBER : RED;
  return (
    <div className="mb-5 px-4 py-3 rounded-xl text-xs mono flex items-center gap-2" style={{ background: `${c}10`, border: `1px solid ${c}30`, color: c }}>
      {kind === 'ok' ? <ShieldCheck size={15} /> : <AlertTriangle size={15} />} {text}
    </div>
  );
}
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (!values || values.length < 2) return <div className="text-xs mono self-end" style={{ color: '#3f444c' }}>building equity history…</div>;
  const W = 300, H = 88, pad = 4;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const pts = values.map((v, i) => [pad + (i / (values.length - 1)) * (W - pad * 2), pad + (1 - (v - min) / range) * (H - pad * 2)]);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
  return (
    <div className="self-end">
      <div className="text-xs mono text-right mb-1" style={{ color: DIM }}>30-day equity</div>
      <svg width={W} height={H}>
        <defs><linearGradient id="spark" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.35" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        <path d={area} fill="url(#spark)" />
        <path d={line} fill="none" stroke={color} strokeWidth="1.8" style={{ filter: `drop-shadow(0 0 4px ${color}88)` }} />
      </svg>
    </div>
  );
}
