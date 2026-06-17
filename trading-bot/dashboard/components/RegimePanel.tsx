'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { SessionLog } from '@/lib/types';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
} from 'recharts';

interface RegimePanelProps {
  session: SessionLog | null;
}

type RegimeName = 'crash' | 'bear' | 'neutral' | 'bull' | 'euphoria';

interface HmmState {
  regime:       RegimeName;
  confidence:   number;
  probability:  number[];      // [crash, bear, neutral, bull, euphoria]
  viterbiPath:  RegimeName[];
  observations: number[];
  classifiedAt: string;
}

interface HmmModel {
  params:    { name: RegimeName; mu: number; sigma: number }[];
  sessions:  number;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocation multiplier — mirrors hmmRegime.ts
// ─────────────────────────────────────────────────────────────────────────────
const ALLOCATION: Record<RegimeName, number> = {
  crash:    0.00,
  bear:     0.40,
  neutral:  0.80,
  bull:     1.00,
  euphoria: 0.60,
};

const REGIME_COLOR: Record<RegimeName, string> = {
  crash:    '#ff4d6d',
  bear:     '#f59e0b',
  neutral:  '#6b7280',
  bull:     '#00ff9f',
  euphoria: '#00cfff',
};

const REGIME_NAMES: RegimeName[] = ['crash', 'bear', 'neutral', 'bull', 'euphoria'];

function RegimeBadge({ regime, confidence }: { regime: RegimeName; confidence: number }) {
  const color = REGIME_COLOR[regime];
  const alloc = ALLOCATION[regime];
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg"
           style={{ background: `${color}12`, border: `1px solid ${color}35` }}>
        <div className="w-2.5 h-2.5 rounded-full pulse-green" style={{ background: color }} />
        <span className="text-xl font-bold mono" style={{ color }}>{regime.toUpperCase()}</span>
        <span className="text-sm mono" style={{ color: `${color}90` }}>
          {(confidence * 100).toFixed(0)}% conf
        </span>
      </div>
      <div className="text-sm mono px-3 py-2 rounded-lg"
           style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <span style={{ color: '#4b5563' }}>Allocation: </span>
        <span style={{ color: alloc === 0 ? '#ff4d6d' : alloc < 1 ? '#f59e0b' : '#00ff9f', fontWeight: 700 }}>
          {(alloc * 100).toFixed(0)}%
        </span>
        <span style={{ color: '#4b5563' }}> of normal size</span>
      </div>
    </div>
  );
}

export default function RegimePanel({ session }: RegimePanelProps) {
  const [hmm,   setHmm]   = useState<HmmState | null>(null);
  const [model, setModel] = useState<HmmModel | null>(null);

  useEffect(() => {
    async function fetchRegime() {
      try {
        const res  = await apiFetch('/api/regime');
        const data = await res.json();
        if (data.regime) setHmm(data.regime);
        if (data.model)  setModel(data.model);
      } catch { /* keep null */ }
    }
    fetchRegime();
    const t = setInterval(fetchRegime, 60_000);
    return () => clearInterval(t);
  }, []);

  // Distribution bar chart data
  const probData = hmm
    ? REGIME_NAMES.map((r, i) => ({
        name:  r,
        value: (hmm.probability[i] ?? 0) * 100,
        color: REGIME_COLOR[r],
      }))
    : [];

  // Viterbi path sequence (last 10 days)
  const pathData = hmm?.viterbiPath.map((r, i) => ({
    day:   `D-${hmm.viterbiPath.length - i}`,
    regime: r,
    color:  REGIME_COLOR[r],
    value:  REGIME_NAMES.indexOf(r) + 1,  // 1-5 for display
  })) ?? [];

  // Observed returns for sparkline
  const returnData = hmm?.observations.map((r, i) => ({
    i, value: r, color: r >= 0 ? '#00ff9f' : '#ff4d6d',
  })) ?? [];

  // Session trades for outcome distribution
  const trades  = session?.trades ?? [];
  const wins    = trades.filter(t => t.outcome === 'WIN').length;
  const losses  = trades.filter(t => t.outcome === 'LOSS').length;
  const open    = trades.filter(t => t.outcome === 'OPEN').length;
  const outcomeData = [
    { name: 'Wins',   value: wins,   color: '#00ff9f' },
    { name: 'Losses', value: losses, color: '#ff4d6d' },
    { name: 'Open',   value: open,   color: '#00cfff' },
  ];

  // Signal radar from last trade
  const lastTrade = [...trades].reverse().find(t => t.decision?.scores);
  const scores    = lastTrade?.decision?.scores;
  const radarData = scores ? [
    { subject: 'Technical',  A: scores.technical      * 100 },
    { subject: 'Macro',      A: scores.macro           * 100 },
    { subject: 'Sentiment',  A: scores.sentiment       * 100 },
    { subject: 'Whale',      A: scores.whale           * 100 },
    { subject: 'Micro',      A: scores.microstructure  * 100 },
  ] : [];

  // Assets
  const tradedSymbols = Array.from(new Set(trades.map(t => t.symbol)));

  return (
    <div className="grid gap-3 h-full" style={{ gridTemplateColumns: '1fr 1fr', alignContent: 'start' }}>

      {/* ── HMM Detected Regime ── */}
      <div className="glass rounded-xl p-4 hover-glow col-span-2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold mono tracking-wide" style={{ color: '#e0e0e0' }}>
            DETECTED REGIME (Hidden Markov Model)
          </h2>
          {hmm && (
            <span className="text-xs mono" style={{ color: '#4b5563' }}>
              classified {new Date(hmm.classifiedAt).toLocaleTimeString('en-US', { hour12: false })}
              {model && ` · ${model.sessions} sessions learned`}
            </span>
          )}
        </div>

        {hmm ? (
          <div className="flex flex-col gap-3">
            <RegimeBadge regime={hmm.regime} confidence={hmm.confidence} />

            {/* Description */}
            <p className="text-xs mono" style={{ color: '#6b7280' }}>
              {{
                crash:    'Extreme volatility, sharp decline. VIX > 35. Capital preservation — no new positions.',
                bear:     'Sustained downtrend. VIX 25-35. Very defensive — 40% of normal position size.',
                neutral:  'Sideways market, no clear trend. VIX 15-25. Slightly cautious — 80% size.',
                bull:     'Trending up, moderate volatility. VIX < 20. Full position size.',
                euphoria: 'Parabolic move, extreme greed. Mean-reversion risk — 60% size.',
              }[hmm.regime]}
            </p>
          </div>
        ) : (
          <p className="text-xs mono" style={{ color: '#4b5563' }}>
            HMM regime data not available yet. Will be classified at 9:00 AM ET on Tue/Wed/Thu.
          </p>
        )}
      </div>

      {/* ── Regime Probability Distribution ── */}
      <div className="glass rounded-xl p-4 hover-glow">
        <h2 className="text-sm font-semibold mono tracking-wide mb-3" style={{ color: '#e0e0e0' }}>
          REGIME DISTRIBUTION
        </h2>
        {probData.length > 0 ? (
          <div style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={probData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barSize={28}>
                <XAxis dataKey="name" tick={{ fill: '#4b5563', fontSize: 9, fontFamily: 'JetBrains Mono' }}
                       axisLine={false} tickLine={false}
                       tickFormatter={v => v.slice(0, 4).toUpperCase()} />
                <YAxis hide domain={[0, 100]} />
                <Tooltip
                  formatter={(v) => [`${(v as number).toFixed(1)}%`, 'Probability']}
                  contentStyle={{ background: 'rgba(10,10,15,0.95)', border: '1px solid rgba(255,255,255,0.1)',
                                  fontFamily: 'JetBrains Mono', fontSize: 11 }}
                  cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                />
                <Bar dataKey="value" radius={[2, 2, 0, 0]}>
                  {probData.map((d, i) => (
                    <Cell key={i} fill={d.color} fillOpacity={d.name === hmm?.regime ? 0.9 : 0.35} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-xs mono py-8 text-center" style={{ color: '#4b5563' }}>No data yet</p>
        )}
      </div>

      {/* ── Viterbi Path (10-day regime sequence) ── */}
      <div className="glass rounded-xl p-4 hover-glow">
        <h2 className="text-sm font-semibold mono tracking-wide mb-3" style={{ color: '#e0e0e0' }}>
          10-DAY REGIME PATH
        </h2>
        {pathData.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {[...pathData].reverse().map((d, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs mono w-8 flex-shrink-0" style={{ color: '#4b5563' }}>{d.day}</span>
                <div className="flex-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
                  <div className="h-1.5 rounded-full" style={{ width: `${(d.value / 5) * 100}%`, background: d.color }} />
                </div>
                <span className="text-xs mono w-16 text-right" style={{ color: d.color }}>{d.regime}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs mono py-4 text-center" style={{ color: '#4b5563' }}>No path data yet</p>
        )}
      </div>

      {/* ── HMM Learned Parameters ── */}
      {model?.params && (
        <div className="glass rounded-xl p-4 hover-glow">
          <h2 className="text-sm font-semibold mono tracking-wide mb-3" style={{ color: '#e0e0e0' }}>
            HMM LEARNED PARAMETERS
          </h2>
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-3 text-xs mono mb-1" style={{ color: '#4b5563' }}>
              <span>REGIME</span><span className="text-right">μ (avg ret)</span><span className="text-right">σ (volatility)</span>
            </div>
            {model.params.map(p => (
              <div key={p.name} className="grid grid-cols-3 text-xs mono">
                <span style={{ color: REGIME_COLOR[p.name] }}>{p.name}</span>
                <span className="text-right" style={{ color: p.mu >= 0 ? '#00ff9f' : '#ff4d6d' }}>
                  {p.mu >= 0 ? '+' : ''}{p.mu.toFixed(3)}%/day
                </span>
                <span className="text-right" style={{ color: '#6b7280' }}>{p.sigma.toFixed(3)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Signal Radar ── */}
      {radarData.length > 0 && (
        <div className="glass rounded-xl p-4 hover-glow">
          <h2 className="text-sm font-semibold mono tracking-wide mb-2" style={{ color: '#e0e0e0' }}>
            SIGNAL RADAR (last trade)
          </h2>
          <div style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                <PolarGrid stroke="rgba(255,255,255,0.06)" />
                <PolarAngleAxis dataKey="subject" tick={{ fill: '#4b5563', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                <Radar dataKey="A" stroke="#00cfff" fill="#00cfff" fillOpacity={0.12} strokeWidth={1.5} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── Outcome Distribution ── */}
      <div className="glass rounded-xl p-4 hover-glow">
        <h2 className="text-sm font-semibold mono tracking-wide mb-3" style={{ color: '#e0e0e0' }}>
          OUTCOME DISTRIBUTION
        </h2>
        {trades.length === 0 ? (
          <p className="text-xs mono py-4 text-center" style={{ color: '#4b5563' }}>No trades yet</p>
        ) : (
          <div style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={outcomeData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barSize={32}>
                <XAxis dataKey="name" tick={{ fill: '#4b5563', fontSize: 10, fontFamily: 'JetBrains Mono' }}
                       axisLine={false} tickLine={false} />
                <YAxis hide allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'rgba(10,10,15,0.95)', border: '1px solid rgba(255,255,255,0.1)',
                                         fontFamily: 'JetBrains Mono', fontSize: 11 }}
                         cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar dataKey="value" radius={[2, 2, 0, 0]}>
                  {outcomeData.map((d, i) => <Cell key={i} fill={d.color} fillOpacity={0.8} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ── What's Being Traded ── */}
      <div className="glass rounded-xl p-4 hover-glow col-span-2">
        <h2 className="text-sm font-semibold mono tracking-wide mb-3" style={{ color: '#e0e0e0' }}>
          ASSETS BEING TRADED
        </h2>
        <div className="flex flex-wrap gap-2">
          {['QQQ', 'SPY'].map(sym => {
            const hasTrade = tradedSymbols.some(a => a.includes(sym));
            const count    = trades.filter(t => t.symbol.includes(sym)).length;
            return (
              <div key={sym} className="flex items-center gap-2 px-3 py-2 rounded-lg"
                   style={{
                     background: hasTrade ? 'rgba(0,255,159,0.06)' : 'rgba(255,255,255,0.02)',
                     border:     hasTrade ? '1px solid rgba(0,255,159,0.2)' : '1px solid rgba(255,255,255,0.06)',
                   }}>
                <div className="w-2 h-2 rounded-full" style={{ background: hasTrade ? '#00ff9f' : '#4b5563' }} />
                <span className="text-sm font-bold mono" style={{ color: hasTrade ? '#00ff9f' : '#6b7280' }}>{sym}</span>
                <span className="text-xs mono" style={{ color: '#4b5563' }}>
                  {hasTrade ? `${count} trade(s)` : 'watching'}
                </span>
              </div>
            );
          })}
        </div>
        <p className="text-xs mono mt-2" style={{ color: '#4b5563' }}>
          Strategy: ORB · Tue/Wed/Thu · 9:30–10:30 AM ET · Long only ·{' '}
          {hmm ? `${hmm.regime} regime → ${(ALLOCATION[hmm.regime] * 100).toFixed(0)}% allocation` : 'regime pending'}
        </p>
      </div>
    </div>
  );
}
